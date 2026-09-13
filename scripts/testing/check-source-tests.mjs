import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkInstallSnapshot,
  checkedProcess,
  findPnpm,
} from '../../supervisor/lib/install-snapshot-check.mjs';
import { repoRoot } from './source-aliases.mjs';
import { runSourceTests } from './source-runner.mjs';

const crowd = 'packages/sim/src/crowd.test.ts';
const step = 'packages/sim/src/step.test.ts';
const simGolden = 'packages/sim/src/determinism.golden.match.test.ts';
const aiGolden = 'packages/ai/src/profile.golden.match.test.ts';
export const sourceMatrix = [
  { environment: 'node', files: [crowd, step] },
  { environment: 'jsdom', files: [crowd, step] },
  { environment: 'node', files: [simGolden] },
  { environment: 'jsdom', files: [simGolden] },
  { environment: 'node', files: [aiGolden] },
];

export function sourcePnpm(env = process.env, realpath = realpathSync, finder = findPnpm) {
  try {
    return finder(env);
  } catch (original) {
    // pnpm/action-setup на Linux кладёт в PATH ссылку bin/pnpm, не pnpm.cjs.
    // Передаём её проверенный target существующему помощнику без изменения его контракта.
    for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
      if (!directory || !existsSync(resolve(directory, 'pnpm'))) continue;
      const cli = realpath(resolve(directory, 'pnpm'));
      if (/pnpm\.(?:c?js)$/.test(cli)) return finder({ ...env, npm_execpath: cli });
    }
    throw original;
  }
}

export function assertNoDist(root) {
  for (const pkg of ['shared', 'sim', 'ai'])
    if (existsSync(resolve(root, `packages/${pkg}/dist`)))
      throw new Error(`Unexpected dist: ${pkg}`);
  return true;
}

export function assertExecution(report, selection, root) {
  if (!report?.ok || report.repoRoot !== root || report.environment !== selection.environment)
    throw new Error(`Source invocation failed: ${JSON.stringify(report)}`);
  if (
    JSON.stringify(report.executed?.map((entry) => entry.file).sort()) !==
      JSON.stringify([...selection.files].sort()) ||
    report.executed.some((entry) => !(entry.passed > 0) || entry.failed !== 0)
  )
    throw new Error(`Invalid execution evidence: ${JSON.stringify(report)}`);
}

export function runMatrix(root, report, { invoke = runSourceTests, noDist = assertNoDist } = {}) {
  report.noDistBefore = noDist(root);
  report.matrix = [];
  for (const selection of sourceMatrix) {
    console.log(`Source matrix: ${selection.environment} ${selection.files.join(' ')}`);
    const result = invoke(selection, { root, cwd: root });
    report.matrix.push(result);
    assertExecution(result, selection, root);
  }
  report.noDistAfter = noDist(root);
}

function contained(parent, path) {
  const local = relative(realpathSync(parent), realpathSync(path));
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
    throw new Error(`Path escapes owned directory: ${path}`);
}

export function runControls(root, report, { invoke = runSourceTests } = {}) {
  report.controls = [];
  for (const [pkg, file] of [
    ['shared', crowd],
    ['sim', aiGolden],
  ]) {
    const source = resolve(root, `packages/${pkg}/src/index.ts`);
    contained(root, source);
    const original = readFileSync(source);
    const marker = `TD_SOURCE_CONTROL_${pkg.toUpperCase()}`;
    const selection = { environment: 'node', files: [file] };
    const control = { pkg, marker, source };
    report.controls.push(control);
    try {
      writeFileSync(source, `throw new Error('${marker}');\n${original.toString('utf8')}`);
      control.failure = invoke(selection, { root, cwd: root });
      if (
        control.failure.ok ||
        !`${control.failure.stderr}\n${control.failure.stdout}`.includes(marker)
      )
        throw new Error(`Unrecognized negative control: ${marker}`);
      control.detected = true;
    } finally {
      writeFileSync(source, original);
      control.restoredBytes = readFileSync(source).equals(original);
    }
    control.restored = invoke(selection, { root, cwd: root });
    assertExecution(control.restored, selection, root);
  }
  report.controlsNoDist = assertNoDist(root);
}

export function installedControlCopy(
  root,
  revision,
  directory,
  { run = checkedProcess, pnpmCli = sourcePnpm() } = {},
) {
  const snapshot = resolve(directory, 'controls');
  mkdirSync(snapshot);
  contained(root, snapshot);
  const archive = resolve(directory, 'source.tar');
  run('git', ['-C', root, 'archive', '--format=tar', `--output=${archive}`, revision], {
    cwd: root,
  });
  run('tar', ['-xf', archive, '-C', snapshot], { cwd: root });
  assertNoDist(snapshot);
  run(
    process.execPath,
    [pnpmCli, 'install', '--frozen-lockfile', '--prefer-offline', '--store-dir', '.pnpm-store'],
    { cwd: snapshot },
  );
  assertNoDist(snapshot);
  return snapshot;
}

export function checkSourceTests(
  mode,
  {
    root = repoRoot,
    snapshotCheck = checkInstallSnapshot,
    run = checkedProcess,
    copy = installedControlCopy,
    matrix = runMatrix,
    controls = runControls,
  } = {},
) {
  if (!['--fresh', '--installed'].includes(mode))
    throw new Error('Expected --fresh or --installed');
  root = realpathSync(root);
  const report = {
    ok: false,
    mode,
    repoRoot: root,
    node: process.version,
    platform: process.platform,
  };
  const base = resolve(root, '.matchlog');
  mkdirSync(base, { recursive: true });
  contained(root, base);
  const directory = mkdtempSync(resolve(base, 'source-check-'));
  report.directory = directory;
  const git = (...args) => run('git', ['-C', root, ...args], { cwd: root }).stdout.trim();
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== root)
      throw new Error('Expected Git root');
    if (git('status', '--porcelain', '--untracked-files=all'))
      throw new Error('Expected clean checkout');
    report.revision = git('rev-parse', 'HEAD');
    report.git = git('--version');
    const pnpmCli = sourcePnpm();
    let target = root;
    if (mode === '--fresh') {
      report.install = snapshotCheck({ cwd: root, pnpmCli });
      if (!report.install.ok)
        throw new Error(`Fresh installation failed: ${JSON.stringify(report.install)}`);
      target = realpathSync(report.install.snapshot);
      contained(root, target);
    }
    report.snapshot = target;
    report.vitest = JSON.parse(
      readFileSync(resolve(target, 'node_modules/vitest/package.json')),
    ).version;
    report.pnpm = run(process.execPath, [pnpmCli, '--version'], { cwd: root }).stdout.trim();
    matrix(target, report);
    // В detached checkout контроля upstream нет; контрольная копия берётся из SHA.
    const controlRoot = mode === '--fresh' ? target : copy(root, report.revision, directory);
    contained(root, controlRoot);
    report.controlRoot = controlRoot;
    controls(controlRoot, report);
    if (
      git('rev-parse', 'HEAD') !== report.revision ||
      git('status', '--porcelain', '--untracked-files=all')
    )
      throw new Error('Checkout changed during verification');
    report.ok = true;
  } catch (error) {
    report.error = error.message;
  }
  writeFileSync(resolve(directory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function checkSourceMain(args = process.argv.slice(2)) {
  try {
    if (args.length !== 1 || realpathSync(process.cwd()) !== realpathSync(repoRoot))
      throw new Error('Run from repository root with --fresh or --installed');
    const report = checkSourceTests(args[0]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return report;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  checkSourceMain();
