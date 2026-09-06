import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { openReportStore } from './report-store.mjs';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import {
  claimSupervisorLock,
  createOwnedSupervisor,
  releaseSupervisorLock,
} from './supervisor-startup.mjs';

const NOW = '2026-09-06T12:00:00.000Z';

function world(existing = null) {
  let lock = existing;
  const events = [];
  return {
    events,
    readLock: () => lock,
    writeLock: (next) => {
      events.push('write-lock');
      lock = next;
    },
    removeLock: () => {
      events.push('remove-lock');
      lock = null;
    },
    claimLock: (next) => {
      events.push('claim-lock');
      if (lock) return false;
      lock = next;
      return true;
    },
    lock: () => lock,
  };
}

function claimArgs(state, over = {}) {
  return {
    lockPath: 'virtual/supervisor.lock',
    now: NOW,
    staleMinutes: 30,
    pid: 101,
    isAlive: () => true,
    underGuard: (_path, operation) => ({ ok: true, value: operation() }),
    ...state,
    ...over,
  };
}

describe('startup под общим lock guard', () => {
  it('не читает очередь до замка и не запускает recovery при повреждении очереди', () => {
    const f = deliveryFixture();
    try {
      const state = world();
      writeFileSync(f.queuePath, 'corrupt pending report');
      expect(() =>
        createOwnedSupervisor({
          claim: () => claimSupervisorLock(claimArgs(state)),
          createSupervisor: () => {
            state.events.push('restore-reports');
            openReportStore(f.queuePath);
            state.events.push('recover-orphans');
          },
        }),
      ).toThrow(f.queuePath);
      expect(state.events).toEqual(['claim-lock', 'restore-reports']);
      expect(readFileSync(f.queuePath, 'utf8')).toBe('corrupt pending report');
    } finally {
      f.cleanup();
    }
  });
  it('fresh startup получает lock до чтения текущего runtime ledger', () => {
    const state = world();
    const events = state.events;
    // Recovery уже освободил общий guard; startup читает не прежнюю копию,
    // а значение, которое лежит на диске после этого восстановления.
    const ledger = 'после восстановления';
    const owned = createOwnedSupervisor({
      claim: () => claimSupervisorLock(claimArgs(state)),
      createSupervisor: () => {
        events.push(`read-ledger:${ledger}`);
        return { ledger };
      },
    });
    expect(owned.supervisor).toEqual({ ledger: 'после восстановления' });
    expect(events).toEqual(['claim-lock', 'read-ledger:после восстановления']);
  });

  it('неуспешный claim не читает и не пишет runtime ledger', () => {
    const state = world({ pid: 202, takenAt: NOW, refreshedAt: NOW });
    let reads = 0;
    let writes = 0;
    const owned = createOwnedSupervisor({
      claim: () => claimSupervisorLock(claimArgs(state)),
      createSupervisor: () => {
        reads += 1;
        writes += 1;
        return {};
      },
    });
    expect(owned.supervisor).toBeNull();
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(state.events).toEqual([]);
  });

  it('самому переданный PID обновляет lock без remove и лишь затем создаёт supervisor', () => {
    const state = world({ pid: 101, handedFrom: 99, takenAt: NOW, refreshedAt: NOW });
    const events = state.events;
    const owned = createOwnedSupervisor({
      claim: () => claimSupervisorLock(claimArgs(state)),
      createSupervisor: () => {
        events.push('read-ledger');
        return {};
      },
    });
    expect(owned.ownership).toMatchObject({ acquired: true, handedFrom: 99 });
    expect(events).toEqual(['write-lock', 'read-ledger']);
  });

  it('raced contender не может начать factory, пока первый захватывает guard', () => {
    const state = world();
    let second;
    const originalClaim = state.claimLock;
    state.claimLock = (next) => {
      second = claimSupervisorLock(
        claimArgs(state, {
          pid: 202,
          underGuard: () => ({ ok: false, reason: 'guard занят' }),
        }),
      );
      return originalClaim(next);
    };
    const first = claimSupervisorLock(claimArgs(state));
    expect(first.acquired).toBe(true);
    expect(second).toEqual({ acquired: false, why: 'guard занят' });
  });

  it('cleanup снимает только lock собственного PID', () => {
    const state = world({ pid: 202, takenAt: NOW, refreshedAt: NOW });
    expect(
      releaseSupervisorLock({
        ...state,
        lockPath: 'virtual/supervisor.lock',
        pid: 101,
        underGuard: (_path, operation) => ({ ok: true, value: operation() }),
      }),
    ).toBe(false);
    expect(state.lock()).toMatchObject({ pid: 202 });
  });
});
