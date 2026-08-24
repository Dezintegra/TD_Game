import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import {
  DIRECTION_SOUTH,
  PPM_ONE,
  StructureKind,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import {
  cellCentre,
  cellIndex,
  cellX,
  cellY,
  createWorld,
  playerStats,
  structureMaxHealth,
} from '@td/sim';
import type { WorldState } from '@td/sim';
import { drawEntities } from './entities.js';
import type { EntityColors, EntityLayers, ViewBounds } from './entities.js';
import { baseCrestPoint } from './base-structure.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import { MIRROR_SQUASH, UNIT_ALTITUDE, hoverBob } from './models.js';
import type { MachineSprite, MachineSprites } from './machine-sprites.js';
import type { StructureSprites } from './structure-sprites.js';
import { WALL_LINK_EAST, WALL_LINK_WEST } from './structures.js';

/**
 * Порядок отрисовки проверяется не картинкой, а тем, в какую полосу
 * глубины попал объект.
 *
 * Полосы и есть механизм перекрытия: между ними сцена вставляет слои
 * неподвижной территории, поэтому «юнит попал в полосу раньше скалы»
 * означает ровно «юнит нарисован за скалой». Скриншот сказал бы то же
 * самое, но перестал бы что-либо доказывать при первой смене палитры.
 */

const SEED = 4242;

/**
 * Заглушка Graphics: методы ничего не рисуют, но остаются цепочечными
 * и считают обращения.
 *
 * Счётчик нужен полосам прочности. Прямоугольник в отрисовке сущностей
 * рисуют только они — тела собраны из многоугольников, — поэтому число
 * вызовов `rect` и отвечает на вопрос «попала ли в этот слой полоса».
 */
/** Прямоугольник, ушедший в слой. Ими рисуются полосы прочности. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Recorder {
  readonly graphics: Graphics;
  readonly counts: Record<string, number>;
  /** Точки, через которые прошёл путь. По ним проверяется геометрия. */
  readonly points: Point[];
  /** Толщины обводок. По ним проверяется, что луч толще трассера. */
  readonly widths: number[];
  /** Прямоугольники — с их координатами, а не только числом. */
  readonly rects: Rect[];
}

const recorder = (): Recorder => {
  const counts: Record<string, number> = {};
  const points: Point[] = [];
  const widths: number[] = [];
  const rects: Rect[] = [];
  const stub: Record<string, (...args: unknown[]) => unknown> = {};

  for (const name of [
    'moveTo',
    'lineTo',
    'closePath',
    'fill',
    'stroke',
    'circle',
    'rect',
    'clear',
  ]) {
    stub[name] = (...args: unknown[]) => {
      counts[name] = (counts[name] ?? 0) + 1;

      if ((name === 'moveTo' || name === 'lineTo') && args.length >= 2) {
        points.push({ x: args[0] as number, y: args[1] as number });
      }

      if (name === 'stroke') {
        const width = (args[0] as { width?: number } | undefined)?.width;
        if (width !== undefined) widths.push(width);
      }

      if (name === 'rect' && args.length >= 4) {
        rects.push({
          x: args[0] as number,
          y: args[1] as number,
          width: args[2] as number,
          height: args[3] as number,
        });
      }

      return stub;
    };
  }

  return { graphics: stub as unknown as Graphics, counts, points, widths, rects };
};

/** Экран заведомо больше карты: отсечение по видимости не должно мешать. */
const WHOLE_MAP: ViewBounds = {
  minX: -1e6,
  maxX: 1e6,
  minY: -1e6,
  maxY: 1e6,
};

const COLORS: EntityColors = {
  self: 0x00ff29,
  enemy: 0xd264ff,
  ground: 0x191919,
  health: 0x00ff29,
  healthLow: 0xff5c5c,
  beacon: 0xff3b30,
};

/**
 * Мир без живых генералов и без построек, кроме заказанных.
 * Тела баз в отрисовке сущностей не участвуют — их рисует территория,
 * а вот полосы прочности баз остаются здесь.
 */
const bare = (): WorldState => {
  const world = createWorld(SEED);

  return {
    ...world,
    generals: world.generals.map((general) => ({ ...general, alive: false })),
    units: [],
    shots: [],
  };
};

const wallAt = (cell: number, id = 500, owner = 0) => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  kind: StructureKind.Wall,
  cell,
  health: 100,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
  facing: DIRECTION_SOUTH,
});

/** Номер подопытного юнита. Из него же выводится фаза его покачивания. */
const UNIT_ID = 600;

const unitAt = (cell: number) => ({
  id: asEntityId(UNIT_ID),
  owner: asPlayerId(0),
  unitType: UnitType.Assault,
  position: cellCentre(cell),
  health: 100,
  facing: DIRECTION_SOUTH,
  readyAtTick: asTickNumber(0),
});

/**
 * Заглушка кеша машин.
 *
 * Запекание требует видеокарты, а проверять здесь надо не картинку,
 * а размещение: в какую полосу попала машина, где оказалась её точка
 * опоры и что раньше — тело или отражение. Поэтому кеш подменяется
 * записями с известными смещениями.
 */
const MODEL_HEIGHT = 0.3;
const BODY_OFFSET = { x: -12, y: -18 };
const MIRROR_OFFSET = { x: -12, y: 2 };

const fakeSprite = (mirror: boolean): MachineSprite => ({
  texture: undefined as unknown as MachineSprite['texture'],
  offsetX: mirror ? MIRROR_OFFSET.x : BODY_OFFSET.x,
  offsetY: mirror ? MIRROR_OFFSET.y : BODY_OFFSET.y,
  modelHeight: MODEL_HEIGHT,
});

const FAKE_MACHINES: MachineSprites = {
  unit: (_side, _unitType, _facing, _attack, _fire, mirror) => fakeSprite(mirror),
  general: (_side, _facing, mirror) => fakeSprite(mirror),
  unitHeight: () => MODEL_HEIGHT,
  dispose: () => undefined,
};

/**
 * Заглушка кеша построек.
 *
 * Смещение по высоте взято ровно геометрическим: верх спрайта приходится
 * на верх модели. Так проверяется то, ради чего заглушка и заведена, —
 * что полоса прочности висит ВЫШЕ тела. Раньше вопроса не было: тело
 * и полоса рисовались в один `Graphics` по порядку вызовов, теперь тело
 * уехало в контейнер спрайтов, и порядок вызовов ничего не решает.
 */
const STRUCTURE_HEIGHT = 0.8;
const STRUCTURE_OFFSET = { x: -20, y: -STRUCTURE_HEIGHT * ELEVATION_PX_PER_CELL };

/** Что запросили у кеша построек — по этому проверяется облик стены. */
interface StructureRequest {
  readonly kind: StructureKind;
  readonly look: number;
  readonly step: number;
}

const structureRequests: StructureRequest[] = [];

const FAKE_STRUCTURES: StructureSprites = {
  sprite: (_side, kind, look, step) => {
    structureRequests.push({ kind, look, step });

    return {
      texture: undefined as unknown as MachineSprite['texture'],
      offsetX: STRUCTURE_OFFSET.x,
      offsetY: STRUCTURE_OFFSET.y,
      modelHeight: STRUCTURE_HEIGHT,
    };
  },
  dispose: () => undefined,
};

/** Куда легла запечённая машина. */
interface Placement {
  readonly band: number;
  readonly mirror: boolean;
  readonly x: number;
  readonly y: number;
}

interface DrawResult {
  /** Полосы глубины, которые запросила отрисовка, в порядке обращения. */
  readonly bands: number[];
  /** Сколько прямоугольников ушло в полосы глубины. */
  readonly bandRects: number;
  /** Сколько прямоугольников ушло в слой поверх тел. */
  readonly overheadRects: number;
  /** Точки тел — в порядке обхода. */
  readonly bodyPoints: Point[];
  /** Размещённые машины — в порядке обращения. */
  readonly machines: Placement[];
  /** Все спрайты, и машины, и постройки, — в порядке обращения. */
  readonly sprites: Placement[];
  /** Прямоугольники полос прочности. */
  readonly rects: Rect[];
  /** Что запросили у кеша построек. */
  readonly requests: StructureRequest[];
}

const drawInto = (world: WorldState, view: ViewBounds = WHOLE_MAP): DrawResult => {
  const depth = recorder();
  const overhead = recorder();
  const bands: number[] = [];
  const machines: Placement[] = [];
  const sprites: Placement[] = [];

  structureRequests.length = 0;

  const layers: EntityLayers = {
    band(index) {
      bands.push(index);
      return depth.graphics;
    },
    sprite(index, baked, anchorX, anchorY) {
      bands.push(index);
      const placement: Placement = {
        band: index,
        mirror: baked.offsetY === MIRROR_OFFSET.y,
        x: anchorX + baked.offsetX,
        y: anchorY + baked.offsetY,
      };

      sprites.push(placement);
      if (baked.offsetX !== STRUCTURE_OFFSET.x) machines.push(placement);
    },
    overhead: overhead.graphics,
  };

  drawEntities(layers, world, view, COLORS, asPlayerId(0), FAKE_MACHINES, FAKE_STRUCTURES);

  return {
    bands,
    bandRects: depth.counts['rect'] ?? 0,
    overheadRects: overhead.counts['rect'] ?? 0,
    bodyPoints: depth.points,
    machines,
    sprites,
    rects: depth.rects,
    requests: [...structureRequests],
  };
};

/** Полосы, которые запросила отрисовка, в порядке обращения. */
const bandsFor = (world: WorldState): number[] => drawInto(world).bands;

describe('полосы глубины', () => {
  it('постройка и юнит в одной клетке попадают в одну полосу', () => {
    // Раньше постройка считалась по углу клетки, а юнит по своей точке,
    // и одна и та же клетка давала им разные полосы. Из-за этого юнит
    // севернее постройки оказывался с ней вровень и рисовался поверх,
    // хотя стоит за ней.
    const cell = cellIndex(10, 10);

    const structureBands = bandsFor({ ...bare(), structures: [wallAt(cell)] });
    const unitBands = bandsFor({ ...bare(), units: [unitAt(cell)] });

    expect(new Set(structureBands)).toEqual(new Set([21]));
    expect(new Set(unitBands)).toEqual(new Set([21]));
  });

  it('юнит южнее постройки попадает в более позднюю полосу', () => {
    const world = {
      ...bare(),
      structures: [wallAt(cellIndex(10, 10))],
      units: [unitAt(cellIndex(10, 11))],
    };

    const bands = bandsFor(world);

    // Сортировка по глубине гарантирует неубывание, а разные полосы —
    // что между ними может вклиниться территория.
    expect(bands).toEqual([...bands].sort((a, b) => a - b));
    expect(Math.max(...bands)).toBe(22);
    expect(Math.min(...bands)).toBe(21);
  });

  it('юнит севернее постройки попадает в более раннюю полосу', () => {
    const world = {
      ...bare(),
      structures: [wallAt(cellIndex(10, 10))],
      units: [unitAt(cellIndex(10, 9))],
    };

    const bands = bandsFor(world);

    expect(bands[0]).toBe(20);
    expect(Math.max(...bands)).toBe(21);
  });
});

describe('парение и отражение', () => {
  const CELL = cellIndex(10, 10);
  const ANCHOR = worldToScreen(cellX(CELL) + 0.5, cellY(CELL) + 0.5);

  /** Подъём машины на нулевом тике. Номер юнита задаёт фазу покачивания. */
  const LIFT = (UNIT_ALTITUDE + hoverBob(UNIT_ID, 0)) * ELEVATION_PX_PER_CELL;

  const placements = (tick = 0): Placement[] =>
    drawInto({ ...bare(), tick: asTickNumber(tick), units: [unitAt(CELL)] }).machines;

  it('машина поднята над землёй, а под ней лежит её отражение', () => {
    const [first, second] = placements();
    if (first === undefined || second === undefined) throw new Error('машина не размещена');

    expect(first.mirror).toBe(true);
    expect(second.mirror).toBe(false);
    expect(second.y).toBeCloseTo(ANCHOR.y - LIFT + BODY_OFFSET.y, 6);
    expect(first.y).toBeCloseTo(ANCHOR.y + LIFT * MIRROR_SQUASH + MIRROR_OFFSET.y, 6);
  });

  it('отражение рисуется раньше тела', () => {
    // Отражение лежит в поверхности, машина висит над ней: нарисуй мы его
    // после, оно перекрыло бы собственные колёса.
    const placed = placements();

    expect(placed.findIndex((item) => item.mirror)).toBeLessThan(
      placed.findIndex((item) => !item.mirror),
    );
  });

  it('тело и отражение попадают в одну полосу глубины', () => {
    // Отражение обязано прятаться за тем, что стоит ближе к зрителю,
    // ровно как сама машина, — а это и есть механизм полос.
    expect(new Set(placements().map((item) => item.band))).toEqual(new Set([21]));
  });

  it('в разные тики машина стоит на разной высоте', () => {
    expect(placements(18)).not.toEqual(placements(0));
  });
});

describe('постройка — спрайт', () => {
  const CELL = cellIndex(10, 10);
  const ANCHOR = worldToScreen(cellX(CELL) + 0.5, cellY(CELL) + 0.5);

  it('тело уходит спрайтом, а не многоугольниками', () => {
    // Прежде постройка трассировала три-четыре десятка многоугольников
    // на каждом кадре. Ради ухода от этого всё и затевалось, поэтому
    // проверяется не «спрайт появился», а «многоугольников не осталось».
    const result = drawInto({ ...bare(), structures: [wallAt(CELL)] });

    expect(result.sprites).toHaveLength(1);
    expect(result.bodyPoints).toEqual([]);
    expect(result.sprites[0]?.x).toBeCloseTo(ANCHOR.x + STRUCTURE_OFFSET.x, 6);
    expect(result.sprites[0]?.y).toBeCloseTo(ANCHOR.y + STRUCTURE_OFFSET.y, 6);
  });

  it('полоса прочности висит выше тела', () => {
    // Раньше вопроса не было: тело и полоса шли в один `Graphics`
    // по порядку вызовов. Теперь тело лежит в контейнере спрайтов,
    // который сцена добавляет ПОСЛЕ слоя полос, — и если полоса
    // не окажется выше модели, тело её закроет.
    const damaged = { ...wallAt(CELL), health: 1 };
    const result = drawInto({ ...bare(), structures: [damaged] });

    const bar = result.rects[0];
    const body = result.sprites[0];
    if (bar === undefined || body === undefined) throw new Error('нечего сравнивать');

    expect(bar.y + bar.height).toBeLessThan(body.y);
  });

  it('постройка ложится в полосу раньше машины той же полосы', () => {
    // Порядок внутри контейнера — это порядок обращений, поэтому важно
    // не то, кто в каком слое, а кто раньше попросил.
    const world = {
      ...bare(),
      structures: [wallAt(CELL)],
      units: [unitAt(cellIndex(9, 11))],
    };

    const placed = drawInto(world).sprites;
    const structure = placed.findIndex((item) => item.x === ANCHOR.x + STRUCTURE_OFFSET.x);

    expect(structure).toBe(0);
    expect(placed.length).toBeGreaterThan(1);
  });
});

describe('облик постройки', () => {
  it('башня спрашивает облик по румбу турели', () => {
    const tower = {
      ...wallAt(cellIndex(10, 10)),
      kind: StructureKind.TowerBasic,
      facing: 5,
    };

    const { requests } = drawInto({ ...bare(), structures: [tower] });

    expect(requests).toEqual([{ kind: StructureKind.TowerBasic, look: 5, step: 7 }]);
  });

  it('стена спрашивает облик по связям с соседями, а не по румбу', () => {
    // Румб у стены в состоянии мира есть, но модель его не спрашивает:
    // он записывается при постройке и не меняется никогда, а линию
    // заграждения задают соседи.
    const world = {
      ...bare(),
      structures: [wallAt(cellIndex(10, 10), 500), wallAt(cellIndex(11, 10), 501)],
    };

    const looks = drawInto(world).requests.map((request) => request.look);

    expect(looks).toEqual([WALL_LINK_EAST, WALL_LINK_WEST]);
  });
});

describe('полоса прочности базы', () => {
  it('уходит в слой поверх тел, а не в полосу глубины', () => {
    // В голом мире нет ни юнитов, ни башен — остаются только две базы,
    // значит всё нарисованное нарисовано ими.
    const result = drawInto(bare());

    expect(result.overheadRects).toBeGreaterThan(0);
    expect(result.bands).toEqual([]);
  });

  it('рисуется у нетронутой базы, в отличие от целой стены', () => {
    const world = bare();
    const player = world.players[0];
    if (player === undefined) throw new Error('в мире нет игрока');

    // Здоровье берётся из баланса, а не назначается числом: стена с сотней
    // очков при максимуме в несколько сотен считалась бы повреждённой,
    // и проверка ничего бы не значила.
    const intact = {
      ...wallAt(cellIndex(10, 10)),
      health: structureMaxHealth(playerStats(player).structures[StructureKind.Wall], PPM_ONE),
    };

    // Целая стена полосы не получает: полсотни одинаковых чёрточек
    // над строем были бы шумом.
    expect(drawInto({ ...world, structures: [intact] }).bandRects).toBe(0);

    // База получает всегда: «полосы нет» и «база цела» — разные сообщения,
    // а по пустому месту их не различить.
    expect(drawInto(world).overheadRects).toBeGreaterThan(0);
  });

  it('не пропадает, когда основание базы ушло за нижнюю кромку экрана', () => {
    const world = bare();
    const [base] = world.structures;
    if (base === undefined) throw new Error('в мире нет базы');

    const x = cellX(base.cell);
    const y = cellY(base.cell);
    const ground = worldToScreen(x, y);
    const crest = baseCrestPoint(x, y);

    // Окно поставлено так, что полоса лежит ровно на нижней кромке,
    // а основание базы — далеко под ней.
    const view: ViewBounds = {
      minX: crest.x - 300,
      maxX: crest.x + 300,
      minY: crest.y - 300,
      maxY: crest.y,
    };

    // Ловушка, ради которой отсечение и считается по полосе: основание
    // ушло под кромку дальше, чем запас на отсечение в 160 пикселей.
    expect(ground.y - view.maxY).toBeGreaterThan(200);
    expect(drawInto(world, view).overheadRects).toBeGreaterThan(0);
  });
});
