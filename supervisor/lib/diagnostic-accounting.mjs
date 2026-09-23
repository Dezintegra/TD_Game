import { beginTokenLaunch } from './token-budget.mjs';
import { providerOf, readCodexAnswer } from './provider.mjs';
import { tokenAdmission } from './token-hold.mjs';

/** Uses the owner's current ledger and persistence boundary; owns no separate account. */
export function diagnosticAccounting({ task, stage, config, getLedger, persistUsage }) {
  return {
    onStart(launchId) {
      if (providerOf(config) !== 'codex') return;
      if (tokenAdmission(task, stage, config, getLedger()))
        throw new Error('token admission holds diagnostic launch');
      persistUsage(task.id, (next) => beginTokenLaunch(next, task.id, launchId));
    },
    onResult(launchId, run) {
      if (providerOf(config) !== 'codex') return;
      const answer = readCodexAnswer(run, config, {
        ledger: getLedger(),
        taskId: task.id,
        launchId,
      });
      persistUsage(task.id, (next) => {
        next.tasks[task.id] = answer.usageLedger.tasks[task.id];
      });
    },
  };
}
