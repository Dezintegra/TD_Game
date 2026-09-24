import { describe, expect, it } from 'vitest';
import { createToolDiagnosticAccounting } from './tool-diagnostic-accounting.mjs';
import { migrateTokenLedger, commitTokenLedger, taskTokens } from './token-budget.mjs';

const codexRun = {
  code: 0,
  stdout: [
    { type: 'thread.started', thread_id: 'diagnostic-session' },
    {
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 0 },
    },
  ]
    .map(JSON.stringify)
    .join('\n'),
};

describe('shared diagnostic accounting', () => {
  function fixture(config = { provider: 'codex' }) {
    const ledger = migrateTokenLedger({});
    const events = [];
    let fail = false;
    const options = {
      config,
      taskId: 'task',
      task: { id: 'task' },
      stage: 'revise',
      getLedger: () => ledger,
      persistUsage: (_taskId, update) =>
        commitTokenLedger(ledger, update, () => {
          events.push('usage');
          if (fail) throw new Error('write ledger');
        }),
      saveIntent: () => {
        events.push('intent');
      },
      saveRaw: () => {
        events.push('raw');
      },
      saveReceipt: () => {
        events.push('receipt');
      },
    };
    return {
      ledger,
      events,
      options,
      fail: () => {
        fail = true;
      },
    };
  }
  it('records raw before usage, counts Codex tokens once even across adapter restart', async () => {
    const f = fixture();
    const accounting = createToolDiagnosticAccounting(f.options);
    await accounting.onStart('launch');
    expect(f.events).toEqual(['intent', 'usage']);
    f.events.length = 0;
    const receipt = await accounting.onResult('launch', codexRun);
    expect(f.events).toEqual(['raw', 'usage', 'receipt']);
    expect(receipt).toMatchObject({
      unit: 'tokens',
      state: 'accounted',
      sessionId: 'diagnostic-session',
    });
    expect(taskTokens(f.ledger, 'task')).toBe(13);
    f.events.length = 0;
    expect(await accounting.onResult('launch', codexRun)).toEqual(receipt);
    expect(f.events).toEqual(['raw']);
    f.events.length = 0;
    expect(await createToolDiagnosticAccounting(f.options).onResult('launch', codexRun)).toEqual(
      receipt,
    );
    expect(f.events).toEqual(['raw', 'receipt']);
    expect(taskTokens(f.ledger, 'task')).toBe(13);
    await expect(accounting.onResult('launch', { ...codexRun, code: 1 })).rejects.toThrow(
      'conflict',
    );
  });
  it('refuses exhausted budget before intent or spawn', async () => {
    const f = fixture({ provider: 'codex', codexMaxTaskTokens: 1 });
    const accounting = createToolDiagnosticAccounting(f.options);
    await accounting.onStart('first');
    await accounting.onResult('first', codexRun);
    f.events.length = 0;
    await expect(accounting.onStart('second')).rejects.toThrow('token admission');
    expect(f.events).toEqual([]);
    expect(f.ledger.tasks.task.launches.second).toBeUndefined();
  });
  it('keeps raw data ahead of an accounting persistence error', async () => {
    const f = fixture();
    const accounting = createToolDiagnosticAccounting(f.options);
    await accounting.onStart('launch');
    f.fail();
    f.events.length = 0;
    await expect(accounting.onResult('launch', codexRun)).rejects.toThrow('write ledger');
    expect(f.events).toEqual(['raw', 'usage']);
    expect(taskTokens(f.ledger, 'task')).toBe(0);
  });
  it('keeps the actual Claude cost and does not invent zero for unknown cost', async () => {
    const f = fixture({ provider: 'claude' });
    const accounting = createToolDiagnosticAccounting(f.options);
    const run = {
      code: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.25,
        session_id: 'claude-session',
        result: '{}',
      }),
    };
    await accounting.onStart('launch');
    const receipt = await accounting.onResult('launch', run);
    expect(receipt).toMatchObject({ unit: 'USD', costUsd: 0.25, state: 'accounted' });
    expect(accounting.costUsd({ runs: [run] })).toBe(0.25);
    expect(f.events).toEqual(['intent', 'raw', 'receipt']);
    expect(await accounting.onResult('missing', { code: 1, stdout: '' })).toMatchObject({
      state: 'unknown',
      costUsd: null,
    });
  });
});
