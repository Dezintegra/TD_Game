import { describe, expect, it } from 'vitest';
import { MAP_CELL_COUNT, MAP_WIDTH_CELLS, Terrain } from '@td/shared';
import type { GameMap } from '@td/sim';
import {
  FOOT_WIDTH_CELLS,
  cellHeight,
  edgeDistance,
  fbm,
  footFactor,
  grainOffset,
  isRockCell,
  surfaceHeight,
  surfaceNormal,
  valueNoise,
} from './relief.js';
import { rockHeight } from './rocks.js';

const mapWithRockBlock = (left: number, top: number, size: number): GameMap => {
  const cells = new Uint8Array(MAP_CELL_COUNT);

  for (let y = top; y < top + size; y += 1) {
    for (let x = left; x < left + size; x += 1) {
      cells[y * MAP_WIDTH_CELLS + x] = Terrain.Rock;
    }
  }

  return { cells, baseCells: [] };
};

/** Массив 6 × 6 с левым верхним углом в (10, 10). Внутренние клетки — с 11 по 14. */
const BLOCK = mapWithRockBlock(10, 10, 6);

describe('дробный шум', () => {
  it('одна и та же точка даёт одно и то же значение', () => {
    expect(valueNoise(3.25, 7.5, 11)).toBe(valueNoise(3.25, 7.5, 11));
    expect(fbm(3.25, 7.5, 11, 3)).toBe(fbm(3.25, 7.5, 11, 3));
  });

  it('значения лежат в объявленных границах при любом числе октав', () => {
    for (let octaves = 1; octaves <= 5; octaves += 1) {
      for (let index = 0; index < 200; index += 1) {
        const value = fbm(index * 0.37, index * 0.11, 5, octaves);

        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });

  it('шум гладкий: соседние точки близки', () => {
    // Ради этого он и заведён отдельно от потока из `noise.ts`: там числа
    // независимы, и поверхности из них не выйдет.
    let biggest = 0;
    for (let index = 0; index < 300; index += 1) {
      const x = index * 0.013;
      const step = Math.abs(valueNoise(x + 0.01, 4.2, 9) - valueNoise(x, 4.2, 9));
      biggest = Math.max(biggest, step);
    }

    expect(biggest).toBeLessThan(0.05);
  });

  it('разные зёрна дают разный рисунок', () => {
    expect(valueNoise(3.25, 7.5, 11)).not.toBe(valueNoise(3.25, 7.5, 12));
  });
});

describe('след скалы на карте', () => {
  it('за скальной клеткой высоты нет', () => {
    expect(isRockCell(BLOCK, 9, 12)).toBe(false);
    expect(cellHeight(BLOCK, 9, 12)).toBe(0);
    expect(surfaceHeight(BLOCK, 9.5, 12.5)).toBe(0);
  });

  it('внутри массива высота есть', () => {
    expect(surfaceHeight(BLOCK, 12.5, 12.5)).toBeGreaterThan(0);
  });

  it('поверхность не выходит за клетку', () => {
    // Обход полосы проходимых клеток вдоль всей западной стороны массива.
    for (let v = 9; v < 17; v += 0.05) {
      expect(surfaceHeight(BLOCK, 9.5, v)).toBe(0);
    }
  });

  it('на границе с проходимой клеткой высота нулевая', () => {
    // Западная граница массива проходит по x = 10.
    expect(surfaceHeight(BLOCK, 10, 12.5)).toBe(0);
    expect(surfaceHeight(BLOCK, 10.001, 12.5)).toBeLessThan(0.01);
  });

  it('подножие занимает меньше половины клетки', () => {
    // Пологий скат во всю клетку обещал бы подъём, которого правила
    // не дают; нулевая ширина вернула бы отвесный уступ.
    expect(FOOT_WIDTH_CELLS).toBeLessThan(0.5 + 0.13);
    expect(FOOT_WIDTH_CELLS).toBeGreaterThan(0.2);
    expect(footFactor(BLOCK, 10 + FOOT_WIDTH_CELLS, 12.5)).toBe(1);
  });

  it('внутри массива высоту на общей границе клеток не теряет', () => {
    // Граница между двумя скальными клетками проходит по x = 12.
    // Это не край массива, и подножию здесь взяться неоткуда.
    expect(edgeDistance(BLOCK, 12, 12.5)).toBeGreaterThan(FOOT_WIDTH_CELLS);
    expect(surfaceHeight(BLOCK, 12, 12.5)).toBeGreaterThan(0);
  });

  it('поверхность внутри массива непрерывна', () => {
    let biggest = 0;
    for (let u = 11.2; u < 14.8; u += 0.02) {
      const step = Math.abs(surfaceHeight(BLOCK, u + 0.02, 12.5) - surfaceHeight(BLOCK, u, 12.5));
      biggest = Math.max(biggest, step);
    }

    // Шаг в две сотых клетки не может дать разрыва: скачок означал бы,
    // что в поле высот просочился уступ.
    expect(biggest).toBeLessThan(0.05);
  });

  it('высота не превосходит самой высокой клетки массива', () => {
    let tallest = 0;
    for (let y = 10; y < 16; y += 1) {
      for (let x = 10; x < 16; x += 1) tallest = Math.max(tallest, rockHeight(x, y));
    }

    for (let v = 10.1; v < 15.9; v += 0.25) {
      for (let u = 10.1; u < 15.9; u += 0.25) {
        expect(surfaceHeight(BLOCK, u, v)).toBeLessThanOrEqual(tallest);
      }
    }
  });
});

describe('фактура отделена от геометрии', () => {
  it('в поле высот нет подробностей мельче шага отрисовки', () => {
    // Главное правило модуля, и мерить его надо именно так.
    //
    // Губка на пробе получилась не от «слишком сильного шума вообще»,
    // а оттого, что в высоте оказались подробности короче расстояния
    // между выборками: соседние столбики уезжали друг относительно друга,
    // и склон превращался в частокол. Значит, проверять надо уклон
    // на шаге отрисовки, а не абстрактную гладкость.
    //
    // Сравнивать с фактурой бессмысленно: она нарочно слабая по амплитуде
    // и на этом шаге добавляет кривизны не больше, чем хребтовой излом,
    // который здесь законен — из него гряда выходит с рёбрами.
    const step = 1 / 22;
    let steepest = 0;

    for (let v = 11.1; v < 14.9; v += step) {
      for (let u = 11.1; u < 14.9; u += step) {
        const rise = Math.abs(surfaceHeight(BLOCK, u + step, v) - surfaceHeight(BLOCK, u, v));
        steepest = Math.max(steepest, rise / step);
      }
    }

    // Четыре клетки подъёма на клетку пути — это уже отвес, но не разрыв.
    // Осыпь катышков дала бы здесь десятки.
    expect(steepest).toBeLessThan(4);
  });

  it('фактура в высоту не попадает', () => {
    // Если бы попадала, тот же замер по сумме высоты и фактуры совпал бы
    // с замером по одной высоте.
    const withGrain = surfaceHeight(BLOCK, 12.5, 12.5) + grainOffset(12.5, 12.5);

    expect(withGrain).not.toBe(surfaceHeight(BLOCK, 12.5, 12.5));
  });

  it('фактура разворачивает нормаль там, где поверхность ровная', () => {
    // Без возмущения нормаль на ровном участке смотрела бы строго вверх,
    // и вся площадка залилась бы одним цветом — тем самым, от которого
    // изменение и уходит.
    const normal = surfaceNormal(BLOCK, 12.5, 12.5);

    expect(Math.hypot(normal.x, normal.y)).toBeGreaterThan(0.01);
  });

  it('нормаль единичной длины и смотрит вверх', () => {
    for (let v = 11; v < 15; v += 0.37) {
      for (let u = 11; u < 15; u += 0.37) {
        const normal = surfaceNormal(BLOCK, u, v);

        expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1, 10);
        expect(normal.z).toBeGreaterThan(0);
      }
    }
  });

  it('фактура воспроизводима', () => {
    expect(grainOffset(3.25, 7.5)).toBe(grainOffset(3.25, 7.5));
  });

  it('соседние участки поверхности освещены по-разному', () => {
    const here = surfaceNormal(BLOCK, 12.5, 12.5);
    const there = surfaceNormal(BLOCK, 12.7, 12.5);

    expect(here.x).not.toBeCloseTo(there.x, 3);
  });
});
