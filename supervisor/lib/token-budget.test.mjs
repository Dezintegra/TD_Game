import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  readTokenLedger,
  recordTokenUsage,
  taskTokens,
  writeTokenLedger,
  emptyTokenSession,
  tokenLaunch,
  reduceTokenObservation,
  launchTokenUsage,
  normalizeTokenUsage,
} from './token-budget.mjs';

// Синтетический fixture по producer ThreadTokenUsage.total в Codex rust-v0.146.0:
// codex-rs/exec/src/event_processor_with_jsonl_output.rs (usage_from_last_total).
const snapshots = [
  { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 50 },
  { input_tokens: 1600, cached_input_tokens: 900, output_tokens: 140, reasoning_output_tokens: 60 },
];

it('reducer считает накопитель один раз, различает равные события и replay', () => {
  let state = {
    session: emptyTokenSession(),
    launch: tokenLaunch('s', { input_tokens: 0, output_tokens: 0 }),
  };
  const apply = (ordinal, usage) => {
    state = reduceTokenObservation(state.session, state.launch, ordinal, usage);
  };
  apply(1, snapshots[0]);
  apply(2, snapshots[1]);
  const saved = globalThis.structuredClone(state);
  apply(1, snapshots[0]);
  expect(state).toEqual(saved);
  apply(3, snapshots[1]);
  expect(Object.keys(state.launch.observations)).toHaveLength(3);
  expect(state.session.knownTokens).toBe(1740);
  expect(launchTokenUsage(state.session, state.launch)).toEqual({
    input_tokens: 1600,
    output_tokens: 140,
    cached_input_tokens: 900,
  });
  apply(4, { input_tokens: 500, output_tokens: 40 });
  expect(state.session.knownTokens).toBe(1740);
  expect(state.session.reasons).toContain('decreased-usage');
  expect(launchTokenUsage(state.session, state.launch)).toBeNull();
  apply(5, { input_tokens: 2000, output_tokens: 180 });
  expect(state.session.knownTokens).toBe(2180);
  expect(launchTokenUsage(state.session, state.launch)).toBeNull();
});

it('reducer проверяет целые и безопасную сумму, конфликт ключа не списывает повторно', () => {
  for (const usage of [
    null,
    {},
    { input_tokens: 0.5, output_tokens: 1 },
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, cached_input_tokens: 2 },
  ]) {
    expect(normalizeTokenUsage(usage)).toBeNull();
    expect(
      reduceTokenObservation(emptyTokenSession(), tokenLaunch(), 1, usage).session.reasons,
    ).toContain('invalid-usage');
  }
  const first = reduceTokenObservation(emptyTokenSession(), tokenLaunch(), 1, snapshots[0]);
  const conflict = reduceTokenObservation(first.session, first.launch, 1, snapshots[1]);
  expect(conflict.session.knownTokens).toBe(1100);
  expect(conflict.session.reasons).toContain('conflicting-observation');
});

it('суммирует сессии, учитывает кэш один раз и переживает перезапуск без двойного учёта', () => {
  const root = mkdtempSync(join(tmpdir(), 'td-tokens-'));
  const config = { paths: { local: '.pipeline' } };
  try {
    const ledger = readTokenLedger(root, config);
    const usage = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 };
    recordTokenUsage(ledger, 'task', 'session1', usage);
    writeTokenLedger(root, config, ledger);
    const restarted = readTokenLedger(root, config);
    expect(recordTokenUsage(restarted, 'task', 'session1', usage)).toBe(false);
    expect(recordTokenUsage(restarted, 'task', 'session1', { ...usage, input_tokens: 500 })).toBe(
      false,
    );
    recordTokenUsage(restarted, 'task', 'session1', { ...usage, input_tokens: 2000 });
    recordTokenUsage(restarted, 'task', 'session2', usage);
    expect(taskTokens(restarted, 'task')).toBe(3200);
    expect(taskTokens(restarted, 'another')).toBe(0);
    writeTokenLedger(root, config, restarted);
    expect(readTokenLedger(root, config)).toEqual(restarted);
    writeFileSync(join(root, '.pipeline/codex-usage.json'), '{"task":{"s":-1}}');
    expect(() => readTokenLedger(root, config)).toThrow('счётчик');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('не выдаёт отсутствие или испорченный usage за известный расход', () => {
  const ledger = {};
  for (const usage of [null, {}, { input_tokens: -1, output_tokens: 1 }])
    expect(recordTokenUsage(ledger, 'task', 's', usage)).toBe(false);
  expect(ledger).toEqual({});
});
