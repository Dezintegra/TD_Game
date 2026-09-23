import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
export const pinned = Object.freeze({
  origin: 'https://github.com/openai/codex.git',
  tag: 'rust-v0.153.4',
  tagObject: '042fb41b7c813ac7999105e886b2b7aa715b5081',
  sourceCommit: '3d2ee51ca2d5db578f328aa75e20aa22c0197c9a',
  sourceTree: 'c527c7a5f5f199231dc0d819264e9e2180eb126a',
});
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function checkManifest(manifest) {
  for (const [key, value] of Object.entries(pinned)) {
    if (manifest[key] !== value) throw new Error(`manifest-mismatch:${key}`);
  }
  if (manifest.toolchain !== '1.95.0' || manifest.target !== 'x86_64-pc-windows-msvc') {
    throw new Error('toolchain-mismatch');
  }
}

export function checkEntry(name) {
  // Windows запрещает ADS и неоднозначные имена; архиву не даём выбирать путь.
  if (
    !name ||
    name.includes('\\') ||
    path.posix.isAbsolute(name) ||
    name
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.includes(':') ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new Error('unsafe-source-path');
  return name;
}

export function checkWorkspace(root, destination, io = fs) {
  const base = io.realpathSync(root);
  const absolute = path.resolve(destination);
  const relative = path.relative(base, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('workspace-escape');
  }
  let cursor = base;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if (io.lstatSync(cursor).isSymbolicLink() || io.realpathSync(cursor) !== cursor) {
        throw new Error('workspace-reparse');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return absolute;
}

export function parseTree(bytes) {
  return bytes
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/u.exec(line);
      if (!match) throw new Error('invalid-tree-entry');
      return { mode: match[1], type: match[2], oid: match[3], path: checkEntry(match[4]) };
    });
}

export function checkedRun(command, args, options, run = spawnSync) {
  const result = run(command, args, {
    ...options,
    shell: false,
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Не сохраняем произвольный stderr: туда могут попасть credentials/окружение.
    const error = new Error(`process-failed:${command}:${result.error?.code ?? result.status}`);
    error.code = result.error?.code ?? `exit-${result.status}`;
    throw error;
  }
  return Buffer.from(result.stdout ?? '');
}

export function readTar(bytes) {
  const files = new Map();
  let prefix;
  let extended = {};
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const string = (start, end) =>
      header.subarray(start, end).toString('utf8').replace(/\0.*$/su, '');
    const size = Number.parseInt(string(124, 136).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) {
      throw new Error('invalid-tar-size');
    }
    const expected = Number.parseInt(string(148, 156).trim(), 8);
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (expected !== checksum) throw new Error('invalid-tar-checksum');
    const type = string(156, 157);
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    // PAX path тоже проверяется до записи; не передаём архив распаковщику ОС.
    if (type === 'g') continue;
    if (type === 'x') {
      extended = {};
      for (let at = 0; at < body.length;) {
        const space = body.indexOf(32, at);
        const length = Number(body.subarray(at, space).toString());
        if (
          space < at ||
          !Number.isSafeInteger(length) ||
          length <= space - at + 1 ||
          at + length > body.length ||
          body[at + length - 1] !== 10
        )
          throw new Error('invalid-pax');
        const record = body.subarray(space + 1, at + length - 1).toString('utf8');
        const equals = record.indexOf('=');
        const key = record.slice(0, equals);
        if (
          equals < 1 ||
          !['path', 'linkpath', 'mtime', 'atime', 'ctime'].includes(key) ||
          key in extended
        )
          throw new Error('unsupported-pax');
        extended[key] = record.slice(equals + 1);
        at += length;
      }
      continue;
    }
    if (!['', '0', '2', '5'].includes(type)) throw new Error(`unsupported-tar-type:${type}`);
    const name =
      extended.path ?? `${string(345, 500) ? `${string(345, 500)}/` : ''}${string(0, 100)}`;
    const link = extended.linkpath ?? string(157, 257);
    extended = {};
    const parts = name.replace(/\/$/u, '').split('/');
    if (prefix === undefined) prefix = parts[0];
    if (parts.shift() !== prefix) throw new Error('tar-root-mismatch');
    if (!parts.length) continue;
    const relative = checkEntry(parts.join('/'));
    if (type === '5') continue;
    if (files.has(relative)) throw new Error('duplicate-tar-entry');
    files.set(relative, type === '2' ? Buffer.from(link) : body);
  }
  if (!files.size) throw new Error('empty-archive');
  return files;
}

export function verifyArchive(tree, files) {
  if (!tree.length || files.size !== tree.length) throw new Error('unknown-archive-input');
  const names = new Set();
  for (const entry of tree) {
    checkEntry(entry.path);
    if (names.has(entry.path.toLowerCase())) throw new Error('duplicate-source-path');
    names.add(entry.path.toLowerCase());
    const bytes = files.get(entry.path);
    if (
      !bytes ||
      entry.type !== 'blob' ||
      !['100644', '100755', '120000'].includes(entry.mode) ||
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.oid
    ) {
      throw new Error(`archive-blob-mismatch:${entry.path}`);
    }
  }
}

export function prepare({ root = path.resolve(here, '../../..') } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'source-manifest.json')));
  checkManifest(manifest);
  const workspace = checkWorkspace(root, path.join(root, '.matchlog/0372-refresh'));
  fs.mkdirSync(workspace, { recursive: true });
  const receipt = {
    receiptVersion: 1,
    status: 'incomplete',
    startedUtc: new Date().toISOString(),
    sourceCommit: pinned.sourceCommit,
    sourceTree: pinned.sourceTree,
    workspace,
    runtimeExecuted: false,
    buildScriptsExecuted: false,
  };
  const receiptPath = path.join(here, 'receipts/source.json');
  try {
    const source = checkWorkspace(root, path.join(workspace, 'source'));
    if (fs.existsSync(source)) throw new Error('preparation-already-exists');
    const api = (endpoint) =>
      checkedRun('gh', ['api', `repos/openai/codex/${endpoint}`], { cwd: workspace });
    const tag = JSON.parse(api(`git/tags/${pinned.tagObject}`));
    const commit = JSON.parse(api(`git/commits/${pinned.sourceCommit}`));
    if (
      tag.sha !== pinned.tagObject ||
      tag.tag !== pinned.tag ||
      tag.object.sha !== pinned.sourceCommit ||
      tag.object.type !== 'commit' ||
      commit.sha !== pinned.sourceCommit ||
      commit.tree.sha !== pinned.sourceTree
    ) {
      throw new Error('source-identity-mismatch');
    }
    const listing = JSON.parse(api(`git/trees/${pinned.sourceTree}?recursive=1`));
    if (listing.truncated || listing.sha !== pinned.sourceTree)
      throw new Error('incomplete-source-tree');
    const tree = listing.tree
      .filter((entry) => entry.type !== 'tree')
      .map((entry) => ({
        path: checkEntry(entry.path),
        mode: entry.mode,
        type: entry.type,
        oid: entry.sha,
      }));
    const archive = api(`tarball/${pinned.sourceCommit}`);
    receipt.archiveSha256 = sha256(archive);
    receipt.transport = 'github-api-tarball';
    const files = readTar(gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 }));
    verifyArchive(tree, files);
    const inputs = tree.filter(
      (entry) => entry.path.startsWith('codex-rs/') || entry.path === 'LICENSE',
    );
    if (!inputs.length) throw new Error('empty-inputs');
    // Экспорт только regular blobs исключает исполнение checkout hooks и symlink traversal.
    const unsupported = inputs.filter(
      (entry) => !['100644', '100755', '120000'].includes(entry.mode),
    );
    if (unsupported.length) {
      receipt.unsupportedInputs = unsupported;
      throw new Error('unsupported-source-entry');
    }
    fs.mkdirSync(source);
    receipt.inputs = [];
    for (const entry of inputs) {
      const destination = checkWorkspace(root, path.join(source, entry.path));
      let bytes = files.get(entry.path);
      const sourceSha256 = sha256(bytes);
      let materializedFrom = null;
      if (entry.mode === '120000') {
        materializedFrom = checkEntry(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(entry.path), bytes.toString('utf8')),
          ),
        );
        const target = inputs.find(
          (candidate) =>
            candidate.path === materializedFrom && ['100644', '100755'].includes(candidate.mode),
        );
        if (!target) throw new Error('unsupported-link-target');
        bytes = files.get(materializedFrom);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: 'wx' });
      receipt.inputs.push({
        ...entry,
        sourceSha256,
        materializedFrom,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
    const lock = fs.readFileSync(path.join(source, 'codex-rs/Cargo.lock'), 'utf8');
    receipt.gitDependencies = [
      ...new Set([...lock.matchAll(/^source = "(git\+[^"\n]+)"$/gm)].map((m) => m[1])),
    ];
    receipt.buildScripts = receipt.inputs.filter((entry) => entry.path.endsWith('/build.rs'));
    receipt.inputsSha256 = sha256(JSON.stringify(receipt.inputs));
    receipt.source = source;
    receipt.status = 'source-exported-review-pending';
    return receipt;
  } catch (error) {
    receipt.reason = error.message;
    throw error;
  } finally {
    receipt.finishedUtc = new Date().toISOString();
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}
