/**
 * Из чего собран командный центр.
 *
 * Модуль чистый: здесь только числа и никакого PixiJS. Так модель можно
 * покрыть тестами — а покрывать есть что, потому что часть её размеров
 * держится не на вкусе, а на правилах симуляции (см. «ближняя половина»
 * ниже).
 *
 * ## Система координат
 *
 * Точка привязки — узел сетки `(x, y)`, то есть УГОЛ клетки базы,
 * а не её середина. Соглашение досталось от прежней отрисовки, и менять
 * его нельзя без правки `baseCrestPoint`: к нему привязана полоса
 * прочности. Зато оно удобно: площадка со стороной в чётное число
 * клеток, построенная вокруг узла, ложится ровно по границам клеток.
 *
 * Местные координаты — в клетках, от точки привязки; `z` — высота,
 * тоже в клетках. Диапазон площадки — [-2, +2] по обеим осям.
 *
 * ## Что где стои́т и почему именно там
 *
 * В нашей проекции сумма мировых координат растёт К ЗРИТЕЛЮ: узел
 * `(-2, -2)` — самая дальняя точка площадки (вверху экрана), `(2, 2)` —
 * самая ближняя (внизу).
 *
 * Тяжёлые объёмы стоят в ДАЛЬНЕЙ половине, ближняя остаётся низкой,
 * и это требование, а не композиция. Юнит появляется на ближайшей
 * свободной клетке вокруг клетки базы (`findFreeCellNear` в `sim`), то
 * есть внутри пятна модели. Машина, возникшая за корпусом, читается
 * выезжающей из-за него; машина, возникшая ВНУТРИ высокого корпуса, —
 * ошибкой отрисовки. Клетка базы лежит в ближней половине, поэтому
 * ближняя половина — плац.
 *
 * Заодно это лечит вторую беду: высокое тело на ближней стороне
 * закрывает собой всё, что за ним, — в аксонометрии оно оказывается
 * на экране НИЖЕ и перекрывает постройку целиком.
 */

/** Точка в местных координатах: клетки от точки привязки, `z` — высота. */
export interface BasePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Материалы командного центра.
 *
 * Бетон нейтрален и несёт основную площадь; цвет стороны достаётся
 * самым мелким и самым ярким местам — окнам, огням, полосам. Правило
 * то же, что у башен, доведённое до конца: чем крупнее тело, тем
 * меньше в нём цвета стороны, а база — самое крупное тело на поле.
 */
export const BaseMaterial = {
  /** Стены, кровля, парапеты. */
  Concrete: 0,
  /** Подиум, карнизы, ниши — уходит в тень. */
  ConcreteDark: 1,
  /** Ограждения, люки, направляющая, конструкция мачты. */
  Metal: 2,
  /** Чистый неон стороны: окна, огни, полосы ворот. Светится сам. */
  Neon: 3,
} as const;

export type BaseMaterial = (typeof BaseMaterial)[keyof typeof BaseMaterial];

/**
 * Объёмное тело модели.
 *
 * `taper` — насколько верхнее основание уже нижнего с каждой стороны,
 * в клетках. Ноль означает отвесные стены. Скос нужен по той же
 * причине, по которой скошена броня машин (замысел, 7.2): у отвесной
 * грани яркость принимает всего два значения, и постройка из отвесных
 * тел читается стопкой кубиков.
 */
export interface BaseSolid {
  readonly label: string;
  /** Северо-западный угол основания. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
  /** Уровень, на котором стоит основание. */
  readonly base: number;
  readonly height: number;
  readonly material: BaseMaterial;
  readonly taper?: number;
  /** Нести ли неоновую окантовку по рёбрам. */
  readonly outline?: boolean;
  readonly decals?: readonly BaseDecal[];
}

/**
 * Наклейка: плоский многоугольник, лежащий на грани тела.
 *
 * Яркость задаётся, а не считается: автор знает, на какой грани лежит
 * наклейка. У светящихся яркость полная — они не освещены, они светят.
 */
export interface BaseDecal {
  readonly points: readonly BasePoint[];
  readonly material: BaseMaterial;
  readonly light: number;
}

/**
 * Тонкий элемент конструкции: отрезок постоянной экранной толщины.
 *
 * Пояс решётчатой мачты в жизни — уголок сантиметров в пятнадцать,
 * в наших клетках это 0,02. Тело такой толщины даёт три грани
 * по полпикселя, которые после сглаживания превращаются в серое пятно;
 * линия читается конструкцией.
 */
export interface BaseStrut {
  readonly from: BasePoint;
  readonly to: BasePoint;
  /** Толщина в экранных пикселях. */
  readonly width: number;
  readonly material: BaseMaterial;
  /** Условная яркость: у отрезка нет нормали, и считать её не из чего. */
  readonly light: number;
  readonly alpha?: number;
}

/** Светящаяся точка: прожектор, огонь ворот, носовая точка ракеты. */
export interface BaseLight {
  readonly at: BasePoint;
  /** Радиус в экранных пикселях. */
  readonly radius: number;
  readonly material: BaseMaterial;
}

// ─────────────────────────────────────────────────────────────────────────
// Габариты площадки
// ─────────────────────────────────────────────────────────────────────────

/** Полуширина площадки в клетках. Сторона — вдвое больше. */
export const BASE_HALF_CELLS = 2;

/** Площадь основания базы в клетках. */
export const BASE_FOOTPRINT_CELLS = (BASE_HALF_CELLS * 2) ** 2;

/**
 * Высота мачты. База обязана быть выше любой скалы — см. замысел
 * и `rock-appearance`. Потолок рельефа — 3 клетки, и запас над ним
 * намеренно небольшой: мачта, ушедшая в небо, перестаёт читаться
 * частью постройки.
 */
export const BASE_ANTENNA_HEIGHT = 3.2;

/**
 * Граница между дальней и ближней половиной площадки.
 *
 * Тело выше `LOW_LIMIT` обязано стоять в дальней половине — там, где
 * сумма местных координат его центра не больше нуля.
 */
export const NEAR_HALF_LIMIT = 0;

/** Предел высоты для ближней половины, в клетках. */
export const LOW_LIMIT = 0.35;

// ─────────────────────────────────────────────────────────────────────────
// Заготовки фактуры
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ряд окон на грани, обращённой к юго-востоку (к зрителю).
 *
 * Окна светятся цветом стороны. Это единственное место модели, где
 * принадлежность видна крупно, и потому их немного: ряд узких щелей,
 * а не витраж.
 */
const windowRow = (
  y: number,
  fromX: number,
  toX: number,
  level: number,
  count: number,
): BaseDecal[] => {
  const span = toX - fromX;
  const pitch = span / count;
  const width = pitch * 0.45;
  const height = 0.11;

  const windows: BaseDecal[] = [];

  for (let index = 0; index < count; index += 1) {
    const left = fromX + pitch * (index + 0.5) - width / 2;

    windows.push({
      points: [
        { x: left, y, z: level },
        { x: left + width, y, z: level },
        { x: left + width, y, z: level + height },
        { x: left, y, z: level + height },
      ],
      material: BaseMaterial.Neon,
      light: 1,
    });
  }

  return windows;
};

/**
 * Косые предупредительные полосы на кромке.
 *
 * Косые, а не прямые: наклон читается сразу и означает ровно то же,
 * что означает на настоящем сооружении, — «не подходи». Тем же приёмом
 * размечены башни.
 */
const hazardBand = (
  y: number,
  fromX: number,
  toX: number,
  bottom: number,
  top: number,
  count: number,
): BaseDecal[] => {
  const span = toX - fromX;
  const pitch = span / count;
  const width = pitch * 0.5;
  const slant = (top - bottom) * 0.5;

  const stripes: BaseDecal[] = [];

  for (let index = 0; index < count; index += 1) {
    const left = fromX + pitch * index;

    stripes.push({
      points: [
        { x: left, y, z: bottom },
        { x: left + width, y, z: bottom },
        { x: left + width + slant, y, z: top },
        { x: left + slant, y, z: top },
      ],
      material: BaseMaterial.Metal,
      light: 0.9,
    });
  }

  return stripes;
};

/** Прямоугольная разметка на горизонтальной плоскости. */
const groundMark = (
  x: number,
  y: number,
  width: number,
  depth: number,
  level: number,
  material: BaseMaterial,
  light: number,
): BaseDecal => ({
  points: [
    { x, y, z: level },
    { x: x + width, y, z: level },
    { x: x + width, y: y + depth, z: level },
    { x, y: y + depth, z: level },
  ],
  material,
  light,
});

// ─────────────────────────────────────────────────────────────────────────
// Тела
// ─────────────────────────────────────────────────────────────────────────

/** Уровень верха подиума. От него отсчитывается всё, что на нём стоит. */
const PODIUM_TOP = 0.1;

/** Уровень плаца: тонкая плита поверх подиума, светлее его. */
const PLAZA_TOP = PODIUM_TOP + 0.03;

/** Ось мачты и уровень, с которого начинается ферма. */
export const MAST_X = -1.525;
export const MAST_Y = -0.025;
const MAST_PAD_TOP = PODIUM_TOP + 0.34;

/** Уровень крыши главного корпуса и её парапета. */
const HULL_TOP = PODIUM_TOP + 1.05;
const HULL_ROOF = HULL_TOP + 0.07;

export const BASE_SOLIDS: readonly BaseSolid[] = [
  {
    label: 'подиум',
    x: -2,
    y: -2,
    width: 4,
    depth: 4,
    base: 0,
    height: PODIUM_TOP,
    material: BaseMaterial.ConcreteDark,
    taper: 0.02,
  },
  {
    // Плац: тонкая плита в ближней половине. Отдельным телом, а не
    // разметкой по подиуму, ради ребра по её краю — по нему читается,
    // где кончается проезжая часть.
    // Границы плаца выбраны не по композиции: тела модели не имеют права
    // врезаться друг в друга, иначе порядок их отрисовки перестаёт быть
    // определённым (`base-render.ts`, отношение «позади»). Плита обходит
    // основание мачты по западу и площадку пусковой по северу.
    label: 'плац',
    x: -1,
    y: 0.5,
    width: 2.9,
    depth: 1.4,
    base: PODIUM_TOP,
    height: 0.03,
    material: BaseMaterial.Concrete,
    decals: [
      // Разметка: осевая полоса от ворот вглубь площадки и поперечные
      // метки стоянки. По ним читается масштаб — без разметки плац
      // выглядит просто плитой.
      groundMark(-0.06, 0.55, 0.12, 1.3, PLAZA_TOP, BaseMaterial.Metal, 0.85),
      groundMark(-0.85, 0.75, 0.65, 0.06, PLAZA_TOP, BaseMaterial.Metal, 0.7),
      groundMark(-0.85, 1.25, 0.65, 0.06, PLAZA_TOP, BaseMaterial.Metal, 0.7),
      groundMark(0.2, 0.75, 0.65, 0.06, PLAZA_TOP, BaseMaterial.Metal, 0.7),
      groundMark(0.2, 1.25, 0.65, 0.06, PLAZA_TOP, BaseMaterial.Metal, 0.7),
    ],
  },
  {
    label: 'главный корпус',
    x: -1.4,
    y: -1.9,
    width: 1.6,
    depth: 1.35,
    base: PODIUM_TOP,
    height: 1.05,
    material: BaseMaterial.Concrete,
    // Скос заметный: у бункера стены и в жизни развалены книзу, а нам
    // он к тому же даёт третий оттенок на теле, которого у отвесных
    // граней взяться неоткуда.
    taper: 0.09,
    outline: true,
    decals: [
      // Окна оперативного зала на ближней грани корпуса.
      ...windowRow(-0.55, -1.25, -0.15, 0.72, 4),
      // Ниша въезда: тёмный прямоугольник у основания. Дверь читается
      // не створками — на этом размере их не видно, — а тем, что стена
      // в одном месте уходит вглубь.
      {
        points: [
          { x: -0.95, y: -0.55, z: PODIUM_TOP },
          { x: -0.55, y: -0.55, z: PODIUM_TOP },
          { x: -0.55, y: -0.55, z: PODIUM_TOP + 0.42 },
          { x: -0.95, y: -0.55, z: PODIUM_TOP + 0.42 },
        ],
        material: BaseMaterial.ConcreteDark,
        light: 0.5,
      },
    ],
  },
  {
    // Карниз: свес по верху корпуса. Он и отличает здание от коробки —
    // у коробки грань идёт от земли до верха одним куском.
    label: 'карниз',
    x: -1.5,
    y: -2,
    width: 1.82,
    depth: 1.57,
    base: HULL_TOP,
    height: 0.07,
    material: BaseMaterial.ConcreteDark,
  },
  {
    label: 'рубка',
    x: -1.05,
    y: -1.72,
    width: 0.95,
    depth: 0.8,
    base: HULL_ROOF,
    height: 0.44,
    material: BaseMaterial.Concrete,
    taper: 0.06,
    outline: true,
    decals: [...windowRow(-0.92, -0.95, -0.2, HULL_ROOF + 0.12, 3)],
  },
  {
    label: 'парапет кровли, ближняя кромка',
    x: -1.5,
    y: -0.55,
    width: 1.82,
    depth: 0.12,
    base: HULL_ROOF,
    height: 0.13,
    material: BaseMaterial.ConcreteDark,
  },
  {
    label: 'парапет кровли, западная кромка',
    x: -1.5,
    y: -2,
    width: 0.12,
    // Кончается там, где начинается ближняя кромка: перекройся они
    // в углу, порядок отрисовки двух парапетов стал бы неопределённым.
    depth: 1.45,
    base: HULL_ROOF,
    height: 0.13,
    material: BaseMaterial.ConcreteDark,
  },
  {
    // Кровля не бывает пустой. Короб вентиляции и люк выхода стоят
    // не для правдоподобия, а ради масштаба: по мелкой детали глаз
    // считывает, насколько велико сооружение под ней.
    label: 'короб вентиляции на кровле',
    x: -0.02,
    y: -1.75,
    width: 0.28,
    depth: 0.42,
    base: HULL_ROOF,
    height: 0.17,
    // Тёмный бетон, а не металл, и это поправка по снимку: светлый
    // металл на горизонтальной грани получает и полный свет, и полный
    // свет неба, и короб выходил белым пятном на серой кровле.
    // Металл остался там, где он тонкий, — на ферме и ограждении.
    material: BaseMaterial.ConcreteDark,
  },
  {
    label: 'люк выхода на кровлю',
    x: -0.85,
    y: -1.95,
    width: 0.3,
    depth: 0.18,
    base: HULL_ROOF,
    height: 0.05,
    material: BaseMaterial.ConcreteDark,
  },
  {
    label: 'оперативная пристройка',
    x: 0.35,
    y: -1.9,
    width: 1.55,
    depth: 1.0,
    base: PODIUM_TOP,
    height: 0.58,
    material: BaseMaterial.Concrete,
    taper: 0.05,
    outline: true,
    decals: [...windowRow(-0.9, 0.5, 1.75, PODIUM_TOP + 0.22, 5)],
  },
  {
    label: 'вентиляционный блок',
    x: 0.72,
    y: -1.62,
    width: 0.52,
    depth: 0.42,
    base: PODIUM_TOP + 0.58,
    height: 0.16,
    material: BaseMaterial.ConcreteDark,
  },
  {
    label: 'основание мачты',
    x: MAST_X - 0.42,
    y: MAST_Y - 0.42,
    width: 0.84,
    depth: 0.84,
    base: PODIUM_TOP,
    height: MAST_PAD_TOP - PODIUM_TOP,
    material: BaseMaterial.ConcreteDark,
    taper: 0.05,
    decals: hazardBand(
      MAST_Y + 0.42,
      MAST_X - 0.36,
      MAST_X + 0.36,
      PODIUM_TOP + 0.06,
      MAST_PAD_TOP - 0.04,
      4,
    ),
  },
  {
    label: 'площадка пусковой установки',
    x: 0.95,
    y: -0.5,
    width: 0.95,
    depth: 0.95,
    base: PODIUM_TOP,
    height: 0.18,
    material: BaseMaterial.ConcreteDark,
    decals: [
      groundMark(1.06, -0.39, 0.73, 0.06, PODIUM_TOP + 0.18, BaseMaterial.Metal, 0.9),
      groundMark(1.06, 0.33, 0.73, 0.06, PODIUM_TOP + 0.18, BaseMaterial.Metal, 0.9),
    ],
  },
  {
    label: 'тумба ворот, западная',
    x: -0.78,
    y: 1.62,
    width: 0.26,
    depth: 0.26,
    base: PLAZA_TOP,
    height: 0.24,
    material: BaseMaterial.ConcreteDark,
  },
  {
    label: 'тумба ворот, восточная',
    x: 0.52,
    y: 1.62,
    width: 0.26,
    depth: 0.26,
    base: PLAZA_TOP,
    height: 0.24,
    material: BaseMaterial.ConcreteDark,
  },
  {
    // Аппарель ворот: приподнятый порог на самой кромке площадки.
    // Спуска на землю здесь нет и быть не может — модель обязана
    // умещаться в свои четыре клетки, а скат вышел бы за них.
    label: 'аппарель',
    x: -0.5,
    y: 1.9,
    width: 1.0,
    depth: 0.1,
    base: PODIUM_TOP,
    height: 0.06,
    material: BaseMaterial.ConcreteDark,
    decals: hazardBand(2.0, -0.46, 0.46, PODIUM_TOP + 0.005, PODIUM_TOP + 0.055, 5),
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Мачта
// ─────────────────────────────────────────────────────────────────────────

/** Полуширина фермы у основания и у вершины, в клетках. */
const MAST_HALF_BOTTOM = 0.15;
const MAST_HALF_TOP = 0.048;

/** Сколько ярусов у фермы. */
const MAST_TIERS = 13;

/** Уровень площадки обслуживания. */
const CATWALK_LEVEL = 2.62;

/** Полуширина фермы на заданной высоте. */
const mastHalf = (level: number): number => {
  const t = (level - MAST_PAD_TOP) / (BASE_ANTENNA_HEIGHT - MAST_PAD_TOP);

  return MAST_HALF_BOTTOM + (MAST_HALF_TOP - MAST_HALF_BOTTOM) * Math.min(1, Math.max(0, t));
};

/** Четыре пояса фермы: углы квадратного сечения. */
const MAST_CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

const mastCorner = (index: number, level: number): BasePoint => {
  const corner = MAST_CORNERS[index % 4] ?? MAST_CORNERS[0];
  const half = mastHalf(level);

  return { x: MAST_X + corner[0] * half, y: MAST_Y + corner[1] * half, z: level };
};

/**
 * Яркость элемента конструкции по тому, куда он обращён.
 *
 * Считать закон Ламберта для отрезка не из чего — у отрезка нет
 * нормали, — но разница в яркости нужна: без неё ферма читается плоской
 * решёткой, наклеенной на небо. Поэтому пояса, обращённые к зрителю
 * и к источнику света, светлее дальних, а раскосы темнее поясов.
 */
const CHORD_LIGHT_NEAR = 0.92;
const CHORD_LIGHT_FAR = 0.52;
const BRACE_LIGHT = 0.68;

/**
 * Ферма мачты: четыре пояса, раскосы зигзагом и распорки по ярусам.
 *
 * Зигзаг раскосов идёт в разные стороны на соседних гранях, как
 * и в настоящей ферме: сходящиеся в одну точку раскосы дали бы
 * рисунок, который на глаз читается решёткой забора.
 */
const mastStruts = (): BaseStrut[] => {
  const struts: BaseStrut[] = [];
  const span = BASE_ANTENNA_HEIGHT - MAST_PAD_TOP;
  const tierHeight = span / MAST_TIERS;

  const lightOf = (index: number): number =>
    // Пояса 1 и 2 (восточный и южный углы сечения) обращены к зрителю.
    index === 1 || index === 2 ? CHORD_LIGHT_NEAR : CHORD_LIGHT_FAR;

  for (let tier = 0; tier < MAST_TIERS; tier += 1) {
    const bottom = MAST_PAD_TOP + tierHeight * tier;
    const top = bottom + tierHeight;

    for (let index = 0; index < 4; index += 1) {
      // Пояс.
      struts.push({
        from: mastCorner(index, bottom),
        to: mastCorner(index, top),
        width: 1.8,
        material: BaseMaterial.Metal,
        light: lightOf(index),
      });

      // Раскос: через ярус меняет направление, поэтому по грани идёт
      // зигзаг, а не частокол параллельных палок.
      const next = (index + 1) % 4;
      const forward = (tier + index) % 2 === 0;

      struts.push({
        from: mastCorner(forward ? index : next, bottom),
        to: mastCorner(forward ? next : index, top),
        width: 1.1,
        material: BaseMaterial.Metal,
        light: BRACE_LIGHT,
      });

      // Распорка по ярусу: только на каждом третьем, иначе решётка
      // становится сплошной сеткой и мачта тяжелеет.
      if (tier % 3 === 0) {
        struts.push({
          from: mastCorner(index, bottom),
          to: mastCorner(next, bottom),
          width: 1.1,
          material: BaseMaterial.Metal,
          light: BRACE_LIGHT,
        });
      }
    }
  }

  return struts;
};

/**
 * Оттяжки: три троса от площадки обслуживания к якорям на подиуме.
 *
 * Три, а не четыре: три точки задают устойчивость, и так делают
 * в жизни. Якоря разведены по ближней половине площадки намеренно —
 * трос, уходящий за корпус, экранно пересёк бы его и читался бы
 * царапиной по стене.
 */
const GUY_ANCHORS: readonly BasePoint[] = [
  { x: -1.85, y: 1.15, z: PODIUM_TOP },
  { x: -0.35, y: 1.5, z: PLAZA_TOP },
  { x: -1.9, y: -1.15, z: PODIUM_TOP },
];

const guyStruts = (): BaseStrut[] =>
  GUY_ANCHORS.map((anchor) => ({
    from: { x: MAST_X, y: MAST_Y, z: CATWALK_LEVEL - 0.06 },
    to: anchor,
    width: 1,
    material: BaseMaterial.Metal,
    light: 0.6,
    // Трос тоньше волоса на этом размере, и полная непрозрачность
    // сделала бы из него стальной прут.
    alpha: 0.45,
  }));

/** Перила: стойки и поручень вдоль отрезка. */
const railing = (from: BasePoint, to: BasePoint, posts: number, height: number): BaseStrut[] => {
  const struts: BaseStrut[] = [];
  const top = (point: BasePoint): BasePoint => ({ ...point, z: point.z + height });

  struts.push({
    from: top(from),
    to: top(to),
    width: 1.2,
    material: BaseMaterial.Metal,
    light: 0.85,
  });

  for (let index = 0; index <= posts; index += 1) {
    const t = index / posts;
    const at: BasePoint = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    };

    struts.push({
      from: at,
      to: top(at),
      width: 1,
      material: BaseMaterial.Metal,
      light: 0.7,
    });
  }

  return struts;
};

/** Высота ограждения по периметру. */
const FENCE_HEIGHT = 0.22;

/**
 * Ограждение и лестницы.
 *
 * Ограждение идёт по ближним кромкам площадки, и это не экономия:
 * дальние кромки лежат за корпусом, и ограждение на них рисовалось бы
 * поверх стены — линии рисуются после тел и глубины не знают.
 */
const fenceStruts = (): BaseStrut[] => [
  ...railing({ x: -2, y: 2, z: PODIUM_TOP }, { x: -0.78, y: 2, z: PODIUM_TOP }, 4, FENCE_HEIGHT),
  ...railing({ x: 0.78, y: 2, z: PODIUM_TOP }, { x: 2, y: 2, z: PODIUM_TOP }, 4, FENCE_HEIGHT),
  ...railing({ x: 2, y: 2, z: PODIUM_TOP }, { x: 2, y: -0.6, z: PODIUM_TOP }, 6, FENCE_HEIGHT),
  ...railing({ x: -2, y: 2, z: PODIUM_TOP }, { x: -2, y: 0.5, z: PODIUM_TOP }, 4, FENCE_HEIGHT),
  // Перила площадки обслуживания на мачте.
  ...railing(
    { x: MAST_X - 0.2, y: MAST_Y + 0.2, z: CATWALK_LEVEL },
    { x: MAST_X + 0.2, y: MAST_Y + 0.2, z: CATWALK_LEVEL },
    2,
    0.09,
  ),
  // Лестница на кровлю корпуса: две тетивы и ступени между ними.
  ...ladderStruts(),
];

const ladderStruts = (): BaseStrut[] => {
  const struts: BaseStrut[] = [];
  // Лестница стои́т ПЕРЕД фасадом корпуса, а не заподлицо с ним: линии
  // рисуются поверх тел и глубины не знают, поэтому лестница, оказавшаяся
  // за стеной, читалась бы царапиной по ней.
  const foot: BasePoint = { x: -0.02, y: -0.48, z: PODIUM_TOP };
  const head: BasePoint = { x: -0.02, y: -0.48, z: HULL_ROOF };
  const offset = 0.07;

  for (const side of [-1, 1]) {
    struts.push({
      from: { ...foot, x: foot.x + side * offset },
      to: { ...head, x: head.x + side * offset },
      width: 1.1,
      material: BaseMaterial.Metal,
      light: 0.8,
    });
  }

  const steps = 9;
  for (let index = 1; index < steps; index += 1) {
    const z = foot.z + ((head.z - foot.z) * index) / steps;
    struts.push({
      from: { x: foot.x - offset, y: foot.y, z },
      to: { x: foot.x + offset, y: foot.y, z },
      width: 0.9,
      material: BaseMaterial.Metal,
      light: 0.6,
    });
  }

  return struts;
};

// ─────────────────────────────────────────────────────────────────────────
// Пусковая установка
// ─────────────────────────────────────────────────────────────────────────

/**
 * Направляющая с ракетой.
 *
 * Единственная часть базы, которая не стоит вертикально, — потому
 * и задана отрезками, а не телом: у призмы нет наклона по определению.
 * Наклон почти отвесный: так она читается пусковой, а не случайной
 * палкой, и не задевает силуэт пристройки.
 */
const LAUNCH_FOOT: BasePoint = { x: 1.42, y: 0.02, z: PODIUM_TOP + 0.18 };
const LAUNCH_TIP: BasePoint = { x: 1.62, y: -0.42, z: PODIUM_TOP + 1.34 };

/** Точка на направляющей: доля пути от пяты до среза. */
const alongRail = (share: number, lift = 0): BasePoint => ({
  x: LAUNCH_FOOT.x + (LAUNCH_TIP.x - LAUNCH_FOOT.x) * share,
  y: LAUNCH_FOOT.y + (LAUNCH_TIP.y - LAUNCH_FOOT.y) * share,
  z: LAUNCH_FOOT.z + (LAUNCH_TIP.z - LAUNCH_FOOT.z) * share + lift,
});

const launcherStruts = (): BaseStrut[] => [
  {
    // Транспортно-пусковой контейнер: тёмный короб, а не палка.
    // Толстая светлая линия, которой он был сперва, читалась именно
    // палкой — на снимке это первое, за что цеплялся глаз.
    from: LAUNCH_FOOT,
    to: LAUNCH_TIP,
    width: 11,
    material: BaseMaterial.ConcreteDark,
    light: 0.85,
  },
  {
    // Светлая кромка вдоль контейнера: по ней читается, что это тело
    // с гранями, а не отрезок.
    from: alongRail(0.05, 0.02),
    to: alongRail(0.95, 0.02),
    width: 3,
    material: BaseMaterial.Metal,
    light: 0.9,
  },
  {
    // Носовая часть изделия, выступающая из контейнера. Целиком
    // рисовать ракету незачем: в контейнере её и не видно.
    from: alongRail(0.94, 0.01),
    to: { x: LAUNCH_TIP.x + 0.03, y: LAUNCH_TIP.y - 0.06, z: LAUNCH_TIP.z + 0.1 },
    width: 4,
    material: BaseMaterial.Neon,
    light: 1,
  },
  {
    // Опора: подкос от площадки к середине контейнера.
    from: { x: 1.72, y: 0.22, z: PODIUM_TOP + 0.18 },
    to: alongRail(0.35),
    width: 2.6,
    material: BaseMaterial.Metal,
    light: 0.7,
  },
  {
    // Вторая опора, ближе к пяте: без неё контейнер висит в воздухе.
    from: { x: 1.2, y: 0.24, z: PODIUM_TOP + 0.18 },
    to: alongRail(0.12),
    width: 2.6,
    material: BaseMaterial.Metal,
    light: 0.6,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Собранные наборы
// ─────────────────────────────────────────────────────────────────────────

/**
 * Штыревые антенны на кровлях.
 *
 * Мелочь, которой у сооружения связи не может не быть, и стоит она
 * двух отрезков. Заодно они разбивают ровные кромки кровель: пустая
 * горизонталь читается крышкой коробки.
 */
const whipStruts = (): BaseStrut[] =>
  [
    { x: 0.12, y: -1.5, z: HULL_ROOF + 0.17, height: 0.55 },
    { x: 1.62, y: -1.62, z: PODIUM_TOP + 0.58, height: 0.42 },
    { x: 0.5, y: -1.75, z: PODIUM_TOP + 0.58, height: 0.3 },
  ].map((whip) => ({
    from: { x: whip.x, y: whip.y, z: whip.z },
    to: { x: whip.x, y: whip.y, z: whip.z + whip.height },
    width: 1,
    material: BaseMaterial.Metal,
    light: 0.8,
  }));

export const BASE_STRUTS: readonly BaseStrut[] = [
  ...mastStruts(),
  ...guyStruts(),
  ...fenceStruts(),
  ...whipStruts(),
  ...launcherStruts(),
];

/** Огни: прожекторы по углам площадки, огни ворот, носовая точка ракеты. */
export const BASE_LIGHTS: readonly BaseLight[] = [
  { at: { x: -0.65, y: 1.75, z: PLAZA_TOP + 0.25 }, radius: 2.6, material: BaseMaterial.Neon },
  { at: { x: 0.65, y: 1.75, z: PLAZA_TOP + 0.25 }, radius: 2.6, material: BaseMaterial.Neon },
  { at: { x: 1.9, y: 1.9, z: PODIUM_TOP + 0.24 }, radius: 2, material: BaseMaterial.Neon },
  { at: { x: -1.9, y: 1.9, z: PODIUM_TOP + 0.24 }, radius: 2, material: BaseMaterial.Neon },
  {
    at: { x: LAUNCH_TIP.x + 0.04, y: LAUNCH_TIP.y - 0.08, z: LAUNCH_TIP.z + 0.14 },
    radius: 2.4,
    material: BaseMaterial.Neon,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Антенна
// ─────────────────────────────────────────────────────────────────────────

/**
 * Параболическая чаша.
 *
 * `tilt` — наклон оси от вертикали. Пятьдесят пять градусов: чаша
 * смотрит вбок и вверх, как настоящая антенна связи, а не в зенит.
 *
 * Угол выбран по снимку, а не по правдоподобию. При тридцати пяти
 * градусах чаша была обращена почти в небо, все её точки получали
 * от источника поровну, и вогнутость не читалась вовсе — на экране
 * был ровный диск. Чем сильнее наклон, тем шире расходятся нормали
 * ближнего и дальнего края, и тем яснее видно, что это чаша.
 *
 * `focus` — фокусное расстояние параболоида `z = r² / (4f)`. Мелкий
 * фокус даёт глубокую чашу, крупный — почти плоскую тарелку; 0,34
 * при радиусе 0,3 даёт узнаваемую глубину около четверти радиуса.
 */
export interface BaseDish {
  readonly centre: BasePoint;
  readonly radius: number;
  readonly focus: number;
  /** Наклон оси от вертикали, в радианах. */
  readonly tilt: number;
  /** Азимут наклона: куда «смотрит» чаша, в радианах от оси X. */
  readonly azimuth: number;
}

export const BASE_DISH: BaseDish = {
  centre: { x: MAST_X, y: MAST_Y, z: BASE_ANTENNA_HEIGHT + 0.1 },
  radius: 0.3,
  // Фокус мелкий: чаша получается глубокой, и её края отклоняются
  // от оси почти на сорок градусов. Проверено снимком — при фокусе
  // в треть клетки разброс нормалей выходил градусов в двадцать,
  // света на них попадало поровну, и чаша читалась не чашей,
  // а светлым шаром на палке.
  focus: 0.22,
  tilt: (55 * Math.PI) / 180,
  // Чаша развёрнута к зрителю: юго-восток — направление «на камеру».
  azimuth: Math.PI / 4,
};

/** Опорно-поворотное устройство: короткое тело между мачтой и чашей. */
export const BASE_DISH_MOUNT: BaseSolid = {
  label: 'опорно-поворотное устройство',
  x: MAST_X - 0.07,
  y: MAST_Y - 0.07,
  width: 0.14,
  depth: 0.14,
  base: BASE_ANTENNA_HEIGHT - 0.02,
  height: 0.14,
  material: BaseMaterial.Metal,
};

/** Точка проблескового огня: вершина мачты. */
export const BASE_BEACON: BasePoint = {
  x: MAST_X,
  y: MAST_Y,
  z: BASE_ANTENNA_HEIGHT + 0.5,
};

/**
 * Насколько высоко над центром базы поднимается верх антенны.
 *
 * Считается по чаше, а не по мачте: чаша сидит выше её вершины,
 * и полоса прочности обязана висеть выше всего сооружения целиком.
 */
export const BASE_TOP_LEVEL = BASE_BEACON.z + 0.12;
