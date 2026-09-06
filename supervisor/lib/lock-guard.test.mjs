import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimLockGuard, releaseLockGuard, underLockGuard } from './lock-guard.mjs';

describe('короткий guard supervisor lock', () => {
  it('пускает только одного contender и снимается только владельцем', () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'lock-guard-')), 'supervisor.lock');
    const first = claimLockGuard(lock, 101);
    expect(first).not.toBeNull();
    expect(claimLockGuard(lock, 202)).toBeNull();
    releaseLockGuard({ ...first, token: 'чужой' });
    expect(existsSync(first.path)).toBe(true);
    releaseLockGuard(first);
    expect(existsSync(first.path)).toBe(false);
  });

  it('не выполняет claim при занятом guard', () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'lock-guard-')), 'supervisor.lock');
    writeFileSync(`${lock}.guard`, 'чужой');
    expect(underLockGuard(lock, () => writeFileSync(lock, 'нельзя'))).toMatchObject({ ok: false });
    expect(existsSync(lock)).toBe(false);
  });

  it('создаёт отсутствующий вложенный local directory до первого atomic claim', () => {
    const local = join(mkdtempSync(join(tmpdir(), 'lock-guard-')), 'fresh', '.pipeline');
    const lock = join(local, 'supervisor.lock');
    expect(existsSync(local)).toBe(false);
    const guard = claimLockGuard(lock, 101);
    expect(guard).not.toBeNull();
    expect(existsSync(local)).toBe(true);
    expect(existsSync(guard.path)).toBe(true);
    releaseLockGuard(guard);
  });
});
