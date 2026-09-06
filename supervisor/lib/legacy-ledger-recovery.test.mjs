import { describe, expect, it } from 'vitest';
import { recoveryPlan, sessionEvidence } from './legacy-ledger-recovery.mjs';

const id = '01a07333-9085-7400-b661-8dd74ccf3d2a';
const cwd = 'C:\\src\\TD_Game\\.claude\\worktrees\\0231-example';
const event = (payload) => JSON.stringify({ type: 'event_msg', payload });
const record = (responseId, amount, cumulative) =>
  JSON.stringify({
    type: 'token_usage_record',
    payload: {
      thread_id: id,
      session_id: id,
      turn_id: 'turn-1',
      response_id: responseId,
      usage: { input_tokens: amount, output_tokens: 0, total_tokens: amount },
      thread_token_usage: { input_tokens: cumulative, output_tokens: 0, total_tokens: cumulative },
    },
  });
const trace = (records) =>
  [
    JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd } }),
    event({ type: 'task_started', turn_id: 'turn-1' }),
    ...records,
    event({ type: 'task_complete', turn_id: 'turn-1' }),
  ].join('\n');

describe('доказательство legacy ledger', () => {
  it('предпочитает накопитель record сброшенному legacy счётчику', () => {
    const usages = [...Array(17).fill(95000), 110338, 140626, 141370];
    let total = 0;
    const fixed = usages.map((amount, index) => {
      total += amount;
      return record(`response-${index}`, amount, total);
    });
    const evidence = sessionEvidence(trace(fixed), { sessionId: id, cwd });
    expect(evidence).toMatchObject({ ok: true, source: 'token_usage_record' });
    expect(evidence.snapshot.input_tokens).toBe(2007334);
    const plan = recoveryPlan(
      {
        version: 2,
        tasks: {
          '0231-example': {
            sessions: {
              [id]: { knownTokens: 1585645, snapshot: null, reasons: ['legacy-unknown', 'other'] },
            },
            launches: {},
          },
        },
      },
      new Map([[`0231-example:${id}`, evidence]]),
    );
    expect(plan.ledger.tasks['0231-example'].sessions[id]).toMatchObject({
      knownTokens: 2007334,
      reasons: ['other'],
    });
  });

  it('оставляет конфликт response_id и меньшую сумму неразрешёнными', () => {
    const conflict = sessionEvidence(trace([record('same', 10, 10), record('same', 20, 20)]), {
      sessionId: id,
      cwd,
    });
    expect(conflict).toMatchObject({ ok: false, reason: 'конфликтующий response_id' });
    const plan = recoveryPlan(
      {
        version: 2,
        tasks: {
          task: {
            sessions: { [id]: { knownTokens: 11, snapshot: null, reasons: ['legacy-unknown'] } },
            launches: {},
          },
        },
      },
      new Map([
        [
          `task:${id}`,
          { ok: true, snapshot: { input_tokens: 10, output_tokens: 0 }, source: 'test' },
        ],
      ]),
    );
    expect(plan.proposed).toEqual([]);
    expect(plan.unresolved[0].reason).toContain('меньше');
  });

  it('принимает legacy только с непрерывным завершённым следом', () => {
    const legacy = trace([]).replace(
      event({ type: 'task_complete', turn_id: 'turn-1' }),
      event({
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
      }) +
        '\n' +
        event({ type: 'task_complete', turn_id: 'turn-1' }),
    );
    expect(sessionEvidence(legacy, { sessionId: id, cwd })).toMatchObject({
      ok: true,
      source: 'legacy-token_count',
    });
    const reset = legacy
      .replace('input_tokens":4', 'input_tokens":3')
      .replace('output_tokens":2', 'output_tokens":1')
      .replace('total_tokens":6', 'total_tokens":4');
    expect(sessionEvidence(reset, { sessionId: id, cwd })).toMatchObject({ ok: true });
  });
});
