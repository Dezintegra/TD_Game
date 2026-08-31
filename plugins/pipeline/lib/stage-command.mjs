import { join } from 'node:path';
import { NEEDS_WORKTREE } from '../config/transitions.mjs';

/**
 * Из чего складывается запуск этапа.
 *
 * Чистый счёт: задача и настройка на входе, командная строка на выходе.
 * Ничего не запускает и диска не трогает — иначе состав доводов пришлось бы
 * проверять живыми процессами по полминуты за проверку.
 *
 * Всё, что здесь названо, проверено делом 31.08.2026, а не взято из памяти:
 * неинтерактивный запуск завершается сам, отдаёт код возврата и структурный
 * ответ, а правила из `--append-system-prompt-file` до сессии доходят.
 * Цифры проб — в `openspec/changes/supervise-the-pipeline/design.md`.
 */

/**
 * Собрать запуск этапа.
 *
 * @param {object} params
 * @param {object} params.assignment назначение: `taskId`, `stage`, `sessionId`,
 *                                   `continuation`, путь дерева `path`
 * @param {string} params.prompt     промпт назначения
 * @param {object} params.config     настройка после слияния с умолчаниями
 * @param {string} params.root       корень основного дерева
 * @returns {{ program: string, args: string[], cwd: string }}
 */
export function stageCommand({ assignment, prompt, config, root }) {
  const args = ['-p', prompt];

  // Правила этапа приходят файлом в системный промпт, а не скиллом.
  // Скилл нашёлся бы или не нашёлся в зависимости от того, как приложение
  // подхватило плагин; файл лежит по пути и никуда не девается. Проба
  // 31.08.2026 подтвердила: правило из файла сессия соблюдает.
  args.push('--append-system-prompt-file', join(root, config.skillsDir, `${assignment.stage}.md`));

  // Ответ структурой, а не текстом: из него берутся исход, отказанные
  // действия и идентификатор сессии. Разбирать человекочитаемый вывод
  // значило бы гадать.
  args.push('--output-format', 'json');

  // Продолжение ВОЗОБНОВЛЯЕТ прежнюю сессию, а не начинает новую. Это то,
  // чего файловый слот не мог передать в принципе: продолжатель прежде
  // выяснял сделанное тремя командами `git log` и иногда понимал неверно.
  //
  // Идентификатор выдаётся заранее — тогда он известен до запуска, а не
  // только из ответа, и возобновлять есть что даже после падения супервизора.
  if (assignment.continuation && assignment.sessionId) {
    args.push('--resume', assignment.sessionId);
  } else if (assignment.sessionId) {
    args.push('--session-id', assignment.sessionId);
  }

  // Правки в своём дереве — обычная работа этапа, спрашивать про них нечего.
  // Обход проверок целиком (`bypassPermissions`) не берём намеренно: он снял
  // бы и последнюю границу вокруг команд оболочки, а супервизор гоняет их
  // без человека сутками.
  args.push('--permission-mode', config.permissionMode);

  // Разрешения конвейера отдельным файлом: они не протекают в настройки
  // человека, а человеческие — в конвейер.
  if (config.stageSettings) args.push('--settings', join(root, config.stageSettings));

  // Модель называется, только если проект её назвал. Умолчания здесь нет
  // намеренно: угаданная модель — это чужой выбор цены и качества.
  if (config.stageModel) args.push('--model', config.stageModel);

  return {
    program: config.claudeCommand,
    args,
    // Рабочий каталог — дерево задачи, а у этапов без дерева основное.
    // Прогон и толкование дерева не имеют вовсе: арену считает чужое железо,
    // а толкование только читает уже снятые числа.
    cwd: NEEDS_WORKTREE.includes(assignment.stage) ? join(root, assignment.path) : root,
  };
}

/**
 * Сколько минут отпущено этапу.
 *
 * Общего срока на все этапы нет и быть не может: годный разбору на три
 * минуты запретил бы выкладку с замером, а годный выкладке не поймал бы
 * зависший разбор до вечера.
 */
export function stageTimeoutMs(stage, config) {
  const minutes = config.stageTimeoutMinutes?.[stage] ?? config.stageTimeoutMinutes?.default;
  return minutes * 60000;
}
