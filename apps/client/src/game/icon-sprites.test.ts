import { DIRECTION_SOUTH, StructureKind, UNIT_TYPES } from '@td/shared';
import { describe, expect, it } from 'vitest';
import { worldToScreen } from './iso.js';
import {
  ICON_BAKE_PARAMS,
  ICON_KEYS,
  SIDE_ENEMY,
  SIDE_SELF,
  generalIconKey,
  structureIconKey,
  unitIconKey,
} from './icon-sprites.js';
import { WALL_LINK_NORTH, WALL_LINK_SOUTH, WallShape, wallLook } from './structures.js';

/**
 * Проверки запекателя иконок.
 *
 * Само запекание требует видеокарты и здесь не проверяется — его смотрят
 * снимком. Проверяется то, что от видеокарты не зависит и молча
 * разъезжается: состав набора, ракурс и облик стены.
 */

describe('набор иконок', () => {
  it('покрывает обе стороны', () => {
    for (const side of [SIDE_SELF, SIDE_ENEMY]) {
      for (const unitType of UNIT_TYPES) {
        expect(ICON_KEYS).toContain(unitIconKey(unitType, side));
      }

      expect(ICON_KEYS).toContain(generalIconKey(side));
      expect(ICON_KEYS).toContain(structureIconKey(StructureKind.Wall, side));
      expect(ICON_KEYS).toContain(structureIconKey(StructureKind.TowerBasic, side));
      expect(ICON_KEYS).toContain(structureIconKey(StructureKind.TowerSniper, side));
    }
  });

  it('не содержит базы: её тело печёт другой запекатель', () => {
    for (const side of [SIDE_SELF, SIDE_ENEMY]) {
      expect(ICON_KEYS).not.toContain(structureIconKey(StructureKind.Base, side));
    }
  });

  it('своё идёт раньше чужого', () => {
    const firstEnemy = ICON_KEYS.findIndex((key) => key.endsWith(`-${String(SIDE_ENEMY)}`));
    const lastSelf = ICON_KEYS.reduce(
      (found, key, index) => (key.endsWith(`-${String(SIDE_SELF)}`) ? index : found),
      -1,
    );

    // Плитки заказа и строки прокачки показывают только своё, и они
    // на экране всё время; чужое живёт в одной сводке из шести значков.
    expect(lastSelf).toBeLessThan(firstEnemy);
  });

  it('ключи не повторяются', () => {
    expect(new Set(ICON_KEYS).size).toBe(ICON_KEYS.length);
  });
});

describe('ракурс иконки', () => {
  it('юг — это ровно «влево вниз» на экране', () => {
    expect(ICON_BAKE_PARAMS.facing).toBe(DIRECTION_SOUTH);

    // Мировой юг — это (0, +1). Проверяем не название румба, а то,
    // куда он смотрит на экране: влево (x убывает) и вниз (y растёт).
    // Иначе правка углов проекции молча развернула бы все иконки.
    const origin = worldToScreen(0, 0);
    const south = worldToScreen(0, 1);

    expect(south.x).toBeLessThan(origin.x);
    expect(south.y).toBeGreaterThan(origin.y);
  });

  it('ступени прокачки на иконку не влияют', () => {
    // Плитка, меняющая картинку от покупки дальности, читается как другая
    // плитка, а не как та же с длинным стволом.
    expect(ICON_BAKE_PARAMS.tier).toBe(0);
  });
});

describe('облик стены', () => {
  it('прямой участок, а не столб', () => {
    expect(ICON_BAKE_PARAMS.wallLook).toBe(WALL_LINK_SOUTH | WALL_LINK_NORTH);
    expect(wallLook(ICON_BAKE_PARAMS.wallLook).shape).toBe(WallShape.Straight);
  });
});

describe('разрешение', () => {
  it('иконка плотнее показываемого размера', () => {
    // Модель юнита занимает на поле около полусотни точек, а показывается
    // иконка на тридцати-сорока. Ниже четырёх кратность перестанет
    // покрывать тройную плотность экрана.
    expect(ICON_BAKE_PARAMS.resolution).toBeGreaterThanOrEqual(4);
  });
});
