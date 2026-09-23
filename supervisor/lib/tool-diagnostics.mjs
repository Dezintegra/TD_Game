import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageCommand } from './stage-command.mjs';
import { codexGitEnvironment } from './codex-environment.mjs';
import { startStage } from './run-stage.mjs';
import { classifyToolControls, sameToolContext } from './stage-tool-health.mjs';
import {
  powerShellControl,
  refreshControls,
  toolControls,
  TOOL_DIAGNOSTIC_TIMEOUT_MS,
} from './tool-controls.mjs';
import { evidenceHash } from './refresh-evidence.mjs';

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
  mode = 'controls',
  evidence,
  observer,
  signal,
}) {
  if (!['controls', 'refresh-investigation'].includes(mode))
    throw new Error('unknown-diagnostic-mode');
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
  if (!sameToolContext(expectedContext, context))
    return { verdict: 'inconclusive', context, checks: [], reason: 'unverified-context' };
  if (mode === 'refresh-investigation')
    return investigateRefresh({
      command,
      environment,
      context,
      provider,
      evidence,
      observer,
      signal,
      spawn,
      killTree,
      start,
      now,
      onStart,
      onResult,
    });
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
  });
  const deadline = now() + TOOL_DIAGNOSTIC_TIMEOUT_MS;
  const facts = [];
  const runs = [];
  let accountingError = null;
  for (const control of controls) {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) break;
    const startedAt = now();
    const launchId = randomUUID();
    try {
      await onStart(launchId);
    } catch (error) {
      accountingError = error.message;
      break;
    }
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
    runs.push({ ...run, launchId, startedAt, finishedAt });
    try {
      await onResult(launchId, run);
    } catch (error) {
      accountingError = error.message;
      break;
    }
    facts.push(...controlFacts({ ...run, startedAt, finishedAt }, control, context, provider));
    if (classifyToolControls({ context, controls, facts }).verdict === 'confirmed') break;
  }
  const result = classifyToolControls({ context, controls, facts });
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

/** Не классифицирует outage: пригодность определяет отдельный checker bundle. */
async function investigateRefresh({
  command,
  environment,
  context,
  provider,
  evidence,
  observer,
  signal,
  spawn,
  killTree,
  start,
  now,
  onStart,
  onResult,
}) {
  if (provider !== 'codex' || !evidence?.append || !evidence?.primary || !observer?.arm)
    throw new Error('refresh-investigation-requires-codex-evidence-observer');
  const controls = refreshControls(command.cwd);
  const deadline = now() + 600_000;
  const runs = [];
  for (let session = 0; session < 2 && now() < deadline && !signal?.aborted; session++) {
    const launchId = randomUUID();
    let sessionId = null;
    let index = 0;
    let streamError = null;
    let handle;
    const seen = new Set();
    const stamp = () => new Date(now()).toISOString();
    let primaryIndex = 0;
    const append = (event) => {
      const record = { ...event, launchId, at: stamp() };
      const ref = evidence.primary(`${launchId}-${++primaryIndex}`, record);
      evidence.append({
        ...record,
        references: [
          ...(record.references ?? []),
          {
            ...ref,
            sourcePath: ref.path,
            capturedAt: record.at,
            firstLine: 1,
            lastLine: 1,
            fromUtc: record.at,
            toUtc: record.at,
          },
        ],
      });
    };
    // Armed before spawn, stopped only after exit and the stream drain.
    const watch = await observer.arm({ launchId, deadline, emit: append });
    const abort = () => handle?.kill();
    try {
      if (signal?.aborted || now() >= deadline) break;
      await onStart(launchId);
      let run;
      try {
        if (signal?.aborted || now() >= deadline)
          throw new Error('probe-not-started-deadline-or-cancellation');
        handle = start({
          command: {
            ...command,
            env: environment,
            stdin:
              'Диагностика refresh. Выполни последовательно ровно четыре отдельных вызова PowerShell в этой сессии, даже после отказа. Не объединяй вызовы, не повторяй сверх списка, не меняй права, профиль или файлы. Не печатай секреты.\n' +
              controls.map((control, i) => `${i + 1}. ${powerShellControl(control)}`).join('\n'),
          },
          spawn,
          killTree,
          timeoutMs: Math.min(120_000, deadline - now()),
          beforeInput: async ({ pid }) => {
            const identity = await watch.captureLaunch(pid);
            append({ ...identity, kind: 'prelaunch' });
          },
          onEvent: (event) => {
            if (streamError) return;
            try {
              if (event?.type === 'thread.started') {
                if (sessionId && sessionId !== event.thread_id) throw new Error('mixed-session');
                if (typeof event.thread_id !== 'string' || !event.thread_id)
                  throw new Error('missing-session');
                sessionId = event.thread_id;
                append({ kind: 'session', sessionId });
              }
              if (event?.type !== 'item.completed' || event.item?.type !== 'command_execution')
                return;
              const item = event.item;
              if (!sessionId || !item.id || seen.has(item.id) || index >= controls.length)
                throw new Error('unmatched-invocation');
              const facts = controlFacts(
                { stdout: JSON.stringify(event) },
                controls[index],
                context,
                provider,
              );
              if (facts.length !== 1) throw new Error('unexpected-command-order');
              const fact = facts[0];
              if (
                fact.kind !== 'spawn-error' &&
                (!fact.completed || !Number.isInteger(fact.exitCode))
              )
                throw new Error('unstructured-command-result');
              seen.add(item.id);
              const record = {
                kind: 'command',
                sessionId,
                invocationId: item.id,
                eventId: item.id,
                commandIndex: index++,
                created: fact.kind !== 'spawn-error',
                ...(fact.kind === 'spawn-error'
                  ? { errorCode: fact.errorCode }
                  : { exitCode: fact.exitCode }),
                outputHash: evidenceHash(String(fact.output ?? '')),
              };
              watch.correlate?.({
                sessionId,
                invocationId: item.id,
                commandIndex: record.commandIndex,
              });
              append(record);
            } catch (error) {
              streamError = error;
              abort();
            }
          },
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || streamError) abort();
        run = await handle.finished;
      } catch (error) {
        run = { code: null, stdout: '', stderr: '', error };
      }
      runs.push({ ...run, launchId });
      // Failure here propagates to the owning runtime: never release unsaved usage.
      await onResult(launchId, run);
      append({
        kind: 'session-end',
        sessionId,
        reason:
          streamError?.message ?? (index === 4 ? 'commands-observed' : 'missing-command-results'),
      });
      if (streamError || run.error || run.killedBy || signal?.aborted) break;
    } finally {
      signal?.removeEventListener('abort', abort);
      await watch.close();
    }
  }
  return { verdict: 'inconclusive', reason: 'requires-refresh-evidence-check', context, runs };
}
