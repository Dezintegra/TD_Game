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
import { cellIndex, createWorld } from '@td/sim';
import type { NukeState, StructureState, UnitState, WorldState } from '@td/sim';
import type { Graphics } from 'pixi.js';
import {
  MINIMAP_ASPECT,
  drawMinimapEntities,
  drawMinimapTerrain,
  minimapCellAt,
  minimapLayout,
  projectToMinimap,
} from './minimap.js';
import type { MinimapColors } from './minimap.js';
import { MAP_BOUNDS, screenToWorld, worldToScreen } from './iso.js';
import { traceGroundCircle } from './ground-circle.js';

/**
 * Миникарта показывает тот же мир, что и поле, и главное её свойство —
 * что направления на обеих картинках совпадают. Проверяется это числами,
 * а не осмотром: развёрнутая миникарта выглядит как рабочая, просто
 * переносить с неё замеченное приходится мысленным доворотом, и заметить
 * это глазами трудно.
 */

/**
 * Заглушка Graphics, запоминающая нарисованное.
 *
 * Цвет и толщину она запоминает тоже, а не проглатывает: различие своей
 * метки удара и чужой — это в том числе цвет обводки, и проверить его
 * иначе нечем.
 *
 * Краска приходит отдельным вызовом (`fill`, `stroke`) уже ПОСЛЕ того,
 * как фигура прочерчена, и красит всё прочерченное с прошлой покраски.
 * Поэтому заглушка копит фигуры и проставляет им цвет задним числом —
 * ровно так же, как это делает PixiJS.
 */
interface Shape {
  readonly kind: 'point' | 'rect' | 'circle';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  color: number;
  strokeWidth: number;
  paint: 'fill' | 'stroke' | 'none';
}

interface PaintStyle {
  readonly color?: number;
  readonly width?: number;
  readonly alpha?: number;
}

interface GraphicsStub {
  moveTo: (x: number, y: number) => GraphicsStub;
  lineTo: (x: number, y: number) => GraphicsStub;
  rect: (x: number, y: number, width: number, height: number) => GraphicsStub;
  circle: (x: number, y: number, radius: number) => GraphicsStub;
  closePath: () => GraphicsStub;
  fill: (style?: PaintStyle) => GraphicsStub;
  stroke: (style?: PaintStyle) => GraphicsStub;
  clear: () => GraphicsStub;
}

const tracing = (): { graphics: Graphics; shapes: Shape[] } => {
  const shapes: Shape[] = [];
  let pending: Shape[] = [];

  const add = (shape: Shape): void => {
    pending.push(shape);
    shapes.push(shape);
  };

  const painter =
    (kind: 'fill' | 'stroke') =>
    (style?: PaintStyle): GraphicsStub => {
      for (const shape of pending) {
        shape.paint = kind;
        shape.color = style?.color ?? 0;
        shape.strokeWidth = style?.width ?? 0;
      }
      pending = [];
      return stub;
    };

  const shapeOf = (
    kind: Shape['kind'],
    x: number,
    y: number,
    width: number,
    height: number,
  ): Shape => ({ kind, x, y, width, height, color: 0, strokeWidth: 0, paint: 'none' });

  const stub: GraphicsStub = {
    moveTo: (x, y) => {
      add(shapeOf('point', x, y, 0, 0));
      return stub;
    },
    lineTo: (x, y) => {
      add(shapeOf('point', x, y, 0, 0));
      return stub;
    },
    rect: (x, y, width, height) => {
      add(shapeOf('rect', x, y, width, height));
      return stub;
    },
    circle: (x, y, radius) => {
      add(shapeOf('circle', x, y, radius * 2, radius * 2));
      return stub;
    },
    closePath: () => stub,
    fill: painter('fill'),
    stroke: painter('stroke'),
    clear: () => stub,
  };

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

/**
 * Цвета взяты РАЗНЫМИ намеренно.
 *
 * Прежде здесь стояли нули: геометрию они не портили, а больше ничего
 * и не проверялось. Различие своей метки и чужой — это в том числе цвет
 * обводки, и на одинаковых нулях такая проверка зеленела бы всегда,
 * ничего при этом не проверяя.
 */
const colors: MinimapColors = {
  background: 0x141414,
  border: 0x4d4d4d,
  rock: 0x6e6a63,
  self: 0x00ff29,
  enemy: 0xd264ff,
  viewport: 0xc4c4c4,
  strike: 0xff5c5c,
};

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

  it('миникарта прижата к ЛЕВОМУ верхнему углу', () => {
    // Слева, а не справа, и это переезд по необходимости: справа вверху
    // теперь сводка соперника со строкой связи, справа внизу — рейка
    // заказа. Слева над миникартой только своя сводка, а под ней
    // до самого низа пусто.
    expect(layout.x).toBe(16);
    expect(layout.y).toBe(16);
  });

  it('отступ сверху отодвигает миникарту из-под своей сводки', () => {
    // Без отступа прибор ориентирования наполовину уходит под панель,
    // а наполовину закрытый прибор — уже не прибор.
    const under = minimapLayout(1920, 856, 64);

    expect(under.x).toBe(16);
    expect(under.y).toBe(16 + 64);
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
    drawMinimapTerrain(graphics, world.map, layout, colors);

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
      colors,
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
      colors,
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
      colors,
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

/**
 * Ядерный удар на миникарте.
 *
 * Игрок видит за раз около трети поля, а удар летит три секунды. Метка
 * на поле помогает лишь тому, кто в эту часть поля сейчас смотрит; удар,
 * идущий в невидимую треть, без миникарты для игрока не существует
 * до самого взрыва.
 */
const nuke = (id: number, owner: number, cell: number, radiusCells: number): NukeState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  cell,
  detonateAtTick: asTickNumber(30),
  radius: cellsToUnits(radiusCells),
  damage: 500,
});

/** Мир без сущностей: остаются одни удары, и разбирать нарисованное просто. */
const onlyNukes = (nukes: readonly NukeState[]): WorldState => {
  return { ...world, structures: [], units: [], generals: [], nukes } as WorldState;
};

const drawNukes = (nukes: readonly NukeState[], localPlayer = 0): readonly Shape[] => {
  const { graphics, shapes } = tracing();
  drawMinimapEntities(graphics, onlyNukes(nukes), asPlayerId(localPlayer), [], layout, colors);
  return shapes;
};

/** Габарит ломаной: круг удара — единственное, что рисуется отрезками. */
const ringSizeOf = (shapes: readonly Shape[]): { width: number; height: number } => {
  const points = shapes.filter((shape) => shape.kind === 'point');
  const extent = extentOf(points);

  return { width: extent.maxX - extent.minX, height: extent.maxY - extent.minY };
};

describe('ядерный удар на миникарте', () => {
  it('матч без ударов миникарту не меняет ничем', () => {
    expect(drawNukes([])).toHaveLength(0);
  });

  it('удар в полёте даёт круг и отметку эпицентра', () => {
    const shapes = drawNukes([nuke(1, 0, cellIndex(20, 20), 4)]);

    const points = shapes.filter((shape) => shape.kind === 'point');
    const circles = shapes.filter((shape) => shape.kind === 'circle');

    // Круг — замкнутая ломаная, а не пара отрезков.
    expect(points.length).toBeGreaterThan(8);
    const first = points[0];
    const last = points[points.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || last === undefined) return;

    expect(last.x).toBeCloseTo(first.x, 9);
    expect(last.y).toBeCloseTo(first.y, 9);

    // И отдельная отметка эпицентра: центр эллипса в сорок точек
    // поперёк на глаз не определяется.
    expect(circles).toHaveLength(1);
  });

  it('после удара отметка пропадает', () => {
    // Отметка целиком выводится из world.nukes. Взорвавшейся ракеты
    // там уже нет — значит, и убирать её отдельно не приходится.
    expect(drawNukes([nuke(1, 0, cellIndex(20, 20), 4)]).length).toBeGreaterThan(0);
    expect(drawNukes([])).toHaveLength(0);
  });

  it('круг следует радиусу ИМЕННО ЭТОЙ ракеты, а не балансной постоянной', () => {
    // Радиус прокачивается. Показывать базовые четыре клетки там, где
    // прокачанный удар накроет восемь, значило бы обещать границу,
    // по которой игрок уводит войска, — и хоронить их по настоящей.
    const small = ringSizeOf(drawNukes([nuke(1, 0, cellIndex(20, 20), 4)]));
    const large = ringSizeOf(drawNukes([nuke(1, 0, cellIndex(20, 20), 8)]));

    expect(large.width).toBeCloseTo(small.width * 2, 6);
    expect(large.height).toBeCloseTo(small.height * 2, 6);
  });

  it('круг растянут проекцией ровно так же, как на поле', () => {
    // Ровный круг соврал бы о накрываемой площади — то есть ровно о том,
    // ради чего нарисован. Две картинки одного удара расходиться не вправе.
    const shapes = drawNukes([nuke(1, 0, cellIndex(20, 20), 4)]);
    const onMinimap = ringSizeOf(shapes);

    // Число отрезков берётся из нарисованного, а не вписывается сюда:
    // сравнивать надо ту же ломаную, а не ту же фигуру при другом шаге.
    const steps = shapes.filter((shape) => shape.kind === 'point').length - 1;

    const field = tracing();
    traceGroundCircle(field.graphics, 20.5, 20.5, 4, worldToScreen, steps);
    const onField = ringSizeOf(field.shapes);

    expect(onMinimap.width / onMinimap.height).toBeCloseTo(onField.width / onField.height, 6);
  });

  it('отметка эпицентра одного размера в любом углу карты', () => {
    // Она — такая же точка, как отметки юнитов, и правилу постоянного
    // экранного размера подчиняется. Растянутая проекцией, она читалась бы
    // направлением, которого у неё нет.
    const near = cellIndex(2, 2);
    const far = cellIndex(MAP_WIDTH_CELLS - 3, MAP_HEIGHT_CELLS - 3);
    const shapes = drawNukes([nuke(1, 0, near, 4), nuke(2, 0, far, 4)]);

    const circles = shapes.filter((shape) => shape.kind === 'circle');
    expect(circles).toHaveLength(2);
    expect(circles[0]?.width).toBe(circles[1]?.width);
    expect(circles[0]?.width).toBe(circles[0]?.height);
  });

  it('свой удар и чужой различаются И цветом, И видом эпицентра', () => {
    // Свой удар — подтверждение заказа, чужой — тревога, и требуют они
    // противоположных действий. Проверять один лишь цвет нельзя: своя
    // сторона зелёная, тревога красная, а на красно-зелёной паре различие
    // обязано пережить дальтонизм.
    const cell = cellIndex(20, 20);
    const mine = drawNukes([nuke(1, 0, cell, 4)], 0);
    const theirs = drawNukes([nuke(1, 1, cell, 4)], 0);

    // Цвет обводки кольца. Заглушка его запоминает — прежде проглатывала,
    // и проверить это было нечем.
    const myRing = mine[0];
    const theirRing = theirs[0];
    expect(myRing).toBeDefined();
    expect(theirRing).toBeDefined();
    if (myRing === undefined || theirRing === undefined) return;

    expect(myRing.color).toBe(colors.self);
    expect(theirRing.color).toBe(colors.strike);
    expect(myRing.color).not.toBe(theirRing.color);
    expect(myRing.strokeWidth).toBeGreaterThan(0);

    // И вид эпицентра. Кольцо у обоих одно и то же, значит разница
    // в числе фигур — это в точности разница в отметке эпицентра.
    const ring = mine.filter((shape) => shape.kind === 'point').length;
    const myMark = mine.length - ring;
    const theirMark = theirs.length - ring;

    expect(myMark).toBeGreaterThan(0);
    expect(theirMark).toBeGreaterThan(0);
    expect(myMark).not.toBe(theirMark);
  });
});
