import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function validTokenPrices(prices) {
  return (
    prices != null &&
    ['input', 'cachedInput', 'output'].every(
      (key) => Number.isFinite(prices[key]) && prices[key] >= 0,
    )
  );
}

export function codexStageCommand({ assignment, prompt, config, root, home }) {
  const skillDir = isAbsolute(config.skillsDir)
    ? config.skillsDir
    : resolve(home, config.skillsDir);
  const rules = readFileSync(join(skillDir, `${assignment.stage}.md`), 'utf8');
  const args = [
    'exec',
    '--ignore-user-config',
    '--json',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify([join(root, '.git')])}`,
  ];
  if (config.codexModel) args.push('--model', config.codexModel);
  if (assignment.continuation && assignment.sessionId) args.push('resume', assignment.sessionId);
  args.push('-');
  return {
    ...codexInvocation(config, args),
    cwd: assignment.path ? resolve(root, assignment.path) : root,
    stdin: `Правила автономного этапа:\n${rules}\n\nРабочее дерево уже назначено супервизором; повторно спрашивать о его создании не нужно. Выполни только назначенный этап. Не вызывай интерактивные вопросы: если нужен ответ человека, верни его в JSON-отчёте по правилам этапа.\n\n${prompt}`,
  };
}

/** Разбираем только протокол событий; текст ответа не доказывает завершение. */
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
        error = 'Codex usage уменьшился: стоимость продолжения неизвестна';
      usage[key] = Math.max(0, usage[key] - (previousUsage[key] ?? 0));
    }
  }
  answer.usage = hasUsage ? usage : null;
  if (hasUsage && validTokenPrices(config.codexTokenPrices)) {
    const rates = config.codexTokenPrices;
    answer.cost =
      (Math.max(0, usage.input_tokens - usage.cached_input_tokens) * rates.input +
        usage.cached_input_tokens * rates.cachedInput +
        usage.output_tokens * rates.output) /
      1e6;
  }
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
  if (config.maxTaskCostUsd != null && !hasUsage) {
    return {
      ...answer,
      outcome: 'failed',
      why: 'Codex не сообщил usage: денежный лимит проверить нельзя',
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
  if (config.codexModel) args.push('--model', config.codexModel);
  args.push('Ответь одним словом: готов. Не вызывай инструменты.');
  return codexInvocation(config, args);
}
