import { describe, expect, it } from 'vitest';
import { FACE_LIGHT, faceLight, forEachDiagonal, prismFaces, shade, solidFaces } from './prism.js';
import { ELEVATION_PX_PER_CELL } from './iso.js';

const unitPrism = (height: number) => ({ x: 4, y: 7, width: 1, depth: 1, height });

describe('призма', () => {
  it('при нулевой высоте боковых граней нет', () => {
    const faces = prismFaces(unitPrism(0));

    expect(faces.top).toHaveLength(4);
    expect(faces.left).toHaveLength(0);
    expect(faces.right).toHaveLength(0);
  });

  it('при нулевой высоте верхняя грань совпадает с основанием', () => {
    const flat = prismFaces(unitPrism(0));
    const raised = prismFaces(unitPrism(1));

    // toBeCloseTo, а не toBe: высота единицы теперь равна масштабу,
    // умноженному на косинус наклона камеры, то есть числу иррациональному.
    expect(flat.top[0]?.y).toBeCloseTo((raised.top[0]?.y ?? 0) + ELEVATION_PX_PER_CELL, 9);
  });

  it('смещение верхней грани пропорционально высоте', () => {
    const base = prismFaces(unitPrism(0)).top[0]?.y ?? 0;
    const one = prismFaces(unitPrism(1)).top[0]?.y ?? 0;
    const two = prismFaces(unitPrism(2)).top[0]?.y ?? 0;

    expect(base - one).toBeCloseTo(ELEVATION_PX_PER_CELL, 9);
    expect(base - two).toBeCloseTo(2 * ELEVATION_PX_PER_CELL, 9);
  });

  it('боковые грани четырёхугольные', () => {
    const faces = prismFaces(unitPrism(1));

    expect(faces.left).toHaveLength(4);
    expect(faces.right).toHaveLength(4);
  });

  it('высота не меняет положение по горизонтали', () => {
    const flat = prismFaces(unitPrism(0));
    const raised = prismFaces(unitPrism(3));

    expect(raised.top[0]?.x).toBe(flat.top[0]?.x);
  });
});

describe('освещение', () => {
  it('верхняя грань светлее правой, правая светлее левой', () => {
    expect(FACE_LIGHT.top).toBeGreaterThan(FACE_LIGHT.right);
    expect(FACE_LIGHT.right).toBeGreaterThan(FACE_LIGHT.left);
  });

  it('затенение работает покомпонентно и не выходит за границы канала', () => {
    expect(shade(0xffffff, 1)).toBe(0xffffff);
    expect(shade(0xffffff, 0.5)).toBe(0x808080);
    expect(shade(0x00ff29, 0)).toBe(0x000000);
  });

  it('множители одинаковы для любого цвета', () => {
    // Освещение — свойство грани, а не объекта: камень и здание затеняются
    // одинаково, иначе они читаются как части разных миров.
    const rock = shade(0x6e6a63, FACE_LIGHT.left);
    const building = shade(0x00ff29, FACE_LIGHT.left);

    expect((rock >> 16) & 0xff).toBe(Math.round(0x6e * FACE_LIGHT.left));
    expect((building >> 8) & 0xff).toBe(Math.round(0xff * FACE_LIGHT.left));
  });
});

describe('тело с произвольным основанием', () => {
  const RECTANGLE = [
    { x: 4, y: 7 },
    { x: 5, y: 7 },
    { x: 5, y: 8 },
    { x: 4, y: 8 },
  ];

  /** Многоугольник как неупорядоченное множество углов. */
  const corners = (points: readonly { x: number; y: number }[]): string[] =>
    points.map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`).sort();

  it('на прямоугольнике даёт те же грани, что призма', () => {
    // Два кода для одного и того же существуют осознанно: призма знает свои
    // видимые грани заранее и не считает нормалей. Разъехаться им нельзя,
    // и этот тест — единственное, что за этим следит.
    const general = solidFaces(RECTANGLE, 1);
    const special = prismFaces({ x: 4, y: 7, width: 1, depth: 1, height: 1 });

    expect(general.sides).toHaveLength(2);
    expect(corners(general.top.points)).toEqual(corners(special.top));

    const sides = general.sides.map((face) => corners(face.points));
    expect(sides).toContainEqual(corners(special.left));
    expect(sides).toContainEqual(corners(special.right));
  });

  it('яркость по нормали совпадает с прежними множителями', () => {
    // Совпадение обязательно: разъедься числа хоть на процент, неподвижная
    // башня и повёрнутая рядом машина оказались бы освещены разными
    // источниками, и мир перестал бы читаться единым.
    expect(faceLight(1, 0)).toBeCloseTo(FACE_LIGHT.right, 12);
    expect(faceLight(0, 1)).toBeCloseTo(FACE_LIGHT.left, 12);
  });

  it('грань, обращённая от источника, не темнее фонового уровня', () => {
    const back = faceLight(-1, 0);

    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThan(FACE_LIGHT.left);
    expect(faceLight(-1, 0)).toBe(faceLight(0, -1));
  });

  it('яркость видимых граней меняется с поворотом', () => {
    const straight = solidFaces(RECTANGLE, 1);
    // Тот же квадрат, повёрнутый на 45 градусов вокруг своего центра.
    const half = Math.SQRT1_2 / 2;
    const turned = solidFaces(
      [
        { x: 4.5, y: 7.5 - half * 2 },
        { x: 4.5 + half * 2, y: 7.5 },
        { x: 4.5, y: 7.5 + half * 2 },
        { x: 4.5 - half * 2, y: 7.5 },
      ],
      1,
    );

    const brightness = (faces: typeof straight): number[] =>
      faces.sides.map((face) => face.light).sort((a, b) => a - b);

    expect(brightness(turned)).not.toEqual(brightness(straight));
  });

  it('обращённых от зрителя граней не строит', () => {
    // Из четырёх боковых граней зритель видит ровно две при любом повороте:
    // остальные обращены от него.
    for (let step = 0; step < 8; step += 1) {
      const angle = (step * Math.PI) / 4;
      const rotated = RECTANGLE.map((point) => {
        const dx = point.x - 4.5;
        const dy = point.y - 7.5;
        return {
          x: 4.5 + dx * Math.cos(angle) - dy * Math.sin(angle),
          y: 7.5 + dx * Math.sin(angle) + dy * Math.cos(angle),
        };
      });

      expect(solidFaces(rotated, 1).sides).toHaveLength(2);
    }
  });

  it('при нулевой высоте боковых граней нет', () => {
    expect(solidFaces(RECTANGLE, 0).sides).toHaveLength(0);
    expect(solidFaces(RECTANGLE, 0).top.points).toHaveLength(4);
  });

  it('поднятое основание смещает тело вверх целиком', () => {
    const onGround = solidFaces(RECTANGLE, 0.5);
    const raised = solidFaces(RECTANGLE, 0.5, 1);

    const lift = (onGround.top.points[0]?.y ?? 0) - (raised.top.points[0]?.y ?? 0);
    expect(lift).toBeCloseTo(ELEVATION_PX_PER_CELL, 9);
  });
});

describe('обход по диагоналям', () => {
  it('выдаёт клетки в порядке неубывания суммы координат', () => {
    let previousSum = -1;

    forEachDiagonal(6, 4, (cells) => {
      for (const [x, y] of cells) {
        expect(x + y).toBeGreaterThanOrEqual(previousSum);
      }
      previousSum = (cells[0]?.[0] ?? 0) + (cells[0]?.[1] ?? 0);
    });
  });

  it('внутри одной диагонали сумма координат одинакова', () => {
    forEachDiagonal(6, 4, (cells) => {
      const sums = new Set(cells.map(([x, y]) => x + y));
      expect(sums.size).toBe(1);
    });
  });

  it('покрывает каждую клетку ровно один раз', () => {
    const seen = new Set<string>();
    let total = 0;

    forEachDiagonal(6, 4, (cells) => {
      for (const [x, y] of cells) {
        seen.add(`${x},${y}`);
        total += 1;
      }
    });

    expect(total).toBe(24);
    expect(seen.size).toBe(24);
  });

  it('не выходит за границы карты', () => {
    forEachDiagonal(6, 4, (cells) => {
      for (const [x, y] of cells) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(6);
        expect(y).toBeLessThan(4);
      }
    });
  });
});
