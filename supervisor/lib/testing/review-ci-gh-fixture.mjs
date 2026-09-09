import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';

// Подменяется только граница gh; bin и весь алгоритм подтверждения остаются настоящими.
const original = childProcess.execFileSync;
const data = JSON.parse(readFileSync(new URL('./ci-pr-219.json', import.meta.url), 'utf8'));
const scenario = process.env.REVIEW_CI_SCENARIO;
if (scenario !== 'confirmed')
  data.pr.statusCheckRollup.forEach((check) => {
    check.status = 'COMPLETED';
  });
if (scenario === 'failure') data.pr.statusCheckRollup[0].conclusion = 'FAILURE';
if (scenario === 'unknown') data.pr.mergeable = 'UNKNOWN';
if (scenario === 'conflict') data.pr.mergeable = 'CONFLICTING';
if (scenario === 'head') data.pr.headRefOid = 'a'.repeat(40);
childProcess.execFileSync = (program, args, options) => {
  if (program !== 'gh') return original(program, args, options);
  appendFileSync(process.env.REVIEW_CI_CALLS, `${JSON.stringify(args)}\n`);
  if (scenario === 'transport') throw Object.assign(new Error('fixture transport'), { status: 1 });
  if (args[0] === 'pr') return JSON.stringify(data.pr);
  if (args[1].includes('/jobs?')) return JSON.stringify(data.jobs);
  if (args[1].includes('?head_sha='))
    return JSON.stringify({ total_count: 1, workflow_runs: [data.run] });
  return JSON.stringify(data.run);
};
syncBuiltinESMExports();
