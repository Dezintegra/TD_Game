import { randomUUID } from 'node:crypto';
import { readAnswer, startStage as spawnStageProcess } from './run-stage.mjs';
import { parseReport } from './parse-report.mjs';
import { stageCommand, stageTimeoutMs } from './stage-command.mjs';
import { stagePrompt } from './stage-prompt.mjs';

/**
 * Хозяйство идущих этапов.
 *
 * Держит дескрипторы, считает квоту прямым подсчётом живых детей, помнит
 * идентификаторы сессий ради возобновления и складывает пришедшие отчёты
 * в очередь на перенос.
 *
 * Всё, что трогает мир — порождение, снятие, часы, запись файлов, — приходит
 * доводом. Поэтому и срок, и отказанные действия, и неразобравшийся отчёт
 * проверяются за миллисекунды, а не живыми запусками по десятку секунд
 * и по деньгам за каждый.
 */
export function createSupervisor({
  config,
  root,
  spawn,
  killTree,
  now = () => new Date().toISOString(),
  saveStages = () => {},
  stages = {},
  log = () => {},
  writeStageLog = () => {},
  readStageLog = () => null,
}) {
  /** Живые этапы: `taskId` → дескриптор. */
  const children = new Map();
  /** Отчёты, дождавшиеся переноса в бэклог. Их читает `io`. */
  const reports = [];
  /** Память о сессиях: `taskId:stage` → идентификатор. Переживает перезапуск. */
  const known = { ...stages };

  const key = (taskId, stage) => `${taskId}:${stage}`;

  return {
    reports,

    /** Идущие этапы для сканера: вся картина живости, какая есть. */
    running: () => [...children.values()].map(({ taskId, stage }) => ({ taskId, stage })),

    /** Идентификатор сессии прошлого захода на этот этап, если он был. */
    lastSession: (taskId, stage) => known[key(taskId, stage)] ?? null,

    /**
     * Забыть сессию этапа: следующий заход начнётся с чистого листа.
     *
     * Нужно там, где задачу вернули на пройденный этап. Возобновлённая сессия
     * помнит свой прошлый вывод и отвечает из него — «всё сделано», — не читая
     * замечания, ради которого её и позвали. Проверено 31.08.2026: четыре
     * круга подряд на неизменной вершине, тридцать секунд на круг.
     */
    forgetSession(taskId, stage) {
      if (!(key(taskId, stage) in known)) return false;
      delete known[key(taskId, stage)];
      saveStages(known);
      return true;
    },

    /** Сколько этапов идёт прямо сейчас. */
    busy: () => children.size,

    /**
     * Породить этап.
     *
     * Возвращает управление сразу: цикл обязан идти дальше, пока этап
     * работает. Отказ здесь — это несостоявшееся порождение, а не
     * неудавшийся этап; путать их нельзя, лечатся они по-разному.
     */
    spawnStage(assignment) {
      if (children.has(assignment.taskId)) {
        return { ok: false, why: 'по этой задаче уже идёт этап' };
      }
      if (children.size >= config.maxConcurrent) {
        return { ok: false, why: 'все места заняты' };
      }

      // Идентификатор выдаётся заранее, а не берётся из ответа: тогда
      // возобновлять есть что даже после падения супервизора.
      const sessionId = assignment.sessionId ?? randomUUID();
      const command = stageCommand({
        assignment: { ...assignment, sessionId },
        prompt: stagePrompt({
          assignment,
          task: assignment.task,
          journal: assignment.journal,
          board: assignment.board,
          // Разбору дают лог того этапа, из которого задача упала. Его имя
          // хранит сама задача — состоянием возврата, — и потому спрашивается
          // здесь, а не угадывается по журналу.
          stageLog:
            assignment.stage === 'postmortem'
              ? readStageLog(assignment.taskId, assignment.task?.returnTo)
              : null,
        }),
        config,
        root,
      });

      let handle;
      try {
        handle = spawnStageProcess({
          command,
          timeoutMs: stageTimeoutMs(assignment.stage, config),
          spawn,
          killTree,
        });
      } catch (error) {
        return { ok: false, why: error.message };
      }

      known[key(assignment.taskId, assignment.stage)] = sessionId;
      saveStages(known);

      const child = {
        taskId: assignment.taskId,
        stage: assignment.stage,
        sessionId,
        startedAt: now(),
        handle,
      };
      children.set(assignment.taskId, child);

      log(
        `этап ${assignment.taskId}:${assignment.stage} запущен` +
          `${assignment.continuation ? ' возобновлением' : ''}, процесс ${handle.pid}`,
      );

      // Разбор исхода не должен уронить супервизор: он ведёт все задачи,
      // и падение на одном отчёте остановило бы конвейер целиком.
      handle.finished.then((run) => {
        try {
          finish(child, run);
        } catch (error) {
          children.delete(child.taskId);
          log(`разбор исхода ${child.taskId}:${child.stage} упал: ${error.message}`);
        }
      });
      return { ok: true, sessionId, pid: handle.pid };
    },

    /** Снять все идущие этапы: остановка супервизора. */
    stopAll() {
      for (const child of children.values()) child.handle.kill();
    },

    /** Дождаться, пока идущие этапы кончатся. */
    async settle() {
      await Promise.all([...children.values()].map((child) => child.handle.finished));
    },
  };

  /**
   * Что делать с кончившимся этапом.
   *
   * Три исхода, и все три разные. Отчёт есть — в очередь на перенос. Снят
   * по сроку — ничего: следующий оборот увидит этап без процесса и выдаст
   * продолжение, а идентификатор сессии уже запомнен. Отказ — в журнал,
   * и то же продолжение.
   */
  function finish(child, run) {
    children.delete(child.taskId);

    const answer = readAnswer(run);
    writeStageLog(child.taskId, child.stage, renderLog(child, run, answer));

    // Идентификатор из ответа точнее выданного: приложение вправе завести
    // свой, и возобновлять надо именно его.
    if (answer.sessionId) {
      known[key(child.taskId, child.stage)] = answer.sessionId;
      saveStages(known);
    }

    if (answer.outcome !== 'done') {
      log(`этап ${child.taskId}:${child.stage} не доведён: ${answer.why}`);
      return;
    }

    // Отказанное действие — это не мелочь в журнале. Прежде неразрешённое
    // действие вешало сессию насмерть: беда была заметной. Теперь оно даёт
    // отказ, и этап тихо докладывает об успехе, часть которого ему
    // не позволили сделать. Заметность приходится возвращать правилом.
    if (answer.denials.length > 0) {
      for (const denial of answer.denials) {
        log(
          `этап ${child.taskId}:${child.stage}: отказано ${denial.tool_name} — ` +
            `${JSON.stringify(denial.tool_input)}`,
        );
      }
      log(
        `отчёт ${child.taskId}:${child.stage} не принят: этап отчитался об успехе ` +
          'при отказанных действиях, нужен разбор человеком',
      );
      return;
    }

    const parsed = parseReport(answer.result);
    if (!parsed.report) {
      log(`отчёт ${child.taskId}:${child.stage} не разобрался: ${parsed.why}; вывод в журнале`);
      return;
    }

    // Отчёт о ЧУЖОМ этапе не применяется: он посчитан по другой картине
    // мира, и молча применить его значит двинуть задачу неизвестно куда.
    if (parsed.report.stage !== child.stage) {
      log(
        `отчёт ${child.taskId} говорит об этапе «${parsed.report.stage}», ` +
          `а шёл «${child.stage}» — не принят`,
      );
      return;
    }

    reports.push({ ...parsed.report, taskId: child.taskId });
    log(`этап ${child.taskId}:${child.stage} закончен с исходом ${parsed.report.outcome}`);
  }
}

/** Вывод процесса целиком плюс то, чего в нём нет: срок, стоимость, отказы. */
function renderLog(child, run, answer) {
  const head = [
    `задача:    ${child.taskId}`,
    `этап:      ${child.stage}`,
    `сессия:    ${answer.sessionId ?? child.sessionId}`,
    `начат:     ${child.startedAt}`,
    `процесс:   ${child.handle.pid}`,
    `код:       ${run.code}`,
    `снят:      ${run.killedBy ?? 'нет'}`,
    `исход:     ${answer.outcome}${answer.why ? ` (${answer.why})` : ''}`,
    `ходов:     ${answer.turns ?? '—'}`,
    `стоимость: ${answer.cost ?? '—'}`,
    `отказов:   ${answer.denials.length}`,
  ];
  return [
    ...head,
    '',
    '--- отказанные действия ---',
    JSON.stringify(answer.denials, null, 2),
    '',
    '--- stdout ---',
    run.stdout ?? '',
    '',
    '--- stderr ---',
    run.stderr ?? '',
    '',
  ].join('\n');
}
