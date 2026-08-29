import { DIRECTION_COUNT, DIRECTION_SOUTH, UNIT_TYPES } from '@td/shared';
import type { UnitType } from '@td/shared';
import type { Renderer, Texture } from 'pixi.js';
import { bakeArmour } from './armour-render.js';
import { generalSolids, machinePalette, unitSolids } from './machines.js';
import { TIER_COUNT, clampTier } from './models.js';

/**
 * Кеш запечённых машин.
 *
 * Тот же кеш, что был у силуэтов, и по той же причине: проекция аффинна,
 * камера неподвижна и не приближается, поэтому картинка машины зависит
 * от типа, румба, ступеней оружия и стороны — и больше ни от чего. Две
 * одинаковые машины в разных концах карты дают на экране одну и ту же
 * картинку, сдвинутую на разность их положений.
 *
 * Разница в том, что кешируется. Прежде — набор многоугольников, который
 * на кадре ещё предстояло залить; теперь — готовая текстура, которую
 * остаётся положить спрайтом. Из кадра ушла тесселяция, и вместе с ней
 * ушёл потолок на число деталей.
 *
 * Кеш ленивый, и это главное. Осей прокачки на модели три — атака,
 * скорострельность, дальность, — то есть мест в кеше 1458 у машин
 * плюс 16 у генералов. Разом они не встречаются никогда: у игрока
 * в каждый момент одна тройка ступеней на тип, а картинок на неё —
 * три типа на восемь румбов, на две стороны, на два отражения.
 *
 * Отражение считается за отдельную запись, а не выводится из машины
 * переворотом: в отражении видно днище, и перекрытие деталей там другое.
 */

export interface MachineSprite {
  readonly texture: Texture;
  /** Смещение левого верхнего угла относительно точки опоры машины. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Высота модели в клетках — по ней ставится полоса здоровья. */
  readonly modelHeight: number;
}

export interface MachineSpriteColors {
  /** Броневой лист. */
  readonly plate: number;
  /** Металл: ствол, ступица, оптика. */
  readonly metal: number;
  /** Тень: колёса, решётки, выхлоп. */
  readonly shadow: number;
  /** Остекление. */
  readonly glass: number;
  /** Цвет своей стороны и цвет чужой. */
  readonly self: number;
  readonly enemy: number;
  /** Холодный подсвет сверху. */
  readonly sky: number;
  /** Цвет поверхности поля: к нему приглушается отражение. */
  readonly ground: number;
}

export interface MachineSprites {
  unit(
    side: number,
    unitType: UnitType,
    facing: number,
    attackTier: number,
    fireTier: number,
    rangeTier: number,
    mirror: boolean,
  ): MachineSprite;
  general(side: number, facing: number, mirror: boolean): MachineSprite;
  /** Высота модели юнита в клетках. Нужна полосе здоровья. */
  unitHeight(unitType: UnitType, attackTier: number, fireTier: number, rangeTier: number): number;
  /** Освободить видеопамять. Обязательно при смене матча. */
  dispose(): void;
}

const SIDE_COUNT = 2;
const MIRROR_COUNT = 2;

const normaliseFacing = (facing: number): number =>
  Number.isInteger(facing) && facing > 0 && facing < DIRECTION_COUNT ? facing : DIRECTION_SOUTH;

export const createMachineSprites = (
  renderer: Renderer,
  colors: MachineSpriteColors,
  resolution: number,
  supersample: number,
): MachineSprites => {
  const unitCacheSize =
    UNIT_TYPES.length *
    DIRECTION_COUNT *
    TIER_COUNT *
    TIER_COUNT *
    TIER_COUNT *
    SIDE_COUNT *
    MIRROR_COUNT;

  const units = new Array<MachineSprite | undefined>(unitCacheSize);
  const generals = new Array<MachineSprite | undefined>(
    DIRECTION_COUNT * SIDE_COUNT * MIRROR_COUNT,
  );

  const armourColors = (side: number): Parameters<typeof bakeArmour>[3] => {
    const accent = side === 0 ? colors.self : colors.enemy;

    return {
      palette: machinePalette({
        plate: colors.plate,
        metal: colors.metal,
        shadow: colors.shadow,
        glass: colors.glass,
        accent,
      }),
      accent,
      sky: colors.sky,
      ground: colors.ground,
    };
  };

  const unitIndex = (
    unitType: UnitType,
    facing: number,
    attack: number,
    fire: number,
    range: number,
    side: number,
    mirror: boolean,
  ): number =>
    (((((unitType * DIRECTION_COUNT + facing) * TIER_COUNT + attack) * TIER_COUNT + fire) *
      TIER_COUNT +
      range) *
      SIDE_COUNT +
      side) *
      MIRROR_COUNT +
    (mirror ? 1 : 0);

  const unit = (
    side: number,
    unitType: UnitType,
    facing: number,
    attackTier: number,
    fireTier: number,
    rangeTier: number,
    mirror: boolean,
  ): MachineSprite => {
    const rumb = normaliseFacing(facing);
    const attack = clampTier(attackTier);
    const fire = clampTier(fireTier);
    const range = clampTier(rangeTier);
    const index = unitIndex(unitType, rumb, attack, fire, range, side, mirror);

    const cached = units[index];
    if (cached !== undefined) return cached;

    const baked = bakeArmour(
      renderer,
      unitSolids(unitType, attack, fire, range),
      rumb,
      armourColors(side),
      mirror,
      resolution,
      supersample,
    );

    units[index] = baked;
    return baked;
  };

  const general = (side: number, facing: number, mirror: boolean): MachineSprite => {
    const rumb = normaliseFacing(facing);
    const index = (rumb * SIDE_COUNT + side) * MIRROR_COUNT + (mirror ? 1 : 0);

    const cached = generals[index];
    if (cached !== undefined) return cached;

    const baked = bakeArmour(
      renderer,
      generalSolids(),
      rumb,
      armourColors(side),
      mirror,
      resolution,
      supersample,
    );

    generals[index] = baked;
    return baked;
  };

  return {
    unit,
    general,
    unitHeight: (unitType, attackTier, fireTier, rangeTier) =>
      unit(0, unitType, DIRECTION_SOUTH, attackTier, fireTier, rangeTier, false).modelHeight,
    dispose() {
      // Уничтожать обязательно, и это не педантизм: текстура живёт
      // в видеопамяти, а сборщик мусора о видеопамяти не знает. Кеш
      // сбрасывается при каждой смене матча — утечка накапливалась бы
      // матч за матчем.
      for (const sprite of units) sprite?.texture.destroy(true);
      for (const sprite of generals) sprite?.texture.destroy(true);
      units.fill(undefined);
      generals.fill(undefined);
    },
  };
};
