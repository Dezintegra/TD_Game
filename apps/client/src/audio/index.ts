import { DIRECTION_STOP, unitsToCells } from '@td/shared';
import type { WorldState } from '@td/sim';
import { createCueFeed } from './cues.js';
import { createEngine } from './engine.js';
import type { RotorState } from './engine.js';
import type { Listener } from './placement.js';
import { readSoundSettings, writeSoundSettings } from './settings.js';
import type { SoundSettings } from './settings.js';

export type { Listener } from './placement.js';
export type { SoundSettings } from './settings.js';
export { DEFAULT_SOUND_SETTINGS, readSoundSettings } from './settings.js';

/**
 * Звук игры — то, что видит игровой цикл.
 *
 * Один метод на кадр и один на настройки. Всё остальное — вывод событий
 * из мира, защита от повторов, бюджет, размещение, свёртка, выпечка —
 * спрятано за этой границей намеренно: игровому циклу знать о них нечего,
 * а разбирать их по одному в `bootstrap.ts` значило бы размазать
 * подсистему по чужому файлу.
 */
export interface Audio {
  /**
   * Кадр.
   *
   * `silent` означает «мир сейчас переигрывается»: восстановление
   * по истории команд, пересборка после расхождения, первый кадр матча.
   * События при этом запоминаются, но не звучат — иначе игрок услышал бы
   * минуту боя за полсекунды.
   */
  frame(world: WorldState, listener: Listener, silent: boolean): void;
  setSettings(settings: SoundSettings): void;
  readonly settings: SoundSettings;
  stop(): void;
}

/** Пустышка на случай, когда звука в окружении нет. */
const noopAudio = (settings: SoundSettings): Audio => ({
  frame: () => undefined,
  setSettings: () => undefined,
  settings,
  stop: () => undefined,
});

/**
 * Роторы живых генералов.
 *
 * Оба, и свой и чужой. Тумана войны нет, чужой генерал виден, и слышать
 * его приближение — то же право, что видеть его силуэт.
 *
 * Признак движения берётся из состояния мира (`direction`), а не выводится
 * из разницы положений между кадрами. Разница врала бы дважды: предсказание
 * переигрывает тики, и положение на соседних кадрах бывает одинаковым
 * у движущейся машины и разным у стоящей.
 */
const rotorsOf = (world: WorldState): readonly RotorState[] => {
  const states: RotorState[] = [];

  for (const general of world.generals) {
    if (!general.alive) continue;
    states.push({
      owner: general.owner,
      cellX: unitsToCells(general.position.x),
      cellY: unitsToCells(general.position.y),
      moving: general.direction !== DIRECTION_STOP,
    });
  }

  return states;
};

export const createAudio = (): Audio => {
  let settings = readSoundSettings();

  const engine = createEngine();
  const cues = createCueFeed();

  engine.setSettings(settings);

  /**
   * Первый кадр молчит.
   *
   * При входе в матч мир уже полон записей: выстрелы в полёте, догорающие
   * взрывы, чужая ядерная ракета в снижении. Сыграй мы их, игрок получил
   * бы залп из всего, что случилось до его подключения.
   */
  let primed = false;

  /**
   * Контекст создаётся по первому действию игрока и никак иначе.
   *
   * Браузеры запрещают звук до жеста, и созданный раньше контекст
   * оказался бы приостановленным — первые события пропали бы молча.
   * К началу матча жест заведомо был: игрок прошёл через меню и нажал
   * на кнопку. Но полагаться на это нельзя, матч открывается и по прямой
   * ссылке.
   */
  const wake = (): void => engine.resume();

  const onVisible = (): void => {
    // Браузер приостанавливает контекст в скрытой вкладке и не всегда
    // возвращает его сам.
    if (document.visibilityState === 'visible') engine.resume();
  };

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return noopAudio(settings);
  }

  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);
  document.addEventListener('visibilitychange', onVisible);

  return {
    get settings() {
      return settings;
    },

    setSettings(next: SoundSettings) {
      settings = next;
      engine.setSettings(next);
      writeSoundSettings(next);
      // Включили звук руками — это тоже жест, и контекст пора завести.
      if (next.enabled) engine.resume();
    },

    frame(world: WorldState, listener: Listener, silent: boolean) {
      const quiet = silent || !primed;
      primed = true;

      const fresh = cues.accept(world, quiet);
      engine.frame(fresh, listener);

      // Ротор молчит вместе со всем остальным, пока мир переигрывается:
      // непрерывный звук при перемотке превратился бы в вой.
      engine.rotors(quiet ? [] : rotorsOf(world), listener);
    },

    stop() {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
      document.removeEventListener('visibilitychange', onVisible);
      engine.stop();
    },
  };
};
