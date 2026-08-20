import { TICKS_PER_SECOND } from '@td/shared';
import type { CommandKind, PlayerId, RejectReason } from '@td/shared';
import type { Rejection } from '@td/sim';

/**
 * Лента отказов: из потока отклонённых команд — в сообщения для игрока.
 *
 * Зачем отдельный модуль, а не три строки в `bootstrap`. Здесь живёт
 * единственная нетривиальная часть всей этой затеи — гашение повторов, —
 * и её надо проверять тестом, а не глазами в браузере. Ядро отказывает
 * тридцать раз в секунду, пока клавиша зажата, и без гашения игрок
 * получил бы тридцать одинаковых сообщений в секунду.
 *
 * Модуль ничего не знает о том, как сообщение выглядит и какими словами
 * написано: он оперирует причинами. Слова живут в `hud/labels.ts`, потому
 * что это оформление, а не логика.
 */

/**
 * Сколько тиков после показа сообщения такой же отказ не повторяется.
 *
 * Секунда. Меньше — и зажатая клавиша даёт мельтешение; больше — и игрок,
 * осознанно повторивший действие, не получает ответа и решает,
 * что интерфейс завис.
 */
const QUIET_TICKS = TICKS_PER_SECOND;

/** Сколько тиков сообщение висит на экране. */
const NOTICE_TICKS = Math.round(TICKS_PER_SECOND * 2.5);

/**
 * Сколько сообщений показывается разом.
 *
 * Больше трёх читать некогда: идёт бой. Лишние вытесняются старшими,
 * а не копятся в столбик до низа экрана.
 */
const MAX_NOTICES = 3;

/** Сообщение об отказе, живущее на экране. */
export interface Notice {
  /**
   * Номер по порядку. Нужен и React для `key`, и панелям HUD, чтобы
   * заметить «пришёл новый отказ» и вздрогнуть.
   */
  readonly id: number;
  readonly kind: CommandKind;
  readonly reason: RejectReason;
  /** Тик появления. По нему сообщение и гаснет. */
  readonly tick: number;
}

export interface RejectionFeed {
  /**
   * Принять отказы тика.
   *
   * Возвращает новый список сообщений, если он изменился, и `undefined`,
   * если нет. Различие существенно: обработчик зовётся тридцать раз
   * в секунду, а запись в store перерисовывает HUD, и делать её на каждом
   * тике «просто на всякий случай» значило бы сжечь бюджет отзывчивости
   * ради пустого массива.
   */
  accept(tick: number, rejections: readonly Rejection[]): readonly Notice[] | undefined;
}

const keyOf = (kind: CommandKind, reason: RejectReason): number =>
  // Пара «вид команды, причина» в одно число: причин меньше сотни,
  // и Map по числу дешевле Map по строке.
  kind * 100 + reason;

export const createRejectionFeed = (me: PlayerId): RejectionFeed => {
  let notices: readonly Notice[] = [];
  let lastTick = -1;
  let nextId = 1;

  /** Когда пара «команда, причина» показывалась в последний раз. */
  const shownAt = new Map<number, number>();

  const reset = (): void => {
    notices = [];
    shownAt.clear();
    // Счётчик намеренно не обнуляется: панели HUD отличают новый отказ
    // от старого по возрастанию номера, и повтор номера после рестарта
    // они прочли бы как «ничего не изменилось».
  };

  return {
    accept(tick, rejections) {
      // Тик пошёл назад — начался новый матч. Показывать сообщения
      // из прошлой игры незачем, а главное, без сброса гашение решило бы,
      // что всё уже показано, и промолчало бы всю первую секунду.
      if (tick < lastTick) reset();
      lastTick = tick;

      let changed = false;

      const alive = notices.filter((notice) => tick - notice.tick < NOTICE_TICKS);
      if (alive.length !== notices.length) {
        notices = alive;
        changed = true;
      }

      for (const rejection of rejections) {
        // Чужие отказы игроку не показываются: они его не касаются
        // и выдали бы сведения о неудачных попытках соперника.
        if (rejection.player !== me) continue;

        const key = keyOf(rejection.kind, rejection.reason);
        const previous = shownAt.get(key);
        if (previous !== undefined && tick - previous < QUIET_TICKS) continue;

        shownAt.set(key, tick);
        notices = [
          ...notices,
          { id: nextId, kind: rejection.kind, reason: rejection.reason, tick },
        ];
        nextId += 1;
        changed = true;
      }

      if (notices.length > MAX_NOTICES) {
        notices = notices.slice(notices.length - MAX_NOTICES);
        changed = true;
      }

      return changed ? notices : undefined;
    },
  };
};
