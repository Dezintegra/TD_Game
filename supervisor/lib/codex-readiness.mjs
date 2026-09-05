import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexExecutionArgs, codexInvocation, readCodexAnswer } from './provider.mjs';
import { startStage } from './run-stage.mjs';

/** Проверяем инструмент, а не обещание модели: текст «готов» ничего не доказывает. */
export async function checkCodexReadiness({
  config,
  root,
  env,
  spawn,
  killTree,
  start = startStage,
}) {
  const host = env?.TD_DEPLOY_HOST ?? 'dezintegra';
  if (!/^[a-zA-Z0-9_[\]][a-zA-Z0-9_.@:[\]-]*$/.test(host))
    return { ok: false, why: 'TD_DEPLOY_HOST: требуется SSH-псевдоним или адрес', run: null };
  const ssh = `ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -- ${host} "printf td-codex-ssh-ready"`;
  const cwd = mkdtempSync(join(tmpdir(), 'td-codex-ready-'));
  try {
    const args = [
      'exec',
      '--ignore-user-config',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      ...codexExecutionArgs(config, root, cwd),
      '-c',
      'project_doc_max_bytes=0',
    ];
    if (config.codexModel) args.push('--model', config.codexModel);
    args.push('-');
    const command = {
      ...codexInvocation(config, args),
      cwd,
      env,
      stdin: `Проверка среды. Выполни тремя отдельными командами: git -C ${JSON.stringify(root)} rev-parse --is-inside-work-tree; gh api user --jq .login; ${ssh}. SSH проверяет только соединение с сервером выкладки. Не печатай токены и другие секреты. Ничего не изменяй. При ошибке или отказе остановись, не пробуй альтернативы, не меняй настройки и права доступа. Верни результат команды.`,
    };
    const run = await start({ command, timeoutMs: 120_000, spawn, killTree }).finished;
    const answer = readCodexAnswer(run, config);
    const commands = String(run.stdout ?? '')
      .split('\n')
      .flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return event?.type === 'item.completed' && event.item?.type === 'command_execution'
            ? [event.item]
            : [];
        } catch {
          return [];
        }
      });
    const failed = commands.find((item) => item.status !== 'completed' || item.exit_code !== 0);
    const proof = commands.some(
      (item) =>
        /\bgit\b.*rev-parse\s+--is-inside-work-tree/.test(item.command ?? '') &&
        item.aggregated_output?.trim() === 'true',
    );
    const authenticated = commands.some(
      (item) =>
        /\bgh\s+api\s+user\b/.test(item.command ?? '') &&
        /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(item.aggregated_output?.trim() ?? ''),
    );
    const connected = commands.some(
      (item) =>
        /\bssh\s/.test(item.command ?? '') &&
        item.command.includes(`-- ${host} `) &&
        item.aggregated_output?.trim() === 'td-codex-ssh-ready',
    );
    const ok = answer.outcome === 'done' && !failed && proof && authenticated && connected;
    return {
      ok,
      why: ok
        ? null
        : (answer.why ??
          failed?.aggregated_output ??
          'нет успешных проверочных команд Git, GitHub и SSH'),
      run,
    };
  } finally {
    // Удаляем только пустой каталог пробы; никаких рекурсивных удалений.
    try {
      rmdirSync(cwd);
    } catch {
      /* Непустой каталог оставляем для диагностики. */
    }
  }
}
