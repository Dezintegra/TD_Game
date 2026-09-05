import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { preparePerfPackages } from '../../scripts/perf-prepare.mjs';

it('собирает только библиотеки в назначенном дереве с одним процессом', () => {
  const run = vi.fn(() => ({ status: 0 }));
  preparePerfPackages('/assigned', run);
  expect(run).toHaveBeenCalledWith(
    'pnpm',
    ['--filter', './packages/**', '--workspace-concurrency=1', '-r', 'build'],
    { cwd: '/assigned', shell: process.platform === 'win32', stdio: 'inherit' },
  );
});

it('ошибка компилятора или запуска останавливает подготовку', () => {
  expect(() => preparePerfPackages('/assigned', () => ({ status: 2 }))).toThrow('кодом 2');
  expect(() => preparePerfPackages('/assigned', () => ({ error: new Error('EPERM') }))).toThrow(
    'EPERM',
  );
});

it('подготовка исключена из check-only и стоит до замера нагрузки', () => {
  const source = readFileSync(new URL('../../scripts/perf-run.mjs', import.meta.url), 'utf8');
  expect(source).toMatch(/if \(!checkOnly\) \{[\s\S]*preparePerfPackages\(repoRoot\)/);
  expect(source.indexOf('preparePerfPackages(repoRoot)')).toBeLessThan(
    source.indexOf('await requireQuietMachine'),
  );
  expect(source.indexOf("if (argv.includes('--history'))")).toBeLessThan(
    source.indexOf('preparePerfPackages(repoRoot)'),
  );
});
