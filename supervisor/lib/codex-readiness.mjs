import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexExecutionArgs, codexInvocation, readCodexAnswer } from './provider.mjs';
import { startStage } from './run-stage.mjs';

/** Проверяем инструмент, а не обещание модели: текст «готов» ничего не доказывает. */
export async function checkCodexReadiness({ config, root, spawn, killTree, start = startStage }) {
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
      stdin: `Проверка среды. Выполни ровно git -C ${JSON.stringify(root)} rev-parse --is-inside-work-tree. Ничего не изменяй. При отказе остановись, не пробуй обходить политику. Верни результат команды.`,
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
    const ok = answer.outcome === 'done' && !failed && proof;
    return {
      ok,
      why: ok
        ? null
        : (answer.why ??
          failed?.aggregated_output ??
          'нет успешного выполнения проверочной Git-команды'),
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
