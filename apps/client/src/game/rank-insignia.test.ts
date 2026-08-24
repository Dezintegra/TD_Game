import { describe, expect, it } from 'vitest';
import { VETERAN_MAX_RANK } from '@td/shared';
import type { Graphics } from 'pixi.js';
import {
  RANK_FIELD_HEIGHT_PX,
  RANK_FIELD_WIDTH_PX,
  chevronCount,
  drawRankInsignia,
  hasStar,
  isStarFilled,
  starPoints,
} from './rank-insignia.js';

/**
 * Знак различия проверяется числами, а не осмотром.
 *
 * Осмотром ловится «нарисовалось что-то», а вопрос здесь другой: тот ли
 * знак у этого ранга. Ошибка тут не выглядит ошибкой — над башней будет
 * уверенно висеть чужой погон, и заметить подмену можно только зная,
 * сколько убийств она набрала.
 */

const COLORS = { field: 0x14171a, stripe: 0xcfd6da, gold: 0xffc83d };

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
}

const recorder = (): { graphics: Graphics; calls: Call[] } => {
  const calls: Call[] = [];
  const stub: Record<string, (...args: unknown[]) => unknown> = {};

  for (const op of [
    'moveTo',
    'lineTo',
    'rect',
    'roundRect',
    'circle',
    'poly',
    'closePath',
    'fill',
    'stroke',
    'clear',
  ]) {
    stub[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return stub;
    };
  }

  return { graphics: stub as unknown as Graphics, calls };
};

const drawn = (rank: number): Call[] => {
  const { graphics, calls } = recorder();
  drawRankInsignia(graphics, 0, 0, rank, COLORS);
  return calls;
};

describe('раскладка знаков по рангам', () => {
  it('нулевой ранг не рисуется вовсе', () => {
    // Пустой погон над каждой машиной был бы чистым шумом — по той же
    // причине, по которой не рисуется полная полоса здоровья.
    expect(drawn(0)).toHaveLength(0);
  });

  it('первые три ранга несут ёлочки по числу ранга', () => {
    expect(chevronCount(1)).toBe(1);
    expect(chevronCount(2)).toBe(2);
    expect(chevronCount(3)).toBe(3);

    for (const rank of [1, 2, 3]) {
      expect(hasStar(rank)).toBe(false);
      // Ёлочка — это две линии от вершины, то есть один moveTo и два lineTo.
      expect(drawn(rank).filter((call) => call.op === 'moveTo')).toHaveLength(rank);
      expect(drawn(rank).filter((call) => call.op === 'lineTo')).toHaveLength(rank * 2);
    }
  });

  it('четвёртый ранг — контурная звезда, пятый — закрашенная', () => {
    expect(hasStar(4)).toBe(true);
    expect(hasStar(5)).toBe(true);
    expect(chevronCount(4)).toBe(0);
    expect(chevronCount(5)).toBe(0);

    expect(isStarFilled(4)).toBe(false);
    expect(isStarFilled(VETERAN_MAX_RANK)).toBe(true);
  });

  it('закрашенная звезда крупнее контурной', () => {
    // Размер работает вместе с заливкой, а не вместо неё: высший ранг
    // должен читаться высшим и тогда, когда рядом не с чем сравнить.
    const radius = (rank: number): number => {
      const poly = drawn(rank).find((call) => call.op === 'poly');
      if (poly === undefined) throw new Error('звезда не нарисована');

      const points = poly.args[0] as number[];
      return Math.hypot(points[0] ?? 0, points[1] ?? 0);
    };

    expect(radius(5)).toBeGreaterThan(radius(4));
  });

  it('крупная звезда помещается в подложку', () => {
    const poly = drawn(5).find((call) => call.op === 'poly');
    if (poly === undefined) throw new Error('звезда не нарисована');

    const points = poly.args[0] as number[];
    const ys: number[] = [];
    for (let index = 1; index < points.length; index += 2) ys.push(points[index] ?? 0);

    expect(Math.min(...ys)).toBeGreaterThan(-RANK_FIELD_HEIGHT_PX / 2);
    expect(Math.max(...ys)).toBeLessThan(RANK_FIELD_HEIGHT_PX / 2);
  });

  it('закрашенная звезда заливается, а контурная обводится', () => {
    const outline = drawn(4);
    const filled = drawn(5);

    // Подложка заливается и обводится у обоих — значит, у контурной
    // звезды заливка одна (подложка), а обводок две.
    expect(outline.filter((call) => call.op === 'fill')).toHaveLength(1);
    expect(outline.filter((call) => call.op === 'stroke')).toHaveLength(2);

    expect(filled.filter((call) => call.op === 'fill')).toHaveLength(2);
    expect(filled.filter((call) => call.op === 'stroke')).toHaveLength(1);
  });

  it('ёлочки стальные, звёзды золотые', () => {
    // Переход «сталь → золото» и есть граница между группами. Спутай
    // цвета — и знак потеряет половину смысла: форма на сорока пикселях
    // различается хуже, чем кажется за монитором.
    const chevrons = drawn(3).filter((call) => call.op === 'stroke');
    const star = drawn(5).filter((call) => call.op === 'fill');

    expect(
      chevrons.some((call) => (call.args[0] as { color: number }).color === COLORS.stripe),
    ).toBe(true);
    expect(star.some((call) => (call.args[0] as { color: number }).color === COLORS.gold)).toBe(
      true,
    );
  });

  it('выше высшего ранга знак не меняется', () => {
    // Ранг в ядре обрезан пятью, но рисовалка обязана пережить и лишнее:
    // клиент считает ранг сам, и разойдись он на единицу — на экране
    // не должно появиться ничего нового.
    expect(isStarFilled(VETERAN_MAX_RANK + 3)).toBe(true);
    expect(chevronCount(VETERAN_MAX_RANK + 3)).toBe(0);
  });
});

describe('стоимость знака на кадре', () => {
  /**
   * Замерено: худший случай — третий ранг, пятнадцать вызовов
   * к `Graphics`; больше всех вершин у звёзд, четырнадцать. Полоса
   * здоровья для сравнения стоит четырёх вызовов и восьми вершин.
   *
   * Порог стережёт не производительность саму по себе, а разрастание
   * знака: погон рисуется в кадре, и если однажды он обзаведётся
   * тенью, каймой и блеском, эти числа уедут молча. Уехали — значит,
   * пора запекать в текстуры, а не тихо платить каждый кадр.
   */
  const cost = (rank: number): { ops: number; vertices: number } => {
    const calls = drawn(rank);
    let vertices = 0;

    for (const call of calls) {
      if (call.op === 'moveTo' || call.op === 'lineTo') vertices += 1;
      if (call.op === 'rect' || call.op === 'roundRect') vertices += 4;
      if (call.op === 'poly') vertices += (call.args[0] as number[]).length / 2;
    }

    return { ops: calls.length, vertices };
  };

  it('не дороже пятнадцати вызовов и шестнадцати вершин ни на одном ранге', () => {
    for (let rank = 1; rank <= VETERAN_MAX_RANK; rank += 1) {
      expect(cost(rank).ops).toBeLessThanOrEqual(15);
      expect(cost(rank).vertices).toBeLessThanOrEqual(16);
    }
  });

  it('ёлочки дороже звёзд по вызовам, но дешевле по вершинам', () => {
    // Не курьёз, а следствие устройства: ёлочка — это три точки
    // и обводка на каждую, а звезда — один многоугольник в десять
    // вершин. Кто из них дороже на самом деле, зависит от того,
    // что считать, — потому здесь и меряются обе величины.
    expect(cost(3).ops).toBeGreaterThan(cost(5).ops);
    expect(cost(3).vertices).toBeLessThan(cost(5).vertices);
  });
});

describe('геометрия звезды', () => {
  it('пятиконечная: десять вершин, внешние и внутренние вперемежку', () => {
    const points = starPoints(0, 0, 10);

    expect(points).toHaveLength(20);

    const radii: number[] = [];
    for (let index = 0; index < points.length; index += 2) {
      radii.push(Math.hypot(points[index] ?? 0, points[index + 1] ?? 0));
    }

    // Через одну: внешний радиус, внутренний, внешний…
    for (let index = 0; index < radii.length; index += 2) {
      expect(radii[index]).toBeCloseTo(10, 6);
      expect(radii[index + 1]).toBeCloseTo(3.82, 2);
    }
  });

  it('первый луч смотрит строго вверх', () => {
    // Звезда, повёрнутая на произвольный угол, читается кляксой.
    const [x, y] = starPoints(0, 0, 10);

    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(-10, 6);
  });
});

describe('размер погона', () => {
  it('сравним с полосой здоровья, а не теряется рядом с ней', () => {
    // Мерка здесь — полоса здоровья шириной 26 пикселей и башня
    // в сорок. Первый заход был вдвое мельче и в кадре превращался
    // в крапинку; число охраняет именно это.
    expect(RANK_FIELD_WIDTH_PX).toBeGreaterThanOrEqual(20);
    expect(RANK_FIELD_WIDTH_PX).toBeLessThanOrEqual(28);
    expect(RANK_FIELD_HEIGHT_PX).toBeLessThan(RANK_FIELD_WIDTH_PX);
  });

  it('три ёлочки помещаются в подложку', () => {
    const calls = drawn(3).filter((call) => call.op === 'moveTo' || call.op === 'lineTo');
    const ys = calls.map((call) => call.args[1] as number);

    expect(Math.min(...ys)).toBeGreaterThan(-RANK_FIELD_HEIGHT_PX / 2);
    expect(Math.max(...ys)).toBeLessThan(RANK_FIELD_HEIGHT_PX / 2);
  });
});
