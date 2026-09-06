import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Короткий сериализатор операций над supervisor.lock.
 *
 * Сам lock нельзя читать и потом снимать без взаимного исключения: между
 * этими двумя действиями другой участник уже мог честно получить новый PID.
 * Guard живёт только во время claim/remove и всегда снимается владельцем.
 */
export function claimLockGuard(lockPath, pid = process.pid) {
  const path = `${lockPath}.guard`;
  const token = JSON.stringify({ pid, claimedAt: new Date().toISOString() });
  try {
    const descriptor = openSync(path, 'wx');
    writeFileSync(descriptor, token);
    closeSync(descriptor);
    return { path, token };
  } catch {
    return null;
  }
}

export function releaseLockGuard(guard) {
  if (guard && existsSync(guard.path) && readFileSync(guard.path, 'utf8') === guard.token)
    rmSync(guard.path);
}

export function underLockGuard(lockPath, operation, pid = process.pid) {
  const guard = claimLockGuard(lockPath, pid);
  if (!guard) return { ok: false, reason: 'операция с замком уже выполняется' };
  try {
    return { ok: true, value: operation() };
  } finally {
    releaseLockGuard(guard);
  }
}
