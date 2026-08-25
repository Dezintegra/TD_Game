import type { Solid, Vec3 } from './armour.js';

/**
 * Конструкторы тел: чем пишут описание модели.
 *
 * `armour.ts` рядом отвечает за другое — за то, чем описание **читают**:
 * сетку, кромку, нормали. Разделение не формальное. Конструктор
 * обязан быть проверяемым отдельно от сетки, а сетка — отдельно
 * от конструктора; сложи их в один модуль, и первая же попытка
 * проверить одно потянет за собой другое.
 *
 * Модуль появился, когда за телами `armour.ts` пришли постройки.
 * До этого конструкторы жили внутри `machines.ts` и там же
 * использовались; копировать их в `structures.ts` значило бы завести
 * вторую копию выдавливания и поворота — ровно тот долг, который
 * `towers.ts` однажды записал в своей шапке и который успел разойтись.
 *
 * ## Местные координаты
 *
 * `forward` — вдоль хода, к носу; `side` — вправо от хода; `up` — вверх
 * от земли. Всё в клетках. Мировых координат здесь нет вовсе: поворот
 * по румбу делает `armour.ts`, иначе каждую деталь пришлось бы задавать
 * восемь раз.
 *
 * ## Номер материала
 *
 * Материал здесь — просто число, а не перечисление. Так и должно быть:
 * у машин пятёрка веществ называется одними именами, у построек —
 * другими, а таблицы блеска и блика в `armour.ts` индексируются номером.
 * Знай этот модуль про имена — он привязал бы постройки к машинам.
 */

/** Точка плана детали: вид сверху. */
export interface Plan {
  readonly forward: number;
  readonly side: number;
}

/** Чем верх детали отличается от низа. Без него деталь — призма. */
export interface Slope {
  /** На сколько клеток верх стянут к центру. Положительное сужает кверху. */
  readonly inset?: number;
  /** Сдвиг верха вдоль хода. Им заваливается лобовой лист. */
  readonly forward?: number;
  /** Сдвиг верха поперёк хода. */
  readonly side?: number;
}

/**
 * Верхний план детали.
 *
 * Углы разъезжаются по лучам от центра, поэтому число точек и порядок
 * обхода сохраняются сами. Стягивание ограничено нулём: угол может дойти
 * до центра, но не пройти его насквозь — иначе тело вывернулось бы
 * наизнанку.
 */
const slopePlan = (plan: readonly Plan[], slope: Slope | undefined): readonly Plan[] => {
  if (slope === undefined) return plan;

  const inset = slope.inset ?? 0;
  const forward = slope.forward ?? 0;
  const side = slope.side ?? 0;
  if (inset === 0 && forward === 0 && side === 0) return plan;

  let centreForward = 0;
  let centreSide = 0;
  for (const point of plan) {
    centreForward += point.forward;
    centreSide += point.side;
  }
  centreForward /= plan.length;
  centreSide /= plan.length;

  return plan.map((point) => {
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

/** Прямоугольный план: центр, длина вдоль хода, ширина поперёк. */
export const box = (forward: number, side: number, length: number, width: number): Plan[] => {
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
 * Прямоугольником не выразить ни скошенный нос, ни развал бортов,
 * а именно они отличают технику от коробки.
 */
export const taper = (
  forward: number,
  side: number,
  length: number,
  frontWidth: number,
  backWidth: number,
): Plan[] => {
  const halfLength = length / 2;

  return [
    { forward: forward + halfLength, side: side + frontWidth / 2 },
    { forward: forward + halfLength, side: side - frontWidth / 2 },
    { forward: forward - halfLength, side: side - backWidth / 2 },
    { forward: forward - halfLength, side: side + backWidth / 2 },
  ];
};

/**
 * Углы правильного многоугольника.
 *
 * Первый угол сдвинут на половину шага намеренно. Без сдвига вершина
 * приходится точно на ось, и многоугольник читается звездой с торчащим
 * углом; со сдвигом на ось попадает середина грани.
 */
export const angles = (corners: number): number[] => {
  const step = (Math.PI * 2) / corners;
  const result: number[] = [];
  for (let index = 0; index < corners; index += 1) result.push((index + 0.5) * step);

  return result;
};

/**
 * Тело, выдавленное вверх: план внизу, он же со скосом наверху.
 *
 * Это по-прежнему самая частая форма — ею заданы корпус, башня, палуба,
 * щиток, постамент башни. Круглыми телами ниже задаются только те детали,
 * у которых ось лежит не вертикально.
 */
export const upright = (
  label: string,
  plan: readonly Plan[],
  base: number,
  height: number,
  material: number,
  slope?: Slope,
): Solid => ({
  label,
  bottom: plan.map((point) => ({ forward: point.forward, side: point.side, up: base })),
  top: slopePlan(plan, slope).map((point) => ({
    forward: point.forward,
    side: point.side,
    up: base + height,
  })),
  material,
});

/** Вертикальный цилиндр: командирская башенка, катушка, хувер, погон турели. */
export const column = (
  label: string,
  forward: number,
  side: number,
  base: number,
  radius: number,
  height: number,
  material: number,
  corners = 14,
): Solid => {
  const ring = (up: number): Vec3[] =>
    angles(corners).map((angle) => ({
      forward: forward + Math.cos(angle) * radius,
      side: side + Math.sin(angle) * radius,
      up,
    }));

  return { label, bottom: ring(base), top: ring(base + height), material, round: true };
};

/**
 * Каток: цилиндр с осью поперёк хода.
 *
 * Прежде колесо было коробкой, выдавленной вверх, потому что другого
 * выдавливания в языке тел не существовало. Разница видна сразу: у катка
 * свет обходит обод кругом, и на шести пикселях он читается колесом,
 * а не кубиком.
 */
export const roller = (
  label: string,
  forward: number,
  side: number,
  up: number,
  radius: number,
  width: number,
  material: number,
  corners = 14,
): Solid => {
  const ring = (at: number): Vec3[] =>
    angles(corners).map((angle) => ({
      forward: forward + Math.cos(angle) * radius,
      side: at,
      up: up + Math.sin(angle) * radius,
    }));

  return {
    label,
    bottom: ring(side - width / 2),
    top: ring(side + width / 2),
    material,
    round: true,
  };
};

/**
 * Труба: цилиндр с осью вдоль хода. Ею заданы стволы и хвостовая балка.
 *
 * `rise` поднимает дальний конец над ближним. Нужен он мортире: навесная
 * стрельба — это поднятый ствол, и показать её на модели иначе нечем.
 *
 * Труба при этом не поворачивается, а перекашивается: сечение остаётся
 * кругом в плоскости «поперёк — вверх». Настоящий поворот дал бы эллипс
 * в этой плоскости и потребовал бы пересчёта нормалей ради разницы,
 * которой на сорока пикселях не видно.
 */
export const tube = (
  label: string,
  fromForward: number,
  toForward: number,
  side: number,
  up: number,
  radius: number,
  material: number,
  corners = 12,
  rise = 0,
): Solid => {
  const ring = (at: number, lift: number): Vec3[] =>
    angles(corners).map((angle) => ({
      forward: at,
      side: side + Math.cos(angle) * radius,
      up: up + lift + Math.sin(angle) * radius,
    }));

  return {
    label,
    bottom: ring(fromForward, 0),
    top: ring(toForward, rise),
    material,
    round: true,
  };
};

/**
 * Плита с независимым завалом вдоль и поперёк хода.
 *
 * Отличается от `upright` со скосом ровно тем, ради чего заведена:
 * там углы стягиваются к центру **по лучу**, то есть завал вдоль
 * и поперёк связаны длиной и шириной детали и порознь не задаются.
 * Стене нужно именно порознь: прогон завален наружу по бортам
 * (иначе стена читается отвесной коробкой) и не завален по торцам —
 * торец обязан встретиться с торцом соседней клетки без ступеньки.
 */
export interface SlabShape {
  /** Центр плиты вдоль хода. */
  readonly forward: number;
  /** Центр плиты поперёк хода. */
  readonly side: number;
  /** Длина низа вдоль хода. */
  readonly length: number;
  /** Ширина низа поперёк хода. */
  readonly width: number;
  readonly base: number;
  readonly height: number;
  /** Насколько верх у́же низа вдоль хода. Считается на каждую сторону. */
  readonly taperForward?: number;
  /** То же поперёк хода. */
  readonly taperSide?: number;
}

export const slab = (label: string, shape: SlabShape, material: number): Solid => {
  const alongForward = shape.length / 2;
  const alongSide = shape.width / 2;
  const topForward = Math.max(0, alongForward - (shape.taperForward ?? 0));
  const topSide = Math.max(0, alongSide - (shape.taperSide ?? 0));

  const ring = (halfLength: number, halfWidth: number, up: number): Vec3[] => [
    { forward: shape.forward + halfLength, side: shape.side + halfWidth, up },
    { forward: shape.forward + halfLength, side: shape.side - halfWidth, up },
    { forward: shape.forward - halfLength, side: shape.side - halfWidth, up },
    { forward: shape.forward - halfLength, side: shape.side + halfWidth, up },
  ];

  return {
    label,
    bottom: ring(alongForward, alongSide, shape.base),
    top: ring(topForward, topSide, shape.base + shape.height),
    material,
  };
};
