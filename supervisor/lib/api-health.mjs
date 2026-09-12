/**
 * Здоровье сервера модели: когда пробовать и что делать с паузой.
 *
 * Обращений никуда здесь нет вовсе, и это главное в устройстве. Сама проба
 * приходит доводом от `bin/supervise.mjs` — как приходят `git` и `io` прочим
 * модулям, — а тут остаётся чистый счёт: пора ли пробовать, какова следующая
 * задержка, что делать с паузой при известном исходе пробы.
 *
 * Иначе проверить это нечем: тест, которому нужен живой сервер, зелен
 * по погоде, а не по коду. Проверять же надо именно ветви, которые в обычном
 * прогоне молчат, потому что сервер отвечает.
 */

/**
 * Задержка до следующей пробы.
 *
 * Расписание задано списком, а не формулой удвоения: список видно целиком,
 * и он же служит потолком. Формула требовала бы двух настроек вместо одной.
 *
 * Последняя задержка ПОВТОРЯЕТСЯ без предела. Предела попыток нет намеренно:
 * исчерпав его, автомат должен был бы что-то сделать — разбудить человека
 * нечем, продолжить молотить значит вернуть исходную беду. Пятнадцать минут
 * между пробами достаточно дёшевы, чтобы ждать сколь угодно долго.
 *
 * @param {number} attempt   сколько проб уже сделано под этой паузой
 * @param {number[]} schedule расписание задержек в секундах
 */
export function nextDelaySeconds(attempt, schedule) {
  const steps = Array.isArray(schedule) && schedule.length > 0 ? schedule : [60];
  const at = Math.min(Math.max(0, Math.trunc(attempt)), steps.length - 1);
  return steps[at];
}

/**
 * Пробовать ли сервер прямо сейчас.
 *
 * Два случая, и они разные. Пауза не взведена — пробуем, лишь когда отказов
 * набралось на порог; проба перед взведением обязательна, потому что
 * одиночный отказ бывает случайным. Пауза взведена — пробуем по расписанию,
 * а до срока не делаем ничего вовсе: частая проба чужой сервер не ускоряет.
 *
 * @param {object} params
 * @param {number} params.apiErrors   отказов сервера за оборот
 * @param {number} params.threshold   порог взведения
 * @param {boolean} params.armed      взведена ли пауза сервера
 * @param {number} params.now         текущее время, мс
 * @param {number?} params.lastProbeAt когда пробовали в прошлый раз, мс
 * @param {number} params.attempt     сколько проб сделано под этой паузой
 * @param {number[]} params.schedule  расписание задержек в секундах
 * @returns {{ probe: boolean, why: string, waitSeconds: number }}
 */
export function shouldProbe({
  apiErrors = 0,
  threshold = 1,
  armed = false,
  now = 0,
  lastProbeAt = null,
  attempt = 0,
  schedule = [60],
}) {
  const delay = nextDelaySeconds(attempt, schedule);

  if (!armed) {
    return apiErrors >= threshold
      ? { probe: true, why: `отказов сервера за оборот: ${apiErrors}`, waitSeconds: 0 }
      : { probe: false, why: 'отказов сервера нет', waitSeconds: 0 };
  }

  // Первая проба под свежей паузой делается сразу: отметки прошлой ещё нет,
  // и ждать нечего.
  if (lastProbeAt == null) {
    return { probe: true, why: 'проба под паузой ещё не делалась', waitSeconds: 0 };
  }

  const passed = Math.max(0, now - lastProbeAt) / 1000;
  const left = Math.ceil(delay - passed);
  return left > 0
    ? { probe: false, why: `до следующей пробы ${left} с`, waitSeconds: left }
    : { probe: true, why: `с прошлой пробы прошло ${Math.floor(passed)} с`, waitSeconds: 0 };
}

/**
 * Что делать с паузой сервера при известном исходе пробы.
 *
 * Четыре случая, и все нужны. `idle` — самый ценный: одиночный отказ, после
 * которого сервер отвечает, паузы не заводит вовсе. Проба стоит доли цента,
 * напрасная пауза — целого промежутка между оборотами.
 *
 * @param {object} params
 * @param {boolean} params.armed  взведена ли пауза сервера
 * @param {boolean} params.ok     ответил ли сервер на пробу
 * @param {string|number?} params.status состояние отказа, если он был
 * @returns {{ verdict: 'arm'|'hold'|'lift'|'idle', why: string }}
 */
export function judgeProbe({ armed = false, ok = false, status = null }) {
  const named = status == null ? 'без состояния' : `состояние ${status}`;

  if (!armed) {
    return ok
      ? { verdict: 'idle', why: 'сервер отвечает: отказ был одиночным, пауза не нужна' }
      : { verdict: 'arm', why: `сервер не отвечает (${named}): работы не берём` };
  }

  return ok
    ? { verdict: 'lift', why: 'сервер ответил: работу продолжаем' }
    : { verdict: 'hold', why: `сервер по-прежнему не отвечает (${named})` };
}
