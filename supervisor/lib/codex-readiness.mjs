import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploySshHost, deploySshOptions } from '../../scripts/deploy-ssh.mjs';
import { codexExecutionArgs, codexInvocation, readCodexAnswer } from './provider.mjs';
import { startStage } from './run-stage.mjs';
import { codexGitEnvironment } from './codex-environment.mjs';
import { modelForStage } from './stage-model.mjs';
import { toolControls, powerShellControl, TOOL_DIAGNOSTIC_TIMEOUT_MS } from './tool-controls.mjs';

/** Дешёвая сетевая проба перед повторной дорогой проверкой внутри Codex. */
export function checkRemoteReachability({ root, env, run }) {
  let host;
  try {
    host = deploySshHost(env?.TD_DEPLOY_HOST);
    deploySshOptions(env);
  } catch (error) {
    return { ok: false, why: error.message };
  }
  const script = fileURLToPath(new URL('../../scripts/deploy-remote.mjs', import.meta.url));
  const result = run(
    [script, '--host', host, '--', 'printf td-codex-ssh-ready'],
    process.execPath,
    root,
    { timeout: 30_000, env },
  );
  const ok = result.code === 0 && result.stdout?.trim() === 'td-codex-ssh-ready';
  return {
    ok,
    why: ok
      ? null
      : String(result.stderr || result.stdout || 'SSH не подтвердил соединение').trim(),
  };
}

/** Проверяем инструмент, а не обещание модели: текст «готов» ничего не доказывает. */
export async function checkCodexReadiness({
  config,
  root,
  env,
  spawn,
  killTree,
  start = startStage,
  platform = process.platform,
}) {
  const host = env?.TD_DEPLOY_HOST ?? 'dezintegra';
  if (!/^[a-zA-Z0-9_[\]][a-zA-Z0-9_.@:[\]-]*$/.test(host))
    return { ok: false, why: 'TD_DEPLOY_HOST: требуется SSH-псевдоним или адрес', run: null };
  try {
    deploySshOptions(env);
  } catch (error) {
    return { ok: false, why: error.message, run: null };
  }
  const remoteScript = fileURLToPath(new URL('../../scripts/deploy-remote.mjs', import.meta.url));
  const ssh = `node ${JSON.stringify(remoteScript)} --host ${host} -- "printf td-codex-ssh-ready"`;
  const remote = config.remote ?? 'origin';
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(remote))
    return { ok: false, why: 'remote: требуется имя Git remote', run: null };
  if (platform === 'win32') {
    // Подготовка ACL реального cwd не должна расходовать время первой задачи.
    // Прямой вызов не просит модель ждать и не расходует её токены.
    const command = {
      ...codexInvocation(config, [
        'sandbox',
        ...codexExecutionArgs(config, root, root, platform),
        '-P',
        'td-pipeline',
        '-C',
        root,
        '--',
        process.execPath,
        '-e',
        "process.stdout.write('td-workspace-ready')",
      ]),
      cwd: root,
      env: codexGitEnvironment(env, root, root),
    };
    const run = await start({ command, timeoutMs: 600_000, spawn, killTree }).finished;
    if (run.code !== 0 || run.killedBy || run.stdout?.trim() !== 'td-workspace-ready')
      return { ok: false, why: 'Windows sandbox основного рабочего каталога не готов', run };
  }
  // После перезагрузки задача планировщика может не дать модельной команде
  // доступ к новому каталогу в пользовательском Temp, хотя прямая подготовка
  // песочницы прошла. Локальное хозяйство лежит под уже подготовленным root.
  const probeParent =
    platform === 'win32' ? join(root, config.paths?.local ?? '.pipeline') : tmpdir();
  if (platform === 'win32') mkdirSync(probeParent, { recursive: true });
  const cwd = mkdtempSync(join(probeParent, 'td-codex-ready-'));
  const script = join(cwd, 'codex-node-probe.mjs');
  try {
    writeFileSync(script, readFileSync(new URL('./codex-node-probe.mjs', import.meta.url)));
    const controls = toolControls({
      stage: 'deploy',
      cwd: root,
      remote,
      host,
      childScript: script,
      sshScript: remoteScript,
      id: '',
    });
    const push = powerShellControl(controls.find((control) => control.id === 'push'));
    const node = powerShellControl(controls.find((control) => control.id === 'child'));
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
    const model = modelForStage(config, 'codex', 'deploy');
    if (model) args.push('--model', model);
    args.push('-');
    const command = {
      ...codexInvocation(config, args),
      cwd,
      env: codexGitEnvironment(env, root, cwd),
      stdin: `Проверка среды. Выполни пятью отдельными командами: git -C ${JSON.stringify(root)} rev-parse --is-inside-work-tree; gh api user --jq .login; ${push}; ${node}; ${ssh}. Dry-run проверяет отправку Git без записи удалённых refs; Node проверяет запуск дочерних процессов для pnpm и сборки; SSH проверяет только соединение с сервером выкладки. Не печатай окружение, git config, токены и другие секреты. Ничего не изменяй. При ошибке или отказе остановись, не пробуй альтернативы, не меняй настройки и права доступа. Верни результат команды.`,
    };
    const run = await start({ command, timeoutMs: TOOL_DIAGNOSTIC_TIMEOUT_MS, spawn, killTree })
      .finished;
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
    const sshCommand = (item) => /\bnode\b.*deploy-remote\.mjs/.test(item.command ?? '');
    const failedLocal = commands.find(
      (item) => !sshCommand(item) && (item.status !== 'completed' || item.exit_code !== 0),
    );
    const failedSsh = commands.find(
      (item) => sshCommand(item) && (item.status !== 'completed' || item.exit_code !== 0),
    );
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
        sshCommand(item) &&
        item.command.includes(`--host ${host} --`) &&
        item.aggregated_output?.trim() === 'td-codex-ssh-ready',
    );
    const pushReady = commands.some(
      (item) =>
        /\bgit\b.*push\s+--dry-run\b/.test(item.command ?? '') &&
        item.command.includes(`${remote} HEAD:refs/heads/codex/readiness`),
    );
    const processesReady = commands.some(
      (item) =>
        /\bnode\b.*codex-node-probe\.mjs/.test(item.command ?? '') &&
        item.aggregated_output?.trim() === 'td-codex-processes-ready',
    );
    const ok =
      answer.outcome === 'done' &&
      !failedLocal &&
      proof &&
      authenticated &&
      pushReady &&
      processesReady;
    return {
      ok,
      remoteReady: ok && connected && !failedSsh,
      remoteWhy:
        ok && (!connected || failedSsh)
          ? failedSsh?.aggregated_output?.trim() || 'нет подтверждённой SSH-команды'
          : null,
      why: ok
        ? null
        : (answer.why ??
          failedLocal?.aggregated_output ??
          'нет успешных проверочных команд Git, git push --dry-run, GitHub и дочерних процессов Node'),
      run,
    };
  } finally {
    rmSync(script, { force: true });
    // Удаляем только пустой каталог пробы; никаких рекурсивных удалений.
    try {
      rmdirSync(cwd);
    } catch {
      /* Непустой каталог оставляем для диагностики. */
    }
  }
}
