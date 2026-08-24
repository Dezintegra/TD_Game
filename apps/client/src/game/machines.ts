import { UnitType } from '@td/shared';
import type { Solid } from './armour.js';
import { GENERAL_ALTITUDE, GENERAL_PYLON_SIDE, clampTier } from './models.js';
import { box, column, roller, taper, tube, upright } from './solids.js';

/**
 * Машины: из чего они собраны.
 *
 * Прежние модели состояли из десятка коробок, и это было не решение,
 * а бюджет: геометрия строилась на каждом кадре, и каждая лишняя деталь
 * стоила трёх граней на каждой из двух сотен машин. Отсюда и ствол
 * квадратного сечения, и колесо-кубик, и башня без маски орудия —
 * не потому, что так задумано, а потому, что на большее не хватало кадра.
 *
 * Запекание этот бюджет отменяет: геометрия считается один раз
 * на комбинацию, а в кадре рисуется готовый спрайт. Поэтому машины
 * собраны заново и подробно — три десятка тел вместо десяти, круглые
 * стволы и катки вместо брусьев, маска орудия, командирская башенка,
 * решётка моторного отсека, крылья над колёсами, фары.
 *
 * ## Что осталось прежним
 *
 * Силуэты типов. Снайпер — длинная низкая машина с вынесенным далеко
 * вперёд стволом; Тесла — тяжёлая шестиколёсная с короткой толстой
 * мортирой; штурмовик — средний четырёхколёсный. Габариты, высота
 * корпуса и посадка башни взяты прежние до сотых: по ним игрок узнаёт
 * тип с одного взгляда, и менять их из-за отделки нельзя.
 *
 * Прокачка на модели тоже прежняя: атака удлиняет и утолщает ствол,
 * скорострельность добавляет стволов, верхняя ступень атаки даёт
 * дульный тормоз.
 *
 * ## Местные координаты
 *
 * `forward` — вдоль хода, к носу; `side` — вправо от хода; `up` — вверх
 * от земли. Всё в клетках. Мировых координат здесь нет вовсе: поворот
 * по румбу делает `armour.ts`, иначе каждую деталь пришлось бы задавать
 * восемь раз.
 *
 * ## Откуда берутся тела
 *
 * Конструкторы — `upright`, `column`, `roller`, `tube` — живут
 * в `solids.ts`. Раньше они лежали здесь, и это было верно ровно до тех
 * пор, пока на тех же телах не понадобилось собрать постройки: копия
 * выдавливания и поворота в двух файлах разошлась бы при первой же
 * правке освещения.
 */

/**
 * Чем красится деталь.
 *
 * Машина покрашена в графит, а не в цвет стороны. Цвет стороны живёт
 * на ней **маркерами** — полосами на палубе, фарами, линзой прицела,
 * кольцами разряда — и контровым светом по краю тела.
 *
 * Так техника и читается техникой: серая броня с опознавательными
 * знаками. Корпус, залитый цветом стороны, светится ровным пятном,
 * в котором тонут и швы, и стыки, и форма, — а ради формы всё
 * изменение и затевалось.
 */
export const Material = {
  /** Броневой лист: корпус, башня, крыло, палуба. */
  Hull: 0,
  /** Металл: ствол, ступица, оптика, катушка. Светлее плиты. */
  Gun: 1,
  /** Тень: колёса, решётки, выхлоп. Темнее поля. */
  Tread: 2,
  /** Маркер стороны. Только он и несёт цвет. */
  Neon: 3,
  /** Остекление: тёмное и холодное, живёт бликом. */
  Glass: 4,
} as const;

export type Material = (typeof Material)[keyof typeof Material];

/** Цвета материалов машины. Берутся из токенов, литералов здесь нет. */
export interface MachineColors {
  readonly plate: number;
  readonly metal: number;
  readonly shadow: number;
  readonly glass: number;
  /** Цвет стороны: им светятся маркеры и контровой свет. */
  readonly accent: number;
}

/** Палитра по номерам из `Material`. */
export const machinePalette = (colors: MachineColors): readonly number[] => [
  colors.plate,
  colors.metal,
  colors.shadow,
  colors.accent,
  colors.glass,
];

// ─────────────────────────────────────────────────────────────────────────
// Оружие
// ─────────────────────────────────────────────────────────────────────────

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

/**
 * Стволы.
 *
 * Две оси прокачки дают два независимых изменения модели: атака удлиняет
 * и утолщает ствол, скорострельность добавляет стволов.
 *
 * Кожух у казённой части — деталь, которой раньше не было и которая
 * теперь ничего не стоит. Нужна она не для красоты: тонкая труба
 * без утолщения у основания читается антенной, а не орудием.
 */
const barrels = (mount: Mount, attackTier: number, fireTier: number): Solid[] => {
  const attack = clampTier(attackTier);
  const fire = clampTier(fireTier);

  const length = mount.length * (ATTACK_LENGTH[attack] ?? 1);
  const calibre = mount.calibre * (ATTACK_CALIBRE[attack] ?? 1);
  const count = FIRE_BARRELS[fire] ?? 1;

  const solids: Solid[] = [];
  const spacing = calibre * 1.25;
  // Стволы расходятся от оси симметрично: при двух — по обе стороны,
  // при трёх — средний по оси.
  const first = -((count - 1) / 2) * spacing;

  for (let index = 0; index < count; index += 1) {
    const side = first + index * spacing;
    const from = mount.forward;
    const to = mount.forward + length;

    solids.push(
      tube(`ствол ${index + 1}`, from, to, side, mount.axis, calibre / 2, Material.Gun),
      tube(
        `кожух ${index + 1}`,
        from - calibre * 0.35,
        from + length * 0.26,
        side,
        mount.axis,
        calibre * 0.66,
        Material.Gun,
        12,
      ),
    );

    if (attack === 2) {
      solids.push(
        tube(
          `дульный тормоз ${index + 1}`,
          to - calibre * 1.1,
          to + calibre * 0.25,
          side,
          mount.axis,
          calibre * 0.95,
          Material.Gun,
          12,
        ),
      );
    }
  }

  return solids;
};

// ─────────────────────────────────────────────────────────────────────────
// Общие узлы шасси
// ─────────────────────────────────────────────────────────────────────────

/** Колесо: тёмный обод и светлая ступица, выступающая наружу. */
const wheel = (
  forward: number,
  side: number,
  up: number,
  radius: number,
  width: number,
): Solid[] => {
  const outer = side > 0 ? side + width / 2 : side - width / 2;

  return [
    roller('колесо', forward, side, up, radius, width, Material.Tread),
    roller('ступица', forward, outer, up, radius * 0.42, width * 0.3, Material.Gun, 12),
  ];
};

const wheelPair = (
  forward: number,
  offset: number,
  up: number,
  radius: number,
  width: number,
): Solid[] => [
  ...wheel(forward, offset, up, radius, width),
  ...wheel(forward, -offset, up, radius, width),
];

/**
 * Крыло над колесом.
 *
 * Бортового экрана, закрывающего колёса, здесь нет намеренно. Он был
 * пробован и снят: катки теперь круглые и читаются колёсами с шести
 * пикселей, а экран их закрывал — машина получала вместо колёс две
 * плоские плиты по бортам и от этого выглядела не тяжелее, а площе.
 */
const fenders = (forward: number, offset: number, length: number, top: number): Solid[] => {
  const parts: Solid[] = [];

  for (const side of [offset, -offset]) {
    parts.push(
      upright('крыло', box(forward, side, length, 0.03), top, 0.011, Material.Hull, {
        inset: 0.004,
        side: side > 0 ? -0.003 : 0.003,
      }),
    );
  }

  return parts;
};

/** Решётка моторного отсека: планки поперёк хода. */
const louvres = (
  forward: number,
  side: number,
  width: number,
  base: number,
  count: number,
): Solid[] => {
  const parts: Solid[] = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(
      upright(
        'планка решётки',
        box(forward - index * 0.032, side, 0.016, width),
        base,
        0.007,
        Material.Tread,
      ),
    );
  }

  return parts;
};

/**
 * Маркер стороны: тонкая неоновая полоса, положенная на горизонталь.
 *
 * Именно на горизонталь, а не на борт. Камера смотрит сверху под углом
 * тридцать пять градусов, и верхние поверхности видны у всех восьми
 * румбов, а борт — только у половины. Маркер, нанесённый на борт,
 * пропадал бы на каждом втором развороте, и принадлежность машины
 * приходилось бы угадывать.
 */
const marker = (forward: number, side: number, length: number, width: number, at: number): Solid =>
  upright('маркер', box(forward, side, length, width), at, 0.006, Material.Neon);

/** Пара маркеров по бортам: на крыльях над колёсами. */
const markerPair = (
  forward: number,
  offset: number,
  length: number,
  width: number,
  at: number,
): Solid[] => [
  marker(forward, offset, length, width, at),
  marker(forward, -offset, length, width, at),
];

/** Фары: две неоновые щели в лобовом листе. */
const lamps = (forward: number, offset: number, base: number): Solid[] => [
  upright('фара', box(forward, offset, 0.01, 0.024), base, 0.014, Material.Neon),
  upright('фара', box(forward, -offset, 0.01, 0.024), base, 0.014, Material.Neon),
];

// ─────────────────────────────────────────────────────────────────────────
// Три шасси
// ─────────────────────────────────────────────────────────────────────────

interface Chassis {
  readonly solids: readonly Solid[];
  readonly mount: Mount;
}

/**
 * Штурмовик: средний четырёхколёсный, ровный во всём, как и его
 * характеристики.
 */
const ASSAULT: Chassis = {
  solids: [
    upright('днище', box(0, 0, 0.44, 0.26), 0.056, 0.02, Material.Tread),
    ...wheelPair(0.155, 0.175, 0.085, 0.064, 0.05),
    ...wheelPair(-0.155, 0.175, 0.085, 0.064, 0.05),
    ...fenders(0, 0.183, 0.44, 0.146),
    // Корпус с развалом бортов: наклонная грань попадает по яркости
    // между отвесной и верхней, и борт перестаёт сливаться с бортом
    // соседней машины.
    upright('корпус', taper(-0.02, 0, 0.46, 0.26, 0.32), 0.072, 0.125, Material.Hull, {
      inset: 0.03,
    }),
    // Лобовой лист завален внутрь: верх сдвинут НАЗАД. Сдвинь мы его
    // вперёд — получился бы козырёк, а это облик грузовика, не брони.
    upright('лобовой лист', taper(0.235, 0, 0.13, 0.21, 0.27), 0.072, 0.105, Material.Hull, {
      inset: 0.012,
      forward: -0.05,
    }),
    upright('нижний лист', taper(0.285, 0, 0.07, 0.17, 0.21), 0.058, 0.05, Material.Hull, {
      forward: 0.018,
    }),
    upright('палуба', box(-0.06, 0, 0.34, 0.28), 0.197, 0.012, Material.Hull, { inset: 0.012 }),
    ...louvres(-0.13, 0, 0.19, 0.209, 3),
    upright('ящик ЗИП', box(-0.165, 0.1, 0.1, 0.058), 0.209, 0.03, Material.Tread, {
      inset: 0.006,
    }),
    tube('выхлоп', -0.235, -0.11, -0.152, 0.222, 0.012, Material.Tread, 10),
    // Башня коническая: она стои́т вплотную к палубе и одного с ней
    // цвета, и отличает их только форма.
    upright('башня', taper(-0.045, 0, 0.2, 0.18, 0.215), 0.209, 0.085, Material.Hull, {
      inset: 0.035,
    }),
    // Маска орудия — то, чего у башни не было. Без неё ствол торчит
    // из ровной стенки, и башня читается ящиком со штырём.
    upright('маска орудия', taper(0.078, 0, 0.07, 0.105, 0.15), 0.216, 0.066, Material.Hull, {
      inset: 0.008,
    }),
    column('командирская башенка', -0.105, 0.045, 0.294, 0.034, 0.024, Material.Hull, 12),
    column('люк', -0.105, 0.045, 0.318, 0.028, 0.006, Material.Gun, 12),
    upright('оптика', box(0.028, -0.07, 0.036, 0.028), 0.292, 0.022, Material.Gun),
    upright('линза', box(0.048, -0.07, 0.005, 0.018), 0.297, 0.012, Material.Neon),
    upright('антенна', box(-0.125, -0.08, 0.008, 0.008), 0.294, 0.085, Material.Gun, {
      inset: 0.002,
    }),
    ...lamps(0.305, 0.085, 0.112),
    ...markerPair(0.02, 0.183, 0.3, 0.028, 0.157),
    marker(-0.112, 0, 0.075, 0.13, 0.294),
    marker(0.058, 0, 0.05, 0.2, 0.209),
    ...markerPair(-0.215, 0.075, 0.04, 0.075, 0.209),
  ],
  // Срез ствола вынесен за нос корпуса: орудие, не достающее до лба,
  // читается не орудием, а трубой на крыше.
  mount: { forward: 0.05, axis: 0.25, length: 0.34, calibre: 0.038 },
};

/**
 * Снайпер: длинная низкая машина с вынесенным далеко вперёд стволом
 * и мачтой прицела над кормовой башней.
 */
const SNIPER: Chassis = {
  solids: [
    upright('днище', box(0, 0, 0.48, 0.2), 0.046, 0.018, Material.Tread),
    ...wheelPair(0.2, 0.155, 0.072, 0.054, 0.042),
    ...wheelPair(-0.2, 0.155, 0.072, 0.054, 0.042),
    ...fenders(0, 0.162, 0.48, 0.128),
    upright('корпус', taper(-0.04, 0, 0.52, 0.19, 0.26), 0.06, 0.095, Material.Hull, {
      inset: 0.026,
    }),
    // Самый сильный завал носа из трёх машин: острый скошенный нос —
    // то, по чему снайпера узнают раньше, чем разглядят длину ствола.
    upright('носовой клин', taper(0.3, 0, 0.16, 0.1, 0.19), 0.06, 0.055, Material.Hull, {
      inset: 0.012,
      forward: -0.028,
    }),
    upright('палуба', box(-0.1, 0, 0.28, 0.22), 0.155, 0.01, Material.Hull, { inset: 0.01 }),
    ...louvres(0.11, 0, 0.15, 0.155, 3),
    upright('башня', taper(-0.12, 0, 0.17, 0.14, 0.175), 0.165, 0.07, Material.Hull, {
      inset: 0.03,
    }),
    upright('маска орудия', taper(-0.035, 0, 0.06, 0.075, 0.11), 0.172, 0.056, Material.Hull, {
      inset: 0.006,
    }),
    // Мачта прицела. У снайпера она вместо командирской башенки: высокая
    // тонкая стойка над кормой — второй после ствола признак типа.
    upright('стойка прицела', box(-0.185, 0, 0.022, 0.03), 0.235, 0.05, Material.Gun, {
      inset: 0.004,
    }),
    upright('блок прицела', box(-0.185, 0, 0.05, 0.052), 0.285, 0.028, Material.Gun, {
      inset: 0.008,
    }),
    upright('линза прицела', box(-0.162, 0, 0.005, 0.03), 0.291, 0.016, Material.Neon),
    tube('выхлоп', -0.24, -0.14, -0.14, 0.19, 0.01, Material.Tread, 10),
    ...lamps(0.362, 0.055, 0.086),
    ...markerPair(-0.02, 0.162, 0.34, 0.026, 0.139),
    marker(0.16, 0, 0.055, 0.16, 0.165),
    marker(-0.185, 0, 0.055, 0.1, 0.285),
    ...markerPair(-0.222, 0.065, 0.035, 0.06, 0.165),
  ],
  // Ствол вынесен далеко вперёд и тонок: дальность снайпера должна
  // читаться с поля раньше, чем игрок наведёт на него курсор.
  mount: { forward: -0.04, axis: 0.2, length: 0.52, calibre: 0.03 },
};

/**
 * Тесла: тяжёлая шестиколёсная с отвалом и короткой толстой мортирой
 * между двумя катушками.
 */
const TESLA: Chassis = {
  solids: [
    upright('днище', box(0, 0, 0.46, 0.34), 0.062, 0.024, Material.Tread),
    ...wheelPair(0.19, 0.225, 0.096, 0.074, 0.058),
    ...wheelPair(0, 0.225, 0.096, 0.074, 0.058),
    ...wheelPair(-0.19, 0.225, 0.096, 0.074, 0.058),
    ...fenders(0, 0.233, 0.46, 0.172),
    upright('корпус', taper(-0.02, 0, 0.48, 0.34, 0.4), 0.082, 0.15, Material.Hull, {
      inset: 0.038,
    }),
    // Отвал завален назад сильно и почти не сужается: это широкий щит,
    // а не клин. По нему тяжёлая машина узнаётся прежде, чем сосчитаны
    // колёса.
    upright('отвал', taper(0.27, 0, 0.12, 0.3, 0.34), 0.082, 0.062, Material.Hull, {
      inset: 0.01,
      forward: -0.03,
    }),
    upright('зуб отвала', box(0.316, 0, 0.024, 0.03), 0.078, 0.016, Material.Gun),
    upright('зуб отвала', box(0.316, 0.09, 0.024, 0.03), 0.078, 0.016, Material.Gun),
    upright('зуб отвала', box(0.316, -0.09, 0.024, 0.03), 0.078, 0.016, Material.Gun),
    upright('палуба', box(-0.05, 0, 0.36, 0.36), 0.232, 0.012, Material.Hull, { inset: 0.014 }),
    ...louvres(-0.14, 0, 0.26, 0.244, 4),
    upright('башня', taper(-0.05, 0, 0.25, 0.24, 0.28), 0.244, 0.11, Material.Hull, {
      inset: 0.05,
    }),
    upright('маска мортиры', taper(0.085, 0, 0.06, 0.13, 0.17), 0.256, 0.08, Material.Hull, {
      inset: 0.008,
    }),
    // Катушки: две стойки по бортам башни со светящимся кольцом наверху.
    // Оружие Теслы — разряд, и на модели он обязан быть виден до выстрела.
    column('катушка', -0.115, 0.095, 0.354, 0.026, 0.05, Material.Gun, 12),
    column('катушка', -0.115, -0.095, 0.354, 0.026, 0.05, Material.Gun, 12),
    column('кольцо разряда', -0.115, 0.095, 0.404, 0.034, 0.008, Material.Neon, 12),
    column('кольцо разряда', -0.115, -0.095, 0.404, 0.034, 0.008, Material.Neon, 12),
    tube('выхлоп', -0.26, -0.13, -0.19, 0.246, 0.014, Material.Tread, 10),
    tube('выхлоп', -0.26, -0.13, 0.19, 0.246, 0.014, Material.Tread, 10),
    ...lamps(0.325, 0.115, 0.13),
    ...markerPair(0, 0.233, 0.34, 0.03, 0.183),
    marker(0.268, 0, 0.05, 0.26, 0.144),
    marker(0.075, 0, 0.055, 0.26, 0.244),
    ...markerPair(-0.205, 0.1, 0.045, 0.09, 0.244),
  ],
  // Мортира короткая и толстая — противоположность снайперскому стволу.
  mount: { forward: 0.06, axis: 0.3, length: 0.28, calibre: 0.066 },
};

const CHASSIS: Readonly<Record<UnitType, Chassis>> = {
  [UnitType.Assault]: ASSAULT,
  [UnitType.Sniper]: SNIPER,
  [UnitType.Tesla]: TESLA,
};

/** Тела боевой машины: шасси и стволы по ступеням прокачки. */
export const unitSolids = (
  unitType: UnitType,
  attackTier: number,
  fireTier: number,
): readonly Solid[] => {
  const chassis = CHASSIS[unitType] ?? ASSAULT;

  return [...chassis.solids, ...barrels(chassis.mount, attackTier, fireTier)];
};

// ─────────────────────────────────────────────────────────────────────────
// Машина генерала
// ─────────────────────────────────────────────────────────────────────────

const PYLON_INNER_SIDE = 0.07;
const PYLON_OUTER_SIDE = GENERAL_PYLON_SIDE;

const pylon = (side: number): Solid => {
  const sign = side > 0 ? 1 : -1;

  return {
    label: 'пилон',
    bottom: [
      { forward: 0.07, side: sign * PYLON_INNER_SIDE, up: GENERAL_ALTITUDE + 0.045 },
      { forward: -0.03, side: sign * PYLON_INNER_SIDE, up: GENERAL_ALTITUDE + 0.045 },
      { forward: -0.025, side: sign * PYLON_OUTER_SIDE, up: GENERAL_ALTITUDE + 0.045 },
      { forward: 0.045, side: sign * PYLON_OUTER_SIDE, up: GENERAL_ALTITUDE + 0.045 },
    ],
    top: [
      { forward: 0.064, side: sign * (PYLON_INNER_SIDE + 0.004), up: GENERAL_ALTITUDE + 0.069 },
      { forward: -0.026, side: sign * (PYLON_INNER_SIDE + 0.004), up: GENERAL_ALTITUDE + 0.069 },
      { forward: -0.022, side: sign * (PYLON_OUTER_SIDE - 0.004), up: GENERAL_ALTITUDE + 0.069 },
      { forward: 0.04, side: sign * (PYLON_OUTER_SIDE - 0.004), up: GENERAL_ALTITUDE + 0.069 },
    ],
    material: Material.Hull,
  };
};

/**
 * Машина генерала — ударный вертолёт, а не самолёт.
 *
 * Разница здесь не в украшении, а в обещании. Самолёт обещает скорость
 * и пролёт мимо; генерал же висит над полем, ждёт, строит вокруг себя
 * и отходит. Висение обещает винтокрылая машина.
 *
 * Пропорции сняты с Ка-50 и пересчитаны в доли длины корпуса. На сорока
 * пикселях силуэт узнаётся не деталями, а отношением длин: длинная
 * тонкая хвостовая балка при коротком широком корпусе. Ошибись в этом
 * отношении вдвое, и вертолёт снова станет самолётом, сколько деталей
 * на него ни навесь.
 *
 * Верхнего винта нет намеренно: неподвижный читается поломкой, а
 * вращающийся требует пересчёта на каждом кадре, то есть выхода
 * за запечённый спрайт. Подъём дают два боковых хувера.
 */
const gunshipSolids = (): readonly Solid[] => {
  const base = GENERAL_ALTITUDE;

  return [
    // Хвостовая балка теперь труба, а не брус: у вертолёта она круглая,
    // и на восьми пикселях разница между трубой и брусом видна сразу.
    tube('хвостовая балка', -0.45, -0.09, 0, base + 0.068, 0.026, Material.Hull, 12),
    upright('киль', taper(-0.415, 0, 0.11, 0.02, 0.028), base + 0.075, 0.125, Material.Hull, {
      inset: 0.004,
      forward: -0.028,
    }),
    upright('стабилизатор', box(-0.38, 0, 0.07, 0.19), base + 0.052, 0.018, Material.Hull, {
      inset: 0.005,
    }),
    roller('рулевой винт', -0.452, 0.028, base + 0.14, 0.046, 0.01, Material.Tread, 12),
    column('втулка винта', -0.452, 0.028, base + 0.132, 0.012, 0.016, Material.Gun, 10),
    upright('кабина', taper(0.1, 0, 0.34, 0.13, 0.17), base, 0.125, Material.Hull, {
      inset: 0.024,
    }),
    // Опущенный нос перед высокой кабиной — та поза, по которой ударную
    // машину отличают от транспортной.
    upright('носовая часть', taper(0.35, 0, 0.18, 0.03, 0.13), base + 0.015, 0.062, Material.Hull, {
      inset: 0.012,
      forward: -0.02,
    }),
    // Единственное остекление на поле: у него резкий блик, и взгляд
    // цепляется за него первым — потому оно и стои́т там, где перёд.
    upright('фонарь кабины', taper(0.19, 0, 0.17, 0.05, 0.1), base + 0.125, 0.052, Material.Glass, {
      inset: 0.018,
      forward: -0.014,
    }),
    column('носовая турель', 0.35, 0, base - 0.012, 0.026, 0.028, Material.Gun, 12),
    tube('стволик турели', 0.35, 0.44, 0, base + 0.002, 0.008, Material.Gun, 10),
    pylon(PYLON_OUTER_SIDE),
    pylon(-PYLON_OUTER_SIDE),
    upright('блок НУРС', box(0.03, 0.16, 0.11, 0.05), base + 0.03, 0.038, Material.Gun, {
      inset: 0.006,
    }),
    upright('блок НУРС', box(0.03, -0.16, 0.11, 0.05), base + 0.03, 0.038, Material.Gun, {
      inset: 0.006,
    }),
    // Хувер: борт отвесный, без стягивания — стянутый кверху цилиндр
    // читается стаканом, а хувер обязан читаться кольцом.
    column('хувер', 0.01, 0.265, base + 0.022, 0.085, 0.055, Material.Hull, 16),
    column('хувер', 0.01, -0.265, base + 0.022, 0.085, 0.055, Material.Hull, 16),
    column('свечение хувера', 0.01, 0.265, base + 0.077, 0.05, 0.007, Material.Neon, 16),
    column('свечение хувера', 0.01, -0.265, base + 0.077, 0.05, 0.007, Material.Neon, 16),
    marker(0.02, 0.142, 0.085, 0.05, base + 0.069),
    marker(0.02, -0.142, 0.085, 0.05, base + 0.069),
    marker(-0.29, 0, 0.13, 0.03, base + 0.094),
    marker(-0.38, 0, 0.05, 0.17, base + 0.07),
    marker(0.08, 0, 0.06, 0.11, base + 0.125),
  ];
};

export const generalSolids = (): readonly Solid[] => gunshipSolids();
