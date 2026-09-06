import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  readTokenLedger,
  writeTokenLedger,
  emptyTokenSession,
  tokenLaunch,
  reduceTokenObservation,
  launchTokenUsage,
  normalizeTokenUsage,
  migrateTokenLedger,
  commitTokenLedger,
} from './token-budget.mjs';

it('v2 переносит каждую старую сумму с legacy-unknown и проверяет схему', () => {
  const ledger = migrateTokenLedger({ a: { s: 1740, t: 0 }, b: { u: 320 } });
  expect(ledger.tasks.a.sessions.s).toEqual({
    knownTokens: 1740,
    snapshot: null,
    reasons: ['legacy-unknown'],
  });
  expect(ledger.tasks.a.sessions.t.knownTokens).toBe(0);
  expect(ledger.tasks.b.sessions.u.knownTokens).toBe(320);
  expect(migrateTokenLedger(ledger)).toEqual(ledger);
  expect(migrateTokenLedger({})).toEqual({ version: 2, tasks: {} });
  for (const data of [
    null,
    [],
    { version: 3, tasks: {} },
    { a: { s: -1 } },
    { version: 2, tasks: { a: { sessions: {}, launches: { l: {} } } } },
  ])
    expect(() => migrateTokenLedger(data)).toThrow('счётчик');
});

it('v2 переживает round-trip, а ошибка до rename оставляет память и файл для повтора', () => {
  const root = mkdtempSync(join(tmpdir(), 'td-tokens-v2-'));
  const config = { paths: { local: '.pipeline' } };
  try {
    const ledger = readTokenLedger(root, config);
    writeTokenLedger(root, config, ledger);
    const update = (next) => {
      next.tasks.a = { sessions: { s: emptyTokenSession() }, launches: { l: tokenLaunch('s') } };
    };
    expect(() =>
      commitTokenLedger(ledger, update, () => {
        throw new Error('rename failed');
      }),
    ).toThrow('rename failed');
    expect(ledger).toEqual({ version: 2, tasks: {} });
    expect(readTokenLedger(root, config)).toEqual(ledger);
    const save = (next) => writeTokenLedger(root, config, next);
    expect(commitTokenLedger(ledger, update, save)).toBe(true);
    expect(commitTokenLedger(ledger, update, save)).toBe(false);
    expect(readTokenLedger(root, config)).toEqual(ledger);
    writeFileSync(join(root, '.pipeline/codex-usage.json'), '');
    expect(() => readTokenLedger(root, config)).toThrow();
    writeFileSync(join(root, '.pipeline/codex-usage.json'), '{bad');
    expect(() => readTokenLedger(root, config)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
