import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageCommand } from './stage-command.mjs';
import { codexGitEnvironment } from './codex-environment.mjs';
import { startStage } from './run-stage.mjs';
import { classifyToolControls, sameToolContext } from './stage-tool-health.mjs';
import { powerShellControl, toolControls, TOOL_DIAGNOSTIC_TIMEOUT_MS } from './tool-controls.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function isControlCommand(actual, expected) {
  if (actual === expected) return true;
  if (typeof actual !== 'string') return false;
  const wrapped =
    /^(?:"[^"\r\n]*[\\/]powershell\.exe"|powershell(?:\.exe)?|pwsh(?:\.exe)?) (?:-NoProfile )?-Command ([\s\S]+)$/i.exec(
      actual,
    );
  if (!wrapped) return false;
  return wrapped[1] === `'${expected.replaceAll("'", "''")}'`;
}

/** Отпечатки не раскрывают окружение и разрешения в диагностическом журнале. */
export function toolContext(command, provider, env) {
  const permissions = [];
  for (let index = 0; index < command.args.length; index++) {
    const arg = command.args[index];
    if (['-c', '--permission-mode', '--settings'].includes(arg)) {
      const value = command.args[++index];
      permissions.push([arg, value, arg === '--settings' ? readFileSync(value, 'utf8') : null]);
    }
  }
  return {
    provider,
    cwd: resolve(command.cwd),
    environmentId: hash(Object.entries(env ?? process.env).sort()),
    permissionsId: hash(permissions),
  };
}

/** Только события инструмента; ответ модели никогда не становится свидетельством. */
export function controlFacts(run, control, context, provider) {
  const command = powerShellControl(control);
  const events = String(run.stdout ?? '')
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const uses = new Map();
  const facts = [];
  for (const [sequence, event] of events.entries()) {
    if (provider === 'claude') {
      for (const item of event.message?.content ?? []) {
        if (item.type === 'tool_use' && isControlCommand(item.input?.command, command))
          uses.set(item.id, item);
        if (item.type !== 'tool_result' || !uses.has(item.tool_use_id)) continue;
        const result = event.tool_use_result;
        // Claude без структурированного exit code не позволяет отличить отказ политики.
        if (!Number.isInteger(result?.exit_code)) continue;
        facts.push({
          eventId: item.tool_use_id,
          sequence,
          kind: 'exit',
          completed: true,
          exitCode: result.exit_code,
          output: result.stdout ?? '',
        });
      }
    } else if (
      event.type === 'item.completed' &&
      event.item?.type === 'command_execution' &&
      isControlCommand(event.item.command, command)
    ) {
      const item = event.item;
      if (
        item.status === 'failed' &&
        item.execution_error?.phase === 'spawn' &&
        item.execution_error.created === false
      ) {
        facts.push({
          eventId: item.id,
          sequence,
          kind: 'spawn-error',
          created: false,
          errorCode: item.execution_error.code,
          output: item.aggregated_output,
        });
        continue;
      }
      facts.push({
        eventId: item.id,
        sequence,
        kind: 'exit',
        completed: item.status === 'completed',
        exitCode: item.exit_code,
        output: item.aggregated_output,
      });
    }
  }
  return facts.map((fact) => ({
    ...fact,
    checkId: control.id,
    invocationId: control.invocationId,
    argv: control.argv,
    context,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }));
}

export async function diagnoseStageTools({
  assignment,
  config,
  root,
  home,
  env,
  expectedContext,
  spawn,
  killTree,
  start = startStage,
  now = Date.now,
  buildCommand = stageCommand,
  onStart = () => {},
  onResult = () => {},
  profile = 'default',
}) {
  const provider = config.provider ?? 'claude';
  const command = buildCommand({
    assignment: { ...assignment, continuation: false, sessionId: null },
    prompt: '',
    config,
    root,
    home,
  });
  const environment = provider === 'codex' ? codexGitEnvironment(env, root, command.cwd) : env;
  const context = toolContext(command, provider, environment);
  // Проверяем профиль до записи вспомогательных файлов и допуска запуска.
  toolControls({ stage: assignment.stage, cwd: command.cwd, profile });
  if (!sameToolContext(expectedContext, context))
    return { verdict: 'inconclusive', context, checks: [], reason: 'unverified-context' };
  const parent = join(command.cwd, '.matchlog');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'tool-diagnostic-'));
  const script = join(directory, 'child.mjs');
  writeFileSync(script, readFileSync(new URL('./codex-node-probe.mjs', import.meta.url)));
  const controls = toolControls({
    stage: assignment.stage,
    cwd: command.cwd,
    remote: config.remote,
    host: env?.TD_DEPLOY_HOST,
    childScript: script,
    sshScript: fileURLToPath(new URL('../../scripts/deploy-remote.mjs', import.meta.url)),
    profile,
  });
  const deadline = now() + TOOL_DIAGNOSTIC_TIMEOUT_MS;
  const facts = [];
  const runs = [];
  let accountingError = null;
  let stopReason = null;
  const attempted = new Set();
  for (const control of controls) {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) {
      stopReason = 'deadline';
      break;
    }
    const startedAt = now();
    const launchId = randomUUID();
    try {
      await onStart(launchId, control);
    } catch (error) {
      accountingError = error.message;
      stopReason = 'admission-or-persistence';
      break;
    }
    attempted.add(control.id);
    const run = await start({
      command: {
        ...command,
        env: environment,
        stdin: `Диагностика среды. Выполни ровно одну команду PowerShell без изменений: ${powerShellControl(control)}\nНе выполняй другие команды, не меняй настройки и права, не исправляй ошибки. Не печатай секреты.`,
      },
      timeoutMs,
      spawn,
      killTree,
    }).finished;
    const finishedAt = now();
    // Сырой ответ сохраняет в том числе фактический расход диагностической сессии.
    runs.push({ ...run, launchId, startedAt, finishedAt, control });
    facts.push(...controlFacts({ ...run, startedAt, finishedAt }, control, context, provider));
    try {
      await onResult(launchId, run, { control, startedAt, finishedAt });
    } catch (error) {
      accountingError = error.message;
      stopReason = 'accounting-or-persistence';
      break;
    }
    if (
      profile === 'default' &&
      classifyToolControls({ context, controls, facts }).verdict === 'confirmed'
    )
      break;
  }
  const result = classifyToolControls({ context, controls, facts });
  if (profile !== 'default') {
    result.checks = result.checks.map((check, index) => ({
      ...check,
      invocationId: controls[index].invocationId,
      ...(!attempted.has(check.id) ? { status: 'not-run', reason: stopReason } : {}),
    }));
  }
  if (
    result.verdict === 'healthy' &&
    runs.some((run) => run.code !== 0 || run.killedBy || run.error)
  )
    result.verdict = 'inconclusive';
  return {
    ...result,
    ...(accountingError ? { verdict: 'inconclusive', accountingError } : {}),
    runs,
  };
}
