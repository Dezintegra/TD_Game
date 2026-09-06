#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { recoveryPlan, sessionEvidence } from '../lib/legacy-ledger-recovery.mjs';
import { migrateTokenLedger } from '../lib/token-budget.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function usage() {
  return [
    'Usage: node supervisor/bin/recover-codex-ledger.mjs --root <project-root> --sessions-root <codex-sessions> [--apply]',
    '',
    'Dry-run is the default. --apply requires a conclusively dead or absent supervisor lock.',
  ].join('\n');
}

function filesBelow(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function lockStatus(path) {
  if (!existsSync(path)) return { safe: true, reason: 'замка нет' };
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { safe: false, reason: 'содержимое supervisor.lock не разобралось' };
  }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0)
    return { safe: false, reason: 'pid в supervisor.lock неоднозначен' };
  try {
    process.kill(lock.pid, 0);
    return { safe: false, reason: `supervisor.lock указывает на живой процесс ${lock.pid}` };
  } catch (error) {
    if (error?.code === 'ESRCH') return { safe: true, reason: `процесс ${lock.pid} мёртв` };
    return {
      safe: false,
      reason: `живость процесса ${lock.pid} неоднозначна (${error?.code ?? 'ошибка'})`,
    };
  }
}

function cwdFor(root, registry, taskId) {
  const entries =
    registry.entries?.filter(
      (entry) => entry.taskId === taskId && typeof entry.path === 'string',
    ) ?? [];
  const paths = entries.map((entry) => resolve(root, entry.path));
  // Обычная форма дерева известна из taskId, но имя JSONL доказательством не служит.
  paths.push(resolve(root, '.claude', 'worktrees', taskId));
  return [...new Set(paths)];
}

function evidenceFor({ sessionId, cwd, sessionsRoot }) {
  const suffix = `${sessionId}.jsonl`;
  const paths = filesBelow(sessionsRoot).filter((path) => path.endsWith(suffix));
  if (paths.length !== 1)
    return {
      ok: false,
      reason: paths.length ? 'несколько файлов сессии' : 'файл сессии не найден',
    };
  let text;
  try {
    text = readFileSync(paths[0], 'utf8');
  } catch {
    return { ok: false, reason: 'файл сессии не читается' };
  }
  const results = cwd
    .map((item) => sessionEvidence(text, { sessionId, cwd: item }))
    .filter((item) => item.ok);
  return results.length === 1
    ? results[0]
    : { ok: false, reason: results[0]?.reason ?? 'сессия не доказана для дерева задачи' };
}

export function recover({ root, sessionsRoot, apply = false }) {
  const ledgerPath = join(root, '.pipeline', 'codex-usage.json');
  const registryPath = join(root, '.pipeline', 'registry.json');
  if (!existsSync(ledgerPath)) throw new Error(`реестр не найден: ${ledgerPath}`);
  const original = readFileSync(ledgerPath, 'utf8');
  let ledger;
  let registry = { entries: [] };
  try {
    ledger = JSON.parse(original);
    if (existsSync(registryPath)) registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    throw new Error('реестр или registry.json повреждён');
  }
  const normalized = migrateTokenLedger(ledger);
  const evidence = new Map();
  for (const [taskId, task] of Object.entries(normalized.tasks))
    for (const sessionId of Object.keys(task.sessions ?? {}))
      if (task.sessions[sessionId].reasons.includes('legacy-unknown'))
        evidence.set(
          `${taskId}:${sessionId}`,
          evidenceFor({ sessionId, cwd: cwdFor(root, registry, taskId), sessionsRoot }),
        );
  const plan = recoveryPlan(ledger, evidence);
  const report = {
    count: evidence.size,
    proposed: plan.proposed,
    unresolved: plan.unresolved,
    applied: false,
  };
  if (!apply || !plan.proposed.length) return report;
  const lock = lockStatus(join(root, '.pipeline', 'supervisor.lock'));
  if (!lock.safe) throw new Error(`apply отклонён: ${lock.reason}`);
  if (readFileSync(ledgerPath, 'utf8') !== original)
    throw new Error('apply отклонён: реестр изменился после dry-run (optimistic concurrency)');
  const backup = `${ledgerPath}.bak-${new Date().toISOString().replaceAll(':', '-')}`;
  copyFileSync(ledgerPath, backup);
  const temporary = `${ledgerPath}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(plan.ledger, null, 2));
  renameSync(temporary, ledgerPath);
  return { ...report, applied: true, backup };
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
  if (process.argv.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }
  const root = argument('--root');
  const sessionsRoot = argument('--sessions-root');
  if (!root || !sessionsRoot) {
    console.error(usage());
    process.exit(2);
  }
  try {
    console.log(
      JSON.stringify(
        recover({
          root: resolve(root),
          sessionsRoot: resolve(sessionsRoot),
          apply: process.argv.includes('--apply'),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`Recovery failed: ${error.message}`);
    process.exitCode = 1;
  }
}
