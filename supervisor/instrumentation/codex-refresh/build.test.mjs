import { Buffer } from 'node:buffer';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { admitWireRecipe, checkNativeTestList, runBuild, verifyAppliedPatch } from './build.mjs';
import { pinned, sha256 } from './prepare.mjs';
import {
  DELIVERY_ROOT,
  admitPackageIndex,
  verifyPackage,
  deliverPackage,
  verifyDelivery,
} from './build.mjs';

// Полностью подменённая filesystem boundary: тест никогда не пишет в host storage.
function packageFixture() {
  const source = path.resolve('.matchlog/synthetic-package');
  const nodes = new Map();
  const normalize = (value) => path.resolve(value);
  const error = (code) => Object.assign(new Error(code), { code });
  function directory(name) {
    name = normalize(name);
    const parent = path.dirname(name);
    if (parent !== name && !nodes.has(parent)) directory(parent);
    nodes.set(name, { directory: true });
  }
  directory(source);
  directory(path.parse(path.resolve(DELIVERY_ROOT)).root);
  const index = {
    version: 1,
    buildId: 'a'.repeat(64),
    files: [
      { path: 'bin/codex.exe', size: 3, sha256: sha256('abc') },
      { path: 'schema.json', size: 2, sha256: sha256('{}') },
    ],
  };
  directory(path.join(source, 'bin'));
  nodes.set(path.join(source, 'bin/codex.exe'), { bytes: Buffer.from('abc') });
  nodes.set(path.join(source, 'schema.json'), { bytes: Buffer.from('{}') });
  nodes.set(path.join(source, 'package-index.json'), { bytes: Buffer.from(JSON.stringify(index)) });
  const read = (name) => {
    const entry = nodes.get(normalize(name));
    if (!entry) throw error('ENOENT');
    return entry;
  };
  const io = {
    realpathSync(name) {
      const entry = read(name);
      return entry.link ?? normalize(name);
    },
    lstatSync(name) {
      const entry = read(name);
      return {
        isSymbolicLink: () => !!entry.link,
        isDirectory: () => !!entry.directory,
        isFile: () => !!entry.bytes,
        size: entry.bytes?.length,
      };
    },
    existsSync: (name) => nodes.has(normalize(name)),
    readdirSync(name) {
      read(name);
      return [...nodes.keys()]
        .filter((key) => path.dirname(key) === normalize(name) && key !== normalize(name))
        .map((key) => path.basename(key));
    },
    readFileSync(name, encoding) {
      const bytes = read(name).bytes;
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
    },
    mkdirSync(name, options) {
      if (nodes.has(normalize(name)) && !options?.recursive) throw error('EEXIST');
      directory(name);
    },
    openSync(name, flags) {
      if (flags !== 'wx' || nodes.has(normalize(name))) throw error('EEXIST');
      nodes.set(normalize(name), { bytes: Buffer.alloc(0) });
      return normalize(name);
    },
    writeSync(fd, bytes, offset, length) {
      const entry = read(fd);
      entry.bytes = Buffer.concat([entry.bytes, bytes.subarray(offset, offset + length)]);
      return length;
    },
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    renameSync(from, to) {
      if (nodes.has(normalize(to))) throw error('EEXIST');
      for (const [name, entry] of [...nodes])
        if (name === normalize(from) || name.startsWith(normalize(from) + path.sep)) {
          nodes.set(normalize(to) + name.slice(normalize(from).length), entry);
          nodes.delete(name);
        }
    },
  };
  const destination = DELIVERY_ROOT;
  const final = path.join(path.resolve(destination), admitPackageIndex(index));
  return { source, destination, final, index, io, nodes };
}

describe('portable package transfer over fake filesystem', () => {
  it('verifies independently after source removal and accepts an identical repeat', () => {
    const f = packageFixture();
    const delivered = deliverPackage(f, { fs: f.io });
    expect(delivered.status).toBe('verified');
    expect(delivered.files).toHaveLength(2);
    expect(deliverPackage(f, { fs: f.io }).reused).toBe(true);
    for (const name of [...f.nodes.keys()]) if (name.startsWith(f.source)) f.nodes.delete(name);
    expect(verifyDelivery(f, { fs: f.io })).toMatchObject({
      status: 'verified',
      sourceFallback: false,
      runtimeExecuted: false,
    });
  });
  it.each(['missing', 'truncated', 'hash', 'extra', 'index', 'link'])(
    'rejects destination %s after a successful copy',
    (mutation) => {
      const f = packageFixture();
      deliverPackage(f, { fs: f.io });
      const file = path.join(f.final, 'schema.json');
      if (mutation === 'missing') f.nodes.delete(file);
      if (mutation === 'truncated') f.nodes.set(file, { bytes: Buffer.from('{') });
      if (mutation === 'hash') f.nodes.set(file, { bytes: Buffer.from('[]') });
      if (mutation === 'extra')
        f.nodes.set(path.join(f.final, 'foreign'), { bytes: Buffer.from('x') });
      if (mutation === 'index')
        f.nodes.set(path.join(f.final, 'package-index.json'), { bytes: Buffer.from('{}') });
      if (mutation === 'link') f.nodes.set(file, { bytes: Buffer.from('{}'), link: f.source });
      expect(() => verifyDelivery(f, { fs: f.io })).toThrow();
      expect(() => deliverPackage(f, { fs: f.io })).toThrow();
    },
  );
  it.each(['openSync', 'writeSync', 'fsyncSync', 'renameSync'])(
    'does not report success after %s failure',
    (method) => {
      const f = packageFixture();
      f.io[method] = () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      };
      expect(() => deliverPackage(f, { fs: f.io })).toThrow('denied');
      expect(f.nodes.has(f.final)).toBe(false);
    },
  );
  it('does not escape the fixed destination or overwrite an existing staging directory', () => {
    const f = packageFixture();
    expect(() => deliverPackage({ ...f, destination: f.source }, { fs: f.io })).toThrow(
      'unsupported-delivery-root',
    );
    f.io.mkdirSync(f.final + '.staging', { recursive: true });
    expect(() => deliverPackage(f, { fs: f.io })).toThrow('EEXIST');
  });
  it('rejects reparse parents before writing any files', () => {
    const f = packageFixture();
    const parent = path.dirname(path.resolve(f.destination));
    f.io.mkdirSync(parent, { recursive: true });
    f.nodes.set(parent, { directory: true, link: f.source });
    expect(() => deliverPackage(f, { fs: f.io })).toThrow('workspace-reparse');
    expect(f.nodes.has(f.final)).toBe(false);
  });
  it('rejects path aliases, case collisions and self-hashing entries', () => {
    const f = packageFixture();
    for (const name of ['../outside', 'bin/../outside', 'package-index.json', 'CON']) {
      expect(() =>
        admitPackageIndex({ ...f.index, files: [{ ...f.index.files[0], path: name }] }),
      ).toThrow();
    }
    expect(() =>
      admitPackageIndex({
        ...f.index,
        files: [
          { ...f.index.files[0], path: 'A' },
          { ...f.index.files[0], path: 'a' },
        ],
      }),
    ).toThrow('invalid-package-entry');
    expect(verifyPackage(f.source, f.index, f.io).files).toHaveLength(2);
  });
});

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
