import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// CLI reports cumulative input (including cache) and output for each session.
// Keep maxima independently of reports and session lifecycle: retries are idempotent.
export function recordTokenUsage(ledger, taskId, sessionId, usage) {
  if (!sessionId || !usage) return false;
  if (
    !['input_tokens', 'output_tokens'].every(
      (key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0,
    )
  )
    return false;
  const total = usage.input_tokens + usage.output_tokens;
  if (!Number.isSafeInteger(total)) return false;
  const sessions = ledger[taskId] ?? {};
  if (total <= (sessions[sessionId] ?? -1)) return false;
  ledger[taskId] = { ...sessions, [sessionId]: total };
  return true;
}

export function taskTokens(ledger, taskId) {
  return Object.values(ledger[taskId] ?? {}).reduce((sum, tokens) => sum + tokens, 0);
}

export function readTokenLedger(root, config) {
  const path = join(root, config.paths.local, 'codex-usage.json');
  if (!existsSync(path)) return {};
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (
    !object(ledger) ||
    !Object.values(ledger).every(
      (sessions) =>
        object(sessions) &&
        Object.values(sessions).every((tokens) => Number.isSafeInteger(tokens) && tokens >= 0),
    )
  )
    throw new Error(`Повреждён счётчик токенов: ${path}`);
  return ledger;
}

export function writeTokenLedger(root, config, ledger) {
  const dir = join(root, config.paths.local);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'codex-usage.json');
  writeFileSync(path + '.tmp', JSON.stringify(ledger, null, 2));
  renameSync(path + '.tmp', path);
}
