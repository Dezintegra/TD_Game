import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Buffer } from 'node:buffer';
import { setTimeout as sleep } from 'node:timers/promises';

export const CHUNK_BYTES = 64 * 1024;
const FRAGMENT_CHARS = 4096;

export async function readSupervisorState(
  lockPath,
  { read = readFile, probe = process.kill } = {},
) {
  try {
    const lock = JSON.parse(await read(lockPath, 'utf8'));
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('некорректный PID');
    try {
      probe(lock.pid, 0);
      return { kind: 'live', pid: lock.pid };
    } catch (error) {
      if (error.code === 'EPERM') return { kind: 'live', pid: lock.pid, denied: true };
      if (error.code === 'ESRCH') return { kind: 'waiting' };
      throw error;
    }
  } catch (error) {
    return error.code === 'ENOENT'
      ? { kind: 'waiting' }
      : { kind: 'unknown', reason: error.message };
  }
}

function stateText(state) {
  if (state.kind === 'live')
    return `работает, PID ${state.pid}${state.denied ? ' (жив, недоступен)' : ''}`;
  if (state.kind === 'waiting') return 'не работает, ожидаю запуска';
  return `состояние неизвестно: ${state.reason}`;
}

// Один проход ожидает вывод целиком: медленная консоль не создаёт очередь чтений.
export function createWatcher({
  root,
  emit,
  signal,
  openFile = open,
  readState = readSupervisorState,
}) {
  const localDir = join(root, '.pipeline');
  const sources = ['out', 'err'].map((name) => ({
    name,
    path: join(localDir, `supervisor.${name}.log`),
    position: 0,
    identity: null,
    initial: true,
    decoder: new StringDecoder('utf8'),
    pending: '',
    state: null,
  }));
  let previousStatus;
  let stopped = false;
  let active;

  async function notice(source, state) {
    if (source.state !== state) {
      source.state = state;
      await emit(`[${source.name}] ${state}\n`);
    }
  }

  async function flush(source, text) {
    source.pending += text;
    while (!stopped && !signal?.aborted && source.pending.length) {
      const newline = source.pending.indexOf('\n');
      if (newline < 0 && source.pending.length < FRAGMENT_CHARS) break;
      let length = newline >= 0 && newline < FRAGMENT_CHARS ? newline : FRAGMENT_CHARS;
      // Не разрезаем UTF-16 пару при выводе ограниченного фрагмента.
      if (length && /[\uD800-\uDBFF]/u.test(source.pending[length - 1])) length -= 1;
      const complete = newline === length;
      await emit(
        `[${source.name}] ${source.pending.slice(0, length)}${complete ? '' : ' [фрагмент]'}\n`,
      );
      source.pending = source.pending.slice(length + (complete ? 1 : 0));
    }
  }

  async function readSource(source) {
    let handle;
    try {
      handle = await openFile(source.path, 'r');
      const stat = await handle.stat();
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (
        source.identity !== null &&
        (identity !== source.identity || stat.size < source.position)
      ) {
        source.position = 0;
        source.decoder = new StringDecoder('utf8');
        source.pending = '';
        await notice(source, 'разрыв журнала; читаю новое поколение');
      }
      source.identity = identity;
      let position = source.initial ? Math.max(0, stat.size - CHUNK_BYTES) : source.position;
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(0, stat.size - position)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      // Дескриптор закрывается до ожидания консоли, переименованный файл не удерживается.
      await handle.close();
      handle = null;
      let bytes = buffer.subarray(0, bytesRead);
      if (source.initial) {
        if (position > 0) {
          const newline = bytes.indexOf(10);
          bytes = newline < 0 ? bytes.subarray(bytes.length) : bytes.subarray(newline + 1);
          await notice(source, 'история ограничена 64 КиБ; неполное начало отброшено');
        }
        let lines = 0;
        for (let i = bytes.length - 1 - (bytes.at(-1) === 10 ? 1 : 0); i >= 0; i -= 1) {
          if (bytes[i] === 10 && ++lines === 40) {
            bytes = bytes.subarray(i + 1);
            break;
          }
        }
      }
      source.position = position + bytesRead;
      source.initial = false;
      if (source.state !== null) await notice(source, 'чтение доступно');
      await flush(source, source.decoder.write(bytes));
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (!source.initial) {
          source.position = 0;
          source.identity = null;
          source.decoder = new StringDecoder('utf8');
          source.pending = '';
        }
        await notice(source, 'журнал отсутствует; ожидаю появления');
      } else {
        await notice(source, `ошибка чтения: ${error.code ?? error.message}; повторю`);
      }
    } finally {
      if (handle) await handle.close();
    }
  }

  async function poll() {
    const state = await readState(join(localDir, 'supervisor.lock'));
    const status = stateText(state);
    if (!stopped && !signal?.aborted && status !== previousStatus) {
      await emit(`[супервизор] ${status}\n`);
      previousStatus = status;
    }
    for (const source of sources) if (!stopped && !signal?.aborted) await readSource(source);
    return state;
  }

  return {
    tick() {
      if (stopped) return Promise.resolve();
      if (!active)
        active = poll().finally(() => {
          active = null;
        });
      return active;
    },
    async close() {
      stopped = true;
      await active;
      for (const source of sources) {
        source.pending = '';
        source.decoder.end();
      }
    },
  };
}

export async function watchLogs({
  root,
  output = process.stdout,
  signal,
  afterTick = () => {},
  interval = 500,
  ...options
}) {
  let outputError;
  const controller = new globalThis.AbortController();
  const stop = () => controller.abort();
  const fail = (error) => {
    outputError = error;
    stop();
  };
  signal?.addEventListener('abort', stop, { once: true });
  output.on('error', fail);
  output.on('close', stop);
  if (signal?.aborted) stop();
  const emit = async (text) => {
    if (controller.signal.aborted) return;
    await new Promise((resolve, reject) => {
      const done = (error) => {
        controller.signal.removeEventListener('abort', cancelled);
        if (error) reject(error);
        else resolve();
      };
      const cancelled = () => done();
      controller.signal.addEventListener('abort', cancelled, { once: true });
      // Callback завершается после обработки записи: очередь не растёт даже при backpressure.
      output.write(text, done);
    });
  };
  const watcher = createWatcher({ root, ...options, emit, signal: controller.signal });
  try {
    while (!controller.signal.aborted) {
      const state = await watcher.tick();
      if (!controller.signal.aborted) await afterTick(state);
      await sleep(interval, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    stop();
    await watcher.close();
    signal?.removeEventListener('abort', stop);
    output.off('error', fail);
    output.off('close', stop);
  }
  if (outputError) throw outputError;
}
