import { describe, it, expect, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { Writable } from 'node:stream';
import { createWatcher, readSupervisorState, watchLogs, CHUNK_BYTES } from './watch.mjs';

function fixture() {
  const files = new Map();
  const output = [];
  const reads = [];
  let opened = 0;
  let closed = 0;
  let state = { kind: 'waiting' };
  const put = (name, text, ino = 1) => files.set(name, { bytes: Buffer.from(text), ino });
  const openFile = vi.fn(async (path) => {
    const name = path.includes('.out.') ? 'out' : 'err';
    const file = files.get(name);
    if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (file.error) throw Object.assign(new Error('denied'), { code: file.error });
    opened += 1;
    return {
      stat: async () => ({ size: file.bytes.length, ino: file.ino, dev: 1, birthtimeMs: file.ino }),
      read: async (buffer, offset, length, position) => {
        reads.push({ name, length, position });
        const bytesRead = file.bytes.copy(buffer, offset, position, position + length);
        return { bytesRead };
      },
      close: async () => {
        closed += 1;
      },
    };
  });
  const options = {
    root: '.',
    openFile,
    readState: async () => state,
    emit: async (text) => output.push(text),
  };
  return {
    files,
    output,
    reads,
    put,
    options,
    setState: (next) => {
      state = next;
    },
    counts: () => ({ opened, closed }),
  };
}

describe('readSupervisorState', () => {
  it('uses identity and distinguishes dead, inaccessible and unknown', async () => {
    const read = vi.fn(async () => '{"pid":123}');
    const identify = vi.fn(async () => ({ kind: 'live', pid: 123 }));
    expect(await readSupervisorState('lock', { read, identify })).toEqual({
      kind: 'live',
      pid: 123,
    });
    expect(identify).toHaveBeenCalledWith(123, 'lock');
    identify.mockResolvedValue({ kind: 'unknown', reason: 'denied' });
    expect(await readSupervisorState('lock', { read, identify })).toMatchObject({
      kind: 'unknown',
    });
    identify.mockResolvedValue({ kind: 'waiting' });
    expect(await readSupervisorState('lock', { read, identify })).toEqual({ kind: 'waiting' });
    read.mockResolvedValue('bad json');
    expect(await readSupervisorState('lock', { read, identify })).toMatchObject({
      kind: 'unknown',
    });
    read.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await readSupervisorState('lock', { read, identify })).toMatchObject({
      kind: 'unknown',
      reason: 'denied',
    });
    read.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await readSupervisorState('lock', { read, identify })).toEqual({ kind: 'waiting' });
  });
});

describe('journal watcher', () => {
  it('tails forty lines of both streams and keeps positions across PID changes', async () => {
    const f = fixture();
    f.put('out', Array.from({ length: 60 }, (_, i) => `line ${i}\n`).join(''));
    f.put('err', 'ошибка\n');
    const w = createWatcher(f.options);
    await w.tick();
    expect(f.output.filter((s) => s.startsWith('[out]'))).toHaveLength(40);
    expect(f.output).toContain('[out] line 20\n');
    expect(f.output).toContain('[err] ошибка\n');
    f.setState({ kind: 'live', pid: 10 });
    await w.tick();
    f.setState({ kind: 'live', pid: 11 });
    f.put('err', 'ошибка\nновая\n');
    await w.tick();
    await w.tick();
    expect(f.output.filter((s) => s === '[err] ошибка\n')).toHaveLength(1);
    expect(f.output.filter((s) => s.includes('PID 11'))).toHaveLength(1);
    expect(f.output).toContain('[err] новая\n');
    await w.close();
    expect(f.counts().opened).toBe(f.counts().closed);
  });

  it('bounds initial history, subsequent reads and unterminated lines; preserves split UTF-8', async () => {
    const f = fixture();
    f.put('out', 'x'.repeat(CHUNK_BYTES * 4) + '\nпоследняя\n');
    f.put('err', '');
    const w = createWatcher(f.options);
    await w.tick();
    expect(f.reads[0].position).toBeGreaterThan(0);
    expect(f.output).toContain('[out] последняя\n');
    expect(f.output.some((s) => s.includes('история ограничена'))).toBe(true);
    const bytes = Buffer.from('я\n');
    f.put('err', bytes.subarray(0, 1));
    await w.tick();
    f.put('err', bytes);
    await w.tick();
    expect(f.output).toContain('[err] я\n');
    f.put('err', Buffer.concat([bytes, Buffer.from('z'.repeat(CHUNK_BYTES * 3))]));
    await w.tick();
    expect(f.reads.every((r) => r.length <= CHUNK_BYTES)).toBe(true);
    expect(f.output.every((s) => s.length < 4200)).toBe(true);
    expect(f.output.some((s) => s.includes('[фрагмент]'))).toBe(true);
    await w.close();
  });

  it('recovers from missing, replaced, truncated and inaccessible files without flooding', async () => {
    const f = fixture();
    const w = createWatcher(f.options);
    await w.tick();
    await w.tick();
    expect(f.output.filter((s) => s.includes('[out] журнал отсутствует'))).toHaveLength(1);
    f.put('out', 'first long line\n');
    await w.tick();
    f.put('out', 'short\n');
    await w.tick();
    f.put('out', 'replacement longer than before\n', 2);
    await w.tick();
    f.files.set('out', { error: 'EACCES' });
    await w.tick();
    await w.tick();
    expect(f.output.filter((s) => s.includes('EACCES'))).toHaveLength(1);
    f.files.delete('out');
    await w.tick();
    f.put('out', 'again\n', 3);
    await w.tick();
    for (const line of ['first long line', 'short', 'replacement longer than before', 'again']) {
      expect(f.output).toContain(`[out] ${line}\n`);
    }
    await w.close();
    expect(f.counts().opened).toBe(f.counts().closed);
  });

  it('serializes ticks and closes descriptors before waiting for output', async () => {
    const f = fixture();
    f.put('out', 'one\ntwo\n');
    f.put('err', '');
    let release;
    let waiting;
    const blocked = new Promise((resolve) => {
      waiting = resolve;
    });
    const w = createWatcher({
      ...f.options,
      emit: async (text) => {
        if (text === '[out] one\n') {
          waiting();
          await new Promise((resolve) => {
            release = resolve;
          });
        }
      },
    });
    const first = w.tick();
    await blocked;
    expect(w.tick()).toBe(first);
    expect(f.counts()).toEqual({ opened: 1, closed: 1 });
    release();
    await first;
    await w.close();
    const count = f.options.openFile.mock.calls.length;
    await w.tick();
    expect(f.options.openFile).toHaveBeenCalledTimes(count);
  });

  it('cancels backpressure and removes its output listeners', async () => {
    const f = fixture();
    let written;
    const ready = new Promise((resolve) => {
      written = resolve;
    });
    const output = new Writable({
      highWaterMark: 1,
      write() {
        written();
      },
    });
    const controller = new globalThis.AbortController();
    const run = watchLogs({ ...f.options, output, signal: controller.signal });
    await ready;
    controller.abort();
    await run;
    expect(output.listenerCount('error')).toBe(0);
    expect(output.listenerCount('close')).toBe(0);
    expect(f.options.openFile).not.toHaveBeenCalled();
    output.destroy();
  });
});
