import type { Graphics } from 'pixi.js';
import {
  BLAST_LIFETIME_TICKS,
  BlastKind,
  CELL_SCALE_PX,
  NUKE_DELAY_TICKS,
  NUKE_RADIUS_CELLS,
  TICKS_PER_SECOND,
  unitsToCells,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellX, cellY } from '@td/sim';
import type { BlastState, NukeState, WorldState } from '@td/sim';
import { ELEVATION_PX_PER_CELL, GROUND_SQUASH, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import type { ViewBounds } from './entities.js';
import { BASE_LAUNCH_POINT } from './base-structure.js';
import { GENERAL_ALTITUDE, UNIT_ALTITUDE } from './models.js';
import { blend } from './prism.js';
import { hashOf, noiseFrom } from './noise.js';
import {
  fadeOver,
  glowFill,
  particleHeight,
  resetEffectPaints,
  riseOver,
  smokeFill,
  speedForReach,
  travel,
} from './effects.js';

/**
 * Разрушение: вспышки, искры, обломки, дым, ударная волна и ракета.
 *
 * Модуль отвечает на один вопрос — как выглядит гибель. О том, что она
 * случилась, ему сообщает состояние мира: ядро кладёт туда запись о взрыве
 * ровно так же, как кладёт след выстрела. Своего состояния между кадрами
 * здесь нет ни байта, и это не аккуратность, а необходимость: клиент
 * пересобирает предсказанный мир откатом, один и тот же тик рисуется
 * по нескольку раз, и любая накопленная величина к третьему разу
 * рассогласовалась бы с миром.
 *
 * Поэтому положение каждой искры выводится прямо из возраста взрыва
 * выкладкой, а форма разлёта — из хеша по эпицентру. Взрыв, нарисованный
 * дважды в один момент, совпадает точка в точку.
 *
 * Свет здесь складывается, а не закрашивает. Две пересёкшиеся искры ярче
 * одной, вспышка высветляет то, что под ней. В PixiJS это режим смешивания,
 * заданный слою целиком, поэтому светящееся и несветящееся разложены
 * по разным слоям, а не рисуются вперемешку.
 */

export interface BlastLayers {
  /** Дым, обломки и корпус ракеты. Обычное смешивание: это тела. */
  readonly debris: Graphics;
  /** Свет: вспышки, искры, кольца, факел. Сложение цвета. */
  readonly glow: Graphics;
  /** Засветка всего экрана. Живёт в экранных координатах, вне мира. */
  readonly flash: Graphics;
}

export interface BlastColors {
  readonly self: number;
  readonly enemy: number;
  readonly hullDark: number;
  /** Белое ядро вспышки. */
  readonly core: number;
  /** Огонь. Единственный тёплый цвет на поле. */
  readonly fire: number;
  readonly smoke: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Заготовки заливок
// ─────────────────────────────────────────────────────────────────────────

/**
 * Свет, дым и полёт частицы живут в `effects.ts`.
 *
 * Раньше они жили здесь и годились одному разрушению. Потом собственные
 * вспышки завелись у выстрела, и держать две копии стало нельзя: первая
 * же правка яркости развела бы взрыв и вспышку у ствола по разным мирам.
 *
 * Наружу они по-прежнему смотрят отсюда — на них опираются тесты
 * разрушения, и водить их за собой по чужим модулям незачем.
 */
export { particleHeight, travel };

export const resetBlastPaints = resetEffectPaints;

// ─────────────────────────────────────────────────────────────────────────
// Общие величины
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сколько экранных пикселей в клетке по горизонтали.
 *
 * Радиусы вспышек заданы в клетках, чтобы взрыв соотносился с полем,
 * а не с окном. Переводится масштабом проекции, а не подобранным числом.
 */
const PX_PER_CELL = CELL_SCALE_PX;

/**
 * Во сколько раз ореол вокруг огня шире самого огня.
 *
 * Объявлен здесь, а не рядом с отрисовкой огня, по двум причинам сразу.
 * По нему считается размер ядерного шара в наборе обликов ниже — а тот
 * собирается при загрузке модуля, и объявление ниже по файлу дало бы
 * обращение к величине до её создания. И по существу: внешний край огня —
 * это ореол, и вписывать в пятно поражения надо именно его.
 */
const FIREBALL_HALO = 1.35;

const screenAt = (x: number, y: number, height: number): Point => {
  const point = worldToScreen(x, y);
  return { x: point.x, y: point.y - height * ELEVATION_PX_PER_CELL };
};

const fade = fadeOver;
const rise = riseOver;

// ─────────────────────────────────────────────────────────────────────────
// Облик по виду взрыва
// ─────────────────────────────────────────────────────────────────────────

interface BlastProfile {
  readonly sparks: number;
  readonly chunks: number;
  readonly puffs: number;
  /** Наибольший радиус вспышки, в клетках. */
  readonly flashCells: number;
  /**
   * Размер клубов дыма, в клетках.
   *
   * Отдельно от радиуса вспышки, хотя поначалу выводился из него.
   * У ядерного удара вспышка в десять клеток, и выведенный из неё дым
   * закрывал поле сплошной пеленой шириной в пол-экрана.
   */
  readonly smokeCells: number;
  /** Скорость разлёта искр, клеток в секунду. */
  readonly sparkSpeed: number;
  /** Скорость разлёта обломков. Они тяжелее и летят ближе. */
  readonly chunkSpeed: number;
  /** Высота, с которой начинается разлёт: тело гибнет там, где висело. */
  readonly altitude: number;
  /** Запас на отсечение по экрану, в пикселях. */
  readonly margin: number;
}

/**
 * Числа подобраны по одному правилу: взрыв заметен настолько, насколько
 * значима потеря. Машин гибнут десятки, и их взрыв обязан прочитаться
 * и не залить экран; башня — это вложенная энергия и потерянная позиция,
 * ей достаётся больше дыма и тяжёлых обломков.
 *
 * 23.08.2026 размеры удвоены. Прежний взрыв юнита был в полклетки —
 * заметно меньше самой машины, — и гибель читалась не гибелью, а щелчком:
 * вспышка величиной с колесо на теле шириной в клетку. Клетка с лишним
 * ставит вспышку вровень с тем, что погибло, и разрушение наконец
 * оказывается событием, а не отметкой о событии.
 *
 * Удвоен именно РАЗМЕР, а не срок. Сроки остались прежние (`FLASH_*`
 * и `BLAST_LIFETIME_TICKS`) и трогать их нельзя: вспышка, растянутая
 * во времени вместе с размером, перестаёт быть ударом и превращается
 * в медленно раздувающийся шар, то есть в дым. Разведение размера
 * и срока — то же правило, что уже записано у попадания выстрела.
 *
 * Порядок между видами сохранён: юнит < постройка < генерал. Иначе
 * гибель машины начала бы весить столько же, сколько гибель башни.
 */
const PROFILE: Readonly<Record<BlastKind, BlastProfile>> = {
  [BlastKind.Unit]: {
    sparks: 18,
    chunks: 8,
    // Клубов пять, а не два. Двумя дым не клубится: два пятна любой
    // мягкости глаз собирает в одно, и получается облачко, а не выброс.
    puffs: 5,
    flashCells: 1.1,
    smokeCells: 0.85,
    sparkSpeed: 8,
    chunkSpeed: 4.2,
    altitude: UNIT_ALTITUDE,
    margin: 300,
  },
  [BlastKind.General]: {
    sparks: 24,
    chunks: 10,
    puffs: 6,
    flashCells: 1.5,
    smokeCells: 1.1,
    sparkSpeed: 9.5,
    chunkSpeed: 5,
    altitude: GENERAL_ALTITUDE,
    margin: 380,
  },
  [BlastKind.Structure]: {
    sparks: 20,
    chunks: 12,
    puffs: 6,
    flashCells: 1.15,
    smokeCells: 1.15,
    sparkSpeed: 6,
    chunkSpeed: 3.6,
    altitude: 0.35,
    margin: 340,
  },
  /**
   * У ядерного взрыва все длины — доли радиуса поражения, и ни одной
   * подобранной величины. Облик обязан следовать за радиусом: иначе
   * первая же правка баланса разведёт картинку и правило, причём молча —
   * взрыв останется красивым, просто перестанет говорить правду о том,
   * что погибло.
   *
   * Здесь записан облик БАЗОВОГО радиуса. Радиус прокачивается, поэтому
   * перед отрисовкой строка растягивается под радиус конкретного удара —
   * этим занимается `profileOf`.
   */
  [BlastKind.Nuke]: {
    sparks: 40,
    chunks: 16,
    puffs: 6,
    /**
     * Огненный шар рисуется КРУГОМ на экране, а поражение ложится
     * ЭЛЛИПСОМ на землю. Совпадают они только по ширине; по высоте
     * экранный круг вдвое длиннее, и всё, что он накрыл сверху и снизу,
     * на самом деле уцелело.
     *
     * Поэтому шар считается от КОРОТКОЙ полуоси пятна — радиус
     * на сплющивание проекции, — и ещё делится на ореол, который шире
     * самого шара. Выходит 4,2 клетки против прежних восьми.
     *
     * Восемь были не украшением, а именно ошибкой: шар — самое яркое
     * в первую секунду, и размер удара игрок читал по нему. Читал
     * на треть больше, чем погибло.
     */
    flashCells: (NUKE_RADIUS_CELLS * GROUND_SQUASH) / FIREBALL_HALO,
    smokeCells: NUKE_RADIUS_CELLS * 0.32,
    /**
     * Искры долетают ровно до края поражения, обломки — до половины:
     * тяжёлое падает ближе. Разлёт задан расстоянием, а не скоростью,
     * потому что проверяемое утверждение здесь именно «ровно до края».
     */
    sparkSpeed: speedForReach(NUKE_RADIUS_CELLS),
    chunkSpeed: speedForReach(NUKE_RADIUS_CELLS * 0.5),
    altitude: 0.4,
    // Гриб поднимается на тринадцать клеток, то есть на шестьсот с лишним
    // пикселей вверх от эпицентра, а кольца уходят на два с половиной
    // радиуса вбок. Обычного запаса ему мало.
    margin: 1400,
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Точка входа
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сколько взрывов за кадр рисуется во всех подробностях.
 *
 * Ограничение не запас на будущее, а лечение измеренной беды. Дым, обломки
 * и вспышка одного взрыва — это около десятка заливок градиентом, а каждая
 * заливка градиентом рвёт пакет: у неё своя матрица текстуры, и видеокарта
 * получает отдельный вызов. Полсотни машин, погибших под ядерным ударом
 * в один тик, дают шестьсот вызовов и двадцать четыре миллисекунды
 * на кадр — при бюджете в шестнадцать с половиной.
 *
 * Сверх этого числа взрыв рисуется коротко: ядро вспышки и искры, без дыма
 * и обломков. Потеря честная — теряется ровно то, чего в такой момент
 * не видно: полсотни отдельных дымов в одной точке сливаются в муть,
 * а поверх них в этот момент как раз встаёт вал ядерного взрыва.
 *
 * Подробности достаются последним в списке, то есть самым свежим. Смерть,
 * случившаяся только что, — это событие, за которым игрок следит;
 * догорающая полсекунды — уже фон.
 *
 * Настоящее лечение другое: рисовать частицы не заливками, а спрайтами
 * с одной общей текстурой, которые пакуются в один вызов. Это переделка
 * всего модуля, и делать её стоит тогда, когда десяти подробных взрывов
 * окажется мало.
 *
 * Десять стало восемь 23.08.2026, когда взрыв вырос вдвое и получил пять
 * клубов дыма вместо двух. Бюджет тут не в штуках, а в миллисекундах,
 * и держать надо его. Замерено на этой машине в настоящем PixiJS:
 * заливка градиентом радиусом 30 пикселей стоит 0,023 мс, радиусом 60 —
 * 0,039 мс. Подробный взрыв юнита был около пяти заливок и стал около
 * девяти, причём вдвое более крупных: примерно 0,12 мс против 0,33.
 * Десять прежних — 1,2 мс на кадр, восемь нынешних — 2,6 мс.
 *
 * Дороже, и это признаётся честно. Выбор был между «восемь крупных»
 * и «десять мелких», и он сделан в пользу крупных: в тот момент, когда
 * взрывов на экране больше восьми, они всё равно сливаются в одно
 * зарево, и разница между восемью и десятью источниками этого зарева
 * не видна никому — а разница между заметным взрывом и незаметным
 * видна всегда.
 *
 * Спрайты сняли бы этот выбор целиком: тот же замер даёт 0,003 мс
 * на спрайт из общей текстуры, то есть вдесятеро дешевле заливки
 * и без зависимости от радиуса. Это следующий шаг, и он стоит того,
 * но требует слоя-контейнера от сцены, а не `Graphics`.
 */
const DETAILED_BLASTS_PER_FRAME = 8;

/**
 * Облик взрыва с поправкой на его радиус.
 *
 * Для всех взрывов, кроме ядерного, это просто строка таблицы: у гибели
 * машины размер один и тот же. У ядерного радиус свой у каждого удара —
 * он прокачивается, — и все длины его облика растягиваются вместе с ним.
 * Иначе прокачанный вдвое удар накрывал бы вдвое больший круг, а огненный
 * шар над ним оставался бы прежним: картинка перестала бы говорить правду
 * о том, что погибло.
 *
 * Запас на отсечение растягивается тоже: гриб и ударная волна уходят
 * далеко за радиус, и при прежнем запасе прокачанный взрыв обрезался бы
 * по краю экрана.
 */
const profileOf = (blast: BlastState): BlastProfile => {
  const base = PROFILE[blast.kind];
  if (blast.kind !== BlastKind.Nuke) return base;

  const cells = unitsToCells(blast.radius);
  const scale = cells / NUKE_RADIUS_CELLS;

  return {
    ...base,
    flashCells: base.flashCells * scale,
    smokeCells: base.smokeCells * scale,
    sparkSpeed: speedForReach(cells),
    chunkSpeed: speedForReach(cells * 0.5),
    margin: base.margin * scale,
  };
};

/** Виден ли взрыв: то же отсечение, что и у сущностей, с запасом по виду. */
const blastOnScreen = (blast: BlastState, view: ViewBounds): boolean => {
  const anchor = worldToScreen(unitsToCells(blast.at.x), unitsToCells(blast.at.y));
  const margin = profileOf(blast).margin;

  return (
    anchor.x >= view.minX - margin &&
    anchor.x <= view.maxX + margin &&
    anchor.y >= view.minY - margin &&
    anchor.y <= view.maxY + margin
  );
};

/**
 * Нарисовать все взрывы и все летящие ракеты.
 *
 * Возвращает размах тряски в пикселях. Смещать картинку модуль не может
 * и не должен: слои ему дают, а контейнером владеет сцена. Отдать число
 * наверх — и правило «тряска смещает картинку, а не камеру» остаётся
 * в одном месте.
 */
export const drawBlasts = (
  layers: BlastLayers,
  world: WorldState,
  time: number,
  view: ViewBounds,
  viewport: Viewport,
  colors: BlastColors,
  localPlayer: PlayerId,
): number => {
  let shake = 0;
  let screenFlash = 0;
  let flashCentre: Point = { x: viewport.width / 2, y: viewport.height / 2 };

  // Сколько взрывов доживёт до геометрии, надо знать ДО того, как первый
  // из них нарисован: подробности достаются последним, а не первым.
  let visible = 0;
  for (const blast of world.blasts) {
    if (blast.kind !== BlastKind.Nuke && blastOnScreen(blast, view)) visible += 1;
  }

  const leanCount = Math.max(0, visible - DETAILED_BLASTS_PER_FRAME);
  let drawn = 0;

  for (const blast of world.blasts) {
    const profile = profileOf(blast);
    const x = unitsToCells(blast.at.x);
    const y = unitsToCells(blast.at.y);
    const anchor = worldToScreen(x, y);

    // Отсечение до построения геометрии — то же правило, что и у сущностей.
    if (
      anchor.x < view.minX - profile.margin ||
      anchor.x > view.maxX + profile.margin ||
      anchor.y < view.minY - profile.margin ||
      anchor.y > view.maxY + profile.margin
    ) {
      continue;
    }

    const life = BLAST_LIFETIME_TICKS[blast.kind];
    const seconds = Math.max(0, (time - (blast.expiresAtTick - life)) / TICKS_PER_SECOND);
    const span = life / TICKS_PER_SECOND;
    const seed = hashOf([blast.at.x, blast.at.y, blast.expiresAtTick, blast.kind]);
    const accent = blast.owner === localPlayer ? colors.self : colors.enemy;

    if (blast.kind === BlastKind.Nuke) {
      drawNuke(layers, x, y, seconds, span, seed, profile, unitsToCells(blast.radius), colors);
      shake = Math.max(shake, nukeShake(seconds));

      const strength = nukeFlash(seconds) * proximity(anchor, view);
      if (strength > screenFlash) {
        screenFlash = strength;
        // Мировой контейнер сдвинут камерой, а слой засветки — нет,
        // поэтому эпицентр переводится в экранные координаты вычитанием
        // левого верхнего угла видимой области.
        flashCentre = { x: anchor.x - view.minX, y: anchor.y - view.minY };
      }
      continue;
    }

    const lean = drawn < leanCount;
    drawn += 1;

    drawCommonBlast(layers, x, y, seconds, span, seed, profile, accent, colors, lean);
  }

  for (const nuke of world.nukes) {
    drawMissile(layers, world, nuke, time, colors, localPlayer);
  }

  drawScreenFlash(layers.flash, screenFlash, flashCentre, viewport, colors);

  return shake;
};

// ─────────────────────────────────────────────────────────────────────────
// Обычный взрыв: юнит, генерал, постройка
// ─────────────────────────────────────────────────────────────────────────

const drawCommonBlast = (
  layers: BlastLayers,
  x: number,
  y: number,
  seconds: number,
  span: number,
  seed: number,
  profile: BlastProfile,
  accent: number,
  colors: BlastColors,
  lean: boolean,
): void => {
  // Дым и обломки — самое дорогое во взрыве и самое незаметное в толпе:
  // они первыми и отбрасываются, когда взрывов больше, чем бюджет кадра.
  if (!lean) {
    drawSmoke(layers.debris, x, y, seconds, span, seed, profile, colors);
    drawChunks(layers.debris, x, y, seconds, span, seed, profile, accent, colors);
  }

  drawFireball(layers.glow, x, y, seconds, profile, colors, lean);
  drawSparks(layers.glow, x, y, seconds, span, seed, profile, colors);
};

/**
 * Вспышка: белое ядро, вокруг него огонь, а по краю — разбегающееся кольцо.
 *
 * Три части, и каждая нужна за своим. Огонь шире и живёт дольше, ядро
 * меньше и гаснет почти сразу — именно эта разница скоростей и читается
 * вспышкой; один круг любой яркости читается пятном.
 *
 * Кольцо — то, что отличает взрыв от загоревшейся лампочки. Оно уходит
 * за пределы огня и гаснет за пятую долю секунды, то есть глаз ловит его
 * не как фигуру, а как рывок. Без него всё остальное выглядит вспыхнувшим
 * светом, а не ударом.
 */
const FLASH_GROW_SECONDS = 0.09;
const FLASH_FIRE_SECONDS = 0.45;
const FLASH_CORE_SECONDS = 0.19;
const FLASH_RING_SECONDS = 0.16;

const drawFireball = (
  glow: Graphics,
  x: number,
  y: number,
  seconds: number,
  profile: BlastProfile,
  colors: BlastColors,
  lean = false,
): void => {
  if (seconds > FLASH_FIRE_SECONDS) return;

  const centre = screenAt(x, y, profile.altitude + 0.25);
  const grown = Math.min(1, seconds / FLASH_GROW_SECONDS);

  // Радиус растёт быстро и не убывает: сжимающийся огонь читается
  // всасыванием, а не взрывом. Гаснет он прозрачностью.
  const radius = profile.flashCells * PX_PER_CELL * (0.35 + 0.65 * grown);
  const fireAlpha = fade(seconds, FLASH_FIRE_SECONDS * 0.2, FLASH_FIRE_SECONDS);

  // В кратком виде остаётся одно тело огня из двух: ореол вокруг него
  // при полусотне взрывов в одной точке всё равно ни от чего не отличим.
  if (!lean) {
    glow.circle(centre.x, centre.y, radius * FIREBALL_HALO);
    glow.fill({ fill: glowFill(colors.fire), alpha: 0.55 * fireAlpha });
  }

  glow.circle(centre.x, centre.y, radius);
  glow.fill({ fill: glowFill(colors.fire), alpha: 0.85 * fireAlpha });

  const coreAlpha = fade(seconds, 0, FLASH_CORE_SECONDS);
  if (coreAlpha > 0) {
    if (!lean) {
      glow.circle(centre.x, centre.y, radius * 0.6);
      glow.fill({ fill: glowFill(colors.core), alpha: coreAlpha });
    }
    // Сплошная заливка, а не градиент: она пакуется с соседними и потому
    // остаётся даже в кратком виде — без неё у вспышки пропадает ядро.
    glow.circle(centre.x, centre.y, radius * 0.3);
    glow.fill({ color: colors.core, alpha: 0.8 * coreAlpha });
  }

  if (lean || seconds > FLASH_RING_SECONDS) return;

  const wave = 1 - (1 - seconds / FLASH_RING_SECONDS) ** 2;
  const ringAlpha = fade(seconds, 0, FLASH_RING_SECONDS) ** 2;
  const ringRadius = profile.flashCells * PX_PER_CELL * (0.3 + 1.4 * wave);

  // Ореол под кольцом и тонкое ядро поверх — иначе кольцо читается
  // нарисованной окружностью, а не сжатым воздухом. Гаснет оно по квадрату:
  // равномерное угасание оставляет чёткий круг висеть слишком долго,
  // и глаз успевает опознать в нём фигуру.
  glow.circle(centre.x, centre.y, ringRadius);
  glow.stroke({ width: 3 + 8 * (1 - wave), color: colors.core, alpha: 0.18 * ringAlpha });

  glow.circle(centre.x, centre.y, ringRadius);
  glow.stroke({ width: 1 + 2.5 * (1 - wave), color: colors.core, alpha: 0.6 * ringAlpha });
};

/**
 * Искры: короткие светящиеся следы, разлетающиеся и падающие.
 *
 * Рисуются отрезком от того места, где искра была мгновение назад,
 * к тому, где она сейчас. Точка не читается движением ничем, а отрезок
 * читается сразу — и стоит ровно того же.
 */
const SPARK_TRAIL_SECONDS = 0.06;

const drawSparks = (
  glow: Graphics,
  x: number,
  y: number,
  seconds: number,
  span: number,
  seed: number,
  profile: BlastProfile,
  colors: BlastColors,
): void => {
  const alive = fade(seconds, span * 0.25, span * 0.85);
  if (alive <= 0) return;

  const trace = (): void => {
    const noise = noiseFrom(seed);

    for (let index = 0; index < profile.sparks; index += 1) {
      const angle = (noise() + 1) * Math.PI;
      const speed = profile.sparkSpeed * (0.35 + 0.65 * Math.abs(noise()));
      const lift = 1 + Math.abs(noise()) * 3.5;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);

      const now = travel(speed, seconds);
      const before = travel(speed, Math.max(0, seconds - SPARK_TRAIL_SECONDS));

      const head = screenAt(
        x + dirX * now,
        y + dirY * now,
        particleHeight(profile.altitude, lift, seconds),
      );
      const tail = screenAt(
        x + dirX * before,
        y + dirY * before,
        particleHeight(profile.altitude, lift, Math.max(0, seconds - SPARK_TRAIL_SECONDS)),
      );

      glow.moveTo(tail.x, tail.y).lineTo(head.x, head.y);
    }
  };

  // Два прохода по одному и тому же зерну: широкий тёплый ореол и тонкое
  // белое ядро поверх. Тот же приём, что у луча снайпера, и по той же
  // причине — линия в один пиксель не светится, она просто линия.
  //
  // Все искры одной обводкой: их два десятка, и два десятка обращений
  // к видеокарте вместо одного заметны, когда на экране полсотни взрывов.
  trace();
  glow.stroke({ width: 5, color: colors.fire, alpha: 0.3 * alive });

  trace();
  glow.stroke({ width: 1.6, color: colors.core, alpha: 0.95 * alive });
};

/**
 * Обломки: тяжёлые куски корпуса, летящие ниже искр и остающиеся лежать.
 *
 * Это единственная часть взрыва, окрашенная цветом стороны. Свет, огонь
 * и дым у обеих сторон одинаковые — принадлежность сообщает то, что
 * от машины осталось, а не то, чем она горит.
 */
const drawChunks = (
  debris: Graphics,
  x: number,
  y: number,
  seconds: number,
  span: number,
  seed: number,
  profile: BlastProfile,
  accent: number,
  colors: BlastColors,
): void => {
  // Своё зерно: возьми обломки тот же поток, что и искры, они полетели бы
  // теми же лучами, и разлёт сложился бы в звезду.
  const alpha = fade(seconds, span * 0.55, span);
  if (alpha <= 0) return;

  const trace = (): void => {
    const noise = noiseFrom(seed ^ 0x9e3779b9);

    for (let index = 0; index < profile.chunks; index += 1) {
      const angle = (noise() + 1) * Math.PI;
      const speed = profile.chunkSpeed * (0.3 + 0.7 * Math.abs(noise()));
      const lift = 0.6 + Math.abs(noise()) * 2.4;
      const size = 2.2 + Math.abs(noise()) * 2.6;

      const distance = travel(speed, seconds);
      const centre = screenAt(
        x + Math.cos(angle) * distance,
        y + Math.sin(angle) * distance,
        particleHeight(profile.altitude, lift, seconds),
      );

      // Кувырок: ширина колеблется, высота нет. На куске в шесть пикселей
      // от честного вращения это неотличимо, а стоит одного косинуса.
      const spin = Math.cos(seconds * (7 + index)) * size;

      debris
        .moveTo(centre.x - spin, centre.y)
        .lineTo(centre.x, centre.y - size)
        .lineTo(centre.x + spin, centre.y)
        .lineTo(centre.x, centre.y + size)
        .closePath();
    }
  };

  // Тёмный корпус с малой примесью цвета стороны, а не сам цвет стороны:
  // неоновый обломок читается подобранным бонусом, а не куском брони.
  // Принадлежность при этом остаётся видна — её несёт тонкая окантовка,
  // тот же приём, которым опознаются сами машины на тёмной земле.
  //
  // И обломок остывает: первые полсекунды он раскалён и потому ближе
  // к цвету огня, дальше — к цвету брони. Без остывания куски читаются
  // мусором, вылетевшим из мешка, а не тем, что только что горело.
  const heat = fade(seconds, 0.05, 0.45);
  const hull = blend(colors.hullDark, accent, 0.18);

  trace();
  debris.fill({ color: blend(hull, colors.fire, heat * 0.7), alpha });

  trace();
  debris.stroke({ width: 1, color: accent, alpha: 0.45 * alpha });
};

/**
 * Дым: несколько клубов, всплывающих, расходящихся и рассеивающихся.
 *
 * Клубы намеренно перекрываются: одиночное облако любой мягкости выглядит
 * пятном, а пять наложенных — клубящимся дымом. Тот же приём, что
 * и у настоящих систем частиц, только клубов не сотни, а единицы.
 *
 * Клубится дым от трёх движений сразу, и убери любое — он снова станет
 * пятном:
 *
 *   всплывает        — общее для всех, скорость одна;
 *   расходится       — каждый клуб уезжает от эпицентра по своему лучу,
 *                      быстро в начале и почти встав к концу;
 *   раздувается      — и тем сильнее бледнеет.
 *
 * Последнее и есть «рассеивается». Раньше клуб рос и гас по своим часам,
 * независимо друг от друга, и в середине жизни выходил и большим, и ещё
 * плотным — то есть читался не дымом, а мазком краски. Теперь яркость
 * поделена на размер: дыма в клубе ровно столько, сколько было, и, растекаясь
 * на вчетверо большую площадь, он вчетверо просвечивает. Это же снимает
 * старую беду — раздутый клуб перестал закрывать собой поле.
 */
const SMOKE_RISE_CELLS_PER_SECOND = 0.95;

/** Насколько клуб раздувается за секунду, в долях своего размаха. */
const SMOKE_SPREAD_PER_SECOND = 0.85;

/**
 * За сколько секунд клуб уезжает от эпицентра на всё своё расстояние.
 *
 * Быстро: выброс — это рывок, и клуб, отползающий в сторону полсекунды,
 * читается не выбросом, а туманом, который натягивает ветром.
 */
const SMOKE_PUSH_SECONDS = 0.35;

/** Плотность клуба в тот миг, когда он ещё не начал раздуваться. */
const SMOKE_DENSITY = 0.52;

/**
 * Насколько дым светлее копоти.
 *
 * Токен `--td-blast-smoke` — это цвет сажи, `rgb(43,38,34)`. Поле залито
 * `rgb(25,25,25)`. Разница в восемнадцать уровней, да ещё умноженная
 * на прозрачность клуба, даёт на экране четыре уровня — то есть дым,
 * которого не видно вовсе. Проверено картинкой 23.08.2026: клубы
 * рисовались, считались, тратили кадр и не читались ничем.
 *
 * Осветляется дым НЕ произвольным серым, а подмешиванием цвета ядра
 * вспышки — того же, которым горит всё на этом поле. Правило проекта
 * про цвета из токенов от этого не страдает: новых цветов не заводится,
 * заводится смесь двух имеющихся, ровно как у выхлопа ракеты рядом.
 *
 * Доля скромная. `blend` даёт `rgb(73,67,61)` — это дым, освещённый
 * пожаром и небом, а не туман: он остаётся заметно темнее породы
 * и не спорит с ней за внимание. Больше — и над полем повиснет молоко;
 * ровно на этом обжёгся первый заход, где дым вышел светлее земли
 * и читался туманом.
 */
const SMOKE_LIFT = 0.14;

const drawSmoke = (
  debris: Graphics,
  x: number,
  y: number,
  seconds: number,
  span: number,
  seed: number,
  profile: BlastProfile,
  colors: BlastColors,
): void => {
  const noise = noiseFrom(seed ^ 0x85ebca6b);

  for (let index = 0; index < profile.puffs; index += 1) {
    // Клубы вылетают не разом: разброс по времени и превращает выброс
    // в клубящийся, а не в раскрывающийся цветок. Треть срока — предел,
    // за которым последний клуб уже не успевает рассеяться внутри записи.
    const delay = Math.abs(noise()) * span * 0.35;
    const age = seconds - delay;

    // Клуб уезжает не в эпицентр, а в свою сторону, и стороны у клубов
    // разные. Без этого несколько облаков ложатся друг на друга ровно
    // и дают одно большое пятно вместо клубящегося дыма.
    const offAngle = (noise() + 1) * Math.PI;
    const offset = profile.smokeCells * (0.35 + Math.abs(noise()) * 1.5);
    const drift = noise() * 0.5;
    // Размах у клубов очень разный: одинаковые по величине они снова
    // сливаются в одно ровное пятно, сколько их ни разводи в стороны.
    const spread = 0.4 + Math.abs(noise()) * 0.9;

    if (age <= 0) continue;

    // Раздувание считается ДО прозрачности: от него зависит и размер,
    // и то, насколько клуб просвечивает.
    const swell = spread + age * SMOKE_SPREAD_PER_SECOND;

    // Дым живёт дольше всего остального: огонь погас, обломки легли,
    // а над местом ещё висит. Ровно это и делает разрушение разрушением,
    // а не вспышкой.
    //
    // Делится на размах: клуб не становится плотнее оттого, что вырос, —
    // наоборот, того же дыма на большую площадь приходится меньше.
    const alpha =
      (SMOKE_DENSITY * fade(age, span * 0.3, span * 1.15) * rise(age, 0, 0.08)) /
      (0.55 + swell * 0.75);
    if (alpha <= 0.01) continue;

    // Разлёт с торможением: почти всё расстояние проходится в первые
    // доли секунды, дальше клуб только всплывает и раздувается.
    const push = Math.min(1, age / SMOKE_PUSH_SECONDS) ** 0.6;

    const height = profile.altitude + 0.15 + age * SMOKE_RISE_CELLS_PER_SECOND;
    const centre = screenAt(
      x + Math.cos(offAngle) * offset * push + drift * age,
      y + Math.sin(offAngle) * offset * push + drift * age * 0.6,
      height,
    );
    const radius = profile.smokeCells * swell * PX_PER_CELL;

    // Пока не остыл, дым подсвечен изнутри: это и отличает первую секунду
    // после взрыва от последней — тот же клуб, но горячий.
    //
    // Жар входит в ЦВЕТ клуба, а не рисуется вторым кругом поверх. Второй
    // круг стоил ровно столько же, сколько первый: в PixiJS каждый круг
    // разбивается на треугольники на процессоре, и в толпе взрывов это
    // и оказалось самой дорогой строчкой во всём модуле.
    //
    // Доля жара округляется до четвертей, и это не небрежность: заготовка
    // градиента кешируется по цвету, а непрерывно меняющийся цвет означал
    // бы новую текстуру на каждый кадр.
    //
    // Окно жара растянуто до девяти десятых секунды: клуб теперь живёт
    // и раздувается дольше, и жар, гаснущий за полсекунды, оставлял
    // вторую половину жизни дыма ровной серой кляксой.
    const heat = Math.round(fade(age, 0.15, 0.9) * 4) / 4;
    const body = blend(colors.smoke, colors.core, SMOKE_LIFT);

    debris.circle(centre.x, centre.y, radius);
    debris.fill({
      fill: smokeFill(heat <= 0 ? body : blend(body, colors.fire, heat * 0.5)),
      alpha,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Ядерный взрыв
// ─────────────────────────────────────────────────────────────────────────

/** Сколько точек берётся на окружность ударной волны. */
const RING_STEPS = 64;

const traceWorldCircle = (
  graphics: Graphics,
  centreX: number,
  centreY: number,
  radiusCells: number,
  height = 0,
): void => {
  for (let index = 0; index <= RING_STEPS; index += 1) {
    const angle = (index / RING_STEPS) * Math.PI * 2;
    const point = screenAt(
      centreX + Math.cos(angle) * radiusCells,
      centreY + Math.sin(angle) * radiusCells,
      height,
    );

    if (index === 0) graphics.moveTo(point.x, point.y);
    else graphics.lineTo(point.x, point.y);
  }
};

/**
 * Ударная волна: сколько живёт и докуда доходит.
 */
const SHOCK_SECONDS = 2.4;
const SHOCK_REACH = 2.6;

/**
 * Докуда поднимается гриб и когда он вырастает.
 *
 * Высота — доля радиуса поражения: гриб обязан быть соразмерен тому,
 * что взрыв накрыл. Доля, а не готовые клетки, потому что радиус
 * у каждого удара свой — он прокачивается.
 */
const MUSHROOM_TOP_SHARE = 1.3;
const MUSHROOM_START = 0.75;
const MUSHROOM_SECONDS = 2.6;

const drawNuke = (
  layers: BlastLayers,
  x: number,
  y: number,
  seconds: number,
  span: number,
  seed: number,
  profile: BlastProfile,
  cells: number,
  colors: BlastColors,
): void => {
  drawShockRing(layers.debris, layers.glow, x, y, seconds, seed, cells, colors);
  drawGroundFlash(layers.glow, x, y, seconds, cells, colors);
  // Огненный шар — тот же, что и у всякого взрыва, только размером
  // из ядерной строки набора. Прежде ядерный взрыв его не рисовал вовсе:
  // `flashCells` у этой строки была величиной, которую никто не читал,
  // а самое яркое в первую секунду у самого дорогого удара в игре
  // отсутствовало.
  drawFireball(layers.glow, x, y, seconds, profile, colors);
  drawMushroom(layers.debris, layers.glow, x, y, seconds, cells, colors);

  drawSmoke(layers.debris, x, y, seconds, span, seed, profile, colors);
  drawChunks(layers.debris, x, y, seconds, span * 0.45, seed, profile, colors.smoke, colors);
  drawSparks(layers.glow, x, y, seconds, span * 0.4, seed, profile, colors);
};

/**
 * Белое пятно на земле в первое мгновение.
 *
 * Рисуется многоугольником по мировой окружности, а не экранным кругом:
 * проекция косая, и круг на экране означал бы круг в воздухе, а не пятно
 * на земле. Заливка — тот же радиальный градиент, натянутый на габариты
 * многоугольника, поэтому у пятна нет края.
 */
const GROUND_FLASH_SECONDS = 2.4;

const drawGroundFlash = (
  glow: Graphics,
  x: number,
  y: number,
  seconds: number,
  cells: number,
  colors: BlastColors,
): void => {
  if (seconds > GROUND_FLASH_SECONDS) return;

  const radius = cells * (0.25 + 0.75 * Math.min(1, seconds / 0.3));

  traceWorldCircle(glow, x, y, radius);
  glow.fill({
    fill: glowFill(colors.fire),
    alpha: 0.8 * fade(seconds, 0.3, GROUND_FLASH_SECONDS),
  });

  const core = fade(seconds, 0, 0.55);
  if (core > 0) {
    traceWorldCircle(glow, x, y, radius * 0.6);
    glow.fill({ fill: glowFill(colors.core), alpha: core });
  }

  // Кромка пятна ровно по радиусу поражения.
  //
  // Заливка выше — радиальный градиент, у неё края нет по устройству,
  // и докуда достало, по ней не сказать. Кромка это и сообщает: всё,
  // что внутри, погибло, всё, что снаружи, — уцелело.
  //
  // Живёт она недолго и гаснет вместе с разгоном пятна. Постоянная
  // окружность читалась бы нарисованной фигурой — тем же кольцом
  // прицеливания, которое к этому моменту уже сняли, — а не следом удара.
  const rim = fade(seconds, RIM_HOLD_SECONDS, RIM_SECONDS) * rise(seconds, 0, 0.12);
  if (rim <= 0) return;

  traceWorldCircle(glow, x, y, cells);
  glow.stroke({ width: 2 + 5 * rim, color: colors.core, alpha: 0.55 * rim });
};

/** Сколько держится и сколько живёт кромка пятна поражения. */
const RIM_HOLD_SECONDS = 0.25;
const RIM_SECONDS = 1.1;

/**
 * Ломает окружность вала: три синуса целых частот.
 *
 * Частоты обязаны быть целыми, иначе фронт не сойдётся сам с собой
 * на замыкании и в валу останется ступенька.
 *
 * И частоты высокие, а размах малый. Низкая частота при том же размахе
 * не рвёт край, а ведёт всю окружность: три волны на круг превращают
 * вал в треугольную кляксу, и расхождение из точки перестаёт читаться.
 */
const wobbleAt = (angle: number, phases: readonly number[]): number =>
  Math.sin(angle * 11 + (phases[0] ?? 0)) * 0.42 +
  Math.sin(angle * 19 + (phases[1] ?? 0)) * 0.33 +
  Math.sin(angle * 31 + (phases[2] ?? 0)) * 0.25;

/** Рваная окружность вала на заданной высоте. */
const traceDustRing = (
  graphics: Graphics,
  centreX: number,
  centreY: number,
  radiusCells: number,
  height: number,
  wobble: number,
  phases: readonly number[],
): void => {
  for (let index = 0; index <= RING_STEPS; index += 1) {
    const angle = (index / RING_STEPS) * Math.PI * 2;
    const reach = radiusCells * (1 + wobble * wobbleAt(angle, phases));
    const point = screenAt(
      centreX + Math.cos(angle) * reach,
      centreY + Math.sin(angle) * reach,
      height,
    );

    if (index === 0) graphics.moveTo(point.x, point.y);
    else graphics.lineTo(point.x, point.y);
  }
};

/**
 * Слои вала: от широкого и еле заметного к узкому и плотному.
 *
 * Так у обводки появляется мягкий край. У линии его нет по определению —
 * а у поднятой взрывом пыли краёв нет вовсе, и без этого приёма вал
 * читается ободком, положенным на землю.
 */
const DUST_LAYERS = [
  { width: 1, alpha: 0.22 },
  { width: 0.68, alpha: 0.34 },
  { width: 0.42, alpha: 0.46 },
  { width: 0.2, alpha: 0.6 },
] as const;

/**
 * Тот же приём для подсветки изнутри, слоёв поменьше и все слабее.
 *
 * Слабее намеренно: это дымный вал, подсвеченный огнём, а не огненный
 * вал. Стоит поднять эти доли — и пыль перестаёт читаться пылью,
 * остаётся светящийся ободок.
 */
const HEAT_LAYERS = [
  { width: 0.7, alpha: 0.07 },
  { width: 0.4, alpha: 0.11 },
  { width: 0.16, alpha: 0.16 },
] as const;

/**
 * Ударная волна: один вал пыли, катящийся по земле.
 *
 * Раньше здесь расходились три тонких кольца с запозданием друг от друга,
 * и выглядели они ровно тем, чем были, — тремя начерченными окружностями.
 * Беда не в числе колец: линия любой толщины остаётся линией, у неё два
 * чётких края, а у пыли краёв нет.
 *
 * Пробовали собирать вал из отдельных клубов, как собран весь прочий дым.
 * Не вышло: чтобы клубы сомкнулись на окружности в полсотни клеток, их
 * нужна добрая сотня, а сотней меньше они ложатся бусинами на нитку.
 *
 * Работает третье: рваная окружность, обведённая несколькими слоями
 * от широкого и тусклого к узкому и плотному. Рваная — потому что ровная
 * опознаётся глазом как фигура; слоями — потому что так у обводки
 * появляется мягкий край.
 *
 * Вал растёт: чем дальше уходит, тем выше, толще и прозрачнее. Это и
 * отличает катящуюся стену от расходящейся ряби.
 *
 * Светится он не сам — его освещает изнутри огненный шар, и подсветка
 * гаснет вдвое быстрее самой пыли. Из-за этого вал на глазах
 * превращается из раскалённого в серый, продолжая идти.
 */
const drawShockRing = (
  debris: Graphics,
  glow: Graphics,
  x: number,
  y: number,
  seconds: number,
  seed: number,
  cells: number,
  colors: BlastColors,
): void => {
  if (seconds <= 0 || seconds > SHOCK_SECONDS) return;

  // Расхождение замедляющееся: вал выхлёстывает и вязнет. Равномерное
  // читается расходящейся рябью, а не ударом.
  const progress = 1 - (1 - seconds / SHOCK_SECONDS) ** 2;
  const radius = cells * SHOCK_REACH * progress;
  const alpha = fade(seconds, SHOCK_SECONDS * 0.35, SHOCK_SECONDS);
  if (alpha <= 0) return;

  const noise = noiseFrom(seed ^ 0x27d4eb2f);
  const phases = [noise() * Math.PI, noise() * Math.PI, noise() * Math.PI];

  const wallCells = cells * (0.08 + progress * 0.34);
  const bandPx = wallCells * PX_PER_CELL * 0.8;
  const height = wallCells * 0.45;
  // Рваность растёт вместе с валом: вблизи взрыва фронт ещё ровный,
  // дальше он расползается.
  const wobble = 0.014 + progress * 0.03;

  for (const layer of DUST_LAYERS) {
    traceDustRing(debris, x, y, radius, height, wobble, phases);
    debris.stroke({ width: bandPx * layer.width, color: colors.smoke, alpha: layer.alpha * alpha });
  }

  const heat = fade(seconds, 0.1, SHOCK_SECONDS * 0.35);
  if (heat > 0) {
    for (const layer of HEAT_LAYERS) {
      traceDustRing(glow, x, y, radius * 0.97, height * 0.9, wobble, phases);
      glow.stroke({
        width: bandPx * layer.width,
        color: colors.fire,
        alpha: layer.alpha * alpha * heat,
      });
    }
  }

  // Гребень: сам фронт сжатого воздуха. Тонкий и тусклый — он лишь
  // отмечает, куда дошла волна, а весь вес несёт пыль.
  traceDustRing(glow, x, y, radius, height, wobble, phases);
  glow.stroke({ width: 1 + 2 * (1 - progress), color: colors.core, alpha: 0.12 * alpha });
};

/**
 * Огненный шар и гриб над ним.
 *
 * Шар всплывает и тянет за собой ножку — это и есть гриб: не рисованная
 * шляпка, а поднявшийся шар с оставшимся под ним столбом. Собран из тех же
 * двух заготовок, что и всё остальное: клубы дыма и светящееся ядро.
 */
const drawMushroom = (
  debris: Graphics,
  glow: Graphics,
  x: number,
  y: number,
  seconds: number,
  cells: number,
  colors: BlastColors,
): void => {
  if (seconds < MUSHROOM_START) return;

  const age = seconds - MUSHROOM_START;
  const climb = Math.min(1, age / MUSHROOM_SECONDS);
  const top = cells * MUSHROOM_TOP_SHARE * (1 - (1 - climb) ** 2);
  const alpha = fade(seconds, 2.2, 4.6);
  if (alpha <= 0) return;

  /**
   * Ножка: столб дыма от земли к шляпке.
   *
   * Собран из тех же клубов, что и всё прочее, а не залит трапецией.
   * Трапеция здесь и стояла поначалу — и была видна на экране прямыми
   * рёбрами, то есть ровно тем, чего у дыма быть не может. Дым нигде
   * не имеет края, и получить это можно только наложением мягких пятен.
   */
  const STEM_PUFFS = 5;
  for (let step = 0; step < STEM_PUFFS; step += 1) {
    const along = step / (STEM_PUFFS - 1);
    const knot = screenAt(x, y, top * along);
    const width = cells * (0.2 - 0.09 * along) * PX_PER_CELL;

    debris.circle(knot.x, knot.y, width);
    debris.fill({ fill: smokeFill(colors.smoke), alpha: 0.42 * alpha });
  }

  /**
   * Шляпка: ряд перекрывающихся клубов на одной высоте.
   *
   * Приплюснутая, а не круглая, и в этом всё дело. Круглое облако наверху
   * столба читается воздушным шаром; шляпка гриба тем и узнаётся, что
   * шире, чем выше. Поэтому клубы разъезжаются вбок сильнее, чем растут.
   */
  const capRadius = cells * (0.09 + climb * 0.17) * PX_PER_CELL;
  const capSpread = cells * (0.07 + climb * 0.26) * PX_PER_CELL;

  const cap = screenAt(x, y, top);
  for (const offset of [-1, -0.55, 0, 0.55, 1]) {
    // Смещение экранное, а не мировое: шляпка обязана лечь поперёк взгляда,
    // а мировое смещение положило бы её вдоль одной из осей поля.
    debris.circle(
      cap.x + offset * capSpread,
      cap.y - Math.abs(offset) * capRadius * 0.25,
      capRadius * (1 - Math.abs(offset) * 0.25),
    );
    debris.fill({ fill: smokeFill(colors.smoke), alpha: 0.85 * alpha });
  }

  // Раскалённое нутро: гаснет вдвое быстрее самого дыма, и от этого гриб
  // на глазах остывает из огненного в серый.
  const heat = fade(seconds, 1.1, 3.2);
  if (heat <= 0) return;

  glow.circle(cap.x, cap.y, capRadius * 1.6);
  glow.fill({ fill: glowFill(colors.fire), alpha: 0.45 * heat });
  glow.circle(cap.x, cap.y, capRadius * 0.7);
  glow.fill({ fill: glowFill(colors.fire), alpha: 0.75 * heat });
};

/** Насколько сильно ядерный взрыв засвечивает экран в этот момент. */
const nukeFlash = (seconds: number): number =>
  // Мгновенный набор и долгое угасание: глаз именно так и слепнет.
  0.95 * rise(seconds, 0, 0.05) * Math.exp(-Math.max(0, seconds - 0.05) / 0.5);

/** Размах тряски в пикселях. */
const nukeShake = (seconds: number): number => {
  const amplitude = 26 * Math.exp(-seconds / 0.85);
  return amplitude < 0.2 ? 0 : amplitude;
};

/**
 * Смещение картинки при тряске, в пикселях.
 *
 * Колебание, а не случайное дрожание: у случайного нет направления,
 * и на экране оно читается помехой, а не ударом. Частоты по осям разные
 * и несоизмеримые — при равных или кратных картинка ходила бы
 * по замкнутой фигуре, и глаз опознал бы в ней узор.
 *
 * По вертикали размах меньше: экран шире, чем выше, и одинаковый размах
 * по обеим осям заметнее сверху и снизу.
 *
 * Живёт здесь, рядом с расчётом самого размаха, а не в сцене: сцена
 * прикладывает смещение, но не решает, какой оно формы.
 */
export const shakeOffset = (
  amplitude: number,
  time: number,
): { readonly x: number; readonly y: number } =>
  amplitude <= 0
    ? { x: 0, y: 0 }
    : {
        x: Math.round(Math.sin(time * 2.7) * amplitude),
        y: Math.round(Math.cos(time * 3.9) * amplitude * 0.7),
      };

/**
 * Ослабление засветки с удалением эпицентра от видимой области.
 *
 * Внутри экрана — в полную силу, дальше спадает. Без этого взрыв
 * на другом конце карты слепил бы игрока, который его даже не видит.
 */
const FLASH_FALLOFF_PX = 900;

const proximity = (anchor: Point, view: ViewBounds): number => {
  const outX = Math.max(view.minX - anchor.x, anchor.x - view.maxX, 0);
  const outY = Math.max(view.minY - anchor.y, anchor.y - view.maxY, 0);
  const outside = Math.hypot(outX, outY);

  return Math.max(0, 1 - outside / FLASH_FALLOFF_PX);
};

/**
 * Засветка всего экрана.
 *
 * Два слоя: ровная пелена по всему окну и яркое пятно в стороне эпицентра.
 * Одна пелена читается сменой яркости монитора, одно пятно — кругом
 * поверх картинки; вместе они читаются вспышкой.
 *
 * Пелена намеренно слабее пятна. Первая версия заливала окно почти
 * добела на добрую секунду, и ровно в эту секунду происходило всё
 * интересное: расходилась ударная волна, разлетались обломки. Ослепить
 * игрока — задача вспышки, но ослепить его так, чтобы он пропустил
 * собственный удар, — уже перебор.
 */
const drawScreenFlash = (
  flash: Graphics,
  intensity: number,
  centre: Point,
  viewport: Viewport,
  colors: BlastColors,
): void => {
  if (intensity <= 0.002) return;

  flash.rect(0, 0, viewport.width, viewport.height);
  flash.fill({ color: colors.core, alpha: 0.3 * intensity });

  const radius = Math.hypot(viewport.width, viewport.height) * 0.75;
  flash.circle(centre.x, centre.y, radius);
  flash.fill({ fill: glowFill(colors.core), alpha: 0.85 * intensity });
};

// ─────────────────────────────────────────────────────────────────────────
// Ракета
// ─────────────────────────────────────────────────────────────────────────

/**
 * Доля полёта, на которой ракета проходит вершину дуги.
 *
 * Не половина, хотя симметричная парабола честнее физически. Половина
 * отдала бы снижению полторы секунды из трёх, а обороняющийся читает
 * угрозу именно по снижающейся ракете: пока она идёт вверх, непонятно,
 * куда именно. Треть оставляет на снижение семьдесят процентов полёта.
 */
const MISSILE_APEX_SHARE = 0.3;

/**
 * Высота вершины дуги, в клетках.
 *
 * Ракета обязана уйти ЗА ВЕРХНЮЮ КРОМКУ ОКНА и вернуться из-за неё
 * над целью. Двадцать две клетки — это больше тысячи ста пикселей над
 * точкой на земле: выше половины окна даже на высоком мониторе, когда
 * та точка посреди экрана. Всё, что происходит выше, игрок не видит,
 * и туда-то и убран перелёт через карту.
 *
 * Мерить приходится окном, а не картой: «за кромкой» — свойство экрана,
 * и от дальности удара оно не зависит вовсе.
 */
const MISSILE_APEX_CELLS = 22;

/** Сколько звеньев в дымном следе от точки схода до ракеты. */
const TRAIL_STEPS = 16;

/** Какую долю полёта занимает горящий участок у сопла и сколько в нём звеньев. */
const BURN_SHARE = 0.05;
const BURN_STEPS = 4;

/** Насколько отступать вперёд и назад, определяя направление корпуса. */
const HEADING_STEP = 0.01;

export interface FlightPoint {
  readonly x: number;
  readonly y: number;
  /** Высота над землёй, в клетках. */
  readonly height: number;
}

/**
 * Положение ракеты в мире и её высота на заданной доле пути.
 *
 * Полёт распадается на три части, и средняя игроку не видна:
 * ракета уходит с площадки почти отвесно вверх, за кромкой окна
 * переносится через карту и отвесно же входит обратно в кадр над целью.
 *
 * Перенос убран наверх намеренно. Полёт вдоль земли пришлось бы смотреть
 * поперёк всей карты, а игрок в эти три секунды смотрит либо на свою
 * базу, либо на место удара. Обе части, которые он и правда видит, —
 * старт и падение, — так получают всё время, а не мелькают по краю кадра.
 *
 * Наружу вынесено по той же причине, что и выкладка частиц: экранная `y`
 * несёт и высоту, и положение на плоскости, поэтому «ракета поднялась»
 * по нарисованной точке не проверить — отлёт к северу двигает её
 * ровно так же.
 */
export const missileFlight = (
  launch: FlightPoint,
  targetX: number,
  targetY: number,
  progress: number,
): FlightPoint => {
  const clamped = Math.max(0, Math.min(1, progress));

  // Сглаживающая ступенька: скорость по горизонтали обнуляется на обоих
  // концах и наибольшая посередине. То есть у площадки и над целью
  // ракета идёт отвесно, а через карту переносится там, где не видна.
  //
  // Отвесность обычно и порицают — растущая на месте точка не сообщает
  // направления. Но здесь ракета не возникает над целью, а ВХОДИТ в кадр
  // сверху, ведя за собой след: направление сообщает появление, а не наклон.
  const share = clamped * clamped * (3 - 2 * clamped);

  return {
    x: launch.x + (targetX - launch.x) * share,
    y: launch.y + (targetY - launch.y) * share,
    height: arcHeight(launch.height, MISSILE_APEX_CELLS, clamped),
  };
};

const arcHeight = (launchHeight: number, apex: number, progress: number): number => {
  if (progress <= MISSILE_APEX_SHARE) {
    // Замедляющийся подъём: ракета уходит с направляющей рывком и теряет
    // скорость к вершине. Это тяготение, а не сглаживание ради вида.
    const climb = 1 - (1 - progress / MISSILE_APEX_SHARE) ** 2;

    return launchHeight + (apex - launchHeight) * climb;
  }

  // Квадрат, а не корень: ракета разгоняется к земле. Обратный порядок
  // дал бы торможение перед ударом, то есть посадку.
  const fall = (progress - MISSILE_APEX_SHARE) / (1 - MISSILE_APEX_SHARE);

  return apex * (1 - fall * fall);
};

/**
 * Откуда уходит ракета: срез пусковой установки на базе владельца.
 *
 * Точка привязки модели базы — УЗЕЛ СЕТКИ, то есть угол клетки базы,
 * а не её середина, поэтому местные координаты установки складываются
 * с клеткой напрямую, без привычных полклетки. Ровно так же считает
 * `baseBeaconPoint` для проблескового огня на мачте.
 *
 * Базы может не найтись только в отрыве от матча — в стенде или
 * на разобранной карте. Тогда ракета приходит по диагонали с северо-запада:
 * это не облик, а страховка от полёта нулевой длины.
 */
const launchPoint = (world: WorldState, nuke: NukeState, targetX: number, targetY: number): FlightPoint => {
  const baseCell = world.map.baseCells[nuke.owner];

  if (baseCell === undefined) {
    return {
      x: targetX - MISSILE_ORPHAN_SPAN,
      y: targetY - MISSILE_ORPHAN_SPAN,
      height: BASE_LAUNCH_POINT.z,
    };
  }

  return {
    x: cellX(baseCell) + BASE_LAUNCH_POINT.x,
    y: cellY(baseCell) + BASE_LAUNCH_POINT.y,
    height: BASE_LAUNCH_POINT.z,
  };
};

/** Откуда приходит ракета, если базы владельца на карте нет. */
const MISSILE_ORPHAN_SPAN = 10;

const drawMissile = (
  layers: BlastLayers,
  world: WorldState,
  nuke: NukeState,
  time: number,
  colors: BlastColors,
  localPlayer: PlayerId,
): void => {
  const targetX = cellX(nuke.cell) + 0.5;
  const targetY = cellY(nuke.cell) + 0.5;

  // Ракета уходит с пусковой установки своей базы, а не возникает в небе.
  // Точка схода отвечает на вопрос «чья ракета» без всякого цвета:
  // корпус в тринадцать пикселей цветом не читается.
  const launch = launchPoint(world, nuke, targetX, targetY);

  const progress = Math.max(0, Math.min(1, 1 - (nuke.detonateAtTick - time) / NUKE_DELAY_TICKS));
  const accent = nuke.owner === localPlayer ? colors.self : colors.enemy;

  /** Экранная точка на заданной доле пути. Доля прижимается внутри полёта. */
  const at = (share: number): Point => {
    const point = missileFlight(launch, targetX, targetY, share);

    return screenAt(point.x, point.y, point.height);
  };

  const here = missileFlight(launch, targetX, targetY, progress);
  const nose = screenAt(here.x, here.y, here.height);

  // След тянется от точки схода до самой ракеты, а не коротким хвостом
  // за ней. Это и есть главный носитель сообщения «выпущено отсюда»:
  // ракета мелкая, а след протянут через полкарты и упирается в площадку.
  //
  // Каждое звено обводится отдельно: у следа сужающаяся ширина и убывающая
  // заметность, а одной обводкой их не задать. Звеньев полтора десятка,
  // и ракета в матче одна — это не тот случай, где экономят вызовы.
  for (let step = 1; step <= TRAIL_STEPS; step += 1) {
    const near = at(progress * (1 - (step - 1) / TRAIL_STEPS));
    const far = at(progress * (1 - step / TRAIL_STEPS));
    const left = 1 - step / TRAIL_STEPS;

    layers.debris.moveTo(near.x, near.y).lineTo(far.x, far.y);
    layers.debris.stroke({ width: 3 + 9 * left, color: colors.smoke, alpha: 0.75 * left });
  }

  // Горящий участок у сопла. Задан долей полёта, а не номером звена:
  // след растягивается вместе с прогрессом, и факел, привязанный
  // к звену, к концу полёта растянулся бы на четверть карты.
  for (let step = 1; step <= BURN_STEPS; step += 1) {
    const near = at(progress - ((step - 1) * BURN_SHARE) / BURN_STEPS);
    const far = at(progress - (step * BURN_SHARE) / BURN_STEPS);
    const left = 1 - step / BURN_STEPS;

    layers.glow.moveTo(near.x, near.y).lineTo(far.x, far.y);
    layers.glow.stroke({ width: 2 + 5 * left, color: colors.fire, alpha: 0.5 * left });
  }

  // Отвес к земле прямо под ракетой. Высоту в этой проекции видно только
  // по нему: экранная `y` несёт и высоту, и положение на плоскости.
  // Место удара размечает не он, а кольца опасности и отсчёта в `overlays`.
  const below = screenAt(here.x, here.y, 0);
  layers.glow
    .moveTo(nose.x, nose.y)
    .lineTo(below.x, below.y)
    .stroke({ width: 1, color: accent, alpha: 0.3 });

  // Корпус: вытянутый ромб, повёрнутый по направлению полёта. Направление
  // берётся центральной разностью: односторонняя на самом старте давала бы
  // нулевую длину и схлопывала бы ромб в точку. Прежде это было незаметно —
  // на нулевой доле ракета висела за кромкой экрана, — а теперь видно.
  const ahead = at(progress + HEADING_STEP);
  const behind = at(progress - HEADING_STEP);
  const dx = ahead.x - behind.x;
  const dy = ahead.y - behind.y;
  const length = Math.hypot(dx, dy) || 1;
  const alongX = dx / length;
  const alongY = dy / length;

  const half = 5;
  const body = 13;
  const waist = { x: nose.x - alongX * body, y: nose.y - alongY * body };
  const tail = { x: nose.x - alongX * body * 2.2, y: nose.y - alongY * body * 2.2 };

  layers.debris
    .moveTo(nose.x, nose.y)
    .lineTo(waist.x - alongY * half, waist.y + alongX * half)
    .lineTo(tail.x, tail.y)
    .lineTo(waist.x + alongY * half, waist.y - alongX * half)
    .closePath();
  layers.debris.fill({ color: blend(colors.hullDark, accent, 0.35) });
  layers.debris.stroke({ width: 1.5, color: accent, alpha: 0.95 });

  // Факел двигателя: пульсирует, чтобы ракета не выглядела летящей палкой,
  // и разгорается к земле — двигатель работает на разгоне.
  const flare = (10 + 3 * Math.sin(time * 0.9)) * (0.7 + 0.5 * progress);
  layers.glow.circle(tail.x, tail.y, flare * 1.7);
  layers.glow.fill({ fill: glowFill(colors.fire), alpha: 0.5 });
  layers.glow.circle(tail.x, tail.y, flare);
  layers.glow.fill({ fill: glowFill(colors.fire), alpha: 0.9 });
  layers.glow.circle(tail.x, tail.y, flare * 0.4);
  layers.glow.fill({ fill: glowFill(colors.core), alpha: 0.9 });
};
