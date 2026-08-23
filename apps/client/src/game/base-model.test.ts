import { describe, expect, it } from 'vitest';
import {
  BASE_ANTENNA_HEIGHT,
  BASE_DISH,
  BASE_DISH_MOUNT,
  BASE_FOOTPRINT_CELLS,
  BASE_HALF_CELLS,
  BASE_LIGHTS,
  BASE_SOLIDS,
  BASE_STRUTS,
  BASE_TOP_LEVEL,
  BaseMaterial,
  LOW_LIMIT,
  MAST_X,
  MAST_Y,
  NEAR_HALF_LIMIT,
} from './base-model.js';
import type { BasePoint, BaseSolid } from './base-model.js';
import { MAX_RELIEF_HEIGHT } from './relief.js';

/**
 * Модель проверяется числами, а не картинкой, и проверок здесь две
 * породы. Первая — про габарит: база обязана совпадать с клетками
 * и умещаться в расчищенную площадку. Вторая — про компоновку: высокое
 * стоит в дальней половине, потому что в ближней появляются юниты.
 * Вторая важнее: сломать её можно, подвинув одно тело, и на картинке
 * это будет выглядеть не ошибкой, а «машина заехала в стену».
 */

const solidOf = (label: string): BaseSolid => {
  const solid = BASE_SOLIDS.find((candidate) => candidate.label === label);
  if (solid === undefined) throw new Error(`нет тела «${label}»`);

  return solid;
};

const top = (solid: BaseSolid): number => solid.base + solid.height;

const centre = (solid: BaseSolid): { x: number; y: number } => ({
  x: solid.x + solid.width / 2,
  y: solid.y + solid.depth / 2,
});

const inside = (x: number, y: number): boolean =>
  x >= -BASE_HALF_CELLS - 1e-9 &&
  x <= BASE_HALF_CELLS + 1e-9 &&
  y >= -BASE_HALF_CELLS - 1e-9 &&
  y <= BASE_HALF_CELLS + 1e-9;

describe('площадка командного центра', () => {
  it('занимает четыре клетки на четыре', () => {
    expect(BASE_FOOTPRINT_CELLS).toBe(16);
    expect(BASE_HALF_CELLS * 2).toBe(4);
  });

  it('края подиума лежат по границам клеток', () => {
    // Центр модели — узел сетки, сторона чётная, поэтому края
    // приходятся ровно на границы клеток. Половинчатое накрытие
    // читалось бы как «база стоит криво».
    const podium = solidOf('подиум');

    expect(podium.x).toBe(-BASE_HALF_CELLS);
    expect(podium.y).toBe(-BASE_HALF_CELLS);
    expect(podium.width).toBe(BASE_HALF_CELLS * 2);
    expect(podium.depth).toBe(BASE_HALF_CELLS * 2);
  });

  it('ни одно тело не выходит за площадку', () => {
    for (const solid of [...BASE_SOLIDS, BASE_DISH_MOUNT]) {
      expect(inside(solid.x, solid.y), solid.label).toBe(true);
      expect(inside(solid.x + solid.width, solid.y + solid.depth), solid.label).toBe(true);
    }
  });

  it('ни одна наклейка не сползает с площадки', () => {
    for (const solid of BASE_SOLIDS) {
      for (const decal of solid.decals ?? []) {
        for (const point of decal.points) {
          expect(inside(point.x, point.y), `${solid.label}: наклейка`).toBe(true);
        }
      }
    }
  });

  it('конструкция и огни остаются внутри площадки', () => {
    const points: BasePoint[] = [
      ...BASE_STRUTS.flatMap((strut) => [strut.from, strut.to]),
      ...BASE_LIGHTS.map((light) => light.at),
    ];

    for (const point of points) {
      expect(inside(point.x, point.y)).toBe(true);
    }
  });

  it('умещается в расчищенную генерацией площадку', () => {
    // Генерация расчищает две клетки вокруг базы, то есть пять на пять.
    // Наши четыре на четыре умещаются, и запас в половину клетки
    // с каждой стороны — то, ради чего размер не взят пять на пять.
    expect(BASE_HALF_CELLS * 2).toBeLessThan(5);
  });
});

describe('компоновка: высокое в дальней половине', () => {
  it('в ближней половине нет ничего выше низкой детали', () => {
    // Правило держится на симуляции: юнит появляется на ближайшей
    // свободной клетке вокруг клетки базы, а клетка базы лежит
    // в ближней половине.
    for (const solid of BASE_SOLIDS) {
      const at = centre(solid);
      if (at.x + at.y <= NEAR_HALF_LIMIT) continue;

      expect(solid.height, `${solid.label} стои́т в ближней половине`).toBeLessThanOrEqual(
        LOW_LIMIT,
      );
    }
  });

  it('самое высокое тело ближней половины ниже самого высокого дальней', () => {
    let near = 0;
    let far = 0;

    for (const solid of BASE_SOLIDS) {
      const at = centre(solid);
      if (at.x + at.y > NEAR_HALF_LIMIT) near = Math.max(near, top(solid));
      else far = Math.max(far, top(solid));
    }

    expect(near).toBeLessThan(far);
  });
});

describe('состав сооружения', () => {
  it('несёт главный корпус, пристройку, антенну и пусковую установку', () => {
    expect(solidOf('главный корпус').height).toBeGreaterThan(0.9);
    expect(solidOf('оперативная пристройка').height).toBeGreaterThan(0.3);
    expect(solidOf('основание мачты')).toBeDefined();
    expect(solidOf('площадка пусковой установки')).toBeDefined();
    expect(BASE_DISH.radius).toBeGreaterThan(0.2);
  });

  it('читается обжитым: подиум, ограждение и разметка на месте', () => {
    expect(solidOf('подиум')).toBeDefined();
    expect(solidOf('аппарель')).toBeDefined();

    const marks = BASE_SOLIDS.flatMap((solid) => solid.decals ?? []);
    expect(marks.length).toBeGreaterThan(10);

    // Ограждение — это стойки и поручни, то есть отрезки, а не тела.
    expect(BASE_STRUTS.length).toBeGreaterThan(50);
  });

  it('антенна выше главного корпуса, пристройка ниже него', () => {
    const hull = top(solidOf('главный корпус'));

    expect(BASE_ANTENNA_HEIGHT).toBeGreaterThan(hull);
    expect(top(solidOf('оперативная пристройка'))).toBeLessThan(hull);
  });

  it('остаётся выше любой скалы', () => {
    expect(BASE_ANTENNA_HEIGHT).toBeGreaterThan(MAX_RELIEF_HEIGHT);
  });

  it('принадлежность несут мелкие светящиеся места, а не корпус', () => {
    const neonSolids = BASE_SOLIDS.filter((solid) => solid.material === BaseMaterial.Neon);
    const neonDecals = BASE_SOLIDS.flatMap((solid) => solid.decals ?? []).filter(
      (decal) => decal.material === BaseMaterial.Neon,
    );

    // Ни одно ТЕЛО не залито неоном: крупная площадь цвета стороны
    // выжигает грани, и деталей на ней не видно.
    expect(neonSolids).toHaveLength(0);
    expect(neonDecals.length).toBeGreaterThan(5);
    expect(BASE_LIGHTS.length).toBeGreaterThan(2);
  });
});

describe('мачта', () => {
  /** Отступ точки от оси мачты. */
  const fromAxis = (point: BasePoint): number => Math.hypot(point.x - MAST_X, point.y - MAST_Y);

  /**
   * Точки самой фермы: те, что лежат у оси. Отбор по расстоянию,
   * а не по толщине линии — толщину легко поменять, и проверка
   * молча начала бы мерить пусковую установку вместо мачты.
   */
  const mastPoints = BASE_STRUTS.flatMap((strut) => [strut.from, strut.to]).filter(
    (point) => fromAxis(point) < 0.3 && point.z > 0.4,
  );

  it('ферма доходит до заявленной высоты', () => {
    const highest = Math.max(...mastPoints.map((point) => point.z));

    expect(highest).toBeCloseTo(BASE_ANTENNA_HEIGHT, 6);
  });

  it('пояса сужаются кверху', () => {
    const bottom = Math.min(...mastPoints.map((point) => point.z));
    const spreadAt = (level: number): number =>
      Math.max(
        ...mastPoints
          .filter((point) => Math.abs(point.z - level) < 0.02)
          .map((point) => fromAxis(point)),
      );

    const near = spreadAt(bottom);
    const far = spreadAt(BASE_ANTENNA_HEIGHT);

    expect(near).toBeGreaterThan(0.15);
    expect(far).toBeGreaterThan(0.02);
    expect(far).toBeLessThan(near * 0.6);
  });

  it('раскосы идут между поясами, а не вдоль них', () => {
    // Раскос отличается тем, что меняет и высоту, и положение: пояс
    // поднимается почти отвесно, раскос — наискось.
    const braces = BASE_STRUTS.filter(
      (strut) =>
        Math.abs(strut.from.z - strut.to.z) > 0.05 &&
        Math.hypot(strut.from.x - strut.to.x, strut.from.y - strut.to.y) > 0.05,
    );

    expect(braces.length).toBeGreaterThan(20);
  });

  it('оттяжки идут от мачты к якорям на площадке', () => {
    const guys = BASE_STRUTS.filter((strut) => (strut.alpha ?? 1) < 0.6);

    expect(guys).toHaveLength(3);

    for (const guy of guys) {
      expect(Math.hypot(guy.from.x - MAST_X, guy.from.y - MAST_Y)).toBeLessThan(0.1);
      expect(guy.to.z).toBeLessThan(0.3);
      expect(Math.hypot(guy.to.x - MAST_X, guy.to.y - MAST_Y)).toBeGreaterThan(0.8);
    }
  });

  it('чаша стоит на поворотном устройстве над вершиной мачты', () => {
    expect(BASE_DISH_MOUNT.base).toBeLessThanOrEqual(BASE_ANTENNA_HEIGHT);
    expect(BASE_DISH_MOUNT.base + BASE_DISH_MOUNT.height).toBeGreaterThan(BASE_ANTENNA_HEIGHT);
    expect(BASE_DISH.centre.z).toBeGreaterThan(BASE_ANTENNA_HEIGHT);
    expect(BASE_DISH.centre.x).toBeCloseTo(MAST_X, 6);
  });

  it('верх сооружения выше и мачты, и чаши', () => {
    expect(BASE_TOP_LEVEL).toBeGreaterThan(BASE_DISH.centre.z);
    expect(BASE_TOP_LEVEL).toBeGreaterThan(BASE_ANTENNA_HEIGHT);
  });
});
