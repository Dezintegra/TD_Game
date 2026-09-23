import { describe, expect, it } from 'vitest';
import { compareReleaseLock, verifyPinnedReleaseLock } from './release-lock.mjs';

const local = '[[package]]\nname = "codex-core"\nversion = "0.0.0"\ndependencies = ["external"]\n';
const external =
  '[[package]]\nname = "external"\nversion = "0.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "original"\n';
const before = `version = 4\n${local}${external}`;
const after = before.replace('version = "0.0.0"', 'version = "0.153.4"');

describe('release lock admission', () => {
  it('accepts only local release versions and retains registry version zero', () => {
    expect(compareReleaseLock(before, after)).toEqual(['codex-core']);
  });
  it.each([
    ['checksum', after.replace('"original"', '"changed"')],
    ['external version', after.replace('version = "0.0.0"', 'version = "0.153.4"')],
    ['dependency edge', after.replace('["external"]', '[]')],
    ['missing package', after.replace(external, '')],
    ['added package', after + local],
    ['wrong release', after.replace('0.153.4', '0.155.1')],
    ['unchanged input', before],
  ])('rejects %s', (_name, candidate) => {
    expect(() => compareReleaseLock(before, candidate)).toThrow('unexpected-lock-diff');
  });
  it('rejects git revision drift', () => {
    const gitBefore = before.replace(
      'registry+https://github.com/rust-lang/crates.io-index',
      'git+https://example.invalid/lib#original',
    );
    const gitAfter = after.replace(
      'registry+https://github.com/rust-lang/crates.io-index',
      'git+https://example.invalid/lib#changed',
    );
    expect(() => compareReleaseLock(gitBefore, gitAfter)).toThrow('unexpected-lock-diff');
  });
  it('does not accept synthetic lockfiles as the pinned upstream', () => {
    expect(() => verifyPinnedReleaseLock(before, after)).toThrow('upstream-lock-mismatch');
  });
});
