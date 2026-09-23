import { describe, expect, it } from 'vitest';
import { diagnosticAccounting } from './diagnostic-accounting.mjs';
import { commitTokenLedger, migrateTokenLedger, taskTokens } from './token-budget.mjs';

const task = { id: '0370-test' };
const config = { provider: 'codex', codexMaxTaskTokens: 100 };
const run = {
  code: 0,
  stdout: [
    { type: 'thread.started', thread_id: 'diagnostic-session' },
    { type: 'turn.completed', usage: { input_tokens: 90, output_tokens: 10 } },
  ]
    .map(JSON.stringify)
    .join('\n'),
};
function owner() {
  const ledger = migrateTokenLedger({});
  const saved = [];
  let failure = false;
  const accounting = diagnosticAccounting({
    task,
    stage: 'implement',
    config,
    getLedger: () => ledger,
    persistUsage: (id, update) => {
      expect(id).toBe(task.id);
      commitTokenLedger(ledger, update, (next) => {
        if (failure) throw new Error('disk unavailable');
        saved.push(globalThis.structuredClone(next));
      });
    },
  });
  return {
    accounting,
    ledger,
    saved,
    fail: (value) => {
      failure = value;
    },
  };
}
describe('shared diagnostic accounting', () => {
  it('saves begin, charges the result and checks the updated admission', () => {
    const h = owner();
    h.accounting.onStart('one');
    expect(h.saved[0].tasks[task.id].launches.one.completed).toBe(false);
    h.accounting.onResult('one', run);
    expect(taskTokens(h.ledger, task.id)).toBe(100);
    expect(() => h.accounting.onStart('two')).toThrow('token admission');
    expect(h.ledger.tasks[task.id].launches.two).toBeUndefined();
  });
  it.each(['begin', 'result'])(
    'propagates %s write failure and retry does not double charge',
    (phase) => {
      const h = owner();
      if (phase === 'result') h.accounting.onStart('one');
      const operation = () =>
        phase === 'begin' ? h.accounting.onStart('one') : h.accounting.onResult('one', run);
      const before = globalThis.structuredClone(h.ledger);
      h.fail(true);
      expect(operation).toThrow('disk unavailable');
      expect(h.ledger).toEqual(before);
      h.fail(false);
      operation();
      if (phase === 'begin') h.accounting.onResult('one', run);
      h.accounting.onResult('one', run);
      expect(taskTokens(h.ledger, task.id)).toBe(100);
      expect(h.saved).toHaveLength(2);
    },
  );
  it('keeps Claude callbacks inert without reading the Codex ledger', () => {
    const unexpected = () => {
      throw new Error('unexpected ledger access');
    };
    const callbacks = diagnosticAccounting({
      task,
      stage: 'implement',
      config: { provider: 'claude' },
      getLedger: unexpected,
      persistUsage: unexpected,
    });
    callbacks.onStart('one');
    callbacks.onResult('one', run);
  });
});
