import type { Graphics } from 'pixi.js';
import {
  MISSILE_FLIGHT_SHARE,
  SHOT_LIFETIME_TICKS,
  SPLASH_OUTER_RADIUS,
  ShotWeapon,
  TICKS_PER_SECOND,
  unitsToCells,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellIndex } from '@td/sim';
import type { ShotState, StructureState, WorldState } from '@td/sim';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import type { ViewBounds } from './entities.js';
import { GENERAL_ALTITUDE, MIRROR_SQUASH, UNIT_ALTITUDE } from './models.js';
import { blend } from './prism.js';
import { hashOf, noiseFrom } from './noise.js';
import { fadeOver, glowFill, particleHeight, riseOver, smokeFill, travel } from './effects.js';
import { structureModelHeight, structureMuzzleHeight } from './towers.js';

/**
 * Облик выстрела: вспышка у ствола, след, попадание, ракета.
 *
 * Раньше выстрел был отрезком от стрелка к цели, и бой из-за этого читался
 * схемой связей «кто по кому», а не боем. Хуже другое: событие «попали»
 * не было отмечено на поле ничем. Урон нанесён, здоровье убыло, а глазу
 * об этом не сообщено, пока цель не погибнет, — и разница между «по мне
 * стреляют мимо» и «по мне попадают» оказывалась невидимой, хотя решение
 * отойти или доехать зависит именно от неё.
 *
 * Устройство модуля повторяет устройство разрушения (`blasts.ts`), и это
 * не подражание, а необходимость. Клиент предсказывает симуляцию вперёд
 * и откатывается при расхождении: один и тот же тик перерисовывается
 * по нескольку раз и не подряд. Поэтому здесь нет ни байта состояния
 * между кадрами — положение каждой искры, размер каждого клуба и место
 * ракеты выводятся прямо из возраста записи о выстреле выкладкой,
 * а форма разлёта — из хеша по координатам. Выстрел, нарисованный дважды
 * в один момент, совпадает точка в точку.
 *
 * Отсюда же следует срок жизни всего показанного: он не может быть
 * длиннее срока жизни записи в мире. Дым у дульного среза гаснет ровно
 * тогда, когда запись исчезает, — продлить его нечем, спрашивать уже
 * не у кого.
 *
 * Свет здесь складывается, а не закрашивает: две вспышки рядом ярче
 * одной. В PixiJS это режим смешивания, заданный слою целиком, поэтому
 * светящееся и несветящееся разложены по разным слоям.
 */

export interface ShotLayers {
  /** Дым и корпус ракеты. Обычное смешивание: это тела. */
  readonly trails: Graphics;
  /** Свет: следы, вспышки, искры, факел. Сложение цвета. */
  readonly glow: Graphics;
}

export interface ShotColors {
  readonly self: number;
  readonly enemy: number;
  readonly hullDark: number;
  /** Цвет обычного следа. */
  readonly shot: number;
  /** Цвет добивающего следа. */
  readonly shotLethal: number;
  /** Белое ядро вспышки. Тот же, что у взрыва. */
  readonly core: number;
  /** Огонь. Тот же, что у взрыва: пламя выстрела и пламя гибели — одно. */
  readonly fire: number;
  readonly smoke: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Общие величины
// ─────────────────────────────────────────────────────────────────────────

/**
 * Высота «плеча» стрелка, в клетках.
 *
 * Выстрел идёт не от земли: пальба из-под ног выглядит подкатом,
 * а не стрельбой. Высота парения входит в неё слагаемым, а не числом,
 * иначе после первой же правки парения выстрел стал бы выходить
 * из-под днища.
 */
const SHOULDER_CELLS = 0.35 + UNIT_ALTITUDE;

/**
 * Высота, на которой ракета выходит из-под машины генерала.
 *
 * Чуть ниже самой машины: подвеска висит под фюзеляжем, а не растёт
 * из его спины.
 */
const MISSILE_MOUNT_CELLS = GENERAL_ALTITUDE - 0.04;

/**
 * Куда приходит выстрел по высоте, в клетках.
 *
 * Не в землю и не в маковку: примерно в корпус машины. Точная высота
 * цели рендеру неизвестна — в следе выстрела лежит точка на плоскости,
 * а не тело, — да и не нужна: попадание в корпус читается попаданием
 * при любой цели, а попадание под гусеницы не читается ничем.
 */
const IMPACT_CELLS = 0.28;

/** Насколько виден свой выстрел и насколько — чужой. */
const ALPHA_SELF = 0.75;
const ALPHA_ENEMY = 0.5;

/**
 * До какой доли яркости догорает след к концу своей жизни.
 *
 * Не до нуля: исчезновение записи из мира и так обрывает показ,
 * а след, потухший заранее, просто не виден последние тики.
 */
const FADE_FLOOR = 0.4;

/**
 * Сколько выстрелов за кадр рисуется во всех подробностях.
 *
 * Ограничение не запас на будущее, а перенесённый вывод из измерения
 * на разрушении: `Graphics` в PixiJS тесселяет путь на процессоре при
 * каждой перерисовке, и цена эффекта — это число фигур в нём. Одна
 * заливка градиентом стоит около двадцатой доли миллисекунды.
 *
 * Выстрелов в бою в разы больше, чем взрывов: сотня машин в перестрелке
 * даёт десятки следов одновременно. Сверх предела выстрел рисуется
 * коротко — след и ядро вспышки, без дыма, ореолов и искр.
 *
 * Подробности достаются последним в списке, то есть самым свежим:
 * выстрел, случившийся только что, — событие, догорающий — фон.
 */
const DETAILED_SHOTS_PER_FRAME = 8;

/** Запас на отсечение по экрану, в пикселях. */
const CULL_MARGIN_PX = 240;

const screenAt = (x: number, y: number, height: number): Point => {
  const point = worldToScreen(x, y);
  return { x: point.x, y: point.y - height * ELEVATION_PX_PER_CELL };
};

/** Яркость следа по остатку его срока жизни. */
const shotFade = (shot: ShotState, tick: number): number => {
  const lifetime = SHOT_LIFETIME_TICKS[shot.weapon];
  if (lifetime <= 0) return 1;

  const left = Math.max(0, Math.min(1, (shot.expiresAtTick - tick) / lifetime));
  return FADE_FLOOR + (1 - FADE_FLOOR) * left;
};

/**
 * Постройка в точке выстрела, если она там есть.
 *
 * Опознаётся по точному совпадению точки с центром клетки: постройка
 * стреляет из центра всегда и стоит в центре всегда, а машина попадает
 * туда разве что случайно.
 *
 * Это единственное место, где отрисовка что-то ищет в мире по координатам
 * выстрела, и законно оно ровно потому, что ошибка здесь безобидна:
 * высота окажется прежней условной, а не выдуманной.
 */
const structureAt = (world: WorldState, x: number, y: number): StructureState | undefined => {
  const column = Math.floor(x);
  const row = Math.floor(y);

  if (x - column !== 0.5 || y - row !== 0.5) return undefined;

  const cell = cellIndex(column, row);
  return world.structures.find((structure) => structure.cell === cell);
};

/**
 * Высота дульного среза стрелка, в клетках.
 *
 * Раньше она была одна на всех — треть клетки, — и луч снайперской башни
 * из-за этого выходил у неё из-под днища. Величина эта не правил,
 * а модели, поэтому в состоянии мира её нет и быть не должно: сервер
 * не обязан знать про пиксели. Выводится она из вида оружия и из того,
 * стоит ли в клетке выстрела постройка.
 */
const muzzleHeight = (shot: ShotState, world: WorldState): number => {
  // Ракета принадлежит одному генералу — это условие записано в таблице
  // оружия, и здесь мы им пользуемся: спрашивать, кто стрелял, не у кого,
  // стрелка к моменту показа может уже не быть.
  if (shot.weapon === ShotWeapon.Missile) return MISSILE_MOUNT_CELLS;

  const shooter = structureAt(world, unitsToCells(shot.from.x), unitsToCells(shot.from.y));
  return shooter === undefined ? SHOULDER_CELLS : structureMuzzleHeight(shooter.kind);
};

/**
 * Высота, на которой вспыхивает попадание, в клетках.
 *
 * По машине — в корпус: точная высота цели рендеру неизвестна, в следе
 * лежит точка на плоскости, а не тело. По постройке — в середину её
 * модели, и вот это уже важно: снайперская башня выше полутора клеток,
 * и вспышка у её подножия читалась бы промахом под неё, а не попаданием
 * в неё.
 */
const impactHeight = (shot: ShotState, world: WorldState, colors: ShotColors): number => {
  const target = structureAt(world, unitsToCells(shot.to.x), unitsToCells(shot.to.y));
  if (target === undefined) return IMPACT_CELLS;

  return Math.max(IMPACT_CELLS, structureModelHeight(colors, target.kind) * modelShare(shot));
};

/** Доля высоты модели, в которую приходит попадание: примерно середина. */
const IMPACT_MODEL_SHARE = 0.55;

/**
 * Та же доля для разряда: почти вершина.
 *
 * Молния бьёт в самую высокую точку — объяснять это игроку не нужно, —
 * и ровно этим объясняется навесной огонь Теслы. Она бьёт по постройкам
 * поверх стен, а верх башни выше верха стены, поэтому прямая от ствола
 * к вершине проходит над стеной сама собой.
 *
 * Разница не косметическая. Верх стены — 0,45 клетки по столбам, плечо
 * стрелка — примерно 0,4. При стрельбе с шести клеток прежняя середина
 * модели давала над стеной три сотых клетки — то есть формально линия
 * проходила выше, а глазом читалась касанием. Вершина даёт около трети
 * клетки, и выстрел сквозь стену не отрисовывается.
 *
 * Навесной дуги при этом не заводится: след остаётся прямой ломаной,
 * меняется только высота точки, в которую он приходит.
 */
const IMPACT_ARC_MODEL_SHARE = 0.92;

const modelShare = (shot: ShotState): number =>
  shot.weapon === ShotWeapon.Arc ? IMPACT_ARC_MODEL_SHARE : IMPACT_MODEL_SHARE;

// ─────────────────────────────────────────────────────────────────────────
// Точка входа
// ─────────────────────────────────────────────────────────────────────────

/** Отрезок искры. Копятся за кадр и обводятся все разом. */
type Streak = readonly [Point, Point];

export const drawShots = (
  layers: ShotLayers,
  world: WorldState,
  time: number,
  view: ViewBounds,
  colors: ShotColors,
  localPlayer: PlayerId,
): void => {
  const onScreen = (point: Point): boolean =>
    point.x >= view.minX - CULL_MARGIN_PX &&
    point.x <= view.maxX + CULL_MARGIN_PX &&
    point.y >= view.minY - CULL_MARGIN_PX &&
    point.y <= view.maxY + CULL_MARGIN_PX;

  // Сколько выстрелов доживёт до геометрии, надо знать ДО того, как первый
  // из них нарисован: подробности достаются последним, а не первым.
  const visible: ShotState[] = [];
  for (const shot of world.shots) {
    const from = worldToScreen(unitsToCells(shot.from.x), unitsToCells(shot.from.y));
    const to = worldToScreen(unitsToCells(shot.to.x), unitsToCells(shot.to.y));
    if (onScreen(from) || onScreen(to)) visible.push(shot);
  }

  const leanCount = Math.max(0, visible.length - DETAILED_SHOTS_PER_FRAME);
  const sparks: Streak[] = [];

  visible.forEach((shot, index) => {
    drawShot(layers, world, shot, time, colors, localPlayer, index < leanCount, sparks);
  });

  drawSparks(layers.glow, sparks, colors);
};

/**
 * Искры всех выстрелов кадра — двумя обводками на весь кадр.
 *
 * Не по две на выстрел: искр в перестрелке сотни, и сотня обращений
 * к видеокарте вместо двух заметна ровно тогда, когда идёт самый бой.
 *
 * Ценой этого искры не гаснут плавно, а исчезают: общая обводка не умеет
 * разной прозрачности. Потеря честная — живут они полторы десятых доли
 * секунды, и разницы между «погасла» и «исчезла» на таком сроке не видно.
 *
 * Два прохода по одной и той же геометрии: широкий тёплый ореол и тонкое
 * белое ядро поверх. Линия в один пиксель не светится — она просто линия.
 */
const drawSparks = (glow: Graphics, sparks: readonly Streak[], colors: ShotColors): void => {
  if (sparks.length === 0) return;

  const trace = (): void => {
    for (const [tail, head] of sparks) {
      glow.moveTo(tail.x, tail.y).lineTo(head.x, head.y);
    }
  };

  trace();
  glow.stroke({ width: 4, color: colors.fire, alpha: 0.28 });

  trace();
  glow.stroke({ width: 1.4, color: colors.core, alpha: 0.85 });
};

const drawShot = (
  layers: ShotLayers,
  world: WorldState,
  shot: ShotState,
  time: number,
  colors: ShotColors,
  localPlayer: PlayerId,
  lean: boolean,
  sparks: Streak[],
): void => {
  const life = SHOT_LIFETIME_TICKS[shot.weapon];
  const span = life / TICKS_PER_SECOND;
  const seconds = Math.max(0, (time - (shot.expiresAtTick - life)) / TICKS_PER_SECOND);

  const fromX = unitsToCells(shot.from.x);
  const fromY = unitsToCells(shot.from.y);
  const toX = unitsToCells(shot.to.x);
  const toY = unitsToCells(shot.to.y);

  const landing = impactHeight(shot, world, colors);
  const muzzle = screenAt(fromX, fromY, muzzleHeight(shot, world));
  const impact = screenAt(toX, toY, landing);

  const color = shot.lethal ? colors.shotLethal : colors.shot;
  const accent = shot.owner === localPlayer ? colors.self : colors.enemy;
  const alpha = shot.owner === localPlayer ? ALPHA_SELF : ALPHA_ENEMY;
  const seed = hashOf([shot.from.x, shot.from.y, shot.to.x, shot.to.y, shot.expiresAtTick]);

  // Направление выстрела на экране. Выстрел в упор направления не имеет,
  // и вспышке тогда достаётся направление «вправо» — лишь бы не ноль
  // в знаменателе.
  const dx = impact.x - muzzle.x;
  const dy = impact.y - muzzle.y;
  const length = Math.hypot(dx, dy);
  const alongX = length === 0 ? 1 : dx / length;
  const alongY = length === 0 ? 0 : dy / length;

  // Вспышка у ствола достаётся всем без исключения, включая ракету:
  // невидимый выстрел — беда общая, и лечить её у трёх оружий
  // из четырёх бессмысленно. Дальше расходятся только следы.
  const launch = shot.weapon === ShotWeapon.Missile ? 1.5 : 1;
  drawMuzzleFlash(layers, muzzle, alongX, alongY, seconds, span, colors, launch, lean);

  if (shot.weapon === ShotWeapon.Missile) {
    drawMissile(
      layers,
      muzzle,
      impact,
      landing,
      seconds,
      span,
      seed,
      accent,
      colors,
      shot.lethal,
      lean,
      sparks,
    );
    return;
  }

  const trail = alpha * shotFade(shot, time);

  switch (shot.weapon) {
    case ShotWeapon.Beam:
      drawBeam(
        layers.glow,
        { head: muzzle, ground: worldToScreen(fromX, fromY) },
        { head: impact, ground: worldToScreen(toX, toY) },
        color,
        trail,
        shot.lethal,
        lean,
      );
      break;
    case ShotWeapon.Arc:
      drawArc(layers.glow, muzzle, impact, color, trail, shot.lethal, arcSeed(shot, time), lean);
      // Растекание идёт по земле под точкой попадания, а не от неё самой:
      // урон накрытия достаётся тем, кто стоит на земле вокруг, и облик
      // обязан показывать именно это. У выстрела по башне точка попадания
      // висит на её вершине, и разряд, растекающийся оттуда, читался бы
      // короной над крышей.
      drawSplash(layers.glow, worldToScreen(toX, toY), color, trail, arcSeed(shot, time), lean);
      break;
    default:
      drawBolt(layers.glow, muzzle, impact, color, trail, shot.lethal, lean);
  }

  drawImpact(layers.glow, impact, seconds, seed, colors, shot.lethal, lean, sparks, 1);
};

// ─────────────────────────────────────────────────────────────────────────
// Вспышка у ствола
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сколько живёт вспышка у дульного среза.
 *
 * Десятая доля секунды — это три-четыре кадра. Меньше — и вспышку
 * пропустит глаз, больше — и выстрел перестанет быть рывком: ствол
 * начнёт светиться, а светящийся ствол означает не выстрел, а работу.
 */
const MUZZLE_SECONDS = 0.1;

/** Во сколько раз вспышка длиннее, чем шире. Свет идёт вдоль ствола. */
const MUZZLE_REACH_PX = 17;
const MUZZLE_SPREAD_PX = 7;

const drawMuzzleFlash = (
  layers: ShotLayers,
  at: Point,
  alongX: number,
  alongY: number,
  seconds: number,
  span: number,
  colors: ShotColors,
  scale: number,
  lean: boolean,
): void => {
  drawMuzzleSmoke(layers.trails, at, alongX, alongY, seconds, span, colors, scale, lean);

  const alive = fadeOver(seconds, 0, MUZZLE_SECONDS) ** 1.4;
  if (alive <= 0) return;

  const glow = layers.glow;
  const acrossX = -alongY;
  const acrossY = alongX;

  const reach = MUZZLE_REACH_PX * scale * (0.55 + 0.45 * alive);
  const spread = MUZZLE_SPREAD_PX * scale * alive;

  // Ореол вокруг среза. Первым делом отбрасывается при нехватке кадра:
  // он крупный, он градиентный, и в толпе выстрелов его всё равно
  // не отличить от соседнего.
  if (!lean) {
    glow.circle(at.x, at.y, reach * 0.85);
    glow.fill({ fill: glowFill(colors.fire), alpha: 0.5 * alive });
  }

  // Лепесток пламени вдоль ствола. Именно он отличает выстрел от лампочки:
  // свет, расходящийся кругом, читается взрывом на месте стрелка.
  glow
    .moveTo(at.x - alongX * spread * 0.4, at.y - alongY * spread * 0.4)
    .lineTo(at.x + acrossX * spread, at.y + acrossY * spread)
    .lineTo(at.x + alongX * reach, at.y + alongY * reach)
    .lineTo(at.x - acrossX * spread, at.y - acrossY * spread)
    .closePath();
  glow.fill({ color: colors.fire, alpha: 0.75 * alive });

  // Ядро: сплошная заливка, а не градиент. Она пакуется с соседними
  // и потому остаётся даже в кратком виде — без неё у вспышки нет центра.
  glow.circle(at.x, at.y, spread * 0.75);
  glow.fill({ color: colors.core, alpha: 0.9 * alive });

  if (lean) return;

  // Три коротких луча: два поперёк и один вдоль. Звезда на срезе —
  // то, чем выстрел отличается от свечения, и стоит она одной обводки.
  glow
    .moveTo(at.x - acrossX * spread * 2.1, at.y - acrossY * spread * 2.1)
    .lineTo(at.x + acrossX * spread * 2.1, at.y + acrossY * spread * 2.1)
    .moveTo(at.x, at.y)
    .lineTo(at.x + alongX * reach * 1.35, at.y + alongY * reach * 1.35);
  glow.stroke({ width: 1.6, color: colors.core, alpha: 0.65 * alive });
};

/**
 * Дым у дульного среза.
 *
 * Гаснет ровно к концу срока записи о выстреле, а не по собственным
 * часам: продлить показ за пределы записи нечем — записи к тому моменту
 * в мире уже нет.
 */
const drawMuzzleSmoke = (
  trails: Graphics,
  at: Point,
  alongX: number,
  alongY: number,
  seconds: number,
  span: number,
  colors: ShotColors,
  scale: number,
  lean: boolean,
): void => {
  if (lean) return;

  const alpha = 0.3 * fadeOver(seconds, span * 0.15, span) * riseOver(seconds, 0, 0.03);
  if (alpha <= 0.01) return;

  // Клуб сносит вперёд по ходу выстрела и подымает: пороховой дым идёт
  // за снарядом, а не остаётся висеть на срезе.
  const drift = seconds * 26 * scale;
  const radius = (5 + seconds * 34) * scale;

  trails.circle(at.x + alongX * drift, at.y + alongY * drift - seconds * 12, radius);
  // Пороховой дым светлее копоти пожарища: он не подсвечен изнутри
  // огнём, и в цвете гари на тёмном поле его попросту не видно.
  trails.fill({ fill: smokeFill(blend(colors.smoke, colors.core, EXHAUST_TINT * 0.6)), alpha });
};

// ─────────────────────────────────────────────────────────────────────────
// Попадание
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сколько живёт вспышка попадания и сколько — искры от неё.
 *
 * Вспышка короче, чем у ствола: у ствола светит горящий порох, здесь —
 * удар. Искры живут дольше вспышки, иначе попадание читается щелчком
 * без последствий.
 */
const IMPACT_SECONDS = 0.09;
const IMPACT_SPARK_SECONDS = 0.16;

/** Сколько искр даёт попадание и как быстро они разлетаются. */
const IMPACT_SPARKS = 5;
const IMPACT_SPARK_SPEED = 3.4;

/** Длина хвоста искры по времени: отрезок читается движением, точка — нет. */
const SPARK_TRAIL_SECONDS = 0.05;

const drawImpact = (
  glow: Graphics,
  at: Point,
  seconds: number,
  seed: number,
  colors: ShotColors,
  lethal: boolean,
  lean: boolean,
  sparks: Streak[],
  scale: number,
): void => {
  // Размер и длительность разведены нарочно. Крупная вспышка обязана
  // остаться вспышкой: растяни ей срок вместе с размером — и вместо
  // удара получится медленно раздувающийся шар, то есть дым, а не свет.
  // Поэтому срок растёт втрое медленнее размера.
  const linger = 1 + (scale - 1) * 0.34;
  const alive = fadeOver(seconds, 0, IMPACT_SECONDS * linger);

  if (alive > 0) {
    const radius = (5 + 7 * (1 - alive)) * scale;

    if (!lean) {
      glow.circle(at.x, at.y, radius * 2.2);
      glow.fill({ fill: glowFill(lethal ? colors.shotLethal : colors.fire), alpha: 0.55 * alive });
    }

    glow.circle(at.x, at.y, radius * 0.7);
    glow.fill({ color: colors.core, alpha: 0.9 * alive });

    // Кольцо: сжатый воздух в точке удара. Расходится и гаснет по квадрату,
    // то есть глаз ловит его не как фигуру, а как рывок.
    if (!lean) {
      glow.circle(at.x, at.y, radius * (1.1 + 1.9 * (1 - alive)));
      glow.stroke({ width: 1 + 2 * alive, color: colors.core, alpha: 0.45 * alive ** 2 });
    }
  }

  if (lean || seconds > IMPACT_SPARK_SECONDS * linger) return;

  // Искры летят от точки удара НАЗАД, в сторону стрелка и вбок: так
  // ведёт себя отражённый удар. Разлёт выводится из хеша по выстрелу,
  // поэтому один и тот же выстрел даёт одни и те же искры при любом
  // числе перерисовок его тика.
  const noise = noiseFrom(seed);

  for (let index = 0; index < IMPACT_SPARKS; index += 1) {
    const angle = (noise() + 1) * Math.PI;
    const speed = IMPACT_SPARK_SPEED * scale * (0.4 + 0.6 * Math.abs(noise()));
    const lift = 0.8 + Math.abs(noise()) * 2.2;

    const now = travel(speed, seconds);
    const before = travel(speed, Math.max(0, seconds - SPARK_TRAIL_SECONDS));
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    const head = offsetBy(at, dirX * now, dirY * now, particleHeight(0, lift, seconds));
    const tail = offsetBy(
      at,
      dirX * before,
      dirY * before,
      particleHeight(0, lift, Math.max(0, seconds - SPARK_TRAIL_SECONDS)),
    );

    sparks.push([tail, head]);
  }
};

/**
 * Сдвиг экранной точки на мировое смещение и заданную высоту.
 *
 * Смещение переводится проекцией, а не пикселями: искра летит по земле,
 * и её путь обязан лежать в плоскости поля, иначе наклонный разлёт
 * превращается на экране в ровный круг.
 *
 * Проекция линейна и начало координат оставляет на месте, поэтому
 * смещение переводится ею напрямую, без вычитания начала.
 */
const offsetBy = (from: Point, cellsX: number, cellsY: number, height: number): Point => {
  const shift = worldToScreen(cellsX, cellsY);

  return {
    x: from.x + shift.x,
    y: from.y + shift.y - height * ELEVATION_PX_PER_CELL,
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Следы: трассер, луч, разряд
// ─────────────────────────────────────────────────────────────────────────

/**
 * Трассер: тонкий отрезок от дульного среза к цели.
 *
 * Служит меркой, относительно которой читаются остальные: луч заметно
 * толще трассера, разряд заметно изломаннее. Мерка — это толщина следа,
 * и она не менялась; вспышки у ствола и в цели получили все виды оружия
 * без исключения, потому что невидимое попадание — беда общая.
 */
const drawBolt = (
  glow: Graphics,
  from: Point,
  to: Point,
  color: number,
  alpha: number,
  lethal: boolean,
  lean: boolean,
): void => {
  const core = lethal ? 2 : 1;

  if (!lean) {
    glow.moveTo(from.x, from.y).lineTo(to.x, to.y);
    glow.stroke({ width: core * 3.5, color, alpha: alpha * 0.22 });
  }

  glow.moveTo(from.x, from.y).lineTo(to.x, to.y);
  glow.stroke({ width: core, color, alpha });
};

/** Во сколько раз ядро луча толще трассера. */
const BEAM_WIDTH_SCALE = 2.4;

/** Во сколько раз ореол шире ядра. Без ореола толстая линия читается палкой. */
const BEAM_HALO_SCALE = 3.5;

const BEAM_HALO_ALPHA = 0.3;

/** Насколько луч в отражении слабее самого луча. */
const BEAM_MIRROR_ALPHA = 0.35;

/**
 * Конец луча: сама точка и точка под ней на земле.
 *
 * Пара, а не одна точка, потому что отражению нужна высота, а поднятая
 * точка в этой проекции неотличима от точки, сдвинутой на север.
 * Восстанавливать высоту обратным ходом было бы гаданием — вместо этого
 * она приходит сюда в виде разницы между нарисованной точкой и той же
 * точкой на земле.
 */
interface BeamEnd {
  readonly head: Point;
  readonly ground: Point;
}

/**
 * Луч снайпера: ореол, ядро и отражение в поверхности.
 *
 * Отражается он по той же причине и по тем же правилам, что тела:
 * поле — слабое зеркало, и висящая над ним линия обязана в нём
 * отразиться, иначе зеркало кончается там, где начинается стрельба.
 */
const drawBeam = (
  glow: Graphics,
  from: BeamEnd,
  to: BeamEnd,
  color: number,
  alpha: number,
  lethal: boolean,
  lean: boolean,
): void => {
  const core = (lethal ? 2 : 1) * BEAM_WIDTH_SCALE;

  // Отражение первым: оно лежит глубже и не должно перебивать сам луч.
  // Высота над землёй у концов луча теперь разная — выстрел выходит
  // из ствола, а приходит в корпус, — поэтому каждый конец
  // опрокидывается по-своему, иначе отражение разъехалось бы с лучом.
  if (!lean) {
    const mirror = (end: BeamEnd): number =>
      end.ground.y + (end.ground.y - end.head.y) * MIRROR_SQUASH;

    glow.moveTo(from.head.x, mirror(from)).lineTo(to.head.x, mirror(to));
    glow.stroke({ width: core, color, alpha: alpha * BEAM_MIRROR_ALPHA });

    glow.moveTo(from.head.x, from.head.y).lineTo(to.head.x, to.head.y);
    glow.stroke({ width: core * BEAM_HALO_SCALE, color, alpha: alpha * BEAM_HALO_ALPHA });
  }

  glow.moveTo(from.head.x, from.head.y).lineTo(to.head.x, to.head.y);
  glow.stroke({ width: core, color, alpha: Math.min(1, alpha * 1.3) });
};

/** Сколько изломов в разряде. Меньше — ломаная, больше — верёвка. */
const ARC_STEPS = 7;

/** Сколько ветвей уходит в сторону от основного разряда. */
const ARC_BRANCHES = 2;

/** Какую долю длины выстрела составляет поперечный размах. */
const ARC_SPREAD_FRACTION = 0.12;

/** Предел размаха в пикселях: на дальнем выстреле доля даёт слишком много. */
const ARC_MAX_SPREAD_PX = 14;

const ARC_HALO_SCALE = 3;
const ARC_HALO_ALPHA = 0.2;

/**
 * Зерно для формы разряда.
 *
 * Считается из координат выстрела и номера тика, а не берётся случайным.
 * Кадров в тике несколько, и разряд со случайной формой перестраивался бы
 * шестьдесят раз в секунду — это читается шумом, а не молнией. С зерном
 * от тика он держит форму весь тик и вспыхивает заново на следующем,
 * то есть мигает тридцать раз в секунду, как настоящий разряд.
 */
const arcSeed = (shot: ShotState, tick: number): number =>
  hashOf([shot.from.x, shot.from.y, shot.to.x, shot.to.y, Math.floor(tick)]);

const tracePolyline = (graphics: Graphics, points: readonly Point[]): void => {
  const first = points[0];
  if (first === undefined) return;

  graphics.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point !== undefined) graphics.lineTo(point.x, point.y);
  }
};

/**
 * Разряд Теслы: ломаная с ветвями.
 *
 * Поперечное смещение гаснет к концам синусом: разряд обязан выйти
 * из ствола и прийти в цель. Излом — это облик, а не промах, и уводить
 * концы в сторону значило бы врать про то, куда пришёлся урон.
 */
const drawArc = (
  glow: Graphics,
  from: Point,
  to: Point,
  color: number,
  alpha: number,
  lethal: boolean,
  seed: number,
  lean: boolean,
): void => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);

  // Выстрел в упор ломать не во что.
  if (length === 0) return;

  const acrossX = -dy / length;
  const acrossY = dx / length;
  const spread = Math.min(ARC_MAX_SPREAD_PX, length * ARC_SPREAD_FRACTION);
  const noise = noiseFrom(seed);

  const nodes: Point[] = [from];
  for (let step = 1; step < ARC_STEPS; step += 1) {
    const along = step / ARC_STEPS;
    const swing = noise() * spread * Math.sin(Math.PI * along);

    nodes.push({
      x: from.x + dx * along + acrossX * swing,
      y: from.y + dy * along + acrossY * swing,
    });
  }
  nodes.push(to);

  // Ветви уходят от середины: у ствола и у цели они читались бы промахом.
  const branches: Point[][] = [];
  for (let count = 0; count < ARC_BRANCHES; count += 1) {
    const node = nodes[2 + Math.floor(Math.abs(noise()) * (ARC_STEPS - 3))];
    if (node === undefined) continue;

    branches.push([
      node,
      {
        x: node.x + (acrossX * noise() + (dx / length) * 0.4) * spread * 1.6,
        y: node.y + (acrossY * noise() + (dy / length) * 0.4) * spread * 1.6,
      },
    ]);
  }

  const core = lethal ? 2.4 : 1.6;

  if (!lean) {
    tracePolyline(glow, nodes);
    glow.stroke({ width: core * ARC_HALO_SCALE, color, alpha: alpha * ARC_HALO_ALPHA });
  }

  // Ядро и ветви одной обводкой: ветвь — часть того же разряда, и обводить
  // её отдельно значило бы платить лишним обращением к видеокарте.
  tracePolyline(glow, nodes);
  if (!lean) {
    for (const branch of branches) tracePolyline(glow, branch);
  }
  glow.stroke({ width: core, color, alpha: Math.min(1, alpha * 1.3) });
};

/** Сколько ветвей растекается от точки попадания по земле. */
const SPLASH_BRANCHES = 6;

/** Толщина ветви растекания. Тоньше самого разряда: это его затухание. */
const SPLASH_CORE_PX = 1.4;

/** Насколько ветвь изгибается вбок, в долях радиуса накрытия. */
const SPLASH_BEND_FRACTION = 0.22;

/**
 * Растекание разряда по накрытой площади.
 *
 * Ветви расходятся от точки попадания по земле и доходят примерно
 * до внешнего радиуса накрытия. «Примерно» — это разброс длин, а не
 * вольность: облик обязан показывать ту площадь, по которой нанесён урон.
 * Разряд, растекающийся дальше или ближе накрытия, обманывает игрока
 * в решении, отводить войско или нет.
 *
 * Радиус берётся из баланса и переводится в экран той же проекцией,
 * что и всё остальное, а не подобранным числом пикселей: поправят радиус
 * в правилах — растекание поедет за ним само, и второго источника правды
 * не заведётся.
 *
 * Формы между кадрами не копится: она выводится из зерна, а зерно —
 * из выстрела и номера тика, ровно как у самого разряда. Внутри тика
 * растекание неподвижно, на следующем перестраивается заново.
 */
const drawSplash = (
  glow: Graphics,
  ground: Point,
  color: number,
  alpha: number,
  seed: number,
  lean: boolean,
): void => {
  const reachCells = unitsToCells(SPLASH_OUTER_RADIUS);
  const noise = noiseFrom(seed);

  const away = (cellsX: number, cellsY: number): Point => {
    const shift = worldToScreen(cellsX, cellsY);
    return { x: ground.x + shift.x, y: ground.y + shift.y };
  };

  const branches: Point[][] = [];
  for (let index = 0; index < SPLASH_BRANCHES; index += 1) {
    // Ветви расставлены по кругу, а не разбросаны случайно: случайные
    // сходятся пучком, и накрытие читается кляксой, а не разрядом.
    const angle = ((index + 0.5) / SPLASH_BRANCHES) * Math.PI * 2 + noise() * 0.5;
    const reach = reachCells * (0.6 + Math.abs(noise()) * 0.4);
    const bend = noise() * reachCells * SPLASH_BEND_FRACTION;

    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    branches.push([
      ground,
      away(dirX * reach * 0.5 - dirY * bend, dirY * reach * 0.5 + dirX * bend),
      away(dirX * reach, dirY * reach),
    ]);
  }

  const trace = (): void => {
    for (const branch of branches) tracePolyline(glow, branch);
  };

  if (!lean) {
    trace();
    glow.stroke({ width: SPLASH_CORE_PX * ARC_HALO_SCALE, color, alpha: alpha * ARC_HALO_ALPHA });
  }

  trace();
  glow.stroke({ width: SPLASH_CORE_PX, color, alpha: Math.min(1, alpha * 1.1) });
};

// ─────────────────────────────────────────────────────────────────────────
// Ракета генерала
// ─────────────────────────────────────────────────────────────────────────

/**
 * Какую долю срока записи занимает полёт.
 *
 * Меньше половины — и это главное в устройстве ракеты. Показ кончается
 * вместе с записью о выстреле, поэтому дым обязан уложиться ВНУТРЬ срока,
 * а не после него: остаток срока и есть то время, за которое клубы
 * расходятся и тают.
 *
 * Само число переехало в `@td/shared`, когда у ракеты появился звук:
 * звуку нужно ровно то же деление срока, а две копии одной величины
 * разошлись бы первой же правкой.
 */

/**
 * Сколько клубов оставляет ракета по дороге.
 *
 * Число тут решает всё: клубов мало — и след читается пунктиром из бусин,
 * клубов много — и он становится сплошным столбом дыма. Тринадцать
 * на полсекунды полёта — это уже столб.
 *
 * Дорого: каждый клуб — заливка градиентом, а она стоит около двадцатой
 * доли миллисекунды. Полтора десятка на ракету — это почти миллисекунда
 * кадра, и позволить себе такое можно ровно потому, что ракета в матче
 * одна на генерала, а генералов двое. Сверх бюджета подробностей дым
 * отбрасывается целиком.
 */
const MISSILE_PUFFS = 13;

/**
 * Насколько дым ракеты светлее дыма пожарища.
 *
 * Дым разрушения почти чёрный, и это верно: он висит над горящей
 * машиной, подсвеченной изнутри огнём. Выхлоп двигателя — другое дело,
 * он белёсый; оставь ему цвет копоти — и на тёмном поле его не видно
 * вовсе, то есть у ракеты пропадает ровно то, ради чего она заведена.
 */
const EXHAUST_TINT = 0.42;

/**
 * Доля пути и высота ракеты на заданной доле полёта.
 *
 * Вынесено наружу ради проверяемости. Экранная `y` в этой проекции несёт
 * и высоту, и положение на плоскости, поэтому «ракета снизилась»
 * по нарисованной точке не проверить: движение к цели двигает её ровно
 * так же. Выкладка проверяется там, где она однозначна.
 *
 * Разгон, а не торможение: `along` растёт быстрее к концу. Ракета
 * с постоянной скоростью читается летящей палкой, а тормозящая перед
 * целью — заходящей на посадку.
 */
export const missileFlight = (
  progress: number,
  fromHeight: number,
  toHeight: number,
): { readonly along: number; readonly height: number } => {
  const t = Math.max(0, Math.min(1, progress));

  return {
    along: t * (0.55 + 0.45 * t),
    // Квадрат: ракета идёт высоко и падает к цели в конце, а не снижается
    // равномерно с самого старта.
    height: fromHeight + (toHeight - fromHeight) * t * t,
  };
};

const drawMissile = (
  layers: ShotLayers,
  muzzle: Point,
  impact: Point,
  landing: number,
  seconds: number,
  span: number,
  seed: number,
  accent: number,
  colors: ShotColors,
  lethal: boolean,
  lean: boolean,
  sparks: Streak[],
): void => {
  const flightSeconds = span * MISSILE_FLIGHT_SHARE;
  const progress = flightSeconds <= 0 ? 1 : seconds / flightSeconds;

  /**
   * Где ракета на заданной доле полёта.
   *
   * Точка `muzzle` уже поднята на высоту подвески, а `impact` — на высоту
   * корпуса цели, поэтому вдоль отрезка высота меняется сама собой,
   * линейно. Выкладка добавляет к этому только РАЗНИЦУ между своей
   * высотой и линейной: ракета идёт выше прямой и падает к цели в конце.
   */
  const at = (moment: number): Point => {
    const state = missileFlight(moment, MISSILE_MOUNT_CELLS, landing);
    const straight = MISSILE_MOUNT_CELLS + (landing - MISSILE_MOUNT_CELLS) * state.along;

    return {
      x: muzzle.x + (impact.x - muzzle.x) * state.along,
      y:
        muzzle.y +
        (impact.y - muzzle.y) * state.along -
        (state.height - straight) * ELEVATION_PX_PER_CELL,
    };
  };

  drawMissileSmoke(layers.trails, at, seconds, span, flightSeconds, seed, colors, lean);

  // Дым живёт дольше ракеты: она уже попала, а клубы ещё расходятся.
  if (progress < 1) {
    drawMissileBody(
      layers,
      at(progress),
      at(Math.max(0, progress - 0.09)),
      seconds,
      accent,
      colors,
      lean,
    );
  } else {
    // Втрое против трассера: ракета и попадать обязана заметнее.
    // Признак добивания при этом настоящий, а не выдуманный: красной
    // вспышка становится тогда же, когда краснеет любой другой след.
    drawImpact(
      layers.glow,
      impact,
      seconds - flightSeconds,
      seed,
      colors,
      lethal,
      lean,
      sparks,
      2.4,
    );
  }
};

/**
 * Длина факела и размах его пульсации, в пикселях.
 *
 * Главное здесь не длина, а НАПРАВЛЕНИЕ. Первая версия давала круглое
 * пятно вчетверо меньше нынешнего факела — и всё равно съедала ракету:
 * свет, растущий во все стороны, накрывает собой тело, и вместо ракеты
 * остаётся летящая искра. Направленный факел той же яркости тело
 * не трогает вовсе, потому что растёт назад, вдоль оси, — прочь
 * от корпуса. Ровно поэтому яркость удалось поднять втрое, ничего
 * не потеряв.
 *
 * Величина ограничена сверху размером техники. При длине 26 вся ракета
 * с корпусом выходила за пятьдесят пикселей, то есть длиннее целой
 * машины, — и снаряд начинал читаться объектом поля, а не выстрелом
 * по нему. Юнит на экране занимает около сорока пикселей, и снаряд
 * обязан быть заметно мельче: сейчас вся ракета укладывается в двадцать
 * шесть, то есть примерно в две трети длины танка.
 *
 * Длина факела при этом ХОДИТ ВОКРУГ длины корпуса, а не держится над
 * ней: корпус даёт 10,5, факел — от 9,2 до 13,8. Пересечение намеренное,
 * оно и есть пульсация: факел то вытягивается за корпус, то поджимается
 * к нему.
 *
 * Здесь стояло требование «факел ВСЕГДА длиннее корпуса», и оно снято
 * как неверное с самого начала. Проверка на краях пульсации, которую
 * стоило сделать сразу: при первых числах факел 26 ± 5 против корпуса
 * 22,75 давал в нижней точке 21 — уже короче. То же и после каждого
 * уменьшения: 13,5 против 15,75, потом 9,2 против 10,5. Средняя длина
 * держалась выше корпуса всегда, нижняя точка — никогда, а записана
 * была средняя, как будто она и есть весь диапазон.
 *
 * Держалось требование не на доводе: съедает корпус не длина факела,
 * а его ненаправленность. Требование, живущее в комментарии вопреки
 * числам, вреднее отсутствия требования — следующий читатель поверит
 * ему, а не коду, и подгонит числа под то, чего никогда не было.
 */
const PLUME_LENGTH_PX = 11.5;
const PLUME_PULSE_PX = 2.3;

/** Частота пульсации факела, в радианах на секунду. */
const PLUME_PULSE_RATE = 44;

/**
 * Корпус ракеты и факел двигателя.
 *
 * Корпус — вытянутый ромб, повёрнутый по ходу. Ромб, а не прямоугольник:
 * на теле в полтора десятка пикселей скошенный нос — единственное, что
 * отличает ракету от чёрточки.
 *
 * Сзади у неё раскалённое сопло и факел: конус пламени с белым ядром
 * и мягким ореолом, пульсирующий по длине. Пульсация считается от возраста
 * выстрела, а не от часов кадра, — иначе один и тот же тик, перерисованный
 * дважды, дал бы факелы разной длины.
 */
const drawMissileBody = (
  layers: ShotLayers,
  nose: Point,
  behind: Point,
  seconds: number,
  accent: number,
  colors: ShotColors,
  lean: boolean,
): void => {
  const dx = nose.x - behind.x;
  const dy = nose.y - behind.y;
  const length = Math.hypot(dx, dy) || 1;
  const alongX = dx / length;
  const alongY = dy / length;
  const acrossX = -alongY;
  const acrossY = alongX;

  // Корпус мерится техникой, а не сам собой: юнит на экране занимает
  // около сорока пикселей, и снаряд, сравнимый с ним, читается вторым
  // объектом на поле, а не выстрелом. Шесть на 1,75 дают 10,5 — четверть
  // длины машины.
  //
  // Ниже опускаться уже некуда, и мешает этому не вкус, а отношение
  // длины к ширине: при половине в 1,6 тело выходит 10,5 на 3,2, то есть
  // ромб втрое длиннее своей ширины. Сожми ещё — и скошенный нос,
  // единственное, что отличает ракету от чёрточки, перестанет
  // помещаться в пиксели.
  const body = 6;
  const half = 1.6;

  const waist = { x: nose.x - alongX * body, y: nose.y - alongY * body };
  const tail = { x: nose.x - alongX * body * 1.75, y: nose.y - alongY * body * 1.75 };

  layers.trails
    .moveTo(nose.x, nose.y)
    .lineTo(waist.x + acrossX * half, waist.y + acrossY * half)
    .lineTo(tail.x, tail.y)
    .lineTo(waist.x - acrossX * half, waist.y - acrossY * half)
    .closePath();
  layers.trails.fill({ color: blend(colors.hullDark, accent, 0.32) });
  // Обводка тоньше общей: тело всего 3,2 пикселя поперёк, и линия
  // в пиксель съела бы треть заливки, а в полтора — превратила бы ромб
  // в пустой контур. Совсем убирать её нельзя: цвет стороны на ракете
  // несёт только она, а по нему игрок и понимает, чей это выстрел.
  layers.trails.stroke({ width: 0.8, color: accent, alpha: 0.95 });

  const glow = layers.glow;
  const plume = PLUME_LENGTH_PX + PLUME_PULSE_PX * Math.sin(seconds * PLUME_PULSE_RATE);
  const nozzle = { x: tail.x + alongX * 2, y: tail.y + alongY * 2 };

  // Ореол вокруг сопла: то, что делает свет светом. Без него у факела
  // остаётся чёткий край, и он читается нарисованным треугольником.
  if (!lean) {
    glow.circle(nozzle.x, nozzle.y, 5);
    glow.fill({ fill: glowFill(colors.fire), alpha: 0.75 });
  }

  // Конус пламени. Сужается к концу: струя расходится и гаснет, а не
  // обрывается поперёк.
  const mouth = 2.1;
  const tip = { x: nozzle.x - alongX * plume, y: nozzle.y - alongY * plume };

  glow
    .moveTo(nozzle.x + acrossX * mouth, nozzle.y + acrossY * mouth)
    .lineTo(tip.x + acrossX * mouth * 0.25, tip.y + acrossY * mouth * 0.25)
    .lineTo(tip.x - acrossX * mouth * 0.25, tip.y - acrossY * mouth * 0.25)
    .lineTo(nozzle.x - acrossX * mouth, nozzle.y - acrossY * mouth)
    .closePath();
  glow.fill({ color: colors.fire, alpha: 0.8 });

  // Белое нутро струи: у горячего пламени сердцевина светлее краёв,
  // и именно эта разница читается жаром, а не просто оранжевым.
  const core = { x: nozzle.x - alongX * plume * 0.45, y: nozzle.y - alongY * plume * 0.45 };

  glow
    .moveTo(nozzle.x + acrossX * mouth * 0.5, nozzle.y + acrossY * mouth * 0.5)
    .lineTo(core.x, core.y)
    .lineTo(nozzle.x - acrossX * mouth * 0.5, nozzle.y - acrossY * mouth * 0.5)
    .closePath();
  glow.fill({ color: colors.core, alpha: 0.9 });

  // Само сопло раскалено добела. Сплошная заливка, а не градиент:
  // она пакуется с соседними и остаётся даже в кратком виде.
  glow.circle(nozzle.x, nozzle.y, 1.5);
  glow.fill({ color: colors.core, alpha: 0.95 });
};

/**
 * Клубы дыма за ракетой.
 *
 * Клуб рождается не по времени кадра, а по доле пути: клуб номер `i`
 * возникает там, где ракета была в момент `i/N` своего полёта, и его
 * возраст — это время, прошедшее с той доли. Выкладка чистая, поэтому
 * один и тот же тик даёт один и тот же дым при любом числе перерисовок.
 *
 * И именно поэтому дым продолжает расходиться после попадания: возраст
 * клуба считается от его рождения, а не от того, летит ли ещё ракета.
 */
const drawMissileSmoke = (
  trails: Graphics,
  at: (moment: number) => Point,
  seconds: number,
  span: number,
  flightSeconds: number,
  seed: number,
  colors: ShotColors,
  lean: boolean,
): void => {
  if (lean) return;

  const exhaust = blend(colors.smoke, colors.core, EXHAUST_TINT);
  const hot = blend(exhaust, colors.fire, 0.5);
  const noise = noiseFrom(seed ^ 0x9e3779b9);

  // Общее угасание по возрасту ВЫСТРЕЛА, а не клуба. Без него последние
  // клубы к концу срока держат добрую четверть плотности и исчезают
  // разом вместе с записью — на экране это читается сбоем отрисовки,
  // а не рассеявшимся дымом.
  const leaving = fadeOver(seconds, span * 0.62, span);
  if (leaving <= 0) return;

  for (let index = 0; index < MISSILE_PUFFS; index += 1) {
    const share = index / MISSILE_PUFFS;
    const bornAt = share * flightSeconds;
    const age = seconds - bornAt;

    // Разброс берётся из хеша по выстрелу и потому одинаков при любом
    // числе перерисовок тика. Без него клубы ложатся ровной ниткой бусин:
    // одинаковые круги на одинаковом расстоянии — это что угодно,
    // только не дым.
    const drift = noise();
    const swell = 0.7 + Math.abs(noise()) * 0.9;
    const rise = 7 + Math.abs(noise()) * 12;

    if (age <= 0) continue;

    const alpha = 0.5 * leaving * fadeOver(age, span * 0.25, span) * riseOver(age, 0, 0.03);
    if (alpha <= 0.01) continue;

    const point = at(share);
    const radius = (5 + age * 46) * swell;

    // Свежий клуб ещё раскалён: первые полторы десятых доли секунды
    // он ближе к цвету пламени, дальше — обычный белёсый выхлоп.
    // Доля жара округляется до четвертей, иначе заготовка градиента
    // строилась бы заново на каждый кадр.
    const heat = Math.round(fadeOver(age, 0.02, 0.16) * 4) / 4;

    trails.circle(
      point.x + drift * age * 26,
      point.y - age * rise + drift * age * 8,
      radius,
    );
    trails.fill({ fill: smokeFill(heat <= 0 ? exhaust : blend(exhaust, hot, heat)), alpha });
  }
};
