import {
  Container,
  Geometry,
  GlProgram,
  Graphics,
  Mesh,
  RenderTexture,
  Shader,
  Sprite,
  Texture,
} from 'pixi.js';
import type { Renderer } from 'pixi.js';
import {
  CONCRETE_SLOPE_SCALE,
  CONCRETE_TILE_CELLS,
  CONCRETE_TILE_PIXELS,
  SEAM_PITCH_ACROSS,
  SEAM_PITCH_ALONG,
  buildConcreteTile,
} from './concrete.js';
import { ELEVATION_PX_PER_CELL, VIEW_DIRECTION_3D, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import { blend, shade } from './prism.js';
import { SKY_STRENGTH } from './relief-render.js';
import {
  BASE_DISH,
  BASE_DISH_MOUNT,
  BASE_LIGHTS,
  BASE_SOLIDS,
  BASE_STRUTS,
  BaseMaterial,
} from './base-model.js';
import type { BaseDecal, BasePoint, BaseSolid, BaseStrut } from './base-model.js';

/**
 * Отрисовка командного центра: меш, шейдер материала, запекание.
 *
 * Приём взят у скал (`relief-render.ts`) и перенесён на другую
 * геометрию. У камня поверхность непрерывна, и нормаль берётся
 * из уклона поля высот; у постройки грани плоские, и нормаль каждой
 * известна заранее. Общее — главное: свет считается В ПИКСЕЛЕ,
 * а фактура живёт в нормали и не входит в геометрию.
 *
 * Что делает запекание законным: база неподвижна и неизменна. Она стои́т
 * готовой с нулевого тика, возводиться ей нечего, а разрушение означает
 * конец матча.
 *
 * Шейдер написан под WebGL — приложение поднимается на нём (`app.init`
 * в `scene.ts` предпочтения не задаёт, а PixiJS v8 по умолчанию берёт
 * WebGL). Смена на WebGPU потребует второго варианта на WGSL, и узнать
 * об этом лучше отсюда, чем из чёрного экрана.
 */

/** Цвета, из которых выводятся все оттенки модели. */
export interface BaseColors {
  /** Бетон: основной материал сооружения. */
  readonly concrete: number;
  /** Металл: ограждения, ферма, направляющая. */
  readonly metal: number;
  /** Цвет стороны. */
  readonly accent: number;
  /** Холодный свет неба. Тот же, что у скал: источник один на мир. */
  readonly sky: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Порядок тел
// ─────────────────────────────────────────────────────────────────────────

interface Bounds {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly z0: number;
  readonly z1: number;
}

const boundsOf = (solid: BaseSolid): Bounds => ({
  x0: solid.x,
  x1: solid.x + solid.width,
  y0: solid.y,
  y1: solid.y + solid.depth,
  z0: solid.base,
  z1: solid.base + solid.height,
});

/** Допуск на числа с плавающей точкой: тела стыкуются впритык. */
const TOUCH = 1e-6;

/**
 * Насколько тела должны перекрываться, чтобы считаться пересекающимися,
 * в клетках.
 *
 * Ноль здесь не годится, и это выяснилось на живой модели. Основание
 * мачты задевало карниз корпуса на полторы сотых клетки — меньше
 * пикселя на экране, — и этого хватало, чтобы правило сочло их стоящими
 * друг над другом и расставило по высоте вместо удалённости. Дальше
 * порядок сомкнулся в кольцо.
 *
 * Пять сотых клетки — это три экранных пикселя: перекрытие, которого
 * не видно, порядка и не требует.
 */
const MIN_OVERLAP = 0.05;

/** Перекрываются ли отрезки настолько, чтобы это было видно. */
const overlaps = (from: number, to: number, otherFrom: number, otherTo: number): boolean =>
  Math.min(to, otherTo) - Math.max(from, otherFrom) > MIN_OVERLAP;

/** Стоит ли тело `upper` на теле `lower`: проекции пересекаются, высоты нет. */
export const standsOn = (upper: BaseSolid, lower: BaseSolid): boolean => {
  const first = boundsOf(upper);
  const second = boundsOf(lower);

  return (
    overlaps(first.x0, first.x1, second.x0, second.x1) &&
    overlaps(first.y0, first.y1, second.y0, second.y1) &&
    second.z1 <= first.z0 + TOUCH
  );
};

/** Удалённость тела от зрителя: сумма координат его середины. */
export const depthOf = (solid: BaseSolid): number =>
  solid.x + solid.width / 2 + (solid.y + solid.depth / 2);

/**
 * Порядок отрисовки тел.
 *
 * Буфера глубины нет: перекрытие задаёт порядок треугольников. Ключ
 * из двух чисел — **уровень, на котором тело стои́т, и удалённость
 * от зрителя**, — и оба нужны.
 *
 * Одной удалённости мало, и это не мелочь: подиум охватывает собой всю
 * площадку, и по середине он оказывается ближе стоящего на нём корпуса,
 * то есть закрыл бы его собой. Уровень опоры это чинит: подиум лежит
 * ниже всего, что на нём стоит, и потому рисуется первым.
 *
 * Одного уровня тоже мало: тела на общем подиуме надо расставить между
 * собой, и решает это удалённость — чем ближе к зрителю, тем позже.
 *
 * ## Почему не отношение «кто кого перекрывает»
 *
 * Первые две версии строили граф попарных отношений и сортировали его
 * топологически. Обе дали ЦИКЛ, и оба цикла состояли из звеньев,
 * каждое из которых по отдельности верно:
 *
 * - тумба ворот западнее пристройки (значит дальше) и южнее её
 *   (значит ближе);
 * - плац раньше тумбы (тумба на нём стои́т), тумба раньше пусковой
 *   (пусковая ближе), пусковая раньше плаца (плац южнее).
 *
 * Это не ошибки реализации, а свойство самого приёма: попарное
 * «кто кого перекрывает» на телах общей площадки в кольцо сходится
 * закономерно. Ключ сходиться в кольцо не может по построению.
 *
 * Цена — пары, у которых ключ даёт не тот порядок, что перекрытие:
 * низкая деталь у зрителя и высокая вдали. Такие пары на экране
 * расходятся и друг друга не задевают, поэтому цена нулевая. Что
 * важные случаи — стоящее на теле после самого тела — ключ соблюдает,
 * закреплено тестом.
 */
export const orderSolids = (solids: readonly BaseSolid[]): readonly BaseSolid[] =>
  [...solids].sort((a, b) => a.base - b.base || depthOf(a) - depthOf(b));

// ─────────────────────────────────────────────────────────────────────────
// Грани
// ─────────────────────────────────────────────────────────────────────────

/** Направление в пространстве модели. */
interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Грань меша.
 *
 * `surface` — координаты точки на поверхности, в клетках: по ним
 * берётся фактура и считаются швы. У стены это путь вдоль неё
 * и высота, у кровли — мировые координаты; масштаб один и тот же,
 * поэтому бетон на стене и на крыше остаётся одним материалом.
 */
export interface Face {
  readonly points: readonly BasePoint[];
  readonly surface: readonly (readonly [number, number])[];
  readonly normal: Vector3;
  /** Касательная вдоль первой координаты поверхности. */
  readonly tangent: Vector3;
  readonly tint: number;
  /** Сила шума фактуры, сила швов, признак свечения. */
  readonly style: readonly [number, number, number];
}

const normalise = (vector: Vector3): Vector3 => {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;

  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
};

/** Видна ли грань зрителю. Взгляд объёмный: скошенная грань видна и сверху. */
const facesViewer = (normal: Vector3): boolean =>
  normal.x * VIEW_DIRECTION_3D.x + normal.y * VIEW_DIRECTION_3D.y + normal.z * VIEW_DIRECTION_3D.z >
  0;

/**
 * Оттенки материалов.
 *
 * Доля цвета стороны меньше, чем у башен, и это то же правило,
 * доведённое до конца: чем крупнее тело, тем меньше в нём цвета
 * стороны. База — самое крупное тело на поле, и залей её неоном,
 * поле превратилось бы в два светящихся пятна с боем посередине.
 */
const materialTints = (colors: BaseColors): readonly number[] => [
  blend(colors.concrete, colors.accent, 0.05),
  shade(blend(colors.concrete, colors.accent, 0.04), 0.6),
  blend(colors.metal, colors.accent, 0.1),
  colors.accent,
];

/** Сила фактуры и швов по материалу. */
const materialStyles: readonly (readonly [number, number, number])[] = [
  [1, 1, 0],
  [1, 1, 0],
  // У металла своей крупной фактуры нет: он гладкий, и швы опалубки
  // на нём читались бы ошибкой.
  [0.4, 0, 0],
  [0, 0, 1],
];

/**
 * Грани одного тела.
 *
 * Строятся только видимые: из шести граней зритель видит три —
 * верхнюю, восточную и южную, — и это прямое следствие того, что
 * камера не поворачивается. Скос (`taper`) может добавить видимости
 * заваленной кверху грани, поэтому решает не сторона света, а проверка
 * нормали.
 *
 * Порядок внутри тела — боковые, потом верхняя. У них общее ребро,
 * и при сглаживании вдоль него получаются полупрозрачные пиксели:
 * нарисуй верхнюю раньше, они смешаются с фоном и по ребру пойдёт
 * тёмная нитка.
 */
const solidToFaces = (solid: BaseSolid, colors: BaseColors): Face[] => {
  const tints = materialTints(colors);
  const tint = tints[solid.material] ?? tints[0] ?? 0;
  const style = materialStyles[solid.material] ?? materialStyles[0];

  const taper = solid.taper ?? 0;
  const x0 = solid.x;
  const x1 = solid.x + solid.width;
  const y0 = solid.y;
  const y1 = solid.y + solid.depth;
  const z0 = solid.base;
  const z1 = solid.base + solid.height;

  // Верхнее основание ужато скосом с каждой стороны.
  const tx0 = x0 + taper;
  const tx1 = x1 - taper;
  const ty0 = y0 + taper;
  const ty1 = y1 - taper;

  const faces: Face[] = [];
  const height = solid.height || 1;

  /** Боковая грань: нижнее ребро, верхнее ребро, нормаль, координаты. */
  const side = (
    bottomFrom: BasePoint,
    bottomTo: BasePoint,
    topFrom: BasePoint,
    topTo: BasePoint,
    normal: Vector3,
    along: (point: BasePoint) => number,
    tangent: Vector3,
  ): void => {
    const unit = normalise(normal);
    if (!facesViewer(unit)) return;

    const points = [topFrom, topTo, bottomTo, bottomFrom];

    faces.push({
      points,
      surface: points.map((point) => [along(point), point.z] as const),
      normal: unit,
      tangent: normalise(tangent),
      tint,
      style: style ?? [1, 1, 0],
    });
  };

  if (solid.height > 0) {
    // Восток: нормаль наружу по +x, завалена кверху на величину скоса.
    side(
      { x: x1, y: y0, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: tx1, y: ty0, z: z1 },
      { x: tx1, y: ty1, z: z1 },
      { x: height, y: 0, z: taper },
      (point) => point.y,
      { x: 0, y: 1, z: 0 },
    );
    // Юг: нормаль по +y.
    side(
      { x: x0, y: y1, z: z0 },
      { x: x1, y: y1, z: z0 },
      { x: tx0, y: ty1, z: z1 },
      { x: tx1, y: ty1, z: z1 },
      { x: 0, y: height, z: taper },
      (point) => point.x,
      { x: 1, y: 0, z: 0 },
    );
    // Запад и север видны только у сильно заваленных тел, но проверяются
    // так же: судить о видимости по стороне света значило бы держать
    // знание о проекции в двух местах.
    side(
      { x: x0, y: y1, z: z0 },
      { x: x0, y: y0, z: z0 },
      { x: tx0, y: ty1, z: z1 },
      { x: tx0, y: ty0, z: z1 },
      { x: -height, y: 0, z: taper },
      (point) => point.y,
      { x: 0, y: 1, z: 0 },
    );
    side(
      { x: x1, y: y0, z: z0 },
      { x: x0, y: y0, z: z0 },
      { x: tx1, y: ty0, z: z1 },
      { x: tx0, y: ty0, z: z1 },
      { x: 0, y: -height, z: taper },
      (point) => point.x,
      { x: 1, y: 0, z: 0 },
    );
  }

  const top: BasePoint[] = [
    { x: tx0, y: ty0, z: z1 },
    { x: tx1, y: ty0, z: z1 },
    { x: tx1, y: ty1, z: z1 },
    { x: tx0, y: ty1, z: z1 },
  ];

  faces.push({
    points: top,
    surface: top.map((point) => [point.x, point.y] as const),
    normal: { x: 0, y: 0, z: 1 },
    tangent: { x: 1, y: 0, z: 0 },
    tint,
    style: style ?? [1, 1, 0],
  });

  return faces;
};

/**
 * Наклейка как грань.
 *
 * Наклейки не освещаются и фактуры не несут: они мелкие, лежат
 * на известной автору грани, и яркость у них задана. Свет им считать
 * значило бы получить окно, потемневшее вместе со стеной, — а окно
 * светится само.
 */
const decalToFace = (decal: BaseDecal, colors: BaseColors): Face => {
  const tints = materialTints(colors);
  const tint = tints[decal.material] ?? tints[0] ?? 0;

  return {
    points: decal.points,
    surface: decal.points.map((point) => [point.x, point.y] as const),
    normal: { x: 0, y: 0, z: 1 },
    tangent: { x: 1, y: 0, z: 0 },
    tint: shade(tint, decal.light),
    style: [0, 0, 1],
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Чаша антенны
// ─────────────────────────────────────────────────────────────────────────

/** Сколько колец и секторов у сетки чаши. */
const DISH_RINGS = 8;
const DISH_SECTORS = 24;

/** Базис чаши: ось и две касательные. Наклон и азимут заданы моделью. */
const dishBasis = (): { axis: Vector3; along: Vector3; across: Vector3 } => {
  const { tilt, azimuth } = BASE_DISH;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const cosAz = Math.cos(azimuth);
  const sinAz = Math.sin(azimuth);

  return {
    axis: { x: sinTilt * cosAz, y: sinTilt * sinAz, z: cosTilt },
    along: { x: cosTilt * cosAz, y: cosTilt * sinAz, z: -sinTilt },
    across: { x: -sinAz, y: cosAz, z: 0 },
  };
};

/** Точка чаши по местным координатам её плоскости. */
const dishPoint = (u: number, v: number): BasePoint => {
  const { axis, along, across } = dishBasis();
  const depth = (u * u + v * v) / (4 * BASE_DISH.focus);
  const { centre } = BASE_DISH;

  return {
    x: centre.x + along.x * u + across.x * v + axis.x * depth,
    y: centre.y + along.y * u + across.y * v + axis.y * depth,
    z: centre.z + along.z * u + across.z * v + axis.z * depth,
  };
};

/**
 * Нормаль чаши в точке.
 *
 * Считается аналитически: у параболоида `z = (u² + v²) / 4f` нормаль
 * внутренней стороны равна `(-u / 2f, -v / 2f, 1)`. Ради этого чаша
 * и строится поверхностью — вогнутость читается только тем, что
 * ближняя её часть обращена к источнику, а дальняя от него, и заливкой
 * одним цветом это не сообщить никак.
 */
const dishNormal = (u: number, v: number): Vector3 => {
  const { axis, along, across } = dishBasis();
  const nu = -u / (2 * BASE_DISH.focus);
  const nv = -v / (2 * BASE_DISH.focus);

  return normalise({
    x: along.x * nu + across.x * nv + axis.x,
    y: along.y * nu + across.y * nv + axis.y,
    z: along.z * nu + across.z * nv + axis.z,
  });
};

const dishFaces = (colors: BaseColors): Face[] => {
  const tints = materialTints(colors);
  const metal = tints[BaseMaterial.Metal] ?? 0;
  const faces: Face[] = [];
  const { radius } = BASE_DISH;
  const { along } = dishBasis();

  for (let ring = 0; ring < DISH_RINGS; ring += 1) {
    const inner = (radius * ring) / DISH_RINGS;
    const outer = (radius * (ring + 1)) / DISH_RINGS;

    for (let sector = 0; sector < DISH_SECTORS; sector += 1) {
      const from = (2 * Math.PI * sector) / DISH_SECTORS;
      const to = (2 * Math.PI * (sector + 1)) / DISH_SECTORS;

      const corners: readonly (readonly [number, number])[] = [
        [inner * Math.cos(from), inner * Math.sin(from)],
        [outer * Math.cos(from), outer * Math.sin(from)],
        [outer * Math.cos(to), outer * Math.sin(to)],
        [inner * Math.cos(to), inner * Math.sin(to)],
      ];

      const middleU = (corners[0]?.[0] ?? 0) + (corners[2]?.[0] ?? 0);
      const middleV = (corners[0]?.[1] ?? 0) + (corners[2]?.[1] ?? 0);
      const normal = dishNormal(middleU / 2, middleV / 2);

      faces.push({
        points: corners.map(([u, v]) => dishPoint(u, v)),
        surface: corners.map(([u, v]) => [u, v] as const),
        normal,
        tangent: along,
        // Чаша ТЕМНЕЕ конструкции, а не светлее, и это поправка
        // по снимку. Светлый металл на полном свету плюс свет неба
        // выходил за белое: чаша превращалась в пятно, в котором
        // никакой вогнутости уже не различить.
        tint: shade(metal, 0.72),
        style: [0.3, 0, 0],
      });
    }
  }

  return faces;
};

/**
 * Обод, облучатель и подкосы — линиями.
 *
 * Обод замкнут по краю чаши, облучатель висит в фокусе на трёх
 * подкосах. Без них чаша читается воронкой: именно облучатель
 * сообщает, что это антенна, а не тарелка.
 */
const dishStruts = (): BaseStrut[] => {
  const struts: BaseStrut[] = [];
  const { radius, focus } = BASE_DISH;
  const { axis } = dishBasis();
  const rim = (angle: number): BasePoint =>
    dishPoint(radius * Math.cos(angle), radius * Math.sin(angle));

  for (let sector = 0; sector < DISH_SECTORS; sector += 1) {
    struts.push({
      from: rim((2 * Math.PI * sector) / DISH_SECTORS),
      to: rim((2 * Math.PI * (sector + 1)) / DISH_SECTORS),
      width: 1.6,
      material: BaseMaterial.Metal,
      light: 0.95,
    });
  }

  // Рёбра жёсткости от середины чаши к ободу. Без них чаша остаётся
  // просто пятном нужной формы; с ними она читается собранной
  // конструкцией — тем же приёмом узнаётся и сама мачта.
  for (let spoke = 0; spoke < 6; spoke += 1) {
    const angle = (2 * Math.PI * spoke) / 6;

    struts.push({
      from: dishPoint(0, 0),
      to: rim(angle),
      width: 1,
      material: BaseMaterial.Metal,
      light: 0.55,
      alpha: 0.7,
    });
  }

  // Облучатель стои́т в фокусе параболоида — там, куда чаша сводит
  // приходящий сигнал. Точка считается, а не подбирается: фокус задан
  // самой формой чаши.
  const feed: BasePoint = {
    x: BASE_DISH.centre.x + axis.x * focus,
    y: BASE_DISH.centre.y + axis.y * focus,
    z: BASE_DISH.centre.z + axis.z * focus,
  };

  for (const angle of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    struts.push({
      from: rim(angle),
      to: feed,
      width: 1.2,
      material: BaseMaterial.Metal,
      light: 0.8,
    });
  }

  return struts;
};

/** Точка облучателя: её же подсвечивает огонёк. */
const dishFeed = (): BasePoint => {
  const { axis } = dishBasis();

  return {
    x: BASE_DISH.centre.x + axis.x * BASE_DISH.focus,
    y: BASE_DISH.centre.y + axis.y * BASE_DISH.focus,
    z: BASE_DISH.centre.z + axis.z * BASE_DISH.focus,
  };
};

// ─────────────────────────────────────────────────────────────────────────
// Сборка меша
// ─────────────────────────────────────────────────────────────────────────

/** Экранная точка модели: проекция плюс подъём по высоте. */
export const modelToScreen = (point: BasePoint): Point => {
  const flat = worldToScreen(point.x, point.y);

  return { x: flat.x, y: flat.y - point.z * ELEVATION_PX_PER_CELL };
};

/** Все грани модели в порядке отрисовки. Вынесено ради тестов. */
export const buildFaces = (colors: BaseColors): readonly Face[] => {
  const faces: Face[] = [];

  for (const solid of orderSolids(BASE_SOLIDS)) {
    faces.push(...solidToFaces(solid, colors));
    // Фактура идёт сразу за своей деталью и до следующей: деталь,
    // стоящая ближе, обязана закрыть её собой.
    for (const decal of solid.decals ?? []) faces.push(decalToFace(decal, colors));
  }

  // Антенна рисуется последней: она выше всего сооружения, и закрыть
  // её нечем.
  faces.push(...solidToFaces(BASE_DISH_MOUNT, colors));
  faces.push(...dishFaces(colors));

  return faces;
};

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec3 aNormal;
in vec3 aTangent;
in vec2 aSurface;
in vec3 aTint;
in vec3 aStyle;
in float aHeight;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec3 vNormal;
out vec3 vTangent;
out vec2 vSurface;
out vec3 vTint;
out vec3 vStyle;
out float vHeight;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vNormal = aNormal;
  vTangent = aTangent;
  vSurface = aSurface;
  vTint = aTint;
  vStyle = aStyle;
  vHeight = aHeight;
}`;

const FRAGMENT = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vTangent;
in vec2 vSurface;
in vec3 vTint;
in vec3 vStyle;
in float vHeight;

uniform sampler2D uGrain;
uniform vec3 uLight;
uniform vec3 uSky;
uniform float uAmbient;
uniform float uSkyStrength;
uniform float uGrainScale;
uniform float uTileCells;
uniform vec2 uSeamPitch;
uniform float uSeamWidth;
uniform float uSeamDepth;
uniform float uContactFloor;
uniform float uContactHeight;

out vec4 fragColor;

// Уклон гауссовой канавки. Профиль гладкий намеренно: у канавки
// с изломом уклон меняется скачком, и шов получает жёсткую светлую
// нитку по одному краю и чёрную по другому.
float grooveSlope(float distance) {
  float ratio = distance / uSeamWidth;

  return (2.0 * uSeamDepth * distance / (uSeamWidth * uSeamWidth)) * exp(-ratio * ratio);
}

float toNearestSeam(float coordinate, float pitch) {
  return (fract(coordinate / pitch) - 0.5) * pitch;
}

void main() {
  // Светящаяся деталь не освещается: окно светит само, и потемнеть
  // вместе со стеной оно не может.
  if (vStyle.z > 0.5) {
    fragColor = vec4(vTint, 1.0);
    return;
  }

  vec3 normal = normalize(vNormal);
  vec3 tangent = normalize(vTangent);
  vec3 bitangent = cross(normal, tangent);

  // Плитка хранит уклон фактуры, а не яркость: половина шкалы — ноль.
  vec2 grain = (texture(uGrain, vSurface / uTileCells).rg * 2.0 - 1.0) * uGrainScale * vStyle.x;
  vec2 seam = vec2(
    grooveSlope(toNearestSeam(vSurface.x, uSeamPitch.x)),
    grooveSlope(toNearestSeam(vSurface.y, uSeamPitch.y))
  ) * vStyle.y;

  vec2 slope = grain + seam;
  vec3 shaped = normalize(normal - slope.x * tangent - slope.y * bitangent);

  float lit = min(1.0, uAmbient + max(0.0, dot(shaped, uLight)));
  vec3 colour = vTint * lit;

  // Второй источник — небо. Тот же, что у скал: рассеянный свет сверху,
  // тем больший, чем ближе поверхность к горизонтальной.
  colour += uSky * (uSkyStrength * max(0.0, shaped.z));

  // Потемнение у основания. Настоящий бетон у земли темнее: там
  // и грязь, и тень от собственного цоколя. Без этого сооружение
  // выглядит приклеенным к полю, а не стоящим на нём.
  //
  // Высота берётся отдельным атрибутом, а не из координат поверхности:
  // у кровли вторая координата — мировая ордината, и потемнение по ней
  // залило бы половину крыши тенью без всякой причины. Кровли оно
  // и не касается вовсе — множитель гаснет вместе с отвесностью грани.
  float ground = mix(uContactFloor, 1.0, clamp(vHeight / uContactHeight, 0.0, 1.0));
  float upright = 1.0 - abs(shaped.z);
  colour *= mix(1.0, ground, upright);

  fragColor = vec4(colour, 1.0);
}`;

/** Освещение то же, что у всего остального на поле (`prism.ts`). */
const AMBIENT = 0.34;
const LIGHT: readonly [number, number, number] = [0.72 - AMBIENT, 0.48 - AMBIENT, 1 - AMBIENT];

/** Насколько темнее бетон у самой земли и на какой высоте это сходит на нет. */
const CONTACT_FLOOR = 0.72;
const CONTACT_HEIGHT = 0.4;

/** Ширина и глубина канавки шва. Те же числа, что в образцовой реализации. */
const SEAM_WIDTH = 0.022;
const SEAM_DEPTH = 0.012;

/** Плитка фактуры как текстура. Строится один раз на запуск. */
let concreteTexture: Texture | undefined;

const ensureConcreteTexture = (): Texture => {
  if (concreteTexture !== undefined) return concreteTexture;

  const tile = buildConcreteTile(CONCRETE_TILE_PIXELS);
  const canvas = document.createElement('canvas');
  canvas.width = tile.size;
  canvas.height = tile.size;

  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('нет двумерного контекста для плитки бетона');
  const image = ctx.createImageData(tile.size, tile.size);
  image.data.set(tile.pixels);
  ctx.putImageData(image, 0, 0);

  concreteTexture = Texture.from(canvas);
  concreteTexture.source.addressMode = 'repeat';
  concreteTexture.source.scaleMode = 'linear';

  return concreteTexture;
};

/** Освободить плитку. Нужна при смене палитры и при выходе из матча. */
export const disposeConcreteTexture = (): void => {
  concreteTexture?.destroy(true);
  concreteTexture = undefined;
};

const toRgb = (color: number): Float32Array =>
  new Float32Array([((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255]);

const buildMesh = (faces: readonly Face[], colors: BaseColors): Mesh<Geometry, Shader> => {
  const vertexCount = faces.reduce((sum, face) => sum + face.points.length, 0);
  const position = new Float32Array(vertexCount * 2);
  const normal = new Float32Array(vertexCount * 3);
  const tangent = new Float32Array(vertexCount * 3);
  const surface = new Float32Array(vertexCount * 2);
  const tint = new Float32Array(vertexCount * 3);
  const style = new Float32Array(vertexCount * 3);
  const height = new Float32Array(vertexCount);
  const indices: number[] = [];

  let cursor = 0;

  for (const face of faces) {
    const first = cursor;

    face.points.forEach((point, index) => {
      const screen = modelToScreen(point);
      const uv = face.surface[index] ?? [0, 0];

      position[cursor * 2] = screen.x;
      position[cursor * 2 + 1] = screen.y;
      normal[cursor * 3] = face.normal.x;
      normal[cursor * 3 + 1] = face.normal.y;
      normal[cursor * 3 + 2] = face.normal.z;
      tangent[cursor * 3] = face.tangent.x;
      tangent[cursor * 3 + 1] = face.tangent.y;
      tangent[cursor * 3 + 2] = face.tangent.z;
      surface[cursor * 2] = uv[0];
      surface[cursor * 2 + 1] = uv[1];
      tint[cursor * 3] = ((face.tint >> 16) & 255) / 255;
      tint[cursor * 3 + 1] = ((face.tint >> 8) & 255) / 255;
      tint[cursor * 3 + 2] = (face.tint & 255) / 255;
      style[cursor * 3] = face.style[0];
      style[cursor * 3 + 1] = face.style[1];
      style[cursor * 3 + 2] = face.style[2];
      height[cursor] = point.z;
      cursor += 1;
    });

    // Веер: грани выпуклые, и разбивать их иначе незачем.
    for (let index = 1; index + 1 < face.points.length; index += 1) {
      indices.push(first, first + index, first + index + 1);
    }
  }

  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer: position, format: 'float32x2' },
      aNormal: { buffer: normal, format: 'float32x3' },
      aTangent: { buffer: tangent, format: 'float32x3' },
      aSurface: { buffer: surface, format: 'float32x2' },
      aTint: { buffer: tint, format: 'float32x3' },
      aStyle: { buffer: style, format: 'float32x3' },
      aHeight: { buffer: height, format: 'float32' },
    },
    indexBuffer: new Uint32Array(indices),
  });

  const shader = new Shader({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT }),
    resources: {
      uGrain: ensureConcreteTexture().source,
      baseUniforms: {
        uLight: { value: new Float32Array(LIGHT), type: 'vec3<f32>' },
        // Цвет неба приходит из палитры, а не зашит числом: правило
        // проекта — цвета только через переменные `tokens.css`.
        uSky: { value: toRgb(colors.sky), type: 'vec3<f32>' },
        uAmbient: { value: AMBIENT, type: 'f32' },
        uSkyStrength: { value: SKY_STRENGTH, type: 'f32' },
        uGrainScale: { value: CONCRETE_SLOPE_SCALE, type: 'f32' },
        uTileCells: { value: CONCRETE_TILE_CELLS, type: 'f32' },
        uSeamPitch: {
          value: new Float32Array([SEAM_PITCH_ALONG, SEAM_PITCH_ACROSS]),
          type: 'vec2<f32>',
        },
        uSeamWidth: { value: SEAM_WIDTH, type: 'f32' },
        uSeamDepth: { value: SEAM_DEPTH, type: 'f32' },
        uContactFloor: { value: CONTACT_FLOOR, type: 'f32' },
        uContactHeight: { value: CONTACT_HEIGHT, type: 'f32' },
      },
    },
  });

  return new Mesh({ geometry, shader });
};

// ─────────────────────────────────────────────────────────────────────────
// Конструкция линиями
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ферма, оттяжки, ограждение и огни.
 *
 * Рисуются ПОСЛЕ меша и глубины не знают: `Graphics` кладётся поверх.
 * Ровно поэтому в модели ограждение идёт по ближним кромкам площадки,
 * а лестница стои́т перед фасадом, а не заподлицо с ним, — иначе линия
 * прошла бы по стене, за которой ей полагается прятаться.
 */
const drawStruts = (graphics: Graphics, colors: BaseColors): void => {
  const tints = materialTints(colors);

  for (const strut of [...BASE_STRUTS, ...dishStruts()]) {
    const from = modelToScreen(strut.from);
    const to = modelToScreen(strut.to);
    const tint = tints[strut.material] ?? tints[0] ?? 0;

    graphics
      .moveTo(from.x, from.y)
      .lineTo(to.x, to.y)
      .stroke({
        width: strut.width,
        color: shade(tint, strut.light),
        alpha: strut.alpha ?? 1,
      });
  }

  for (const light of [
    ...BASE_LIGHTS,
    { at: dishFeed(), radius: 2, material: BaseMaterial.Neon },
  ]) {
    const at = modelToScreen(light.at);
    const tint = tints[light.material] ?? tints[0] ?? 0;

    graphics.circle(at.x, at.y, light.radius).fill({ color: tint });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Запекание
// ─────────────────────────────────────────────────────────────────────────

/** Запас по краю текстуры: линии имеют толщину, а огни — радиус. */
const BAKE_MARGIN_PX = 10;

interface BaseBounds {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

/** Габарит модели на экране. Считается по всему, что рисуется. */
export const baseScreenBounds = (): BaseBounds => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const account = (point: BasePoint): void => {
    const screen = modelToScreen(point);
    minX = Math.min(minX, screen.x);
    maxX = Math.max(maxX, screen.x);
    minY = Math.min(minY, screen.y);
    maxY = Math.max(maxY, screen.y);
  };

  for (const solid of [...BASE_SOLIDS, BASE_DISH_MOUNT]) {
    for (const dx of [0, solid.width]) {
      for (const dy of [0, solid.depth]) {
        for (const dz of [0, solid.height]) {
          account({ x: solid.x + dx, y: solid.y + dy, z: solid.base + dz });
        }
      }
    }
  }

  for (const strut of [...BASE_STRUTS, ...dishStruts()]) {
    account(strut.from);
    account(strut.to);
  }

  for (const light of BASE_LIGHTS) account(light.at);

  for (let sector = 0; sector < DISH_SECTORS; sector += 1) {
    const angle = (2 * Math.PI * sector) / DISH_SECTORS;
    account(dishPoint(BASE_DISH.radius * Math.cos(angle), BASE_DISH.radius * Math.sin(angle)));
  }

  return {
    minX: minX - BAKE_MARGIN_PX,
    minY: minY - BAKE_MARGIN_PX,
    width: Math.ceil(maxX - minX) + 2 * BAKE_MARGIN_PX,
    height: Math.ceil(maxY - minY) + 2 * BAKE_MARGIN_PX,
  };
};

/**
 * Построить спрайт командного центра.
 *
 * Считается один раз на базу при загрузке карты. Меш и линии рисуются
 * в одну текстуру одним проходом, после чего меш уничтожается: всё,
 * что он умел, лежит в текстуре.
 *
 * Плотность приходит снаружи, из общего расчёта (`bake-density.ts`).
 * Раньше здесь стояла единица, и база мылила на плотном экране так же,
 * как и скалы, — при том что стоящие рядом постройки не мылили.
 */
export const bakeBase = (renderer: Renderer, colors: BaseColors, density: number): Sprite => {
  const bounds = baseScreenBounds();
  const mesh = buildMesh(buildFaces(colors), colors);

  const struts = new Graphics();
  drawStruts(struts, colors);

  const stage = new Container();
  stage.addChild(mesh, struts);
  stage.position.set(-bounds.minX, -bounds.minY);

  const texture = RenderTexture.create({
    width: bounds.width,
    height: bounds.height,
    resolution: density,
    antialias: true,
  });

  renderer.render({ container: stage, target: texture, clear: true });
  mesh.destroy(true);
  struts.destroy(true);

  const sprite = new Sprite(texture);
  sprite.position.set(bounds.minX, bounds.minY);

  return sprite;
};

/**
 * Поставить базу в слой.
 *
 * Слой тот же, в котором лежат спрайты скал этой диагонали: порядок
 * перекрытия от этого не меняется, а заводить базе свой слой на каждую
 * из девяноста пяти диагоналей значило бы платить за пустоту.
 */
export const mountBase = (
  layer: Container,
  renderer: Renderer,
  centreX: number,
  centreY: number,
  colors: BaseColors,
  density: number,
): void => {
  const sprite = bakeBase(renderer, colors, density);
  const anchor = worldToScreen(centreX, centreY);

  sprite.position.set(sprite.position.x + anchor.x, sprite.position.y + anchor.y);
  layer.addChild(sprite);
};
