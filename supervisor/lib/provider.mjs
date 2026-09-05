import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelForStage } from './stage-model.mjs';

export function providerOf(config) {
  const provider = config.provider ?? 'claude';
  if (!['claude', 'codex'].includes(provider)) throw new Error(`Неизвестный provider: ${provider}`);
  return provider;
}

/** npm-обёртки Windows нельзя передавать execFile как исполняемые файлы. */
export function codexInvocation(config, args) {
  return {
    program: process.execPath,
    args: [
      fileURLToPath(new URL('../bin/codex-runner.mjs', import.meta.url)),
      config.codexCommand ?? 'codex',
      ...args,
    ],
  };
}

export function codexExecutionArgs(config, root, cwd, platform = process.platform) {
  const args = [
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.ignore_default_excludes=true',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify([join(root, '.git')])}`,
  ];
  if (platform === 'win32') {
    // Профиль сохраняет защиту :workspace и явно разрешает служебные записи Git.
    // Обычные writable_roots не снимают защиту .git в связанном worktree.
    args.splice(4);
    const common = resolve(root, '.git');
    let gitdir = common;
    const pointer = join(cwd, '.git');
    try {
      if (statSync(pointer).isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(pointer, 'utf8'));
        if (!match) throw new Error('Некорректный gitdir');
        gitdir = resolve(cwd, match[1].trim());
        const subpath = relative(common, gitdir);
        if (subpath.startsWith('..') || isAbsolute(subpath))
          throw new Error('gitdir назначенного дерева выходит за общую .git');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const filesystem = [...new Set([common, gitdir])]
      .map((path) => JSON.stringify(path.replaceAll('\\', '/')) + '="write"')
      .join(',');
    args.push(
      '-c',
      'default_permissions="td-pipeline"',
      '-c',
      'permissions={td-pipeline={extends=":workspace",filesystem={' +
        filesystem +
        '},network={enabled=true}}}',
    );
    const sandbox = config.codexWindowsSandbox ?? 'elevated';
    if (!['elevated', 'unelevated'].includes(sandbox))
      throw new Error('codexWindowsSandbox: требуется elevated или unelevated');
    args.push('-c', `windows.sandbox=${JSON.stringify(sandbox)}`);
  }
  return args;
}

export function codexStageCommand({ assignment, prompt, config, root, home }) {
  const skillDir = isAbsolute(config.skillsDir)
    ? config.skillsDir
    : resolve(home, config.skillsDir);
  const rules = readFileSync(join(skillDir, `${assignment.stage}.md`), 'utf8');
  const cwd = assignment.path ? resolve(root, assignment.path) : root;
  const args = ['exec', '--ignore-user-config', '--json', ...codexExecutionArgs(config, root, cwd)];
  const model = modelForStage(config, 'codex', assignment.stage);
  if (model) args.push('--model', model);
  if (assignment.continuation && assignment.sessionId) args.push('resume', assignment.sessionId);
  args.push('-');
  return {
    ...codexInvocation(config, args),
    cwd,
    stdin: `Правила автономного этапа:\n${rules}\n\nРабочее дерево уже назначено супервизором; повторно спрашивать о его создании не нужно. Выполни только назначенный этап. Не вызывай интерактивные вопросы: если нужен ответ человека, верни его в JSON-отчёте по правилам этапа.\n\n${prompt}`,
  };
}

/** Разбираем только протокол событий; текст ответа не доказывает завершение. */
export function codexDenial(event) {
  if (event?.type !== 'item.completed' || event.item?.status !== 'declined') return null;
  return {
    tool_name: event.item.type === 'command_execution' ? 'shell' : event.item.type,
    tool_input: { command: event.item.command ?? JSON.stringify(event.item.changes ?? []) },
    reason: event.item.aggregated_output || 'Codex: blocked by policy',
  };
}

export function readCodexAnswer(run, config = {}, previousUsage = null) {
  const answer = {
    envelope: null,
    denials: [],
    sessionId: null,
    result: null,
    cost: null,
    turns: 0,
    usage: null,
  };
  let terminal = null;
  let error = null;
  let message = null;
  let toolsUsed = false;
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let hasUsage = false;
  for (const line of String(run.stdout ?? '').split('\n')) {
    let event;
    try {
      event = JSON.parse(line.replace(/^\uFEFF/, ''));
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const denial = codexDenial(event);
    if (denial) answer.denials.push(denial);
    if (event.item && event.item.type !== 'agent_message' && event.item.type !== 'reasoning')
      toolsUsed = true;
    if (event.type === 'thread.started') answer.sessionId = event.thread_id ?? null;
    if (event.type === 'turn.started') {
      terminal = null;
      message = null;
      error = null;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message')
      message = event.item.text;
    if (event.type === 'turn.completed') {
      terminal = event;
      answer.turns += 1;
      if (
        event.usage &&
        Object.keys(usage).every(
          (key) => Number.isFinite(event.usage[key]) && event.usage[key] >= 0,
        )
      ) {
        for (const key of Object.keys(usage)) usage[key] = event.usage[key];
        hasUsage = true;
      }
    }
    if (event.type === 'turn.failed') {
      terminal = event;
      error = event.error?.message ?? 'Codex turn.failed';
    }
    if (event.type === 'error') error = event.message ?? 'Codex error';
  }
  answer.envelope = terminal;
  // CLI возвращает накопительный usage всей сессии, включая resume.
  answer.usageTotals = hasUsage ? { ...usage } : null;
  if (hasUsage && previousUsage) {
    for (const key of Object.keys(usage)) {
      if (usage[key] < (previousUsage[key] ?? 0))
        error = 'Codex usage уменьшился: расход продолжения неизвестен';
      usage[key] = Math.max(0, usage[key] - (previousUsage[key] ?? 0));
    }
  }
  answer.usage = hasUsage ? usage : null;
  if (run.killedBy) return { ...answer, outcome: 'timeout', why: `этап снят: ${run.killedBy}` };
  if (run.error)
    return { ...answer, outcome: 'failed', why: `запуск не состоялся: ${run.error.message}` };
  if (
    error &&
    !toolsUsed &&
    answer.turns === 0 &&
    /\b(?:429|500|502|503|504)\b|rate limit|usage limit/i.test(error)
  ) {
    return { ...answer, outcome: 'api-error', why: error };
  }
  if (run.code !== 0 || terminal?.type !== 'turn.completed' || error) {
    return {
      ...answer,
      outcome: 'failed',
      why: error ?? `Codex не завершил ход (код ${run.code})`,
    };
  }
  if (
    config.codexMaxTaskTokens != null &&
    (!hasUsage ||
      !terminal.usage ||
      !Object.keys(usage).every(
        (key) => Number.isFinite(terminal.usage[key]) && terminal.usage[key] >= 0,
      ))
  ) {
    return {
      ...answer,
      outcome: 'failed',
      why: 'Codex не сообщил usage: токеновый бюджет проверить нельзя',
    };
  }
  return { ...answer, result: message, outcome: 'done', why: null };
}

export function codexProbeCommand(config) {
  const args = [
    'exec',
    '--ignore-user-config',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
  ];
  const model = modelForStage(config, 'codex', 'default');
  if (model) args.push('--model', model);
  args.push('Ответь одним словом: готов. Не вызывай инструменты.');
  return codexInvocation(config, args);
}
