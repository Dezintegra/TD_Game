import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, parse, sep } from 'node:path';

export const CONSUMER_TASK = '0083-pravka-purpose-speki-ne-dostavlyaetsya-d';
export const CONSUMER_CHANGE = 'guard-declared-purpose-updates';
export const HOST_DIRECTORY = '.matchlog/0302-project-skill-host';
export const HOST_EVIDENCE = '.matchlog/0302-project-skill-host-evidence.json';
export const TARGETS = [
  '.agents/skills/openspec-archive-change/SKILL.md',
  '.agents/skills/openspec-sync-specs/SKILL.md',
];
export const CONTROLS = [
  '.agents/skills/unassigned/SKILL.md',
  '.codex/control.txt',
  '../foreign/control.txt',
];
export const INITIAL =
  '---\nname: diagnostic-fixture\ndescription: Inert permission diagnostic fixture.\n---\n\n<!-- 0299:initial -->\n';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const samePath = (a, b) => relative(resolve(a), resolve(b)) === '';
export function within(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function hostError(code) {
  return Object.assign(new Error(code), { hostCode: code });
}

/** Только обычные компоненты: junction и прочие reparse tags не считаются каталогами. */
export function ordinaryPath(file, directory, io) {
  const absolute = resolve(file);
  let current = parse(absolute).root;
  const components = absolute.slice(current.length).split(sep).filter(Boolean);
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = join(current, components[i]);
    io.checkTime();
    const stat = io.fs.lstatSync(current);
    const isDir = i < components.length - 1 || directory;
    if (
      stat.isSymbolicLink() ||
      !(isDir ? stat.isDirectory() : stat.isFile()) ||
      (!isDir && stat.nlink !== 1)
    )
      throw hostError('path-type');
    if (io.platform === 'win32') {
      const attributes = io.exec('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -Force -LiteralPath '${current.replaceAll("'", "''")}' -ErrorAction Stop).Attributes.value__`,
      ]);
      if (!/^[0-9]+$/.test(attributes) || (Number(attributes) & 1024) !== 0)
        throw hostError('reparse-point');
    }
    if (!samePath(current, io.fs.realpathSync(current))) throw hostError('redirected-path');
  }
  return absolute;
}

export function hostIO(effects = {}) {
  const now = effects.now ?? Date.now;
  const deadline = now() + 600000;
  const io = {
    fs,
    now,
    platform: process.platform,
    checkTime() {
      if (now() >= deadline) throw hostError('timeout');
    },
    ...effects,
  };
  io.exec ??= (program, args) => {
    io.checkTime();
    return execFileSync(program, args, {
      encoding: 'utf8',
      timeout: Math.max(1, Math.min(10000, deadline - now())),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  };
  io.git ??= (cwd, ...args) => io.exec('git', ['-C', cwd, ...args]);
  return io;
}

export function registeredTrees(raw) {
  return raw
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      const lines = record.split('\0');
      return {
        tree: lines.find((line) => line.startsWith('worktree '))?.slice(9),
        branch: lines.find((line) => line.startsWith('branch '))?.slice(7),
      };
    });
}

export function validateLinkedTree(root, cwd, taskId, io) {
  ordinaryPath(root, true, io);
  ordinaryPath(cwd, true, io);
  if (samePath(root, cwd)) throw hostError('main-is-not-consumer');
  ordinaryPath(join(cwd, '.git'), false, io);
  const common = ordinaryPath(join(root, '.git'), true, io);
  const gitdir = io.git(cwd, 'rev-parse', '--absolute-git-dir');
  if (!isAbsolute(gitdir) || !within(join(common, 'worktrees'), gitdir))
    throw hostError('gitdir-mismatch');
  ordinaryPath(gitdir, true, io);
  const actualCommon = io.git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!isAbsolute(actualCommon) || !samePath(actualCommon, common))
    throw hostError('common-mismatch');
  const top = io.git(cwd, 'rev-parse', '--show-toplevel');
  if (!isAbsolute(top) || !samePath(top, cwd)) throw hostError('toplevel-mismatch');
  const branch = io.git(cwd, 'symbolic-ref', '--short', 'HEAD');
  if (branch !== `worktree-${taskId}`) throw hostError('branch-mismatch');
  const records = registeredTrees(io.git(root, 'worktree', 'list', '--porcelain', '-z'));
  const matching = records.filter((entry) => entry.tree && samePath(entry.tree, cwd));
  if (matching.length !== 1 || matching[0].branch !== `refs/heads/${branch}`)
    throw hostError('registration-mismatch');
  // Обе стороны указателя сверяются с ответом Git, а не заменяют его.
  const pointer = /^gitdir: (.+)\s*$/.exec(io.fs.readFileSync(join(cwd, '.git'), 'utf8'));
  if (!pointer || !samePath(resolve(cwd, pointer[1].trim()), gitdir))
    throw hostError('pointer-mismatch');
  ordinaryPath(join(gitdir, 'gitdir'), false, io);
  if (!samePath(io.fs.readFileSync(join(gitdir, 'gitdir'), 'utf8').trim(), join(cwd, '.git')))
    throw hostError('backlink-mismatch');
  ordinaryPath(join(gitdir, 'commondir'), false, io);
  if (
    !samePath(resolve(gitdir, io.fs.readFileSync(join(gitdir, 'commondir'), 'utf8').trim()), common)
  )
    throw hostError('common-pointer-mismatch');
  return { root: resolve(root), cwd: resolve(cwd), gitdir: resolve(gitdir), common, branch };
}

export function fixtureFiles() {
  return {
    ...Object.fromEntries([...TARGETS, ...CONTROLS].map((file) => [file, INITIAL])),
    '.matchlog/observe.mjs': `import { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nconst files = ${JSON.stringify([...TARGETS, ...CONTROLS])};\nconsole.log(JSON.stringify(Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))));\n`,
    '.matchlog/negative.mjs': `import { openSync, closeSync, readFileSync } from 'node:fs';\nconst files = ${JSON.stringify(CONTROLS)};\nconst results = [];\nfor (const file of files) {\n  readFileSync(file);\n  try { const fd = openSync(file, 'r+'); closeSync(fd); results.push({file, result:'unexpected-write-access'}); break; }\n  catch (error) { results.push({file, result: error.code}); if (!['EACCES','EPERM'].includes(error.code)) break; }\n}\nconsole.log(JSON.stringify(results));\nprocess.exitCode = results.length === files.length && results.every(r => ['EACCES','EPERM'].includes(r.result)) ? 0 : 1;\n`,
  };
}

export function createHostFixture(workspace, io) {
  const stand = resolve(workspace, HOST_DIRECTORY);
  ordinaryPath(dirname(stand), true, io);
  io.fs.mkdirSync(stand);
  io.fs.writeFileSync(
    join(stand, 'attempt.json'),
    JSON.stringify({ started: new Date(io.now()).toISOString(), maxSessions: 2, maxResumes: 1 }),
    { flag: 'wx' },
  );
  const root = join(stand, 'main');
  const cwd = join(stand, 'tree');
  io.fs.mkdirSync(root);
  io.fs.mkdirSync(join(stand, 'foreign'));
  io.git(root, 'init', '--initial-branch=main');
  io.git(
    root,
    '-c',
    'user.name=Permission fixture',
    '-c',
    'user.email=fixture@invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  io.git(root, 'worktree', 'add', '-b', `worktree-${CONSUMER_TASK}`, cwd);
  for (const [file, content] of Object.entries(fixtureFiles())) {
    const target = resolve(cwd, file);
    if (!within(stand, target)) throw hostError('fixture-path');
    io.fs.mkdirSync(dirname(target), { recursive: true });
    io.fs.writeFileSync(target, content, { flag: 'wx' });
  }
  for (const file of ['.perf-lock', '.perf-log.jsonl'])
    io.fs.writeFileSync(join(root, file), '', { flag: 'wx' });
  const fixture = {
    root,
    cwd,
    stand,
    assignment: {
      taskId: CONSUMER_TASK,
      stage: 'implement',
      path: relative(root, cwd),
      task: { id: CONSUMER_TASK, links: { change: CONSUMER_CHANGE } },
    },
  };
  verifyHostFixture(workspace, fixture, io);
  return fixture;
}

export function verifyHostFixture(workspace, fixture, io, phase = 'baseline', after = false) {
  const stand = resolve(workspace, HOST_DIRECTORY);
  if (
    !samePath(stand, fixture.stand) ||
    !samePath(join(stand, 'main'), fixture.root) ||
    !samePath(join(stand, 'tree'), fixture.cwd)
  )
    throw hostError('fixture-topology');
  validateLinkedTree(fixture.root, fixture.cwd, CONSUMER_TASK, io);
  const hashes = {};
  for (const [file, initial] of Object.entries(fixtureFiles())) {
    let content = initial;
    if (TARGETS.includes(file) && (phase === 'resume' || (phase === 'target' && after)))
      content = content.replace('0299:initial', '0299:assigned');
    if (file === TARGETS[0] && phase === 'resume' && after)
      content = content.replace('0299:assigned', '0299:resumed');
    const target = ordinaryPath(resolve(fixture.cwd, file), false, io);
    hashes[file] = sha256(io.fs.readFileSync(target));
    if (hashes[file] !== sha256(content)) throw hostError('fixture-content');
  }
  for (const file of ['.perf-lock', '.perf-log.jsonl']) {
    ordinaryPath(join(fixture.root, file), false, io);
    if (io.fs.readFileSync(join(fixture.root, file)).length)
      throw hostError('fixture-perf-content');
  }
  return hashes;
}
