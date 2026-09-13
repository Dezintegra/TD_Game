import { expect, it } from 'vitest';
import { classifyDeployment, readDeploymentImpact } from './deploy-impact.mjs';
import { execute } from './execute.mjs';

const pr = {
  number: 23,
  merged: true,
  merged_at: '2026-09-07T12:00:00Z',
  base: { ref: 'main' },
  changed_files: 1,
  merge_commit_sha: 'a'.repeat(40),
};
const file = (filename, over = {}) => ({ filename, status: 'modified', ...over });
it('служебные добавления, изменения и удаления обходят выкладку', () => {
  for (const name of [
    'supervisor/lib/io.mjs',
    'docs/setup.md',
    'openspec/changes/x/tasks.md',
    'CLAUDE.md',
  ])
    for (const status of ['added', 'modified', 'removed'])
      expect(classifyDeployment(pr, [file(name, { status })], 23, 'main').needed).toBe(false);
});
it('игра, сборка и обе стороны переименования требуют выкладку', () => {
  for (const name of [
    'apps/client/src/main.ts',
    'packages/shared/src/balance.ts',
    'Dockerfile',
    'pnpm-lock.yaml',
    'scripts/deploy.mjs',
  ]) {
    expect(classifyDeployment(pr, [file(name)], 23, 'main').needed).toBe(true);
    expect(
      classifyDeployment(
        pr,
        [file('docs/moved.md', { status: 'renamed', previous_filename: name })],
        23,
        'main',
      ).needed,
    ).toBe(true);
  }
});
it('неизвестность, усечение и невлитый PR не отменяют выкладку', () => {
  for (const over of [
    { merged: false },
    { number: 24 },
    { base: { ref: 'other' } },
    { changed_files: 2 },
    { changed_files: 0 },
    { merge_commit_sha: null },
  ])
    expect(classifyDeployment({ ...pr, ...over }, [file('docs/a.md')], 23, 'main').needed).toBe(
      true,
    );
  for (const f of [
    file('docs/../apps/a'),
    file('docs/a', { status: 'renamed' }),
    file('docs/a', { status: 'unknown' }),
  ])
    expect(classifyDeployment(pr, [f], 23, 'main').needed).toBe(true);
});
it('читает все страницы и сохраняет обычную выкладку при ошибке', () => {
  const args = [];
  const run = (a) => {
    args.push(a);
    return {
      code: 0,
      stdout: JSON.stringify(a.includes('--paginate') ? [[file('docs/a.md')]] : pr),
    };
  };
  expect(readDeploymentImpact({ run, root: '.', number: 23, mainBranch: 'main' }).needed).toBe(
    false,
  );
  expect(args[1]).toContain('--slurp');
  expect(readDeploymentImpact({ run: () => ({ code: 1 }), number: 23 }).needed).toBe(true);
});
it('перенос отчёта ревью использует доказательство IO, а не утверждение агента', async () => {
  for (const needed of [false, true]) {
    let saved;
    const task = {
      id: '0001-test',
      status: 'review',
      type: 'feature',
      links: { pr: 23 },
      attempts: {},
      history: [],
    };
    const io = {
      now: '2026-09-07T12:00:00Z',
      readTask: () => task,
      allTaskIds: () => [],
      readReport: () => ({ stage: 'review', outcome: 'done', summary: 'Влито', skipDeploy: true }),
      deploymentImpact: () => ({ needed, reason: 'Служебный diff подтверждён' }),
      saveTask: async (t, e) => {
        saved = { task: t, entry: e };
        return { ok: true };
      },
      removeReport: () => {},
    };
    const result = await execute(
      [{ kind: 'transfer-report', taskId: task.id, stage: 'review' }],
      io,
    );
    expect(result[0].result).toBe('done');
    expect(saved.task.status).toBe(needed ? 'deploy' : 'cleanup');
    if (!needed) expect(saved.entry.what).toContain('Служебный diff');
  }
});
