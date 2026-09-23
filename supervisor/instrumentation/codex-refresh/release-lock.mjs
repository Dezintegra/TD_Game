import { createHash } from 'node:crypto';

export const UPSTREAM_LOCK_SHA256 =
  '3494b8a78d0f643556a83a9cc184e912bcab9f4c5640288952f4223452ba5dc8';
export const RELEASE_LOCK_SHA256 =
  'a2cb91dfb2e8112bc81d05158fa00b9698e2df8cc1ae0547b5dc5606a44904d3';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function compareReleaseLock(before, after) {
  const changed = [];
  // Сравниваем все остальные bytes, а не только номера версий: это запрещает
  // скрытое обновление registry/git зависимостей при подготовке release lock.
  const expected = before
    .split('[[package]]')
    .map((part, index) => {
      if (index === 0 || /^source = /mu.test(part) || !/^version = "0.0.0"$/mu.test(part)) {
        return part;
      }
      const name = /^name = "([A-Za-z0-9_-]+)"$/mu.exec(part)?.[1];
      if (!name || changed.includes(name)) throw new Error('invalid-workspace-package');
      changed.push(name);
      return part.replace(/^version = "0.0.0"$/mu, 'version = "0.153.4"');
    })
    .join('[[package]]');
  if (!changed.length || expected !== after) throw new Error('unexpected-lock-diff');
  return changed;
}

export function verifyPinnedReleaseLock(before, after) {
  if (sha256(before) !== UPSTREAM_LOCK_SHA256) throw new Error('upstream-lock-mismatch');
  const changed = compareReleaseLock(before, after);
  if (changed.length !== 149 || sha256(after) !== RELEASE_LOCK_SHA256) {
    throw new Error('release-lock-mismatch');
  }
  return { changed, upstreamSha256: sha256(before), releaseSha256: sha256(after) };
}
