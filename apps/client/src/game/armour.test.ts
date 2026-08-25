import { describe, expect, it } from 'vitest';
import { DIRECTION_SOUTH, UnitType } from '@td/shared';
import { DEFAULT_BEVEL, buildArmourMesh } from './armour.js';
import type { Solid, Vec3 } from './armour.js';
import { AMBIENT, LIGHT } from './armour-render.js';
import { unitSolids } from './machines.js';
import { MIRROR_SQUASH } from './models.js';
import { faceLight } from './prism.js';

/**
 * Сборка сетки проверяется числами, а не картинкой.
 *
 * Картинку даёт видеокарта, которой в прогоне тестов нет, — но всё, чем
 * новая отрисовка отличается от прежней, лежит до неё: нормали, кромка,
 * гладкость круглых тел, опрокидывание отражения. Ошибка в любом из этих
 * мест видна в числах раньше, чем на экране.
 */

const box = (
  forward: number,
  side: number,
  up: number,
  length: number,
  width: number,
  height: number,
): Solid => ({
  label: 'коробка',
  bottom: [
    { forward: forward + length / 2, side: side + width / 2, up },
    { forward: forward + length / 2, side: side - width / 2, up },
    { forward: forward - length / 2, side: side - width / 2, up },
    { forward: forward - length / 2, side: side + width / 2, up },
  ],
  top: [
    { forward: forward + length / 2, side: side + width / 2, up: up + height },
    { forward: forward + length / 2, side: side - width / 2, up: up + height },
    { forward: forward - length / 2, side: side - width / 2, up: up + height },
    { forward: forward - length / 2, side: side + width / 2, up: up + height },
  ],
  material: 0,
});

const cylinder = (radius: number, corners: number): Solid => {
  const ring = (side: number): Vec3[] => {
    const points: Vec3[] = [];
    for (let index = 0; index < corners; index += 1) {
      const angle = ((index + 0.5) * Math.PI * 2) / corners;
      points.push({
        forward: Math.cos(angle) * radius,
        side,
        up: 0.2 + Math.sin(angle) * radius,
      });
    }

    return points;
  };

  return { label: 'каток', bottom: ring(-0.03), top: ring(0.03), material: 0, round: true };
};

/** Нормали вершин сетки как тройки чисел. */
const normalsOf = (mesh: { normals: Float32Array }): [number, number, number][] => {
  const result: [number, number, number][] = [];
  for (let index = 0; index * 3 < mesh.normals.length; index += 1) {
    result.push([
      mesh.normals[index * 3] as number,
      mesh.normals[index * 3 + 1] as number,
      mesh.normals[index * 3 + 2] as number,
    ]);
  }

  return result;
};

describe('сборка сетки', () => {
  it('строит треугольники и не выходит за пределы вершин', () => {
    const mesh = buildArmourMesh([box(0, 0, 0, 0.4, 0.3, 0.1)], DIRECTION_SOUTH);
    const vertices = mesh.positions.length / 2;

    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    for (const index of mesh.indices) expect(index).toBeLessThan(vertices);
  });

  it('нормали единичные', () => {
    const mesh = buildArmourMesh(unitSolids(UnitType.Assault, 1, 1, 0), 2);

    for (const [x, y, z] of normalsOf(mesh)) {
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 5);
    }
  });

  it('габариты совпадают с координатами вершин', () => {
    const mesh = buildArmourMesh([box(0, 0, 0, 0.4, 0.3, 0.1)], DIRECTION_SOUTH);
    let maxX = 0;
    let maxY = 0;

    for (let index = 0; index * 2 < mesh.positions.length; index += 1) {
      maxX = Math.max(maxX, mesh.positions[index * 2] as number);
      maxY = Math.max(maxY, mesh.positions[index * 2 + 1] as number);
    }

    expect(mesh.width).toBeGreaterThanOrEqual(maxX);
    expect(mesh.height).toBeGreaterThanOrEqual(maxY);
    expect(mesh.width - maxX).toBeLessThan(1);
    expect(mesh.height - maxY).toBeLessThan(1);
  });

  it('одинаковые входы дают одинаковую сетку', () => {
    // Кеш спрайтов держится ровно на этом: две одинаковые машины в разных
    // концах карты обязаны давать одну и ту же картинку.
    const first = buildArmourMesh(unitSolids(UnitType.Sniper, 0, 0, 0), 4);
    const second = buildArmourMesh(unitSolids(UnitType.Sniper, 0, 0, 0), 4);

    expect(Array.from(first.positions)).toEqual(Array.from(second.positions));
    expect(Array.from(first.normals)).toEqual(Array.from(second.normals));
  });
});

describe('кромка', () => {
  it('вдоль контура грани нормаль отвёрнута наружу', () => {
    // У коробки без кромки нормалей ровно три — по числу видимых граней.
    // Кромка добавляет к каждой грани поясок со своими направлениями.
    const mesh = buildArmourMesh([box(0, 0, 0, 0.4, 0.3, 0.1)], DIRECTION_SOUTH);
    const distinct = new Set(normalsOf(mesh).map((normal) => normal.join(',')));

    expect(distinct.size).toBeGreaterThan(6);
  });

  it('не меняет очертания тела', () => {
    // Поясок лежит в плоскости своей грани: внешний контур остаётся тем же,
    // меняется только направление нормали на нём.
    const narrow = buildArmourMesh([box(0, 0, 0, 0.4, 0.3, 0.1)], DIRECTION_SOUTH, false, {
      ...DEFAULT_BEVEL,
      width: DEFAULT_BEVEL.width / 4,
    });
    const wide = buildArmourMesh([box(0, 0, 0, 0.4, 0.3, 0.1)], DIRECTION_SOUTH, false, {
      ...DEFAULT_BEVEL,
      width: DEFAULT_BEVEL.width * 2,
    });

    expect(wide.width).toBe(narrow.width);
    expect(wide.height).toBe(narrow.height);
    expect(wide.offsetX).toBeCloseTo(narrow.offsetX, 6);
    expect(wide.offsetY).toBeCloseTo(narrow.offsetY, 6);
  });

  it('не выворачивает тонкую деталь', () => {
    // Планка решётки тоньше двух кромок. Без ограничения внутренний контур
    // перехлестнулся бы сам через себя, и грань свернулась бы в ленту.
    const thin = box(0, 0, 0.2, 0.016, 0.19, 0.007);
    const mesh = buildArmourMesh([thin], DIRECTION_SOUTH);

    expect(mesh.indices.length).toBeGreaterThan(0);
    for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('круглые тела', () => {
  it('свет по ободу идёт без ступеней', () => {
    // Ступень на ребре — это разрыв нормали: две соседние грани приходят
    // в общий угол с разными направлениями. У круглого тела в этом углу
    // направление одно на обе грани, и разрыва нет.
    //
    // Кромка на время проверки выключена: она добавляет к каждому углу
    // свои направления и заслонила бы то, что проверяется.
    const SHARP = { width: 0, tilt: 0, maxInset: 0 };
    const flat = buildArmourMesh(
      [{ ...cylinder(0.07, 14), round: false }],
      DIRECTION_SOUTH,
      false,
      SHARP,
    );
    const round = buildArmourMesh([cylinder(0.07, 14)], DIRECTION_SOUTH, false, SHARP);

    /** Сколько разных направлений сходится в самом «людном» углу. */
    const worstCorner = (mesh: { positions: Float32Array; normals: Float32Array }): number => {
      const corners = new Map<string, Set<string>>();
      const normals = normalsOf(mesh);

      for (let index = 0; index < normals.length; index += 1) {
        const key = `${(mesh.positions[index * 2] as number).toFixed(3)}:${(
          mesh.positions[index * 2 + 1] as number
        ).toFixed(3)}`;
        const found = corners.get(key) ?? new Set<string>();
        found.add((normals[index] as number[]).map((value) => value.toFixed(3)).join(','));
        corners.set(key, found);
      }

      return Math.max(...[...corners.values()].map((set) => set.size));
    };

    expect(worstCorner(flat)).toBeGreaterThan(worstCorner(round));
  });

  it('в силуэте нет щелей на краях', () => {
    // Крайнюю грань трубы видно ребром, и в одном её углу усреднённая
    // нормаль уже смотрит от зрителя. Отсеки мы грань по первому углу —
    // в силуэте появилась бы щель.
    const round = buildArmourMesh([cylinder(0.07, 16)], DIRECTION_SOUTH);
    const flat = buildArmourMesh([{ ...cylinder(0.07, 16), round: false }], DIRECTION_SOUTH);

    expect(round.width).toBe(flat.width);
    expect(round.height).toBe(flat.height);
  });
});

describe('отражение', () => {
  it('уходит под точку опоры, а машина остаётся над ней', () => {
    const solids = unitSolids(UnitType.Assault, 0, 0, 0);
    const body = buildArmourMesh(solids, DIRECTION_SOUTH);
    const mirror = buildArmourMesh(solids, DIRECTION_SOUTH, true);

    // Экранная `y` растёт вниз: у тела верхняя кромка выше опоры,
    // у отражения нижняя — ниже её.
    expect(body.offsetY).toBeLessThan(0);
    expect(mirror.offsetY + mirror.height).toBeGreaterThan(0);
  });

  it('сплюснуто ровно вдвое', () => {
    // Основание нарочно крошечное: у обычного тела в экранную высоту
    // входит ещё и ромб основания, а он при опрокидывании не сжимается,
    // и отношение вышло бы не про сплюснутость.
    const solids = [box(0, 0, 0.1, 0.002, 0.002, 0.2)];
    const body = buildArmourMesh(solids, DIRECTION_SOUTH);
    const mirror = buildArmourMesh(solids, DIRECTION_SOUTH, true);

    expect(mirror.height / body.height).toBeCloseTo(MIRROR_SQUASH, 1);
  });

  it('лежит целиком ниже точки касания', () => {
    // Отражение начинается там, где машина касалась бы земли, и уходит
    // вниз. Заедь оно выше — читалось бы не отражением, а второй машиной.
    const solids = [box(0, 0, 0.1, 0.002, 0.002, 0.2)];
    const mirror = buildArmourMesh(solids, DIRECTION_SOUTH, true);

    expect(mirror.offsetY).toBeGreaterThan(0);
  });
});

describe('освещение', () => {
  it('источник тот же, что у построек', () => {
    // Числа в шейдере и числа в `prism.ts` — это один источник света.
    // Разъедься они, машина и стоящая рядом башня оказались бы в разных
    // мирах, и это читается ошибкой даже без объяснения, что не так.
    const lit = (x: number, y: number, z: number): number =>
      Math.min(1, AMBIENT + Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]));

    expect(lit(0, 0, 1)).toBeCloseTo(faceLight(0, 0, 1), 10);
    expect(lit(1, 0, 0)).toBeCloseTo(faceLight(1, 0), 10);
    expect(lit(0, 1, 0)).toBeCloseTo(faceLight(0, 1), 10);
    expect(lit(-1, 0, 0)).toBeCloseTo(AMBIENT, 10);
  });
});
