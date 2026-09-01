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
 * @param {Function} [params.setTimer]
 * @param {Function} [params.clearTimer]
 * @returns {{ pid, finished: Promise<object>, kill: Function }}
 */
export function startStage({
  command,
  timeoutMs,
  spawn,
  killTree,
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
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
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
 * Ответ приходит одним объектом JSON, но вокруг него бывает мусор: строка
 * предупреждения от менеджера пакетов, пустые строки. Поэтому ищем объект,
 * а не требуем, чтобы весь вывод был им.
 */
function parseEnvelope(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;

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
