import type { Graphics } from 'pixi.js';
import { DIRECTION_COUNT, DIRECTION_SCALE, DIRECTION_SOUTH, DIRECTION_VECTORS } from '@td/shared';
import { StructureKind } from '@td/shared';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import { FACE_LIGHT, blend, shade, solidFaces, tracePolygonAt } from './prism.js';
import type { FootprintPoint } from './prism.js';

/**
 * Модели построек.
 *
 * До этого модуля башня была призмой с призмой поменьше сверху. Она
 * не только выглядела схемой — она молчала: ствол торчал вверх и никуда
 * не смотрел, поэтому по башне нельзя было прочитать ни того, что она
 * дерётся, ни того, с какой стороны к ней подошли.
 *
 * Здесь башня собирается из тех же объёмных тел, что техника и скалы:
 * постамент, корпус, пояски, поворотная турель, стволы, вентиляция,
 * оптика. Устройство модуля объясняют четыре вещи.
 *
 * ПЕРВОЕ: поворачивается не вся постройка, а только турель. Постамент,
 * корпус и пояски стоят по клетке. Причина не в правдоподобии:
 * постамент, повёрнутый на сорок пять градусов, вылез бы за клетку,
 * а границы клетки игрок читает именно по постройке.
 *
 * ВТОРОЕ: фактура — это геометрия, а не растр. Швы, заклёпки, косые
 * предупредительные полосы, вентиляционные щели и светящаяся оптика
 * заданы многоугольниками в тех же местных координатах, что и сами
 * тела, и проецируются тем же преобразованием — то есть ложатся
 * на грань вместе с её наклоном. Растровых текстур в игре нет нигде
 * (замысел, 7.2), и заводить их ради ощущения поверхности незачем:
 * это ощущение даёт не растр, а то, что на грани есть хоть
 * что-нибудь — шов, уступ, кромка. Ровно так же сделан камень.
 *
 * ТРЕТЬЕ: наклейка рисуется сразу после своей детали и до следующей.
 * Тогда деталь, стоящая ближе, законно закрывает её собой, и порядок
 * не приходится задавать руками.
 *
 * ЧЕТВЁРТОЕ: готовая экранная геометрия кешируется. Проекция аффинна,
 * а камера неподвижна, поэтому силуэт зависит от вида постройки, румба
 * турели, ступени готовности и стороны — но НЕ от того, где постройка
 * стоит. На кадре остаётся сложение готовых координат.
 *
 * Сборка деталей в силуэт здесь своя, хотя такая же есть в `models.ts`.
 * Это сознательный временный долг: параллельно идёт изменение, которое
 * переписывает `models.ts` целиком, и вынос общего кода в момент
 * переписывания дал бы конфликт в самом сложном файле отрисовки.
 * Вынос записан отдельной задачей — см. `design.md`, решение 8.
 */

// ─────────────────────────────────────────────────────────────────────────
// Из чего собирается модель
// ─────────────────────────────────────────────────────────────────────────

/**
 * Точка в местных координатах постройки, в клетках, от центра клетки.
 *
 * `forward` — вдоль ствола, положительное значение к дульному срезу.
 * `side` — поперёк, положительное значение вправо от ствола.
 *
 * У неподвижных деталей те же координаты означают юг и запад: они
 * собираются так, будто турель смотрит на юг, и дальше не поворачиваются.
 */
interface LocalPoint {
  readonly forward: number;
  readonly side: number;
}

/** Точка на поверхности модели: к местным координатам добавлена высота. */
interface LocalSpot extends LocalPoint {
  readonly up: number;
}

/**
 * Чем красится деталь.
 *
 * Оттенки выводятся из цвета стороны, а не задаются литералами: цвет
 * на поле означает принадлежность. Сплошной неон на крупном теле
 * выжигает грани, поэтому корпус — тёмная основа с примесью цвета
 * стороны, и чем мельче деталь, тем примеси больше.
 */
const Material = {
  /** Корпус, плита стены, турель. */
  Hull: 0,
  /** Броневые накладки и оголовки: светлее корпуса. */
  Plate: 1,
  /** Стволы, кромки, мелочь. Ещё светлее. */
  Trim: 2,
  /** Постамент, пояски, ниши. Уходит в тень. */
  Dark: 3,
  /** Чистый неон стороны. Оптика, вентиляция, прицел. */
  Neon: 4,
} as const;

type Material = (typeof Material)[keyof typeof Material];

/**
 * Наклейка на поверхности: многоугольник, лежащий на грани детали.
 *
 * Яркость задаётся, а не выводится: наклейка лежит на известной автору
 * грани, и он знает, какая это грань. У светящихся наклеек яркость
 * полная — они не освещены, они светят.
 */
interface Decal {
  readonly points: readonly LocalSpot[];
  readonly material: Material;
  readonly light: number;
}

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
  /** Поворачивается ли деталь вместе с турелью. */
  readonly swivel?: boolean;
  /** Появляется ли деталь только у готовой постройки. */
  readonly whenBuilt?: boolean;
  readonly decals?: readonly Decal[];
}

/** Прямоугольная деталь: центр, длина вдоль ствола, ширина поперёк. */
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

/** Трапеция: ширина спереди и сзади разная. Нужна скошенным щитам. */
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

/**
 * Восьмиугольное основание с плоскими гранями по осям.
 *
 * Восьмиугольник, а не квадрат, — потому что квадрат читается коробкой
 * при любой отделке: у него четыре угла, и все они прямые. Срезанные
 * углы дают силуэт укрепления, и стоит это одной лишней видимой грани.
 *
 * Вершины стоят на половине угла между осями, поэтому ПЛОСКИЕ грани
 * приходятся ровно на оси — вперёд, назад и по бокам. Это не эстетика,
 * а условие для наклеек: полосы и вентиляция кладутся на переднюю грань,
 * и она обязана быть плоской и известной наперёд.
 */
const OCTAGON_APOTHEM = Math.cos(Math.PI / 8);
const OCTAGON_HALF_FACE = Math.sin(Math.PI / 8);

const octagon = (radius: number): LocalPoint[] => {
  const points: LocalPoint[] = [];

  for (let index = 0; index < 8; index += 1) {
    const angle = (Math.PI / 8) * (2 * index + 1);
    points.push({ forward: Math.cos(angle) * radius, side: Math.sin(angle) * radius });
  }

  return points;
};

// ─────────────────────────────────────────────────────────────────────────
// Заготовки фактуры
// ─────────────────────────────────────────────────────────────────────────

/**
 * Косые предупредительные полосы на передней грани восьмиугольника.
 *
 * Косые, а не вертикальные: вертикальная полоса на объекте в полсотни
 * пикселей неотличима от шва, а наклон читается сразу и означает ровно
 * то, что означает на настоящей технике, — «не подходи».
 */
const hazardStripes = (
  radius: number,
  bottom: number,
  top: number,
  count: number,
): Decal[] => {
  const apothem = radius * OCTAGON_APOTHEM;
  const reach = radius * OCTAGON_HALF_FACE * 0.92;
  const width = (reach * 2) / count;
  const slant = (top - bottom) * 0.55;

  const stripes: Decal[] = [];

  for (let index = 0; index < count; index += 1) {
    // Через одну: тёмная полоса — это не полоса, а промежуток между
    // светлыми, и рисовать её незачем.
    if (index % 2 === 1) continue;

    const left = -reach + index * width;

    stripes.push({
      points: [
        { forward: apothem, side: left, up: bottom },
        { forward: apothem, side: left + width, up: bottom },
        { forward: apothem, side: left + width + slant, up: top },
        { forward: apothem, side: left + slant, up: top },
      ],
      material: Material.Trim,
      light: FACE_LIGHT.left,
    });
  }

  return stripes;
};

/**
 * Вентиляционные щели на передней грани восьмиугольника.
 *
 * Светятся: это единственный способ показать, что внутри постройки
 * что-то работает. Заодно они и несут цвет стороны — корпус остаётся
 * тёмным, а принадлежность читается по светящимся деталям.
 */
const vents = (radius: number, bottom: number, gap: number, count: number): Decal[] => {
  const apothem = radius * OCTAGON_APOTHEM;
  const reach = radius * OCTAGON_HALF_FACE * 0.6;
  const thickness = gap * 0.35;

  const slits: Decal[] = [];

  for (let index = 0; index < count; index += 1) {
    const level = bottom + index * gap;

    slits.push({
      points: [
        { forward: apothem, side: -reach, up: level },
        { forward: apothem, side: reach, up: level },
        { forward: apothem, side: reach, up: level + thickness },
        { forward: apothem, side: -reach, up: level + thickness },
      ],
      material: Material.Neon,
      // Свет здесь не считается: щель светится сама.
      light: 1,
    });
  }

  return slits;
};

/**
 * Ряд заклёпок вдоль передней грани.
 *
 * Мелочь на грани пикселя в два, и именно она отличает бронеплиту
 * от закрашенного многоугольника: глаз не считает заклёпки, он видит,
 * что поверхность не пуста.
 */
const rivets = (radius: number, level: number, count: number): Decal[] => {
  const apothem = radius * OCTAGON_APOTHEM;
  const reach = radius * OCTAGON_HALF_FACE * 0.8;
  const size = 0.016;

  const dots: Decal[] = [];

  for (let index = 0; index < count; index += 1) {
    const side = count === 1 ? 0 : -reach + ((2 * reach) / (count - 1)) * index;

    dots.push({
      points: [
        { forward: apothem, side: side - size, up: level - size },
        { forward: apothem, side: side + size, up: level - size },
        { forward: apothem, side: side + size, up: level + size },
        { forward: apothem, side: side - size, up: level + size },
      ],
      material: Material.Trim,
      light: FACE_LIGHT.left,
    });
  }

  return dots;
};

/** Плоская наклейка на прямоугольной грани, обращённой вбок. */
const sideStripe = (
  forwardFrom: number,
  forwardTo: number,
  side: number,
  bottom: number,
  top: number,
  material: Material,
  light: number,
): Decal => ({
  points: [
    { forward: forwardFrom, side, up: bottom },
    { forward: forwardTo, side, up: bottom },
    { forward: forwardTo, side, up: top },
    { forward: forwardFrom, side, up: top },
  ],
  material,
  light,
});

// ─────────────────────────────────────────────────────────────────────────
// Модели
// ─────────────────────────────────────────────────────────────────────────

/**
 * Стена.
 *
 * Не плита во всю клетку: плита читается кубиком. Читается стеной
 * другое — фундамент шире тела, тело уже фундамента, сверху кромка,
 * по углам столбы, а на лицевой грани косые полосы. Всё это низкое:
 * стена перекрывает проход, но обзор загораживать не должна.
 *
 * Турели у неё нет, поэтому не поворачивается ничего. Румб в состоянии
 * мира у неё всё равно есть — таблица обязана быть полной, — но модель
 * его не спрашивает.
 */
const WALL_PARTS: readonly Part[] = [
  {
    label: 'фундамент',
    shape: box(0, 0, 0.76, 0.94),
    base: 0,
    height: 0.05,
    material: Material.Dark,
  },
  {
    label: 'плита',
    shape: box(0, 0, 0.42, 0.78),
    base: 0.05,
    height: 0.3,
    material: Material.Hull,
    outline: true,
    decals: [
      // Косые полосы на лицевой грани. Стена стоит рядами, и ряд
      // одинаковых полос читается заграждением, а не забором.
      {
        points: [
          { forward: 0.21, side: -0.3, up: 0.08 },
          { forward: 0.21, side: -0.17, up: 0.08 },
          { forward: 0.21, side: -0.08, up: 0.29 },
          { forward: 0.21, side: -0.21, up: 0.29 },
        ],
        material: Material.Trim,
        light: FACE_LIGHT.left,
      },
      {
        points: [
          { forward: 0.21, side: 0.04, up: 0.08 },
          { forward: 0.21, side: 0.17, up: 0.08 },
          { forward: 0.21, side: 0.26, up: 0.29 },
          { forward: 0.21, side: 0.13, up: 0.29 },
        ],
        material: Material.Trim,
        light: FACE_LIGHT.left,
      },
      // Шов на боковой грани: она в этой проекции тоже видна, и
      // оставлять её пустой нельзя.
      sideStripe(-0.21, 0.21, -0.391, 0.17, 0.195, Material.Dark, FACE_LIGHT.right),
    ],
  },
  {
    label: 'столб левый',
    shape: box(0, -0.4, 0.62, 0.14),
    base: 0.05,
    height: 0.4,
    material: Material.Plate,
  },
  {
    label: 'столб правый',
    shape: box(0, 0.4, 0.62, 0.14),
    base: 0.05,
    height: 0.4,
    material: Material.Plate,
  },
  {
    label: 'кромка',
    shape: box(0, 0, 0.54, 0.9),
    base: 0.35,
    height: 0.07,
    material: Material.Trim,
    outline: true,
    // Свес кромки над плитой — то, что отличает стену от плиты:
    // у плиты грань идёт от земли до верха одним куском.
  },
];

/**
 * Базовая башня.
 *
 * Приземистая и широкая — противоположность снайперской. Силуэт
 * складывается из ступенчатого постамента, восьмигранного корпуса
 * и низкой турели с двумя стволами: издали читается «коренастая
 * и скорострельная», а это ровно то, что она и есть.
 */
const BASIC_PARTS: readonly Part[] = [
  {
    label: 'постамент',
    shape: octagon(0.44),
    base: 0,
    height: 0.1,
    material: Material.Dark,
    decals: hazardStripes(0.44, 0.015, 0.085, 5),
  },
  {
    label: 'цоколь',
    shape: octagon(0.36),
    base: 0.1,
    height: 0.09,
    material: Material.Dark,
    decals: rivets(0.36, 0.045, 5),
  },
  {
    label: 'корпус',
    shape: octagon(0.3),
    base: 0.19,
    height: 0.31,
    material: Material.Hull,
    outline: true,
    decals: vents(0.3, 0.24, 0.055, 3),
  },
  {
    label: 'поясок',
    shape: octagon(0.33),
    base: 0.36,
    height: 0.025,
    material: Material.Dark,
  },
  {
    label: 'оголовок',
    shape: octagon(0.29),
    base: 0.5,
    height: 0.09,
    material: Material.Plate,
  },
  {
    label: 'погон',
    shape: octagon(0.25),
    base: 0.59,
    height: 0.035,
    material: Material.Dark,
  },
  {
    label: 'турель',
    shape: box(-0.04, 0, 0.34, 0.32),
    base: 0.625,
    height: 0.15,
    material: Material.Hull,
    outline: true,
    swivel: true,
    whenBuilt: true,
    decals: [sideStripe(-0.19, 0.11, -0.161, 0.66, 0.685, Material.Dark, FACE_LIGHT.right)],
  },
  {
    label: 'щит',
    shape: taper(0.17, 0, 0.12, 0.2, 0.32),
    base: 0.625,
    height: 0.175,
    material: Material.Plate,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'ящик',
    shape: box(-0.16, 0.2, 0.18, 0.09),
    base: 0.66,
    height: 0.08,
    material: Material.Dark,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'прицел',
    shape: box(0.05, -0.14, 0.09, 0.05),
    base: 0.775,
    height: 0.035,
    material: Material.Neon,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'ствол левый',
    shape: box(0.35, -0.075, 0.36, 0.055),
    base: 0.675,
    height: 0.055,
    material: Material.Trim,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'ствол правый',
    shape: box(0.35, 0.075, 0.36, 0.055),
    base: 0.675,
    height: 0.055,
    material: Material.Trim,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'дульный тормоз левый',
    shape: box(0.5, -0.075, 0.08, 0.1),
    base: 0.663,
    height: 0.08,
    material: Material.Trim,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'дульный тормоз правый',
    shape: box(0.5, 0.075, 0.08, 0.1),
    base: 0.663,
    height: 0.08,
    material: Material.Trim,
    swivel: true,
    whenBuilt: true,
  },
];

/**
 * Снайперская башня.
 *
 * Высокая и узкая: её дальность должна читаться с поля раньше, чем
 * игрок наведёт на неё курсор. Пилон с двумя хомутами, площадка,
 * узкая голова с длинным тонким стволом и светящейся оптикой.
 *
 * Ствол длиннее корпуса — та же мерка, что у снайперской машины,
 * и по той же причине: длина ствола на поле означает дальность.
 */
const SNIPER_PARTS: readonly Part[] = [
  {
    label: 'постамент',
    shape: octagon(0.42),
    base: 0,
    height: 0.09,
    material: Material.Dark,
    decals: hazardStripes(0.42, 0.012, 0.078, 5),
  },
  {
    label: 'опора',
    shape: octagon(0.3),
    base: 0.09,
    height: 0.11,
    material: Material.Plate,
    decals: rivets(0.3, 0.055, 4),
  },
  {
    label: 'пилон',
    shape: octagon(0.17),
    base: 0.2,
    height: 0.72,
    material: Material.Hull,
    outline: true,
    decals: [...vents(0.17, 0.3, 0.05, 3), ...vents(0.17, 0.66, 0.05, 2)],
  },
  {
    label: 'хомут нижний',
    shape: octagon(0.2),
    base: 0.42,
    height: 0.03,
    material: Material.Dark,
  },
  {
    label: 'хомут верхний',
    shape: octagon(0.2),
    base: 0.66,
    height: 0.03,
    material: Material.Dark,
  },
  {
    label: 'площадка',
    shape: octagon(0.27),
    base: 0.92,
    height: 0.07,
    material: Material.Plate,
    decals: rivets(0.27, 0.035, 4),
  },
  {
    label: 'голова',
    shape: taper(-0.02, 0, 0.3, 0.2, 0.26),
    base: 0.99,
    height: 0.14,
    material: Material.Hull,
    outline: true,
    swivel: true,
    whenBuilt: true,
    decals: [sideStripe(-0.15, 0.1, -0.116, 1.04, 1.065, Material.Dark, FACE_LIGHT.right)],
  },
  {
    label: 'противовес',
    shape: box(-0.21, 0, 0.13, 0.2),
    base: 1.01,
    height: 0.1,
    material: Material.Dark,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'оптика',
    shape: box(0.08, 0, 0.14, 0.07),
    base: 1.13,
    height: 0.04,
    material: Material.Neon,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'ствол',
    shape: box(0.4, 0, 0.6, 0.05),
    base: 1.035,
    height: 0.05,
    material: Material.Trim,
    swivel: true,
    whenBuilt: true,
  },
  {
    label: 'дульный тормоз',
    shape: box(0.66, 0, 0.09, 0.1),
    base: 1.02,
    height: 0.08,
    material: Material.Trim,
    swivel: true,
    whenBuilt: true,
  },
];

/**
 * База своей модели здесь не имеет намеренно.
 *
 * Командный центр собран из шести объёмов и рисуется вместе
 * с территорией: он неподвижен, и перестраивать его геометрию каждый
 * кадр незачем. Запись в таблице всё равно есть — таблица обязана быть
 * полной, иначе первый же новый вид постройки молча получил бы
 * `undefined` и не показался вовсе.
 */
const PARTS: Readonly<Record<StructureKind, readonly Part[]>> = {
  [StructureKind.Base]: [],
  [StructureKind.Wall]: WALL_PARTS,
  [StructureKind.TowerBasic]: BASIC_PARTS,
  [StructureKind.TowerSniper]: SNIPER_PARTS,
};

/**
 * Высота дульного среза, в клетках.
 *
 * Отсюда выходит выстрел. Живёт рядом с моделями, а не в состоянии
 * мира: это величина модели, а не правил, и сервер про пиксели знать
 * не обязан. Разъехаться с моделью числу не даёт то, что оно стоит
 * в одной таблице с ней и правится тем же движением руки.
 */
const MUZZLE_HEIGHT: Readonly<Record<StructureKind, number>> = {
  // База стреляет из своего корпуса; её модель живёт в base-structure.ts.
  [StructureKind.Base]: 0.9,
  // Стена не стреляет вовсе. Число нужно только для полноты таблицы.
  [StructureKind.Wall]: 0.3,
  [StructureKind.TowerBasic]: 0.7,
  [StructureKind.TowerSniper]: 1.06,
};

export const structureMuzzleHeight = (kind: StructureKind): number => MUZZLE_HEIGHT[kind];

// ─────────────────────────────────────────────────────────────────────────
// Ступени готовности
// ─────────────────────────────────────────────────────────────────────────

/**
 * На сколько ступеней разбит ход возведения.
 *
 * Ступени, а не непрерывная доля: силуэт кешируется, и непрерывная доля
 * означала бы новую запись кеша на каждый кадр возведения — то есть кеш,
 * который никогда не попадает.
 *
 * Восемь ступеней на шесть секунд стройки — это заметный рост примерно
 * раз в три четверти секунды. Меньше — и рост читается рывками; больше —
 * и разницы между соседними ступенями уже не видно.
 */
export const READINESS_STEPS = 8;

/** Последняя ступень означает «достроено», и только она. */
const BUILT_STEP = READINESS_STEPS - 1;

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
 * а начатая стройка обязана быть видна с первого тика.
 */
const growth = (step: number): number =>
  step >= BUILT_STEP ? 1 : Math.max(0.12, (step + 1) / READINESS_STEPS);

// ─────────────────────────────────────────────────────────────────────────
// Сборка силуэта
// ─────────────────────────────────────────────────────────────────────────

/** Группа многоугольников одного цвета, залитых одним вызовом. */
export interface TowerFill {
  readonly color: number;
  readonly polygons: readonly (readonly Point[])[];
}

export interface TowerSilhouette {
  /** Заливки в порядке от дальних граней к ближним. */
  readonly fills: readonly TowerFill[];
  /** Контуры под неоновую обводку. */
  readonly outline: readonly (readonly Point[])[];
  /** Высота модели в клетках. По ней ставится полоса прочности. */
  readonly height: number;
}

/** Цвета, из которых выводятся все оттенки модели. */
export interface TowerColors {
  readonly self: number;
  readonly enemy: number;
  readonly hullDark: number;
}

/** Своя сторона и чужая. Индекс входит в ключ кеша. */
const SIDE_COUNT = 2;
const ENEMY_SIDE = 1;

/**
 * Оттенки материалов для одной стороны.
 *
 * Доли меньше, чем у техники, и это не разнобой, а то же правило,
 * доведённое до конца: чем крупнее тело, тем меньше в нём цвета стороны.
 * Машина занимает на экране сорок пикселей, башня — вдвое больше и вдвое
 * выше; возьми она долю машины, поле превратилось бы в светящиеся глыбы,
 * между которыми теряются сами машины.
 *
 * Принадлежность при этом не пропадает: её несут неоновая окантовка
 * и светящаяся оптика, то есть самые мелкие места модели.
 */
const materialColors = (colors: TowerColors, side: number): readonly number[] => {
  const accent = side === ENEMY_SIDE ? colors.enemy : colors.self;

  return [
    blend(colors.hullDark, accent, 0.2),
    blend(colors.hullDark, accent, 0.32),
    blend(colors.hullDark, accent, 0.5),
    blend(colors.hullDark, accent, 0.07),
    accent,
  ];
};

/** Ход «на юг» — им собираются неподвижные детали. */
const SOUTHWARD = { x: 0, y: DIRECTION_SCALE };

/** Перевод местной точки в мировую относительно центра клетки. */
const toWorld = (local: LocalPoint, facing: number): FootprintPoint => {
  const vector = DIRECTION_VECTORS[facing] ?? SOUTHWARD;
  const forwardX = vector.x / DIRECTION_SCALE;
  const forwardY = vector.y / DIRECTION_SCALE;

  // «Вправо от ствола» — поворот вектора на прямой угол. Ось Y смотрит
  // на юг, поэтому вправо от «на восток» оказывается юг, как и должно быть.
  return {
    x: local.forward * forwardX - local.side * forwardY,
    y: local.forward * forwardY + local.side * forwardX,
  };
};

/** Экранная точка по местной, с учётом высоты. */
const project = (local: LocalSpot, facing: number, lift: number): Point => {
  const world = toWorld(local, facing);
  const screen = worldToScreen(world.x, world.y);

  return { x: screen.x, y: screen.y - local.up * lift * ELEVATION_PX_PER_CELL };
};

interface PlacedPart {
  readonly part: Part;
  readonly footprint: readonly FootprintPoint[];
  readonly facing: number;
  /** Удалённость от зрителя: сумма мировых координат центра детали. */
  readonly depth: number;
}

/**
 * Сборка силуэта.
 *
 * Порядок деталей считается здесь, а не задаётся руками в таблице:
 * достаточно поправить одно смещение, и ручной порядок сломался бы
 * молча. Правило то же, что для всего поля: чем больше сумма координат
 * центра, тем ближе деталь к зрителю и тем позже её надо рисовать.
 * Детали на одном месте разводятся по высоте — турель поверх корпуса.
 */
const buildSilhouette = (
  parts: readonly Part[],
  facing: number,
  step: number,
  colors: TowerColors,
  side: number,
): TowerSilhouette => {
  const palette = materialColors(colors, side);
  const lift = growth(step);
  const built = step >= BUILT_STEP;

  const placed: PlacedPart[] = [];

  for (const part of parts) {
    // Ствол и турель появляются только у готовой постройки. Это второй
    // признак готовности рядом с высотой: почти достроенная башня
    // по высоте от готовой уже почти не отличается, а по стволу —
    // отличается сразу.
    if (part.whenBuilt === true && !built) continue;

    const rumb = part.swivel === true ? facing : DIRECTION_SOUTH;
    const footprint = part.shape.map((point) => toWorld(point, rumb));

    let sum = 0;
    for (const point of footprint) sum += point.x + point.y;

    placed.push({
      part,
      footprint,
      facing: rumb,
      depth: footprint.length === 0 ? 0 : sum / footprint.length,
    });
  }

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

  for (const { part, footprint, facing: rumb } of placed) {
    const faces = solidFaces(footprint, part.height * lift, part.base * lift);
    const base = palette[part.material] ?? palette[0] ?? 0;

    for (const face of faces.sides) emit(shade(base, face.light), face.points);
    emit(shade(base, faces.top.light), faces.top.points);

    if (part.outline === true) {
      for (const face of faces.sides) outline.push(face.points);
      outline.push(faces.top.points);
    }

    // Фактура идёт сразу за своей деталью и до следующей: деталь,
    // стоящая ближе, обязана закрыть её собой.
    for (const decal of part.decals ?? []) {
      const decalColor = palette[decal.material] ?? base;
      emit(
        shade(decalColor, decal.light),
        decal.points.map((point) => project(point, rumb, lift)),
      );
    }

    const top = (part.base + part.height) * lift;
    if (top > height) height = top;
  }

  return { fills, outline, height };
};

// ─────────────────────────────────────────────────────────────────────────
// Кеш
// ─────────────────────────────────────────────────────────────────────────

/**
 * Кеш силуэтов.
 *
 * Ключ — целое число из вида, румба, ступени готовности и стороны.
 * Строкового ключа здесь быть не должно: обращение идёт на каждую
 * постройку каждый кадр.
 *
 * Комбинаций пять сотен, и все они разом не встречаются никогда:
 * кеш ленивый. Недострой к тому же живёт секунды, а его записи —
 * до конца матча; это законно, потому что их немного и они мелкие.
 */
const KIND_COUNT = Object.keys(PARTS).length;
const CACHE_SIZE = KIND_COUNT * DIRECTION_COUNT * READINESS_STEPS * SIDE_COUNT;

const cache: (TowerSilhouette | undefined)[] = new Array<TowerSilhouette | undefined>(CACHE_SIZE);

/**
 * Палитра, для которой построен кеш.
 *
 * Цвета читаются из CSS один раз при запуске, и объект палитры живёт
 * столько же, сколько сцена, поэтому сравнения по ссылке достаточно.
 */
let cachedColors: TowerColors | undefined;

const ensurePalette = (colors: TowerColors): void => {
  if (cachedColors === colors) return;

  cachedColors = colors;
  cache.fill(undefined);
};

const normaliseFacing = (facing: number): number =>
  Number.isInteger(facing) && facing > 0 && facing < DIRECTION_COUNT ? facing : DIRECTION_SOUTH;

const clampStep = (step: number): number =>
  !Number.isInteger(step) || step < 0 ? 0 : step > BUILT_STEP ? BUILT_STEP : step;

/**
 * Силуэт постройки. Одинаковые запросы возвращают одну и ту же запись.
 */
export const structureSilhouette = (
  colors: TowerColors,
  side: number,
  kind: StructureKind,
  facing: number,
  step: number,
): TowerSilhouette => {
  ensurePalette(colors);

  const rumb = normaliseFacing(facing);
  const stage = clampStep(step);
  const index = ((kind * DIRECTION_COUNT + rumb) * READINESS_STEPS + stage) * SIDE_COUNT + side;

  const cached = cache[index];
  if (cached !== undefined) return cached;

  const built = buildSilhouette(PARTS[kind], rumb, stage, colors, side);

  cache[index] = built;
  return built;
};

/**
 * Высота готовой модели, в клетках. По ней ставится полоса прочности.
 *
 * Считается через силуэт, а не отдельной таблицей: две таблицы
 * разъехались бы при первой же правке модели, и полоса прочности
 * повисла бы в воздухе.
 */
export const structureModelHeight = (colors: TowerColors, kind: StructureKind): number =>
  structureSilhouette(colors, 0, kind, DIRECTION_SOUTH, BUILT_STEP).height;

/** Только для тестов: сбросить кеш и заставить строить силуэты заново. */
export const resetTowerCache = (): void => {
  cachedColors = undefined;
  cache.fill(undefined);
};

// ─────────────────────────────────────────────────────────────────────────
// Отрисовка
// ─────────────────────────────────────────────────────────────────────────

/**
 * Отрисовка готового силуэта из кеша.
 *
 * Вся геометрия построена заранее относительно центра клетки, поэтому
 * здесь остаётся сложение двух чисел на точку. Заливки уже склеены
 * по цвету и упорядочены от дальних граней к ближним — порядок вызовов
 * менять нельзя.
 */
export const paintStructure = (
  graphics: Graphics,
  silhouette: TowerSilhouette,
  anchorX: number,
  anchorY: number,
  accent: number,
): void => {
  for (const run of silhouette.fills) {
    for (const polygon of run.polygons) {
      tracePolygonAt(graphics, polygon, anchorX, anchorY);
    }
    graphics.fill({ color: run.color });
  }

  if (silhouette.outline.length === 0) return;

  // Неоновая окантовка несёт основную нагрузку узнавания: тёмный корпус
  // на тёмной земле сам по себе виден плохо. Обводятся не все детали,
  // а только те, что задают силуэт, — иначе башня превращается
  // в клубок светящихся линий.
  for (const polygon of silhouette.outline) {
    tracePolygonAt(graphics, polygon, anchorX, anchorY);
  }
  graphics.stroke({ width: 1, color: accent, alpha: 0.9 });
};
