import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { repoRoot } from './source-aliases.mjs';

export const goldenFiles = [
  'packages/sim/src/determinism.golden.match.test.ts',
  'packages/ai/src/profile.golden.match.test.ts',
];
const normalized = (path) => path.split(sep).join('/');

export function validateSelection(selection, root = repoRoot) {
  if (!selection || !['node', 'jsdom'].includes(selection.environment))
    throw new Error('Expected --environment node or jsdom');
  if (!Array.isArray(selection.files) || selection.files.length === 0)
    throw new Error('Select explicit test files');
  const files = selection.files.map((file) => {
    if (
      typeof file !== 'string' ||
      isAbsolute(file) ||
      /[\\*?[\]{}]/.test(file) ||
      file.split('/').includes('..')
    )
      throw new Error(`Invalid test path: ${file}`);
    if (!/^packages\/(shared|sim|ai)\/src\/.+\.test\.ts$/.test(file))
      throw new Error(`Unsupported test file: ${file}`);
    if (file.endsWith('.match.test.ts') && !goldenFiles.includes(file))
      throw new Error(`Only explicit golden match tests are supported: ${file}`);
    if (selection.environment === 'jsdom' && !file.startsWith('packages/sim/'))
      throw new Error('jsdom is supported only for sim');
    const absolute = resolve(root, file);
    if (
      !statSync(absolute).isFile() ||
      normalized(relative(realpathSync(root), realpathSync(absolute))) !== file
    )
      throw new Error(`Test path is not a local regular file: ${file}`);
    return file;
  });
  if (new Set(files).size !== files.length) throw new Error('Duplicate test files');
  return { environment: selection.environment, files };
}

export function parseSourceArgs(args) {
  if (
    args[0] !== '--environment' ||
    args.length < 3 ||
    args.slice(2).some((arg) => arg.startsWith('-'))
  )
    throw new Error(
      'Usage: node scripts/test-source.mjs --environment node|jsdom <explicit files>',
    );
  return { environment: args[1], files: args.slice(2) };
}

export function inspectResults(json, selection, root) {
  if (!json || !Array.isArray(json.testResults)) throw new Error('Missing testResults');
  const files = json.testResults.map((suite) => {
    const file = normalized(relative(root, suite.name));
    const counts = { passed: 0, failed: 0, skipped: 0 };
    if (!Array.isArray(suite.assertionResults)) throw new Error(`Missing assertions: ${file}`);
    for (const assertion of suite.assertionResults) {
      if (assertion.status === 'passed') counts.passed++;
      else if (assertion.status === 'failed') counts.failed++;
      else if (['pending', 'skipped', 'todo', 'disabled'].includes(assertion.status))
        counts.skipped++;
      else throw new Error(`Unknown assertion status: ${assertion.status}`);
    }
    return { file, ...counts, status: suite.status };
  });
  if (
    JSON.stringify(files.map((item) => item.file).sort()) !==
    JSON.stringify([...selection.files].sort())
  )
    throw new Error(`Executed files differ from selection: ${JSON.stringify(files)}`);
  if (files.some((item) => item.passed === 0 || item.failed > 0 || item.status !== 'passed'))
    throw new Error(`No successful execution in every file: ${JSON.stringify(files)}`);
  if (
    json.success !== true ||
    json.numFailedTests !== 0 ||
    json.numFailedTestSuites !== 0 ||
    json.numRuntimeErrorTestSuites > 0 ||
    json.unhandledErrors?.length > 0
  )
    throw new Error('Vitest reported errors');
  return files;
}

export function runSourceTests(
  selection,
  { root = repoRoot, cwd = process.cwd(), run = spawnSync, quiet = false } = {},
) {
  root = realpathSync(root);
  if (realpathSync(cwd) !== root) throw new Error('Run from the repository root');
  selection = validateSelection(selection, root);
  const base = resolve(root, '.matchlog');
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== base) throw new Error('Result directory must not be a link');
  const directory = mkdtempSync(resolve(base, 'source-test-'));
  const report = { ok: false, repoRoot: root, ...selection, directory, executed: [] };
  try {
    const require = createRequire(resolve(root, 'package.json'));
    const cli = resolve(require.resolve('vitest/package.json'), '../vitest.mjs');
    const result = run(
      process.execPath,
      [
        cli,
        'run',
        '--root',
        resolve(root, 'scripts/testing'),
        '--config',
        resolve(root, 'scripts/testing/vitest.source.config.ts'),
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${resolve(directory, 'vitest.json')}`,
      ],
      {
        cwd: root,
        env: { ...process.env, TD_SOURCE_SELECTION: JSON.stringify(selection) },
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 1800000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    report.stdout = result.stdout ?? '';
    report.stderr = result.stderr ?? '';
    if (!quiet) {
      process.stdout.write(report.stdout);
      process.stderr.write(report.stderr);
    }
    if (result.error || result.signal || result.status !== 0)
      throw new Error(
        `Vitest process failed: ${result.error?.message ?? result.signal ?? result.status}`,
      );
    report.executed = inspectResults(
      JSON.parse(readFileSync(resolve(directory, 'vitest.json'), 'utf8')),
      selection,
      root,
    );
    report.ok = true;
  } catch (error) {
    report.error = error.message;
  }
  writeFileSync(resolve(directory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function sourceMain(args = process.argv.slice(2)) {
  try {
    const report = runSourceTests(parseSourceArgs(args));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return report;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
