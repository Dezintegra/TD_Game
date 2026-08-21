import {
  DIRECTION_COUNT,
  DIRECTION_SCALE,
  DIRECTION_SOUTH,
  DIRECTION_VECTORS,
  UNIT_TYPES,
  UnitType,
} from '@td/shared';
import { blend, shade, solidFaces } from './prism.js';
import type { FootprintPoint } from './prism.js';
import type { Point } from './iso.js';

/**
 * Модели техники.
 *
 * На поле стоит командный центр из шести объёмов, а рядом ездят коробки —
 * так было до этого модуля. Юниты собираются здесь из тех же объёмных тел,
 * что скалы и постройки: корпус, колёса, башня, ствол; у генерала —
 * фюзеляж, крыло, киль.
 *
 * Три вещи объясняют устройство модуля.
 *
 * ПЕРВОЕ: детали описаны в местных координатах машины — «вперёд по ходу»
 * и «вправо от хода», — а не в координатах мира. Иначе каждую деталь
 * пришлось бы задавать восемь раз, по разу на румб.
 *
 * ВТОРОЕ: готовая экранная геометрия кешируется. Проекция аффинна,
 * а камера неподвижна, поэтому силуэт машины зависит от типа, румба
 * и оружия, но НЕ от того, где машина стоит: две одинаковые машины
 * в разных концах карты дают на экране один и тот же набор
 * многоугольников, сдвинутый на разность их положений. Значит, силуэт
 * можно построить один раз, а на кадре только складывать координаты.
 * Без этого десяток деталей на четырёхстах юнитах съел бы кадр целиком.
 *
 * ТРЕТЬЕ: заливки склеиваются по цвету — там, где это законно.
 *
 * Соблазн велик собрать все грани одного оттенка со всей машины в один
 * вызов, как это сделано у скал. Со скалами так можно: клетки одной
 * диагонали друг друга не перекрывают, и порядок внутри диагонали
 * безразличен. С деталями одной машины так нельзя: башня перекрывает
 * корпус, ближнее колесо перекрывает борт, и стоит собрать грани
 * по цвету — перекрытие рассыплется.
 *
 * Поэтому склейка только у соседних по глубине граней одного цвета,
 * и срабатывает она нечасто: у каждой детали три грани трёх разных
 * яркостей. Выигрыш даёт не она, а предпосчёт геометрии.
 */

// ─────────────────────────────────────────────────────────────────────────
// Из чего собирается модель
// ─────────────────────────────────────────────────────────────────────────

/**
 * Точка в местных координатах машины, в клетках.
 *
 * `forward` — вдоль хода, положительное значение к носу.
 * `side` — поперёк, положительное значение вправо от хода.
 */
interface LocalPoint {
  readonly forward: number;
  readonly side: number;
}

/**
 * Чем красится деталь.
 *
 * Оттенки выводятся из цвета стороны, а не задаются литералами: цвет
 * на поле означает принадлежность, и модель обязана его нести. Сплошной
 * неон при этом выжигает детали, поэтому корпус — тёмная основа
 * с примесью цвета стороны, и чем мельче деталь, тем примеси больше.
 */
const Material = {
  /** Корпус, крыло, башня. */
  Hull: 0,
  /** Ствол, кабина, сопло: светлее корпуса, иначе мелкая деталь пропадает. */
  Gun: 1,
  /** Колёса и прочее, что должно уходить в тень. */
  Tread: 2,
  /** Чистый неон стороны. Только для самых мелких деталей. */
  Neon: 3,
} as const;

type Material = (typeof Material)[keyof typeof Material];

interface Part {
  readonly label: string;
  /** Основание детали в местных координатах, обход по контуру. */
  readonly shape: readonly LocalPoint[];
  /** Уровень, на котором стоит основание, в клетках. */
  readonly base: number;
  readonly height: number;
  readonly material: Material;
  /** Нести ли неоновую окантовку по рёбрам. */
  readonly outline?: boolean;
}

/** Прямоугольная деталь: центр, длина вдоль хода, ширина поперёк. */
const box = (forward: number, side: number, length: number, width: number): LocalPoint[] => {
  const halfLength = length / 2;
  const halfWidth = width / 2;

  return [
    { forward: forward + halfLength, side: side + halfWidth },
    { forward: forward + halfLength, side: side - halfWidth },
    { forward: forward - halfLength, side: side - halfWidth },
    { forward: forward - halfLength, side: side + halfWidth },
  ];
};

/**
 * Трапеция: ширина спереди и сзади разная.
 *
 * Прямоугольником не выразить ни скошенный нос, ни стреловидное крыло,
 * а именно они отличают технику от коробки.
 */
const taper = (
  forward: number,
  side: number,
  length: number,
  frontWidth: number,
  backWidth: number,
): LocalPoint[] => {
  const halfLength = length / 2;

  return [
    { forward: forward + halfLength, side: side + frontWidth / 2 },
    { forward: forward + halfLength, side: side - frontWidth / 2 },
    { forward: forward - halfLength, side: side - backWidth / 2 },
    { forward: forward - halfLength, side: side + backWidth / 2 },
  ];
};

// ─────────────────────────────────────────────────────────────────────────
// Оружие
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ступеней прокачки на модели три, а уровней в ветке сколько угодно,
 * поэтому нужны пороги.
 *
 * Первый порог — единица: первая же покупка обязана быть видна на поле,
 * иначе связь «купил — изменилось» не устанавливается и прокачка остаётся
 * числом в панели. Второй порог отодвинут дальше: верхняя ступень должна
 * оставаться заметным событием.
 */
const TIER_THRESHOLDS = [1, 5] as const;

/** Ступень модели по уровню ветки прокачки. */
export const weaponTier = (level: number): number => {
  let tier = 0;
  for (const threshold of TIER_THRESHOLDS) {
    if (level >= threshold) tier += 1;
  }
  return tier;
};

export const TIER_COUNT = TIER_THRESHOLDS.length + 1;

/** Насколько ступень атаки удлиняет и утолщает ствол. */
const ATTACK_LENGTH = [1, 1.25, 1.5] as const;
const ATTACK_CALIBRE = [1, 1.2, 1.45] as const;

/** Сколько стволов даёт ступень скорострельности. */
const FIRE_BARRELS = [1, 2, 3] as const;

interface Mount {
  /** Откуда ствол выходит: смещение вперёд от центра машины. */
  readonly forward: number;
  /** Высота оси ствола над землёй. */
  readonly axis: number;
  readonly length: number;
  readonly calibre: number;
}

const clampTier = (tier: number): number => (tier < 0 ? 0 : tier > 2 ? 2 : Math.floor(tier));

/**
 * Стволы.
 *
 * Две оси прокачки дают два независимых изменения модели: атака удлиняет
 * и утолщает ствол, скорострельность добавляет стволов. Так они и заданы
 * в референсном паке, и так же они устроены у нас в ветках прокачки.
 *
 * Дульный тормоз на верхней ступени атаки — единственная деталь, которая
 * появляется, а не меняет размер. Нужен потому, что разницу между длиной
 * ×1,3 и ×1,62 глазом не поймать, а появление насадки на срезе видно сразу.
 */
const barrels = (mount: Mount, attackTier: number, fireTier: number): Part[] => {
  const attack = clampTier(attackTier);
  const fire = clampTier(fireTier);

  const length = mount.length * (ATTACK_LENGTH[attack] ?? 1);
  const calibre = mount.calibre * (ATTACK_CALIBRE[attack] ?? 1);
  const count = FIRE_BARRELS[fire] ?? 1;

  const parts: Part[] = [];
  const spacing = calibre * 1.15;
  // Стволы расходятся от оси симметрично: при двух — по обе стороны,
  // при трёх — средний по оси.
  const first = -((count - 1) / 2) * spacing;

  for (let index = 0; index < count; index += 1) {
    const side = first + index * spacing;

    parts.push({
      label: `ствол ${index + 1}`,
      shape: box(mount.forward + length / 2, side, length, calibre),
      base: mount.axis,
      height: calibre,
      material: Material.Gun,
    });

    if (attack === 2) {
      parts.push({
        label: `дульный тормоз ${index + 1}`,
        shape: box(mount.forward + length - calibre * 0.5, side, calibre * 1.6, calibre * 1.9),
        base: mount.axis - calibre * 0.2,
        height: calibre * 1.4,
        material: Material.Gun,
      });
    }
  }

  return parts;
};

// ─────────────────────────────────────────────────────────────────────────
// Шасси
// ─────────────────────────────────────────────────────────────────────────

/** Колесо. Тёмное и утопленное в борт: на экране это деталь в шесть пикселей. */
const wheel = (forward: number, side: number, radius: number, width: number): Part => ({
  label: 'колесо',
  shape: box(forward, side, radius * 2, width),
  base: 0,
  height: radius * 1.7,
  material: Material.Tread,
});

const wheelPair = (forward: number, offset: number, radius: number, width: number): Part[] => [
  wheel(forward, offset, radius, width),
  wheel(forward, -offset, radius, width),
];

interface Chassis {
  readonly parts: readonly Part[];
  readonly mount: Mount;
}

/**
 * Три шасси.
 *
 * Различаются силуэтом, а не размером. Разница в размере на объекте
 * в сорок пикселей не читается — прежние три коробки отличались друг
 * от друга на несколько пикселей и выглядели одинаковыми. Читается другое:
 * число колёс, пропорции корпуса, длина ствола.
 *
 * Роль каждого типа видна из его вида: снайпер — длинная низкая машина
 * с вынесенным далеко вперёд стволом; гранатомётчик — тяжёлый
 * шестиколёсный с короткой толстой мортирой; штурмовик — средний
 * четырёхколёсный, ровный во всём, как и его характеристики.
 */
const CHASSIS: Readonly<Record<UnitType, Chassis>> = {
  [UnitType.Assault]: {
    parts: [
      ...wheelPair(0.155, 0.185, 0.062, 0.055),
      ...wheelPair(-0.155, 0.185, 0.062, 0.055),
      {
        label: 'корпус',
        shape: taper(-0.02, 0, 0.46, 0.26, 0.32),
        base: 0.072,
        height: 0.125,
        material: Material.Hull,
        outline: true,
      },
      {
        label: 'моторный отсек',
        shape: taper(0.26, 0, 0.16, 0.19, 0.26),
        base: 0.072,
        height: 0.075,
        material: Material.Hull,
        outline: true,
      },
      {
        label: 'башня',
        shape: box(-0.05, 0, 0.19, 0.21),
        base: 0.197,
        height: 0.09,
        material: Material.Hull,
        outline: true,
      },
    ],
    // Срез ствола вынесен за нос корпуса. Орудие, не достающее до капота,
    // читается не орудием, а трубой на крыше.
    mount: { forward: 0.05, axis: 0.225, length: 0.34, calibre: 0.036 },
  },

  [UnitType.Sniper]: {
    parts: [
      ...wheelPair(0.2, 0.155, 0.05, 0.045),
      ...wheelPair(-0.2, 0.155, 0.05, 0.045),
      {
        label: 'корпус',
        shape: taper(-0.04, 0, 0.52, 0.19, 0.26),
        base: 0.06,
        height: 0.095,
        material: Material.Hull,
        outline: true,
      },
      {
        label: 'носовой клин',
        shape: taper(0.3, 0, 0.16, 0.1, 0.19),
        base: 0.06,
        height: 0.055,
        material: Material.Hull,
        outline: true,
      },
      {
        label: 'башня',
        shape: box(-0.12, 0, 0.16, 0.17),
        base: 0.155,
        height: 0.07,
        material: Material.Hull,
        outline: true,
      },
    ],
    // Ствол вынесен далеко вперёд и тонок: дальность снайпера должна
    // читаться с поля раньше, чем игрок наведёт на него курсор.
    mount: { forward: -0.04, axis: 0.175, length: 0.52, calibre: 0.028 },
  },

  [UnitType.Grenadier]: {
    parts: [
      ...wheelPair(0.19, 0.225, 0.07, 0.062),
      ...wheelPair(0, 0.225, 0.07, 0.062),
      ...wheelPair(-0.19, 0.225, 0.07, 0.062),
      {
        label: 'корпус',
        shape: taper(-0.02, 0, 0.48, 0.34, 0.4),
        base: 0.082,
        height: 0.15,
        material: Material.Hull,
        outline: true,
      },
      {
        label: 'отвал',
        shape: taper(0.27, 0, 0.12, 0.3, 0.34),
        base: 0.082,
        height: 0.06,
        material: Material.Hull,
        outline: true,
      },
      {
        label: 'башня',
        shape: box(-0.05, 0, 0.25, 0.27),
        base: 0.232,
        height: 0.115,
        material: Material.Hull,
        outline: true,
      },
    ],
    // Мортира короткая и толстая — противоположность снайперскому стволу.
    // Короткая относительно своего калибра: за отвал она всё же выходит.
    mount: { forward: 0.06, axis: 0.28, length: 0.28, calibre: 0.062 },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Парение над полем
// ─────────────────────────────────────────────────────────────────────────

/**
 * Высота, на которой висит боевая машина, в клетках.
 *
 * Поле — слабое зеркало, и машина, лежащая на нём вплотную, отражения
 * не даёт: её отражение начиналось бы прямо от линии касания и читалось бы
 * не отражением, а удвоенным вниз силуэтом. Отражение делает отражением
 * разрыв, и вот этот разрыв здесь и задан.
 *
 * Восемь сотых клетки — около четырёх пикселей при высоте модели
 * примерно в пятнадцать. Разрыв виден, но машина ещё не висит в воздухе:
 * она именно парит над поверхностью, а не летит над ней.
 *
 * На правила высота не влияет ничем: в состоянии мира её нет вовсе,
 * юнит по-прежнему занимает свою клетку и упирается в скалу.
 */
export const UNIT_ALTITUDE = 0.08;

/** Размах покачивания, в клетках. Около полутора пикселей. */
const BOB_AMPLITUDE = 0.03;

/** Период покачивания, в тиках. Две с половиной секунды. */
const BOB_PERIOD_TICKS = 72;

/**
 * Разброс фаз между соседними номерами, в тиках.
 *
 * Взаимно просто с периодом, поэтому соседние номера расходятся по фазе
 * далеко и не сходятся обратно. Строй, качающийся в такт, читается
 * не парением, а ошибкой синхронизации: живые вещи не дышат в ногу.
 */
const BOB_PHASE_STRIDE_TICKS = 29;

const TWO_PI = Math.PI * 2;

/**
 * Покачивание парящей машины, в клетках. Может быть отрицательным.
 *
 * Время берётся из номера тика, а не из часов: всё остальное на поле
 * движется с частотой тика, и покачивание по собственным часам разъехалось
 * бы с движением при первой просадке кадров. Фаза берётся из номера
 * сущности — он уже уникален и уже лежит в состоянии мира.
 *
 * Величина считается на кадре, а не кладётся в кеш силуэтов: кеш общий
 * для всех машин одной комбинации, и величине, зависящей от конкретной
 * машины, в нём места нет.
 */
export const hoverBob = (seed: number, tick: number): number =>
  BOB_AMPLITUDE * Math.sin((TWO_PI * (tick + seed * BOB_PHASE_STRIDE_TICKS)) / BOB_PERIOD_TICKS);

// ─────────────────────────────────────────────────────────────────────────
// Истребитель генерала
// ─────────────────────────────────────────────────────────────────────────

/**
 * Высота, на которой идёт машина генерала.
 *
 * Генерал обязан опознаваться среди сотни юнитов мгновенно. Раньше это
 * делал вертикальный шпиль, потом — то, что он единственный на поле
 * не касается земли. Теперь над полем парят все, и признаком стала
 * величина отрыва: генерал идёт вшестеро выше юнита, и его отражение
 * уходит дальше всех. Признак от этого не ослаб, а усилился — разрыв
 * виден рядом с чужими разрывами, а сравнение нагляднее одиночного
 * присутствия.
 *
 * Полклетки, а не больше: выше — и машина отрывается от собственной тени
 * настолько, что перестаёт быть понятно, где она стоит, а вокруг её клетки
 * считается радиус строительства.
 */
export const GENERAL_ALTITUDE = 0.5;

const JET_PARTS: readonly Part[] = [
  {
    label: 'левое крыло',
    shape: [
      { forward: 0.02, side: -0.06 },
      { forward: -0.24, side: -0.44 },
      { forward: -0.34, side: -0.42 },
      { forward: -0.16, side: -0.06 },
    ],
    base: GENERAL_ALTITUDE + 0.02,
    height: 0.028,
    material: Material.Hull,
    outline: true,
  },
  {
    label: 'правое крыло',
    shape: [
      { forward: 0.02, side: 0.06 },
      { forward: -0.16, side: 0.06 },
      { forward: -0.34, side: 0.42 },
      { forward: -0.24, side: 0.44 },
    ],
    base: GENERAL_ALTITUDE + 0.02,
    height: 0.028,
    material: Material.Hull,
    outline: true,
  },
  {
    label: 'фюзеляж',
    shape: taper(-0.02, 0, 0.5, 0.11, 0.14),
    base: GENERAL_ALTITUDE,
    height: 0.1,
    material: Material.Hull,
    outline: true,
  },
  {
    label: 'носовой обтекатель',
    shape: taper(0.35, 0, 0.24, 0.02, 0.11),
    base: GENERAL_ALTITUDE + 0.012,
    height: 0.07,
    material: Material.Hull,
    outline: true,
  },
  {
    label: 'фонарь кабины',
    shape: taper(0.13, 0, 0.16, 0.05, 0.09),
    base: GENERAL_ALTITUDE + 0.1,
    height: 0.045,
    material: Material.Gun,
    outline: true,
  },
  {
    label: 'левый стабилизатор',
    shape: taper(-0.28, -0.12, 0.14, 0.03, 0.12),
    base: GENERAL_ALTITUDE + 0.02,
    height: 0.025,
    material: Material.Hull,
  },
  {
    label: 'правый стабилизатор',
    shape: taper(-0.28, 0.12, 0.14, 0.03, 0.12),
    base: GENERAL_ALTITUDE + 0.02,
    height: 0.025,
    material: Material.Hull,
  },
  {
    label: 'киль',
    shape: taper(-0.22, 0, 0.16, 0.022, 0.032),
    base: GENERAL_ALTITUDE + 0.1,
    height: 0.17,
    material: Material.Hull,
    outline: true,
  },
  {
    label: 'сопло',
    shape: box(-0.29, 0, 0.07, 0.1),
    base: GENERAL_ALTITUDE + 0.018,
    height: 0.07,
    material: Material.Neon,
  },
];

/**
 * Тень истребителя.
 *
 * Не украшение: объект, оторванный от земли, теряет привязку к клетке,
 * а вокруг клетки генерала считается радиус строительства — игрок обязан
 * видеть, где генерал стоит. Тень эту привязку возвращает.
 *
 * Отражение эту обязанность не снимает и заменить тень не может.
 * Отражение объекта, поднятого на высоту, лежит на той же глубине под
 * поверхностью — так устроено плоское зеркало, — и у генерала с его
 * полклетки оно целиком уходит ниже его клетки. Клетку оно отмечает
 * приблизительно, тень — точно.
 *
 * Рисуется плоским телом нулевой высоты, то есть одной верхней гранью.
 */
const SHADOW_PARTS: readonly Part[] = [
  {
    label: 'тень фюзеляжа',
    shape: taper(-0.02, 0, 0.62, 0.08, 0.1),
    base: 0,
    height: 0,
    material: Material.Tread,
  },
  {
    label: 'тень крыла',
    shape: taper(-0.16, 0, 0.26, 0.5, 0.7),
    base: 0,
    height: 0,
    material: Material.Tread,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Сборка силуэта
// ─────────────────────────────────────────────────────────────────────────

/** Группа граней одного цвета, залитых одним вызовом. */
export interface FillRun {
  readonly color: number;
  readonly polygons: readonly (readonly Point[])[];
}

export interface Silhouette {
  /** Заливки в порядке от дальних граней к ближним. */
  readonly fills: readonly FillRun[];
  /** Контуры под неоновую обводку. */
  readonly outline: readonly (readonly Point[])[];
  /** Высота модели в клетках. По ней ставится полоса здоровья. */
  readonly height: number;
}

/** Цвета, из которых выводятся все оттенки модели. */
export interface ModelColors {
  readonly self: number;
  readonly enemy: number;
  readonly hullDark: number;
  /**
   * Цвет поверхности поля. Нужен отражениям: они не полупрозрачные,
   * а подмешанные к цвету поля. Почему именно так — ниже, у `mirrorOf`.
   */
  readonly ground: number;
}

/** Своя сторона и чужая. Индекс входит в ключ кеша. */
export const SIDE_SELF = 0;
export const SIDE_ENEMY = 1;
const SIDE_COUNT = 2;

/**
 * Оттенки материалов для одной стороны.
 *
 * Доля цвета стороны растёт от корпуса к мелким деталям: крупный объект
 * в чистом неоне светится ровным пятном, в котором тонут грани, а мелкая
 * деталь в тёмном корпусе просто пропадает.
 */
const materialColors = (colors: ModelColors, side: number): readonly number[] => {
  const accent = side === SIDE_ENEMY ? colors.enemy : colors.self;

  return [
    blend(colors.hullDark, accent, 0.42),
    blend(colors.hullDark, accent, 0.66),
    blend(colors.hullDark, accent, 0.1),
    accent,
  ];
};

/** Ход «на юг» — запасной на случай, если румб окажется неизвестным. */
const SOUTHWARD = { x: 0, y: DIRECTION_SCALE };

/** Перевод местной точки машины в мировую относительно её центра. */
const toWorld = (local: LocalPoint, facing: number): FootprintPoint => {
  const vector = DIRECTION_VECTORS[facing] ?? SOUTHWARD;
  const forwardX = vector.x / DIRECTION_SCALE;
  const forwardY = vector.y / DIRECTION_SCALE;

  // «Вправо от хода» — поворот вектора хода на прямой угол. Ось Y смотрит
  // на юг, поэтому вправо от «на восток» оказывается юг, как и должно быть.
  return {
    x: local.forward * forwardX - local.side * forwardY,
    y: local.forward * forwardY + local.side * forwardX,
  };
};

interface PlacedPart {
  readonly part: Part;
  readonly footprint: readonly FootprintPoint[];
  /** Удалённость от зрителя: сумма мировых координат центра детали. */
  readonly depth: number;
}

/**
 * Сборка силуэта.
 *
 * Порядок деталей внутри модели считается здесь, а не задаётся руками
 * в таблице: достаточно поправить одно смещение, и ручной порядок сломался
 * бы молча. Правило то же, что для всего поля: чем больше сумма координат
 * центра, тем ближе деталь к зрителю и тем позже её надо рисовать.
 * Детали на одном месте разводятся по высоте — башня поверх корпуса.
 */
const buildSilhouette = (
  parts: readonly Part[],
  facing: number,
  colors: ModelColors,
  side: number,
): Silhouette => {
  const palette = materialColors(colors, side);

  const placed: PlacedPart[] = parts.map((part) => {
    const footprint = part.shape.map((point) => toWorld(point, facing));

    let sum = 0;
    for (const point of footprint) sum += point.x + point.y;

    return { part, footprint, depth: footprint.length === 0 ? 0 : sum / footprint.length };
  });

  placed.sort((a, b) => a.depth - b.depth || a.part.base - b.part.base);

  const fills: { color: number; polygons: (readonly Point[])[] }[] = [];
  const outline: (readonly Point[])[] = [];
  let height = 0;

  const emit = (color: number, points: readonly Point[]): void => {
    // Склейка с предыдущей заливкой того же цвета. Дальше соседней
    // заглядывать нельзя: перестановка граней ломает перекрытие деталей.
    const last = fills[fills.length - 1];
    if (last !== undefined && last.color === color) {
      last.polygons.push(points);
      return;
    }

    fills.push({ color, polygons: [points] });
  };

  for (const { part, footprint } of placed) {
    const faces = solidFaces(footprint, part.height, part.base);
    const base = palette[part.material] ?? palette[0] ?? 0;

    for (const face of faces.sides) emit(shade(base, face.light), face.points);
    emit(shade(base, faces.top.light), faces.top.points);

    if (part.outline === true) {
      for (const face of faces.sides) outline.push(face.points);
      outline.push(faces.top.points);
    }

    const top = part.base + part.height;
    if (top > height) height = top;
  }

  return { fills, outline, height };
};

// ─────────────────────────────────────────────────────────────────────────
// Отражение в поверхности
// ─────────────────────────────────────────────────────────────────────────

/**
 * Насколько отражение сплюснуто по высоте.
 *
 * Зеркало мы видим под острым углом, и отражение в полную длину читалось бы
 * не отражением, а второй машиной, стоящей вниз головой.
 */
export const MIRROR_SQUASH = 0.5;

/**
 * Какая доля цвета грани доживает до отражения.
 *
 * Зеркало слабое, и это требование, а не осторожность: на поле помещается
 * две сотни машин, и отражение, спорящее с телом за внимание, превратило бы
 * строй в кашу. Меньше пятой доли — уже пятно, больше четверти — уже
 * вторая машина.
 */
const MIRROR_STRENGTH = 0.22;

/**
 * Детали, опрокинутые под поверхность.
 *
 * Отражение строится из деталей заново, а не переворачиванием готовой
 * экранной геометрии, и вот почему. В нашей проекции экранная `y` несёт
 * сразу две вещи: высоту над землёй и положение на плоскости. Точка
 * северного крыла имеет отрицательную `y` не потому, что она высоко,
 * а потому, что она далеко на север. Опрокинь мы `y` целиком —
 * отражение уехало бы вбок от машины и перекосилось.
 *
 * Опрокидывать надо только высоту. Деталь, стоявшая от `base`
 * до `base + height`, уходит под поверхность на ту же глубину:
 * ближайшая к поверхности грань отражения соответствует нижней грани
 * детали. Опора остаётся на месте — и отражение остаётся под машиной.
 *
 * Отсюда же берётся верный порядок отрисовки. Детали сортируются
 * по удалённости, а при равной удалённости — по высоте опоры. У опрокинутых
 * деталей порядок по высоте переворачивается сам: башня, лежавшая
 * на корпусе, в отражении оказывается глубже него и рисуется раньше.
 * Именно так и выглядит отражение.
 *
 * Окантовки у отражения нет: неоновая линия сделала бы из него второй
 * объект, а это изображение объекта.
 */
const mirroredParts = (parts: readonly Part[]): Part[] =>
  parts.map((part) => ({
    ...part,
    base: -(part.base + part.height) * MIRROR_SQUASH,
    height: part.height * MIRROR_SQUASH,
    outline: false,
  }));

/**
 * Приглушение отражения цветом поверхности.
 *
 * Отражение непрозрачное, и это не небрежность. Полупрозрачность
 * выглядела бы честнее, но модель собрана из десятка тел, и тела
 * перекрывают друг друга — башня лежит на корпусе, ближнее колесо
 * на борту. Прозрачные заливки в этих местах складываются, и отражение
 * покрывается пятнами там, где у машины просто стык деталей. Отдельный
 * слой с общей прозрачностью не помогает: PixiJS умножает прозрачность
 * объекта в цвета вершин при пакетной отрисовке, то есть она попадает
 * в каждую заливку по отдельности.
 *
 * Обойтись без прозрачности получается потому, что цвет поверхности
 * известен заранее и одинаков по всей карте: земля рисуется линиями,
 * заливок у неё нет. Подмешивание к цвету поля даёт тот же результат,
 * что дала бы прозрачность, и стоит одного смешивания цветов
 * при построении кеша.
 *
 * Затенение граней при этом сохраняется: верхняя грань в отражении
 * светлее боковой, как и у машины. Ровно это отличает отражение
 * от пятна и не стоит ничего.
 */
const dimmedToGround = (silhouette: Silhouette, ground: number): Silhouette => ({
  fills: silhouette.fills.map((run) => ({
    color: blend(ground, run.color, MIRROR_STRENGTH),
    polygons: run.polygons,
  })),
  outline: [],
  // Высота отражения бессмысленна: над ним ничего не ставится.
  height: 0,
});

const buildReflection = (
  parts: readonly Part[],
  facing: number,
  colors: ModelColors,
  side: number,
): Silhouette =>
  dimmedToGround(buildSilhouette(mirroredParts(parts), facing, colors, side), colors.ground);

// ─────────────────────────────────────────────────────────────────────────
// Кеш
// ─────────────────────────────────────────────────────────────────────────

/**
 * Кеш силуэтов.
 *
 * Ключ — целое число, собранное из типа, румба, двух ступеней оружия
 * и стороны. Строкового ключа здесь быть не должно: обращение идёт
 * на каждый юнит каждый кадр, а это сотни склеек строк в секунду
 * на ровном месте.
 *
 * Комбинаций 486, и все они разом не встречаются никогда: кеш ленивый.
 */
const UNIT_CACHE_SIZE = UNIT_TYPES.length * DIRECTION_COUNT * TIER_COUNT * TIER_COUNT * SIDE_COUNT;

const unitCache: (Silhouette | undefined)[] = new Array<Silhouette | undefined>(UNIT_CACHE_SIZE);
const generalCache: (Silhouette | undefined)[] = new Array<Silhouette | undefined>(
  DIRECTION_COUNT * SIDE_COUNT,
);
const shadowCache: (Silhouette | undefined)[] = new Array<Silhouette | undefined>(DIRECTION_COUNT);

/**
 * Кеши отражений. Ключи те же самые: отражение однозначно выводится
 * из силуэта, а значит, зависит ровно от того же.
 */
const unitMirrorCache: (Silhouette | undefined)[] = new Array<Silhouette | undefined>(
  UNIT_CACHE_SIZE,
);
const generalMirrorCache: (Silhouette | undefined)[] = new Array<Silhouette | undefined>(
  DIRECTION_COUNT * SIDE_COUNT,
);

/**
 * Палитра, для которой построен кеш.
 *
 * Цвета читаются из CSS один раз при запуске, и объект палитры живёт
 * столько же, сколько сцена, поэтому сравнения по ссылке достаточно.
 * Пришла другая палитра — кеш строится заново; в матче этого не бывает,
 * а тестам удобно.
 */
let cachedColors: ModelColors | undefined;

const ensurePalette = (colors: ModelColors): void => {
  if (cachedColors === colors) return;

  cachedColors = colors;
  unitCache.fill(undefined);
  generalCache.fill(undefined);
  shadowCache.fill(undefined);
  unitMirrorCache.fill(undefined);
  generalMirrorCache.fill(undefined);
};

const normaliseFacing = (facing: number): number =>
  Number.isInteger(facing) && facing > 0 && facing < DIRECTION_COUNT ? facing : DIRECTION_SOUTH;

/** Детали машины: шасси и стволы по ступеням прокачки. */
const unitParts = (unitType: UnitType, attackTier: number, fireTier: number): readonly Part[] => {
  const chassis = CHASSIS[unitType];
  return [...chassis.parts, ...barrels(chassis.mount, attackTier, fireTier)];
};

/** Номер записи в кеше юнитов. Один на силуэт и его отражение. */
const unitCacheIndex = (
  unitType: UnitType,
  facing: number,
  attackTier: number,
  fireTier: number,
  side: number,
): number =>
  (((unitType * DIRECTION_COUNT + normaliseFacing(facing)) * TIER_COUNT + clampTier(attackTier)) *
    TIER_COUNT +
    clampTier(fireTier)) *
    SIDE_COUNT +
  side;

/** Силуэт боевой машины. Одинаковые запросы возвращают одну и ту же запись. */
export const unitSilhouette = (
  colors: ModelColors,
  side: number,
  unitType: UnitType,
  facing: number,
  attackTier: number,
  fireTier: number,
): Silhouette => {
  ensurePalette(colors);

  const rumb = normaliseFacing(facing);
  const attack = clampTier(attackTier);
  const fire = clampTier(fireTier);
  const index = unitCacheIndex(unitType, rumb, attack, fire, side);

  const cached = unitCache[index];
  if (cached !== undefined) return cached;

  const built = buildSilhouette(unitParts(unitType, attack, fire), rumb, colors, side);

  unitCache[index] = built;
  return built;
};

/** Силуэт истребителя генерала. */
export const generalSilhouette = (
  colors: ModelColors,
  side: number,
  facing: number,
): Silhouette => {
  ensurePalette(colors);

  const rumb = normaliseFacing(facing);
  const index = rumb * SIDE_COUNT + side;

  const cached = generalCache[index];
  if (cached !== undefined) return cached;

  const built = buildSilhouette(JET_PARTS, rumb, colors, side);
  generalCache[index] = built;
  return built;
};

/**
 * Тень истребителя. От стороны не зависит: тень у всех одна и та же,
 * и красить её в цвет игрока значило бы соврать про источник света.
 */
export const generalShadow = (colors: ModelColors, facing: number): Silhouette => {
  ensurePalette(colors);

  const rumb = normaliseFacing(facing);

  const cached = shadowCache[rumb];
  if (cached !== undefined) return cached;

  const built = buildSilhouette(SHADOW_PARTS, rumb, colors, SIDE_SELF);
  shadowCache[rumb] = built;
  return built;
};

/** Отражение боевой машины в поверхности поля. */
export const unitReflection = (
  colors: ModelColors,
  side: number,
  unitType: UnitType,
  facing: number,
  attackTier: number,
  fireTier: number,
): Silhouette => {
  ensurePalette(colors);

  const index = unitCacheIndex(unitType, facing, attackTier, fireTier, side);

  const cached = unitMirrorCache[index];
  if (cached !== undefined) return cached;

  const built = buildReflection(
    unitParts(unitType, clampTier(attackTier), clampTier(fireTier)),
    normaliseFacing(facing),
    colors,
    side,
  );

  unitMirrorCache[index] = built;
  return built;
};

/** Отражение истребителя генерала. */
export const generalReflection = (
  colors: ModelColors,
  side: number,
  facing: number,
): Silhouette => {
  ensurePalette(colors);

  const index = normaliseFacing(facing) * SIDE_COUNT + side;

  const cached = generalMirrorCache[index];
  if (cached !== undefined) return cached;

  const built = buildReflection(JET_PARTS, normaliseFacing(facing), colors, side);
  generalMirrorCache[index] = built;
  return built;
};

/**
 * Высота модели юнита в клетках — для полосы здоровья.
 *
 * Считается через силуэт, а не отдельной таблицей: две таблицы разъехались
 * бы при первой же правке модели, и полоса здоровья повисла бы в воздухе.
 */
export const unitModelHeight = (
  colors: ModelColors,
  unitType: UnitType,
  attackTier: number,
  fireTier: number,
): number =>
  unitSilhouette(colors, SIDE_SELF, unitType, DIRECTION_SOUTH, attackTier, fireTier).height;

/** Только для тестов: сбросить кеш и заставить строить силуэты заново. */
export const resetModelCache = (): void => {
  cachedColors = undefined;
  unitCache.fill(undefined);
  generalCache.fill(undefined);
  shadowCache.fill(undefined);
  unitMirrorCache.fill(undefined);
  generalMirrorCache.fill(undefined);
};
