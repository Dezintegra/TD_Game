import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { stageCommand } from './stage-command.mjs';
import { checkEnvironment } from './environment.mjs';
import { providerOf, readCodexAnswer } from './provider.mjs';
import { beginTokenLaunch, taskTokens } from './token-budget.mjs';

const home = fileURLToPath(new URL('..', import.meta.url));
const config = resolveConfig({ provider: 'codex' }).config;
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
    expect(command.args).toContain(
      process.platform === 'win32'
        ? 'default_permissions="td-pipeline"'
        : 'sandbox_mode="workspace-write"',
    );
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
  for (const text of [report, 'не JSON\nисходный текст']) {
    it.each(['decreased-usage', 'decreased-output', 'invalid-usage', 'history', 'cached'])(
      `сохраняет текст ${text} при %s`,
      (kind) => {
        const first = readCodexAnswer(run(), config);
        if (kind === 'history')
          first.usageLedger.tasks.answer.sessions['thread-1'].reasons.push('legacy-unknown');
        beginTokenLaunch(first.usageLedger, 'answer', 'next', 'thread-1');
        const usage =
          kind === 'invalid-usage'
            ? undefined
            : {
                input_tokens: kind === 'decreased-usage' ? 500 : kind === 'history' ? 2000 : 1000,
                output_tokens: kind === 'decreased-output' ? 50 : 100,
                cached_input_tokens: 0,
              };
        const answer = readCodexAnswer(
          run([
            events[0],
            events[1],
            { type: 'item.completed', item: { type: 'agent_message', text } },
            { type: 'turn.completed', usage },
          ]),
          config,
          { ledger: first.usageLedger, launchId: 'next' },
        );
        expect(answer.result).toBe(text);
        expect(answer.outcome).toBe(kind === 'cached' ? 'done' : 'failed');
        if (kind === 'cached') expect(answer.usageError).toBeNull();
        else
          expect(answer.usageError).toContain(
            kind === 'history'
              ? 'legacy-unknown'
              : kind === 'decreased-output'
                ? 'decreased-usage'
                : kind,
          );
      },
    );
  }
  it('читает терминальное событие и возвращает токены без долларовой оценки', () => {
    expect(readCodexAnswer(run(), config)).toMatchObject({
      outcome: 'done',
      sessionId: 'thread-1',
      result: report,
      turns: 1,
    });
    expect(readCodexAnswer(run(), config).cost).toBeNull();
  });
  it('не превращает обрыв потока или ненулевой код в успех', () => {
    expect(readCodexAnswer(run(events.slice(0, -1))).outcome).toBe('failed');
    expect(readCodexAnswer(run(events, 1)).outcome).toBe('failed');
  });
  it('после начала нового хода старый ответ уже не итог', () => {
    expect(readCodexAnswer(run([...events, { type: 'turn.started' }])).outcome).toBe('failed');
  });
  it('сохраняет идентификатор и расход при снятии по сроку', () => {
    expect(readCodexAnswer({ ...run(), killedBy: 'timeout' }, config)).toMatchObject({
      outcome: 'timeout',
      sessionId: 'thread-1',
      result: null,
    });
  });
  it('не считает неизвестную стоимость нулевой', () => {
    expect(readCodexAnswer(run()).cost).toBeNull();
    expect(
      readCodexAnswer(run([...events.slice(0, -1), { type: 'turn.completed' }]), {
        codexMaxTaskTokens: 25_000_000,
      }).outcome,
    ).toBe('failed');
  });
});

describe('границы сохранения текста Codex', () => {
  const message = (text) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
  for (const text of [report, '{сломанный JSON']) {
    it.each([
      null,
      {},
      { input_tokens: 10 },
      { input_tokens: -1, output_tokens: 1 },
      { input_tokens: '10', output_tokens: 1 },
      { input_tokens: 10, output_tokens: 0.5 },
    ])(`сохраняет ${text} при непригодном usage %j`, (usage) => {
      const answer = readCodexAnswer(
        run([events[0], message(text), { type: 'turn.completed', usage }]),
        config,
      );
      expect(answer).toMatchObject({ result: text, outcome: 'failed' });
      expect(answer.usageError).toContain('invalid-usage');
    });
  }

  it.each(['missing-terminal', 'new-turn', 'turn-failed', 'error', 'exit', 'killed', 'spawn'])(
    'текст не обходит проверку %s даже без токенового лимита',
    (kind) => {
      const items = [events[0], message(report), { type: 'turn.completed' }];
      if (kind === 'missing-terminal') items.pop();
      if (kind === 'new-turn') items.push({ type: 'turn.started' });
      if (kind === 'turn-failed')
        items.push({ type: 'turn.failed', error: { message: 'protocol failed' } });
      if (kind === 'error') items.push({ type: 'error', message: 'protocol error' });
      const answer = readCodexAnswer(
        {
          ...run(items, kind === 'exit' ? 1 : 0),
          ...(kind === 'killed' ? { killedBy: 'timeout' } : {}),
          ...(kind === 'spawn' ? { error: new Error('spawn failed') } : {}),
        },
        { codexMaxTaskTokens: null },
      );
      expect(answer.result).toBeNull();
      expect(answer.outcome).toBe(kind === 'killed' ? 'timeout' : 'failed');
      expect(answer.usageError).toBeTruthy();
      if (kind === 'error') expect(answer.why).toBe('protocol error');
    },
  );

  it('выбирает последнее сообщение текущего хода, различая пустое и отсутствующее', () => {
    for (const text of [report, '', null]) {
      const items = [...events, { type: 'turn.started' }];
      if (text !== null) items.push(message('промежуточный'), message(text));
      items.push({ type: 'turn.completed' });
      const answer = readCodexAnswer(run(items), { codexMaxTaskTokens: null });
      expect(answer.result).toBe(text);
      expect(answer.outcome).toBe('done');
      expect(answer.usageError).toContain('invalid-usage');
    }
  });

  it('числовой расход нового thread не снимает неизвестность старого', () => {
    const first = readCodexAnswer(
      run([events[0], message(report), { type: 'turn.completed' }]),
      config,
    );
    const answer = readCodexAnswer(
      run([{ type: 'thread.started', thread_id: 'new' }, message(report), events.at(-1)]),
      config,
      { ledger: first.usageLedger, launchId: 'new' },
    );
    expect(answer.usage).toMatchObject({ input_tokens: 1000, output_tokens: 100 });
    expect(answer).toMatchObject({ result: report, outcome: 'failed' });
    expect(answer.usageError).toContain('invalid-usage');
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
  it('проверяет положительный токеновый бюджет', () => {
    expect(inspect().fatal).toBeNull();
    expect(inspect({ codexMaxTaskTokens: null }).fatal).toBeNull();
    for (const value of [-1, 0, 1.5, '100'])
      expect(inspect({ codexMaxTaskTokens: value }).fatal).toContain('codexMaxTaskTokens');
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
  const first = readCodexAnswer(run(), config);
  beginTokenLaunch(first.usageLedger, 'answer', 'resume', 'thread-1');
  const second = readCodexAnswer(
    run([
      ...events.slice(0, -1),
      {
        type: 'turn.completed',
        usage: { input_tokens: 2000, cached_input_tokens: 400, output_tokens: 200 },
      },
    ]),
    config,
    { ledger: first.usageLedger, launchId: 'resume' },
  );
  expect(second.cost).toBeNull();
  expect(second.usage).toEqual(first.usage);
  expect(second.usageTotals.input_tokens).toBe(2000);
});

it('посторонний JSON null в потоке не роняет супервизор', () => {
  expect(readCodexAnswer({ ...run(), stdout: 'null\n' + run().stdout }).outcome).toBe('done');
});

it('подписка Codex не выключает долларовый лимит Claude', () => {
  expect(resolveConfig({ provider: 'codex' }).config.maxTaskCostUsd).toBeNull();
  expect(resolveConfig({ provider: 'claude' }).config.maxTaskCostUsd).toBe(25);
  expect(resolveConfig({ provider: 'codex' }).config.codexMaxTaskTokens).toBe(25_000_000);
});

it('прошлый usage не подтверждает расход нового завершённого хода', () => {
  expect(
    readCodexAnswer(run([...events, { type: 'turn.started' }, { type: 'turn.completed' }]), config)
      .outcome,
  ).toBe('failed');
});

it('согласует все completed, resume и уменьшение без отрицательного расхода', () => {
  const completed = (input_tokens, output_tokens) => ({
    type: 'turn.completed',
    usage: { input_tokens, output_tokens },
  });
  const first = readCodexAnswer(
    run([...events.slice(0, -1), completed(1000, 100), completed(1600, 140)]),
    config,
  );
  expect(first.usage).toEqual({ input_tokens: 1600, output_tokens: 140 });
  expect(first.usageLedger.tasks.answer.sessions['thread-1'].knownTokens).toBe(1740);
  beginTokenLaunch(first.usageLedger, 'answer', 'resume', 'thread-1');
  const resumed = readCodexAnswer(run([...events.slice(0, -1), completed(2000, 180)]), config, {
    ledger: first.usageLedger,
    launchId: 'resume',
  });
  expect(resumed.usage).toEqual({ input_tokens: 400, output_tokens: 40 });
  expect(taskTokens(resumed.usageLedger, 'answer')).toBe(2180);
  beginTokenLaunch(resumed.usageLedger, 'answer', 'smaller', 'thread-1');
  const smaller = readCodexAnswer(run([...events.slice(0, -1), completed(500, 40)]), config, {
    ledger: resumed.usageLedger,
    launchId: 'smaller',
  });
  expect(smaller.usage).toBeNull();
  expect(smaller.usageLedger.tasks.answer.sessions['thread-1'].knownTokens).toBe(2180);
  expect(smaller.usageReasons).toContain('decreased-usage');
});

it('повтор finish и раннего снимка после другого запуска не меняет реестр или расход старого запуска', () => {
  const first = readCodexAnswer(run(), config);
  const repeated = readCodexAnswer(run(), config, { ledger: first.usageLedger });
  expect(repeated.usageLedger).toEqual(first.usageLedger);
  beginTokenLaunch(first.usageLedger, 'answer', 'resume', 'thread-1');
  const second = readCodexAnswer(
    run([
      ...events.slice(0, -1),
      { type: 'turn.completed', usage: { input_tokens: 2000, output_tokens: 180 } },
    ]),
    config,
    { ledger: first.usageLedger, launchId: 'resume' },
  );
  const replay = readCodexAnswer(run(), config, { ledger: second.usageLedger });
  expect(replay.usageLedger).toEqual(second.usageLedger);
  expect(replay.usage).toEqual(first.usage);
  expect(replay.usageTotals).toEqual(first.usageTotals);
  expect(taskTokens(replay.usageLedger, 'answer')).toBe(2180);
});

it('включает Windows sandbox без Git-авторизации в argv', async () => {
  const { codexExecutionArgs } = await import('./provider.mjs');
  const args = codexExecutionArgs({}, '/main', '/tree', 'win32');
  expect(args).toContain('windows.sandbox="elevated"');
  expect(args.join()).not.toContain('GIT_CONFIG');
  expect(args.join()).not.toContain('credential');
  expect(codexExecutionArgs({}, '/main', '/tree', 'linux').join()).not.toContain('windows.sandbox');
  expect(() =>
    codexExecutionArgs({ codexWindowsSandbox: 'disabled' }, '/main', '/tree', 'win32'),
  ).toThrow('codexWindowsSandbox');
});

it('считает declined отдельным отказом, даже когда модель завершила ответ', () => {
  const denied = {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'declined',
      command: 'git status',
      aggregated_output: 'blocked by policy',
      exit_code: -1,
    },
  };
  const answer = readCodexAnswer(run([denied, ...events]));
  expect(answer.denials).toEqual([
    { tool_name: 'shell', tool_input: { command: 'git status' }, reason: 'blocked by policy' },
  ]);
});
