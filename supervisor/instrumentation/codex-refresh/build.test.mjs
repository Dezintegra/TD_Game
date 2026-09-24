import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { admitWireRecipe, checkNativeTestList, runBuild, verifyAppliedPatch } from './build.mjs';
import { pinned, sha256 } from './prepare.mjs';

const files = [
  'codex-rs/Cargo.lock',
  'codex-rs/windows-sandbox-rs/Cargo.toml',
  'codex-rs/windows-sandbox-rs/src/lib.rs',
  'codex-rs/windows-sandbox-rs/src/refresh_boundary.rs',
];
const patch = Buffer.from('synthetic patch, never used as production source');
const recipe = {
  version: 1,
  stage: 'wire-only',
  target: 'x86_64-pc-windows-msvc',
  toolchain: '1.95.0',
  tests: ['refresh_boundary::tests::refresh_boundary_wire_roundtrip_fixture'],
  inputs: files.map((path) => ({ path, sha256: 'a'.repeat(64) })),
};
function fixture(value = recipe) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    bytes,
    manifest: {
      ...pinned,
      toolchain: '1.95.0',
      target: 'x86_64-pc-windows-msvc',
      patchSha256: sha256(patch),
      recipeSha256: sha256(bytes),
    },
  };
}
describe('wire build admission (not final build/package)', () => {
  it('rejects a patch that does not describe the tested source', () => {
    const run = vi.fn(() => ({ status: 1 }));
    expect(() => verifyAppliedPatch('source', 'patch', run)).toThrow('patch-source-mismatch');
    expect(run.mock.calls[0][1]).toEqual([
      '-C',
      'source',
      'apply',
      '--check',
      '--reverse',
      'patch',
    ]);
    run.mockReturnValue({ status: 0 });
    expect(() => verifyAppliedPatch('source', 'patch', run)).not.toThrow();
  });
  it('admits the exact declared patch and recipe', () => {
    const { bytes, manifest } = fixture();
    expect(() => admitWireRecipe(manifest, recipe, patch, bytes)).not.toThrow();
  });
  it('rejects changed patch bytes', () => {
    const { bytes, manifest } = fixture();
    expect(() => admitWireRecipe(manifest, recipe, Buffer.from('changed'), bytes)).toThrow(
      'patch-mismatch',
    );
  });
  it('rejects changed recipe bytes', () => {
    const { manifest } = fixture();
    expect(() => admitWireRecipe(manifest, recipe, patch, Buffer.from('changed'))).toThrow(
      'recipe-mismatch',
    );
  });
  it.each([
    ['empty tests', { ...recipe, tests: [] }, 'invalid-test-list'],
    ['foreign tests', { ...recipe, tests: ['setup::real_setup'] }, 'invalid-test-list'],
    [
      'duplicate tests',
      { ...recipe, tests: [...recipe.tests, ...recipe.tests] },
      'invalid-test-list',
    ],
    [
      'foreign source path',
      {
        ...recipe,
        inputs: [...recipe.inputs.slice(1), { path: '../outside', sha256: 'a'.repeat(64) }],
      },
      'invalid-input-list',
    ],
    ['unsupported target', { ...recipe, target: 'aarch64-pc-windows-msvc' }, 'unsupported-recipe'],
  ])('rejects %s', (_name, value, reason) => {
    const { bytes, manifest } = fixture(value);
    expect(() => admitWireRecipe(manifest, value, patch, bytes)).toThrow(reason);
  });
  it.each(['build', 'reproduce', 'package', 'deliver', 'verify-delivery', 'negative', 'shell'])(
    'refuses unavailable mode %s before I/O or spawn',
    (mode) => {
      const run = vi.fn();
      const io = { realpathSync: vi.fn() };
      expect(() =>
        runBuild({ projectRoot: 'unused', mode, group: 'wire' }, { run, fs: io }),
      ).toThrow('unsupported-build-mode');
      expect(run).not.toHaveBeenCalled();
      expect(io.realpathSync).not.toHaveBeenCalled();
    },
  );
  it('requires an exact nonempty native harness list, not a successful empty filter', () => {
    const names = recipe.tests;
    expect(checkNativeTestList(`${names[0]}: test\r\n\r\n1 test, 0 benchmarks`, names)).toEqual(
      names,
    );
    for (const text of [
      '',
      '0 tests, 0 benchmarks',
      `${names[0]}: test\n${names[0]}: test`,
      'other: test',
    ])
      expect(() => checkNativeTestList(text, names)).toThrow('native-test-list-mismatch');
  });
});
