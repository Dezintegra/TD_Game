import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import {
  DIRECTION_SOUTH,
  PPM_ONE,
  ShotWeapon,
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
import type { ShotState, WorldState } from '@td/sim';
import { drawEntities } from './entities.js';
import type { EntityColors, EntityLayers, ViewBounds } from './entities.js';
import { baseCrestPoint } from './base-structure.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import {
  MIRROR_SQUASH,
  SIDE_SELF,
  UNIT_ALTITUDE,
  hoverBob,
  unitReflection,
  unitSilhouette,
} from './models.js';
import type { Silhouette } from './models.js';

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
interface Recorder {
  readonly graphics: Graphics;
  readonly counts: Record<string, number>;
  /** Точки, через которые прошёл путь. По ним проверяется геометрия. */
  readonly points: Point[];
  /** Толщины обводок. По ним проверяется, что луч толще трассера. */
  readonly widths: number[];
}

const recorder = (): Recorder => {
  const counts: Record<string, number> = {};
  const points: Point[] = [];
  const widths: number[] = [];
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

      return stub;
    };
  }

  return { graphics: stub as unknown as Graphics, counts, points, widths };
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
  hullDark: 0x23271f,
  ground: 0x191919,
  health: 0x00ff29,
  healthLow: 0xff5c5c,
  shot: 0xeaffef,
  shotLethal: 0xff5c5c,
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

const wallAt = (cell: number) => ({
  id: asEntityId(500),
  owner: asPlayerId(0),
  kind: StructureKind.Wall,
  cell,
  health: 100,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
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

interface DrawResult {
  /** Полосы глубины, которые запросила отрисовка, в порядке обращения. */
  readonly bands: number[];
  /** Сколько прямоугольников ушло в полосы глубины. */
  readonly bandRects: number;
  /** Сколько прямоугольников ушло в слой поверх тел. */
  readonly overheadRects: number;
  /** Точки тел — в порядке обхода. */
  readonly bodyPoints: Point[];
  /** Точки следов выстрелов. Слой у них свой, поэтому и точки отдельно. */
  readonly shotPoints: Point[];
  /** Толщины обводок следов выстрелов. */
  readonly shotWidths: number[];
}

const drawInto = (world: WorldState, view: ViewBounds = WHOLE_MAP): DrawResult => {
  const depth = recorder();
  const shots = recorder();
  const overhead = recorder();
  const bands: number[] = [];

  const layers: EntityLayers = {
    band(index) {
      bands.push(index);
      return depth.graphics;
    },
    shots: shots.graphics,
    overhead: overhead.graphics,
  };

  drawEntities(layers, world, view, COLORS, asPlayerId(0));

  return {
    bands,
    bandRects: depth.counts['rect'] ?? 0,
    overheadRects: overhead.counts['rect'] ?? 0,
    bodyPoints: depth.points,
    shotPoints: shots.points,
    shotWidths: shots.widths,
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

  const model = (): Silhouette =>
    unitSilhouette(COLORS, SIDE_SELF, UnitType.Assault, DIRECTION_SOUTH, 0, 0);
  const mirror = (): Silhouette =>
    unitReflection(COLORS, SIDE_SELF, UnitType.Assault, DIRECTION_SOUTH, 0, 0);

  /** Самая верхняя и самая нижняя точки готовой геометрии. */
  const span = (silhouette: Silhouette): { top: number; bottom: number } => {
    let top = Infinity;
    let bottom = -Infinity;

    for (const run of silhouette.fills) {
      for (const polygon of run.polygons) {
        for (const point of polygon) {
          top = Math.min(top, point.y);
          bottom = Math.max(bottom, point.y);
        }
      }
    }

    return { top, bottom };
  };

  const drawUnit = (tick = 0): Point[] =>
    drawInto({ ...bare(), tick: asTickNumber(tick), units: [unitAt(CELL)] }).bodyPoints;

  it('машина поднята над землёй, а под ней лежит её отражение', () => {
    // Целая машина полосы здоровья не получает, поэтому в слой попали
    // только два тела: она сама и её отражение. Верх картины принадлежит
    // ей, низ — отражению.
    const points = drawUnit();

    expect(Math.min(...points.map((point) => point.y))).toBeCloseTo(
      ANCHOR.y - LIFT + span(model()).top,
      6,
    );
    expect(Math.max(...points.map((point) => point.y))).toBeCloseTo(
      ANCHOR.y + LIFT * MIRROR_SQUASH + span(mirror()).bottom,
      6,
    );
  });

  it('отражение рисуется раньше тела', () => {
    // Отражение лежит в поверхности, машина висит над ней: нарисуй мы его
    // после, оно перекрыло бы собственные колёса.
    const points = drawUnit();
    const highest = Math.min(...points.map((point) => point.y));
    const deepest = Math.max(...points.map((point) => point.y));

    expect(points.findIndex((point) => point.y === deepest)).toBeLessThan(
      points.findIndex((point) => point.y === highest),
    );
  });

  it('тело и отражение попадают в одну полосу глубины', () => {
    // Отражение обязано прятаться за тем, что стоит ближе к зрителю,
    // ровно как сама машина, — а это и есть механизм полос.
    expect(new Set(drawInto({ ...bare(), units: [unitAt(CELL)] }).bands)).toEqual(new Set([21]));
  });

  it('в разные тики машина стоит на разной высоте', () => {
    expect(drawUnit(18)).not.toEqual(drawUnit(0));
  });
});

describe('облик выстрела', () => {
  const FROM = cellIndex(10, 10);
  const TO = cellIndex(14, 10);

  const START = worldToScreen(cellX(FROM) + 0.5, cellY(FROM) + 0.5);
  const FINISH = worldToScreen(cellX(TO) + 0.5, cellY(TO) + 0.5);

  const shotOf = (weapon: ShotWeapon): ShotState => ({
    owner: asPlayerId(0),
    from: cellCentre(FROM),
    to: cellCentre(TO),
    expiresAtTick: asTickNumber(4),
    lethal: false,
    weapon,
  });

  const draw = (weapon: ShotWeapon, tick = 0): DrawResult =>
    drawInto({ ...bare(), tick: asTickNumber(tick), shots: [shotOf(weapon)] });

  it('трассер держится над землёй и не отражается', () => {
    // Сравнивать надо каждый конец со своей точкой земли: экранная `y`
    // растёт и от высоты, и от положения на плоскости, поэтому дальний
    // конец трассера лежит ниже ближнего, оставаясь над землёй.
    const points = draw(ShotWeapon.Bolt).shotPoints;
    const [start, finish] = points;

    expect(points).toHaveLength(2);
    expect(start?.y).toBeLessThan(START.y);
    expect(finish?.y).toBeLessThan(FINISH.y);
  });

  it('луч толще трассера', () => {
    const bolt = Math.max(...draw(ShotWeapon.Bolt).shotWidths);
    const beam = Math.max(...draw(ShotWeapon.Beam).shotWidths);

    // Не на волосок: разницу должно быть видно, не приглядываясь.
    expect(beam).toBeGreaterThan(bolt * 2);
  });

  it('луч отражается в поверхности', () => {
    // У стрелка луч трижды проходит через одну и ту же вертикаль: ореол,
    // ядро и отражение. Отражение — то из трёх, что ушло под землю.
    const atShooter = draw(ShotWeapon.Beam).shotPoints.filter((point) => point.x === START.x);

    expect(atShooter.length).toBeGreaterThan(1);
    expect(atShooter.some((point) => point.y > START.y)).toBe(true);
  });

  it('разряд выходит из ствола и приходит в цель', () => {
    // Излом — это облик, а не промах: концы обязаны стоять там же,
    // где стояли бы концы трассера.
    const points = draw(ShotWeapon.Arc).shotPoints;
    const first = points[0];
    const arrival = points.find((point) => point.x === FINISH.x);

    if (first === undefined || arrival === undefined) throw new Error('разряд не дошёл до цели');

    expect(first.x).toBe(START.x);
    expect(arrival.y - first.y).toBeCloseTo(FINISH.y - START.y, 6);
  });

  it('разряд изломан, а не прям', () => {
    const points = draw(ShotWeapon.Arc).shotPoints;
    const first = points[0];
    if (first === undefined) throw new Error('разряд не нарисован');

    const alongX = FINISH.x - START.x;
    const alongY = FINISH.y - START.y;
    const offLine = points.some(
      (point) => Math.abs((point.x - first.x) * alongY - (point.y - first.y) * alongX) > 1,
    );

    expect(offLine).toBe(true);
  });

  it('разряд держит форму весь тик и вспыхивает заново на следующем', () => {
    const now = draw(ShotWeapon.Arc).shotPoints;

    expect(draw(ShotWeapon.Arc).shotPoints).toEqual(now);
    expect(draw(ShotWeapon.Arc, 1).shotPoints).not.toEqual(now);
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
