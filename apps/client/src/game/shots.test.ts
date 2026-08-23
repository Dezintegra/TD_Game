import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import {
  DIRECTION_SOUTH,
  PPM_ONE,
  SHOT_LIFETIME_TICKS,
  ShotSide,
  ShotWeapon,
  StructureKind,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import { cellCentre, cellIndex, cellX, cellY, createWorld } from '@td/sim';
import type { ShotState, StructureState, WorldState } from '@td/sim';
import { drawShots, missileFlight } from './shots.js';
import type { ShotColors, ShotLayers } from './shots.js';
import type { ViewBounds } from './entities.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import { structureModelHeight } from './towers.js';

/**
 * Облик выстрела проверяется не картинкой, а тем, что уходит в слои.
 *
 * Слоя два, и разделение между ними — само по себе требование: свет
 * складывается с тем, что под ним, а дым закрашивает, и в PixiJS режим
 * смешивания задаётся слою целиком. Поэтому «вспышка попала в слой
 * света» — это проверяемое утверждение, а не подробность отрисовки.
 */

const SEED = 4242;

interface Recorder {
  readonly graphics: Graphics;
  readonly counts: Record<string, number>;
  /** Точки, через которые прошёл путь. */
  readonly points: Point[];
  /** Центры кругов: вспышки, ядра, клубы дыма. */
  readonly circles: Point[];
  readonly widths: number[];
}

const recorder = (): Recorder => {
  const counts: Record<string, number> = {};
  const points: Point[] = [];
  const circles: Point[] = [];
  const widths: number[] = [];
  const stub: Record<string, (...args: unknown[]) => unknown> = {};

  for (const name of ['moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'circle', 'clear']) {
    stub[name] = (...args: unknown[]) => {
      counts[name] = (counts[name] ?? 0) + 1;

      if ((name === 'moveTo' || name === 'lineTo') && args.length >= 2) {
        points.push({ x: args[0] as number, y: args[1] as number });
      }

      if (name === 'circle' && args.length >= 2) {
        circles.push({ x: args[0] as number, y: args[1] as number });
      }

      if (name === 'stroke') {
        const width = (args[0] as { width?: number } | undefined)?.width;
        if (width !== undefined) widths.push(width);
      }

      return stub;
    };
  }

  return { graphics: stub as unknown as Graphics, counts, points, circles, widths };
};

const WHOLE_MAP: ViewBounds = { minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6 };

const COLORS: ShotColors = {
  self: 0x00ff29,
  enemy: 0xd264ff,
  hullDark: 0x23271f,
  shot: 0xeaffef,
  shotLethal: 0xff5c5c,
  core: 0xfff6e0,
  fire: 0xff8a2b,
  smoke: 0x2b2622,
};

const FROM = cellIndex(10, 10);
const TO = cellIndex(14, 10);

const START = worldToScreen(cellX(FROM) + 0.5, cellY(FROM) + 0.5);
const FINISH = worldToScreen(cellX(TO) + 0.5, cellY(TO) + 0.5);

const shotOf = (
  weapon: ShotWeapon,
  from = FROM,
  to = TO,
  side: ShotSide = ShotSide.Centre,
): ShotState => ({
  owner: asPlayerId(0),
  from: cellCentre(from),
  to: cellCentre(to),
  expiresAtTick: asTickNumber(SHOT_LIFETIME_TICKS[weapon]),
  lethal: false,
  weapon,
  side,
});

/** Мир без построек, кроме заказанных: базы отрисовке выстрелов не мешают. */
const bare = (structures: readonly StructureState[] = []): WorldState => {
  const world = createWorld(SEED);
  return { ...world, structures, units: [], shots: [] };
};

const towerAt = (cell: number, kind: StructureKind): StructureState => ({
  id: asEntityId(500),
  owner: asPlayerId(0),
  kind,
  cell,
  health: 100,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
  facing: DIRECTION_SOUTH,
});

interface DrawResult {
  readonly trails: Recorder;
  readonly glow: Recorder;
}

const draw = (
  shots: readonly ShotState[],
  time = 0,
  structures: readonly StructureState[] = [],
): DrawResult => {
  const trails = recorder();
  const glow = recorder();
  const layers: ShotLayers = { trails: trails.graphics, glow: glow.graphics };

  drawShots(layers, { ...bare(structures), shots }, time, WHOLE_MAP, COLORS, asPlayerId(0));

  return { trails, glow };
};

/** Есть ли в наборе точка ближе указанного расстояния к цели. */
const near = (points: readonly Point[], target: Point, radius = 26): boolean =>
  points.some((point) => Math.hypot(point.x - target.x, point.y - target.y) <= radius);

const opsOf = (recorded: Recorder): number =>
  Object.values(recorded.counts).reduce((total, count) => total + count, 0);

describe('след выстрела', () => {
  it('трассер держится над землёй и не отражается', () => {
    // Сравнивать надо каждый конец со своей точкой земли: экранная `y`
    // растёт и от высоты, и от положения на плоскости, поэтому дальний
    // конец трассера лежит ниже ближнего, оставаясь над землёй.
    const points = draw([shotOf(ShotWeapon.Bolt)]).glow.points;
    const [start, finish] = points;

    expect(start?.y).toBeLessThan(START.y);
    expect(finish?.y).toBeLessThan(FINISH.y);
    expect(points.every((point) => point.y <= Math.max(START.y, FINISH.y))).toBe(true);
  });

  it('луч толще трассера', () => {
    const bolt = Math.max(...draw([shotOf(ShotWeapon.Bolt)]).glow.widths);
    const beam = Math.max(...draw([shotOf(ShotWeapon.Beam)]).glow.widths);

    // Не на волосок: разницу должно быть видно, не приглядываясь.
    expect(beam).toBeGreaterThan(bolt * 2);
  });

  it('луч отражается в поверхности', () => {
    // Отражение — то, что ушло под землю. Ищем его на вертикали стрелка.
    const atShooter = draw([shotOf(ShotWeapon.Beam)]).glow.points.filter(
      (point) => Math.abs(point.x - START.x) < 0.001,
    );

    expect(atShooter.length).toBeGreaterThan(1);
    expect(atShooter.some((point) => point.y > START.y)).toBe(true);
  });

  it('разряд выходит из ствола и приходит в цель', () => {
    // Излом — это облик, а не промах: концы обязаны стоять там же,
    // где стояли бы концы трассера.
    const arc = draw([shotOf(ShotWeapon.Arc)]).glow.points;
    const bolt = draw([shotOf(ShotWeapon.Bolt)]).glow.points;

    expect(arc[0]).toEqual(bolt[0]);
    expect(arc.some((point) => Math.abs(point.x - FINISH.x) < 0.001)).toBe(true);
  });

  it('разряд изломан, а не прям', () => {
    const points = draw([shotOf(ShotWeapon.Arc)]).glow.points;
    const first = points[0];
    if (first === undefined) throw new Error('разряд не нарисован');

    const alongX = FINISH.x - START.x;
    const alongY = FINISH.y - START.y;
    const offLine = points.some(
      (point) => Math.abs((point.x - first.x) * alongY - (point.y - first.y) * alongX) > 1,
    );

    expect(offLine).toBe(true);
  });

  it('разряд растекается за цель по накрытой площади', () => {
    // Насколько далеко за цель, вдоль направления выстрела, уходит
    // хоть одна нарисованная точка. У луча — никуда: он кончается в цели.
    // У разряда — на клетку с лишним: там лежит накрытие, и облик обязан
    // показывать ту площадь, по которой нанесён урон.
    const dx = FINISH.x - START.x;
    const dy = FINISH.y - START.y;
    const length = Math.hypot(dx, dy);

    const beyond = (weapon: ShotWeapon): number =>
      Math.max(
        ...draw([shotOf(weapon)]).glow.points.map(
          (point) => ((point.x - FINISH.x) * dx + (point.y - FINISH.y) * dy) / length,
        ),
      );

    const step = worldToScreen(1, 0);
    const cellPx = Math.hypot(step.x, step.y);

    expect(beyond(ShotWeapon.Arc)).toBeGreaterThan(beyond(ShotWeapon.Beam) + cellPx * 0.5);
  });

  it('разряд держит форму весь тик и вспыхивает заново на следующем', () => {
    // Кадров в тике несколько, и разряд со случайной формой перестраивался
    // бы шестьдесят раз в секунду — это читается шумом, а не молнией.
    const now = draw([shotOf(ShotWeapon.Arc)], 0.4).glow.points;

    expect(draw([shotOf(ShotWeapon.Arc)], 0.4).glow.points).toEqual(now);
    expect(draw([shotOf(ShotWeapon.Arc)], 1.4).glow.points).not.toEqual(now);
  });
});

describe('вспышки', () => {
  it('свежий выстрел даёт свет у стрелка', () => {
    expect(near(draw([shotOf(ShotWeapon.Bolt)]).glow.circles, START, 30)).toBe(true);
  });

  it('свежий выстрел даёт свет в цели', () => {
    // Урон на поле до этого был невидим до самой гибели цели, из-за чего
    // «по мне стреляют мимо» и «по мне попадают» не различались никак.
    expect(near(draw([shotOf(ShotWeapon.Bolt)]).glow.circles, FINISH, 30)).toBe(true);
  });

  it('вспышка гаснет раньше следа', () => {
    // Выстрел — это рывок, а не свечение: светящийся ствол означает
    // не выстрел, а работу.
    const late = draw([shotOf(ShotWeapon.Bolt)], 3.5);

    expect(late.glow.circles).toHaveLength(0);
    expect(late.glow.points.length).toBeGreaterThan(0);
  });

  it('свет и дым лежат в разных слоях', () => {
    // Режим смешивания задаётся слою целиком, поэтому разделение —
    // требование, а не подробность.
    //
    // Тик спустя, а не в момент выстрела: дым нарастает, а не появляется
    // клубом — мгновенно возникшее облако читается сбоем.
    const result = draw([shotOf(ShotWeapon.Bolt)], 1);

    expect(opsOf(result.glow)).toBeGreaterThan(0);
    expect(result.trails.circles.length).toBeGreaterThan(0);
    expect(result.trails.counts['stroke'] ?? 0).toBe(0);
  });

  it('искры разлетаются от точки попадания', () => {
    const glow = draw([shotOf(ShotWeapon.Bolt)], 0.9).glow;
    const away = glow.points.filter(
      (point) => Math.hypot(point.x - FINISH.x, point.y - FINISH.y) > 2,
    );

    expect(away.length).toBeGreaterThan(2);
  });
});

describe('без состояния между кадрами', () => {
  it('повторная отрисовка одного момента совпадает точка в точку', () => {
    // Клиент предсказывает и откатывается: один и тот же тик
    // перерисовывается по нескольку раз и не подряд. Накопленный список
    // частиц к третьему показу разошёлся бы с миром.
    const shots = [shotOf(ShotWeapon.Bolt), shotOf(ShotWeapon.Missile)];

    const first = draw(shots, 1.7);
    const second = draw(shots, 1.7);

    expect(second.glow.points).toEqual(first.glow.points);
    expect(second.glow.circles).toEqual(first.glow.circles);
    expect(second.trails.circles).toEqual(first.trails.circles);
  });

  it('нет выстрела в мире — нет и ничего на экране', () => {
    const empty = draw([]);

    expect(opsOf(empty.glow)).toBe(0);
    expect(opsOf(empty.trails)).toBe(0);
  });
});

describe('высота дульного среза', () => {
  it('луч снайперской башни выходит из её ствола', () => {
    const tower = towerAt(FROM, StructureKind.TowerSniper);
    const start = draw([shotOf(ShotWeapon.Beam)], 0, [tower]).glow.points[0];

    if (start === undefined) throw new Error('луч не нарисован');

    // Половина высоты модели — заведомо выше «плеча» машины и заведомо
    // ниже верхушки: попасть в этот промежуток можно только из ствола.
    const half = structureModelHeight(COLORS, StructureKind.TowerSniper) / 2;

    expect(START.y - start.y).toBeGreaterThan(half * ELEVATION_PX_PER_CELL);
  });

  it('выстрел юнита выходит с прежней высоты плеча', () => {
    const withTower = draw([shotOf(ShotWeapon.Bolt)], 0, [towerAt(FROM, StructureKind.TowerBasic)])
      .glow.points[0];
    const plain = draw([shotOf(ShotWeapon.Bolt)]).glow.points[0];

    if (withTower === undefined || plain === undefined) throw new Error('трассер не нарисован');

    // Плечо ниже дульного среза башни: та же точка на земле, но выше
    // по экрану у башни.
    expect(plain.y).toBeGreaterThan(withTower.y);
  });

  it('выстрел не с пилона стартует ровно над стрелком', () => {
    // Борт есть только у ракеты генерала. У всех прочих он «по оси»,
    // и вбок их выстрел уезжать не должен ни на пиксель.
    //
    // Смотрим на круг, а не на путь: первый круг в слое света — это
    // ореол вспышки, и он лежит ровно в точке выстрела. Лепесток пламени
    // рядом сдвинут назад вдоль ствола, и на него опираться нельзя.
    const start = draw([shotOf(ShotWeapon.Bolt)]).glow.circles[0];

    if (start === undefined) throw new Error('трассер не нарисован');

    expect(start.x).toBeCloseTo(START.x, 6);
  });

  it('попадание по башне вспыхивает на башне, а не у её подножия', () => {
    // Снайперская башня выше полутора клеток, и вспышка внизу читалась бы
    // промахом под неё, а не попаданием в неё.
    const target = towerAt(TO, StructureKind.TowerSniper);

    const onTower = draw([shotOf(ShotWeapon.Bolt)], 0, [target]).glow.circles;
    const onGround = draw([shotOf(ShotWeapon.Bolt)]).glow.circles;

    const highest = (circles: readonly Point[]): number =>
      Math.min(...circles.filter((point) => Math.abs(point.x - FINISH.x) < 40).map((p) => p.y));

    expect(highest(onTower)).toBeLessThan(highest(onGround));
  });

  it('разряд приходит в вершину башни, а прочее оружие — в середину', () => {
    // Молния бьёт в самую высокую точку, и этим же объясняется навесной
    // огонь Теслы: верх башни выше верха стены, поэтому прямая от ствола
    // к вершине проходит над стеной сама собой, и выстрел сквозь
    // непроходимую постройку не отрисовывается.
    const target = towerAt(TO, StructureKind.TowerBasic);

    const highest = (weapon: ShotWeapon): number =>
      Math.min(
        ...draw([shotOf(weapon)], 0, [target])
          .glow.circles.filter((point) => Math.abs(point.x - FINISH.x) < 40)
          .map((point) => point.y),
      );

    expect(highest(ShotWeapon.Arc)).toBeLessThan(highest(ShotWeapon.Bolt));
  });

  it('снесённая башня не ломает показ своего следа', () => {
    // След живёт дольше стрелка. Постройки в клетке уже нет — выстрел
    // выходит из «плеча», то есть чуть ниже, чем следовало, а не пропадает.
    const orphan = draw([shotOf(ShotWeapon.Beam)]).glow.points[0];

    expect(orphan).toBeDefined();
    expect(orphan?.y).toBeLessThan(START.y);
  });
});

describe('ракета генерала', () => {
  // Борт настоящий, а не «по оси»: по оси генерал не стреляет никогда,
  // и проверять его полёт на положении, которого в игре не бывает,
  // значило бы проверять не то, что летает.
  const MISSILE = shotOf(ShotWeapon.Missile, FROM, TO, ShotSide.Left);
  const SPAN = SHOT_LIFETIME_TICKS[ShotWeapon.Missile];

  it('снижается по ходу полёта', () => {
    // Экранная `y` несёт и высоту, и положение на плоскости, поэтому
    // «ракета снизилась» проверяется на выкладке, а не на пикселях.
    const start = missileFlight(0, 0.5, 0.28);
    const finish = missileFlight(1, 0.5, 0.28);

    expect(start.height).toBeCloseTo(0.5, 6);
    expect(finish.height).toBeCloseTo(0.28, 6);
    expect(finish.height).toBeLessThan(start.height);
  });

  it('проходит весь путь и разгоняется к концу', () => {
    expect(missileFlight(0, 1, 0).along).toBeCloseTo(0, 6);
    expect(missileFlight(1, 1, 0).along).toBeCloseTo(1, 6);

    // Разгон: вторая половина пути проходится быстрее первой. Ракета
    // с постоянной скоростью читается летящей палкой.
    const first = missileFlight(0.5, 1, 0).along;
    expect(first).toBeLessThan(0.5);
  });

  it('тело ракеты уже в цели раньше конца срока следа', () => {
    // Полёт занимает меньше половины срока: остаток нужен дыму.
    const flying = draw([MISSILE], SPAN * 0.2);
    const arrived = draw([MISSILE], SPAN * 0.8);

    expect(flying.trails.points.length).toBeGreaterThan(0);
    expect(arrived.trails.points).toHaveLength(0);
  });

  it('дым остаётся после попадания', () => {
    const arrived = draw([MISSILE], SPAN * 0.8);

    expect(arrived.trails.circles.length).toBeGreaterThan(0);
  });

  it('попадание отмечено вспышкой', () => {
    const arrived = draw([MISSILE], SPAN * 0.5);

    expect(near(arrived.glow.circles, FINISH, 40)).toBe(true);
  });

  it('след читается столбом дыма, а не пунктиром из бусин', () => {
    const smoke = draw([MISSILE], SPAN * 0.45).trails.circles;

    expect(smoke.length).toBeGreaterThan(10);
  });

  it('дым исчезает не разом, а гаснет к концу срока', () => {
    // Клубы, державшие плотность до последнего тика, пропадают вместе
    // с записью в один кадр, и это читается сбоем отрисовки, а не
    // рассеявшимся дымом.
    const middle = draw([MISSILE], SPAN * 0.5).trails.circles.length;
    const ending = draw([MISSILE], SPAN * 0.95).trails.circles.length;

    expect(ending).toBeLessThan(middle);
    // К самому концу срока не остаётся ничего: продлевать показ нечем,
    // записи о выстреле в мире уже нет.
    expect(draw([MISSILE], SPAN).trails.circles).toHaveLength(0);
  });

  it('факел направлен назад, а не во все стороны', () => {
    // Ненаправленный факел той же яркости накрывает собой корпус,
    // и вместо ракеты остаётся летящая искра.
    //
    // Момент выбран так, чтобы вспышка у ствола уже погасла: иначе
    // «позади ракеты» окажутся и её фигуры, и довод развалится.
    const result = draw([MISSILE], 5);

    const dirX = FINISH.x - START.x;
    const dirY = FINISH.y - START.y;
    const along = (point: Point): number => point.x * dirX + point.y * dirY;

    const body = result.trails.points.map(along);
    const flame = result.glow.points.map(along);

    expect(body.length).toBeGreaterThan(0);
    expect(flame.length).toBeGreaterThan(0);
    expect(Math.min(...flame)).toBeLessThan(Math.min(...body));
  });

  it('борта расходятся симметрично относительно машины', () => {
    // Первый круг в слое света — ореол вспышки у ствола, то есть сама
    // точка пуска: в свежем выстреле он рисуется раньше всего прочего.
    const launchOf = (side: ShotSide): Point | undefined =>
      draw([shotOf(ShotWeapon.Missile, FROM, TO, side)]).glow.circles[0];

    const left = launchOf(ShotSide.Left);
    const right = launchOf(ShotSide.Right);
    const axis = launchOf(ShotSide.Centre);

    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(axis).toBeDefined();
    if (left === undefined || right === undefined || axis === undefined) return;

    // Расхождение бортов при вылете подвески 0,215 клетки и масштабе
    // клетки в 63 пикселя выходит от 21 до 23 пикселей — в зависимости
    // от того, куда машина стреляет: проекция сжимает оси по-разному.
    // Порог взят ниже наименьшего, потому что проверяется не число,
    // а то, что сдвиг не выродился в ноль.
    expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeGreaterThan(18);

    // Симметрия: середина между бортами — это и есть ось машины.
    expect((left.x + right.x) / 2).toBeCloseTo(axis.x, 6);
    expect((left.y + right.y) / 2).toBeCloseTo(axis.y, 6);
  });

  it('вспышка вспыхивает там же, откуда уходит ракета', () => {
    // Свет, оставшийся на оси, показывал бы пуск оттуда, откуда ракета
    // не выходила.
    const result = draw([shotOf(ShotWeapon.Missile, FROM, TO, ShotSide.Right)]);

    const flash = result.glow.circles[0];
    const nose = result.trails.points[0];

    expect(flash).toBeDefined();
    expect(nose).toBeDefined();
    expect(flash?.x).toBeCloseTo(nose?.x ?? 0, 6);
    expect(flash?.y).toBeCloseTo(nose?.y ?? 0, 6);
  });

  it('клубы дыма расходятся по дороге, а не висят в одной точке', () => {
    const smoke = draw([MISSILE], SPAN * 0.35).trails.circles;
    const spread =
      Math.max(...smoke.map((point) => point.x)) - Math.min(...smoke.map((point) => point.x));

    expect(smoke.length).toBeGreaterThan(1);
    expect(spread).toBeGreaterThan(10);
  });
});

describe('бюджет подробностей', () => {
  it('толпа выстрелов не выводит кадр за бюджет', () => {
    // Цена эффекта в PixiJS — это число фигур в нём. Сверх предела
    // выстрел рисуется коротко: след и ядро вспышки.
    const many = Array.from({ length: 50 }, (_, index) =>
      shotOf(ShotWeapon.Bolt, cellIndex(10 + (index % 5), 10 + Math.floor(index / 5)), TO),
    );
    const few = many.slice(0, 8);

    const heavy = opsOf(draw(many).glow) + opsOf(draw(many).trails);
    const light = opsOf(draw(few).glow) + opsOf(draw(few).trails);

    // Впятеро больше выстрелов — заметно меньше чем впятеро фигур.
    expect(heavy).toBeLessThan(light * 3);
  });

  it('подробности достаются самым свежим выстрелам', () => {
    // Выстрел, случившийся только что, — событие; догорающий — фон.
    const stale = Array.from({ length: 12 }, (_, index) =>
      shotOf(ShotWeapon.Bolt, cellIndex(10 + index, 12), TO),
    );
    const fresh = shotOf(ShotWeapon.Bolt);

    // Свежий стоит последним в списке — так его кладёт ядро.
    const result = draw([...stale, fresh]);

    // У свежего есть ореол попадания, то есть круг у точки цели.
    expect(near(result.glow.circles, FINISH, 30)).toBe(true);
  });
});
