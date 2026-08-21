import { beforeEach, describe, expect, it } from 'vitest';
import { DIRECTION_SOUTH, StructureKind } from '@td/shared';
import {
  READINESS_STEPS,
  readinessStep,
  resetTowerCache,
  structureModelHeight,
  structureMuzzleHeight,
  structureSilhouette,
} from './towers.js';
import type { TowerColors, TowerSilhouette } from './towers.js';
import { CELL_SCREEN_AREA_PX, ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';

/**
 * Модели построек проверяются как чистые функции, без Pixi.
 *
 * Проверяется не картинка, а то, что в неё войдёт: сколько тел, есть ли
 * фактура, что поворачивается, а что стоит по клетке. Скриншот сказал бы
 * то же самое и перестал бы что-либо доказывать при первой смене палитры.
 */

const COLORS: TowerColors = {
  self: 0x00ff29,
  enemy: 0xd264ff,
  hullDark: 0x23271f,
};

/** Румб «на восток». Именованной константы у него в общем пакете нет. */
const DIRECTION_EAST = 1;

const SIDE_SELF = 0;
const SIDE_ENEMY = 1;

const BUILT = READINESS_STEPS - 1;

const TOWERS = [StructureKind.TowerBasic, StructureKind.TowerSniper] as const;
const MODELLED = [StructureKind.Wall, ...TOWERS] as const;

const built = (kind: StructureKind, facing = DIRECTION_SOUTH): TowerSilhouette =>
  structureSilhouette(COLORS, SIDE_SELF, kind, facing, BUILT);

const polygonCount = (silhouette: TowerSilhouette): number =>
  silhouette.fills.reduce((total, run) => total + run.polygons.length, 0);

const bounds = (silhouette: TowerSilhouette) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const run of silhouette.fills) {
    for (const polygon of run.polygons) {
      for (const point of polygon) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }
  }

  return { minX, maxX, minY, maxY };
};

beforeEach(() => {
  resetTowerCache();
});

describe('постройка выглядит сооружением', () => {
  it('модель собрана из нескольких тел', () => {
    for (const kind of MODELLED) {
      // Тело даёт от двух до шести граней, поэтому «многоугольников
      // больше шести» и означает «тел больше одного».
      expect(polygonCount(built(kind))).toBeGreaterThan(6);
    }
  });

  it('виды различаются составом модели, а не только размером', () => {
    const counts = MODELLED.map((kind) => polygonCount(built(kind)));

    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('снайперская башня выше базовой, а стена ниже обеих', () => {
    // Силуэт и есть сообщение: высокая и узкая означает дальнюю,
    // приземистая и широкая — скорострельную. Читаться это должно
    // раньше, чем игрок наведёт курсор.
    const wall = structureModelHeight(COLORS, StructureKind.Wall);
    const basic = structureModelHeight(COLORS, StructureKind.TowerBasic);
    const sniper = structureModelHeight(COLORS, StructureKind.TowerSniper);

    expect(wall).toBeLessThan(basic);
    expect(basic).toBeLessThan(sniper);
  });

  it('модель не выходит за свою клетку', () => {
    // Границы клетки игрок читает по постройке, и тело, вылезшее
    // за них, соврало бы о том, что занято.
    //
    // Сравнивается площадь габаритов, а не координаты: клетка
    // в проекции — косой параллелограмм, и «уместиться» для него
    // означает «не занять больше места, чем он сам», с запасом
    // на то, что габариты прямоугольные, а он нет.
    const cell = Math.sqrt(CELL_SCREEN_AREA_PX);

    for (const kind of MODELLED) {
      for (let facing = 1; facing <= 8; facing += 1) {
        const box = bounds(structureSilhouette(COLORS, SIDE_SELF, kind, facing, BUILT));
        const corners = [
          worldToScreen(-0.5, -0.5),
          worldToScreen(0.5, -0.5),
          worldToScreen(0.5, 0.5),
          worldToScreen(-0.5, 0.5),
        ];
        const reach = Math.max(...corners.map((point) => Math.abs(point.x)));

        expect(box.minX).toBeGreaterThanOrEqual(-reach - 1);
        expect(box.maxX).toBeLessThanOrEqual(reach + 1);
        // По высоте ограничения нет: башня и должна торчать вверх.
        expect(box.maxY - box.minY).toBeGreaterThan(cell * 0.3);
      }
    }
  });
});

describe('фактура', () => {
  it('на гранях есть что-то помимо самих граней', () => {
    // Тело даёт не больше шести видимых граней: верх и до пяти боковых
    // у восьмиугольника. Значит, многоугольников заметно больше, чем
    // шесть на тело, — и это и есть фактура.
    for (const kind of TOWERS) {
      const silhouette = built(kind);
      const outlined = silhouette.outline.length;

      expect(polygonCount(silhouette)).toBeGreaterThan(outlined * 2);
    }
  });

  it('самые яркие места модели несут цвет стороны', () => {
    // Корпус остаётся тёмным, принадлежность читается по светящимся
    // деталям. Поэтому чистый цвет стороны обязан встретиться в заливках.
    const mine = built(StructureKind.TowerBasic).fills.map((run) => run.color);
    resetTowerCache();
    const theirs = structureSilhouette(
      COLORS,
      SIDE_ENEMY,
      StructureKind.TowerBasic,
      DIRECTION_SOUTH,
      BUILT,
    ).fills.map((run) => run.color);

    expect(mine).toContain(COLORS.self);
    expect(theirs).toContain(COLORS.enemy);
  });

  it('чужая постройка окрашена иначе, чем своя', () => {
    const mine = built(StructureKind.TowerSniper).fills.map((run) => run.color);
    const theirs = structureSilhouette(
      COLORS,
      SIDE_ENEMY,
      StructureKind.TowerSniper,
      DIRECTION_SOUTH,
      BUILT,
    ).fills.map((run) => run.color);

    expect(mine).not.toEqual(theirs);
  });
});

describe('разворот турели', () => {
  it('поворот меняет модель башни', () => {
    expect(built(StructureKind.TowerBasic, DIRECTION_EAST).fills).not.toEqual(
      built(StructureKind.TowerBasic, DIRECTION_SOUTH).fills,
    );
  });

  it('постамент не поворачивается', () => {
    // Постамент стоит по клетке: повернись он на сорок пять градусов —
    // и вылез бы за неё, а границы клетки игрок читает по постройке.
    //
    // Сравнивается нижняя десятая доля клетки: ниже неё в модели нет
    // ничего, кроме постамента, поэтому «нижние многоугольники совпали»
    // и означает «постамент не тронулся».
    const floor = (silhouette: TowerSilhouette): string[] => {
      const limit = -0.1 * ELEVATION_PX_PER_CELL;

      return silhouette.fills
        .flatMap((run) => run.polygons)
        .filter((polygon) => polygon.every((point) => point.y >= limit))
        .map((polygon) => JSON.stringify(polygon))
        .sort();
    };

    const south = floor(built(StructureKind.TowerBasic, DIRECTION_SOUTH));
    const east = floor(built(StructureKind.TowerBasic, DIRECTION_EAST));

    expect(south.length).toBeGreaterThan(0);
    expect(south).toEqual(east);
  });

  it('стена от разворота не зависит: турели у неё нет', () => {
    expect(built(StructureKind.Wall, DIRECTION_EAST).fills).toEqual(
      built(StructureKind.Wall, DIRECTION_SOUTH).fills,
    );
  });
});

describe('ход возведения', () => {
  it('недострой ниже готовой постройки', () => {
    const early = structureSilhouette(COLORS, SIDE_SELF, StructureKind.TowerBasic, 3, 0);
    const done = built(StructureKind.TowerBasic);

    expect(early.height).toBeLessThan(done.height);
  });

  it('первый тик стройки уже виден', () => {
    // Совсем плоское тело сливается с землёй, а начатая стройка обязана
    // быть видна сразу: пустое место читается как «ничего не строится».
    const early = structureSilhouette(COLORS, SIDE_SELF, StructureKind.TowerBasic, 3, 0);

    expect(early.height).toBeGreaterThan(0);
    expect(polygonCount(early)).toBeGreaterThan(0);
  });

  it('у недостроя нет ствола', () => {
    // Ствол — второй признак готовности рядом с высотой: почти
    // достроенная башня по высоте от готовой уже почти не отличается.
    for (const kind of TOWERS) {
      const early = structureSilhouette(COLORS, SIDE_SELF, kind, DIRECTION_SOUTH, BUILT - 1);
      const done = built(kind);

      expect(polygonCount(early)).toBeLessThan(polygonCount(done));
    }
  });

  it('доля готовности переводится в ступень, и единица — в последнюю', () => {
    expect(readinessStep(1)).toBe(BUILT);
    expect(readinessStep(0)).toBe(0);
    // Почти готовая обязана отличаться от готовой, иначе ствол появится
    // до срока.
    expect(readinessStep(0.99)).toBeLessThan(BUILT);
    expect(readinessStep(0.5)).toBeGreaterThan(0);
  });

  it('возведение не плодит записей кеша', () => {
    // Непрерывная доля готовности означала бы новую запись на каждый
    // кадр возведения, то есть кеш, который никогда не попадает.
    const steps = new Set<number>();
    for (let frame = 0; frame <= 200; frame += 1) {
      steps.add(readinessStep(frame / 200));
    }

    expect(steps.size).toBeLessThanOrEqual(READINESS_STEPS);
  });
});

describe('кеш силуэтов', () => {
  it('повторный запрос возвращает ту же запись', () => {
    expect(built(StructureKind.TowerSniper)).toBe(built(StructureKind.TowerSniper));
  });

  it('смена палитры строит силуэты заново', () => {
    const before = built(StructureKind.TowerBasic);
    const other = structureSilhouette(
      { ...COLORS },
      SIDE_SELF,
      StructureKind.TowerBasic,
      DIRECTION_SOUTH,
      BUILT,
    );

    expect(other).not.toBe(before);
  });
});

describe('дульный срез', () => {
  it('у снайперской башни выше, чем у базовой', () => {
    expect(structureMuzzleHeight(StructureKind.TowerSniper)).toBeGreaterThan(
      structureMuzzleHeight(StructureKind.TowerBasic),
    );
  });

  it('лежит внутри модели, а не над ней и не под землёй', () => {
    // Выстрел обязан выходить из ствола: и из-под днища, и из воздуха
    // над башней он выглядит одинаково неверно.
    for (const kind of TOWERS) {
      const height = structureModelHeight(COLORS, kind);
      const muzzle = structureMuzzleHeight(kind);

      expect(muzzle).toBeGreaterThan(height * 0.4);
      expect(muzzle).toBeLessThan(height);
    }
  });
});
