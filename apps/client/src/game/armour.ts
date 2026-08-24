import { DIRECTION_SCALE, DIRECTION_VECTORS } from '@td/shared';
import { ELEVATION_PX_PER_CELL, VIEW_DIRECTION_3D, worldToScreen } from './iso.js';
import { MIRROR_SQUASH } from './models.js';

/**
 * Поверхность боевой машины.
 *
 * Приём тот же, которым сделаны скалы, и перенесён он сюда целиком:
 * **свет считается в каждой точке поверхности, а не на грань**. Разница
 * в том, откуда берётся нормаль. У скалы она выводится из уклона поля
 * высот; у машины поверхность задана гранями, и нормаль у грани одна
 * на всю площадь — значит, плоская заливка получилась бы снова, сколько
 * бы граней мы ни настроили.
 *
 * Отсюда два приёма, которых у скалы нет.
 *
 * **Кромка.** Каждая грань разбирается на плоскую середину и узкий поясок
 * вдоль контура, у которого нормаль отвёрнута наружу. На кромке свет
 * меняется быстро — по ребру идёт светлая нить с освещённой стороны
 * и тёмная с теневой. Ровно это отличает обработанную деталь от картонки:
 * у настоящей брони ребро не бывает бесконечно острым, оно ловит свет.
 *
 * **Гладкая нормаль по кругу.** У круглой детали нормаль берётся в углу
 * контура как среднее двух соседних граней. Свет тогда идёт по боку
 * плавно, и шестнадцатигранник читается трубой, а не гранёным столбиком.
 *
 * Оба стоят ровно ничего, потому что считаются один раз на комбинацию
 * при запекании, а не на кадре. Это тот же обмен, что и у скал: работа
 * уходит из кадра в загрузку, и там ей можно позволить в двадцать раз
 * больше треугольников, чем позволял кадр. Из-за этого же обмена машины
 * и стало возможно собрать из трёх десятков тел вместо десяти.
 *
 * ## Почему геометрия строится в местных координатах машины
 *
 * Швы бронеплит обязаны ехать вместе с машиной, а не плыть по ней при
 * развороте. Поэтому у каждой вершины, кроме экранного положения,
 * сохраняются её местные координаты — «вперёд по ходу», «вправо от хода»
 * и «вверх». По ним шейдер и раскладывает фактуру.
 */

/** Точка в местных координатах машины, в клетках. */
export interface Vec3 {
  readonly forward: number;
  readonly side: number;
  readonly up: number;
}

/**
 * Тело: два кольца вершин.
 *
 * Кольца задают выпуклое тело: боковая поверхность идёт по рёбрам между
 * ними, торцы закрывают кольца целиком. Так выражается всё, из чего
 * собраны машины: коробка — два прямоугольника, конус — два разных
 * прямоугольника, каток — два круга в плоскости борта, ствол — два круга
 * поперёк хода.
 *
 * Кольцо, а не «основание плюс высота», — потому что выдавливать вверх
 * больше не обязательно. Ствол выдавлен вдоль хода, каток — поперёк;
 * ни то ни другое прежним описанием не выражалось, и оттого ствол был
 * брусом квадратного сечения, а колесо — коробкой.
 */
export interface Solid {
  readonly label: string;
  readonly bottom: readonly Vec3[];
  readonly top: readonly Vec3[];
  /** Номер материала: индекс в палитре, см. `Material` в `machines.ts`. */
  readonly material: number;
  /** Круглое в сечении: боковая поверхность освещается плавно. */
  readonly round?: boolean;
}

/**
 * Ширина кромки, в клетках.
 *
 * Около пикселя при масштабе клетки в шестьдесят три. Меньше — и кромка
 * пропадает после уменьшения; больше — и грань перестаёт иметь плоскую
 * середину, деталь раздувается в подушку.
 */
const BEVEL_CELLS = 1.0 / 63;

/**
 * Насколько нормаль на кромке отвёрнута наружу от грани.
 *
 * Единица дала бы сорок пять градусов — честную фаску. Взято меньше:
 * фаска в сорок пять градусов на детали в шесть пикселей съедает саму
 * деталь. Три четверти дают около тридцати семи градусов — ребро ловит
 * свет, но грань остаётся гранью.
 */
const BEVEL_TILT = 0.75;

/**
 * Наибольшая доля пути к центру, на которую поясок может уйти внутрь.
 *
 * Тонкая деталь — щиток, планка решётки — уже́ двух кромок. Без
 * ограничения внутренний контур вывернулся бы наизнанку, и грань
 * свернулась бы в ленту.
 */
const MAX_INSET = 0.32;

/** Кромка: ширина в клетках, отворот нормали и предел ухода внутрь. */
export interface BevelTuning {
  readonly width: number;
  readonly tilt: number;
  readonly maxInset: number;
}

export const DEFAULT_BEVEL: BevelTuning = {
  width: BEVEL_CELLS,
  tilt: BEVEL_TILT,
  maxInset: MAX_INSET,
};

/**
 * Свойства материалов: блеск и сила блика.
 *
 * Металл узнаётся не цветом, а тем, как он отражает единственный
 * источник: у брони блик широкий и слабый, у ствола узкий и резкий,
 * у резины его нет вовсе. Разведи мы материалы только цветом — машина
 * осталась бы раскрашенной, а не собранной из разных веществ.
 *
 * Порядок соответствует `Material` из `machines.ts`.
 */
export const MATERIAL_GLOSS: readonly number[] = [20, 46, 5, 8, 110];
export const MATERIAL_SPECULAR: readonly number[] = [0.22, 0.38, 0.05, 0.12, 0.7];

/**
 * Насколько материал светится сам.
 *
 * Только маркер стороны. Он не отражает свет, а горит: это лампа,
 * а не покрашенная жесть. Без этого маркер на теневом борту уходит
 * в тень вместе с бронёй — и ровно тогда, когда он нужнее всего,
 * потому что теневой борт и так труднее опознать.
 *
 * Не единица: даже лампа немного темнеет там, где закрыта соседней
 * деталью, и полностью независимый от света маркер выглядит наклейкой,
 * лежащей поверх машины, а не её частью.
 */
export const MATERIAL_EMISSIVE: readonly number[] = [0, 0, 0, 0.8, 0];

/** Готовая сетка одной комбинации: тип, румб, ступени оружия, сторона. */
export interface ArmourMesh {
  /** Экранные координаты вершины в пикселях, начало — левый верхний угол. */
  readonly positions: Float32Array;
  /** Мировая нормаль вершины, единичная. */
  readonly normals: Float32Array;
  /** Местные координаты вершины: по ним раскладывается фактура. */
  readonly locals: Float32Array;
  /** Номер материала и удалённость от зрителя. */
  readonly surface: Float32Array;
  readonly indices: Uint32Array;
  /** Габариты в пикселях. */
  readonly width: number;
  readonly height: number;
  /** Смещение левого верхнего угла относительно точки опоры машины. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Высота модели в клетках — по ней ставится полоса здоровья. */
  readonly modelHeight: number;
}

/**
 * Пересчёт удалённости в число от нуля до единицы.
 *
 * Удалённость едет в альфа-канале промежуточного буфера, а он
 * восьмибитный: половина шкалы отдана под запас в обе стороны, потому
 * что машина занимает по глубине около половины клетки.
 *
 * Ноль означает «пусто»: очищенный буфер прозрачен, и по нулю второй
 * проход отличает фон от машины. Поэтому шкала начинается не с нуля.
 */
const DEPTH_BIAS = 0.5;
const DEPTH_SCALE = 0.5;

const depthOf = (x: number, y: number, z: number): number => {
  const depth =
    DEPTH_BIAS +
    DEPTH_SCALE * (x * VIEW_DIRECTION_3D.x + y * VIEW_DIRECTION_3D.y + z * VIEW_DIRECTION_3D.z);

  return depth < 0.02 ? 0.02 : depth > 1 ? 1 : depth;
};

/** Грань: контур в местных координатах и нормаль в каждом его углу. */
interface Face {
  readonly points: readonly Vec3[];
  readonly normals: readonly Vec3[];
  /** Гладкая грань кромки не несёт: кромка на трубе прочертила бы рёбра. */
  readonly smooth: boolean;
  /** Удалённость середины грани: по ней грани тела идут от дальней к ближней. */
  readonly depth: number;
}

const normalise = (vector: Vec3): Vec3 => {
  const norm = Math.sqrt(
    vector.forward * vector.forward + vector.side * vector.side + vector.up * vector.up,
  );

  return norm === 0
    ? { forward: 0, side: 0, up: 1 }
    : { forward: vector.forward / norm, side: vector.side / norm, up: vector.up / norm };
};

/**
 * Нормаль многоугольника по формуле Ньюэлла.
 *
 * Векторным произведением двух рёбер её взять нельзя: у шестнадцатиугольника
 * соседние рёбра почти сонаправлены, и произведение вырождается в шум.
 * Ньюэлл суммирует вклад всех рёбер и потому устойчив к этому, а заодно
 * не требует, чтобы многоугольник был идеально плоским.
 */
const newellNormal = (points: readonly Vec3[]): Vec3 => {
  let forward = 0;
  let side = 0;
  let up = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index] as Vec3;
    const next = points[(index + 1) % points.length] as Vec3;

    forward += (current.side - next.side) * (current.up + next.up);
    side += (current.up - next.up) * (current.forward + next.forward);
    up += (current.forward - next.forward) * (current.side + next.side);
  }

  return normalise({ forward, side, up });
};

const centroidOf = (points: readonly Vec3[]): Vec3 => {
  let forward = 0;
  let side = 0;
  let up = 0;
  for (const point of points) {
    forward += point.forward;
    side += point.side;
    up += point.up;
  }
  const count = points.length === 0 ? 1 : points.length;

  return { forward: forward / count, side: side / count, up: up / count };
};

/**
 * Грани одного тела: два торца и боковая поверхность.
 *
 * Куда смотрит нормаль, решает центр тела, а не порядок обхода контура.
 * Обход задаёт тот, кто описывал деталь, и полагаться на него нельзя:
 * у опрокинутого отражения он переворачивается сам собой, а у катка,
 * повёрнутого поперёк хода, зависит от того, с какой стороны смотреть.
 */
const facesOf = (solid: Solid, mirror: boolean): Face[] => {
  const flip = (point: Vec3): Vec3 =>
    mirror ? { forward: point.forward, side: point.side, up: -point.up * MIRROR_SQUASH } : point;

  const bottom = solid.bottom.map(flip);
  const top = solid.top.map(flip);
  const corners = Math.min(bottom.length, top.length);
  if (corners < 3) return [];

  const centre = centroidOf([...bottom, ...top]);

  const outward = (points: readonly Vec3[], normal: Vec3): Vec3 => {
    const middle = centroidOf(points);
    const away =
      normal.forward * (middle.forward - centre.forward) +
      normal.side * (middle.side - centre.side) +
      normal.up * (middle.up - centre.up);

    return away < 0 ? { forward: -normal.forward, side: -normal.side, up: -normal.up } : normal;
  };

  const viewDepth = (points: readonly Vec3[]): number => {
    const middle = centroidOf(points);

    return (
      middle.forward * VIEW_DIRECTION_3D.x +
      middle.side * VIEW_DIRECTION_3D.y +
      middle.up * VIEW_DIRECTION_3D.z
    );
  };

  // Нормали боковых граней считаются все, включая обращённые от зрителя:
  // круглой детали они нужны для усреднения в углу. Возьми мы среднее
  // только по видимым, на крайней грани оно вышло бы однобоким,
  // и по силуэту трубы прошла бы ступенька.
  const sideNormals: Vec3[] = [];
  for (let index = 0; index < corners; index += 1) {
    const next = (index + 1) % corners;
    const quad = [
      top[index] as Vec3,
      top[next] as Vec3,
      bottom[next] as Vec3,
      bottom[index] as Vec3,
    ];
    sideNormals.push(outward(quad, newellNormal(quad)));
  }

  const smoothAt = (index: number): Vec3 => {
    const before = sideNormals[(index - 1 + corners) % corners] as Vec3;
    const here = sideNormals[index] as Vec3;

    return normalise({
      forward: before.forward + here.forward,
      side: before.side + here.side,
      up: before.up + here.up,
    });
  };

  const faces: Face[] = [];
  const round = solid.round === true;

  const addCap = (ring: readonly Vec3[]): void => {
    const normal = outward(ring, newellNormal(ring));
    faces.push({
      points: ring,
      normals: ring.map(() => normal),
      smooth: false,
      depth: viewDepth(ring),
    });
  };

  addCap(bottom);
  addCap(top);

  for (let index = 0; index < corners; index += 1) {
    const next = (index + 1) % corners;
    const quad = [
      top[index] as Vec3,
      top[next] as Vec3,
      bottom[next] as Vec3,
      bottom[index] as Vec3,
    ];
    const normal = sideNormals[index] as Vec3;

    faces.push({
      points: quad,
      normals: round
        ? [smoothAt(index), smoothAt(next), smoothAt(next), smoothAt(index)]
        : [normal, normal, normal, normal],
      smooth: round,
      depth: viewDepth(quad),
    });
  }

  return faces;
};

/** Тело на своём месте: грани и удалённость для порядка отрисовки. */
interface PlacedSolid {
  readonly solid: Solid;
  readonly faces: readonly Face[];
  readonly depth: number;
  readonly up: number;
}

/**
 * Сборка сетки.
 *
 * Порядок тел — алгоритм художника: чем больше сумма мировых координат
 * центра, тем ближе тело к зрителю и тем позже его надо положить. Тела
 * на одном месте разводятся по высоте — башня поверх корпуса. Буфера
 * глубины здесь нет намеренно: порядок известен заранее, а буфер стоил бы
 * отдельной текстуры при запекании каждой комбинации.
 *
 * У отражения порядок по высоте переворачивается сам: у опрокинутой башни
 * середина ниже, чем у опрокинутого корпуса, и она уходит вперёд очереди.
 * Именно так отражение и выглядит.
 */
export const buildArmourMesh = (
  solids: readonly Solid[],
  facing: number,
  mirror = false,
  bevel: BevelTuning = DEFAULT_BEVEL,
): ArmourMesh => {
  const vector = DIRECTION_VECTORS[facing] ?? { x: 0, y: DIRECTION_SCALE };
  // Вектор румба приводится к единичной длине, а не просто делится
  // на масштаб. Диагональ записана как 707 при масштабе 1000, то есть
  // короче единицы на полторы сотых процента: на положении это незаметно,
  // а нормаль от такого поворота перестаёт быть единичной, и освещённость
  // диагональных румбов уезжает от освещённости прямых.
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y) || DIRECTION_SCALE;
  const forwardX = vector.x / length;
  const forwardY = vector.y / length;

  const toWorldX = (forward: number, side: number): number => forward * forwardX - side * forwardY;
  const toWorldY = (forward: number, side: number): number => forward * forwardY + side * forwardX;

  const placed: PlacedSolid[] = solids.map((solid) => {
    const centre = centroidOf([...solid.bottom, ...solid.top]);
    const worldX = toWorldX(centre.forward, centre.side);
    const worldY = toWorldY(centre.forward, centre.side);

    return {
      solid,
      faces: facesOf(solid, mirror),
      depth: worldX + worldY,
      up: mirror ? -centre.up * MIRROR_SQUASH : centre.up,
    };
  });

  placed.sort((a, b) => a.depth - b.depth || a.up - b.up);

  const positions: number[] = [];
  const normals: number[] = [];
  const locals: number[] = [];
  const surface: number[] = [];
  const indices: number[] = [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let modelHeight = 0;

  const push = (point: Vec3, normal: Vec3, material: number): number => {
    const worldX = toWorldX(point.forward, point.side);
    const worldY = toWorldY(point.forward, point.side);
    const screen = worldToScreen(worldX, worldY);
    const x = screen.x;
    const y = screen.y - point.up * ELEVATION_PX_PER_CELL;

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    positions.push(x, y);
    normals.push(
      toWorldX(normal.forward, normal.side),
      toWorldY(normal.forward, normal.side),
      normal.up,
    );
    locals.push(point.forward, point.side, point.up);
    surface.push(material, depthOf(worldX, worldY, point.up));

    return positions.length / 2 - 1;
  };

  const visible = (normal: Vec3): boolean =>
    toWorldX(normal.forward, normal.side) * VIEW_DIRECTION_3D.x +
      toWorldY(normal.forward, normal.side) * VIEW_DIRECTION_3D.y +
      normal.up * VIEW_DIRECTION_3D.z >
    0;

  for (const { solid, faces } of placed) {
    for (const point of solid.top) {
      if (point.up > modelHeight) modelHeight = point.up;
    }
    for (const point of solid.bottom) {
      if (point.up > modelHeight) modelHeight = point.up;
    }

    // Внутри тела грани идут от дальней к ближней. Тело выпукло, поэтому
    // такой порядок точен, а не приблизителен.
    for (const face of [...faces].sort((a, b) => a.depth - b.depth)) {
      const corners = face.points.length;
      if (corners < 3) continue;

      // Гладкой грани мало нормали в первом углу: у трубы крайняя грань
      // видна ребром, а среднее в одном её углу уже смотрит от зрителя.
      const shown = face.smooth
        ? face.normals.some((normal) => visible(normal))
        : visible(face.normals[0] as Vec3);
      if (!shown) continue;

      // Гладкая грань идёт как есть: кромка на ней прочертила бы рёбра
      // ровно там, где мы их только что убрали.
      if (face.smooth) {
        const ring: number[] = [];
        for (let index = 0; index < corners; index += 1) {
          ring.push(push(face.points[index] as Vec3, face.normals[index] as Vec3, solid.material));
        }
        for (let index = 1; index + 1 < corners; index += 1) {
          indices.push(ring[0] as number, ring[index] as number, ring[index + 1] as number);
        }
        continue;
      }

      const centre = centroidOf(face.points);
      const outer: number[] = [];
      const inner: number[] = [];

      for (let index = 0; index < corners; index += 1) {
        const point = face.points[index] as Vec3;
        const normal = face.normals[index] as Vec3;

        const awayForward = point.forward - centre.forward;
        const awaySide = point.side - centre.side;
        const awayUp = point.up - centre.up;
        const distance = Math.sqrt(
          awayForward * awayForward + awaySide * awaySide + awayUp * awayUp,
        );

        // Направление «наружу вдоль грани» в точке контура. Оно уже лежит
        // в плоскости грани — вычитать из него нормаль незачем: и точка,
        // и центр принадлежат грани.
        const away =
          distance === 0
            ? normal
            : {
                forward: awayForward / distance,
                side: awaySide / distance,
                up: awayUp / distance,
              };

        outer.push(
          push(
            point,
            normalise({
              forward: normal.forward + away.forward * bevel.tilt,
              side: normal.side + away.side * bevel.tilt,
              up: normal.up + away.up * bevel.tilt,
            }),
            solid.material,
          ),
        );

        const shrink =
          distance === 0 ? 0 : Math.max(1 - bevel.maxInset, 1 - bevel.width / distance);

        inner.push(
          push(
            {
              forward: centre.forward + awayForward * shrink,
              side: centre.side + awaySide * shrink,
              up: centre.up + awayUp * shrink,
            },
            normal,
            solid.material,
          ),
        );
      }

      // Плоская середина: веер из первого внутреннего угла.
      for (let index = 1; index + 1 < corners; index += 1) {
        indices.push(inner[0] as number, inner[index] as number, inner[index + 1] as number);
      }

      // Поясок: два треугольника на каждое ребро контура.
      for (let index = 0; index < corners; index += 1) {
        const next = (index + 1) % corners;
        indices.push(outer[index] as number, outer[next] as number, inner[next] as number);
        indices.push(outer[index] as number, inner[next] as number, inner[index] as number);
      }
    }
  }

  const count = positions.length / 2;
  const shifted = new Float32Array(positions.length);
  for (let index = 0; index < count; index += 1) {
    shifted[index * 2] = (positions[index * 2] as number) - minX;
    shifted[index * 2 + 1] = (positions[index * 2 + 1] as number) - minY;
  }

  return {
    positions: shifted,
    normals: new Float32Array(normals),
    locals: new Float32Array(locals),
    surface: new Float32Array(surface),
    indices: new Uint32Array(indices),
    width: Math.max(1, Math.ceil(maxX - minX)),
    height: Math.max(1, Math.ceil(maxY - minY)),
    offsetX: minX,
    offsetY: minY,
    modelHeight,
  };
};
