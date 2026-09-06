import { lockVerdict, newLock } from './lock.mjs';
import { underLockGuard } from './lock-guard.mjs';

/**
 * Захватить долгий supervisor.lock внутри короткого общего guard.
 *
 * Все проверки, снятие старого lock и создание нового находятся в одном
 * guard: recovery и startup не могут вклиниться между read и remove.
 */
export function claimSupervisorLock({
  lockPath,
  now,
  staleMinutes,
  isAlive,
  pid = process.pid,
  readLock,
  writeLock,
  removeLock,
  claimLock,
  underGuard = underLockGuard,
}) {
  const guarded = underGuard(
    lockPath,
    () => {
      const existingLock = readLock();
      const verdict = lockVerdict(existingLock, now, staleMinutes, isAlive, pid);
      if (!verdict.take) return { acquired: false, why: verdict.why };

      const handedFrom = existingLock?.handedFrom ?? null;
      // Переданный lock уже принадлежит новому PID; окна без lock нет.
      if (existingLock?.pid === pid) {
        writeLock(newLock(pid, now));
        return { acquired: true, handedFrom };
      }

      // remove разрешён только под тем же guard, который защищает recovery.
      // Поэтому между verdict и remove другой живой owner появиться не может.
      if (existingLock) removeLock(existingLock);
      return claimLock(newLock(pid, now))
        ? { acquired: true, handedFrom }
        : { acquired: false, why: 'замок занят при атомарном захвате' };
    },
    pid,
  );

  return guarded.ok ? guarded.value : { acquired: false, why: guarded.reason };
}

/** Создать stateful supervisor только после подтверждённого владения lock. */
export function createOwnedSupervisor({ claim, createSupervisor }) {
  const ownership = claim();
  return ownership.acquired
    ? { ownership, supervisor: createSupervisor() }
    : { ownership, supervisor: null };
}

/** Не снять lock нового владельца при позднем завершении старого процесса. */
export function releaseSupervisorLock({
  lockPath,
  pid = process.pid,
  readLock,
  removeLock,
  underGuard = underLockGuard,
}) {
  const guarded = underGuard(
    lockPath,
    () => {
      const current = readLock();
      if (current?.pid !== pid) return false;
      removeLock(current);
      return true;
    },
    pid,
  );
  return Boolean(guarded.ok && guarded.value);
}
