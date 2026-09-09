import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as catalog from './catalog.mjs';
import { executePair, projectRoot } from './execute.mjs';
import { summarize, validateCatalog } from './model.mjs';
import { renderReport } from './report.mjs';

export async function runCanaries({
  mutations = catalog.mutations,
  pairs = catalog.pairs,
  execute = executePair,
  outputRoot = resolve(projectRoot, '.matchlog/mutation'),
  sha,
  ref = process.env.GITHUB_REF || 'local',
  actionsUrl = '',
} = {}) {
  const runId = randomUUID();
  const directory = resolve(outputRoot, runId);
  await mkdir(directory, { recursive: true });
  const results = [];
  if (!sha)
    sha = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const errors = validateCatalog({ mutations, pairs });
  for (const reason of errors) results.push({ status: 'error', reason });
  if (!errors.length) {
    for (const pair of pairs) {
      const mutation = mutations.find((entry) => entry.id === pair.mutationId);
      try {
        results.push(await execute(pair, mutation, { runId, directory }));
      } catch (error) {
        results.push({ status: 'error', reason: error.message, pair, mutation });
      }
    }
    for (const mutation of mutations) {
      if (!pairs.some((pair) => pair.mutationId === mutation.id))
        results.push({ status: 'uncovered', mutation });
    }
  }
  const report = { runId, sha, ref, actionsUrl, directory, results, ...summarize(results) };
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(directory, 'summary.md'), renderReport(report));
  return report;
}

export async function main() {
  const actionsUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const report = await runCanaries({ sha: process.env.GITHUB_SHA, actionsUrl });
  console.log(renderReport(report));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `directory=${report.directory}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, renderReport(report));
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
}
