import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';

/**
 * Хозяин у процесса этапа.
 *
 * Всё изменение затевалось ради этого файла. Прежде этап был сессией,
 * порождённой планировщиком: у неё не было ни срока, ни кода возврата,
 * и упёршись в запрос подтверждения, она не завершалась никогда. Планировщик
 * умеет лишь не начинать следующий прогон — то есть не умеет ничего.
 *
 * Дескриптор ребёнка даёт всё сразу: срок, снятие и исход. Ничего умнее
 * не требуется, и весь прежний слой признаков живости — снимок сессий,
 * отметка активности, признак «идёт» — существовал ровно потому, что этого
 * дескриптора не было.
 *
 * Порождение и снятие приходят доводами. Не ради чистоты: живой запуск
 * стоит десяток секунд и денег, и проверять на нём срок, ошибку запуска
 * и разбор ответа значило бы не проверять их вовсе.
 */

/**
 * Запустить этап и держать его.
 *
 * Возвращает управление сразу: супервизор обязан продолжать цикл, пока
 * этап идёт. Ждут его через `finished`.
 *
 * @param {object} params
 * @param {{program:string,args:string[],cwd:string}} params.command
 * @param {number} params.timeoutMs   срок, по истечении которого этап снимают
 * @param {Function} params.spawn     порождение процесса
 * @param {Function} params.killTree  снятие поддерева процессов
 * @param {Function} [params.onEvent]  событие потока: разобранный объект либо
 *                                     `null` и сырая строка, если не разобралось
 * @param {Function} [params.onStderr] строка, пришедшая в поток ошибок
 * @param {Function} [params.setTimer]
 * @param {Function} [params.clearTimer]
 * @returns {{ pid, finished: Promise<object>, kill: Function }}
 */
export function startStage({
  command,
  timeoutMs,
  spawn,
  killTree,
  onEvent = () => {},
  onStderr = () => {},
  setTimer = nodeSetTimeout,
  clearTimer = nodeClearTimeout,
}) {
  const child = spawn(command.program, command.args, { cwd: command.cwd });

  // Промпт подаётся на вход, а не аргументом: длина аргументов на Windows
  // ограничена, и назначение растущей задачи однажды перестаёт в неё влезать
  // (`spawn ENAMETOOLONG`, двадцать шесть раз за 01.09.2026).
  //
  // Ввод обязательно закрывается: приложение ждёт конца потока и без него
  // простоит до истечения срока этапа, ничего не сделав. Ошибку записи ловим
  // отдельно — оборванный канал не должен ронять супервизор целиком, этап
  // и без промпта завершится сам, а его исход разберут как обычно.
  if (command.stdin != null && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(command.stdin);
  }

  let stdout = '';
  let stderr = '';

  // Вывод копится целиком — он уезжает в журнал этапа, — и одновременно
  // режется на строки для наблюдения. Одно другому не замена: журнал
  // читают потом и полностью, а консоль смотрят сейчас и выборочно.
  //
  // Резать приходится с остатком: кусок приходит по мере готовности сокета
  // и обрывается посреди строки где угодно. Разбирать куски как строки
  // значило бы терять каждое второе событие на длинном ответе.
  const lines = splitter((line) => safely(() => deliver(line, onEvent)));
  const errLines = splitter((line) => safely(() => onStderr(line)));

  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
    lines.push(String(chunk));
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
    errLines.push(String(chunk));
  });

  let killedBy = null;
  const stop = (why) => {
    killedBy = killedBy ?? why;
    killTree(child.pid);
  };

  const timer = setTimer(() => stop('timeout'), timeoutMs);
  // Таймер не должен держать процесс супервизора живым сам по себе: этап
  // может кончиться за минуту, а срок у него — час.
  timer?.unref?.();

  const finished = new Promise((resolve) => {
    const done = (code, error) => {
      clearTimer(timer);
      // Последняя строка приходит без перевода в конце, и без этого слива
      // терялось бы именно итоговое событие — то самое, из которого берётся
      // весь отчёт.
      lines.flush();
      errLines.flush();
      resolve({ code, killedBy, stdout, stderr, error: error ?? null });
    };
    // «error» — это не упавший этап, а несостоявшийся запуск: нет такой
    // команды, нет такого каталога. Путать их нельзя: первое лечится
    // продолжением, второе — настройкой.
    child.on('error', (error) => done(null, error));
    child.on('close', (code) => done(code));
  });

  return { pid: child.pid, finished, kill: () => stop('shutdown') };
}

/**
 * Резалка потока на строки с остатком.
 *
 * Кусок из сокета обрывается посреди строки где угодно, и хвост надо
 * донести до следующего куска. `flush` доносит последнюю строку, за которой
 * перевода уже не будет.
 */
function splitter(onLine) {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk;
      const parts = rest.split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) if (part.trim()) onLine(part.trim());
    },
    flush() {
      const last = rest.trim();
      rest = '';
      if (last) onLine(last);
    },
  };
}

/** Разобрать строку потока и отдать наружу. Сырая строка идёт следом всегда. */
function deliver(line, onEvent) {
  onEvent(parseLine(line), line);
}

/**
 * Наблюдение не вправе уронить супервизор.
 *
 * Он ведёт все задачи разом, и падение на разборе одного события остановило бы
 * конвейер целиком. Цена ошибки здесь несоизмерима с ценой самого наблюдения.
 */
function safely(action) {
  try {
    action();
  } catch {
    // Молча: жаловаться на неудачу наблюдения некуда, кроме того же наблюдения.
  }
}

/** Строка потока как объект. Не разобралась — `null`, и это законный ответ. */
function parseLine(line) {
  const text = stripBom(line).trim();
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Снять метку порядка байтов.
 *
 * Стоит отдельной мелочью потому, что стоила бы получаса поисков: метка
 * невидима, а `JSON.parse` на ней спотыкается с сообщением про неожиданный
 * знак в начале — то есть указывает ровно туда, где глазами ничего нет.
 */
function stripBom(text) {
  const line = String(text ?? '');
  // Сравнением кода, а не знаком в выражении: в исходнике метка невидима,
  // и правка рядом стёрла бы её незаметно и для глаза, и для обзора кода.
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
}

/**
 * Что ответил этап.
 *
 * Исход берётся из кода возврата и разбора ответа — и ниоткуда больше.
 * Восстанавливать его по отметке активности и признаку «идёт» не нужно:
 * оба существовали лишь потому, что кода возврата не было.
 *
 * @returns {{ outcome, envelope, denials, sessionId, result, why, seconds, cost, turns }}
 */
export function readAnswer(run) {
  const base = {
    envelope: null,
    denials: [],
    sessionId: null,
    result: null,
    cost: null,
    turns: null,
  };

  // Снятие по сроку — отдельный исход, а не отказ. Он назначает продолжение,
  // пока продолжения не исчерпаны: этап, не уложившийся в час, чаще всего
  // не сломан, а просто длинный.
  if (run.killedBy === 'timeout') {
    return { ...base, outcome: 'timeout', why: 'этап снят по истечении срока' };
  }
  if (run.killedBy === 'shutdown') {
    return { ...base, outcome: 'timeout', why: 'этап снят при остановке супервизора' };
  }

  if (run.error) {
    return { ...base, outcome: 'failed', why: `запуск не состоялся: ${run.error.message}` };
  }

  const envelope = parseEnvelope(run.stdout);
  if (!envelope) {
    return {
      ...base,
      outcome: 'failed',
      why: `ответ не разобрался (код ${run.code}); вывод сохранён целиком`,
    };
  }

  const answer = {
    envelope,
    denials: envelope.permission_denials ?? [],
    sessionId: envelope.session_id ?? null,
    result: envelope.result ?? null,
    cost: envelope.total_cost_usd ?? null,
    turns: envelope.num_turns ?? null,
  };

  if (run.code !== 0 || envelope.is_error) {
    return {
      ...answer,
      outcome: 'failed',
      why: `этап завершился неудачей (код ${run.code}, ${envelope.subtype ?? envelope.terminal_reason ?? 'без причины'})`,
    };
  }

  return { ...answer, outcome: 'done', why: null };
}

/**
 * Разобрать ответ приложения.
 *
 * Ответов два вида, и порядок разбора идёт от нового к старому.
 *
 * Поток событий (`stream-json`) — это NDJSON: по объекту на строку, и нужен
 * из них ровно один, помеченный `type: "result"`. Прежний приём — вырезать
 * от первой скобки до последней — на таком выводе даёт заведомо негодный
 * JSON: срез захватывает все события разом.
 *
 * Однократный ответ (`json`) — один объект, вокруг которого бывает мусор:
 * строка предупреждения от менеджера пакетов, пустые строки. Поэтому ищем
 * объект, а не требуем, чтобы весь вывод был им.
 */
function parseEnvelope(stdout) {
  const text = stripBom(stdout).trim();
  if (!text) return null;

  // Итоговое событие берётся ПОСЛЕДНЕЕ. Продолженная сессия печатает своё
  // на каждый заход, и первое из них говорит о прошлом ходе работы.
  let result = null;
  let stream = false;
  for (const line of text.split('\n')) {
    const event = parseLine(line);
    if (!event?.type) continue;
    if (event.type === 'result') result = event;
    else stream = true;
  }
  if (result) return result;

  // Поток был, а итога в нём нет — это оборванный этап, и признать его
  // удавшимся нельзя. Без этой проверки оборвавшийся на первом же событии
  // этап отдавал бы ровно один объект, тот разбирался бы запасным путём
  // как ответ, а отсутствующий признак ошибки читался бы как успех:
  // отказ превращался бы в «сделано» ценой одного события.
  if (stream) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Не разобралось целиком — ищем последний объект верхнего уровня.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Снять поддерево процессов.
 *
 * Именно поддерево, а не сам процесс. Этап порождает `git`, `pnpm`, `gh`
 * и браузер; осиротевший `pnpm install` удерживает каталог рабочего дерева
 * не хуже зависшей сессии, и уборка потом падает с «каталог занят».
 *
 * На Windows это `taskkill /T /F`: своей группы процессов там нет, и
 * `process.kill` снял бы одного `claude`, оставив всех его детей.
 */
/**
 * Спросить у системы, что за процесс носит этот номер.
 *
 * Нужно ради одного: номера процессов система переиспользует, и «номер
 * существует» само по себе не значит «наш этап жив». Довериться одному лишь
 * номеру значило бы однажды снять поддеревом (`taskkill /T /F`) постороннюю
 * ветку процессов рабочей станции — браузер, редактор и всё, что они успели
 * породить.
 *
 * Ответ разводит три положения, и путать их нельзя:
 *
 * - `known: true,  alive: true`  — процесс есть, и вот имя его образа;
 * - `known: true,  alive: false` — процесса с таким номером нет;
 * - `known: false`               — спросить не удалось, и это НЕ «процесса нет».
 *
 * Третье приходится отличать отдельно: «процесса нет» отпускает рабочее
 * дерево задачи, а «не спросилось» обязано оставить этап идущим до его срока.
 * Свалив их в одно, мы выдали бы продолжение живому этапу — то самое, ради
 * отмены чего опознание и заводится.
 */
export function createProbeProcess(run, platform = process.platform) {
  return (pid) => {
    if (!pid) return UNKNOWN;
    let answer;
    try {
      answer =
        platform === 'win32'
          ? run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'])
          : run('ps', ['-p', String(pid), '-o', 'comm=']);
    } catch {
      // Нет самой команды опроса — тот же случай «спросить не удалось».
      return UNKNOWN;
    }
    return platform === 'win32' ? readTasklist(answer) : readPs(answer);
  };
}

/** Спросить не удалось. Отдельное положение, а не разновидность отсутствия. */
const UNKNOWN = { known: false, alive: false, image: null };
/** Процесса с таким номером нет — и об этом система сказала прямо. */
const GONE = { known: true, alive: false, image: null };

/**
 * Ответ `tasklist`.
 *
 * Отсутствие процесса он сообщает ТЕКСТОМ при нулевом коде возврата —
 * «INFO: No tasks are running which match the specified criteria», причём
 * на языке системы. Поэтому опознаётся не сообщение (его не с чем сверять),
 * а его отсутствие: строка данных в формате CSV начинается с кавычки, всё
 * прочее — разговоры.
 */
function readTasklist(answer) {
  const line = firstLine(answer?.stdout);
  if (!line) return UNKNOWN;
  if (!line.startsWith('"')) return GONE;
  const end = line.indexOf('"', 1);
  const image = end > 1 ? line.slice(1, end) : '';
  return image ? { known: true, alive: true, image } : UNKNOWN;
}

/** Ответ `ps`: здесь отсутствие процесса приходит кодом возврата. */
function readPs(answer) {
  if (!answer) return UNKNOWN;
  if (answer.code !== 0) return GONE;
  const image = firstLine(answer.stdout);
  return image ? { known: true, alive: true, image } : UNKNOWN;
}

/** Первая непустая строка вывода. Пустой вывод — это «не разобралось». */
function firstLine(stdout) {
  return (
    String(stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

export function createKillTree(run, platform = process.platform) {
  return (pid) => {
    if (!pid) return;
    if (platform === 'win32') {
      run('taskkill', ['/PID', String(pid), '/T', '/F']);
      return;
    }
    // На прочих системах ребёнок порождается своей группой, и минус перед
    // номером означает «всей группе».
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Процесс уже кончился сам — снимать нечего.
      }
    }
  };
}
