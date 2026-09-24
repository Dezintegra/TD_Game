import { createHash } from 'node:crypto';
import { providerOf, readCodexAnswer } from './provider.mjs';
import { readAnswer } from './run-stage.mjs';
import { beginTokenLaunch } from './token-budget.mjs';
import { tokenAdmission } from './token-hold.mjs';

const digest = (run) => createHash('sha256').update(JSON.stringify(run)).digest('hex');

/** Оба входа используют прежний ledger; raw сохраняется раньше возможной ошибки учёта. */
export function createToolDiagnosticAccounting({
  config,
  taskId,
  task,
  stage,
  getLedger,
  persistUsage,
  saveIntent = () => {},
  saveRaw = () => {},
  readReceipt = () => null,
  saveReceipt = () => {},
}) {
  const receipts = new Map();
  return {
    async onStart(launchId, control) {
      if (providerOf(config) === 'codex' && tokenAdmission(task, stage, config, getLedger()))
        throw new Error('token admission holds diagnostic launch');
      await saveIntent(launchId, control);
      if (providerOf(config) === 'codex')
        persistUsage(taskId, (next) => beginTokenLaunch(next, taskId, launchId));
    },
    async onResult(launchId, run, metadata) {
      await saveRaw(launchId, run, metadata);
      const runHash = digest(run);
      const previous = receipts.get(launchId) ?? (await readReceipt(launchId));
      if (previous) {
        if (previous.runHash !== runHash) throw new Error('diagnostic accounting result conflict');
        return previous;
      }
      let receipt;
      if (providerOf(config) === 'codex') {
        const ledger = getLedger();
        const answer = readCodexAnswer(run, config, { ledger, taskId, launchId });
        // Повтор после записи ledger, но до квитанции не создаёт второе списание.
        if (
          JSON.stringify(ledger.tasks[taskId]) !== JSON.stringify(answer.usageLedger.tasks[taskId])
        )
          persistUsage(taskId, (next) => {
            next.tasks[taskId] = answer.usageLedger.tasks[taskId];
          });
        receipt = {
          launchId,
          runHash,
          provider: 'codex',
          unit: 'tokens',
          sessionId: answer.sessionId ?? null,
          usage: answer.usage,
          state: answer.usageError ? 'unknown' : 'accounted',
          reason: answer.usageError ?? null,
        };
      } else {
        const answer = readAnswer(run);
        receipt = {
          launchId,
          runHash,
          provider: 'claude',
          unit: 'USD',
          sessionId: answer.sessionId ?? null,
          costUsd: answer.cost ?? null,
          state: Number.isFinite(answer.cost) ? 'accounted' : 'unknown',
        };
      }
      await saveReceipt(launchId, receipt);
      receipts.set(launchId, receipt);
      return receipt;
    },
    costUsd(evidence) {
      return providerOf(config) === 'claude'
        ? (evidence.runs ?? []).reduce((sum, run) => sum + (readAnswer(run).cost ?? 0), 0)
        : 0;
    },
  };
}
