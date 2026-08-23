import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import {
  BLAST_LIFETIME_TICKS,
  BlastKind,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  NUKE_DELAY_TICKS,
  NUKE_RADIUS_CELLS,
  TICKS_PER_SECOND,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellIndex, cellX as cellColumn, cellY as cellRow, createWorld } from '@td/sim';
import type { BlastState, NukeState, WorldState } from '@td/sim';
import {
  drawBlasts,
  missileFlight,
  particleHeight,
  resetBlastPaints,
  shakeOffset,
  travel,
} from './blasts.js';
import type { BlastColors, BlastLayers, FlightPoint } from './blasts.js';
import { BASE_ANTENNA_HEIGHT, BASE_LAUNCH_POINT } from './base-structure.js';
import type { ViewBounds } from './entities.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';

/**
 * Взрыв проверяется не картинкой, а тем, что попало в слои.
 *
 * Скриншот сказал бы то же самое и перестал бы что-либо доказывать при
 * первой смене палитры. А вот «в слое света появилась заливка», «габариты
 * нарисованного выросли», «два вызова совпали точка в точку» — утверждения
 * об облике, не зависящие от цвета.
 *
 * Выкладка частиц и полёт ракеты проверяются напрямую, а не по пикселям.
 * Причина в проекции: экранная `y` несёт и высоту, и положение на плоскости,
 * поэтому «искра поднялась» по одной нарисованной точке неотличимо
 * от «искра отлетела на юг».
 */

const SEED = 4242;

interface Recorder {
  readonly graphics: Graphics;
  readonly counts: Record<string, number>;
  /** Точки путей и центры кругов: по ним считаются габариты. */
  readonly points: Point[];
  /** Прозрачность заливок. По ней проверяется угасание. */
  readonly fillAlphas: number[];
  /** Цвета сплошных заливок. По ним проверяется цвет обломков. */
  readonly fillColors: number[];
  /** Заготовки градиентов. По ним проверяется, что они не строятся заново. */
  readonly gradients: unknown[];
  /** Центры и радиусы кругов. По ним проверяется подъём гриба. */
  readonly circles: { x: number; y: number; r: number }[];
  readonly strokeAlphas: number[];
  /** Толщины обводок. По ним проверяется, что вал пыли толстеет. */
  readonly strokeWidths: number[];
}

const recorder = (): Recorder => {
  const counts: Record<string, number> = {};
  const points: Point[] = [];
  const fillAlphas: number[] = [];
  const fillColors: number[] = [];
  const gradients: unknown[] = [];
  const circles: { x: number; y: number; r: number }[] = [];
  const strokeAlphas: number[] = [];
  const strokeWidths: number[] = [];
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

      if (name === 'circle' && args.length >= 3) {
        // Круг даёт две точки — крайние по горизонтали. Так габариты
        // нарисованного учитывают радиус, а не только центр.
        const [x, y, radius] = args as [number, number, number];
        points.push({ x: x - radius, y }, { x: x + radius, y });
        circles.push({ x, y, r: radius });
      }

      if (name === 'fill') {
        const style = args[0] as { alpha?: number; color?: number; fill?: unknown } | undefined;
        if (style?.alpha !== undefined) fillAlphas.push(style.alpha);
        if (style?.color !== undefined) fillColors.push(style.color);
        if (style?.fill !== undefined) gradients.push(style.fill);
      }

      if (name === 'stroke') {
        const style = args[0] as { alpha?: number; width?: number } | undefined;
        if (style?.alpha !== undefined) strokeAlphas.push(style.alpha);
        if (style?.width !== undefined) strokeWidths.push(style.width);
      }

      return stub;
    };
  }

  return {
    graphics: stub as unknown as Graphics,
    counts,
    points,
    fillAlphas,
    fillColors,
    gradients,
    circles,
    strokeAlphas,
    strokeWidths,
  };
};

interface Capture {
  readonly debris: Recorder;
  readonly glow: Recorder;
  readonly flash: Recorder;
  readonly shake: number;
}

const COLORS: BlastColors = {
  self: 0x00ff29,
  enemy: 0xd264ff,
  hullDark: 0x23271f,
  core: 0xfff6e0,
  fire: 0xff8a2b,
  smoke: 0x2b2622,
};

/** Экран заведомо больше карты: отсечение по видимости не должно мешать. */
const WHOLE_MAP: ViewBounds = { minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6 };

const VIEWPORT = { width: 1600, height: 900 };

const CENTRE_CELL = cellIndex(MAP_WIDTH_CELLS / 2, MAP_HEIGHT_CELLS / 2);

const blastAt = (kind: BlastKind, owner: number, cellX: number, cellY: number): BlastState => ({
  at: { x: cellsToUnits(cellX), y: cellsToUnits(cellY) },
  kind,
  owner: asPlayerId(owner),
  // Срок истечения равен сроку жизни: значит, взрыв начался на нулевом
  // тике, и время отрисовки читается прямо как возраст.
  expiresAtTick: asTickNumber(BLAST_LIFETIME_TICKS[kind]),
});

const worldWith = (
  blasts: readonly BlastState[],
  nukes: readonly NukeState[] = [],
): WorldState => ({
  ...createWorld(SEED),
  blasts,
  nukes,
});

const draw = (
  world: WorldState,
  seconds: number,
  view: ViewBounds = WHOLE_MAP,
  localPlayer: PlayerId = asPlayerId(0),
): Capture => {
  const debris = recorder();
  const glow = recorder();
  const flash = recorder();

  const layers: BlastLayers = {
    debris: debris.graphics,
    glow: glow.graphics,
    flash: flash.graphics,
  };

  const shake = drawBlasts(
    layers,
    world,
    seconds * TICKS_PER_SECOND,
    view,
    VIEWPORT,
    COLORS,
    localPlayer,
  );

  return { debris, glow, flash, shake };
};

/** Насколько далеко нарисованное уходит от точки. */
const reachFrom = (points: readonly Point[], from: Point): number =>
  points.reduce((far, point) => Math.max(far, Math.hypot(point.x - from.x, point.y - from.y)), 0);

const largest = (values: readonly number[]): number =>
  values.reduce((top, value) => Math.max(top, value), 0);

describe('выкладка частиц', () => {
  it('путь растёт и вязнет', () => {
    // Сопротивление воздуха: обломок стартует резко и замедляется.
    // Без этого разлёт читается расходящимся кольцом точек.
    const first = travel(5, 0.1) - travel(5, 0);
    const later = travel(5, 0.6) - travel(5, 0.5);

    expect(travel(5, 0.5)).toBeGreaterThan(travel(5, 0.1));
    expect(later).toBeLessThan(first);
  });

  it('высота сперва растёт, потом убывает', () => {
    const rising = particleHeight(0.1, 3, 0.15);
    const peak = particleHeight(0.1, 3, 3 / 9);
    const falling = particleHeight(0.1, 3, 0.5);

    expect(peak).toBeGreaterThan(rising);
    expect(falling).toBeLessThan(peak);
  });

  it('упавшая частица остаётся на земле, а не проваливается', () => {
    expect(particleHeight(0.1, 1, 5)).toBe(0);
  });
});

describe('взрыв', () => {
  const unitBlast = (owner = 1): WorldState => worldWith([blastAt(BlastKind.Unit, owner, 24, 24)]);

  it('даёт вспышку в слое света', () => {
    const { glow } = draw(unitBlast(), 0.05);

    expect(glow.counts['fill'] ?? 0).toBeGreaterThan(0);
  });

  it('даёт обломки и дым в слое тел', () => {
    const { debris } = draw(unitBlast(), 0.2);

    expect(debris.counts['fill'] ?? 0).toBeGreaterThan(0);
  });

  it('искры разлетаются от эпицентра', () => {
    const epicentre = worldToScreen(24, 24);

    const early = reachFrom(draw(unitBlast(), 0.04).glow.points, epicentre);
    const late = reachFrom(draw(unitBlast(), 0.35).glow.points, epicentre);

    expect(late).toBeGreaterThan(early);
  });

  it('обломки окрашены цветом стороны', () => {
    // Единственное, чем взрыв сообщает принадлежность: свет, огонь и дым
    // у обеих сторон одинаковые.
    const mine = draw(unitBlast(0), 0.2).debris.fillColors;
    const theirs = draw(unitBlast(1), 0.2).debris.fillColors;

    expect(mine).not.toEqual(theirs);
  });

  it('форма разлёта повторяется', () => {
    const first = draw(unitBlast(), 0.2);
    const second = draw(unitBlast(), 0.2);

    expect(first.glow.points).toEqual(second.glow.points);
    expect(first.debris.points).toEqual(second.debris.points);
  });

  it('форма разлёта различается у разных взрывов', () => {
    const here = worldWith([blastAt(BlastKind.Unit, 1, 24, 24)]);
    const there = worldWith([blastAt(BlastKind.Unit, 1, 30, 30)]);

    // Сравниваются смещения от своего эпицентра, а не точки: иначе тест
    // проходил бы просто оттого, что взрывы в разных местах.
    const shape = (world: WorldState, cx: number, cy: number): number[] => {
      const centre = worldToScreen(cx, cy);
      return draw(world, 0.2).glow.points.map((point) => point.x - centre.x);
    };

    expect(shape(here, 24, 24)).not.toEqual(shape(there, 30, 30));
  });

  it('за экраном не рисуется', () => {
    const far: ViewBounds = { minX: 40_000, maxX: 41_000, minY: 40_000, maxY: 41_000 };
    const { glow, debris } = draw(unitBlast(), 0.2, far);

    expect(glow.counts).toEqual({});
    expect(debris.counts).toEqual({});
  });

  it('гибель юнита картинку не трясёт', () => {
    // В бою юниты гибнут по нескольку в секунду, и поле дрожало бы
    // непрерывно.
    for (const kind of [BlastKind.Unit, BlastKind.General, BlastKind.Structure]) {
      expect(draw(worldWith([blastAt(kind, 1, 24, 24)]), 0.05).shake).toBe(0);
    }
  });

  it('обычный взрыв экран не засвечивает', () => {
    expect(draw(unitBlast(), 0.05).flash.counts).toEqual({});
  });

  it('в толпе подробности достаются не всем, но пропасть не даёт никто', () => {
    // Дым и обломки — самое дорогое во взрыве и самое незаметное в толпе.
    // Сверх бюджета кадра взрыв рисуется коротко: ядро вспышки и искры.
    const crowd = (count: number): WorldState =>
      worldWith(
        Array.from({ length: count }, (unused, index) =>
          blastAt(BlastKind.Unit, 1, 22 + (index % 8) * 0.5, 22 + Math.floor(index / 8) * 0.5),
        ),
      );

    const ten = draw(crowd(10), 0.2);
    const forty = draw(crowd(40), 0.2);

    const debrisFills = (capture: typeof ten): number => capture.debris.counts['fill'] ?? 0;

    // Вчетверо больше взрывов — дыма и обломков не больше, чем у десяти.
    // Точного равенства не требуем: подробности достаются другой десятке,
    // зёрна у неё свои, и один-другой клуб может ещё не начаться.
    expect(debrisFills(forty)).toBeGreaterThan(0);
    expect(debrisFills(forty)).toBeLessThanOrEqual(debrisFills(ten) + 2);

    // Но ни один не пропал: свет достаётся каждому.
    expect(forty.glow.counts['fill'] ?? 0).toBeGreaterThan(ten.glow.counts['fill'] ?? 0);
  });
  it('заготовка градиента строится один раз, а не на частицу', () => {
    // Свойство не косметическое: `FillGradient` строит текстуру, и сотня
    // частиц со своей заготовкой означала бы сотню текстур за кадр.
    const first = draw(unitBlast(), 0.2).glow.gradients;
    const second = draw(unitBlast(), 0.25).glow.gradients;

    expect(first.length).toBeGreaterThan(1);
    expect(new Set([...first, ...second]).size).toBeLessThan(first.length);
  });

  it('сброс заготовок заставляет строить их заново', () => {
    const before = draw(unitBlast(), 0.2).glow.gradients[0];
    resetBlastPaints();
    const after = draw(unitBlast(), 0.2).glow.gradients[0];

    expect(after).not.toBe(before);
  });
});

describe('ядерный взрыв', () => {
  const nukeBlast = (): WorldState => worldWith([blastAt(BlastKind.Nuke, 0, 24, 24)]);

  it('ударная волна расходится дальше радиуса поражения', () => {
    const epicentre = worldToScreen(24, 24);
    const edge = Math.abs(worldToScreen(24 + NUKE_RADIUS_CELLS, 24).x - epicentre.x);

    const early = reachFrom(draw(nukeBlast(), 0.2).glow.points, epicentre);
    const late = reachFrom(draw(nukeBlast(), 1.6).glow.points, epicentre);

    expect(late).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(edge);
  });

  it('ударная волна гаснет по мере расхождения', () => {
    const early = largest(draw(nukeBlast(), 0.6).glow.strokeAlphas);
    const late = largest(draw(nukeBlast(), 1.9).glow.strokeAlphas);

    expect(late).toBeLessThan(early);
  });

  it('засвечивает экран и гаснет', () => {
    const peak = largest(draw(nukeBlast(), 0.06).flash.fillAlphas);
    const later = largest(draw(nukeBlast(), 1.5).flash.fillAlphas);

    expect(peak).toBeGreaterThan(0.3);
    expect(later).toBeLessThan(peak);
  });

  it('дальний взрыв засвечивает слабее', () => {
    const epicentre = worldToScreen(24, 24);
    const near: ViewBounds = {
      minX: epicentre.x - 800,
      maxX: epicentre.x + 800,
      minY: epicentre.y - 450,
      maxY: epicentre.y + 450,
    };
    const far: ViewBounds = {
      minX: epicentre.x + 3000,
      maxX: epicentre.x + 4600,
      minY: epicentre.y + 3000,
      maxY: epicentre.y + 3900,
    };

    const close = largest(draw(nukeBlast(), 0.06, near).flash.fillAlphas);
    const distant = largest(draw(nukeBlast(), 0.06, far).flash.fillAlphas);

    expect(distant).toBeLessThan(close);
  });

  it('трясёт картинку и успокаивается', () => {
    expect(draw(nukeBlast(), 0.05).shake).toBeGreaterThan(0);
    expect(draw(nukeBlast(), 4.5).shake).toBe(0);
  });

  it('без тряски смещения нет вовсе', () => {
    // Ноль здесь означает «контейнер стоит на месте», а не «стоит почти
    // на месте»: дрожание в полпикселя на неподвижном поле заметнее,
    // чем кажется.
    expect(shakeOffset(0, 12)).toEqual({ x: 0, y: 0 });
  });

  it('смещение колеблется, а не дрожит', () => {
    const path = [0, 4, 8, 12, 16, 20, 24].map((tick) => shakeOffset(30, tick));

    // Колебание обязано менять знак: смещение, всегда уводящее в одну
    // сторону, читается сползанием камеры, а не ударом.
    expect(path.some((point) => point.x > 0)).toBe(true);
    expect(path.some((point) => point.x < 0)).toBe(true);

    // Оси не должны ходить в такт: при совпадающих частотах картинка
    // ездила бы по одной диагонали.
    expect(path.map((point) => point.x)).not.toEqual(path.map((point) => point.y));
  });

  it('поднимает гриб', () => {
    // Меряются центры кругов над самым эпицентром, а не самая верхняя
    // точка слоя. Верхнюю точку занимает дальний край пыльного вала:
    // он расходится на десятки клеток, и в этой проекции его северная
    // кромка уходит по экрану выше любого гриба.
    const epicentre = worldToScreen(24, 24);

    const capTop = (seconds: number): number =>
      draw(nukeBlast(), seconds)
        .debris.circles.filter((circle) => Math.abs(circle.x - epicentre.x) < 40)
        .reduce((high, circle) => Math.min(high, circle.y), Number.POSITIVE_INFINITY);

    expect(capTop(2.5)).toBeLessThan(capTop(1.0));
  });

  it('ударная волна идёт валом пыли, а не линией', () => {
    // Вал рисуется в слое тел, а не в слое света: пыль это тело.
    // И он толстеет по мере расхождения — тем и отличается катящаяся
    // стена от расходящейся ряби.
    const band = (seconds: number): number =>
      largest(draw(nukeBlast(), seconds).debris.strokeWidths);

    expect(band(0.3)).toBeGreaterThan(0);
    expect(band(1.5)).toBeGreaterThan(band(0.3));
  });
});

describe('ракета', () => {
  const MAP = createWorld(SEED).map;

  const nuke = (owner: number, cell: number = CENTRE_CELL): NukeState => ({
    id: asEntityId(900),
    owner: asPlayerId(owner),
    cell,
    detonateAtTick: asTickNumber(NUKE_DELAY_TICKS),
  });

  /**
   * Срез пусковой установки на базе игрока, в мировых координатах.
   *
   * Складывается с клеткой базы БЕЗ полклетки: точка привязки модели
   * базы — узел сетки, то есть угол клетки, а не её середина.
   */
  const launchOf = (owner: number): FlightPoint => {
    const cell = MAP.baseCells[owner] ?? 0;

    return {
      x: cellColumn(cell) + BASE_LAUNCH_POINT.x,
      y: cellRow(cell) + BASE_LAUNCH_POINT.y,
      height: BASE_LAUNCH_POINT.z,
    };
  };

  const targetOf = (cell: number): Point => ({ x: cellColumn(cell) + 0.5, y: cellRow(cell) + 0.5 });

  const flight = (progress: number, cell: number = CENTRE_CELL): FlightPoint => {
    const target = targetOf(cell);

    return missileFlight(launchOf(0), target.x, target.y, progress);
  };

  const heightAt = (progress: number): number => flight(progress).height;

  /** Мировая точка полёта → точка на экране, с учётом высоты. */
  const screenOf = (point: FlightPoint): Point => {
    const flat = worldToScreen(point.x, point.y);

    return { x: flat.x, y: flat.y - point.height * ELEVATION_PX_PER_CELL };
  };

  /** Половина полёта, в секундах. */
  const HALF_FLIGHT = NUKE_DELAY_TICKS / TICKS_PER_SECOND / 2;

  it('стартует на пусковой установке своей базы', () => {
    const start = flight(0);
    const launch = launchOf(0);

    expect(start.x).toBeCloseTo(launch.x);
    expect(start.y).toBeCloseTo(launch.y);
    expect(start.height).toBeCloseTo(launch.height);

    // И это заведомо не цель: иначе «стартует на базе» выполнялось бы
    // само собой на ударе, наведённом у собственной площадки.
    const target = targetOf(CENTRE_CELL);
    expect(Math.hypot(start.x - target.x, start.y - target.y)).toBeGreaterThan(NUKE_RADIUS_CELLS);
  });

  it('поднимается, а потом снижается', () => {
    expect(heightAt(0.3)).toBeGreaterThan(heightAt(0));
    expect(heightAt(0.3)).toBeGreaterThan(heightAt(0.9));
  });

  it('снижается ускоряясь, а не тормозя перед землёй', () => {
    // Равные доли времени на снижении, ранняя и поздняя. Обратное
    // соотношение означало бы посадку, а не удар.
    const early = heightAt(0.4) - heightAt(0.6);
    const late = heightAt(0.8) - heightAt(1);

    expect(late).toBeGreaterThan(early);
  });

  it('приходит к земле к моменту взрыва', () => {
    expect(heightAt(1)).toBe(0);
  });

  it('сходит с направляющей почти отвесно', () => {
    const start = flight(0);
    const soon = flight(0.1);
    const target = targetOf(CENTRE_CELL);

    const span = Math.hypot(target.x - start.x, target.y - start.y);
    const gone = Math.hypot(soon.x - start.x, soon.y - start.y);

    // Десятая доля времени — и меньше двадцатой доли пути: ракета в это
    // время занята подъёмом, а не сближением.
    expect(gone / span).toBeLessThan(0.05);
    expect(soon.height).toBeGreaterThan(start.height * 2);
  });

  it('уходит за верхнюю кромку окна и возвращается из-за неё', () => {
    // Вершина берётся перебором, а не формулой: тест не должен повторять
    // выкладку, которую проверяет.
    const apexOf = (cell: number): number => {
      let top = 0;
      for (let step = 0; step <= 100; step += 1) {
        top = Math.max(top, flight(step / 100, cell).height);
      }

      return top;
    };

    // Выше ВСЕГО окна, а не половины: тогда ракета за кромкой при любом
    // положении камеры, а не только когда цель ровно посередине.
    expect(apexOf(CENTRE_CELL) * ELEVATION_PX_PER_CELL).toBeGreaterThan(VIEWPORT.height);

    // «За кромкой окна» — свойство экрана, а не карты: ближний удар
    // обязан уйти ровно так же высоко, как дальний.
    expect(apexOf(cellTowardsCentre(MAP.baseCells[0] ?? 0, 8))).toBeCloseTo(apexOf(CENTRE_CELL));

    // И к последней десятой доле пути ракета уже вернулась в кадр.
    expect(heightAt(0.9)).toBeGreaterThan(BASE_ANTENNA_HEIGHT);
    expect(heightAt(0.9) * ELEVATION_PX_PER_CELL).toBeLessThan(VIEWPORT.height / 2);
  });

  it('входит в кадр отвесно над целью', () => {
    // Отвесность обычно и порицают — растущая на месте точка не сообщает
    // направления. Но ракета не возникает над целью, а входит в кадр
    // сверху со следом: направление сообщает появление, а не наклон.
    const target = targetOf(CENTRE_CELL);
    const start = flight(0);
    const diving = flight(0.9);

    const span = Math.hypot(target.x - start.x, target.y - start.y);
    const aside = Math.hypot(diving.x - target.x, diving.y - target.y);

    expect(aside).toBeLessThan(span * 0.05);
  });

  it('след тянется от базы владельца', () => {
    const { debris } = draw(worldWith([], [nuke(0)]), HALF_FLIGHT);
    const start = screenOf(flight(0));

    const nearest = debris.points.reduce(
      (near, point) => Math.min(near, Math.hypot(point.x - start.x, point.y - start.y)),
      Number.POSITIVE_INFINITY,
    );

    // Дальний конец следа — это и есть точка схода: след протянут
    // от площадки до ракеты целиком, а не коротким хвостом за ней.
    expect(nearest).toBeLessThan(1);
  });

  it('факел держится у сопла, а не растягивается вместе со следом', () => {
    // Горящий участок задан долей полёта. Будь он задан номером звена,
    // к концу полёта он растянулся бы вместе со следом на четверть карты.
    const { debris, glow } = draw(
      worldWith([], [nuke(0)]),
      (NUKE_DELAY_TICKS * 0.95) / TICKS_PER_SECOND,
    );
    const nose = screenOf(flight(0.95));

    expect(reachFrom(glow.points, nose)).toBeLessThan(reachFrom(debris.points, nose) / 4);
  });

  it('на старте корпус не схлопывается в точку', () => {
    // Направление полёта берётся центральной разностью: односторонняя
    // на нулевой доле дала бы нулевую длину и выродила бы ромб корпуса.
    const { debris } = draw(worldWith([], [nuke(0)]), 0);

    expect(reachFrom(debris.points, screenOf(flight(0)))).toBeGreaterThan(5);
  });

  it('ракеты двух игроков уходят с разных мест', () => {
    const world = (owner: number): WorldState => worldWith([], [nuke(owner)]);

    const mine = draw(world(0), 0).debris.points;
    const theirs = draw(world(1), 0).debris.points;

    expect(mine).not.toEqual(theirs);
    expect(mine.length).toBeGreaterThan(0);
  });

  it('после взрыва не рисуется', () => {
    // Запись об ударе к этому моменту из состояния мира уже удалена,
    // и рисовать ракету нечему: своей памяти у модуля нет.
    expect(draw(worldWith([]), 0).debris.counts).toEqual({});
  });
});

/** Клетка в стольких-то клетках от заданной в сторону середины карты. */
const cellTowardsCentre = (from: number, cells: number): number => {
  const fromX = cellColumn(from);
  const fromY = cellRow(from);
  const toX = MAP_WIDTH_CELLS / 2;
  const toY = MAP_HEIGHT_CELLS / 2;
  const share = cells / Math.hypot(toX - fromX, toY - fromY);

  return cellIndex(
    Math.round(fromX + (toX - fromX) * share),
    Math.round(fromY + (toY - fromY) * share),
  );
};
