import { describe, expect, it } from 'vitest';
import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS } from '@td/shared';
import type { Graphics } from 'pixi.js';
import { drawField, drawGrid } from './terrain.js';
import type { TerrainColors } from './terrain.js';
import { worldToScreen } from './iso.js';

/**
 * Земля разъехалась на два слоя, и проверяется здесь именно разъезд.
 *
 * Смысл разделения в том, что поверхность видна всегда, а сетка — только
 * в режиме строительства, и прячется она снятием видимости слоя целиком.
 * Затеши хоть одну линию сетки в слой поверхности — она осталась бы
 * на экране в бою, и заметить это можно было бы только глазами.
 * Обратная сторона того же: попади заливка в слой сетки — поле чернело бы
 * и белело вместе с ней.
 *
 * Заглушка `Graphics` запоминает ВСЕ вызовы, а не только формы: половина
 * утверждений здесь — про то, чего слой НЕ делает, и по одним лишь
 * запомненным формам «не делает» не проверить.
 */

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

const tracing = (): { graphics: Graphics; calls: Call[] } => {
  const calls: Call[] = [];
  const stub: Record<string, (...args: unknown[]) => unknown> = {};

  for (const name of [
    'clear',
    'moveTo',
    'lineTo',
    'poly',
    'fill',
    'stroke',
    'rect',
    'circle',
    'closePath',
  ]) {
    stub[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      return stub;
    };
  }

  return { graphics: stub as unknown as Graphics, calls };
};

const named = (calls: readonly Call[], name: string): readonly Call[] =>
  calls.filter((call) => call.name === name);

const colors: TerrainColors = {
  surface: 0x000000,
  grid: 0x3a3a3a,
  gridMajor: 0x4d4d4d,
  rock: 0x82796d,
  rockSky: 0x5c7ea8,
  border: 0x6b6b6b,
};

/** Углы карты в проекции — считаются здесь заново, а не берутся у кода. */
const corners = [
  worldToScreen(0, 0),
  worldToScreen(MAP_WIDTH_CELLS, 0),
  worldToScreen(MAP_WIDTH_CELLS, MAP_HEIGHT_CELLS),
  worldToScreen(0, MAP_HEIGHT_CELLS),
];

describe('поверхность поля', () => {
  it('заливается ровно один раз на всю карту', () => {
    // Не полторы тысячи заливок по клетке: поверхность одноцветна,
    // делить её нечем, и каждая лишняя заливка — лишнее обращение
    // к видеокарте на ровном месте.
    const { graphics, calls } = tracing();
    drawField(graphics, colors);

    expect(named(calls, 'fill')).toHaveLength(1);
    expect(named(calls, 'poly')).toHaveLength(1);
  });

  it('вершины заливки совпадают с проекцией углов карты', () => {
    // Разойдись они — заливка вылезла бы за край карты или не дотянула
    // до него, и мгла за границей поля легла бы поверх чёрного поля,
    // а не рядом с ним.
    const { graphics, calls } = tracing();
    drawField(graphics, colors);

    expect(named(calls, 'poly')[0]?.args[0]).toEqual(
      corners.flatMap((corner) => [corner.x, corner.y]),
    );
  });

  it('не рисует линий сетки: из линий только граница карты', () => {
    const { graphics, calls } = tracing();
    drawField(graphics, colors);

    // Граница — замкнутый обход четырёх углов, то есть ровно пять точек.
    // Сетка добавила бы к ним под две сотни.
    const points = [...named(calls, 'moveTo'), ...named(calls, 'lineTo')];
    expect(points).toHaveLength(5);
    expect(named(calls, 'stroke')).toHaveLength(1);

    for (const point of points) {
      expect(
        corners.some((corner) => corner.x === point.args[0] && corner.y === point.args[1]),
      ).toBe(true);
    }
  });

  it('начинается с очистки своего слоя', () => {
    // Слоя два, и каждый чистит себя сам. Забудь один из них очиститься —
    // при смене карты новая геометрия легла бы поверх старой.
    const { graphics, calls } = tracing();
    drawField(graphics, colors);

    expect(calls[0]?.name).toBe('clear');
  });
});

describe('сетка клеток', () => {
  it('не делает ни одной заливки', () => {
    // Слой сетки прячется целиком, и заливка в нём означала бы, что вместе
    // с сеткой пропадает и поверхность поля.
    const { graphics, calls } = tracing();
    drawGrid(graphics, colors);

    expect(named(calls, 'fill')).toHaveLength(0);
    expect(named(calls, 'poly')).toHaveLength(0);
    expect(named(calls, 'rect')).toHaveLength(0);
  });

  it('рисует по линии на каждую грань клеток и не рисует границы', () => {
    const { graphics, calls } = tracing();
    drawGrid(graphics, colors);

    // Линии идут через всю карту: по одной на каждую из границ клеток
    // вдоль обеих осей, то есть на единицу больше числа клеток.
    expect(named(calls, 'moveTo')).toHaveLength(MAP_WIDTH_CELLS + MAP_HEIGHT_CELLS + 2);

    // Обводки ровно две — тонкая и яркая. Третьей, границы карты, здесь
    // нет: она принадлежит поверхности и видна в любом режиме.
    expect(named(calls, 'stroke')).toHaveLength(2);
  });

  it('начинается с очистки своего слоя', () => {
    const { graphics, calls } = tracing();
    drawGrid(graphics, colors);

    expect(calls[0]?.name).toBe('clear');
  });
});
