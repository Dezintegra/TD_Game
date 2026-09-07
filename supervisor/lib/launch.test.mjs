import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { describe, it, expect, vi } from 'vitest';
import { parseLaunchArgs, runLaunch, spawnSupervisor, launchUsage } from './launch.mjs';

function fixture(args = []) {
  const options = parseLaunchArgs(args);
  const states = [{ kind: 'waiting' }];
  let now = 0;
  const effects = {
    log: vi.fn(),
    error: vi.fn(),
    exists: vi.fn(() => true),
    remove: vi.fn(),
    killTree: vi.fn(),
    sleep: vi.fn(async () => {}),
    now: () => now,
    state: vi.fn(async () => (states.length > 1 ? states.shift() : states[0])),
    spawn: vi.fn(async () => ({ pid: 99 })),
    watch: vi.fn(async ({ afterTick }) => afterTick({ kind: 'live', pid: 99 })),
  };
  const context = { options, root: '/project', entry: '/tool/supervise.mjs' };
  return {
    options,
    states,
    effects,
    context,
    clock: (value) => {
      now = value;
    },
    run: () => runLaunch(context, effects),
  };
}

describe('launch argument matrix', () => {
  it.each([
    [[], 'start-watch'],
    [['--quiet', '--root=/project', '--provider=codex', '--config=custom'], 'start-watch'],
    [['--watch'], 'watch'],
    [['--foreground'], 'foreground'],
    [['--detached'], 'detached'],
    [['--stop'], 'stop'],
    [['--shadow'], 'foreground'],
    [['--dry-run'], 'foreground'],
    [['--shadow', '--dry-run', '--foreground'], 'foreground'],
    [['--shadow', '--detached'], 'detached'],
  ])('%j selects %s', (args, mode) => expect(parseLaunchArgs(args).mode).toBe(mode));

  const modes = ['watch', 'foreground', 'detached', 'stop'];
  for (let i = 0; i < modes.length; i += 1)
    for (let j = i + 1; j < modes.length; j += 1) {
      it(`rejects ${modes[i]} with ${modes[j]} before any effects`, () => {
        expect(() => parseLaunchArgs([`--${modes[i]}`, `--${modes[j]}`])).toThrow('Несовместимые');
      });
    }
  it.each(['--shadow', '--dry-run', '--quiet', '--provider=claude', '--config=custom'])(
    'rejects watch/stop with %s',
    (arg) => {
      for (const mode of ['--watch', '--stop'])
        expect(() => parseLaunchArgs([mode, arg])).toThrow();
    },
  );
  it.each(['--', '--typo', '--root', '--root=', '--provider=other', '--watch=yes'])(
    'rejects %s even with help',
    (arg) => {
      expect(() => parseLaunchArgs(['--help', arg])).toThrow();
    },
  );
  it('explains both kinds of Ctrl+C', () => {
    expect(launchUsage()).toContain('Ctrl+C закрывает только наблюдение');
    expect(launchUsage()).toContain('Ctrl+C даёт идущим этапам доработать');
  });
});

describe('launcher effects', () => {
  it('starts detached then watches and forwards only supervisor arguments', async () => {
    const f = fixture(['--provider=codex', '--quiet', '--config=custom']);
    expect(await f.run()).toBe(0);
    expect(f.effects.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        detached: true,
        root: '/project',
        argv: ['/tool/supervise.mjs', '--provider=codex', '--quiet', '--config=custom', '/project'],
      }),
    );
    expect(f.effects.spawn.mock.invocationCallOrder[0]).toBeLessThan(
      f.effects.watch.mock.invocationCallOrder[0],
    );
    expect(f.effects.log.mock.calls.flat().join('\n')).toContain('stdout приглушён');
    expect(f.effects.killTree).not.toHaveBeenCalled();
    expect(f.effects.remove).not.toHaveBeenCalled();
  });
  it.each(['watch', 'start-watch'])('only observes for %s with live PID', async (mode) => {
    const f = fixture(mode === 'watch' ? ['--watch'] : ['--provider=codex']);
    f.states[0] = { kind: 'live', pid: 42 };
    expect(await f.run()).toBe(0);
    expect(f.effects.watch).toHaveBeenCalledOnce();
    expect(f.effects.spawn).not.toHaveBeenCalled();
    expect(f.effects.killTree).not.toHaveBeenCalled();
    expect(f.effects.remove).not.toHaveBeenCalled();
  });
  it('watch waits without creating anything or requiring supervise to exist', async () => {
    const f = fixture(['--watch']);
    f.effects.watch.mockImplementation(async ({ afterTick }) => afterTick({ kind: 'waiting' }));
    expect(await f.run()).toBe(0);
    expect(f.effects.exists).not.toHaveBeenCalled();
    expect(f.effects.spawn).not.toHaveBeenCalled();
    expect(f.effects.remove).not.toHaveBeenCalled();
    expect(f.effects.killTree).not.toHaveBeenCalled();
  });
  it.each(['--watch', '--stop', '--foreground', '--detached'])(
    'applies worktree guard before effects for %s',
    async (arg) => {
      const f = fixture([arg]);
      f.context.gitFile = 'gitdir: C:/project/.git/worktrees/task';
      expect(await f.run()).toBe(1);
      for (const name of ['exists', 'state', 'spawn', 'watch', 'remove', 'killTree'])
        expect(f.effects[name]).not.toHaveBeenCalled();
      f.context.explicitRoot = '/project';
      f.states[0] = { kind: 'live', pid: 1 };
      await f.run();
      expect(f.effects.state).toHaveBeenCalled();
    },
  );
  it.each(['--foreground', '--shadow', '--dry-run', '--detached'])(
    'keeps existing PID for %s without watching',
    async (arg) => {
      const f = fixture([arg]);
      f.states[0] = { kind: 'live', pid: 42 };
      expect(await f.run()).toBe(0);
      expect(f.effects.spawn).not.toHaveBeenCalled();
      expect(f.effects.watch).not.toHaveBeenCalled();
    },
  );
  it.each(['--foreground', '--shadow', '--dry-run'])(
    'retains direct output and exit status for %s',
    async (arg) => {
      const f = fixture([arg]);
      f.effects.spawn.mockImplementation(async ({ onExit }) => {
        onExit({ code: 7 });
        return { pid: 99 };
      });
      expect(await f.run()).toBe(7);
      expect(f.effects.spawn.mock.calls[0][0].detached).toBe(false);
      expect(f.effects.watch).not.toHaveBeenCalled();
    },
  );
  it('detached never waits for readiness or watches', async () => {
    const f = fixture(['--detached']);
    expect(await f.run()).toBe(0);
    expect(f.effects.watch).not.toHaveBeenCalled();
    expect(f.effects.state).toHaveBeenCalledTimes(1);
  });
  it('keeps stop handling stale lock and live subtree', async () => {
    const f = fixture(['--stop']);
    expect(await f.run()).toBe(0);
    expect(f.effects.remove).toHaveBeenCalledOnce();
    expect(f.effects.killTree).not.toHaveBeenCalled();
    f.states.unshift({ kind: 'live', pid: 42 });
    expect(await f.run()).toBe(0);
    expect(f.effects.killTree).toHaveBeenCalledWith(42);
    expect(f.effects.sleep).toHaveBeenCalledWith(500);
    expect(f.effects.spawn).not.toHaveBeenCalled();
  });
  it('reports spawn failure, early exit and unconfirmed startup without killing', async () => {
    const f = fixture();
    f.effects.spawn.mockRejectedValueOnce(new Error('spawn denied'));
    expect(await f.run()).toBe(1);
    f.effects.spawn.mockImplementation(async ({ onExit }) => {
      onExit({ code: 4 });
      return { pid: 99 };
    });
    f.effects.watch.mockImplementation(async ({ afterTick }) => afterTick({ kind: 'waiting' }));
    expect(await f.run()).toBe(1);
    expect(f.effects.error.mock.calls.flat().join('\n')).toContain('процесс завершился (4)');
    f.effects.spawn.mockResolvedValue({ pid: 99 });
    f.effects.watch.mockImplementation(async ({ afterTick }) => {
      f.clock(10_001);
      afterTick({ kind: 'unknown' });
    });
    expect(await f.run()).toBe(1);
    expect(f.effects.error.mock.calls.flat().join('\n')).toContain('не подтверждён');
    expect(f.effects.killTree).not.toHaveBeenCalled();
    expect(f.effects.remove).not.toHaveBeenCalled();
  });
  it('accepts a live competing PID and later waits across restarts', async () => {
    const f = fixture();
    f.effects.spawn.mockImplementation(async ({ onExit }) => {
      onExit({ code: 1 });
      return { pid: 99 };
    });
    f.effects.watch.mockImplementation(async ({ afterTick }) => {
      afterTick({ kind: 'live', pid: 100 });
      f.clock(20_000);
      afterTick({ kind: 'waiting' });
      afterTick({ kind: 'live', pid: 101 });
    });
    expect(await f.run()).toBe(0);
  });
  it('output failure affects only observation', async () => {
    const f = fixture(['--watch']);
    f.effects.watch.mockRejectedValue(new Error('EPIPE'));
    expect(await f.run()).toBe(1);
    expect(f.effects.killTree).not.toHaveBeenCalled();
  });
});

describe('real spawn factory options', () => {
  function ioFixture() {
    const child = new EventEmitter();
    child.unref = vi.fn();
    const io = {
      mkdir: vi.fn(),
      open: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(11),
      close: vi.fn(),
      spawn: vi.fn(() => child),
    };
    return { child, io };
  }
  it('detaches with hidden window, ignored stdin and file descriptors, then unrefs', async () => {
    const { child, io } = ioFixture();
    const result = spawnSupervisor({ root: '/project', argv: ['fixture'], detached: true }, io);
    expect(io.spawn).toHaveBeenCalledWith(process.execPath, ['fixture'], {
      cwd: '/project',
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 10, 11],
    });
    expect(io.close.mock.calls).toEqual([[10], [11]]);
    expect(child.unref).not.toHaveBeenCalled();
    child.emit('spawn');
    expect(await result).toBe(child);
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it('closes opened files on partial open and synchronous spawn errors', () => {
    const a = ioFixture();
    a.io.open
      .mockReset()
      .mockReturnValueOnce(10)
      .mockImplementationOnce(() => {
        throw new Error('open');
      });
    expect(() => spawnSupervisor({ root: '.', argv: [], detached: true }, a.io)).toThrow('open');
    expect(a.io.close.mock.calls).toEqual([[10]]);
    const b = ioFixture();
    b.io.spawn.mockImplementation(() => {
      throw new Error('spawn');
    });
    expect(() => spawnSupervisor({ root: '.', argv: [], detached: true }, b.io)).toThrow('spawn');
    expect(b.io.close.mock.calls).toEqual([[10], [11]]);
  });
  it('reports asynchronous spawn failure and keeps foreground stdio inherited', async () => {
    const { child, io } = ioFixture();
    const result = spawnSupervisor({ root: '.', argv: [], detached: false }, io);
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    await expect(result).rejects.toThrow('ENOENT');
    expect(io.spawn.mock.calls[0][2]).toEqual({ cwd: '.', stdio: 'inherit' });
    expect(io.open).not.toHaveBeenCalled();
  });
  it('wrappers remain ASCII with prescribed line endings and error exits', () => {
    for (const name of ['start.cmd', 'start.sh']) {
      const text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
      expect([...text].every((character) => character.charCodeAt(0) < 128)).toBe(true);
      expect(text).toContain('--watch');
      expect(text).toContain('--foreground');
      if (name.endsWith('.cmd')) {
        expect(text.replaceAll('\r\n', '')).not.toContain('\n');
        expect(text).toContain('exit /b %SUPERVISOR_EXIT%');
      } else {
        expect(text).not.toContain('\r');
        expect(text).toContain('exit 1');
      }
    }
  });
});
