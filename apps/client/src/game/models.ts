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

/**
 * Скос детали: чем верхнее основание отличается от нижнего.
 *
 * Вторым списком точек верх не задаётся намеренно. Два списка обязаны
 * совпадать по числу точек и по порядку обхода, и ничто, кроме
 * внимательности, этого не гарантирует: разъедься они — тело свернулось
 * бы в ленту молча, без единой ошибки. Три числа же не дают ошибиться
 * по построению.
 */
interface Slope {
  /**
   * На сколько клеток верх стянут к центру основания.
   * Положительное сужает кверху, отрицательное расширяет.
   */
  readonly inset?: number;
  /** Сдвиг верха вдоль хода. Им заваливается лобовой лист. */
  readonly forward?: number;
  /** Сдвиг верха поперёк хода. */
  readonly side?: number;
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
  /** Чем верх отличается от низа. Без него деталь — призма. */
  readonly top?: Slope;
  /**
   * Готовое верхнее основание. Заполняется только там, где скос уже
   * вычислен и описанием его больше не выразить, — у опрокинутых
   * деталей отражения, где верх и низ меняются местами.
   */
  readonly topShape?: readonly LocalPoint[];
}

/**
 * Верхнее основание детали.
 *
 * Углы разъезжаются по лучам от центра основания, поэтому число точек
 * и порядок обхода сохраняются сами. Стягивание ограничено нулём: угол
 * может дойти до центра, но не пройти его насквозь — иначе тело
 * вывернулось бы наизнанку и грани посмотрели бы внутрь.
 */
const topFootprintOf = (part: Part): readonly LocalPoint[] => {
  if (part.topShape !== undefined) return part.topShape;

  const slope = part.top;
  if (slope === undefined) return part.shape;

  const inset = slope.inset ?? 0;
  const forward = slope.forward ?? 0;
  const side = slope.side ?? 0;
  if (inset === 0 && forward === 0 && side === 0) return part.shape;

  let centreForward = 0;
  let centreSide = 0;
  for (const point of part.shape) {
    centreForward += point.forward;
    centreSide += point.side;
  }
  centreForward /= part.shape.length;
  centreSide /= part.shape.length;

  return part.shape.map((point) => {
    const alongForward = point.forward - centreForward;
    const alongSide = point.side - centreSide;
    const distance = Math.sqrt(alongForward * alongForward + alongSide * alongSide);
    const keep = distance === 0 ? 0 : Math.max(0, 1 - inset / distance);

    return {
      forward: centreForward + alongForward * keep + forward,
      side: centreSide + alongSide * keep + side,
    };
  });
};

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

/**
 * Правильный многоугольник: им задаются круглые в плане детали.
 *
 * Круга в нашем языке тел нет и быть не может: `solidFaces` строит
 * по грани на ребро и требует выпуклого основания. Восьмигранник
 * на десяти пикселях от круга неотличим, а стоит ровно столько же,
 * сколько коробка, — одно тело.
 *
 * Первый угол сдвинут на половину шага намеренно. Без сдвига вершина
 * приходится точно на ось, и восьмигранник читается звездой с торчащим
 * углом; со сдвигом ось попадает на середину грани, и он читается
 * кольцом — а кольцом ему и надо читаться.
 */
const disc = (forward: number, side: number, radius: number, corners = 8): LocalPoint[] => {
  const points: LocalPoint[] = [];
  const step = (Math.PI * 2) / corners;

  for (let index = 0; index < corners; index += 1) {
    const angle = (index + 0.5) * step;

    points.push({
      forward: forward + Math.cos(angle) * radius,
      side: side + Math.sin(angle) * radius,
    });
  }

  return points;
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

/**
 * Колесо. Тёмное и утопленное в борт: на экране это деталь в шесть пикселей.
 *
 * Слабый скос кверху заменяет колесу округлость. Отвесная коробка на шести
 * пикселях читается кубиком, а стянутый верх ловит свет иначе, чем борт,
 * и та же коробка начинает читаться скатом. Стягивание задано долей ширины,
 * а не числом: колёса у трёх шасси разного размера, и общее число сделало бы
 * маленькое колесо конусом, а большое — почти отвесным.
 */
const wheel = (forward: number, side: number, radius: number, width: number): Part => ({
  label: 'колесо',
  shape: box(forward, side, radius * 2, width),
  base: 0,
  height: radius * 1.7,
  material: Material.Tread,
  top: { inset: width * 0.22 },
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
 * с вынесенным далеко вперёд стволом; Тесла — тяжёлая
 * шестиколёсная с короткой толстой мортирой; штурмовик — средний
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
        // Развал бортов. При высоте 0,125 стягивание в 0,03 даёт наклон
        // около 13 градусов — борт светлеет примерно на шестую часть
        // и перестаёт сливаться с бортом соседней машины.
        top: { inset: 0.03 },
      },
      {
        label: 'моторный отсек',
        shape: taper(0.26, 0, 0.16, 0.19, 0.26),
        base: 0.072,
        height: 0.075,
        material: Material.Hull,
        outline: true,
        // Верх сдвинут НАЗАД, а не вперёд: так лобовой лист заваливается
        // внутрь, как ему и положено. Сдвинь мы верх вперёд — получился бы
        // козырёк, нависающий над носом, а это облик грузовика, не брони.
        top: { inset: 0.02, forward: -0.025 },
      },
      {
        label: 'башня',
        shape: box(-0.05, 0, 0.19, 0.21),
        base: 0.197,
        height: 0.09,
        material: Material.Hull,
        outline: true,
        // Самый сильный скос на машине, и это не украшение: башня стои́т
        // вплотную к моторному отсеку и одного с ним оттенка, поэтому
        // отличать их приходится форме. Конус от коробки отличим
        // и на сорока пикселях.
        top: { inset: 0.04 },
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
        // Развал сильнее, чем у штурмовика: корпус снайпера низкий,
        // и при малой высоте только заметный наклон отличает его борт
        // от плоской полосы.
        top: { inset: 0.026 },
      },
      {
        label: 'носовой клин',
        shape: taper(0.3, 0, 0.16, 0.1, 0.19),
        base: 0.06,
        height: 0.055,
        material: Material.Hull,
        outline: true,
        // Самый сильный завал носа из трёх машин: 0,028 при высоте 0,055
        // это около 27 градусов. Острый скошенный нос — то, по чему
        // снайпера узнают раньше, чем разглядят длину ствола.
        top: { inset: 0.012, forward: -0.028 },
      },
      {
        label: 'башня',
        shape: box(-0.12, 0, 0.16, 0.17),
        base: 0.155,
        height: 0.07,
        material: Material.Hull,
        outline: true,
        top: { inset: 0.03 },
      },
    ],
    // Ствол вынесен далеко вперёд и тонок: дальность снайпера должна
    // читаться с поля раньше, чем игрок наведёт на него курсор.
    mount: { forward: -0.04, axis: 0.175, length: 0.52, calibre: 0.028 },
  },

  [UnitType.Tesla]: {
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
        // Корпус самый высокий из трёх, поэтому стягивание больше
        // по величине, а наклон — тот же: важно не число, а угол.
        top: { inset: 0.038 },
      },
      {
        label: 'отвал',
        shape: taper(0.27, 0, 0.12, 0.3, 0.34),
        base: 0.082,
        height: 0.06,
        material: Material.Hull,
        outline: true,
        // Отвал завален назад сильно и почти не сужается: это широкий
        // щит, а не клин. Наклон у него от бульдозерного ножа, и по нему
        // тяжёлая машина узнаётся прежде, чем сосчитаны колёса.
        top: { inset: 0.01, forward: -0.03 },
      },
      {
        label: 'башня',
        shape: box(-0.05, 0, 0.25, 0.27),
        base: 0.232,
        height: 0.115,
        material: Material.Hull,
        outline: true,
        // Крупная и коническая. Мортира выходит из неё коротким толстым
        // стволом, и без сужения башня читалась бы вторым корпусом,
        // поставленным сверху.
        top: { inset: 0.05 },
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
// Ударный вертолёт генерала
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
 * Полклетки, а не больше: выше — и разрыв между машиной и отражением
 * становится таким, что машина перестаёт читаться связанной с местом,
 * над которым висит.
 */
export const GENERAL_ALTITUDE = 0.5;

/**
 * Машина генерала — ударный вертолёт, а не самолёт.
 *
 * Разница здесь не в украшении, а в обещании. Самолёт обещает скорость
 * и пролёт мимо; генерал же висит над полем, ждёт, строит вокруг себя
 * и отходит. Висение обещает винтокрылая машина — и это про него правда.
 *
 * Пропорции сняты с Ка-50 и пересчитаны в доли длины корпуса, а не
 * подобраны на глаз. На сорока пикселях силуэт узнаётся не деталями —
 * их там нет, — а отношением длин: длинная тонкая хвостовая балка при
 * коротком широком корпусе. Ошибись в этом отношении вдвое, и вертолёт
 * снова станет самолётом, сколько деталей на него ни навесь.
 *
 * Верхнего винта нет намеренно. У винта ровно два состояния, и оба
 * плохи: неподвижный читается поломкой (глаз знает, что вертолёт
 * с остановленным винтом падает), а вращающийся требует пересчёта
 * геометрии на каждом кадре — то есть выхода за кеш силуэтов, который
 * ключуется румбом и стороной и знать «какой сейчас кадр» не может.
 * Подъём вместо винта дают два боковых хувера на концах пилонов,
 * и отсутствие винта само по себе служит признаком: взгляд ищет,
 * чем машина держится, и находит их.
 */
const GUNSHIP_PARTS: readonly Part[] = [
  {
    label: 'киль',
    shape: taper(-0.415, 0, 0.11, 0.02, 0.028),
    base: GENERAL_ALTITUDE + 0.075,
    height: 0.125,
    material: Material.Hull,
    outline: true,
    // Киль скошен назад: верх сдвинут против хода. Стреловидность
    // здесь не украшение — киль высокий и узкий, и отвесным он читается
    // мачтой антенны, то есть деталью базы, а не машины.
    top: { inset: 0.004, forward: -0.028 },
  },
  {
    label: 'стабилизатор',
    shape: box(-0.38, 0, 0.07, 0.19),
    base: GENERAL_ALTITUDE + 0.052,
    height: 0.018,
    material: Material.Hull,
    // Окантовки нет: полоска в два пикселя, обведённая неоном,
    // превращается в светящуюся чёрточку поперёк хвоста.
    top: { inset: 0.005 },
  },
  {
    label: 'хвостовая балка',
    shape: taper(-0.27, 0, 0.36, 0.075, 0.035),
    base: GENERAL_ALTITUDE + 0.045,
    height: 0.045,
    material: Material.Hull,
    outline: true,
    // Балка чуть длиннее кабины и вдвое сужается к хвосту. Это главная
    // мерка вертолёта: укороти балку или удлини кабину — и получится
    // самолёт, сколько деталей на него ни навесь.
    top: { inset: 0.01 },
  },
  {
    label: 'кабина',
    shape: taper(0.1, 0, 0.34, 0.13, 0.17),
    base: GENERAL_ALTITUDE,
    height: 0.125,
    material: Material.Hull,
    outline: true,
    // Кабина коробчатая и высокая, к носу сужается. Ударный вертолёт
    // узнают по тому, что тело у него короткое и высокое, а хвост
    // длинный и тонкий, — отношение важнее любой детали.
    top: { inset: 0.024 },
  },
  {
    label: 'носовая часть',
    shape: taper(0.35, 0, 0.18, 0.03, 0.13),
    base: GENERAL_ALTITUDE + 0.015,
    height: 0.062,
    material: Material.Hull,
    outline: true,
    // Нос низкий, острый и завален внутрь — клин, а не конус.
    // Опущенный нос перед высокой кабиной и есть та поза, по которой
    // ударную машину отличают от транспортной.
    top: { inset: 0.012, forward: -0.02 },
  },
  {
    label: 'фонарь кабины',
    shape: taper(0.19, 0, 0.17, 0.05, 0.1),
    base: GENERAL_ALTITUDE + 0.125,
    height: 0.052,
    material: Material.Gun,
    outline: true,
    // Единственная деталь светлого материала: она притягивает взгляд
    // первой и потому обязана стоять там, где у машины перёд.
    top: { inset: 0.018, forward: -0.014 },
  },
  {
    label: 'левый пилон',
    shape: [
      { forward: 0.07, side: -0.07 },
      { forward: -0.03, side: -0.07 },
      { forward: -0.025, side: -0.215 },
      { forward: 0.045, side: -0.215 },
    ],
    base: GENERAL_ALTITUDE + 0.045,
    height: 0.024,
    material: Material.Hull,
    // Окантовки нет намеренно: пилон — это перемычка между кабиной
    // и хувером, и обведённый неоном он спорит с ними обоими.
    top: { inset: 0.005 },
  },
  {
    label: 'правый пилон',
    shape: [
      { forward: 0.045, side: 0.215 },
      { forward: -0.025, side: 0.215 },
      { forward: -0.03, side: 0.07 },
      { forward: 0.07, side: 0.07 },
    ],
    base: GENERAL_ALTITUDE + 0.045,
    height: 0.024,
    material: Material.Hull,
    top: { inset: 0.005 },
  },
  {
    label: 'левый хувер',
    shape: disc(0.01, -0.265, 0.085),
    base: GENERAL_ALTITUDE + 0.022,
    height: 0.055,
    material: Material.Hull,
    outline: true,
    // Борт отвесный, без стягивания: хувер обязан читаться кольцом,
    // а стянутый кверху восьмигранник читается стаканом.
  },
  {
    label: 'правый хувер',
    shape: disc(0.01, 0.265, 0.085),
    base: GENERAL_ALTITUDE + 0.022,
    height: 0.055,
    material: Material.Hull,
    outline: true,
  },
  {
    label: 'свечение левого хувера',
    shape: disc(0.01, -0.265, 0.048),
    base: GENERAL_ALTITUDE + 0.077,
    height: 0.007,
    material: Material.Neon,
  },
  {
    label: 'свечение правого хувера',
    shape: disc(0.01, 0.265, 0.048),
    base: GENERAL_ALTITUDE + 0.077,
    height: 0.007,
    material: Material.Neon,
  },
];

/**
 * Тени у генерала нет, и это решение, а не упущение.
 *
 * Она была: плоское пятно под машиной, отмечавшее клетку, вокруг которой
 * считается радиус строительства. После того как поле стало слабым
 * зеркалом, пятно оказалось рядом с отражением — и обе отметки вышли
 * приглушённо-зелёными почти одной яркости: тень на земле `rgb(28,41,28)`,
 * верхняя грань отражения `rgb(24,48,27)`. Читались они не как «тень
 * и отражение», а как одно отражение, продублированное со сдвигом.
 *
 * Покраской это не чинится. Земля у нас `#191919`, то есть 25 из 255:
 * вниз остаётся 25 единиц, и тень, отличимая от земли, обязана уйти
 * почти в чёрный — а тогда она читается дырой в поверхности. Приём
 * «затемнить поверхность» рассчитан на светлую поверхность, наша тёмная
 * по замыслу.
 *
 * Точную клетку игрок получает там, где она ему нужна: окружность
 * радиуса строительства рисуется вокруг положения генерала в момент
 * выбора места под постройку — см. `drawBuildRadius` в `overlays.ts`.
 */

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
  /**
   * Верхнее основание в мировых координатах. У детали без скоса — та же
   * ссылка, что и нижнее: `solidFaces` узнаёт призму по совпадению ссылок
   * и не проецирует одни и те же точки дважды.
   */
  readonly topFootprint: readonly FootprintPoint[];
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
    const localTop = topFootprintOf(part);
    // Совпадение по ссылке означает «скоса нет» и передаётся дальше как есть.
    const topFootprint =
      localTop === part.shape ? footprint : localTop.map((point) => toWorld(point, facing));

    let sum = 0;
    for (const point of footprint) sum += point.x + point.y;

    return {
      part,
      footprint,
      topFootprint,
      depth: footprint.length === 0 ? 0 : sum / footprint.length,
    };
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

  for (const { part, footprint, topFootprint } of placed) {
    const faces = solidFaces(footprint, part.height, part.base, topFootprint);
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
  parts.map((part) => {
    // У скошенной детали при опрокидывании верх становится низом:
    // то основание, что было наверху, оказывается ближе всего
    // к поверхности. Поэтому основания меняются местами.
    //
    // Обратного скоса тут не изобрести: стягивание нелинейно — у него
    // есть ограничение нулём, — и описания, возвращающего верх обратно
    // в низ, в общем случае не существует. Значит, скос нужно вычислить
    // в готовое основание до опрокидывания, что и делается.
    //
    // У детали без скоса оба основания остаются одной и той же ссылкой,
    // поэтому отражение отвесного тела не меняется ничем.
    const upper = topFootprintOf(part);

    return {
      label: part.label,
      shape: upper,
      topShape: part.shape,
      base: -(part.base + part.height) * MIRROR_SQUASH,
      height: part.height * MIRROR_SQUASH,
      material: part.material,
      outline: false,
    };
  });

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

/** Силуэт машины генерала. */
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

  const built = buildSilhouette(GUNSHIP_PARTS, rumb, colors, side);
  generalCache[index] = built;
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

/** Отражение машины генерала. */
export const generalReflection = (
  colors: ModelColors,
  side: number,
  facing: number,
): Silhouette => {
  ensurePalette(colors);

  const index = normaliseFacing(facing) * SIDE_COUNT + side;

  const cached = generalMirrorCache[index];
  if (cached !== undefined) return cached;

  const built = buildReflection(GUNSHIP_PARTS, normaliseFacing(facing), colors, side);
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
  unitMirrorCache.fill(undefined);
  generalMirrorCache.fill(undefined);
};
