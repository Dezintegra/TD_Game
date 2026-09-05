import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
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
const push = command(
  'git push --dry-run origin HEAD:refs/heads/codex/readiness',
  'Everything up-to-date',
);
const ssh = command(
  'node deploy-remote.mjs --host dezintegra -- "printf td-codex-ssh-ready"',
  'td-codex-ssh-ready',
);
const node = command('node codex-node-probe.mjs', 'td-codex-processes-ready');
const check = (events, over = {}, env = {}) =>
  checkCodexReadiness({
    config: {},
    root: '/repo',
    env: { GH_TOKEN: 'test-token', ...env },
    start: ({ command: probe, timeoutMs }) => {
      expect(timeoutMs).toBe(120000);
      expect(probe.args).toContain('--ephemeral');
      expect(probe.args.join()).not.toContain('test-token');
      expect(probe.stdin).toContain('push --dry-run');
      expect(probe.stdin).toContain('rev-parse');
      expect(probe.stdin).toContain(`--host ${env.TD_DEPLOY_HOST ?? 'dezintegra'} --`);
      expect(probe.stdin).toContain('deploy-remote.mjs');
      expect(probe.env.TD_DEPLOY_SSH_CONFIG).toBe(env.TD_DEPLOY_SSH_CONFIG);
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
    const events = [git, github, push, ssh, node, completed];
    expect((await check(events)).ok).toBe(true);
    for (const missing of [git, github, push, ssh, node])
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
      expect((await check([git, github, push, event, completed])).ok).toBe(false);
  });
  it('проверяет выбранный TD_DEPLOY_HOST, а не другой доступный сервер', async () => {
    const env = { TD_DEPLOY_HOST: 'deploy@example.org' };
    expect((await check([git, github, push, ssh, node, completed], {}, env)).ok).toBe(false);
    const chosen = command(
      ssh.item.command.replace('dezintegra', env.TD_DEPLOY_HOST),
      'td-codex-ssh-ready',
    );
    expect((await check([git, github, push, chosen, node, completed], {}, env)).ok).toBe(true);
  });
  it.each(['', '-F', 'host; whoami', '$(whoami)', 'host\ntrue'])(
    'не вставляет некорректный host в команду: %s',
    async (host) => {
      expect(await check([], {}, { TD_DEPLOY_HOST: host })).toMatchObject({ ok: false, run: null });
    },
  );
});

it('отклоняет сбой Git push даже при успешных GitHub API и SSH', async () => {
  const failure = command(push.item.command, 'authentication failed', {
    exit_code: 128,
    status: 'failed',
  });
  expect(await check([git, github, failure, ssh, completed])).toMatchObject({
    ok: false,
    why: 'authentication failed',
  });
});

it('не принимает EPERM, echo или текст модели вместо запуска дочерних процессов', async () => {
  for (const fake of [
    command(node.item.command, 'EPERM', { exit_code: 1, status: 'failed' }),
    command('echo td-codex-processes-ready', 'td-codex-processes-ready'),
    { type: 'item.completed', item: { type: 'agent_message', text: 'td-codex-processes-ready' } },
  ]) {
    expect((await check([git, github, push, ssh, fake, completed])).ok).toBe(false);
  }
});

it('скрипт реально порождает процессы и временный каталог удаляется после проверки', async () => {
  let cwd;
  const result = await checkCodexReadiness({
    config: {},
    root: '/repo',
    env: { GH_TOKEN: 'test-token' },
    start: ({ command: probe }) => {
      cwd = probe.cwd;
      const script = join(cwd, 'codex-node-probe.mjs');
      const output = execFileSync(process.execPath, [script], {
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(output).toBe('td-codex-processes-ready');
      expect(probe.stdin).toContain('codex-node-probe.mjs');
      return {
        finished: Promise.resolve({
          code: 0,
          stdout: [git, github, push, ssh, command(`node ${script}`, output), completed]
            .map((e) => JSON.stringify(e))
            .join('\n'),
        }),
      };
    },
  });
  expect(result.ok).toBe(true);
  expect(existsSync(cwd)).toBe(false);
});

it('удаляет скрипт и каталог после ошибки порождения пробы', async () => {
  let cwd;
  await expect(
    checkCodexReadiness({
      config: {},
      root: '/repo',
      env: { GH_TOKEN: 'test-token' },
      start: ({ command: probe }) => {
        cwd = probe.cwd;
        throw new Error('test spawn failure');
      },
    }),
  ).rejects.toThrow('test spawn failure');
  expect(existsSync(cwd)).toBe(false);
});
