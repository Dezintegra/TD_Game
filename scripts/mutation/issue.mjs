import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderReport } from './report.mjs';

export const issueMarker = '<!-- td-mutation-canaries -->';

export async function publishIssue(
  report,
  { ref, eventName, repository, token, fetchImpl = globalThis.fetch },
) {
  // Проверяется и контекст Actions, и происхождение отчёта: диагностика не пишет Issue.
  if (
    ref !== 'refs/heads/main' ||
    report.ref !== ref ||
    !['schedule', 'workflow_dispatch'].includes(eventName)
  )
    return { action: 'diagnostic' };
  const survived = report.results.filter((result) => result.status === 'survived');
  if (!survived.length) return { action: 'none' };
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ''))
    throw new Error('Missing GitHub token or repository');
  const base = `https://api.github.com/repos/${repository}/issues`;
  async function request(url, method = 'GET', body) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub Issue ${method} failed: HTTP ${response.status}`);
    return response.json();
  }
  let existing;
  for (let page = 1; ; page++) {
    const issues = await request(`${base}?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) throw new Error('Invalid GitHub issues response');
    existing = issues.find((issue) => !issue.pull_request && issue.body?.includes(issueMarker));
    if (existing || issues.length < 100) break;
  }
  const errors = report.results.filter((result) => result.status === 'error');
  const body = [
    issueMarker,
    'Проверки пережили заявленную порчу; требуется проверить их чувствительность.',
    '',
    '## Survived',
    renderReport({ ...report, results: survived }),
    '## Ошибки исполнения (не обнаруженные мутации)',
    errors.length ? renderReport({ ...report, results: errors }) : 'Нет.',
  ].join('\n');
  const payload = { title: 'Mutation canaries: проверки пережили порчу', body };
  const issue = await request(
    existing ? `${base}/${existing.number}` : base,
    existing ? 'PATCH' : 'POST',
    payload,
  );
  return { action: existing ? 'updated' : 'created', number: issue.number };
}

async function main() {
  if (!process.env.MUTATION_DIRECTORY) throw new Error('Mutation result directory missing');
  const report = JSON.parse(
    await readFile(resolve(process.env.MUTATION_DIRECTORY, 'summary.json'), 'utf8'),
  );
  console.log(
    await publishIssue(report, {
      ref: process.env.GITHUB_REF,
      eventName: process.env.GITHUB_EVENT_NAME,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
}
