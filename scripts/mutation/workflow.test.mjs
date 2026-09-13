import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname, relative } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { projectRoot } from './execute.mjs';

// Парсеры уже установлены с ESLint; новых зависимостей у оснастки нет.
const require = createRequire(import.meta.url);
const requireEslint = createRequire(require.resolve('eslint/package.json'));
const { load: yaml } = createRequire(requireEslint.resolve('@eslint/eslintrc'))('js-yaml');
const minimatch = requireEslint('minimatch');
const read = (path) => readFile(resolve(projectRoot, path), 'utf8');
const realEntry = /mutation[/\\](?:run\.mjs|run\.acceptance\.mjs|acceptance\.config\.ts)/;

function parseSource(source) {
  return ts.createSourceFile('config.ts', source, ts.ScriptTarget.Latest, true);
}
function strings(source) {
  const values = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) values.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parseSource(source));
  return values;
}
function arrays(source, property) {
  const values = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === property) {
      if (!ts.isArrayLiteralExpression(node.initializer))
        throw new Error(`Dynamic ${property} needs review`);
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteralLike(element)) values.push(element.text);
        else if (property === 'include') throw new Error('Dynamic discovery needs review');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseSource(source));
  return values;
}

async function snapshot() {
  const configs = { 'scripts/vitest.config.ts': await read('scripts/vitest.config.ts') };
  const packages = { 'package.json': JSON.parse(await read('package.json')) };
  for (const area of ['packages', 'apps']) {
    for (const entry of await readdir(resolve(projectRoot, area), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${area}/${entry.name}`;
      const files = await readdir(resolve(projectRoot, directory));
      for (const file of files.filter((name) => /^vitest.*config\.ts$/.test(name)))
        configs[`${directory}/${file}`] = await read(`${directory}/${file}`);
      if (files.includes('package.json'))
        packages[`${directory}/package.json`] = JSON.parse(await read(`${directory}/package.json`));
    }
  }
  return {
    configs,
    packages,
    workspace: await read('vitest.workspace.ts'),
    pnpmWorkspace: await read('pnpm-workspace.yaml'),
    turbo: await read('turbo.json'),
    ci: yaml(await read('.github/workflows/ci.yml')),
  };
}

async function assertPrBoundary(state) {
  const acceptance = 'scripts/mutation/run.acceptance.mjs';
  expect(
    strings(state.workspace).some(
      (value) => realEntry.test(value) || minimatch('scripts/mutation', value),
    ),
  ).toBe(false);
  expect(
    yaml(state.pnpmWorkspace).packages.some((value) => minimatch('scripts/mutation', value)),
  ).toBe(false);
  expect(strings(state.turbo).some((value) => realEntry.test(value))).toBe(false);
  for (const [path, source] of Object.entries(state.configs)) {
    expect(
      strings(source).some((value) => realEntry.test(value)),
      path,
    ).toBe(false);
    const candidate = relative(dirname(path), acceptance).replaceAll('\\', '/');
    const include = arrays(source, 'include');
    const exclude = arrays(source, 'exclude');
    expect(
      include.some((pattern) => minimatch(candidate, pattern)) &&
        !exclude.some((pattern) => minimatch(candidate, pattern)),
      path,
    ).toBe(false);
  }
  // Проверяются и тела именованных команд: вызов через pnpm не скрывает runner.
  const commands = Object.values(state.packages).flatMap((pkg) => Object.values(pkg.scripts || {}));
  for (const job of Object.values(state.ci.jobs))
    for (const step of job.steps || []) if (step.run) commands.push(step.run);
  const visited = new Set();
  async function inspect(command) {
    expect(realEntry.test(command), command).toBe(false);
    for (const match of command.matchAll(
      /(?:node|tsx)\s+(?:--[\w-]+\s+)*["']?((?:scripts|supervisor)\/[\w/.-]+\.m?[jt]s)/g,
    )) {
      const path = match[1];
      if (visited.has(path)) continue;
      visited.add(path);
      const source = await read(path);
      // Не запрещаем безопасный импорт runner в тестах: исполнение импорта проверено отдельно.
      // Исполняемые CLI-обёртки не должны вести к реальному прогону даже через импорт.
      expect(
        strings(source).some((value) => realEntry.test(value)),
        path,
      ).toBe(false);
      await inspect(source);
    }
  }
  for (const command of commands) await inspect(command);
}

it('keeps nightly execution separate and retains failure evidence', async () => {
  const workflow = yaml(await read('.github/workflows/mutation.yml'));
  expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  expect(workflow.on.schedule).toEqual([{ cron: '30 2 * * *' }]);
  expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' });
  expect(workflow.concurrency).toEqual({ group: 'mutation-canaries', 'cancel-in-progress': false });
  const job = workflow.jobs.mutation;
  expect(job['runs-on']).toBe('ubuntu-latest');
  expect(job['timeout-minutes']).toBe(90);
  const steps = job.steps;
  expect(steps.find((step) => step.uses === 'actions/setup-node@v4').with['node-version']).toBe(22);
  expect(steps.some((step) => step.uses === 'pnpm/action-setup@v4')).toBe(true);
  expect(steps.some((step) => step.run === 'pnpm install --frozen-lockfile')).toBe(true);
  const run = steps.find((step) => step.id === 'canaries');
  expect(run.run).toBe('node scripts/mutation/run.mjs');
  expect(run['continue-on-error']).toBeUndefined();
  const issue = steps.find((step) => step.run === 'node scripts/mutation/issue.mjs');
  expect(issue.if).toBe(
    "always() && github.ref == 'refs/heads/main' && steps.canaries.outputs.directory != ''",
  );
  expect(issue['continue-on-error']).toBeUndefined();
  expect(steps.filter((step) => step.env?.GH_TOKEN)).toEqual([issue]);
  const missing = steps.find((step) => step.name === 'Проверить наличие сводки');
  expect(missing.if).toBe('always()');
  expect(missing.run).toContain('exit 1');
  expect(missing.run).toContain('GITHUB_STEP_SUMMARY');
  const artifact = steps.find((step) => step.uses === 'actions/upload-artifact@v4');
  expect(artifact.if).toBe('always()');
  expect(artifact.with).toMatchObject({
    path: '.matchlog/mutation/',
    'include-hidden-files': true,
    'retention-days': 30,
    'if-no-files-found': 'error',
  });
});
it('excludes acceptance from ordinary discovery and direct or indirect PR commands', async () => {
  const state = await snapshot();
  await assertPrBoundary(state);
  const broad = globalThis.structuredClone(state);
  broad.configs['scripts/vitest.config.ts'] = "export default { test: { include: ['**/*.mjs'] } };";
  await expect(assertPrBoundary(broad)).rejects.toThrow();
  const direct = globalThis.structuredClone(state);
  direct.ci.jobs.test.steps.push({ run: 'node scripts/mutation/run.mjs' });
  await expect(assertPrBoundary(direct)).rejects.toThrow();
  const indirect = globalThis.structuredClone(state);
  indirect.packages['package.json'].scripts['test:scripts'] += ' && pnpm mutation:nightly';
  indirect.packages['package.json'].scripts['mutation:nightly'] = 'node scripts/mutation/run.mjs';
  await expect(assertPrBoundary(indirect)).rejects.toThrow();
});
