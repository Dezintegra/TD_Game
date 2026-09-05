import { describe, expect, it } from 'vitest';
import { checkCodexReadiness } from './codex-readiness.mjs';
const completed = {
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
};
const command = {
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: 'git rev-parse --is-inside-work-tree',
    exit_code: 0,
    status: 'completed',
    aggregated_output: 'true\n',
  },
};
const check = (events, over = {}) =>
  checkCodexReadiness({
    config: {},
    root: '/repo',
    start: ({ command: probe, timeoutMs }) => {
      expect(timeoutMs).toBe(120000);
      expect(probe.args).toContain('--ephemeral');
      expect(probe.stdin).toContain('rev-parse');
      return {
        finished: Promise.resolve({
          code: 0,
          stdout: events.map((e) => JSON.stringify(e)).join('\n'),
          ...over,
        }),
      };
    },
  });
describe('проверка готовности Codex', () => {
  it('принимает только успешную выполненную команду', async () => {
    expect(
      (
        await check([
          command,
          {
            type: 'item.completed',
            item: {
              ...command.item,
              command: 'gh api user --jq .login',
              aggregated_output: 'Dezintegra',
            },
          },
          completed,
        ])
      ).ok,
    ).toBe(true);
    expect((await check([command, completed])).ok).toBe(false);
    expect((await check([completed])).ok).toBe(false);
    expect((await check([command, completed], { code: 1 })).ok).toBe(false);
    expect((await check([command, completed], { killedBy: 'timeout' })).ok).toBe(false);
  });
  it('не выдаёт отказ или ошибку Git за готовность модели', async () => {
    const denied = {
      type: 'item.completed',
      item: {
        ...command.item,
        status: 'declined',
        exit_code: -1,
        aggregated_output: 'blocked by policy',
      },
    };
    expect(await check([denied, completed])).toMatchObject({ ok: false, why: 'blocked by policy' });
    expect(
      (
        await check([
          { ...denied, item: { ...denied.item, status: 'failed', exit_code: 128 } },
          completed,
        ])
      ).ok,
    ).toBe(false);
  });
});
