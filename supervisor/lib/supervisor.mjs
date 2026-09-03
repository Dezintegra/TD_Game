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
   * Исходы осиротевших этапов, дождавшиеся записи в журнал задачи.
   *
   * Очередь по образцу `reports`, и по той же причине: писать на доску вправе
   * только исполнение решений, а супервизор — хозяин процессов, и второго пути
   * к доске у него быть не должно.
   */
  const orphanOutcomes = [];
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
  /**
   * Осиротевшие этапы: `taskId` → `{ taskId, stage, at, live }`.
   *
   * Сирота — этап, чей дескриптор прочитан с диска, а породил его не этот
   * супервизор. Живой сирота ничем не отличается от собственного ребёнка
   * с точки зрения счёта: место занято, сессия не выдаётся, второй процесс
   * на его рабочем дереве не заводится.
   */
  const orphans = new Map();
  /** Часы пульса. Заводятся с первым этапом и снимаются с последним. */
  let pulseTimer = null;

  const key = (taskId, stage) => `${taskId}:${stage}`;

  adoptOrphans();

  return {
    reports,
    orphanOutcomes,

    /**
     * Обойти сирот: кто кончился, кто оказался посторонним, кто пережил срок.
     *
     * Зовётся раз в оборот, до чтения `running()`. Отдельно от сборки потому,
     * что сирота живёт минутами и часами: судить его один раз при запуске
     * значило бы держать его в перечне идущих до самого конца супервизора.
     */
    sweep,

    /**
     * Забыть исход сироты: он записан в журнал задачи, дескриптор больше
     * не нужен.
     *
     * Стирание идёт ПОСЛЕ удавшейся записи, а не до неё. Обрыв между ними
     * оставляет дескриптор на диске, и следующий оборот пробует снова:
     * повторная запись стоит одного лишнего комментария, потерянная —
     * необъяснимого провала в журнале задачи.
     */
    forgetOrphan(taskId, stage) {
      const at = orphanOutcomes.findIndex((item) => item.taskId === taskId && item.stage === stage);
      if (at === -1) return false;
      const [outcome] = orphanOutcomes.splice(at, 1);
      forget(outcome.at);
      return true;
    },

    /**
     * Идущие этапы для сканера: вся картина живости, какая есть.
     *
     * Собственные дети и живые сироты идут одним перечнем намеренно. Все
     * четыре трактовки живости в сканере — негодная карточка, хвост ветки,
     * выдача сессии, счёт мест — для сироты верны дословно, и особый случай
     * там означал бы, что сирота не то же самое, что идущий этап. А он то же.
     */
    running: () => [
      ...[...children.values()].map(({ taskId, stage }) => ({ taskId, stage })),
      ...[...orphans.values()].map(({ taskId, stage }) => ({ taskId, stage })),
    ],

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

    /** Сколько этапов идёт прямо сейчас — вместе с осиротевшими. */
    busy: () => children.size + orphans.size,

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
      // Живой сирота держит задачу так же, как собственный ребёнок. Без этой
      // проверки на его рабочем дереве завёлся бы второй процесс — ровно то,
      // ради отмены чего дескриптор и кладётся на диск.
      if (orphans.has(assignment.taskId)) {
        return {
          ok: false,
          reason: 'busy',
          why: 'по этой задаче идёт этап, осиротевший при смене супервизора',
        };
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

    /**
     * Снять все идущие этапы: остановка супервизора.
     *
     * Своих детей — и только их. Сироту супервизор снял бы, не сумев записать
     * исход: очередь исходов в этот миг исполнять уже некому, доска
     * закрывается вместе с оборотом. Вышла бы ровно та потеря, из-за которой
     * всё изменение и затеяно, только сделанная своими руками.
     *
     * Оставленный сирота ничего не теряет: дескриптор лежит на диске,
     * и следующий супервизор судит его тем же правилом. Плата названа честно —
     * рабочее дерево остаётся занятым до конца сироты.
     */
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
   * Подобрать сирот из прочитанного с диска состояния.
   *
   * Всякая запись с дескриптором — сирота: собственных детей у супервизора
   * в этот миг нет вовсе, а дескриптор пишется при рождении процесса
   * и стирается при его конце. Значит он остался от прежнего супервизора,
   * и вопрос ровно один — жив ли ещё тот процесс.
   *
   * Дескриптор чужой станции не судится: местное хранилище состояния можно
   * скопировать, а номер процесса с другой машины здесь не значит ничего —
   * его вполне мог занять кто угодно.
   */
  function adoptOrphans() {
    let changed = false;
    for (const [at, value] of Object.entries(known)) {
      if (!value?.live) continue;

      if (machine && value.live.machine && value.live.machine !== machine) {
        log(
          `дескриптор ${at} записан станцией «${value.live.machine}», а мы «${machine}»: ` +
            'не судим и стираем — номер процесса чужой машины здесь ничего не значит',
        );
        delete value.live;
        changed = true;
        continue;
      }

      const cut = at.lastIndexOf(':');
      orphans.set(at.slice(0, cut), {
        taskId: at.slice(0, cut),
        stage: at.slice(cut + 1),
        at,
        live: value.live,
      });
    }
    if (changed) saveStages(known);
    sweep();
  }

  /**
   * Обойти сирот и развести их по исходам.
   *
   * Живость сироты — конъюнкция: номер существует И опознание совпало
   * с записанным. Одного номера мало: система их переиспользует.
   *
   * Снятие делается ровно в одном случае — процесс опознан и пережил
   * записанный ему срок. Всё прочее остаётся жить: цена ошибочного снятия
   * поддеревом на рабочей станции несоизмерима с ценой лишнего ожидания
   * длиной в один срок этапа.
   */
  function sweep() {
    for (const orphan of [...orphans.values()]) {
      const verdict = judgeOrphan(orphan);

      if (verdict === 'gone') {
        release(orphan, 'gone', 'процесс кончился сам, а исход его записать было некому');
        continue;
      }
      if (verdict === 'stale') {
        release(
          orphan,
          'stale',
          'номер процесса занял посторонний: дескриптор протух, ' +
            'сам процесс не снят — он не наш',
        );
        continue;
      }

      const ran = ranMs(orphan.live);
      const overdue = ran === null || ran >= (orphan.live.timeoutMs ?? 0);
      if (!overdue) {
        // Неопознанный называется в журнале цикла один раз, а не каждый
        // оборот: строка, повторяющаяся раз в пять минут, перестаёт читаться.
        if (verdict === 'unidentified' && !orphan.noted) {
          orphan.noted = true;
          log(
            `этап ${orphan.at} осиротел и не опознаётся (процесс ${orphan.live.pid}): ` +
              'числится идущим до своего срока, снят не будет ни при каких условиях',
          );
        }
        continue;
      }

      if (verdict === 'ours' && ran !== null) {
        killTree(orphan.live.pid);
        release(orphan, 'killed', 'снят по истечении своего срока вместе со всем поддеревом');
        continue;
      }

      // Неопознанный за сроком уходит из перечня, но НЕ снимается: под его
      // номером может работать что угодно, а `taskkill /T /F` уносит целое
      // дерево процессов рабочей станции.
      release(
        orphan,
        'left',
        ran === null
          ? 'срок сверить нечем: отметки начала в дескрипторе нет, процесс оставлен работать'
          : 'срок вышел, но опознать процесс не удалось — оставлен работать',
      );
    }
  }

  /** Сколько миллисекунд идёт процесс. `null` — сверить нечем. */
  function ranMs(live) {
    const from = Number.isFinite(live.startedMs) ? live.startedMs : Date.parse(live.startedAt);
    return Number.isFinite(from) ? nowMs() - from : null;
  }

  /**
   * Отпустить сироту: он больше не идущий этап.
   *
   * Дескриптор при этом НЕ стирается — исход встаёт в очередь, и стереть его
   * можно будет лишь после того, как исход ляжет в журнал задачи. Молчаливое
   * исчезновение запрещено: отчёт такого этапа потерян вместе с прежним
   * супервизором, и журнал задачи — единственное место, где следующая сессия
   * и разбор узнают, почему прошлый заход не дал ничего.
   */
  function release(orphan, outcome, why) {
    orphans.delete(orphan.taskId);
    orphanOutcomes.push({
      taskId: orphan.taskId,
      stage: orphan.stage,
      at: orphan.at,
      pid: orphan.live.pid,
      startedAt: orphan.live.startedAt,
      timeoutMs: orphan.live.timeoutMs,
      outcome,
      why,
    });
    log(`этап ${orphan.at} осиротел при смене супервизора: ${why} (процесс ${orphan.live.pid})`);
  }

  /**
   * Что стало с осиротевшим процессом. Исходов четыре, и путать их дорого:
   *
   * - `gone`         — процесса с таким номером нет; этап кончился;
   * - `ours`         — номер есть, и опознание совпало с записанным;
   * - `stale`        — номер есть, но опознание другое: номер переиспользован;
   * - `unidentified` — спросить не удалось либо опознания нет в дескрипторе.
   *
   * Последний исход — не разновидность первого, и в этом всё дело. Объявив
   * неопознанного исчезнувшим, мы выдали бы продолжение живому этапу
   * и завели бы второй процесс на его рабочем дереве.
   */
  function judgeOrphan(orphan) {
    const seen = ask(orphan.live.pid);
    if (seen.known && !seen.alive) return 'gone';
    if (!seen.known || !orphan.live.image) return 'unidentified';
    return seen.image === orphan.live.image ? 'ours' : 'stale';
  }

  /** Стереть дескриптор с диска: процесса, о котором он говорил, больше нет. */
  function forget(at) {
    if (!known[at]?.live) return;
    delete known[at].live;
    saveStages(known);
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
    // Отчёт разбирается ЗДЕСЬ, а не там, где он применяется, — потому что
    // ниже по этой функции три досрочных возврата, а лог обязан лечь на диск
    // раньше каждого из них: как раз в тех случаях, ради которых лог и пишут,
    // он единственное, что осталось от сессии.
    //
    // Разбор остаётся однократным. Второй вызов внутри `renderLog` был бы
    // дешевле на вид и хуже по существу: два источника истины об исходе этапа
    // расходятся молча, а сходятся на разборе падения, которого никто
    // не поймёт.
    //
    // Ответа может не быть вовсе — снятие по сроку, несостоявшийся запуск.
    // Тогда `answer.result` равен `null`, разбор берёт `String(text ?? '')`,
    // получает пустую строку и возвращает `{ report: null, why }`. Исключений
    // он не бросает, защиты не требует.
    const parsed = parseReport(answer.result);
    writeStageLog(child.taskId, child.stage, renderLog(child, run, answer, parsed));

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

/**
 * Чем кончился ЭТАП — по его же отчёту, а не по коду возврата процесса.
 *
 * Отчёта может не быть, и тогда это не пропуск, а улика: разбору падения
 * важно, чем именно отчёт не стал. Случая два, и они различаются намеренно.
 * Ответа нет вовсе (`answer.result == null`: снятие по сроку, несостоявшийся
 * запуск) — про такую сессию «в ответе нет ни одного объекта JSON» было бы
 * формально верно и по смыслу вздорно: читатель пошёл бы искать испорченный
 * отчёт там, где его не начинали писать.
 */
function reportOutcome(child, answer, parsed) {
  if (!parsed.report) {
    return answer.result == null
      ? 'отчёта нет — сессия ответа не оставила'
      : `отчёта нет — ${parsed.why}`;
  }
  // Отчёт о чужом этапе к задаче не применялся вовсе, и слова «не применён»
  // здесь обязательны: без них шапка сообщала бы исход, которого задача
  // не получала, — то есть ровно ту же ложь, только в новом поле.
  if (parsed.report.stage !== child.stage) {
    return (
      `${parsed.report.outcome} (отчёт об этапе «${parsed.report.stage}», ` +
      `а шёл «${child.stage}» — не применён)`
    );
  }
  return parsed.report.outcome;
}

/**
 * Вывод процесса целиком плюс то, чего в нём нет: срок, стоимость, отказы.
 *
 * Два поля вместо одного «исхода», и это не педантизм. Ответ сессии говорит
 * о ПРОЦЕССЕ: `done` у него значит «отработал и вернул разбираемый ответ»,
 * и вместе со словом он несёт причину (`answer.why`), которой в отчёте нет
 * и быть не может. Исход отчёта говорит об ЭТАПЕ. Слова `исход` в шапке
 * не остаётся ни в каком виде: знакомое остановило бы читателя раньше, чем
 * он дошёл до нужного поля.
 *
 * Колонку значений задаёт самое длинное имя — сегодня это `ответ сессии:`.
 */
function renderLog(child, run, answer, parsed) {
  const head = [
    `задача:        ${child.taskId}`,
    `этап:          ${child.stage}`,
    `сессия:        ${answer.sessionId ?? child.sessionId}`,
    `начат:         ${child.startedAt}`,
    `процесс:       ${child.handle.pid}`,
    `код:           ${run.code}`,
    `снят:          ${run.killedBy ?? 'нет'}`,
    `ответ сессии:  ${answer.outcome}${answer.why ? ` (${answer.why})` : ''}`,
    `исход отчёта:  ${reportOutcome(child, answer, parsed)}`,
    `ходов:         ${answer.turns ?? '—'}`,
    `стоимость:     ${answer.cost ?? '—'}`,
    `отказов:       ${answer.denials.length}`,
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
