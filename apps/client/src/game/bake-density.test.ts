import { describe, expect, it } from 'vitest';
import { MAX_ZOOM } from './camera.js';
import {
  ARMOUR_SUPERSAMPLE,
  MAX_ARMOUR_BAKE_DENSITY,
  ROCK_BAKE_BUDGET_MB,
  ROCK_CELL_AREA_PX,
  armourBakeDensity,
  rockBakeDensity,
  rockBaseDensity,
  rockTargetDensity,
  rockTextureBytes,
  rockMemoryLimit,
  rockResolutionBridge,
  rockResizeLimit,
} from './bake-density.js';

describe('адаптивная плотность и память', () => {
  it.each([1, 2, 3])('покрывает масштаб при DPR %s без потолка брони', (r) => {
    for (const s of [0.25, 0.5, 1, 1.001, 1.999, 2, 2.001, 3.999, 4]) {
      const target = rockTargetDensity(r, s);
      expect(target).toBeGreaterThanOrEqual(r * s);
      expect(target).toBeGreaterThanOrEqual(r);
      if (s > 1) expect(target).toBeLessThan(r * s * 2);
    }
    expect(rockTargetDensity(r, 4 * 0.5)).toBe(2 * r);
    expect(rockTargetDensity(r, 4)).toBe(4 * r);
    expect(rockBaseDensity(0.5)).toBe(1);
  });

  it('считает округлённые физические размеры и всю mip-цепочку', () => {
    expect(rockTextureBytes({ width: 2.1, height: 1.1 }, 1)).toBe((3 * 2 + 1) * 4);
    expect(rockTextureBytes({ width: 1, height: 8 }, 1)).toBe((8 + 4 + 2 + 1) * 4);
    expect(rockTextureBytes({ width: 0, height: 8 }, 1)).toBe(0);
  });

  it('пустая карта не резервирует память', () => {
    expect(rockMemoryLimit([], { width: 800, height: 600 }, 3)).toEqual({
      base: 0,
      detail: 0,
      temporary: 0,
      total: 0,
    });
    expect(rockResolutionBridge([], 3, 0).total).toBe(0);
  });

  it('учитывает максимальную вершину и отражение, resize уменьшает предел', () => {
    const cells = Array.from({ length: 10000 }, () => ({ width: 97, height: 271 }));
    const large = rockMemoryLimit(cells, { width: 1800, height: 1000 }, 3);
    const small = rockMemoryLimit(cells, { width: 300, height: 200 }, 3);
    expect(large.detail).toBeGreaterThan(small.detail);
    expect(small.temporary).toBe(rockTextureBytes(cells[0]!, 12));
    expect(small.base).toBe(10000 * rockTextureBytes(cells[0]!, 3));
    expect(rockResizeLimit(large.total, small.total)).toBe(large.total);
  });

  it.each([
    [1, 3],
    [3, 1],
  ])('переход %s → %s удерживает старую базу до установки', (before, after) => {
    const sizes = [
      { width: 97, height: 271 },
      { width: 75.5, height: 133.2 },
    ];
    const cells = sizes.map((size) => ({ ...size, heldBytes: rockTextureBytes(size, before!) }));
    const start = cells.reduce((sum, cell) => sum + cell.heldBytes, 0);
    const bridge = rockResolutionBridge(cells, after!, start);
    expect(bridge.base).toBe(sizes.reduce((sum, size) => sum + rockTextureBytes(size, 3), 0));
    let held = start;
    for (const cell of cells) {
      const next = rockTextureBytes(cell, after!);
      expect(held + next).toBeLessThanOrEqual(bridge.total);
      held += next - cell.heldBytes;
    }
    cells[0]!.heldBytes = rockTextureBytes(cells[0]!, after!);
    const mixed = rockResolutionBridge(cells, 2, held);
    expect(mixed.base).toBe(
      cells.reduce((sum, cell) => sum + Math.max(cell.heldBytes, rockTextureBytes(cell, 2)), 0),
    );
  });
});

/** Во что обходится слой скал при такой плотности, в мегабайтах. */
const rockLayerMb = (cells: number, density: number): number =>
  (cells * ROCK_CELL_AREA_PX * density * density * 4 * (4 / 3)) / (1024 * 1024);

describe('плотность запекания брони', () => {
  it('покрывает предельное приближение на обычном экране', () => {
    // Главное свойство: плотность равна наибольшему возможному масштабу
    // показа, а не подобранному числу. Растяжения не остаётся.
    expect(armourBakeDensity(1)).toBe(MAX_ZOOM);
  });

  it('следует за пределом приближения, а не за собственной константой', () => {
    // Если предел зума однажды поменяют, плотность обязана поехать
    // вместе с ним. Разъедься они — мыло вернулось бы молча, без единой
    // ошибки в логах.
    expect(armourBakeDensity(1)).toBeLessThanOrEqual(MAX_ARMOUR_BAKE_DENSITY);
    expect(armourBakeDensity(1)).toBe(Math.min(MAX_ZOOM, MAX_ARMOUR_BAKE_DENSITY));
  });

  it('учитывает плотность экрана множителем', () => {
    // На подробном экране запечённое обязано быть подробнее, а не крупнее:
    // масштаб считается в точках CSS, а рисуется в пикселях устройства.
    expect(armourBakeDensity(1.5)).toBeGreaterThan(armourBakeDensity(1));
  });

  it('не превышает потолка на плотном экране', () => {
    expect(armourBakeDensity(2)).toBe(MAX_ARMOUR_BAKE_DENSITY);
    expect(armourBakeDensity(3)).toBe(MAX_ARMOUR_BAKE_DENSITY);
  });

  it('не опускается ниже единицы при дробной плотности экрана', () => {
    // Браузер отдаёт дробную плотность при масштабировании системы.
    // Запекать реже показа нельзя ни при каких обстоятельствах.
    expect(armourBakeDensity(0.75)).toBeGreaterThanOrEqual(1);
  });
});

describe('кратность чернового буфера', () => {
  it('больше единицы: иначе сведение станет растягиванием', () => {
    // Это ровно то, что сломается при следующей правке плотности,
    // и сломается тихо: черновик реже готовой текстуры добавит мыла,
    // а не уберёт его. Прежняя формула, выводившая кратность делением,
    // при нынешней плотности дала бы 0,75.
    expect(ARMOUR_SUPERSAMPLE).toBeGreaterThan(1);
  });

  it('оставляет решётку проб шейдера целой', () => {
    // Шейдер сведения берёт две пробы на сторону с шагом
    // «кратность / 2». Шаг обязан оставаться меньше точки черновика,
    // иначе пробы разъедутся и усреднять станет нечего.
    expect(ARMOUR_SUPERSAMPLE / 2).toBeLessThanOrEqual(1);
  });
});

describe('плотность запекания скал', () => {
  // Карта на двоих: сторона 38, около 13 процентов клеток скальные.
  const smallMapCells = 220;
  // Карта на четверых: сторона 58, площадь вдвое с третью больше.
  const largeMapCells = 512;

  it('укладывается в бюджет на карте для двоих', () => {
    const density = rockBakeDensity(armourBakeDensity(1), smallMapCells);

    expect(rockLayerMb(smallMapCells, density)).toBeLessThanOrEqual(ROCK_BAKE_BUDGET_MB);
  });

  it('снижает плотность на карте вдвое большей и остаётся в бюджете', () => {
    const ceiling = armourBakeDensity(1);
    const small = rockBakeDensity(ceiling, smallMapCells);
    const large = rockBakeDensity(ceiling, largeMapCells);

    expect(large).toBeLessThan(small);
    expect(rockLayerMb(largeMapCells, large)).toBeLessThanOrEqual(ROCK_BAKE_BUDGET_MB);
  });

  it('остаётся ниже брони: полное покрытие зума скалам не по карману', () => {
    // Не украшение, а суть решения: слой скал единственный, чья сумма
    // растёт со стороной карты. При плотности брони он занял бы
    // 150–200 МБ на карте для двоих.
    const ceiling = armourBakeDensity(1);

    expect(rockBakeDensity(ceiling, smallMapCells)).toBeLessThan(ceiling);
  });

  it('не поднимается выше потолка, когда бюджет позволяет больше', () => {
    const ceiling = armourBakeDensity(1);

    expect(rockBakeDensity(ceiling, 4)).toBe(ceiling);
  });

  it('не опускается ниже единицы даже на карте, не влезающей в бюджет', () => {
    expect(rockBakeDensity(armourBakeDensity(1), 100_000)).toBe(1);
  });

  it('на карте без скал возвращает потолок, а не бесконечность', () => {
    const ceiling = armourBakeDensity(1);

    expect(rockBakeDensity(ceiling, 0)).toBe(ceiling);
    expect(Number.isFinite(rockBakeDensity(ceiling, 0))).toBe(true);
  });
});
