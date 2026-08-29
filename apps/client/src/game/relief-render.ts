import { Geometry, GlProgram, Mesh, RenderTexture, Shader, Sprite, Texture } from 'pixi.js';
import type { Container, Renderer } from 'pixi.js';
import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS } from '@td/shared';
import type { GameMap } from '@td/sim';
import { GRAIN_SLOPE_SCALE, GRAIN_TILE_PIXELS, buildGrainTile } from './grain.js';
import { ELEVATION_PX_PER_CELL, screenToWorld, worldToScreen } from './iso.js';
import { diagonalCells } from './prism.js';
import {
  GRAIN_TILE_CELLS,
  fbm,
  isRockCell,
  rockCoverage,
  surfaceHeight,
  wideHeight,
} from './relief.js';

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

/**
 * Сила света неба.
 *
 * Держится скромной намеренно. Небо здесь не второе солнце, а поправка:
 * его задача — не осветить теневую сторону, а перестать делать её
 * одинаковой. Заметно больше — и массив теряет объём, потому что разница
 * между обращённым к источнику и отвёрнутым от него смазывается.
 */
export const SKY_STRENGTH = 0.18;

/**
 * Разброс неоднородности породы: множитель яркости от `TONE_BASE`
 * до `TONE_BASE + TONE_RANGE`.
 *
 * Сумма ровно единица, и это не совпадение, а правило: **токен
 * `--td-rock` задаёт цвет камня на полном свету, и отрисовка не имеет
 * права его превышать.** Множитель больше единицы означал бы, что
 * палитра говорит одно, а поле показывает другое.
 *
 * Поймано проверкой. Сначала здесь стояли 0,84 и 0,3, то есть максимум
 * 1,14; вместе с тёплой добавкой и светом неба самый яркий камень
 * выходил на 72 процента яркости против 51 у токена. На картинке это
 * читалось светлым песком, который спорит с полем за внимание, —
 * при том что замысел требует от скал обратного.
 */
export const TONE_BASE = 0.72;
export const TONE_RANGE = 0.28;

/**
 * Сила отражения гряды в поле — у самой поверхности.
 *
 * Больше, чем `MIRROR_STRENGTH` у боевых машин, и это не рассогласование,
 * а следствие того, что зеркало у них общее, а отражается в нём разное.
 *
 * Замерено 23.08.2026 прямо по запечённой текстуре. Освещённая порода
 * даёт яркость около 100 из 255, земля — 25. При доле 0,22 отражение
 * ложится на 29 — то есть на четыре уровня выше земли, что не видно
 * ни на каком мониторе. Машина того же не требует: её отражение лежит
 * вплотную под ярким неоновым силуэтом, и глазу есть на что опереться,
 * а гряда стоит посреди пустого поля.
 *
 * При 0,55 отражение у подножия выходит около 66 — заметно, но заметно
 * бледнее самой породы (около 100), то есть отражением и читается.
 * Значения 0,42 оказалось мало: на картинке отражение вышло на 40 против
 * 26 у земли и терялось, стоило отойти от монитора.
 *
 * Одной этой доли, однако, мало: она задаёт только КРАЙ у поверхности.
 */
export const ROCK_MIRROR_STRENGTH = 0.34;

/**
 * Насколько быстро отражение слабеет с глубиной.
 *
 * Отражение вершины лежит дальше от поверхности, чем отражение подножия,
 * а поле — зеркало неидеальное: чем дальше отражённое от него, тем
 * сильнее рассеивается отражённый свет. Без этого затухания получается
 * ровная по яркости копия гряды, поставленная вверх ногами, и она
 * читается второй грядой, растущей вниз, — то есть дырой в поле.
 *
 * Делитель `1 + h · k` при k = 0,35 оставляет у подножия единицу,
 * на высоте клетки — три четверти, у самого высокого пика (2,05 клетки) —
 * примерно три пятых. Ровно тот порядок, который нужен: отражение тает
 * кверху, а не обрывается. Более крутое затухание (0,55) съедало
 * отражение вершин целиком, и в поле оставались отражаться одни подножия.
 */
const MIRROR_DEPTH_FADE = 1.15;

/**
 * Насколько сплюснуто отражение гряды.
 *
 * Единица — то есть не сплюснуто вовсе, честное зеркало. И это единственное
 * место, где отражение поля расходится с отражением боевых машин
 * (`MIRROR_SQUASH`, одна вторая). Расхождение вынужденное, и вот его
 * причина.
 *
 * Отражение точки высоты `h` лежит на `h · s · ELEVATION` ниже её опоры.
 * Клетка же и сама занимает на экране полосу: её ромб уходит вниз
 * от центра на 34 пикселя. При `s = 1/2` пик в две клетки отражается
 * на 52 пикселя вниз — то есть высовывается из-под собственной горы
 * на 18 пикселей и виден полоской. Проверено картинкой: полоска и вышла.
 *
 * Машине сплюснутость нужна по обратной причине: её отражение в полную
 * длину — это чёткая копия небольшого тела, и она читается второй машиной,
 * стоящей вниз головой. Гряда крупная, матовая и гаснет с глубиной,
 * так что перепутать её отражение с горой, растущей вниз, невозможно.
 *
 * Иначе говоря, сплюснутость у машин — это лекарство от чёткости,
 * а у гряды чёткости нет, зато есть затухание. Лекарство лишнее,
 * а болезнь — невидимое отражение — вполне настоящая.
 */
const ROCK_MIRROR_SQUASH = 0.62;

/**
 * Насколько сглажена поверхность в отражении.
 *
 * Поле — зеркало неровное, и отражение в нём не бывает таким же чётким,
 * как отражаемое. Отражённая гряда с полной фактурой читается не бликом
 * на поверхности, а второй грядой под ней: у неё те же складки, то же
 * зерно, тот же рисунок света.
 *
 * Размывать по-настоящему было бы дорого — это ещё один проход
 * по текстуре на каждую клетку. Тот же итог даёт сглаживание самой
 * поверхности: уклон в отражении берётся вчетверо слабее, и подробности
 * освещения тают, а общее пятно и его яркость остаются на месте.
 */
const MIRROR_SOFTEN = 0.4;

/**
 * Сколько клетки занимает растворение отражения у края поля.
 *
 * Отражение обязано жить только там, где под ним есть поле. Обрежь его
 * по границе резко — получится вырезанный ножницами силуэт; растворение
 * на треть клетки читается тем, чем и является: отражение кончилось
 * вместе с поверхностью, которая его давала.
 */
const MIRROR_EDGE_FADE_CELLS = 0.34;

/**
 * Насколько освещённый камень теплее затенённого, в долях канала.
 *
 * Вынесено в константы, а не оставлено числами в тексте шейдера,
 * ровно затем, чтобы проверка приглушённости цвета могла до них
 * добраться. Два набора чисел — в GLSL и в тесте — разъехались бы
 * при первой же правке.
 */
export const WARM_BOOST: readonly [number, number, number] = [16 / 255, 10 / 255, 2 / 255];

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aWorld;
in vec2 aSlope;
in vec3 aShade;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vWorld;
out vec2 vSlope;
out vec3 vShade;

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
in vec3 vShade;

uniform sampler2D uGrain;
uniform vec3 uLight;
uniform vec3 uRock;
uniform vec3 uSky;
uniform vec3 uWarm;
uniform float uAmbient;
uniform float uSkyStrength;
uniform float uGrainScale;
uniform float uTileCells;
uniform float uKeep;
uniform float uSoften;

out vec4 fragColor;

void main() {
  // Плитка хранит уклон фактуры, а не яркость: половина шкалы — ноль.
  vec2 grain = (texture(uGrain, vWorld / uTileCells).rg * 2.0 - 1.0) * uGrainScale;
  // uSoften — единица у самой скалы, малая доля у её отражения. Слабый
  // уклон означает гладкую поверхность, а гладкая поверхность отражает
  // без подробностей: ровно то, чем нечёткое отражение и отличается
  // от чёткого.
  vec2 slope = (vSlope + grain) * uSoften;

  vec3 normal = normalize(vec3(-slope.x, -slope.y, 1.0));
  float lit = min(1.0, uAmbient + max(0.0, dot(normal, uLight)));

  // Часть затенения приходит из вершины, часть зависит от наклона в точке.
  float ao = clamp(vShade.x + 0.20 * normal.z, 0.50, 1.0);
  float key = lit * ao;

  // Освещённый камень чуть теплее, затенённый чуть холоднее.
  float warm = clamp((lit - uAmbient) * 1.4, 0.0, 1.0);
  vec3 base = uRock + uWarm * warm;

  vec3 colour = base * vShade.y * key;

  // Второй источник — небо. Рассеянный свет сверху, тем больший, чем
  // ближе поверхность к горизонтальной, и холоднее основного. Без него
  // теневая сторона массива остаётся одинаковой тёмной заливкой:
  // у одного направленного источника всё, что от него отвёрнуто,
  // получает ровно ambient и различий не имеет.
  //
  // Затенение множится и сюда: в расщелину неба видно не больше, чем
  // солнца.
  colour += uSky * (uSkyStrength * max(0.0, normal.z) * ao);

  // Прозрачность вырезает клетку по неровному очертанию породы, а не
  // по ровному ромбу. Без этого крайняя клетка массива целиком закрыта
  // камнем, и гряда читается набором квадратов.
  //
  // uKeep — доля, доживающая до экрана: единица у самой скалы, малая
  // доля у её отражения в поле. Приглушение идёт ПРОЗРАЧНОСТЬЮ, а не
  // подмешиванием цвета земли, и это не мелочь: так отражению не нужно
  // знать, какого цвета поверхность под ним, а результат получается
  // тот же самый — обычное смешивание доложит остальное. Заодно
  // отражение, попавшее на соседнюю скалу, приглушается её цветом,
  // а не цветом пустой земли.
  //
  // Цвет умножается на прозрачность заранее: слой рисуется в режиме
  // с предумноженной альфой, и без этого по краю пошла бы светлая кайма.
  float coverage = clamp(vShade.z, 0.0, 1.0) * uKeep;
  fragColor = vec4(colour * coverage, coverage);
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

/**
 * Доля отражения, доживающая до экрана в данной точке.
 *
 * Отражение видно только там, где под ним есть поле. Точка отражения
 * лежит ниже своей опоры на высоту породы, и куда она попадёт на карте,
 * заранее не известно: у высокой вершины отражение уезжает на клетку
 * с лишним к юго-востоку и вполне может оказаться за краем карты.
 *
 * Тогда получается не отражение, а гора, торчащая из-под поля, — то,
 * что глаз читает как подводный айсберг, а не как блик на поверхности.
 * Поэтому здесь берётся мировая точка ПОД отражением и проверяется
 * дважды: не вышла ли она за карту и не попала ли на другую скалу.
 * На скале отражения быть не может — она непрозрачна и стои́т на поле,
 * а не лежит в нём.
 *
 * Обратный ход проекции здесь законен: он ищет точку на плоскости поля,
 * а у плоскости высоты нет и двусмысленности «выше или севернее»
 * не возникает.
 */
const fieldFade = (map: GameMap, screenX: number, screenY: number): number => {
  const point = screenToWorld(screenX, screenY);

  const toEdge = Math.min(point.x, point.y, MAP_WIDTH_CELLS - point.x, MAP_HEIGHT_CELLS - point.y);
  if (toEdge <= 0) return 0;

  const edge = Math.min(1, toEdge / MIRROR_EDGE_FADE_CELLS);

  return edge * (1 - rockCoverage(map, point.x, point.y));
};

export interface CellMesh {
  // Тип с параметрами: по умолчанию `Mesh` это `Mesh<MeshGeometry,
  // TextureShader>`, а у нас и геометрия, и шейдер свои.
  readonly mesh: Mesh<Geometry, Shader>;
  /**
   * Та же клетка, опрокинутая в поверхность поля.
   *
   * Отдельная сетка, а не отражённый по вертикали спрайт, и вот почему.
   * Отражение точки — это `y_земли + высота · s`, тогда как сама точка —
   * `y_земли − высота`. Обе величины линейны по высоте, но `y_земли`
   * внутри одной клетки меняется на 68 пикселей: проекция косая,
   * и северный угол ромба стоит настолько выше южного. Опрокидывание
   * готовой картинки относительно ОДНОЙ горизонтали даёт ошибку
   * в полтора раза больше этого — до полусотни пикселей по углам клетки,
   * а гряда собрана из многих клеток, и на стыках это разошлось бы
   * ступеньками.
   *
   * Считать же отражение по вершинам — почти бесплатно: тяжёлое
   * (сглаживание высот, уклоны, затенение) уже посчитано и берётся тем же
   * массивом, заново строится только экранное положение.
   */
  readonly mirror: Mesh<Geometry, Shader>;
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
export interface ReliefColors {
  /** Цвет породы. */
  readonly rock: number;
  /** Цвет неба: холодный подсвет сверху. */
  readonly sky: number;
}

export const buildCellMesh = (
  map: GameMap,
  cellX: number,
  cellY: number,
  colors: ReliefColors,
): CellMesh => {
  const { rock, sky } = colors;

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
  const shade = new Float32Array(count * 3);
  // Затенение отражения отличается от затенения скалы одним: долей
  // породы, в которую вложено затухание с глубиной. Отдельный массив,
  // а не поправка в шейдере, потому что глубина известна ровно здесь —
  // в шейдере от неё остаётся только экранная координата.
  const mirrorShade = new Float32Array(count * 3);
  const screen = new Float32Array(count * 2);
  // Экранная `y` того же места, опрокинутого в поверхность поля.
  // Хранится отдельным массивом, а не пересчитывается потом: высота
  // нужна для этого обеими своими ипостасями сразу, а обратным ходом
  // из готовой экранной точки её не достать — подъём в этой проекции
  // неотличим от сдвига на север.
  const mirrored = new Float32Array(count);

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
      // Отражение уходит от земли ВНИЗ ровно на ту же высоту, на какую
      // порода поднимается вверх. Знак противоположный, множитель —
      // `ROCK_MIRROR_SQUASH`, и почему он отличается от машинного,
      // разобрано у самой константы.
      const reflected = point.y + height * ELEVATION_PX_PER_CELL * ROCK_MIRROR_SQUASH;

      screen[index * 2] = x;
      screen[index * 2 + 1] = y;
      mirrored[index] = reflected;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, reflected);

      world[index * 2] = u;
      world[index * 2 + 1] = v;

      slope[index * 2] =
        (surfaceHeight(map, u + differential, v) - surfaceHeight(map, u - differential, v)) /
        (2 * differential);
      slope[index * 2 + 1] =
        (surfaceHeight(map, u, v + differential) - surfaceHeight(map, u, v - differential)) /
        (2 * differential);

      // Затенение без слагаемого от наклона: его добавит шейдер в точке.
      const ambient = 0.7 + (height - wideHeight(map, u, v) * 0.9) * 0.55;
      // Крупная неоднородность породы. Частота низкая (3,8 на клетку
      // против 24 у крошки), поэтому вершин хватает и в плитку её класть
      // незачем — она считается тут же, на процессоре.
      const tone = TONE_BASE + TONE_RANGE * fbm(u * 3.8, v * 3.8, 3, 3);
      // Доля породы: по ней шейдер вырежет клетку по неровному краю.
      const coverage = rockCoverage(map, u, v);

      shade[index * 3] = ambient;
      shade[index * 3 + 1] = tone;
      shade[index * 3 + 2] = coverage;

      // Отражение отличается долей породы: в неё вложено затухание
      // с глубиной и обрезка по полю.
      mirrorShade[index * 3] = ambient;
      mirrorShade[index * 3 + 1] = tone;
      mirrorShade[index * 3 + 2] =
        (coverage / (1 + height * MIRROR_DEPTH_FADE)) * fieldFade(map, x, reflected);
    }
  }

  const position = new Float32Array(count * 2);
  const mirrorPosition = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    const left = (screen[index * 2] ?? 0) - minX;
    position[index * 2] = left;
    position[index * 2 + 1] = (screen[index * 2 + 1] ?? 0) - minY;
    // По горизонтали отражение совпадает со скалой: зеркалом служит
    // сама плоскость поля, а она горизонтальна.
    mirrorPosition[index * 2] = left;
    mirrorPosition[index * 2 + 1] = (mirrored[index] ?? 0) - minY;
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

  // Геометрии две, а вершинных данных полтора набора: всё, кроме
  // экранного положения, у скалы и её отражения одинаково.
  const build = (vertices: Float32Array, shading: Float32Array): Geometry =>
    new Geometry({
      attributes: {
        aPosition: { buffer: vertices, format: 'float32x2' },
        aWorld: { buffer: world, format: 'float32x2' },
        aSlope: { buffer: slope, format: 'float32x2' },
        aShade: { buffer: shading, format: 'float32x3' },
      },
      indexBuffer: indices,
    });

  const paint = (keep: number, soften: number): Shader =>
    new Shader({
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
          uSky: {
            value: new Float32Array([
              ((sky >> 16) & 255) / 255,
              ((sky >> 8) & 255) / 255,
              (sky & 255) / 255,
            ]),
            type: 'vec3<f32>',
          },
          uWarm: { value: new Float32Array(WARM_BOOST), type: 'vec3<f32>' },
          uAmbient: { value: AMBIENT, type: 'f32' },
          uSkyStrength: { value: SKY_STRENGTH, type: 'f32' },
          uGrainScale: { value: GRAIN_SLOPE_SCALE, type: 'f32' },
          uTileCells: { value: GRAIN_TILE_CELLS, type: 'f32' },
          uKeep: { value: keep, type: 'f32' },
          uSoften: { value: soften, type: 'f32' },
        },
      },
    });

  return {
    mesh: new Mesh({ geometry: build(position, shade), shader: paint(1, 1) }),
    mirror: new Mesh({
      geometry: build(mirrorPosition, mirrorShade),
      shader: paint(ROCK_MIRROR_STRENGTH, MIRROR_SOFTEN),
    }),
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY),
    offsetX: minX,
    offsetY: minY,
  };
};

/**
 * Запечь клетку в текстуру. Вызывается один раз на клетку за матч.
 *
 * Отражение первым, скала поверх: отражение лежит в поверхности, то есть
 * глубже, и в узкой полосе у подножия, где они перекрываются, побеждать
 * обязана порода.
 */
export const bakeCell = (renderer: Renderer, target: RenderTexture, cell: CellMesh): void => {
  renderer.render({ container: cell.mirror, target, clear: true });
  renderer.render({ container: cell.mesh, target, clear: false });
};

/**
 * Сколько на карте скальных клеток.
 *
 * Нужно затем, что слой скал укладывается в бюджет видеопамяти, а число
 * клеток — единственная его составляющая, известная до запекания.
 * Обход дешёвый: полторы тысячи проверок против шестисот вершин
 * на каждую скальную клетку при самом запекании.
 */
export const countRockCells = (map: GameMap): number => {
  let cells = 0;

  for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
    for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
      if (isRockCell(map, x, y)) cells += 1;
    }
  }

  return cells;
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
 *
 * Плотность приходит снаружи и не выбирается здесь. Раньше на её месте
 * стояла единица, и оттого рельеф на экране с плотными пикселями мылил
 * вдвое сильнее машин, которые на нём стоят: машины плотность экрана
 * учитывали, а скалы — нет. Кто и как её считает, разобрано
 * в `bake-density.ts`.
 */
export const mountRockDiagonal = (
  layer: Container,
  renderer: Renderer,
  map: GameMap,
  diagonal: number,
  colors: ReliefColors,
  density: number,
): void => {
  clearRockLayer(layer);

  for (const [x, y] of diagonalCells(MAP_WIDTH_CELLS, MAP_HEIGHT_CELLS, diagonal)) {
    if (!isRockCell(map, x, y)) continue;

    const cell = buildCellMesh(map, x, y, colors);
    const texture = RenderTexture.create({
      width: cell.width,
      height: cell.height,
      resolution: density,
      antialias: true,
    });

    bakeCell(renderer, texture, cell);
    // Сетки больше не нужны: всё, что они умели, лежит в текстуре.
    cell.mesh.destroy(true);
    cell.mirror.destroy(true);

    const sprite = new Sprite(texture);
    sprite.position.set(cell.offsetX, cell.offsetY);
    layer.addChild(sprite);
  }
};
