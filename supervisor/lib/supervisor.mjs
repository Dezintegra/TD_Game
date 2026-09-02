import { randomUUID } from 'node:crypto';
import { clearInterval as nodeClearInterval, setInterval as nodeSetInterval } from 'node:timers';
import { TAG, clip, describeEvent, humanDuration } from './console.mjs';
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
  /** Каталог самого инструмента. От него считаются его собственные пути. */
  home = root,
  spawn,
  killTree,
  /**
   * Опрос системы о процессе по номеру: `(pid) => { known, alive, image }`.
   * Приходит доводом наравне с порождением и снятием — тогда сироты
   * проверяются за миллисекунды и без единого живого процесса.
   */
  probe = null,
  /**
   * Имя станции и номер собственного процесса. Доводами, а не чтением
   * `node:os` внутри: счётная часть супервизора уже принимает так же
   * и часы, и порождение.
   */
  machine = null,
  supervisorPid = null,
  now = () => new Date().toISOString(),
  /** Часы в миллисекундах: длительности считаются ими, а не разбором строк. */
  nowMs = () => Date.now(),
  saveStages = () => {},
  stages = {},
  log = () => {},
  writeStageLog = () => {},
  readStageLog = () => null,
  /** Рассказчик. По умолчанию немой: счётная часть обязана работать и без него. */
  say = { line: () => {} },
  setPulse = nodeSetInterval,
  clearPulse = nodeClearInterval,
}) {
  /** Живые этапы: `taskId` → дескриптор. */
  const children = new Map();
  /** Отчёты, дождавшиеся переноса в бэклог. Их читает `io`. */
  const reports = [];
  /**
   * Память об этапах: `taskId:stage` → `{ sessionId, startedAt, live }`.
   * Переживает перезапуск супервизора.
   *
   * `live` — дескриптор идущего процесса. Он и есть всё изменение: пока
   * живость жила единственным экземпляром в памяти, преемник, взявший замок,
   * не видел ни одного этапа, порождённого прежним супервизором, — и выдавал
   * живому этапу продолжение, заводя второй процесс на его рабочем дереве.
   */
  const known = Object.fromEntries(
    Object.entries(stages).map(([at, value]) => [at, remembered(value)]),
  );
  /** Часы пульса. Заводятся с первым этапом и снимаются с последним. */
  let pulseTimer = null;

  const key = (taskId, stage) => `${taskId}:${stage}`;

  return {
    reports,

    /** Идущие этапы для сканера: вся картина живости, какая есть. */
    running: () => [...children.values()].map(({ taskId, stage }) => ({ taskId, stage })),

    /** Идентификатор сессии прошлого захода на этот этап, если он был. */
    lastSession: (taskId, stage) => known[key(taskId, stage)]?.sessionId ?? null,

    /**
     * Когда на этот этап зашли ПЕРВЫЙ раз.
     *
     * Этим отличают свежий коммит от чужого, и потому отметка не двигается
     * продолжением: продолжатель приходит к уже сделанным коммитам и объявил
     * бы их чужими. Отметки нет — значит сверять нечем, и это верный ответ,
     * а не поломка: так выглядит первый запуск после обновления, когда файл
     * лежит в прежней раскладке.
     */
    stageStartedAt: (taskId, stage) => known[key(taskId, stage)]?.startedAt ?? null,

    /**
     * Забыть сессию этапа: следующий заход начнётся с чистого листа.
     *
     * Нужно там, где задачу вернули на пройденный этап. Возобновлённая сессия
     * помнит свой прошлый вывод и отвечает из него — «всё сделано», — не читая
     * замечания, ради которого её и позвали. Проверено 31.08.2026: четыре
     * круга подряд на неизменной вершине, тридцать секунд на круг.
     *
     * Стирается запись ЦЕЛИКОМ, вместе с отметкой начала. Возврат начинает
     * этап заново, и коммиты прошлого захода для него действительно чужие.
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
     *
     * Отказ несёт разбираемую причину `reason`: `'busy'` — мест нет либо
     * по задаче уже идёт этап, `'not-born'` — процесс породить не удалось.
     * Поле заведено вместо разбора текста `why`: сравнение русских строк
     * между двумя файлами превратило бы правку формулировки в журнале
     * в молчаливую подмену тесноты поломкой.
     */
    spawnStage(assignment) {
      if (children.has(assignment.taskId)) {
        return { ok: false, reason: 'busy', why: 'по этой задаче уже идёт этап' };
      }
      if (children.size >= config.maxConcurrent) {
        return { ok: false, reason: 'busy', why: 'все места заняты' };
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
        home,
      });

      // Дескриптор заводится ДО порождения: обработчики событий пишут
      // в него ходы и последнее действие, а пульс их оттуда читает.
      const timeoutMs = stageTimeoutMs(assignment.stage, config);
      const child = {
        taskId: assignment.taskId,
        stage: assignment.stage,
        sessionId,
        startedAt: now(),
        startedMs: nowMs(),
        timeoutMs,
        // Событий ассистента, а не ходов. Различие не педантизм: приложение
        // считает ходы по-своему и в итоговом событии даёт другое число —
        // проба 01.09.2026 дала восемь против пяти. Одно слово с двумя
        // разными числами в соседних строках читателя обманывает.
        steps: 0,
        last: null,
        handle: null,
      };

      try {
        child.handle = spawnStageProcess({
          command,
          timeoutMs,
          spawn,
          killTree,
          onEvent: (event, line) => watch(child, event, line),
          // Поток ошибок печатается всегда: там появляются предупреждения
          // самого приложения, к отчёту не относящиеся, — и именно они
          // объясняют половину странных исходов.
          onStderr: (line) => say.line(TAG.warn, `${child.taskId} ⚠ ${clip(line, 200)}`),
        });
      } catch (error) {
        return { ok: false, reason: 'not-born', why: error.message };
      }
      const handle = child.handle;

      // Родился — значит есть номер процесса. `spawn` на несуществующую
      // команду возвращает объект без номера, а ошибку присылает событием
      // позже, отдельным ходом цикла событий: отсюда «этап запущен, процесс
      // undefined» в журнале и `spawn claude ENOENT` следом (02.09.2026,
      // задача 0088). Дожидаться события нельзя — порождение обязано вернуть
      // управление немедленно, — а вот распознать случай синхронно можно.
      //
      // Проверка стоит ДО памяти о сессии намеренно: запомненный
      // идентификатор незаведённой сессии увёл бы следующее продолжение
      // на возобновление того, чего не было, и оно умерло бы за секунды
      // с ответом «сессии с таким идентификатором нет».
      if (!handle?.pid) {
        return { ok: false, reason: 'not-born', why: 'процесс не родился: номера у него нет' };
      }

      // Отметка начала ставится один раз и переживает продолжения: она
      // отвечает на вопрос «этот ли заход сделал коммит», а продолжатель
      // приходит к чужим с его точки зрения коммитам.
      const at = key(assignment.taskId, assignment.stage);
      known[at] = {
        sessionId,
        startedAt: known[at]?.startedAt ?? now(),
        // Дескриптор ложится на диск ТЕМ ЖЕ действием, что и память о сессии:
        // обе записи об одном процессе, и разъехаться им нельзя. Отдельный
        // файл дал бы второе место, где можно забыть стереть.
        live: describeLive(handle.pid, timeoutMs, assignment),
      };
      saveStages(known);

      children.set(assignment.taskId, child);
      startPulse();

      log(
        `этап ${assignment.taskId}:${assignment.stage} запущен` +
          `${assignment.continuation ? ' возобновлением' : ''}, процесс ${handle.pid}`,
      );

      // Отдельной строкой и с полным составом: это ответ на вопрос «какая
      // задача идёт прямо сейчас», ради которого за консолью и следят.
      say.line(
        TAG.task,
        `${assignment.taskId} → ${assignment.stage}` +
          `${assignment.continuation ? ' (возобновление)' : ''}` +
          `, срок ${humanDuration(timeoutMs)}, процесс ${handle.pid}` +
          `${assignment.path ? `, дерево ${assignment.path}` : ''}`,
      );
      if (assignment.reason)
        say.line(TAG.task, `${assignment.taskId}   зачем: ${clip(assignment.reason, 140)}`);

      // Разбор исхода не должен уронить супервизор: он ведёт все задачи,
      // и падение на одном отчёте остановило бы конвейер целиком.
      handle.finished.then((run) => {
        try {
          finish(child, run);
        } catch (error) {
          children.delete(child.taskId);
          stopPulse();
          log(`разбор исхода ${child.taskId}:${child.stage} упал: ${error.message}`);
          say.line(TAG.error, `${child.taskId} разбор исхода упал: ${error.message}`);
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

    /** Напечатать состояние идущих этапов сейчас же. Ею и бьётся пульс. */
    pulse,
  };

  /**
   * Пересказать событие этапа.
   *
   * Итоговое событие сюда не попадает: его печатает завершение, где известны
   * и длительность, и стоимость, и отказы.
   */
  function watch(child, event, line) {
    if (event?.type === 'result') return;
    if (event?.type === 'assistant') child.steps += 1;

    const said = describeEvent(event);
    if (said.length === 0) {
      // Строка, не разобравшаяся в событие, — это чужой вывод в общий поток:
      // предупреждение менеджера пакетов и тому подобное. Печатаем его, но
      // обрывок JSON — нет: он ничего не значит без своего целого.
      if (!event && line && !line.trimStart().startsWith('{')) {
        say.line(TAG.stage, `${child.taskId} ${clip(line, 160)}`);
      }
      return;
    }

    child.last = said.at(-1);
    say.line(
      TAG.stage,
      said.map((one) => `${child.taskId} ${one}`),
    );
  }

  /**
   * Дескриптор живого этапа: чем он опознаётся и по чему судится.
   *
   * Опознание спрашивается у системы прямо здесь, при рождении процесса,
   * а не выводится из настройки. Причина в том, что `claudeCommand` равно
   * `claude`, на Windows это обёртка `.cmd`, и образ живого процесса ей
   * не равен: сверка с настройкой давала бы несовпадение всегда, то есть
   * тихо выключила бы всю проверку.
   *
   * Отметки времени две, и обе нужны. Строкой — для записи в журнал задачи,
   * которую будет читать человек; числом — для счёта срока, чтобы не
   * разбирать строку и не гадать, что делать с неразобравшейся. Так же
   * устроен и дескриптор собственного ребёнка.
   */
  function describeLive(pid, timeoutMs, assignment) {
    const live = {
      pid,
      machine,
      supervisorPid,
      startedAt: now(),
      startedMs: nowMs(),
      timeoutMs,
    };

    const seen = ask(pid);
    if (seen.known && seen.image) return { ...live, image: seen.image };

    // Дескриптор без опознания — законная запись, а не поломка: судьба
    // такого сироты разобрана отдельно («жив, но неопознан»), и снимать
    // его нельзя ни при каких условиях. Молчать об этом всё же нельзя:
    // из журнала цикла видно, что опрос системы не работает вовсе.
    log(
      `дескриптор ${assignment.taskId}:${assignment.stage} записан без опознания процесса ` +
        `${pid}: ${probe ? 'спросить систему не удалось' : 'опрос системы не передан'}`,
    );
    return live;
  }

  /**
   * Спросить систему о процессе, не дав ей уронить супервизор.
   *
   * Неудача опроса — это «спросить не удалось», а НЕ «процесса нет»: первое
   * оставляет этап идущим до его срока, второе отпускает рабочее дерево.
   */
  function ask(pid) {
    if (!probe) return { known: false, alive: false, image: null };
    try {
      return probe(pid) ?? { known: false, alive: false, image: null };
    } catch {
      return { known: false, alive: false, image: null };
    }
  }

  /** Состояние каждого живого этапа: сколько идёт, сколько осталось, чем занят. */
  function pulse() {
    for (const child of children.values()) {
      const ran = nowMs() - child.startedMs;
      const left = child.startedMs + child.timeoutMs - nowMs();
      say.line(
        TAG.pulse,
        `${child.taskId} ${child.stage}: идёт ${humanDuration(ran)} из ${humanDuration(child.timeoutMs)}` +
          `, до срока ${humanDuration(left)}, событий ${child.steps}` +
          `${child.last ? `; последнее — ${clip(child.last, 90)}` : '; пока молчит'}`,
      );
    }
  }

  function startPulse() {
    if (pulseTimer || !config.pulseSeconds) return;
    pulseTimer = setPulse(pulse, config.pulseSeconds * 1000);
    // Часы пульса не должны сами по себе удерживать процесс супервизора
    // живым: этап может кончиться за минуту, а супервизор — ждать сигнала.
    pulseTimer?.unref?.();
  }

  function stopPulse() {
    if (!pulseTimer || children.size > 0) return;
    clearPulse(pulseTimer);
    pulseTimer = null;
  }

  /**
   * Что делать с кончившимся этапом.
   *
   * Три исхода, и все три разные. Отчёт есть — в очередь на перенос. Снят
   * по сроку — ничего: следующий оборот увидит этап без процесса и выдаст
   * продолжение, а идентификатор сессии уже запомнен. Отказанные действия
   * называются в журнале цикла и едут вместе с отчётом: судит их перенос,
   * которому доступен и разобранный отчёт, и git.
   */
  function finish(child, run) {
    children.delete(child.taskId);
    stopPulse();

    const answer = readAnswer(run);
    writeStageLog(child.taskId, child.stage, renderLog(child, run, answer));

    // Итог этапа одной строкой: то, ради чего человек и смотрит в консоль,
    // отойдя на час. В журнале этапа то же самое есть подробнее, но журнал
    // надо открыть, а строку видно сразу.
    say.line(
      answer.outcome === 'done' ? TAG.stage : TAG.warn,
      `${child.taskId} ${child.stage} завершён: ${answer.outcome}` +
        `${answer.why ? ` — ${answer.why}` : ''}` +
        `, ${humanDuration(nowMs() - child.startedMs)}` +
        `, ходов ${answer.turns ?? '—'}` +
        `, стоимость ${answer.cost != null ? `$${answer.cost.toFixed(2)}` : '—'}` +
        `, отказов ${answer.denials.length}`,
    );

    // Дескриптор стирается при ЛЮБОМ исходе — отчётом, отказом, снятием
    // по сроку, — потому что процесса больше нет, а дескриптор говорит
    // ровно о нём. Оставленный, он объявил бы задачу занятой навсегда.
    //
    // Идентификатор из ответа точнее выданного: приложение вправе завести
    // свой, и возобновлять надо именно его. Обе правки — одной записью:
    // разделив их, мы получили бы миг, в котором на диске лежит дескриптор
    // мёртвого процесса.
    const at = key(child.taskId, child.stage);
    if (known[at]) {
      const kept = { ...known[at] };
      delete kept.live;
      known[at] = answer.sessionId ? { ...kept, sessionId: answer.sessionId } : kept;
      saveStages(known);
    }

    if (answer.outcome !== 'done') {
      log(`этап ${child.taskId}:${child.stage} не доведён: ${answer.why}`);
      return;
    }

    // Отказанное действие называется в журнале цикла целиком: по доводам
    // вызова видно, какое правило разрешений не дописано.
    //
    // А вот СУДИТЬ по одному лишь наличию отказов супервизор больше не
    // берётся, и это не послабление. Здесь отчёт ещё не разобран: неизвестны
    // ни исход, ни ссылки — то есть ровно то, чем след этапа и проверяется.
    // Суд получался вслепую и потому не мог не быть грубым: вечер 31.08.2026
    // дал шесть отброшенных отчётов подряд, и ни один не потерян из-за
    // настоящей беды. Перечень едет в отчёт полем `denials`, а разбирает его
    // `execute.transferReport`, где есть и разобранный отчёт, и git.
    for (const denial of answer.denials) {
      log(
        `этап ${child.taskId}:${child.stage}: отказано ${denial.tool_name} — ` +
          `${JSON.stringify(denial.tool_input)}`,
      );
      say.line(
        TAG.warn,
        `${child.taskId} отказано ${denial.tool_name}: ${clip(JSON.stringify(denial.tool_input), 140)}`,
      );
    }

    const parsed = parseReport(answer.result);
    if (!parsed.report) {
      log(`отчёт ${child.taskId}:${child.stage} не разобрался: ${parsed.why}; вывод в журнале`);
      say.line(TAG.warn, `${child.taskId} отчёт не разобрался: ${clip(parsed.why, 140)}`);
      return;
    }

    // Отчёт о ЧУЖОМ этапе не применяется: он посчитан по другой картине
    // мира, и молча применить его значит двинуть задачу неизвестно куда.
    if (parsed.report.stage !== child.stage) {
      log(
        `отчёт ${child.taskId} говорит об этапе «${parsed.report.stage}», ` +
          `а шёл «${child.stage}» — не принят`,
      );
      say.line(
        TAG.warn,
        `${child.taskId} отчёт о чужом этапе «${parsed.report.stage}» — не принят`,
      );
      return;
    }

    // Отказы едут ВМЕСТЕ с отчётом: судить их будет перенос, и своего
    // источника у него нет — процесс к тому времени давно закрыт.
    reports.push({ ...parsed.report, taskId: child.taskId, denials: answer.denials });
    log(`этап ${child.taskId}:${child.stage} закончен с исходом ${parsed.report.outcome}`);
  }
}

/**
 * Привести запись об этапе к нынешней раскладке.
 *
 * Прежде значением была голая строка — идентификатор сессии. Читать её
 * обязательно: супервизор перезапускают сторожем, и первый же запуск после
 * обновления придёт к файлу прежнего вида. Отметки начала в нём нет, и это
 * честный ответ «сверять нечем», а не поломка.
 *
 * Дескриптор живого этапа переносится как есть. Его отсутствие означает
 * «этап не идёт» — тоже честный ответ, а не поломка: так выглядит и память
 * о законченном этапе, и файл прежней раскладки.
 */
function remembered(value) {
  if (typeof value === 'string') return { sessionId: value, startedAt: null };
  const kept = {
    sessionId: value?.sessionId ?? null,
    startedAt: value?.startedAt ?? null,
  };
  return value?.live ? { ...kept, live: value.live } : kept;
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
