import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';

const TIMEOUT = 600_000;

export function checkedProcess(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
    shell: false,
  });
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    /(?:^|\n)(?:error|fatal):/i.test(result.stderr ?? '')
  ) {
    throw new Error(
      `${program}: ${result.error?.code ?? result.signal ?? result.status}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`,
    );
  }
  return result;
}

function within(parent, child) {
  const path = relative(parent, child);
  return path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

function contained(parent, child) {
  if (!within(parent, realpathSync(child))) throw new Error(`Path escapes workspace: ${child}`);
}

export function findPnpm(env = process.env) {
  const candidates = [env.npm_execpath];
  for (const directory of [
    dirname(process.execPath),
    ...(env.PATH ?? env.Path ?? '').split(delimiter),
  ]) {
    if (!directory) continue;
    candidates.push(join(directory, 'node_modules/pnpm/bin/pnpm.cjs'), join(directory, 'pnpm.cjs'));
  }
  const cli = candidates.find((path) => path && /pnpm\.(?:c?js)$/.test(path) && existsSync(path));
  if (!cli) throw new Error('Prerequisites: installed pnpm CLI not found');
  return realpathSync(cli);
}

function* cacheFiles(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected cache link: ${path}`);
    if (entry.isFile()) yield path;
    if (entry.isDirectory()) yield* cacheFiles(path);
  }
}

function firstPackageFile(store) {
  // pnpm 10.12.4: индекс v10 связывает пакет с SHA-512 файлами CAFS.
  // Один маркер или даже файл с похожим именем не доказывает наличие пакета.
  const files = new Set(cacheFiles(store));
  for (const path of files) {
    const local = relative(store, path).split(sep).join('/');
    if (!/^v10\/index\/[a-f0-9]{2}\/[a-f0-9]{62}-.+\.json$/.test(local)) continue;
    const index = JSON.parse(readFileSync(path, 'utf8'));
    if (!index.name || !index.version || !index.files?.['package.json']) continue;
    let manifestPath;
    let valid = true;
    for (const [name, file] of Object.entries(index.files)) {
      if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(file.integrity ?? '')) {
        valid = false;
        break;
      }
      const hash = Buffer.from(file.integrity.slice(7), 'base64').toString('hex');
      const suffix = file.mode & 0o111 ? '-exec' : '';
      const content = join(store, 'v10/files', hash.slice(0, 2), hash.slice(2) + suffix);
      if (!files.has(content) || statSync(content).size !== file.size) {
        valid = false;
        break;
      }
      const bytes = readFileSync(content);
      if (createHash('sha512').update(bytes).digest('hex') !== hash) {
        valid = false;
        break;
      }
      if (name === 'package.json') manifestPath = content;
    }
    if (!valid || !manifestPath) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name === index.name && manifest.version === index.version) return manifestPath;
  }
  return null;
}

export function checkInstallSnapshot({ cwd = process.cwd(), pnpmCli, run = checkedProcess } = {}) {
  const root = realpathSync(cwd);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const report = {
    ok: false,
    stage: 'prerequisites',
    parent: root,
    node: process.version,
    platform: process.platform,
  };
  let diagnostic;
  const git = (where, ...args) =>
    run(
      'git',
      [
        '-C',
        where,
        '-c',
        'core.fsmonitor=false',
        '-c',
        `safe.directory=${where.split(sep).join('/')}`,
        ...args,
      ],
      { cwd: root, env },
    ).stdout;
  const status = (where) => git(where, 'status', '--porcelain', '--untracked-files=all');
  const clean = (where) => {
    const value = status(where);
    if (value !== '') throw new Error(`Dirty snapshot: ${value}`);
    return value;
  };
  try {
    if (realpathSync(git(root, 'rev-parse', '--show-toplevel').trim()) !== root)
      throw new Error('cwd must be Git root');
    clean(root);
    report.revision = git(root, 'rev-parse', 'HEAD').trim();
    if (git(root, 'rev-parse', '@{u}').trim() !== report.revision)
      throw new Error('HEAD must equal upstream');
    report.git = git(root, '--version').trim();
    const cli = pnpmCli ?? findPnpm();
    report.pnpm = run(process.execPath, [cli, '--version'], { cwd: root, env }).stdout.trim();
    const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager;
    if (expected?.split('+')[0] !== `pnpm@${report.pnpm}`)
      throw new Error(`Prerequisites: pnpm version mismatch: ${report.pnpm} / ${expected}`);
    const base = join(root, '.matchlog');
    if (existsSync(base)) contained(root, base);
    else mkdirSync(base);
    contained(root, base);
    const directory = mkdtempSync(join(base, 'install-check-'));
    contained(root, directory);
    diagnostic = join(directory, 'result.json');
    report.directory = directory;
    report.snapshot = join(directory, 'snapshot');
    report.stage = 'prepare';
    mkdirSync(report.snapshot);
    contained(root, report.snapshot);
    const archive = join(directory, 'source.tar');
    git(root, 'archive', '--format=tar', `--output=${archive}`, report.revision);
    run('tar', ['-xf', archive, '-C', report.snapshot], { cwd: root, env });
    git(report.snapshot, 'init');
    const absentIgnore = join(directory, 'absent-ignore');
    if (existsSync(absentIgnore)) throw new Error('Ignore override must not exist');
    const hooks = join(directory, 'hooks');
    mkdirSync(hooks);
    for (const [key, value] of Object.entries({
      'core.excludesFile': absentIgnore,
      'core.fsmonitor': 'false',
      'core.hooksPath': hooks,
      'user.name': 'Install check',
      'user.email': 'install-check@example.invalid',
    }))
      git(report.snapshot, 'config', '--local', key, value);
    const files = git(root, 'ls-tree', '-r', '--name-only', '-z', report.revision)
      .split('\0')
      .filter(Boolean);
    // Явные пути порциями избегают предела командной строки Windows.
    for (let i = 0; i < files.length; i += 20)
      git(report.snapshot, 'add', '--', ...files.slice(i, i + 20));
    git(report.snapshot, 'commit', '-m', 'Snapshot baseline');
    report.initialStatus = clean(report.snapshot);
    const store = join(report.snapshot, '.pnpm-store');
    report.cacheAbsent = !existsSync(store) && !existsSync(join(report.snapshot, 'node_modules'));
    if (!report.cacheAbsent) throw new Error('Snapshot contains old installation');
    report.stage = 'install';
    const installed = run(
      process.execPath,
      [cli, 'install', '--frozen-lockfile', '--store-dir', '.pnpm-store'],
      { cwd: report.snapshot, env },
    );
    report.install = {
      status: installed.status,
      stdout: installed.stdout,
      stderr: installed.stderr,
    };
    report.stage = 'verify';
    const cacheFile = existsSync(store) && firstPackageFile(store);
    if (!cacheFile) throw new Error('Cache has no nonempty package files');
    report.cacheFile = relative(report.snapshot, cacheFile).split(sep).join('/');
    report.installedStatus = clean(report.snapshot);
    report.ignore = git(report.snapshot, 'check-ignore', '-v', '.pnpm-store/', report.cacheFile);
    const sources = report.ignore.trim().split('\n');
    if (
      sources.length !== 2 ||
      sources.some((line) => !/^\.gitignore:[0-9]+:\.pnpm-store\/\t/.test(line))
    )
      throw new Error(`Wrong ignore source: ${report.ignore}`);
    const source = files.find((file) => /^(?:packages|apps)\/.*\.(?:ts|js)$/.test(file));
    if (!source) throw new Error('No tracked source for negative control');
    const sourcePath = join(report.snapshot, source);
    const original = readFileSync(sourcePath);
    writeFileSync(sourcePath, Buffer.concat([original, Buffer.from('\n// install check\n')]));
    report.sourceStatus = status(report.snapshot);
    if (report.sourceStatus !== ` M ${source}\n`)
      throw new Error(`Source control failed: ${report.sourceStatus}`);
    writeFileSync(sourcePath, original);
    report.restoredSourceStatus = clean(report.snapshot);
    const extra = 'install-check-untracked.txt';
    writeFileSync(join(report.snapshot, extra), 'negative control', { flag: 'wx' });
    report.extraStatus = status(report.snapshot);
    if (report.extraStatus !== `?? ${extra}\n`)
      throw new Error(`Untracked control failed: ${report.extraStatus}`);
    unlinkSync(join(report.snapshot, extra));
    report.finalStatus = clean(report.snapshot);
    report.ok = true;
    report.stage = 'complete';
  } catch (error) {
    report.error = error.message;
  }
  if (diagnostic) writeFileSync(diagnostic, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
