import { TELEMETRY_GRACE_MS } from '@td/shared';
import type { HistogramSnapshot, ReadingRows } from '@td/shared';

/**
 * Приём показаний клиента: кто их прислал, что в них нового и куда их деть.
 *
 * Точка `/api/telemetry` смотрит в интернет — `nginx` проксирует `/api/`
 * целиком, — поэтому всё здесь исходит из того, что присылающий может
 * оказаться кем угодно и прислать что угодно.
 */

/** Чьи это показания. Матч и сторона опознают партию, но не человека. */
export interface ReadingsSeat {
  readonly matchId: string;
  readonly side: number;
}

/**
 * Карта билетов: по билету — матч и сторона.
 *
 * Билет выдал сервер, значит по нему и опознаём. Взять `matchId`
 * и сторону из тела запроса было бы проще всего — и неверно: прислав
 * чужой идентификатор, кто угодно дописал бы в чужой файл.
 *
 * ## Почему карта своя, а не сиденья реестра матчей
 *
 * Реестр снимает сиденья, когда матч закрывается, а последний снимок
 * уходит уже после исхода — по событию конца матча и по выходу игрока
 * в меню. Опознавай мы реестром, самый нужный снимок отвергался бы
 * всегда.
 *
 * Держать ради этого сиденья в самом реестре нельзя: он ведёт матчи,
 * и платить за диагностику его памятью — значит связать одно с другим
 * там, где связи нет.
 *
 * ## Почему без таймеров
 *
 * Забывание ленивое: просроченное отбрасывается при обращении и при
 * заведении нового матча. Таймер на каждый матч держал бы цикл событий
 * и требовал бы отмены при закрытии службы — цена несоразмерная задаче
 * «забыть строку через две минуты».
 */
export interface TicketBook {
  /** Матч начался: запомнить его билеты. */
  register(matchId: string, tickets: ReadonlyMap<string, number>): void;
  /** Матч кончился: билеты доживают отпущенный срок и забываются. */
  finish(matchId: string): void;
  /** Чей билет. Неизвестный или просроченный — `undefined`. */
  resolve(ticket: string): ReadingsSeat | undefined;
  /**
   * Прошлый снимок этого билета — тот, с которым считать разность.
   *
   * Живёт здесь, а не во второй карте рядом, потому что срок жизни
   * у него ровно тот же, что у билета. Вторая карта со своим сроком
   * однажды разошлась бы с первой и потекла бы памятью.
   */
  lastOf(ticket: string): ReadingRows | undefined;
  /** Запомнить снимок как прошлый. */
  remember(ticket: string, rows: ReadingRows): void;
  /** Сколько билетов помнится. Для проверок и для показаний о службе. */
  readonly size: number;
}

export interface TicketBookOptions {
  /** Часы. Внедрены ради проверяемости отсрочки. */
  readonly now?: () => number;
  readonly graceMs?: number;
}

interface BookEntry {
  readonly seat: ReadingsSeat;
  /** Когда матч кончился. `undefined` — ещё идёт. */
  endedAtMs?: number;
  /** Прошлый принятый снимок. `undefined` — снимков ещё не было. */
  last?: ReadingRows;
}

export const createTicketBook = (options: TicketBookOptions = {}): TicketBook => {
  const now = options.now ?? (() => Date.now());
  const graceMs = options.graceMs ?? TELEMETRY_GRACE_MS;

  const entries = new Map<string, BookEntry>();

  const expired = (entry: BookEntry, at: number): boolean =>
    entry.endedAtMs !== undefined && at - entry.endedAtMs > graceMs;

  const sweep = (): void => {
    const at = now();
    for (const [ticket, entry] of entries) {
      if (expired(entry, at)) entries.delete(ticket);
    }
  };

  return {
    register(matchId, tickets) {
      // Уборка при заведении, а не по таймеру: матчи заводятся регулярно,
      // и этого хватает, чтобы карта не росла. Служба без матчей карту
      // не растит вовсе, и подметать в ней нечего.
      sweep();

      for (const [ticket, side] of tickets) {
        entries.set(ticket, { seat: { matchId, side } });
      }
    },

    finish(matchId) {
      const at = now();
      for (const entry of entries.values()) {
        if (entry.seat.matchId === matchId) entry.endedAtMs = at;
      }
    },

    resolve(ticket) {
      const entry = entries.get(ticket);
      if (entry === undefined) return undefined;

      if (expired(entry, now())) {
        entries.delete(ticket);
        return undefined;
      }

      return entry.seat;
    },

    lastOf(ticket) {
      return entries.get(ticket)?.last;
    },

    remember(ticket, rows) {
      const entry = entries.get(ticket);
      if (entry === undefined) return;

      entry.last = rows;
    },

    get size() {
      return entries.size;
    },
  };
};

/**
 * Разность двух снимков одного ряда.
 *
 * Снимки накопительные: клиент шлёт всё, что скопилось с начала матча,
 * и шлёт десятки раз за партию. Влей мы каждый целиком — одни и те же
 * наблюдения посчитались бы столько раз, сколько было отправок.
 *
 * Все поля снимка, кроме перцентилей и максимума, — монотонные
 * счётчики, поэтому разность честная. Максимум не вычитается, а едет
 * как есть: он монотонен, а `merge` берёт от него большее. Перцентили
 * не пересылаются вовсе — они пересчитываются из корзин при отдаче.
 *
 * ## Убывший счётчик — не порча, а перезапуск копилки
 *
 * Игрок перезагрузил страницу посреди матча: билет тот же, копилка
 * новая, счёт пошёл с нуля. Вычти мы здесь — получилось бы
 * отрицательное число наблюдений, то есть тихая порча всей выборки.
 *
 * Поэтому убывание любого счётчика читается как перезапуск, и снимок
 * отдаётся целиком, как первый. Приём известен по Prometheus (counter
 * reset) и работает здесь по той же причине.
 *
 * Границы корзин, разошедшиеся с прошлым снимком, читаются так же:
 * это другая копилка, и вычитать из неё нечего.
 */
const rowDelta = (
  previous: HistogramSnapshot | undefined,
  next: HistogramSnapshot,
): HistogramSnapshot => {
  if (previous === undefined) return next;
  if (previous.buckets.length !== next.buckets.length) return next;

  for (let index = 0; index < next.buckets.length; index += 1) {
    if (previous.buckets[index]?.bound !== next.buckets[index]?.bound) return next;
  }

  const restarted =
    next.count < previous.count ||
    next.sum < previous.sum ||
    next.overBudget < previous.overBudget ||
    next.overflow < previous.overflow;

  if (restarted) return next;

  const buckets = next.buckets.map((bucket, index) => ({
    bound: bucket.bound,
    count: bucket.count - (previous.buckets[index]?.count ?? 0),
  }));

  // Корзина, похудевшая при выросшем итоге, означает то же самое:
  // копилку начали заново, а совпадение итогов случайно.
  if (buckets.some((bucket) => bucket.count < 0)) return next;

  return {
    count: next.count - previous.count,
    sum: next.sum - previous.sum,
    max: next.max,
    overBudget: next.overBudget - previous.overBudget,
    overflow: next.overflow - previous.overflow,
    buckets,
    p50: 0,
    p95: 0,
    p99: 0,
  };
};

/**
 * Что в присланном снимке нового по сравнению с прошлым.
 *
 * Ряд, которого в новом снимке нет, отсутствует и в разности: старый
 * бандл в открытой вкладке шлёт не все ряды, и требовать от него
 * полноты значило бы отвергать показания из-за собственной выкладки.
 */
export const deltaOf = (previous: ReadingRows | undefined, next: ReadingRows): ReadingRows => {
  const delta: { -readonly [Row in keyof ReadingRows]: ReadingRows[Row] } = {};

  for (const [row, snapshot] of Object.entries(next) as [
    keyof ReadingRows,
    HistogramSnapshot | undefined,
  ][]) {
    if (snapshot === undefined) continue;

    delta[row] = rowDelta(previous?.[row], snapshot);
  }

  return delta;
};
