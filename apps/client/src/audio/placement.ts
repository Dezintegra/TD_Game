import { worldToScreen } from '../game/iso.js';

/**
 * Где звук слышен: громкость, панорама, глухота и доля отражений.
 *
 * Модуль чистый — числа на входе, числа на выходе, — и потому проверяется
 * обычным тестом. Всё, что знает браузер, лежит в `engine.ts`.
 *
 * Считается это КАЖДЫЙ КАДР для каждого звучащего источника, а не один
 * раз при запуске. Разница слышна сразу: игрок прокручивает карту,
 * и грохот, начавшийся справа, уезжает налево вместе с картинкой.
 * Посчитай мы размещение однажды, восьмисекундный ядерный удар остался бы
 * висеть там, где экран был восемь секунд назад.
 */

export interface Listener {
  /** Центр обзора в клетках карты. */
  readonly cellX: number;
  readonly cellY: number;
  /** Половина ширины окна в пикселях: ею меряется размах панорамы. */
  readonly halfWidth: number;
}

export interface Placement {
  /** Множитель громкости, от нуля до единицы. */
  readonly gain: number;
  /** Панорама от −1 (слева) до 1 (справа). */
  readonly pan: number;
  /** Частота среза, в герцах: далёкое глуше. */
  readonly cutoff: number;
  /** Доля, уходящая в отражения. */
  readonly wet: number;
}

/**
 * На каком удалении громкость падает вдвое.
 *
 * Десять клеток — примерно четверть видимой области. Ближе этого
 * разница в громкости почти не читается, дальше — читается сразу.
 */
const HALF_GAIN_CELLS = 10;

/** Где звук начинает пропадать и где пропадает совсем, в клетках. */
const FADE_FROM_CELLS = 22;
export const SILENT_BEYOND_CELLS = 32;

/**
 * Насколько панорама не доходит до края.
 *
 * Полностью уведённый в один канал звук в наушниках слышится «в ухе»,
 * а не «слева на карте». Три четверти дают направление и оставляют звук
 * снаружи головы.
 */
const PAN_LIMIT = 0.75;

/**
 * Во сколько раз шире окна должен быть источник, чтобы уехать в край
 * панорамы.
 *
 * Чуть шире единицы: звук у самой кромки экрана должен быть уже почти
 * в краю, но не в нём, иначе всё, что за экраном, панорамируется одинаково
 * и перестаёт различаться по направлению.
 */
const PAN_SPAN = 1.15;

/** Срез вблизи и вдали. Дальнее глуше: воздух гасит верх. */
const NEAR_CUTOFF_HZ = 18000;
const FAR_CUTOFF_HZ = 2600;

/** Доля отражений вблизи и вдали. */
const NEAR_WET = 0.1;
const FAR_WET = 0.62;

/** На каком удалении глухота и отражения достигают предела. */
const DISTANCE_SCALE_CELLS = 26;

/**
 * Разместить источник относительно слушателя.
 *
 * Удаление меряется в клетках мира, а панорама — в экранных пикселях,
 * и это не непоследовательность. Громкость зависит от того, как далеко
 * событие произошло на самом деле; панорама — от того, где оно оказалось
 * на экране. Проекция косая, поэтому одно из другого не выводится.
 */
export const place = (cellX: number, cellY: number, listener: Listener): Placement => {
  const dx = cellX - listener.cellX;
  const dy = cellY - listener.cellY;
  const distance = Math.hypot(dx, dy);

  // Скат к отсечке — та же кривая, какой гаснут частицы в `effects.ts`,
  // но записанная здесь, а не взятая оттуда. Причина не в независимости,
  // а в весе: `effects.ts` тянет за собой PixiJS, и звуковой модуль
  // из-за одной пятистрочной выкладки начинал зависеть от рендерера,
  // а его тесты — собираться десять секунд вместо трёх.
  const fade =
    distance <= FADE_FROM_CELLS
      ? 1
      : distance >= SILENT_BEYOND_CELLS
        ? 0
        : 1 - (distance - FADE_FROM_CELLS) / (SILENT_BEYOND_CELLS - FADE_FROM_CELLS);

  const gain = (HALF_GAIN_CELLS / (HALF_GAIN_CELLS + distance)) * fade;

  // Экранное смещение считается разностью проекций, а не проекцией
  // разности: преобразование линейное, поэтому это одно и то же, —
  // но так виднее, что речь именно о смещении на экране.
  const source = worldToScreen(cellX, cellY);
  const centre = worldToScreen(listener.cellX, listener.cellY);
  const offset = source.x - centre.x;

  const span = Math.max(1, listener.halfWidth) * PAN_SPAN;
  const pan = Math.max(-1, Math.min(1, offset / span)) * PAN_LIMIT;

  const far = Math.min(1, distance / DISTANCE_SCALE_CELLS);

  return {
    gain,
    pan,
    // Срез съезжает по квадрату, а не по прямой: слух логарифмичен,
    // и линейный съезд читается «выключили верх» на полпути.
    cutoff: NEAR_CUTOFF_HZ + (FAR_CUTOFF_HZ - NEAR_CUTOFF_HZ) * far * far,
    wet: NEAR_WET + (FAR_WET - NEAR_WET) * far,
  };
};

/** Слышно ли событие вообще. Неслышное не занимает места среди звучащих. */
export const isAudible = (cellX: number, cellY: number, listener: Listener): boolean =>
  Math.hypot(cellX - listener.cellX, cellY - listener.cellY) < SILENT_BEYOND_CELLS;
