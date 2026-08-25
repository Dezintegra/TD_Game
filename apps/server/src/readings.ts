import { TELEMETRY_GRACE_MS } from '@td/shared';

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

    get size() {
      return entries.size;
    },
  };
};
