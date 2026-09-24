import { expect, it, vi } from 'vitest';
import { issueMarker, publishIssue } from './issue.mjs';
import { summarize } from './model.mjs';

const results = ['first', 'second'].map((id) => ({
  status: 'survived',
  mutation: { id, tuning: { income: 2 } },
  pair: { testFile: 'fixture.ts', fullName: ['suite', id] },
  baseline: { status: 'passed' },
  mutant: { status: 'passed' },
}));
const report = {
  ref: 'refs/heads/main',
  sha: 'abc123',
  runId: 'run',
  actionsUrl: 'https://github.com/example/game/actions/runs/123',
  results,
  ...summarize(results),
};
const context = { ref: report.ref, repository: 'example/game', token: 'fixture-token' };
const response = (data) => ({ ok: true, json: async () => data });

it.each(['schedule', 'workflow_dispatch'])(
  'creates and updates with every survived on main (%s)',
  async (eventName) => {
    for (const existing of [[], [{ number: 42, body: issueMarker }]]) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(response(existing))
        .mockResolvedValueOnce(response({ number: 42 }));
      expect(await publishIssue(report, { ...context, eventName, fetchImpl })).toEqual({
        action: existing.length ? 'updated' : 'created',
        number: 42,
      });
      const [url, options] = fetchImpl.mock.calls[1];
      expect(options.method).toBe(existing.length ? 'PATCH' : 'POST');
      expect(url.endsWith(existing.length ? '/issues/42' : '/issues')).toBe(true);
      const body = JSON.parse(options.body).body;
      for (const text of [
        'first',
        'second',
        'fixture.ts',
        'suite > first',
        'suite > second',
        'abc123',
        report.actionsUrl,
        'passed',
        'income',
        issueMarker,
      ])
        expect(body).toContain(text);
      expect(report.exitCode).toBe(1);
    }
  },
);
it.each(['refs/heads/feature', 'refs/pull/1/merge'])(
  'never writes from diagnostic ref %s',
  async (ref) => {
    const fetchImpl = vi.fn();
    expect(
      (
        await publishIssue(
          { ...report, ref },
          { ...context, ref, eventName: 'workflow_dispatch', fetchImpl },
        )
      ).action,
    ).toBe('diagnostic');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.exitCode).toBe(1);
  },
);
it('does not publish foreign reports, unsupported events or error-only runs', async () => {
  const fetchImpl = vi.fn();
  await publishIssue({ ...report, ref: 'other' }, { ...context, eventName: 'schedule', fetchImpl });
  await publishIssue(report, { ...context, eventName: 'pull_request', fetchImpl });
  await publishIssue(
    { ...report, results: [{ status: 'error', reason: 'import failed' }] },
    { ...context, eventName: 'schedule', fetchImpl },
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('finds the marker beyond the first page and keeps errors separate', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(response(Array.from({ length: 100 }, () => ({ body: 'unrelated' }))))
    .mockResolvedValueOnce(response([{ body: issueMarker, number: 12 }]))
    .mockResolvedValueOnce(response({ number: 12 }));
  await publishIssue(
    { ...report, results: [...results, { status: 'error', reason: 'import failed' }] },
    { ...context, eventName: 'schedule', fetchImpl },
  );
  expect(fetchImpl.mock.calls[1][0]).toContain('page=2');
  expect(JSON.parse(fetchImpl.mock.calls[2][1].body).body).toContain('import failed');
});
it.each(['GET', 'POST', 'PATCH'])('exposes %s API failures', async (method) => {
  const fetchImpl = vi.fn();
  if (method !== 'GET')
    fetchImpl.mockResolvedValueOnce(
      response(method === 'PATCH' ? [{ body: issueMarker, number: 42 }] : []),
    );
  fetchImpl.mockResolvedValueOnce({ ok: false, status: 403 });
  await expect(
    publishIssue(report, { ...context, eventName: 'schedule', fetchImpl }),
  ).rejects.toThrow(`GitHub Issue ${method} failed: HTTP 403`);
});
