import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  readTokenLedger,
  recordTokenUsage,
  taskTokens,
  writeTokenLedger,
} from './token-budget.mjs';

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
