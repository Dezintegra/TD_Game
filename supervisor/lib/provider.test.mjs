import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { stageCommand } from './stage-command.mjs';
import { checkEnvironment } from './environment.mjs';
import { providerOf, readCodexAnswer } from './provider.mjs';

const home = fileURLToPath(new URL('..', import.meta.url));
const config = resolveConfig({ provider: 'codex' }).config;
const prices = { input: 2, cachedInput: 1, output: 8 };
const report = JSON.stringify({ stage: 'design', outcome: 'done', summary: 'готово' });
const events = [
  { type: 'thread.started', thread_id: 'thread-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: report } },
  {
    type: 'turn.completed',
    usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 },
  },
];
const run = (items = events, code = 0) => ({
  stdout: items.map((event) => JSON.stringify(event)).join('\n'),
  code,
});

describe('выбор исполнителя', () => {
  it('сохраняет Claude по умолчанию и отвергает опечатку', () => {
    expect(providerOf(resolveConfig().config)).toBe('claude');
    expect(() => resolveConfig({ provider: 'typo' })).toThrow('provider');
  });
  it('Codex получает правила этапа, stdin и свою модель без ключей Claude', () => {
    const command = stageCommand({
      root: '/repo',
      home,
      config: { ...config, stageModel: 'claude-only', codexModel: 'explicit-model' },
      assignment: { stage: 'design', path: 'tree', sessionId: 'unused' },
      prompt: 'назначение',
    });
    expect(command.stdin).toContain('назначение');
    expect(command.stdin).toContain('design');
    expect(command.args).toContain('explicit-model');
    expect(command.args).not.toContain('claude-only');
    expect(command.args).not.toContain('--session-id');
    expect(command.args).not.toContain('--settings');
    expect(command.args).not.toContain('unused');
    expect(command.args.at(-1)).toBe('-');
    expect(command.args).toContain('sandbox_mode="workspace-write"');
  });
  it('продолжает конкретную сессию и снова передаёт ограничения', () => {
    const command = stageCommand({
      root: '/repo',
      home,
      config,
      assignment: { stage: 'design', continuation: true, sessionId: 'thread-1' },
      prompt: 'доделай',
    });
    expect(command.args.slice(-3)).toEqual(['resume', 'thread-1', '-']);
    expect(command.args).toContain('approval_policy="never"');
  });
});

describe('ответ Codex', () => {
  it('читает терминальное событие и считает оценку с учётом кэша', () => {
    expect(readCodexAnswer(run(), { codexTokenPrices: prices })).toMatchObject({
      outcome: 'done',
      sessionId: 'thread-1',
      result: report,
      turns: 1,
    });
    expect(readCodexAnswer(run(), { codexTokenPrices: prices }).cost).toBeCloseTo(0.0026);
  });
  it('не превращает обрыв потока или ненулевой код в успех', () => {
    expect(readCodexAnswer(run(events.slice(0, -1))).outcome).toBe('failed');
    expect(readCodexAnswer(run(events, 1)).outcome).toBe('failed');
  });
  it('после начала нового хода старый ответ уже не итог', () => {
    expect(readCodexAnswer(run([...events, { type: 'turn.started' }])).outcome).toBe('failed');
  });
  it('сохраняет идентификатор и расход при снятии по сроку', () => {
    expect(
      readCodexAnswer({ ...run(), killedBy: 'timeout' }, { codexTokenPrices: prices }),
    ).toMatchObject({
      outcome: 'timeout',
      sessionId: 'thread-1',
      result: null,
    });
  });
  it('не считает неизвестную стоимость нулевой', () => {
    expect(readCodexAnswer(run()).cost).toBeNull();
    expect(
      readCodexAnswer(run([...events.slice(0, -1), { type: 'turn.completed' }]), {
        maxTaskCostUsd: 25,
      }).outcome,
    ).toBe('failed');
  });
});

describe('предпроверка Codex', () => {
  const inspect = (over = {}) =>
    checkEnvironment({
      root: '/repo',
      home,
      config: { ...config, ...over },
      env: {},
      exists: () => true,
      run: () => ({ code: 0, stdout: 'version' }),
    });
  it('не снимает денежный потолок молча', () => {
    expect(inspect().fatal).toContain('codexTokenPrices');
    expect(inspect({ codexTokenPrices: prices }).fatal).toBeNull();
    expect(inspect({ maxTaskCostUsd: null }).fatal).toBeNull();
    expect(inspect({ codexTokenPrices: { ...prices, output: -1 } }).fatal).toContain(
      'codexTokenPrices',
    );
  });
});

it('отказ API до работы сохраняет попытку, после инструмента — обычная неудача', () => {
  const failure = { type: 'turn.failed', error: { message: 'HTTP 429 rate limit' } };
  expect(readCodexAnswer(run([events[0], events[1], failure], 1)).outcome).toBe('api-error');
  expect(
    readCodexAnswer(
      run([events[0], { type: 'item.completed', item: { type: 'command_execution' } }, failure], 1),
    ).outcome,
  ).toBe('failed');
});

it('накопительный usage после resume не считает прошлый заход второй раз', () => {
  const first = readCodexAnswer(run(), { codexTokenPrices: prices });
  const second = readCodexAnswer(
    run([
      ...events.slice(0, -1),
      {
        type: 'turn.completed',
        usage: { input_tokens: 2000, cached_input_tokens: 400, output_tokens: 200 },
      },
    ]),
    { codexTokenPrices: prices },
    first.usageTotals,
  );
  expect(second.cost).toBeCloseTo(first.cost);
  expect(second.usage).toEqual(first.usage);
  expect(second.usageTotals.input_tokens).toBe(2000);
});
