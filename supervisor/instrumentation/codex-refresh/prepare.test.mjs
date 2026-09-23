import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { checkWorkspace, readTar, verifyArchive } from './prepare.mjs';
import { checkEntry, checkedRun, checkManifest, parseTree, pinned } from './prepare.mjs';

describe('pinned refresh source preparation', () => {
  it('rejects foreign source and toolchain before fetching', () => {
    const manifest = { ...pinned, toolchain: '1.95.0', target: 'x86_64-pc-windows-msvc' };
    expect(() => checkManifest(manifest)).not.toThrow();
    for (const key of Object.keys(manifest)) {
      expect(() => checkManifest({ ...manifest, [key]: 'foreign' })).toThrow();
    }
  });
  it.each([
    '../escape',
    '/absolute',
    'a/../../b',
    'a\\b',
    'c:stream',
    'a//b',
    'a/NUL.rs',
    'a/b.',
    'a/b ',
  ])('rejects unsafe path %s', (name) => {
    expect(() => checkEntry(name)).toThrow('unsafe-source-path');
  });
  it('preserves exact blob identity and mode for admission', () => {
    const oid = 'a'.repeat(40);
    expect(parseTree(Buffer.from(`100644 blob ${oid}\tcodex-rs/Cargo.lock\0`))).toEqual([
      { mode: '100644', type: 'blob', oid, path: 'codex-rs/Cargo.lock' },
    ]);
    expect(() => parseTree(Buffer.from('unknown\0'))).toThrow('invalid-tree-entry');
  });
  it('retains failure code without logging arbitrary stderr', () => {
    expect(() => checkedRun('git', [], {}, () => ({ status: 1, stderr: 'SECRET_CANARY' }))).toThrow(
      'process-failed:git:1',
    );
  });
});

function tarEntry(name, content, type = '0') {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(body.length.toString(8).padStart(11, '0'), 124);
  header.write(type, 156);
  header.fill(32, 148, 156);
  header.write(
    header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0'),
    148,
  );
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

describe('archive and filesystem boundaries', () => {
  it('accepts regular bytes and validates their Git object identity', () => {
    const bytes = Buffer.from('source');
    const files = readTar(tarEntry('root/file', bytes));
    const tree = [
      {
        path: 'file',
        type: 'blob',
        mode: '100644',
        oid: createHash('sha1').update('blob 6\0').update(bytes).digest('hex'),
      },
    ];
    expect(() => verifyArchive(tree, files)).not.toThrow();
    files.set('file', Buffer.from('damage'));
    expect(() => verifyArchive(tree, files)).toThrow('archive-blob-mismatch:file');
    files.delete('file');
    expect(() => verifyArchive(tree, files)).toThrow('unknown-archive-input');
    files.set('file', bytes);
    files.set('extra', bytes);
    expect(() => verifyArchive(tree, files)).toThrow('unknown-archive-input');
  });
  it('rejects tar escape, duplicate, corruption and truncation before writes', () => {
    expect(() => readTar(tarEntry('root/../escape', 'x'))).toThrow('unsafe-source-path');
    const entry = tarEntry('root/file', 'source');
    expect(() => readTar(Buffer.concat([entry, entry]))).toThrow('duplicate-tar-entry');
    expect(() => readTar(entry.subarray(0, 514))).toThrow('invalid-tar-size');
    entry[0] ^= 1;
    expect(() => readTar(entry)).toThrow('invalid-tar-checksum');
  });
  it('checks effective PAX names rather than trusting the header name', () => {
    const value = 'path=root/../escape\n';
    const length = value.length + 3;
    expect(() =>
      readTar(
        Buffer.concat([
          tarEntry('root/pax', `${length} ${value}`, 'x'),
          tarEntry('root/file', 'x'),
        ]),
      ),
    ).toThrow('unsafe-source-path');
    expect(() => readTar(tarEntry('root/pax', '999 path=x\n', 'x'))).toThrow('invalid-pax');
  });
  it('rejects directory escape, junction and broken symlink without following them', () => {
    const root = path.resolve('.');
    const destination = path.join(root, 'child');
    const regular = {
      realpathSync: (name) => name,
      lstatSync: () => ({ isSymbolicLink: () => false }),
    };
    expect(checkWorkspace(root, destination, regular)).toBe(destination);
    expect(() => checkWorkspace(root, root, regular)).toThrow('workspace-escape');
    expect(() => checkWorkspace(root, path.resolve(root, '../other'), regular)).toThrow(
      'workspace-escape',
    );
    expect(() =>
      checkWorkspace(root, destination, {
        ...regular,
        lstatSync: () => ({ isSymbolicLink: () => true }),
      }),
    ).toThrow('workspace-reparse');
    expect(() =>
      checkWorkspace(root, destination, {
        ...regular,
        realpathSync: (name) => (name === root ? root : path.join(root, 'elsewhere')),
      }),
    ).toThrow('workspace-reparse');
  });
});
