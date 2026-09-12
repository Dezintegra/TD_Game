import { MAX_ZOOM } from './camera.js';
import { screenToWorld } from './iso.js';

export const rockBaseDensity = (resolution: number): number => Math.max(1, resolution);
/** Совместимость статического fx-probe: его первый аргумент — плотность брони. */
export const rockBakeDensity = (armourDensity: number, _rockCells: number): number =>
  rockBaseDensity(armourDensity / MAX_ZOOM);
export const rockTargetDensity = (resolution: number, scale: number): number =>
  rockBaseDensity(resolution) * 2 ** Math.ceil(Math.log2(Math.max(1, scale)));

export interface RockTextureSize {
  readonly width: number;
  readonly height: number;
}

/** Физические размеры округляются вверх; каждый mip учитывается целиком. */
export const rockTextureBytes = ({ width, height }: RockTextureSize, density: number): number => {
  let w = Math.ceil(width * density);
  let h = Math.ceil(height * density);
  if (w <= 0 || h <= 0) return 0;
  let bytes = 0;
  for (;;) {
    bytes += w * h * 4;
    if (w === 1 && h === 1) return bytes;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
};

export interface RockMemoryLimit {
  readonly base: number;
  readonly detail: number;
  readonly temporary: number;
  readonly total: number;
}

/** Запас задан в координатах проекции, как и расширение фактического обзора. */
export const ROCK_VIEW_MARGIN = 32;

export const rockMemoryLimit = (
  cells: readonly RockTextureSize[],
  field: RockTextureSize,
  resolution: number,
): RockMemoryLimit => {
  const d0 = rockBaseDensity(resolution);
  const base = cells.reduce((sum, cell) => sum + rockTextureBytes(cell, d0), 0);
  const width = Math.max(0, ...cells.map((cell) => cell.width));
  const height = Math.max(0, ...cells.map((cell) => cell.height));
  const largest = { width, height };
  let detail = 0;
  for (let level = 1; level <= Math.ceil(Math.log2(MAX_ZOOM)); level += 1) {
    const lowerScale = 2 ** (level - 1);
    const w = field.width / lowerScale + 2 * (width + ROCK_VIEW_MARGIN);
    const h = field.height / lowerScale + 2 * (height + ROCK_VIEW_MARGIN);
    const corners = [
      screenToWorld(0, 0),
      screenToWorld(w, 0),
      screenToWorld(0, h),
      screenToWorld(w, h),
    ];
    const spanX = Math.max(...corners.map((p) => p.x)) - Math.min(...corners.map((p) => p.x));
    const spanY = Math.max(...corners.map((p) => p.y)) - Math.min(...corners.map((p) => p.y));
    const count = Math.min(cells.length, (Math.ceil(spanX) + 2) * (Math.ceil(spanY) + 2));
    detail = Math.max(detail, count * rockTextureBytes(largest, d0 * 2 ** level));
  }
  const temporary = cells.length === 0 ? 0 : rockTextureBytes(largest, d0 * MAX_ZOOM);
  return { base, detail, temporary, total: base + detail + temporary };
};

export const rockResolutionBridge = (
  cells: readonly (RockTextureSize & { readonly heldBytes: number })[],
  resolution: number,
  startBytes: number,
): { base: number; temporary: number; total: number } => {
  const costs = cells.map((cell) => rockTextureBytes(cell, rockBaseDensity(resolution)));
  const base = cells.reduce((sum, cell, i) => sum + Math.max(cell.heldBytes, costs[i] ?? 0), 0);
  const temporary = Math.max(0, ...costs);
  return { base, temporary, total: Math.max(startBytes, base) + temporary };
};

export const rockResizeLimit = (startBytes: number, newLimit: number): number =>
  Math.max(startBytes, newLimit);

/**
 * Плотность запекания — во сколько раз запечённая текстура подробнее
 * показа при единичном масштабе.
 *
 * Величина здесь одна намеренно. До этого модуля её выбирало каждое место
 * запекания само: машины брали плотность экрана, дуги — двойку, а скалы
 * и командный центр — единицу, то есть выбрасывали плотность экрана, ради
 * которой `app.init` её и запрашивает. Разъезд произошёл молча, и заметен
 * он стал только с появлением зума.
 *
 * **Плотность не назначается, а выводится.** Поле масштабируется
 * приближением, и запечённое растягивается вместе с ним, — но у растяжения
 * есть точная граница:
 *
 * - `defaultScale` не поднимается выше единицы НИКОГДА: это записанное
 *   обещание широкому экрану, картинка уменьшается при нехватке высоты
 *   и никогда не растёт сама;
 * - `clampZoom` не пускает выше `MAX_ZOOM`;
 * - значит `scale = defaultScale × zoom ≤ MAX_ZOOM`.
 *
 * Отсюда всё остальное. Плотность `плотность экрана × MAX_ZOOM` покрывает
 * диапазон целиком, и мыла не остаётся ни при каком приближении; плотность
 * сверх неё — выброшенная память, потому что этих точек не увидит никто.
 *
 * Прежде здесь стоял ЗАПАС — двойка, выбранная как компромисс между
 * чёткостью и памятью. Компромисс был честно назван компромиссом,
 * и половину мыла он оставлял на месте.
 */
export const ARMOUR_BAKE_ZOOM = MAX_ZOOM;

/**
 * Потолок плотности запекания брони.
 *
 * Нужен потому, что плотность экрана входит в произведение. Телефон
 * сообщает `devicePixelRatio = 3`, и без потолка вышло бы двенадцать,
 * то есть в сто сорок четыре раза больше памяти, чем при единице.
 *
 * Шесть выбрано так, чтобы обычный экран получил свою четвёрку без
 * урезания, а плотный — шесть из восьми желаемых. Остаток растяжения
 * на ретине при этом 1,33 вместо нынешних 2.
 */
export const MAX_ARMOUR_BAKE_DENSITY = 6;

/**
 * Плотность запекания брони: машин, построек, командного центра и дуг.
 *
 * Покрывает диапазон приближения целиком — см. вывод в шапке модуля.
 * На подробном экране запечённое обязано быть подробнее, а не крупнее,
 * поэтому плотность экрана входит множителем.
 */
export const armourBakeDensity = (screenDensity: number): number =>
  Math.min(Math.max(screenDensity, 1) * ARMOUR_BAKE_ZOOM, MAX_ARMOUR_BAKE_DENSITY);

/**
 * Во сколько раз черновой буфер брони плотнее готовой текстуры.
 *
 * Броня печётся в черновик, который плотнее готового, и уменьшается
 * вторым проходом — так получается сглаживание, не спорящее
 * с альфа-каналом, в котором лежит удалённость.
 *
 * **Кратность снова постоянна, и это не откат, а следствие.** Прежде она
 * выводилась делением: готовая текстура росла вдвое, а плотность черновика
 * держалась прежней, и запекание не дорожало. Приём был верен ровно
 * потому, что рост был умеренным.
 *
 * Теперь готовая текстура растёт вчетверо, и прежняя формула дала бы
 * кратность МЕНЬШЕ единицы — черновик оказался бы реже готового. Сведение
 * превратилось бы в растягивание, то есть добавило бы ровно то мыло, ради
 * которого плотность и поднимали.
 *
 * Полтора — та же кратность, которая раньше получалась расчётом на обычном
 * экране, поэтому решётка проб в шейдере сведения остаётся верной без
 * единой правки.
 *
 * Цена названа честно: черновик становится вчетверо плотнее прежнего
 * (было `экран × 3`, стало `экран × 6`), и запекание одной комбинации
 * дорожает с измеренных 3,3 мс примерно до 13. Ради этого и заводится
 * прогрев в меню: тринадцать миллисекунд посреди боя — пропущенный кадр,
 * а в меню они не стоят ничего.
 */
export const ARMOUR_SUPERSAMPLE = 1.5;
