import { describe, expect, it } from 'vitest';
import { checkCodexReadiness } from './codex-readiness.mjs';
const completed = {
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
};
const command = (text, output, over = {}) => ({
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command: text,
    exit_code: 0,
    status: 'completed',
    aggregated_output: output,
    ...over,
  },
});
const git = command('git rev-parse --is-inside-work-tree', 'true\n');
const github = command('gh api user --jq .login', 'Dezintegra');
const ssh = command(
  'ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -- dezintegra "printf td-codex-ssh-ready"',
  'td-codex-ssh-ready',
);
const check = (events, over = {}, env = {}) =>
  checkCodexReadiness({
    config: {},
    root: '/repo',
    env,
    start: ({ command: probe, timeoutMs }) => {
      expect(timeoutMs).toBe(120000);
      expect(probe.args).toContain('--ephemeral');
      expect(probe.stdin).toContain('rev-parse');
      expect(probe.stdin).toContain(`-- ${env.TD_DEPLOY_HOST ?? 'dezintegra'} `);
      expect(probe.stdin).toContain('BatchMode=yes');
      expect(probe.stdin).toContain('StrictHostKeyChecking=yes');
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
  it('принимает только все успешные команды и завершённый процесс', async () => {
    const events = [git, github, ssh, completed];
    expect((await check(events)).ok).toBe(true);
    for (const missing of [git, github, ssh])
      expect((await check(events.filter((event) => event !== missing))).ok).toBe(false);
    expect((await check([completed])).ok).toBe(false);
    expect((await check(events, { code: 1 })).ok).toBe(false);
    expect((await check(events, { killedBy: 'timeout' })).ok).toBe(false);
  });
  it.each([
    ['declined', -1, 'blocked by policy'],
    ['failed', 255, 'Could not resolve hostname dezintegra'],
    ['failed', 255, 'Permission denied (publickey).'],
    ['failed', 255, 'Host key verification failed.'],
  ])('сохраняет ошибку SSH: %s %s %s', async (status, exit_code, output) => {
    expect(
      await check([
        git,
        github,
        command(ssh.item.command, output, { status, exit_code }),
        completed,
      ]),
    ).toMatchObject({ ok: false, why: output });
  });
  it('не принимает текст модели, локальное echo и пустой вывод вместо удалённого маркера', async () => {
    for (const event of [
      { type: 'item.completed', item: { type: 'agent_message', text: 'td-codex-ssh-ready' } },
      command('echo td-codex-ssh-ready', 'td-codex-ssh-ready'),
      command(ssh.item.command, ''),
    ])
      expect((await check([git, github, event, completed])).ok).toBe(false);
  });
  it('проверяет выбранный TD_DEPLOY_HOST, а не другой доступный сервер', async () => {
    const env = { TD_DEPLOY_HOST: 'deploy@example.org' };
    expect((await check([git, github, ssh, completed], {}, env)).ok).toBe(false);
    const chosen = command(
      ssh.item.command.replace('dezintegra', env.TD_DEPLOY_HOST),
      'td-codex-ssh-ready',
    );
    expect((await check([git, github, chosen, completed], {}, env)).ok).toBe(true);
  });
  it.each(['', '-F', 'host; whoami', '$(whoami)', 'host\ntrue'])(
    'не вставляет некорректный host в команду: %s',
    async (host) => {
      expect(await check([], {}, { TD_DEPLOY_HOST: host })).toMatchObject({ ok: false, run: null });
    },
  );
});
