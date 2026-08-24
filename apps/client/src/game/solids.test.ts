import { describe, expect, it } from 'vitest';
import { angles, box, column, roller, slab, tube, upright } from './solids.js';

/**
 * Конструкторы тел проверяются габаритами.
 *
 * Проверять здесь нечего кроме них: свет, кромка и нормали живут
 * в `armour.ts` и проверяются там. Зато габариты — это ровно то, чем
 * конструктор может соврать молча, а соврав, сдвинуть силуэт, по которому
 * игрок узнаёт вид постройки.
 */

const ups = (points: readonly { up: number }[]): number[] => points.map((point) => point.up);

describe('выдавливание вверх', () => {
  it('план внизу и он же наверху', () => {
    const solid = upright('проба', box(0, 0, 0.4, 0.2), 0.1, 0.3, 0);

    expect(ups(solid.bottom)).toEqual([0.1, 0.1, 0.1, 0.1]);
    expect(ups(solid.top)).toEqual([0.4, 0.4, 0.4, 0.4]);
    expect(solid.top.map((point) => point.forward)).toEqual(
      solid.bottom.map((point) => point.forward),
    );
  });

  it('скос стягивает верх к центру, но не выворачивает тело', () => {
    // Угол может дойти до центра, но не пройти его насквозь: иначе
    // обход контура перевернулся бы, и тело вывернулось наизнанку.
    const solid = upright('проба', box(0, 0, 0.2, 0.2), 0, 0.3, 0, { inset: 5 });

    for (const point of solid.top) {
      expect(point.forward).toBeCloseTo(0, 6);
      expect(point.side).toBeCloseTo(0, 6);
    }
  });
});

describe('круглые тела', () => {
  it('на ось приходится середина грани, а не вершина', () => {
    // Без сдвига на половину шага многоугольник читается звездой
    // с торчащим углом, а наклейки некуда класть: грань обязана быть
    // плоской и известной наперёд.
    for (const angle of angles(8)) {
      expect(Math.abs(Math.cos(angle))).not.toBeCloseTo(1, 6);
    }
  });

  it('у столба, катка и трубы оси разные', () => {
    const upright = column('столб', 0, 0, 0, 0.1, 0.4, 0);
    const across = roller('каток', 0, 0, 0.2, 0.1, 0.06, 0);
    const along = tube('труба', 0, 0.5, 0, 0.2, 0.05, 0);

    // У столба кольца различаются высотой, у катка — поперечиной,
    // у трубы — продольной координатой.
    expect(upright.bottom[0]?.up).not.toBeCloseTo(upright.top[0]?.up ?? 0, 6);
    expect(across.bottom[0]?.side).not.toBeCloseTo(across.top[0]?.side ?? 0, 6);
    expect(along.bottom[0]?.forward).not.toBeCloseTo(along.top[0]?.forward ?? 0, 6);
  });

  it('круглые тела помечены круглыми', () => {
    expect(column('столб', 0, 0, 0, 0.1, 0.4, 0).round).toBe(true);
    expect(roller('каток', 0, 0, 0.2, 0.1, 0.06, 0).round).toBe(true);
    expect(tube('труба', 0, 0.5, 0, 0.2, 0.05, 0).round).toBe(true);
    expect(upright('коробка', box(0, 0, 0.2, 0.2), 0, 0.1, 0).round).toBeUndefined();
  });
});

describe('плита с завалом', () => {
  it('габариты низа совпадают с заданными', () => {
    const plate = slab(
      'плита',
      {
        forward: 0,
        side: 0,
        length: 1,
        width: 0.3,
        base: 0,
        height: 0.4,
      },
      0,
    );

    expect(Math.max(...plate.bottom.map((point) => point.forward))).toBeCloseTo(0.5, 6);
    expect(Math.max(...plate.bottom.map((point) => point.side))).toBeCloseTo(0.15, 6);
    expect(Math.max(...plate.top.map((point) => point.up))).toBeCloseTo(0.4, 6);
  });

  it('завал вдоль и поперёк задаётся порознь', () => {
    // Ради этого `slab` и заведена. У `upright` со скосом углы
    // стягиваются по лучу, то есть завал вдоль и поперёк связаны длиной
    // и шириной детали; стене нужен завал по бортам и ровный торец —
    // торец обязан встретиться с торцом соседней клетки без ступеньки.
    const plate = slab(
      'плита',
      {
        forward: 0,
        side: 0,
        length: 1,
        width: 0.3,
        base: 0,
        height: 0.4,
        taperSide: 0.05,
      },
      0,
    );

    expect(Math.max(...plate.top.map((point) => point.forward))).toBeCloseTo(0.5, 6);
    expect(Math.max(...plate.top.map((point) => point.side))).toBeCloseTo(0.1, 6);
  });

  it('завал больше половины ширины не выворачивает плиту', () => {
    const plate = slab(
      'плита',
      {
        forward: 0,
        side: 0,
        length: 1,
        width: 0.3,
        base: 0,
        height: 0.4,
        taperSide: 5,
      },
      0,
    );

    for (const point of plate.top) expect(point.side).toBeCloseTo(0, 6);
  });
});
