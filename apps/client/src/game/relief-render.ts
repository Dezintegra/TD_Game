import { Geometry, GlProgram, Mesh, RenderTexture, Shader, Sprite, Texture } from 'pixi.js';
import type { Container, Renderer } from 'pixi.js';
import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS } from '@td/shared';
import type { GameMap } from '@td/sim';
import { GRAIN_SLOPE_SCALE, GRAIN_TILE_PIXELS, buildGrainTile } from './grain.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import { diagonalCells } from './prism.js';
import { GRAIN_TILE_CELLS, fbm, isRockCell, surfaceHeight, wideHeight } from './relief.js';

/**
 * Отрисовка скальной клетки: сетка вершин плюс свет в каждом пикселе.
 *
 * Работа поделена по частоте, и в этом весь смысл. Дорогое сглаживание
 * высот по тридцати шести соседям считается в ВЕРШИНАХ, которых на клетку
 * около шестисот; свет считается в ПИКСЕЛЯХ, которых там же около
 * четырнадцати тысяч. Наоборот было бы в двадцать пять раз дороже,
 * и именно так стоил образцовый расчёт: полторы секунды на сорок две
 * клетки.
 *
 * Фактуры на видеокарте нет: её уклон лежит готовым в замощаемой плитке
 * (`grain.ts`), шейдер только складывает его с уклоном геометрии.
 *
 * Шейдер написан под WebGL. Приложение поднимается на нём же — `app.init`
 * в `scene.ts` предпочтения не задаёт, а по умолчанию PixiJS v8 берёт
 * WebGL. Если предпочтение однажды сменят на WebGPU, сюда понадобится
 * второй вариант программы на WGSL, и об этом лучше узнать из этого
 * комментария, чем из чёрного экрана.
 */

/** Сколько квадратов на сторону клетки. */
const RESOLUTION = 24;

/** Освещение то же, что у всего остального на поле (`prism.ts`). */
const AMBIENT = 0.34;
const LIGHT: readonly [number, number, number] = [0.72 - AMBIENT, 0.48 - AMBIENT, 1 - AMBIENT];

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aWorld;
in vec2 aSlope;
in vec2 aShade;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vWorld;
out vec2 vSlope;
out vec2 vShade;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vWorld = aWorld;
  vSlope = aSlope;
  vShade = aShade;
}`;

const FRAGMENT = `#version 300 es
precision highp float;

in vec2 vWorld;
in vec2 vSlope;
in vec2 vShade;

uniform sampler2D uGrain;
uniform vec3 uLight;
uniform vec3 uRock;
uniform float uAmbient;
uniform float uGrainScale;
uniform float uTileCells;

out vec4 fragColor;

void main() {
  // Плитка хранит уклон фактуры, а не яркость: половина шкалы — ноль.
  vec2 grain = (texture(uGrain, vWorld / uTileCells).rg * 2.0 - 1.0) * uGrainScale;
  vec2 slope = vSlope + grain;

  vec3 normal = normalize(vec3(-slope.x, -slope.y, 1.0));
  float lit = min(1.0, uAmbient + max(0.0, dot(normal, uLight)));

  // Часть затенения приходит из вершины, часть зависит от наклона в точке.
  float ao = clamp(vShade.x + 0.20 * normal.z, 0.50, 1.0);
  float key = lit * ao;

  // Освещённый камень чуть теплее, затенённый чуть холоднее.
  float warm = clamp((lit - uAmbient) * 1.4, 0.0, 1.0);
  vec3 base = uRock + vec3(16.0, 10.0, 2.0) / 255.0 * warm;

  fragColor = vec4(base * vShade.y * key, 1.0);
}`;

/** Плитка фактуры как текстура. Строится один раз на запуск. */
let grainTexture: Texture | undefined;

const ensureGrainTexture = (): Texture => {
  if (grainTexture !== undefined) return grainTexture;

  const tile = buildGrainTile(GRAIN_TILE_PIXELS);
  const canvas = document.createElement('canvas');
  canvas.width = tile.size;
  canvas.height = tile.size;

  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('нет двумерного контекста для плитки фактуры');
  // Копия, а не сама плитка: `ImageData` требует массив, которым владеет
  // сам, и на общем буфере конструктор не сходится по типам.
  const image = ctx.createImageData(tile.size, tile.size);
  image.data.set(tile.pixels);
  ctx.putImageData(image, 0, 0);

  grainTexture = Texture.from(canvas);
  // Замощение: плитка обязана повторяться, иначе за её краем растянется
  // последний пиксель и по карте пойдёт полоса.
  grainTexture.source.addressMode = 'repeat';
  grainTexture.source.scaleMode = 'linear';

  return grainTexture;
};

/** Освободить плитку. Нужна при смене палитры и при выходе из матча. */
export const disposeGrainTexture = (): void => {
  grainTexture?.destroy(true);
  grainTexture = undefined;
};

export interface CellMesh {
  // Тип с параметрами: по умолчанию `Mesh` это `Mesh<MeshGeometry,
  // TextureShader>`, а у нас и геометрия, и шейдер свои.
  readonly mesh: Mesh<Geometry, Shader>;
  /** Габариты спрайта в пикселях. */
  readonly width: number;
  readonly height: number;
  /** Смещение спрайта относительно проекции угла клетки. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Сетка одной скальной клетки.
 *
 * Позиции вершин лежат в пикселях спрайта, а не мира: клетка запекается
 * в свою маленькую текстуру, и начало координат у неё своё.
 */
export const buildCellMesh = (
  map: GameMap,
  cellX: number,
  cellY: number,
  rock: number,
): CellMesh => {
  // Нахлёст на соседа. Спрайты соседних клеток не стыкуются пиксель
  // в пиксель — по границам проступают тёмные швы, — поэтому сетка
  // заходит на шаг за край ТУДА, ГДЕ СОСЕД ТОЖЕ СКАЛА. За край массива
  // она не выходит: там высота нулевая, и нахлёст оставил бы каменную
  // бахрому на проходимой клетке.
  const west = isRockCell(map, cellX - 1, cellY) ? 1 : 0;
  const east = isRockCell(map, cellX + 1, cellY) ? 1 : 0;
  const north = isRockCell(map, cellX, cellY - 1) ? 1 : 0;
  const south = isRockCell(map, cellX, cellY + 1) ? 1 : 0;

  const columns = RESOLUTION + 1 + west + east;
  const rows = RESOLUTION + 1 + north + south;
  const count = columns * rows;

  const world = new Float32Array(count * 2);
  const slope = new Float32Array(count * 2);
  const shade = new Float32Array(count * 2);
  const screen = new Float32Array(count * 2);

  const step = 1 / RESOLUTION;
  const differential = 0.02;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const u = cellX + (column - west) * step;
      const v = cellY + (row - north) * step;

      const height = surfaceHeight(map, u, v);
      const point = worldToScreen(u, v);
      const x = point.x;
      const y = point.y - height * ELEVATION_PX_PER_CELL;

      screen[index * 2] = x;
      screen[index * 2 + 1] = y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      world[index * 2] = u;
      world[index * 2 + 1] = v;

      slope[index * 2] =
        (surfaceHeight(map, u + differential, v) - surfaceHeight(map, u - differential, v)) /
        (2 * differential);
      slope[index * 2 + 1] =
        (surfaceHeight(map, u, v + differential) - surfaceHeight(map, u, v - differential)) /
        (2 * differential);

      // Затенение без слагаемого от наклона: его добавит шейдер в точке.
      shade[index * 2] = 0.7 + (height - wideHeight(map, u, v) * 0.9) * 0.55;
      // Крупная неоднородность породы. Частота низкая (3,8 на клетку
      // против 24 у крошки), поэтому вершин хватает и в плитку её класть
      // незачем — она считается тут же, на процессоре.
      shade[index * 2 + 1] = 0.84 + 0.3 * fbm(u * 3.8, v * 3.8, 3, 3);
    }
  }

  const position = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    position[index * 2] = (screen[index * 2] ?? 0) - minX;
    position[index * 2 + 1] = (screen[index * 2 + 1] ?? 0) - minY;
  }

  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  let cursor = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = row * columns + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;

      indices[cursor] = topLeft;
      indices[cursor + 1] = topRight;
      indices[cursor + 2] = bottomLeft;
      indices[cursor + 3] = topRight;
      indices[cursor + 4] = bottomRight;
      indices[cursor + 5] = bottomLeft;
      cursor += 6;
    }
  }

  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer: position, format: 'float32x2' },
      aWorld: { buffer: world, format: 'float32x2' },
      aSlope: { buffer: slope, format: 'float32x2' },
      aShade: { buffer: shade, format: 'float32x2' },
    },
    indexBuffer: indices,
  });

  const shader = new Shader({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT }),
    resources: {
      uGrain: ensureGrainTexture().source,
      reliefUniforms: {
        uLight: { value: new Float32Array(LIGHT), type: 'vec3<f32>' },
        // Цвет берётся из палитры, а не зашит числом: правило проекта —
        // цвета только через переменные `tokens.css`.
        uRock: {
          value: new Float32Array([
            ((rock >> 16) & 255) / 255,
            ((rock >> 8) & 255) / 255,
            (rock & 255) / 255,
          ]),
          type: 'vec3<f32>',
        },
        uAmbient: { value: AMBIENT, type: 'f32' },
        uGrainScale: { value: GRAIN_SLOPE_SCALE, type: 'f32' },
        uTileCells: { value: GRAIN_TILE_CELLS, type: 'f32' },
      },
    },
  });

  return {
    mesh: new Mesh({ geometry, shader }),
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY),
    offsetX: minX,
    offsetY: minY,
  };
};

/** Запечь клетку в текстуру. Вызывается один раз на клетку за матч. */
export const bakeCell = (renderer: Renderer, target: RenderTexture, cell: CellMesh): void => {
  renderer.render({ container: cell.mesh, target, clear: true });
};

/**
 * Снять слой скал и освободить его текстуры.
 *
 * Уничтожать обязательно, и это не педантизм: текстура клетки живёт
 * в видеопамяти, а сборщик мусора о видеопамяти не знает. Слой снимается
 * при каждой смене карты, то есть каждый матч, — утечка накапливалась бы
 * матч за матчем.
 */
export const clearRockLayer = (layer: Container): void => {
  for (const child of layer.removeChildren()) {
    if (child instanceof Sprite) child.texture.destroy(true);
    child.destroy();
  }
};

/**
 * Разложить скалы одной диагонали по слою.
 *
 * Диагональ — единица слоя, а не только группировки: между диагоналями
 * сцена вклинивает подвижные объекты, иначе юнит за скалой рисовался бы
 * поверх неё. Клетки внутри диагонали друг друга не перекрывают, поэтому
 * порядок между ними безразличен.
 */
export const mountRockDiagonal = (
  layer: Container,
  renderer: Renderer,
  map: GameMap,
  diagonal: number,
  rock: number,
): void => {
  clearRockLayer(layer);

  for (const [x, y] of diagonalCells(MAP_WIDTH_CELLS, MAP_HEIGHT_CELLS, diagonal)) {
    if (!isRockCell(map, x, y)) continue;

    const cell = buildCellMesh(map, x, y, rock);
    const texture = RenderTexture.create({
      width: cell.width,
      height: cell.height,
      resolution: 1,
      antialias: true,
    });

    bakeCell(renderer, texture, cell);
    // Сетка больше не нужна: всё, что она умела, лежит в текстуре.
    cell.mesh.destroy(true);

    const sprite = new Sprite(texture);
    sprite.position.set(cell.offsetX, cell.offsetY);
    layer.addChild(sprite);
  }
};
