import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectChanges, needsGameChecks } from './ci-affected.mjs';

describe('области CI', () => {
  it('не запускает игру для состава PR 155', () => {
    expect(
      needsGameChecks([
        'CLAUDE.md',
        'docs/agent-setup.md',
        'openspec/changes/route-models-by-stage/.openspec.yaml',
        'supervisor/config/defaults.mjs',
        'supervisor/lib/stage-model.test.mjs',
        'supervisor/pipeline.config.json',
      ]),
    ).toBe(false);
  });

  it.each([
    'packages/sim/src/step.ts',
    'packages/shared/src/constants.ts',
    'apps/client/src/main.tsx',
    'apps/server/src/recording.match.test.ts',
    'packages/sim/vitest.match.config.ts',
    'e2e/lobby.spec.ts',
    'scripts/deploy.mjs',
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'tsconfig.base.json',
    'vitest.workspace.ts',
    'playwright.config.ts',
    '.github/workflows/ci.yml',
    'new-directory/file.js',
    'packages/sim/README.md',
    'docs-like/file.ts',
  ])('включает игру при изменении %s', (path) => {
    expect(needsGameChecks(['docs/guide.md', path])).toBe(true);
  });

  it('обрабатывает большой список без лимита 300 файлов', () => {
    expect(
      needsGameChecks([
        ...Array.from({ length: 1000 }, (_, i) => `docs/${i}.md`),
        'packages/sim/src/step.ts',
      ]),
    ).toBe(true);
  });
});

describe('полный Git diff', () => {
  const repos = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  function fixture() {
    const cwd = mkdtempSync(join(tmpdir(), 'td-ci-affected-'));
    repos.push(cwd);
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'ci-test@example.invalid');
    git('config', 'user.name', 'CI test');
    const commit = (path, content = path) => {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
      git('add', '--all');
      git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD');
    };
    const base = commit('README.md');
    return { cwd, git, commit, base };
  }

  it('пропускает игру для служебного push и пустого diff', () => {
    const { cwd, base, commit } = fixture();
    const head = commit('supervisor/file with spaces.mjs');
    expect(detectChanges('push', { before: base, after: head }, cwd).game).toBe(false);
    expect(detectChanges('push', { before: head, after: head }, cwd).game).toBe(false);
  });

  it('учитывает игровой коммит перед последней правкой документации', () => {
    const { cwd, base, commit } = fixture();
    commit('packages/sim/src/step.ts');
    const head = commit('docs/guide.md');
    expect(
      detectChanges(
        'pull_request',
        { pull_request: { base: { sha: base }, head: { sha: head } } },
        cwd,
      ).game,
    ).toBe(true);
  });

  it('не принимает изменения только новой базы за изменения PR', () => {
    const { cwd, base, git, commit } = fixture();
    const head = commit('docs/guide.md');
    git('checkout', '-q', '--detach', base);
    const advancedBase = commit('packages/shared/src/constants.ts');
    expect(
      detectChanges(
        'pull_request',
        { pull_request: { base: { sha: advancedBase }, head: { sha: head } } },
        cwd,
      ).game,
    ).toBe(false);
  });

  it.each(['delete', 'rename'])('учитывает старый игровой путь: %s', (operation) => {
    const { cwd, commit } = fixture();
    const base = commit('packages/sim/src/step.ts');
    if (operation === 'delete') rmSync(join(cwd, 'packages/sim/src/step.ts'));
    else renameSync(join(cwd, 'packages/sim/src/step.ts'), join(cwd, 'saved.md'));
    const head = commit('docs/guide.md');
    expect(detectChanges('push', { before: base, after: head }, cwd).game).toBe(true);
  });

  it('при недоступной базе, нулевом SHA и неизвестном событии включает игру', () => {
    const { cwd, base } = fixture();
    for (const before of ['f'.repeat(40), '0'.repeat(40), '--invalid']) {
      expect(detectChanges('push', { before, after: base }, cwd).game).toBe(true);
    }
    expect(detectChanges('workflow_dispatch', {}, cwd).game).toBe(true);
  });
});
