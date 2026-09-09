import { describe, expect, it } from 'vitest';
import { sessionEvidence } from './legacy-ledger-recovery.mjs';
import {
  recoverTokenLaunch,
  taskTokens,
  taskTokenStatus,
  tokenAccountingAllowed,
  commitTokenLedger,
  migrateTokenLedger,
} from './token-budget.mjs';
import { tokenAdmission } from './token-hold.mjs';

const after = '2026-09-08T10:03:21.812Z';
const cwd = '/repo/trees/0242';
const raw = (type, payload) =>
  JSON.stringify({ timestamp: '2026-09-08T10:04:00.000Z', type, payload });
const record = (response, amount, total) =>
  raw('token_usage_record', {
    session_id: 's',
    thread_id: 's',
    turn_id: 't',
    response_id: response,
    usage: { input_tokens: amount, output_tokens: 0, total_tokens: amount },
    thread_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
  });
const trace = () =>
  [
    raw('session_meta', { id: 's', session_id: 's', cwd }),
    raw('event_msg', { type: 'task_started', turn_id: 't' }),
    record('a', 1000000, 1000000),
    record('b', 771976, 1771976),
  ].join('\n');
const options = { sessionId: 's', cwd, after, allowIncomplete: true };
const ledger = () => ({
  version: 2,
  tasks: {
    task: {
      sessions: {
        previous: { knownTokens: 39719702, snapshot: null, reasons: [] },
        s: { knownTokens: 0, snapshot: null, reasons: ['missing-usage', 'stdout-unavailable'] },
      },
      launches: {
        l: {
          sessionId: 's',
          baseline: { input_tokens: 0, output_tokens: 0 },
          observations: {},
          completed: true,
          reasons: ['missing-usage', 'stdout-unavailable'],
        },
      },
    },
  },
});

describe('восстановление прерванного расхода', () => {
  it('учитывает реальный сценарий 0242 ровно один раз и допускает минимум без объявления полноты', () => {
    const data = ledger();
    expect(sessionEvidence(trace(), { ...options, allowIncomplete: false }).ok).toBe(false);
    const proof = sessionEvidence(trace(), options);
    expect(proof).toMatchObject({ ok: true, complete: false, snapshot: { input_tokens: 1771976 } });
    expect(recoverTokenLaunch(data, 'task', 'l', proof)).toBe(true);
    expect(taskTokens(data, 'task')).toBe(41491678);
    expect(taskTokenStatus(data, 'task')).toMatchObject({
      complete: false,
      acceptedIncomplete: true,
      reasons: ['missing-usage', 'stdout-unavailable'],
    });
    const restored = migrateTokenLedger(data);
    expect(recoverTokenLaunch(restored, 'task', 'l', proof)).toBe(false);
    expect(restored).toEqual(data);
    expect(
      tokenAdmission(
        { id: 'task' },
        'review',
        { provider: 'codex', codexMaxTaskTokens: 50000000 },
        data,
      ),
    ).toBeNull();
    expect(
      tokenAdmission(
        { id: 'task' },
        'review',
        { provider: 'codex', codexMaxTaskTokens: 40000000 },
        data,
      ),
    ).toMatchObject({ reason: 'exhausted', accountingComplete: false });
    restored.tasks.task.launches.next = {
      sessionId: null,
      baseline: null,
      observations: {},
      completed: false,
      reasons: [],
    };
    expect(tokenAccountingAllowed(taskTokenStatus(restored, 'task'))).toBe(false);
    expect(
      tokenAccountingAllowed(taskTokenStatus({ ...data, writeErrors: ['task'] }, 'task')),
    ).toBe(false);
  });
  it.each([
    ['чужая сессия', () => trace().replaceAll('"session_id":"s"', '"session_id":"foreign"')],
    ['чужое дерево', () => trace().replace(cwd, '/other')],
    ['разрыв', () => trace().replaceAll('1771976', '1771977')],
    ['конфликт response', () => trace() + '\n' + record('a', 2, 1771978)],
    ['повреждение', () => trace() + '\n{'],
    [
      'новый незавершённый turn',
      () => trace() + '\n' + raw('event_msg', { type: 'task_started', turn_id: 'other' }),
    ],
  ])('не разрешает %s', (_, make) => {
    const data = ledger(),
      proof = sessionEvidence(make(), options);
    expect(proof.ok).toBe(false);
    expect(recoverTokenLaunch(data, 'task', 'l', proof)).toBe(false);
    expect(taskTokens(data, 'task')).toBe(39719702);
  });
  it('отвергает устаревшее доказательство и не принимает один legacy token_count', () => {
    expect(sessionEvidence(trace(), { ...options, after: '2026-09-09T00:00:00Z' }).ok).toBe(false);
    expect(sessionEvidence(trace(), { ...options, after: null }).ok).toBe(false);
    const legacy =
      trace().split('\n').slice(0, 2).join('\n') +
      '\n' +
      raw('event_msg', {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
      });
    expect(sessionEvidence(legacy, options).ok).toBe(false);
  });
  it('сохраняет блокировку иных причин и не переписывает больший минимум', () => {
    for (const change of [
      (d) => d.tasks.task.sessions.s.reasons.push('invalid-usage'),
      (d) => (d.tasks.task.sessions.s.knownTokens = 2000000),
      (d) => (d.tasks.task.launches.l.completed = false),
      (d) => (d.tasks.task.launches.other = globalThis.structuredClone(d.tasks.task.launches.l)),
    ]) {
      const data = ledger();
      change(data);
      expect(recoverTokenLaunch(data, 'task', 'l', sessionEvidence(trace(), options))).toBe(false);
    }
  });
  it('атомарно сохраняет и восстанавливается после ошибки записи', () => {
    const data = ledger(),
      proof = sessionEvidence(trace(), options);
    expect(() =>
      commitTokenLedger(
        data,
        (d) => recoverTokenLaunch(d, 'task', 'l', proof),
        () => {
          throw Error('disk');
        },
      ),
    ).toThrow('disk');
    expect(data).toEqual(ledger());
    commitTokenLedger(
      data,
      (d) => recoverTokenLaunch(d, 'task', 'l', proof),
      () => {},
    );
    expect(taskTokens(data, 'task')).toBe(41491678);
  });
});
