import { readFileSync } from 'node:fs';
import { URLSearchParams } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reviewCi } from './review-ci.mjs';
import { summarisePullRequest } from './io.mjs';

// Исходные ответы сохранены в 0297; список runs и повторные чтения моделируются.
const observation = JSON.parse(
  readFileSync(new URL('./testing/ci-pr-219.json', import.meta.url), 'utf8'),
);
function fixture(edit = () => {}, intercept = () => null) {
  const f = JSON.parse(JSON.stringify(observation));
  f.runs = [f.run];
  edit(f);
  const calls = [];
  const run = (args, tool, cwd, options) => {
    calls.push({ args, tool, cwd, options });
    const override = intercept(args, calls.length, f);
    if (override) return override;
    let data;
    if (args[0] === 'pr') data = f.pr;
    else if (args[1].includes('/jobs?')) {
      const id = Number(args[1].split('/runs/')[1].split('/')[0]);
      const jobs = f.jobs.jobs.filter((j) => j.run_id === id);
      const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
      data = { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) };
    } else if (args[1].includes('?head_sha=')) {
      const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
      data = {
        total_count: f.runs.length,
        workflow_runs: f.runs.slice((page - 1) * 100, page * 100),
      };
    } else data = f.runs.find((r) => r.id === Number(args[1].split('/').at(-1)));
    return { code: 0, stdout: JSON.stringify(data), stderr: '' };
  };
  return {
    f,
    run,
    calls,
    poll: (head = observation.pr.headRefOid, pr = 219) => reviewCi({ pr, head, run }),
  };
}

describe('общий вход review', () => {
  it('подтверждает исходное противоречие, которое чистое сведение оставляет pending', () => {
    const f = fixture();
    expect(summarisePullRequest(JSON.stringify(f.f.pr)).state).toBe('pending');
    expect(f.poll()).toMatchObject({
      state: 'success',
      mode: 'confirmed',
      expectedHead: f.f.pr.headRefOid,
      observedHead: f.f.pr.headRefOid,
      runs: [{ id: f.f.run.id, attempt: 1, head: f.f.pr.headRefOid }],
    });
    expect(f.calls).toHaveLength(7);
    expect(f.calls.every((c) => c.tool === 'gh' && c.options.timeout === 15000)).toBe(true);
  });
  it('не разрешает другой ожидаемый SHA', () => {
    const f = fixture();
    expect(f.poll('a'.repeat(40))).toMatchObject({ state: 'pending', runs: [] });
    expect(f.calls).toHaveLength(1);
  });
  it('конфликт имеет приоритет даже при несовпадении SHA', () => {
    const f = fixture((f) => {
      f.pr.mergeable = 'CONFLICTING';
    });
    expect(f.poll('a'.repeat(40))).toMatchObject({ state: 'conflict', runs: [] });
  });
  it('действительно работающее задание не допускается', () => {
    const f = fixture((f) => {
      f.jobs.jobs[1].status = 'in_progress';
      f.jobs.jobs[1].conclusion = null;
      f.pr.statusCheckRollup[1].status = 'IN_PROGRESS';
      f.pr.statusCheckRollup[1].conclusion = null;
    });
    expect(f.poll()).toMatchObject({ state: 'pending', runs: [] });
  });
});
