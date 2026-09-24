import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { repoRoot } from './source-aliases.mjs';

const require = createRequire(import.meta.url);
const eslint = createRequire(require.resolve('eslint/package.json'));
const { load } = createRequire(eslint.resolve('@eslint/eslintrc'))('js-yaml');
const workflow = load(readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8'));

function assertJob(job) {
  expect(job.needs).toBe('changes');
  expect(typeof job.if).toBe('string');
  const expression = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  for (const [result, game, cancelled, expected] of [
    ['success', 'false', false, false],
    ['success', 'true', false, true],
    ['failure', 'false', false, true],
    ['success', '', false, true],
    ['skipped', undefined, false, true],
    ['failure', 'true', true, false],
    ['success', 'true', true, false],
  ]) {
    expect(
      runInNewContext(
        expression,
        {
          always: () => true,
          cancelled: () => cancelled,
          needs: { changes: { result, outputs: { game } } },
        },
        { timeout: 100 },
      ),
      `${result}/${game}/${cancelled}`,
    ).toBe(expected);
  }
  expect(job['continue-on-error']).toBeUndefined();
  expect(job.steps.filter((s) => s.run).map((s) => s.run)).toEqual([
    'pnpm install --frozen-lockfile',
    'node scripts/testing/check-source-tests.mjs --installed',
  ]);
  expect(job.steps.filter((s) => s.uses).map((s) => s.uses)).toEqual([
    'actions/checkout@v4',
    'pnpm/action-setup@v4',
    'actions/setup-node@v4',
    'actions/upload-artifact@v4',
  ]);
  expect(job.steps.findIndex((s) => s.run?.startsWith('pnpm install'))).toBeLessThan(
    job.steps.findIndex((s) => s.run?.startsWith('node scripts/testing')),
  );
  for (const step of job.steps.filter((s) => s.run)) {
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
  }
  expect(job.steps.find((s) => s.uses === 'actions/setup-node@v4').with.cache).toBe('pnpm');
  expect(JSON.stringify(job.steps)).not.toMatch(/download-artifact|actions\/cache|turbo|\bdist\b/);
}

it('runs the real matrix only for game impact or inconclusive changes, before any build', () => {
  assertJob(workflow.jobs['source-tests']);
  expect(workflow.jobs.test.steps.some((s) => s.run === 'pnpm test:scripts' && !s.if)).toBe(true);
  expect(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).not.toContain(
    'check-source-tests.mjs',
  );
  expect(readFileSync(resolve(repoRoot, 'scripts/vitest.config.ts'), 'utf8')).toContain(
    "include: ['**/*.test.mjs']",
  );
});

it.each(['build', 'needs', 'condition', 'unconditional', 'no-fallback', 'cache', 'skip-run'])(
  'rejects %s regression',
  (kind) => {
    const job = globalThis.structuredClone(workflow.jobs['source-tests']);
    if (kind === 'build') job.steps.splice(3, 0, { run: 'pnpm build' });
    if (kind === 'needs') delete job.needs;
    if (kind === 'condition') delete job.if;
    if (kind === 'unconditional') job.if = '${{ true }}';
    if (kind === 'no-fallback')
      job.if = "${{ !cancelled() && needs.changes.outputs.game == 'true' }}";
    if (kind === 'cache')
      job.steps.unshift({ uses: 'actions/cache@v4', with: { path: 'packages/*/dist' } });
    if (kind === 'skip-run')
      job.steps.find((s) => s.run?.startsWith('node scripts/testing')).if = 'false';
    expect(() => assertJob(job)).toThrow();
  },
);
