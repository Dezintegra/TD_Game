import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  realpathSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { spawnSupervisor } from './launch.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/watch-lifetime.mjs', import.meta.url));
const basePath = join(repo, '.matchlog/watch-supervisor-tests');

async function until(check, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

function text(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function setup() {
  mkdirSync(basePath, { recursive: true });
  const base = realpathSync(basePath);
  const root = realpathSync(mkdtempSync(join(base, 'case-')));
  writeFileSync(join(root, 'owner'), '0126-watch-lifetime');
  const observers = [];
  const writers = new Map();
  const out = join(root, '.pipeline/supervisor.out.log');
  const err = join(root, '.pipeline/supervisor.err.log');
  const observed = join(root, 'observed.log');

  function assertOwned() {
    if (
      realpathSync(root) !== root ||
      dirname(root) !== base ||
      !basename(root).startsWith('case-')
    )
      throw new Error('Unsafe fixture path');
    if (readFileSync(join(root, 'owner'), 'utf8') !== '0126-watch-lifetime')
      throw new Error('Wrong owner');
  }

  async function observer(mode) {
    const fd = openSync(observed, 'a');
    let child;
    try {
      child = spawn(process.execPath, [fixturePath, mode, root, 'first'], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    observers.push(child);
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return child;
  }

  async function writer(id) {
    const calls = [];
    const child = await spawnSupervisor(
      { root, detached: true, argv: [fixturePath, 'writer', root, id] },
      {
        spawn: (...args) => {
          calls.push(args);
          return spawn(...args);
        },
      },
    );
    writers.set(id, child.pid);
    expect(calls[0][2]).toMatchObject({ cwd: root, detached: true, windowsHide: true });
    expect(calls[0][2].stdio[0]).toBe('ignore');
    expect(calls[0][2].stdio.slice(1).every(Number.isInteger)).toBe(true);
    await until(
      () => text(out).includes(`${id}:out:ready`) && text(err).includes(`${id}:err:ready`),
      'writer ready',
    );
    return child;
  }

  async function stopWriter(id) {
    assertOwned();
    writeFileSync(join(root, `stop-${id}`), 'stop');
    const pid = writers.get(id);
    if (pid) await until(() => !alive(pid), `writer ${id} exits`, 5000);
  }

  async function closeObserver(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    await until(() => child.exitCode !== null || child.signalCode !== null, 'observer exits', 5000);
  }

  async function cleanup() {
    assertOwned();
    for (const child of observers) await closeObserver(child);
    // Писатель мог появиться перед падением проверки; идентичность оставляет сама фикстура.
    for (const id of ['first', 'second']) {
      const identityPath = join(root, `${id}.identity.json`);
      if (existsSync(identityPath)) {
        const identity = JSON.parse(text(identityPath));
        if (identity.root !== root || identity.id !== id)
          throw new Error('Unknown process ownership');
        writers.set(id, identity.pid);
      }
      writeFileSync(join(root, `stop-${id}`), 'stop');
    }
    for (const [id, pid] of writers) {
      if (!alive(pid)) continue;
      try {
        await until(() => !alive(pid), `cleanup ${id}`, 5000);
      } catch {
        process.kill(pid, 'SIGKILL');
        await until(() => !alive(pid), `kill owned ${id}`, 5000);
      }
    }
    assertOwned();
    rmSync(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
  return {
    root,
    out,
    err,
    observed,
    observers,
    writers,
    observer,
    writer,
    closeObserver,
    stopWriter,
    cleanup,
  };
}

describe('independent supervisor observation on real processes', () => {
  it('writer produces both control records after its launching observer has exited', async () => {
    const f = setup();
    try {
      const observer = await f.observer('launch');
      await until(
        () => text(f.observed).includes('[err] first:err:ready'),
        'launch observer reads writer',
      );
      const identity = JSON.parse(text(join(f.root, 'spawn.json')));
      expect(identity.root).toBe(f.root);
      f.writers.set('first', identity.pid);
      expect(alive(identity.pid)).toBe(true);
      expect(text(f.out)).not.toContain('after-observer-exit');
      await f.closeObserver(observer);
      // Запрос создаётся после подтверждённого выхода: старая строка тест не удовлетворит.
      writeFileSync(join(f.root, 'command'), 'after-observer-exit');
      await until(
        () =>
          text(f.out).includes('first:out:after-observer-exit') &&
          text(f.err).includes('first:err:after-observer-exit'),
        'new output after observer exit',
      );
      expect(alive(identity.pid)).toBe(true);
      expect(JSON.parse(text(join(f.root, '.pipeline/supervisor.lock'))).pid).toBe(identity.pid);
    } finally {
      await f.cleanup();
    }
  }, 30_000);

  it('same observer follows replacement writer and PID without replaying either stream', async () => {
    const f = setup();
    try {
      const first = await f.writer('first');
      const observer = await f.observer('watch');
      await until(
        () =>
          text(f.observed).includes('[out] first:out:ready') &&
          text(f.observed).includes('[err] first:err:ready'),
        'initial history',
      );
      writeFileSync(join(f.root, 'command'), 'before-restart');
      await until(
        () => text(f.observed).includes('[err] first:err:before-restart'),
        'old writer output',
      );
      await f.stopWriter('first');
      const second = await f.writer('second');
      expect(second.pid).not.toBe(first.pid);
      writeFileSync(join(f.root, 'command'), 'after-restart');
      await until(
        () =>
          text(f.observed).includes(`[супервизор] работает, PID ${second.pid}`) &&
          text(f.observed).includes('[out] second:out:after-restart') &&
          text(f.observed).includes('[err] second:err:after-restart'),
        'new PID and both streams',
      );
      expect(observer.exitCode).toBeNull();
      expect(observer.signalCode).toBeNull();
      for (const source of ['out', 'err'])
        for (const record of [
          'first:' + source + ':ready',
          'first:' + source + ':before-restart',
          'second:' + source + ':after-restart',
        ]) {
          expect(text(f.observed).split(`[${source}] ${record}\n`)).toHaveLength(2);
        }
    } finally {
      await f.cleanup();
    }
  }, 30_000);
});
