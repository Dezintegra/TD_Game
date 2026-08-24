import { DIRECTION_SOUTH, StructureKind } from '@td/shared';
import type { Solid, Vec3 } from './armour.js';
import type { Plan } from './solids.js';
import { angles, box, column, roller, slab, taper, tube, upright } from './solids.js';

/**
 * Постройки: из чего они собраны.
 *
 * Прежние модели строились в `Graphics` на каждом кадре, и это был
 * не выбор облика, а бюджет. Отсюда ствол квадратного сечения (выдавить
 * вбок было нечем), отсутствие маски орудия, заливка грани одним цветом
 * и неоновая обводка по рёбрам — тёмный корпус на тёмной земле иначе
 * не был виден.
 *
 * Запекание этот бюджет отменяет. Тела здесь те же, что у машин
 * (`solids.ts`), свет считается в каждой точке, у грани есть кромка,
 * у ствола — круглое сечение, у стыков — затенение. Обводки нет:
 * её работу взял контровой свет.
 *
 * ## Что осталось прежним до сотых
 *
 * Все отметки высот и все радиусы башен. По силуэту игрок узнаёт вид,
 * а из дульного среза выходит выстрел (`MUZZLE_HEIGHT` в `towers.ts`,
 * `shots.ts`): сдвиг ради красивой детали — это правка правил,
 * замаскированная под отделку.
 *
 * Стена — единственное исключение, и меняется она по существу задачи:
 * из отдельной плиты в клетке она стала звеном сплошной линии.
 *
 * ## Местные координаты и разворот
 *
 * `forward` — вдоль ствола, к дульному срезу; `side` — вправо от ствола;
 * `up` — вверх от земли. Всё в клетках.
 *
 * Запекается модель **всегда на юг**, а разворот турели делается здесь,
 * поворотом местных координат. Так и должно быть: `bakeArmour` поворачивает
 * весь набор тел разом, а у постройки поворачивается только турель —
 * постамент стоит по клетке, потому что границы клетки игрок читает
 * именно по постройке. Отдай поворот запеканию — восьмигранный постамент
 * на диагональных румбах развернулся бы на 45°, и вершины оказались бы
 * там, где были плоские грани.
 *
 * Углы берутся точными: `Math.cos(Math.PI / 4)`, а не вектором румба
 * из `direction.ts`. Тот записан как (707, 707) при масштабе 1000,
 * то есть короче единицы на полторы сотых процента. Положению это
 * безразлично, а нормали от такого поворота перестают быть единичными —
 * грабли уже оплачены машинами.
 */

// ─────────────────────────────────────────────────────────────────────────
// Материалы
// ─────────────────────────────────────────────────────────────────────────

/**
 * Чем красится деталь.
 *
 * Номера — те же пять веществ, что у машин: `armour.ts` хранит по номеру
 * блеск, силу блика и самосвечение, и таблицы эти общие. Меняется только
 * палитра: там, где у машины резина, у постройки бетон. Совпадение
 * не натяжка — у резины блик почти отсутствует, и у бетона тоже.
 * Вещество одно и то же, матовое; различает их цвет.
 */
export const StructureMaterial = {
  /** Броневой лист: корпус, турель, тело стены. */
  Hull: 0,
  /** Сталь: ствол, кромка, погон, хомут, заклёпка. */
  Steel: 1,
  /** Бетон: постамент башни, фундамент стены. Матовый. */
  Concrete: 2,
  /** Маркер стороны. Только он и несёт цвет. */
  Neon: 3,
  /** Остекление: линза прицела и оптики. Живёт бликом. */
  Glass: 4,
} as const;

export type StructureMaterial = (typeof StructureMaterial)[keyof typeof StructureMaterial];

/** Цвета материалов постройки. Берутся из токенов, литералов здесь нет. */
export interface StructureColors {
  readonly plate: number;
  readonly steel: number;
  readonly concrete: number;
  readonly glass: number;
  /** Цвет стороны: им светятся маркеры и контровой свет. */
  readonly accent: number;
}

/** Палитра по номерам из `StructureMaterial`. */
export const structurePalette = (colors: StructureColors): readonly number[] => [
  colors.plate,
  colors.steel,
  colors.concrete,
  colors.accent,
  colors.glass,
];

// ─────────────────────────────────────────────────────────────────────────
// Поворот местных координат
// ─────────────────────────────────────────────────────────────────────────

/** Правильный многоугольник в плане. Плоские грани приходятся на оси. */
const polygon = (radius: number, corners: number, forward = 0, side = 0): Plan[] =>
  angles(corners).map((angle) => ({
    forward: forward + Math.cos(angle) * radius,
    side: side + Math.sin(angle) * radius,
  }));

/** Расстояние от центра до середины грани правильного многоугольника. */
const apothem = (radius: number, corners: number): number => radius * Math.cos(Math.PI / corners);

const spinPoint = (point: Vec3, cos: number, sin: number): Vec3 => ({
  forward: point.forward * cos - point.side * sin,
  side: point.forward * sin + point.side * cos,
  up: point.up,
});

/**
 * Поворот набора тел вокруг вертикальной оси, в румбах.
 *
 * Румб — восьмая часть оборота. Поворачиваются только те тела, которые
 * обязаны следовать за целью; неподвижные сюда не попадают вовсе.
 */
const spin = (solids: readonly Solid[], rumbs: number): readonly Solid[] => {
  if (rumbs === 0) return solids;

  const angle = (rumbs * Math.PI) / 4;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return solids.map((solid) => ({
    ...solid,
    bottom: solid.bottom.map((point) => spinPoint(point, cos, sin)),
    top: solid.top.map((point) => spinPoint(point, cos, sin)),
  }));
};

/**
 * Подросшая не до конца постройка: все высоты умножены на долю.
 *
 * Умножается именно высота, а не размер целиком: стройка растёт вверх,
 * а пятно она занимает своё с первого тика — клетка непроходима сразу
 * (`apply.ts`), и модель обязана это показывать.
 */
const grow = (solids: readonly Solid[], lift: number): readonly Solid[] => {
  if (lift >= 1) return solids;

  const raise = (point: Vec3): Vec3 => ({ ...point, up: point.up * lift });

  return solids.map((solid) => ({
    ...solid,
    bottom: solid.bottom.map(raise),
    top: solid.top.map(raise),
  }));
};

// ─────────────────────────────────────────────────────────────────────────
// Заготовки отделки
// ─────────────────────────────────────────────────────────────────────────

/**
 * Кольцо заклёпок по верху детали.
 *
 * Мелочь размером в пиксель-два, и именно она отличает бронеплиту
 * от закрашенного многоугольника: глаз не считает заклёпки, он видит,
 * что поверхность не пуста. Раньше они были плоскими наклейками
 * на грани; теперь это тела, и у каждой есть своя кромка и свой блик.
 */
const rivetRing = (radius: number, at: number, count: number): Solid[] => {
  const parts: Solid[] = [];

  for (let index = 0; index < count; index += 1) {
    const angle = ((index + 0.5) * (Math.PI * 2)) / count;
    parts.push(
      column(
        'заклёпка',
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        at,
        0.014,
        0.009,
        StructureMaterial.Steel,
        8,
      ),
    );
  }

  return parts;
};

/**
 * Вентиляционные щели на грани восьмигранного корпуса.
 *
 * Светятся: это единственный способ показать, что внутри постройки
 * что-то работает. Заодно они несут цвет стороны — корпус остаётся
 * графитовым, а принадлежность читается по светящимся деталям.
 *
 * Кладутся на грань, обращённую к зрителю, и это законно ровно потому,
 * что корпус не поворачивается: у машины маркер на борту пропадал бы
 * на каждом втором развороте, у постройки борт всегда один и тот же.
 */
const vents = (
  radius: number,
  corners: number,
  from: number,
  gap: number,
  count: number,
): Solid[] => {
  const reach = apothem(radius, corners);
  const parts: Solid[] = [];

  for (let index = 0; index < count; index += 1) {
    const level = from + index * gap;

    // Южная грань: в нашей проекции она обращена к зрителю слева-снизу.
    parts.push(
      slab(
        'щель',
        {
          forward: reach,
          side: 0,
          length: 0.016,
          width: radius * 0.62,
          base: level,
          height: gap * 0.32,
        },
        StructureMaterial.Neon,
      ),
    );

    // Восточная грань: она обращена к зрителю справа-снизу. Обе видны
    // всегда, потому что камера смотрит на угол клетки, а не на грань.
    parts.push(
      slab(
        'щель',
        {
          forward: 0,
          side: -reach,
          length: radius * 0.62,
          width: 0.016,
          base: level,
          height: gap * 0.32,
        },
        StructureMaterial.Neon,
      ),
    );
  }

  return parts;
};

// ─────────────────────────────────────────────────────────────────────────
// Базовая башня
// ─────────────────────────────────────────────────────────────────────────

/**
 * Базовая башня: приземистая и широкая — противоположность снайперской.
 *
 * Все отметки взяты из прежней модели без изменений: постамент 0,44,
 * корпус 0,30, погон на 0,625, турель до 0,775, ось стволов на 0,7025.
 * Прибавилось то, что прежде было невыразимо: круглые стволы с кожухами,
 * маска орудия, кольцо погона, линза прицела.
 */
const BASIC_FIXED: readonly Solid[] = [
  upright('постамент', polygon(0.44, 8), 0, 0.1, StructureMaterial.Concrete, { inset: 0.028 }),
  upright('цоколь', polygon(0.36, 8), 0.1, 0.09, StructureMaterial.Hull, { inset: 0.018 }),
  ...rivetRing(0.315, 0.19, 8),
  upright('корпус', polygon(0.3, 8), 0.19, 0.31, StructureMaterial.Hull, { inset: 0.022 }),
  ...vents(0.3, 8, 0.235, 0.055, 3),
  upright('поясок', polygon(0.33, 8), 0.36, 0.025, StructureMaterial.Steel),
  upright('оголовок', polygon(0.29, 8), 0.5, 0.09, StructureMaterial.Hull, { inset: 0.016 }),
  column('погон', 0, 0, 0.59, 0.25, 0.035, StructureMaterial.Steel, 16),
];

/**
 * Ось стволов базовой башни.
 *
 * Она же `MUZZLE_HEIGHT`: выстрел обязан выходить из ствола, а не рядом
 * с ним. Прежде это были два числа — коробка ствола стояла на 0,675
 * высотой 0,055, то есть ось приходилась на 0,7025, а таблица дульных
 * срезов говорила 0,7. Расхождение в две с половиной тысячных клетки
 * не видел никто, но два числа вместо одного — это приглашение
 * к расхождению побольше.
 */
const BASIC_AXIS = 0.7;

const BASIC_TURRET: readonly Solid[] = [
  upright('турель', box(-0.04, 0, 0.34, 0.32), 0.625, 0.15, StructureMaterial.Hull, {
    inset: 0.024,
    forward: 0.012,
  }),
  // Маска орудия: цилиндр с осью поперёк ствола. Без неё ствол растёт
  // прямо из плиты, и башня читается коробкой с палкой.
  roller('маска орудия', 0.15, 0, BASIC_AXIS, 0.082, 0.26, StructureMaterial.Hull, 12),
  upright('щит', taper(0.2, 0, 0.1, 0.19, 0.3), 0.625, 0.175, StructureMaterial.Hull, {
    inset: 0.012,
  }),
  upright('ящик ЗИП', box(-0.16, 0.2, 0.18, 0.09), 0.66, 0.08, StructureMaterial.Steel),
  // Маркер стороны лежит на крыше турели — на горизонтали, видимой
  // при любом развороте.
  //
  // Полосой, а не пятном. Первая проба клала на крышу плиту 0,16 × 0,21
  // при крыше 0,29 × 0,27, то есть половину её площади: башня читалась
  // коробкой с наклейкой, и всё, ради чего затевалось изменение —
  // кромки, швы, скос, — тонуло в ровном свечении. Ровно эта ошибка
  // уже разобрана у машин: сплошной неон на крупном теле показывает
  // только сам себя.
  slab(
    'маркер',
    { forward: -0.09, side: 0, length: 0.05, width: 0.25, base: 0.775, height: 0.007 },
    StructureMaterial.Neon,
  ),
  upright('прицел', box(0.05, -0.14, 0.09, 0.05), 0.775, 0.035, StructureMaterial.Hull),
  slab(
    'линза',
    { forward: 0.096, side: -0.14, length: 0.012, width: 0.036, base: 0.783, height: 0.022 },
    StructureMaterial.Glass,
  ),
];

/** Стволы базовой башни: два круглых, с кожухами и дульными тормозами. */
const basicBarrels = (): Solid[] => {
  const parts: Solid[] = [];

  for (const side of [-0.075, 0.075]) {
    parts.push(
      tube('ствол', 0.17, 0.53, side, BASIC_AXIS, 0.0275, StructureMaterial.Steel, 12),
      tube('кожух', 0.14, 0.27, side, BASIC_AXIS, 0.042, StructureMaterial.Steel, 12),
      tube('дульный тормоз', 0.46, 0.54, side, BASIC_AXIS, 0.05, StructureMaterial.Steel, 12),
    );
  }

  return parts;
};

// ─────────────────────────────────────────────────────────────────────────
// Снайперская башня
// ─────────────────────────────────────────────────────────────────────────

/**
 * Снайперская башня: высокая и узкая.
 *
 * Её дальность должна читаться с поля раньше, чем игрок наведёт на неё
 * курсор, поэтому силуэт — пилон с хомутами и длинный тонкий ствол.
 *
 * Решётчатой фермы у пилона нет намеренно. Соблазн взять приём мачты
 * командного центра силён, но там ферма нарисована **линиями**
 * постоянной толщины поверх меша, а `bakeArmour` линий не умеет. Пояс
 * фермы телом — это 0,02 клетки, то есть полпикселя: после сглаживания
 * от него остаётся серое пятно. Ту же работу делают каннелюры — рёбра
 * вдоль пилона: они шириной в три пикселя и читаются конструкцией.
 */
const SNIPER_FLUTE_TOP = 0.9;

const sniperFlutes = (): Solid[] => {
  const reach = apothem(0.17, 8);
  const parts: Solid[] = [];

  // Четыре ребра по осям. Два из них зритель видит всегда, два прячутся
  // за пилоном — но стоят они ничего, а без них силуэт с тыла обеднел бы
  // на обломках, которые остаются от разрушенной башни.
  parts.push(
    slab(
      'каннелюра',
      {
        forward: reach,
        side: 0,
        length: 0.014,
        width: 0.05,
        base: 0.22,
        height: SNIPER_FLUTE_TOP - 0.22,
      },
      StructureMaterial.Hull,
    ),
    slab(
      'каннелюра',
      {
        forward: -reach,
        side: 0,
        length: 0.014,
        width: 0.05,
        base: 0.22,
        height: SNIPER_FLUTE_TOP - 0.22,
      },
      StructureMaterial.Hull,
    ),
    slab(
      'каннелюра',
      {
        forward: 0,
        side: reach,
        length: 0.05,
        width: 0.014,
        base: 0.22,
        height: SNIPER_FLUTE_TOP - 0.22,
      },
      StructureMaterial.Hull,
    ),
    slab(
      'каннелюра',
      {
        forward: 0,
        side: -reach,
        length: 0.05,
        width: 0.014,
        base: 0.22,
        height: SNIPER_FLUTE_TOP - 0.22,
      },
      StructureMaterial.Hull,
    ),
  );

  return parts;
};

const SNIPER_FIXED: readonly Solid[] = [
  upright('постамент', polygon(0.42, 8), 0, 0.09, StructureMaterial.Concrete, { inset: 0.026 }),
  upright('опора', polygon(0.3, 8), 0.09, 0.11, StructureMaterial.Hull, { inset: 0.02 }),
  ...rivetRing(0.255, 0.2, 8),
  upright('пилон', polygon(0.17, 8), 0.2, 0.72, StructureMaterial.Hull, { inset: 0.014 }),
  ...sniperFlutes(),
  ...vents(0.17, 8, 0.3, 0.05, 3),
  ...vents(0.17, 8, 0.72, 0.05, 2),
  upright('хомут нижний', polygon(0.205, 8), 0.42, 0.03, StructureMaterial.Steel),
  upright('хомут верхний', polygon(0.205, 8), 0.66, 0.03, StructureMaterial.Steel),
  upright('площадка', polygon(0.27, 8), 0.92, 0.07, StructureMaterial.Hull, { inset: 0.014 }),
  ...rivetRing(0.235, 0.99, 8),
];

/** Ось ствола снайперской башни. Совпадает с `MUZZLE_HEIGHT`. */
const SNIPER_AXIS = 1.06;

const SNIPER_HEAD: readonly Solid[] = [
  upright('голова', taper(-0.02, 0, 0.3, 0.2, 0.26), 0.99, 0.14, StructureMaterial.Hull, {
    inset: 0.018,
  }),
  upright('противовес', box(-0.21, 0, 0.13, 0.2), 1.01, 0.1, StructureMaterial.Steel),
  roller('маска орудия', 0.12, 0, SNIPER_AXIS, 0.062, 0.17, StructureMaterial.Hull, 12),
  slab(
    'маркер',
    { forward: -0.08, side: 0, length: 0.045, width: 0.18, base: 1.13, height: 0.007 },
    StructureMaterial.Neon,
  ),
  upright('оптика', box(0.08, 0, 0.14, 0.07), 1.13, 0.04, StructureMaterial.Hull),
  slab(
    'линза',
    { forward: 0.152, side: 0, length: 0.012, width: 0.05, base: 1.137, height: 0.028 },
    StructureMaterial.Glass,
  ),
  tube('ствол', 0.1, 0.7, 0, SNIPER_AXIS, 0.025, StructureMaterial.Steel, 12),
  tube('кожух', 0.07, 0.24, 0, SNIPER_AXIS, 0.04, StructureMaterial.Steel, 12),
  tube('дульный тормоз', 0.615, 0.705, 0, SNIPER_AXIS, 0.05, StructureMaterial.Steel, 12),
];

// ─────────────────────────────────────────────────────────────────────────
// Стена
// ─────────────────────────────────────────────────────────────────────────

/**
 * Стена перестала быть плитой в клетке.
 *
 * Прежде десять стен в ряд давали десять отдельных плит со столбами
 * по углам: между ними были видны просветы, и заграждения не возникало.
 * При этом в правилах ряд стен уже был сплошной преградой — стена
 * единственная перекрывает линию огня с земли (`sight.ts`). Картинка
 * противоречила правилу, а игрок читает картинку.
 *
 * Теперь облик стены задаёт набор её связей с соседями. Шестнадцать
 * наборов раскладываются на шесть форм и разворот; разворот делает
 * `spin`, поэтому описаний ровно шесть.
 */

/** Докуда доходит плечо. Половина клетки плюс нахлёст. */
const ARM_REACH = 0.52;

/**
 * Нахлёст обязателен, и вот почему.
 *
 * Оборвись геометрия ровно на границе клетки — вдоль стыка двух спрайтов
 * пошла бы светлая нитка. Крайний столбец пикселей у каждого спрайта
 * покрыт наполовину, две половинные прозрачности складываются
 * не в единицу, а в три четверти, и сквозь стену просвечивает земля.
 * Нахлёст в две сотых клетки — это около пикселя, и он эту щель
 * закрывает телом соседа.
 */
const ARM_OVERLAP = ARM_REACH - 0.5;

/** Откуда плечо начинается: изнутри контрфорса, чтобы не было щели. */
const ARM_FROM = 0.16;

/**
 * Сечение стены.
 *
 * Ширины подобраны на пробе, и первая попытка была неверной: фундамент
 * 0,44 при теле 0,30 и кромке 0,36 давал в точности профиль двутавра —
 * широкая полка снизу, узкая стенка, широкая полка сверху, — и звено
 * читалось балкой, лежащей на земле, а не стеной. Лечится сближением
 * ширин: полки перестают выпирать, и остаётся стена с цоколем.
 *
 * Высоты остаются низкими намеренно. Стена перекрывает проход,
 * но обзор загораживать не должна.
 */
const WALL_FOOTING_WIDTH = 0.38;
const WALL_BODY_WIDTH = 0.3;
const WALL_COPING_WIDTH = 0.34;

const WALL_FOOTING_TOP = 0.05;
const WALL_BODY_TOP = 0.36;
const WALL_COPING_TOP = 0.42;

/**
 * Звено стены вдоль хода: фундамент, тело с завалом, кромка и нить.
 *
 * Нить по гребню — маркер стороны, и он же то, что сваривает звенья
 * в одну стену: у соседних клеток нити встречаются на границе
 * и продолжают друг друга. Ради этого нить проложена на всю длину
 * звена вместе с нахлёстом.
 */
const wallRun = (centre: number, length: number): Solid[] => [
  slab(
    'фундамент',
    {
      forward: centre,
      side: 0,
      length,
      width: WALL_FOOTING_WIDTH,
      base: 0,
      height: WALL_FOOTING_TOP,
      taperSide: 0.012,
    },
    StructureMaterial.Concrete,
  ),
  slab(
    'тело',
    {
      forward: centre,
      side: 0,
      length,
      width: WALL_BODY_WIDTH,
      base: WALL_FOOTING_TOP,
      height: WALL_BODY_TOP - WALL_FOOTING_TOP,
      taperSide: 0.03,
    },
    StructureMaterial.Hull,
  ),
  slab(
    'кромка',
    {
      forward: centre,
      side: 0,
      length,
      width: WALL_COPING_WIDTH,
      base: WALL_BODY_TOP,
      height: WALL_COPING_TOP - WALL_BODY_TOP,
      taperSide: 0.018,
    },
    StructureMaterial.Steel,
  ),
  slab(
    'нить',
    {
      forward: centre,
      side: 0,
      length,
      width: 0.035,
      base: WALL_COPING_TOP,
      height: 0.006,
    },
    StructureMaterial.Neon,
  ),
];

/** Плечо: звено от контрфорса до границы клетки. */
const wallArm = (): Solid[] => wallRun((ARM_FROM + ARM_REACH) / 2, ARM_REACH - ARM_FROM);

/**
 * Контрфорс: восьмигранный столб с оголовком и огнём на вершине.
 *
 * Стоит везде, кроме прямого прогона. Довод в обе стороны: поставь его
 * в каждую клетку — и прямая стена превратится в нанизанные на нитку
 * бусины; убери с угла и разветвления — и на внешнем углу останется
 * голое вертикальное ребро, то есть ровно та коробка, от которой уходим.
 */
const WALL_PYLON: readonly Solid[] = [
  upright('фундамент контрфорса', polygon(0.3, 8), 0, 0.06, StructureMaterial.Concrete, {
    inset: 0.014,
  }),
  upright('контрфорс', polygon(0.24, 8), 0.06, 0.38, StructureMaterial.Hull, { inset: 0.022 }),
  upright('оголовок', polygon(0.275, 8), 0.44, 0.07, StructureMaterial.Steel, { inset: 0.016 }),
  column('огонь', 0, 0, 0.51, 0.05, 0.022, StructureMaterial.Neon, 10),
];

/** Прогон: сплошная плита через всю клетку. Единственный облик без контрфорса. */
const WALL_STRAIGHT: readonly Solid[] = wallRun(0, ARM_REACH * 2);

/**
 * Шесть форм стены.
 *
 * Плечи заданы четвертями оборота от «вперёд»: 0 — вперёд, 1 — вправо,
 * 2 — назад, 3 — влево. Модель запекается на юг, поэтому «вперёд» — это
 * юг, «вправо» — запад, и четверти совпадают с битами маски связей
 * один в один. Совпадение не случайно: ради него и выбран порядок битов.
 */
export const WallShape = {
  Post: 0,
  End: 1,
  Straight: 2,
  Corner: 3,
  Tee: 4,
  Cross: 5,
} as const;

export type WallShape = (typeof WallShape)[keyof typeof WallShape];

const WALL_ARMS: Readonly<Record<WallShape, readonly number[]>> = {
  [WallShape.Post]: [],
  [WallShape.End]: [0],
  [WallShape.Straight]: [],
  [WallShape.Corner]: [0, 1],
  [WallShape.Tee]: [0, 1, 2],
  [WallShape.Cross]: [0, 1, 2, 3],
};

const wallSolids = (shape: WallShape): readonly Solid[] => {
  if (shape === WallShape.Straight) return WALL_STRAIGHT;

  const parts: Solid[] = [...WALL_PYLON];
  for (const quarter of WALL_ARMS[shape]) parts.push(...spin(wallArm(), quarter * 2));

  return parts;
};

// ─────────────────────────────────────────────────────────────────────────
// Облик: маска связей и разворот в одном числе
// ─────────────────────────────────────────────────────────────────────────

/**
 * Биты маски связей стены — по часовой стрелке, начиная с юга.
 *
 * Порядок задан двумя условиями, и оба обязательны.
 *
 * ПЕРВОЕ: по часовой стрелке. Тогда сдвиг маски на бит влево — это
 * поворот на четверть оборота, и таблица обликов раскладывается сама,
 * а не переписывается руками для каждой из шестнадцати клеток.
 *
 * ВТОРОЕ: начиная с юга. Модель запекается развёрнутой на юг
 * (`DIRECTION_SOUTH`), поэтому неповёрнутая форма смотрит плечом
 * именно туда. Начни счёт с востока — и все шестнадцать обликов стены
 * встали бы поперёк своей линии.
 */
export const WALL_LINK_SOUTH = 1;
export const WALL_LINK_WEST = 2;
export const WALL_LINK_NORTH = 4;
export const WALL_LINK_EAST = 8;

export const WALL_LINK_COUNT = 16;

/** Смещения соседей по сторонам, в том же порядке, что биты маски. */
export const WALL_LINK_STEPS: readonly (readonly [number, number])[] = [
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 0],
];

interface WallLook {
  readonly shape: WallShape;
  /** На сколько четвертей оборота повёрнута форма. */
  readonly quarter: number;
}

/**
 * Разложение маски на форму и разворот.
 *
 * Считается один раз при загрузке модуля, а не таблицей вручную:
 * шестнадцать строк, написанных руками, разошлись бы с формами
 * при первой же правке, и разошлись бы молча.
 */
const buildLooks = (): readonly WallLook[] => {
  const looks: WallLook[] = [];

  for (let mask = 0; mask < WALL_LINK_COUNT; mask += 1) {
    const bits: number[] = [];
    for (let bit = 0; bit < 4; bit += 1) if ((mask & (1 << bit)) !== 0) bits.push(bit);

    if (bits.length === 0) {
      looks.push({ shape: WallShape.Post, quarter: 0 });
      continue;
    }

    if (bits.length === 4) {
      looks.push({ shape: WallShape.Cross, quarter: 0 });
      continue;
    }

    if (bits.length === 1) {
      looks.push({ shape: WallShape.End, quarter: bits[0] ?? 0 });
      continue;
    }

    if (bits.length === 3) {
      // Не хватает ровно одного плеча, а три оставшихся идут подряд
      // по часовой стрелке сразу за ним. Значит, форма начинается
      // со следующей четверти после недостающей.
      let missing = 0;
      for (let bit = 0; bit < 4; bit += 1) if ((mask & (1 << bit)) === 0) missing = bit;
      looks.push({ shape: WallShape.Tee, quarter: (missing + 1) % 4 });
      continue;
    }

    // Осталось два плеча: либо напротив друг друга, либо под углом.
    const [first = 0, second = 0] = bits;
    if ((second - first) % 2 === 0) {
      looks.push({ shape: WallShape.Straight, quarter: first });
      continue;
    }

    // Угол: начало формы — то плечо, за которым по часовой стрелке
    // сразу идёт второе. Для пары «север и восток» это север, а не восток.
    const quarter = (second - first) % 4 === 1 ? first : second;
    looks.push({ shape: WallShape.Corner, quarter });
  }

  return looks;
};

const WALL_LOOKS = buildLooks();

/** Форма и разворот стены по маске связей. */
export const wallLook = (mask: number): WallLook =>
  WALL_LOOKS[mask & (WALL_LINK_COUNT - 1)] ?? { shape: WallShape.Post, quarter: 0 };

// ─────────────────────────────────────────────────────────────────────────
// Ступени готовности
// ─────────────────────────────────────────────────────────────────────────

/**
 * На сколько ступеней разбит ход возведения.
 *
 * Ступени, а не непрерывная доля: модель запекается, и непрерывная доля
 * означала бы новую текстуру на каждый кадр возведения — то есть кеш,
 * который никогда не попадает.
 *
 * Восемь ступеней на шесть секунд стройки — это заметный рост примерно
 * раз в три четверти секунды. Меньше — и рост читается рывками; больше —
 * и разницы между соседними ступенями уже не видно.
 */
export const READINESS_STEPS = 8;

/** Последняя ступень означает «достроено», и только она. */
export const BUILT_STEP = READINESS_STEPS - 1;

/**
 * Ступень по доле готовности.
 *
 * Доля 1 — и только она — даёт последнюю ступень: почти достроенная
 * башня обязана отличаться от готовой, иначе ствол появлялся бы
 * до срока, а ствол — это второй признак готовности рядом с высотой.
 */
export const readinessStep = (readiness: number): number => {
  if (readiness >= 1) return BUILT_STEP;

  const step = Math.floor(Math.max(0, readiness) * BUILT_STEP);
  return step < 0 ? 0 : step > BUILT_STEP - 1 ? BUILT_STEP - 1 : step;
};

/**
 * Во сколько раз ниже готовой постройки её недострой.
 *
 * Нижний порог не косметика: совсем плоское тело сливается с землёй,
 * а начатая стройка обязана быть видна с первого тика — клетка под ней
 * непроходима уже тогда.
 */
export const readinessLift = (step: number): number =>
  step >= BUILT_STEP ? 1 : Math.max(0.12, (step + 1) / READINESS_STEPS);

// ─────────────────────────────────────────────────────────────────────────
// Высота дульного среза
// ─────────────────────────────────────────────────────────────────────────

/**
 * Высота дульного среза, в клетках. Отсюда выходит выстрел.
 *
 * Живёт рядом с моделями, а не в состоянии мира: это величина модели,
 * а не правил, и сервер про пиксели знать не обязан. Разъехаться
 * с моделью числу не даёт то, что оно стоит в одной таблице с ней
 * и правится тем же движением руки, — и проверка, сверяющая его
 * с осью ствола.
 */
const MUZZLE_HEIGHT: Readonly<Record<StructureKind, number>> = {
  // База стреляет из своего корпуса; её модель живёт в base-model.ts.
  [StructureKind.Base]: 0.9,
  // Стена не стреляет вовсе. Число нужно только для полноты таблицы.
  [StructureKind.Wall]: 0.3,
  [StructureKind.TowerBasic]: BASIC_AXIS,
  [StructureKind.TowerSniper]: SNIPER_AXIS,
};

export const structureMuzzleHeight = (kind: StructureKind): number => MUZZLE_HEIGHT[kind];

// ─────────────────────────────────────────────────────────────────────────
// Сборка модели
// ─────────────────────────────────────────────────────────────────────────

/**
 * Сколько обликов у вида постройки.
 *
 * У башни это восемь румбов турели, у стены — шестнадцать наборов
 * связей. Одно поле на оба случая: ключ кеша должен быть целым числом,
 * а не парой, и шире шестнадцати ни одному виду не нужно.
 */
export const STRUCTURE_LOOK_COUNT = 16;

/**
 * Тела постройки.
 *
 * `look` — румб турели у башни и маска связей у стены. `built` решает,
 * есть ли турель и связи вовсе: у недостроя нет ни того, ни другого,
 * и это не украшение, а второй признак готовности рядом с высотой —
 * почти достроенная башня по высоте от готовой уже почти не отличается.
 */
export const structureSolids = (
  kind: StructureKind,
  look: number,
  built: boolean,
  lift: number,
): readonly Solid[] => {
  const parts: Solid[] = [];

  if (kind === StructureKind.Wall) {
    const { shape, quarter } = wallLook(built ? look : 0);
    parts.push(...spin(wallSolids(shape), quarter * 2));
    return grow(parts, lift);
  }

  if (kind === StructureKind.TowerBasic) {
    parts.push(...BASIC_FIXED);
    if (built) {
      const rumbs = look - DIRECTION_SOUTH;
      parts.push(...spin([...BASIC_TURRET, ...basicBarrels()], rumbs));
    }

    return grow(parts, lift);
  }

  if (kind === StructureKind.TowerSniper) {
    parts.push(...SNIPER_FIXED);
    if (built) parts.push(...spin(SNIPER_HEAD, look - DIRECTION_SOUTH));

    return grow(parts, lift);
  }

  // База своей модели здесь не имеет намеренно: командный центр собран
  // в `base-model.ts` и запекается один раз за матч. Запись всё равно
  // нужна — иначе первый же новый вид молча получил бы пустой набор.
  return parts;
};

/**
 * Высота готовой модели, в клетках.
 *
 * Нужна двоим: полосе прочности (`entities.ts`) и высоте точки попадания
 * (`shots.ts`). Считается из описания, а не из запечённого спрайта:
 * ни палитры, ни видеокарты для этого не требуется, а от расхождения
 * со спрайтом число удерживает проверка, сверяющая его с `modelHeight`
 * из `buildArmourMesh`.
 */
const modelHeight = (kind: StructureKind): number => {
  let top = 0;
  for (const solid of structureSolids(kind, DIRECTION_SOUTH, true, 1)) {
    for (const point of solid.top) if (point.up > top) top = point.up;
    for (const point of solid.bottom) if (point.up > top) top = point.up;
  }

  return top;
};

const HEIGHTS: Readonly<Record<StructureKind, number>> = {
  [StructureKind.Base]: 0,
  [StructureKind.Wall]: modelHeight(StructureKind.Wall),
  [StructureKind.TowerBasic]: modelHeight(StructureKind.TowerBasic),
  [StructureKind.TowerSniper]: modelHeight(StructureKind.TowerSniper),
};

export const structureModelHeight = (kind: StructureKind): number => HEIGHTS[kind] ?? 0;

/** Только для проверок: докуда достаёт модель по связанной стороне. */
export const WALL_ARM_REACH = ARM_REACH;
export const WALL_ARM_OVERLAP = ARM_OVERLAP;
