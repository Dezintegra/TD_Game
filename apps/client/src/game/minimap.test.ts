import { describe, expect, it } from 'vitest';
import {
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  StructureKind,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
} from '@td/shared';
import { createWorld } from '@td/sim';
import type { StructureState, UnitState, WorldState } from '@td/sim';
import type { Graphics } from 'pixi.js';
import {
  MINIMAP_ASPECT,
  drawMinimapEntities,
  drawMinimapTerrain,
  minimapCellAt,
  minimapLayout,
  projectToMinimap,
} from './minimap.js';
import { MAP_BOUNDS, screenToWorld, worldToScreen } from './iso.js';

/**
 * Миникарта показывает тот же мир, что и поле, и главное её свойство —
 * что направления на обеих картинках совпадают. Проверяется это числами,
 * а не осмотром: развёрнутая миникарта выглядит как рабочая, просто
 * переносить с неё замеченное приходится мысленным доворотом, и заметить
 * это глазами трудно.
 */

/** Заглушка Graphics, запоминающая нарисованное. */
interface Shape {
  readonly kind: 'point' | 'rect' | 'circle';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const tracing = (): { graphics: Graphics; shapes: Shape[] } => {
  const shapes: Shape[] = [];
  const stub: Record<string, (...args: number[]) => unknown> = {};

  for (const name of ['moveTo', 'lineTo']) {
    stub[name] = (x = 0, y = 0) => {
      shapes.push({ kind: 'point', x, y, width: 0, height: 0 });
      return stub;
    };
  }

  stub['rect'] = (x = 0, y = 0, width = 0, height = 0) => {
    shapes.push({ kind: 'rect', x, y, width, height });
    return stub;
  };

  stub['circle'] = (x = 0, y = 0, radius = 0) => {
    shapes.push({ kind: 'circle', x, y, width: radius * 2, height: radius * 2 });
    return stub;
  };

  for (const name of ['closePath', 'fill', 'stroke', 'clear']) {
    stub[name] = () => stub;
  }

  return { graphics: stub as unknown as Graphics, shapes };
};

const extentOf = (shapes: readonly Shape[]) => ({
  minX: Math.min(...shapes.map((s) => (s.kind === 'point' ? s.x : s.x - s.width / 2))),
  maxX: Math.max(...shapes.map((s) => (s.kind === 'point' ? s.x : s.x + s.width / 2))),
  minY: Math.min(...shapes.map((s) => (s.kind === 'point' ? s.y : s.y - s.height / 2))),
  maxY: Math.max(...shapes.map((s) => (s.kind === 'point' ? s.y : s.y + s.height / 2))),
});

const layout = minimapLayout(1920, 856);
const world = createWorld(4321);

describe('раскладка миникарты', () => {
  it('отношение сторон выводится из габаритов спроецированной карты', () => {
    // Не вписано числом: сменятся углы проекции — отношение поедет само.
    expect(MINIMAP_ASPECT).toBeCloseTo(
      (MAP_BOUNDS.maxX - MAP_BOUNDS.minX) / (MAP_BOUNDS.maxY - MAP_BOUNDS.minY),
      9,
    );

    // При нынешних 40 и 35 градусах карта заметно шире, чем выше.
    expect(MINIMAP_ASPECT).toBeCloseTo(1.743, 2);
  });

  it('ширина следует из высоты, а не подгоняется под квадрат', () => {
    expect(layout.width).toBe(Math.round(layout.height * MINIMAP_ASPECT));
    expect(layout.width).not.toBe(layout.height);
  });

  it('высота ограничена долей высоты поля', () => {
    expect(minimapLayout(1920, 856).height).toBe(146);

    // Ограничители сверху и снизу: на большом экране миникарта не растёт
    // бесконечно, на маленьком не вырождается в точку.
    expect(minimapLayout(3840, 2160).height).toBe(150);
    expect(minimapLayout(1280, 400).height).toBe(96);
  });

  it('миникарта прижата к правому верхнему углу', () => {
    expect(layout.x + layout.width).toBe(1920 - 16);
    expect(layout.y).toBe(16);
  });
});

describe('проекция миникарты', () => {
  it('углы карты ложатся в габарит отведённой области', () => {
    const corners = [
      projectToMinimap(0, 0, layout),
      projectToMinimap(MAP_WIDTH_CELLS, 0, layout),
      projectToMinimap(MAP_WIDTH_CELLS, MAP_HEIGHT_CELLS, layout),
      projectToMinimap(0, MAP_HEIGHT_CELLS, layout),
    ];

    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);

    expect(Math.min(...xs)).toBeCloseTo(layout.x, 6);
    expect(Math.max(...xs)).toBeCloseTo(layout.x + layout.width, 0);
    expect(Math.min(...ys)).toBeCloseTo(layout.y, 6);
    expect(Math.max(...ys)).toBeCloseTo(layout.y + layout.height, 0);
  });

  it('направление совпадает с направлением на поле', () => {
    // Главное свойство изменения. Берём пару клеток, смотрим направление
    // между ними на поле и на миникарте — знаки и угол обязаны совпасть.
    const pairs: readonly (readonly [number, number, number, number])[] = [
      [4, 4, 20, 4],
      [4, 4, 4, 20],
      [10, 30, 30, 10],
      [1, 1, 47, 47],
    ];

    for (const [ax, ay, bx, by] of pairs) {
      const fieldA = worldToScreen(ax, ay);
      const fieldB = worldToScreen(bx, by);
      const onField = { x: fieldB.x - fieldA.x, y: fieldB.y - fieldA.y };

      const a = projectToMinimap(ax, ay, layout);
      const b = projectToMinimap(bx, by, layout);
      const onMinimap = { x: b.x - a.x, y: b.y - a.y };

      // Углы совпадают: векторы сонаправлены, значит их векторное
      // произведение равно нулю, а скалярное положительно.
      const cross = onField.x * onMinimap.y - onField.y * onMinimap.x;
      const dot = onField.x * onMinimap.x + onField.y * onMinimap.y;

      expect(Math.abs(cross)).toBeLessThan(1e-6);
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('клетка переводится в точку и обратно в ту же клетку', () => {
    // Разойдись прямое и обратное преобразования — камера начала бы ездить
    // не туда: молча, без единого признака поломки.
    // Клетки выводятся из размера карты, а не вписаны числами: прежние
    // 47 и 44 были сняты на поле 48 × 48 и на поле 38 × 38 оказались
    // за его краем — обратное преобразование честно вернуло «мимо карты»,
    // и проверка упала, не поймав при этом ни одной настоящей ошибки.
    const last = MAP_WIDTH_CELLS - 1;
    const middle = Math.floor(MAP_WIDTH_CELLS / 2);

    for (const [x, y] of [
      [0, 0],
      [1, 1],
      [middle, middle],
      [last, last],
      [3, last - 3],
      [last - 3, 3],
    ]) {
      const centre = projectToMinimap((x ?? 0) + 0.5, (y ?? 0) + 0.5, layout);
      const back = minimapCellAt(centre.x, centre.y, layout);

      expect(back).toBe((y ?? 0) * MAP_WIDTH_CELLS + (x ?? 0));
    }
  });

  it('нажатие мимо карты не подтягивается к ближайшей клетке', () => {
    // Углы описанного прямоугольника картой не являются: карта в проекции
    // параллелограмм. Подтягивание к ближайшей означало бы перенос камеры
    // не туда, куда целились.
    expect(minimapCellAt(layout.x + 1, layout.y + 1, layout)).toBe(-1);
    expect(minimapCellAt(layout.x + layout.width - 1, layout.y + layout.height - 1, layout)).toBe(
      -1,
    );

    // И совсем вне отведённой области — тоже отказ.
    expect(minimapCellAt(layout.x - 50, layout.y - 50, layout)).toBe(-1);
  });
});

describe('отрисовка миникарты', () => {
  it('рельеф укладывается в отведённую область', () => {
    const { graphics, shapes } = tracing();
    drawMinimapTerrain(graphics, world.map, layout, {
      background: 0,
      border: 0,
      rock: 0,
      self: 0,
      enemy: 0,
      viewport: 0,
    });

    expect(shapes.length).toBeGreaterThan(0);

    const extent = extentOf(shapes);
    expect(extent.minX).toBeGreaterThanOrEqual(layout.x - 1);
    expect(extent.maxX).toBeLessThanOrEqual(layout.x + layout.width + 1);
    expect(extent.minY).toBeGreaterThanOrEqual(layout.y - 1);
    expect(extent.maxY).toBeLessThanOrEqual(layout.y + layout.height + 1);
  });

  it('отметки юнитов одного размера в любом углу карты', () => {
    // Растянутая проекцией точка читалась бы направлением, которого
    // у неё нет. Поэтому проецируется только центр.
    const unit = (id: number, x: number, y: number): UnitState => ({
      id: asEntityId(id),
      owner: asPlayerId(0),
      unitType: UnitType.Assault,
      position: { x: cellsToUnits(x), y: cellsToUnits(y) },
      health: 100,
      facing: 1,
      readyAtTick: asTickNumber(0),
      kills: 0,
    });

    const { graphics, shapes } = tracing();
    drawMinimapEntities(
      graphics,
      { ...world, structures: [], units: [unit(1, 2, 2), unit(2, 45, 45)] } as WorldState,
      asPlayerId(0),
      [],
      layout,
      { background: 0, border: 0, rock: 0, self: 0, enemy: 0, viewport: 0 },
    );

    const rects = shapes.filter((shape) => shape.kind === 'rect');
    expect(rects).toHaveLength(2);
    expect(rects[0]?.width).toBe(rects[1]?.width);
    expect(rects[0]?.height).toBe(rects[1]?.height);
    expect(rects[0]?.width).toBe(rects[0]?.height);
  });

  it('база отмечается крупнее обычной постройки', () => {
    const structure = (id: number, kind: StructureKind, cell: number): StructureState => ({
      id: asEntityId(id),
      owner: asPlayerId(0),
      kind,
      cell,
      health: 100,
      kills: 0,
      readyAtTick: asTickNumber(0),
      builtAtTick: asTickNumber(0),
      demolishAtTick: asTickNumber(0),
      facing: 1,
    });

    const { graphics, shapes } = tracing();
    drawMinimapEntities(
      graphics,
      {
        ...world,
        structures: [structure(1, StructureKind.Base, 100), structure(2, StructureKind.Wall, 200)],
        units: [],
        generals: [],
      } as WorldState,
      asPlayerId(0),
      [],
      layout,
      { background: 0, border: 0, rock: 0, self: 0, enemy: 0, viewport: 0 },
    );

    const rects = shapes.filter((shape) => shape.kind === 'rect');
    expect(rects).toHaveLength(2);
    expect(rects[0]?.width).toBeGreaterThan(rects[1]?.width ?? 0);
  });

  it('рамка обзора рисуется прямоугольником со сторонами по краям экрана', () => {
    // Прямоугольником она становится сама: область экрана прямоугольна,
    // и та же проекция переводит её в прямоугольник. Прежний косой ромб
    // был следствием того, что проекции у поля и миникарты были разные.
    const corners = [
      screenToWorld(-400, -300),
      screenToWorld(400, -300),
      screenToWorld(400, 300),
      screenToWorld(-400, 300),
    ];

    const { graphics, shapes } = tracing();
    drawMinimapEntities(
      graphics,
      { ...world, structures: [], units: [], generals: [] } as WorldState,
      asPlayerId(0),
      corners,
      layout,
      { background: 0, border: 0, rock: 0, self: 0, enemy: 0, viewport: 0 },
    );

    const points = shapes.filter((shape) => shape.kind === 'point');
    expect(points).toHaveLength(4);

    const [a, b, c, d] = points;
    expect(a && b && c && d).toBeTruthy();
    if (a === undefined || b === undefined || c === undefined || d === undefined) return;

    // Верхняя и нижняя стороны горизонтальны, левая и правая вертикальны.
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(c.y).toBeCloseTo(d.y, 6);
    expect(b.x).toBeCloseTo(c.x, 6);
    expect(d.x).toBeCloseTo(a.x, 6);

    // И это именно прямоугольник, а не выродившийся в отрезок.
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(1);
    expect(Math.abs(c.y - b.y)).toBeGreaterThan(1);
  });
});
