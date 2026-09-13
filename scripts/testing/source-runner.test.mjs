import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { repoRoot, sourceAliases } from './source-aliases.mjs';
import {
  inspectResults,
  parseSourceArgs,
  runSourceTests,
  validateSelection,
} from './source-runner.mjs';
import { checkedProcess, findPnpm } from '../../supervisor/lib/install-snapshot-check.mjs';

const file = 'packages/sim/src/crowd.test.ts';
const selection = { environment: 'node', files: [file] };
const good = () => ({
  success: true,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  testResults: [
    { name: resolve(repoRoot, file), status: 'passed', assertionResults: [{ status: 'passed' }] },
  ],
});

describe('explicit source selection', () => {
  it('accepts existing files and exact aliases only', () => {
    expect(validateSelection(selection)).toEqual(selection);
    expect(sourceAliases()[0].find.test('@td/shared/subpath')).toBe(false);
    expect(sourceAliases()[1].replacement).toBe(resolve(repoRoot, 'packages/sim/src/index.ts'));
  });
  it.each([
    [],
    ['packages/sim/src'],
    ['packages/sim/src/*.test.ts'],
    ['../crowd.test.ts'],
    [file, file],
    ['packages/sim/src/missing.test.ts'],
    ['packages/ai/src/siege.match.test.ts'],
    ['scripts/a.test.mjs'],
  ])('rejects invalid files %j', (...files) => {
    // Vitest разворачивает массив строки таблицы в аргументы.
    expect(() => validateSelection({ ...selection, files })).toThrow();
  });
  it('rejects unsupported environments and CLI options', () => {
    expect(() => validateSelection({ ...selection, environment: 'browser' })).toThrow();
    expect(() =>
      validateSelection({ environment: 'jsdom', files: ['packages/shared/src/rules.test.ts'] }),
    ).toThrow();
    expect(() => parseSourceArgs([])).toThrow();
    expect(() => parseSourceArgs(['--environment', 'node', file, '--config=x'])).toThrow();
    expect(parseSourceArgs(['--environment', 'node', file])).toEqual(selection);
    expect(() => runSourceTests(selection, { cwd: resolve(repoRoot, 'scripts') })).toThrow();
  });
});

describe('execution evidence', () => {
  it('requires exact executed files and passed assertions', () => {
    expect(inspectResults(good(), selection, repoRoot)[0].passed).toBe(1);
    for (const mutate of [
      (r) => {
        r.testResults = [];
      },
      (r) => {
        r.testResults.push(r.testResults[0]);
      },
      (r) => {
        r.testResults[0].name = resolve(repoRoot, 'extra.test.ts');
      },
      (r) => {
        r.testResults[0].assertionResults = [];
      },
      (r) => {
        r.testResults[0].assertionResults[0].status = 'pending';
      },
      (r) => {
        r.testResults[0].assertionResults[0].status = 'failed';
      },
      (r) => {
        r.testResults[0].status = 'failed';
      },
      (r) => {
        r.success = false;
      },
      (r) => {
        r.numRuntimeErrorTestSuites = 1;
      },
      (r) => {
        r.unhandledErrors = ['error'];
      },
    ]) {
      const result = good();
      mutate(result);
      expect(() => inspectResults(result, selection, repoRoot)).toThrow();
    }
  });
  it.each([
    { status: 1 },
    { status: 0, signal: 'SIGTERM' },
    { status: 0, error: new Error('timeout') },
    { status: 0 },
  ])('rejects process or missing report %j', (result) => {
    expect(runSourceTests(selection, { run: () => result, quiet: true }).ok).toBe(false);
  });
  it('preserves mutation-specific settings outside the normal configuration', () => {
    const mutation = readFileSync(resolve(repoRoot, 'scripts/mutation/vitest.config.ts'), 'utf8');
    for (const marker of [
      'TD_MUTATION_DESCRIPTOR',
      'descriptor.pair?.testFile',
      'scripts/mutation/setup.ts',
      'scripts/mutation/reporter.ts',
      "hooks: 'stack'",
      "requireVitest.resolve('@vitest/runner')",
      'sourceAliases()',
    ])
      expect(mutation).toContain(marker);
    const normal = readFileSync(
      resolve(repoRoot, 'scripts/testing/vitest.source.config.ts'),
      'utf8',
    );
    expect(normal).not.toMatch(/mutation|setupFiles|reporters|descriptor/i);
    expect(normal).toContain('maxWorkers: 1');
    expect(normal).toContain('fileParallelism: false');
  });
});

it('imports fresh shared and sim exports in a separately installed fixture', () => {
  const base = resolve(repoRoot, '.matchlog');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(resolve(base, 'source-fixture-'));
  for (const path of [
    'scripts/testing/source-aliases.mjs',
    'scripts/testing/source-runner.mjs',
    'scripts/testing/vitest.source.config.ts',
    'scripts/test-source.mjs',
  ]) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    copyFileSync(resolve(repoRoot, path), resolve(root, path));
  }
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: {
        vitest: JSON.parse(readFileSync(resolve(repoRoot, 'node_modules/vitest/package.json')))
          .version,
      },
    }),
  );
  checkedProcess(
    process.execPath,
    [findPnpm(), 'install', '--prefer-offline', '--store-dir', '.pnpm-store'],
    { cwd: root },
  );
  for (const pkg of ['shared', 'sim', 'ai'])
    mkdirSync(resolve(root, `packages/${pkg}/src`), { recursive: true });
  writeFileSync(resolve(root, 'packages/shared/src/index.ts'), 'export const shared = 1;');
  writeFileSync(resolve(root, 'packages/sim/src/index.ts'), 'export const sim = 2;');
  const testFile = 'packages/ai/src/import.test.ts';
  writeFileSync(
    resolve(root, testFile),
    "import { expect, it } from 'vitest'; import { shared } from '@td/shared'; import { sim } from '@td/sim'; it('fresh exports', () => { expect(shared).toBe(1); expect(sim).toBe(2); });",
  );
  const invoke = () =>
    runSourceTests({ environment: 'node', files: [testFile] }, { root, cwd: root, quiet: true });
  expect(invoke().ok).toBe(true);
  for (const [pkg, original] of [
    ['shared', 1],
    ['sim', 2],
  ]) {
    const path = resolve(root, `packages/${pkg}/src/index.ts`);
    try {
      writeFileSync(path, `export const ${pkg} = 99;`);
      const failed = invoke();
      expect(failed.ok).toBe(false);
      expect(failed.stderr).toContain(`expected 99 to be ${original}`);
    } finally {
      writeFileSync(path, `export const ${pkg} = ${original};`);
    }
    expect(invoke().ok).toBe(true);
  }
}, 120000);
