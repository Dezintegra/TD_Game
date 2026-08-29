import { DIRECTION_COUNT, DIRECTION_SOUTH, StructureKind } from '@td/shared';
import type { Renderer, Texture } from 'pixi.js';
import { DEFAULT_TUNING, bakeArmour } from './armour-render.js';
import type { ArmourTuning } from './armour-render.js';
import {
  BUILT_STEP,
  READINESS_STEPS,
  STRUCTURE_LOOK_COUNT,
  readinessLift,
  structurePalette,
  structureSolids,
} from './structures.js';

/**
 * Кеш запечённых построек.
 *
 * Тот же приём, что у машин, и по той же причине: проекция аффинна,
 * камера неподвижна и не приближается, поэтому картинка постройки
 * зависит от вида, облика, ступени готовности и стороны — и больше
 * ни от чего.
 *
 * ## Отражения в ключе нет
 *
 * Отражаются только те, кто висит (замысел, 7.2). Башня и стена стоят,
 * поэтому ключ вдвое короче машинного.
 *
 * ## Ключ не различает неразличимое
 *
 * Наивный ключ «вид × румб × ступень × сторона» дал бы 512 записей
 * и врал бы дважды. У недостроенной башни нет турели, а поворачивается
 * только она, — значит, во всех восьми румбах недострой выглядит
 * одинаково. У недостроенной стены нет связей — значит, её облик
 * всегда «столб».
 *
 * Отсюда приведение облика к нулю, пока постройка не готова, и вместо
 * 512 комбинаций остаётся 106:
 *
 * | Что           | Достроенных | Недостроенных |
 * | ------------- | ----------- | ------------- |
 * | Базовая башня | 8 × 2 = 16  | 7 × 2 = 14    |
 * | Снайперская   | 16          | 14            |
 * | Стена         | 16 × 2 = 32 | 14            |
 *
 * Встречаются в матче единицы из них: запекание ленивое.
 */

export interface StructureSprite {
  readonly texture: Texture;
  /** Смещение левого верхнего угла относительно центра клетки. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Высота модели в клетках. */
  readonly modelHeight: number;
}

export interface StructureSpriteColors {
  /** Броневой лист: корпус, турель, тело стены. */
  readonly plate: number;
  /** Сталь: ствол, кромка, погон, заклёпка. */
  readonly steel: number;
  /** Бетон: постамент башни, фундамент стены. */
  readonly concrete: number;
  /** Остекление линз. */
  readonly glass: number;
  /** Цвет своей стороны и цвет чужой. */
  readonly self: number;
  readonly enemy: number;
  /** Холодный подсвет сверху. */
  readonly sky: number;
  /** Цвет поверхности поля. */
  readonly ground: number;
}

export interface StructureSprites {
  /**
   * Спрайт постройки.
   *
   * `look` — румб турели у башни и маска связей у стены. `step` —
   * ступень готовности; последняя означает «достроено», и только она.
   */
  sprite(side: number, kind: StructureKind, look: number, step: number): StructureSprite;
  /** Освободить видеопамять. Обязательно при смене матча. */
  dispose(): void;
}

const SIDE_COUNT = 2;
const KIND_COUNT = 4;

/**
 * Фактура постройки грубее машинной.
 *
 * Бронеплита укрепления крупнее машинной, поэтому швов на клетку меньше,
 * а сами они глубже. Зерно оставлено машинным: ловушка «зерно крупнее
 * пары пикселей читается камнем, а не металлом» на постройке сработает
 * ровно так же, и лечится она не ослаблением, а частотой.
 */
const STRUCTURE_TUNING: ArmourTuning = {
  ...DEFAULT_TUNING,
  seamFrequency: 5,
  seamWidth: 0.009,
  seamDepth: 0.5,
};

const normaliseStep = (step: number): number =>
  !Number.isInteger(step) || step < 0 ? 0 : step > BUILT_STEP ? BUILT_STEP : step;

/**
 * Облик, приведённый к ключу кеша.
 *
 * У недостроя облика нет вовсе, и ноль здесь означает именно это.
 * У башни облик — румб, и он проверяется на попадание в восьмёрку:
 * снаружи сюда приходит число из состояния мира, а ноль там означает
 * «стоять» и модели не соответствует.
 */
const normaliseLook = (kind: StructureKind, look: number, built: boolean): number => {
  if (!built) return 0;
  if (kind === StructureKind.Wall) {
    return Number.isInteger(look) && look >= 0 && look < STRUCTURE_LOOK_COUNT ? look : 0;
  }

  return Number.isInteger(look) && look > 0 && look < DIRECTION_COUNT ? look : DIRECTION_SOUTH;
};

export const createStructureSprites = (
  renderer: Renderer,
  colors: StructureSpriteColors,
  resolution: number,
  supersample: number,
): StructureSprites => {
  const cache = new Array<StructureSprite | undefined>(
    KIND_COUNT * STRUCTURE_LOOK_COUNT * READINESS_STEPS * SIDE_COUNT,
  );

  const armourColors = (side: number): Parameters<typeof bakeArmour>[3] => {
    const accent = side === 0 ? colors.self : colors.enemy;

    return {
      palette: structurePalette({
        plate: colors.plate,
        steel: colors.steel,
        concrete: colors.concrete,
        glass: colors.glass,
        accent,
      }),
      accent,
      sky: colors.sky,
      ground: colors.ground,
    };
  };

  const sprite = (
    side: number,
    kind: StructureKind,
    look: number,
    step: number,
  ): StructureSprite => {
    const stage = normaliseStep(step);
    const built = stage >= BUILT_STEP;
    const shape = normaliseLook(kind, look, built);

    const index =
      ((kind * STRUCTURE_LOOK_COUNT + shape) * READINESS_STEPS + stage) * SIDE_COUNT + side;

    const cached = cache[index];
    if (cached !== undefined) return cached;

    const baked = bakeArmour(
      renderer,
      structureSolids(kind, shape, built, readinessLift(stage)),
      // Всегда на юг: разворот турели и разворот стены сделаны поворотом
      // местных координат в `structures.ts`. Отдай поворот запеканию —
      // вместе с турелью развернулся бы и восьмигранный постамент,
      // а он обязан стоять по клетке.
      DIRECTION_SOUTH,
      armourColors(side),
      false,
      resolution,
      supersample,
      STRUCTURE_TUNING,
    );

    cache[index] = baked;
    return baked;
  };

  return {
    sprite,
    dispose() {
      // Уничтожать обязательно: текстура живёт в видеопамяти,
      // а сборщик мусора о видеопамяти не знает.
      for (const entry of cache) entry?.texture.destroy(true);
      cache.fill(undefined);
    },
  };
};
