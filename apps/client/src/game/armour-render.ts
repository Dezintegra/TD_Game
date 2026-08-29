import { Geometry, GlProgram, Mesh, RenderTexture, Shader, State } from 'pixi.js';
import type { Renderer, Texture } from 'pixi.js';
import { finishBakedTexture } from './baked-texture.js';
import { VIEW_DIRECTION_3D } from './iso.js';
import { MIRROR_KEEP } from './models.js';
import {
  DEFAULT_BEVEL,
  MATERIAL_EMISSIVE,
  MATERIAL_GLOSS,
  MATERIAL_SPECULAR,
  buildArmourMesh,
} from './armour.js';
import type { ArmourMesh, BevelTuning, Solid } from './armour.js';

/**
 * Запекание боевой машины в спрайт.
 *
 * Работа поделена по частоте ровно так же, как у скал: геометрия
 * считается в вершинах, свет — в пикселях, и всё это один раз
 * на комбинацию, а не на кадре.
 *
 * Проходов два, и второй нужен из-за того, чего у одной грани быть
 * не может, — **затенения в стыках**. Башня стои́т на корпусе, колесо
 * прижато к борту, ствол выходит из башни; в жизни в каждом таком стыке
 * темно, потому что свету туда не пробраться. Формула освещения грани
 * об этом не знает: она видит только направление нормали и не видит,
 * что перед гранью что-то стои́т.
 *
 * Поэтому первый проход, кроме цвета, кладёт в альфа-канал удалённость
 * каждого пикселя от зрителя, а второй по ней и считает затенение:
 * пиксель, вокруг которого много точек ближе него самого, лежит в стыке.
 * Это тот же приём, которым у скал темнеют расщелины, только там глубина
 * бралась из поля высот, а тут — из буфера.
 *
 * Второй проход заодно уменьшает картинку: первый рисует втрое крупнее,
 * второй усредняет. Так получается сглаживание, которое не спорит
 * с альфа-каналом первого прохода: обычное MSAA смешало бы соседние
 * значения удалённости и выдало бы стык там, где просто край детали.
 */

/** Во сколько раз промежуточный буфер крупнее готового спрайта. */
const SUPERSAMPLE = 3;

/**
 * Освещение то же, что у всего остального на поле (`prism.ts`).
 *
 * Вынесено наружу не для удобства, а под проверку: два набора чисел —
 * здесь и в `prism.ts` — разъехались бы при первой же правке, и машина
 * оказалась бы освещена не тем источником, что стоящая рядом башня.
 */
export const AMBIENT = 0.34;
export const LIGHT: readonly [number, number, number] = [
  0.72 - AMBIENT,
  0.48 - AMBIENT,
  1 - AMBIENT,
];

/**
 * Настройки поверхности.
 *
 * Собраны в одну запись, а не разбросаны по тексту шейдера, потому
 * что подбираются они глазом и парами: усильте зерно — придётся
 * ослабить швы, иначе борт превращается в осыпь. Значения по
 * умолчанию — те, что выбраны на пробе.
 */
export interface ArmourTuning {
  /**
   * Сила света неба.
   *
   * Держится скромной по той же причине, что у скал: небо здесь
   * не второй источник, а поправка: его задача — не осветить теневой
   * борт, а перестать делать его одинаковой заливкой.
   */
  readonly skyStrength: number;
  /**
   * Сила контрового света цветом стороны.
   *
   * Заменяет собой неоновую обводку по рёбрам. Обводка была линией
   * постоянной яркости вокруг всего силуэта и сообщала «нарисовано»;
   * контровой свет ярче там, где поверхность отвернулась от зрителя,
   * то есть ровно по краю тела, и гаснет на плоскостях. Принадлежность
   * стороне он показывает не хуже — а вместе с бликом даёт то, чего
   * у заливки не было: край, за который цепляется взгляд.
   */
  readonly rimStrength: number;
  /** Насколько круто гаснет контровой свет от края к середине грани. */
  readonly rimFalloff: number;
  /** Насколько сильно фактура отклоняет нормаль. */
  readonly bumpScale: number;
  /** Сколько швов бронеплит приходится на клетку. */
  readonly seamFrequency: number;
  /** Ширина шва в клетках. */
  readonly seamWidth: number;
  /** Глубина шва в единицах поля неровности. */
  readonly seamDepth: number;
  /** Частота зерна металла и его размах. */
  readonly grainFrequency: number;
  readonly grainAmplitude: number;
  /** Сила затенения в стыках. */
  readonly aoStrength: number;
  /**
   * Радиус, в котором ищется перекрытие, в пикселях ГОТОВОГО спрайта.
   *
   * Именно готового, а не промежуточного буфера: иначе при запекании
   * в двойном разрешении затенение охватывало бы вдвое меньшую долю
   * машины, и машина на экране с плотными пикселями оказалась бы светлее
   * такой же машины на обычном.
   */
  readonly aoRadius: number;
  /**
   * Насколько сосед должен быть ближе, чтобы считаться перекрытием.
   *
   * В долях шкалы удалённости. Без запаса затенение появлялось бы
   * на собственном скосе детали: у наклонной грани соседний пиксель
   * всегда чуть ближе.
   */
  readonly aoBias: number;
}

export const DEFAULT_TUNING: ArmourTuning = {
  skyStrength: 0.24,
  rimStrength: 0.45,
  rimFalloff: 5,
  bumpScale: 0.03,
  seamFrequency: 8,
  seamWidth: 0.007,
  seamDepth: 0.4,
  grainFrequency: 150,
  grainAmplitude: 0.03,
  aoStrength: 0.45,
  aoRadius: 1.6,
  aoBias: 0.006,
};

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec3 aNormal;
in vec3 aLocal;
in vec3 aAlbedo;
in vec4 aSurface;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec3 vNormal;
out vec3 vLocal;
out vec3 vAlbedo;
out vec4 vSurface;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  // Третья координата — удалённость от зрителя, приведённая к отрезку
  // отсечения. Ею и работает буфер глубины: ближе к зрителю — меньше.
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 1.0 - 2.0 * aSurface.x, 1.0);
  vNormal = aNormal;
  vLocal = aLocal;
  vAlbedo = aAlbedo;
  vSurface = aSurface;
}`;

const FRAGMENT = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vLocal;
in vec3 vAlbedo;
in vec4 vSurface;

uniform vec3 uLight;
uniform vec3 uView;
uniform vec3 uSky;
uniform vec3 uAccent;
uniform vec3 uGround;
uniform float uAmbient;
uniform float uSkyStrength;
uniform float uRimStrength;
uniform float uRimFalloff;
uniform float uBumpScale;
uniform float uSeamFrequency;
uniform float uSeamWidth;
uniform float uSeamDepth;
uniform float uGrainFrequency;
uniform float uGrainAmplitude;
uniform float uMirror;

out vec4 fragColor;

float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float valueNoise(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = p - cell;
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(cell);
  float n100 = hash13(cell + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(cell + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(cell + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(cell + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(cell + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(cell + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(cell + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

/**
 * Поле неровности в местных координатах машины.
 *
 * В высоту оно не входит — только в направление нормали. Правило
 * то же, что у скал: силуэт задаёт геометрия и остаётся чистым,
 * а подробности живут в освещении.
 */
float relief(vec3 p) {
  // Шов поперёк хода: треугольная волна даёт расстояние до ближайшей линии.
  float wave = abs(fract(p.x * uSeamFrequency + 0.5) - 0.5) / uSeamFrequency;
  float groove = -uSeamDepth * exp(-(wave * wave) / (uSeamWidth * uSeamWidth));

  float grain = valueNoise(p * uGrainFrequency) * 0.6
    + valueNoise(p * uGrainFrequency * 2.3) * 0.3
    + valueNoise(p * uGrainFrequency * 4.7) * 0.1;

  return groove + grain * uGrainAmplitude;
}

void main() {
  vec3 normal = normalize(vNormal);

  // Отклонение нормали по уклону поля неровности. Касательная часть
  // градиента — всё, что нужно: составляющая вдоль нормали поверхность
  // не наклоняет, а только поднимает, а поднимать её нам нельзя.
  float eps = 0.004;
  float centre = relief(vLocal);
  vec3 gradient = vec3(
    relief(vLocal + vec3(eps, 0.0, 0.0)) - centre,
    relief(vLocal + vec3(0.0, eps, 0.0)) - centre,
    relief(vLocal + vec3(0.0, 0.0, eps)) - centre) / eps;
  gradient -= normal * dot(gradient, normal);
  normal = normalize(normal - gradient * uBumpScale);

  float key = max(0.0, dot(normal, uLight));
  float lit = min(1.0, uAmbient + key);

  // Маркер стороны горит сам: свет на него влияет вполсилы, иначе
  // на теневом борту он уходит в тень вместе с бронёй.
  vec3 colour = vAlbedo * mix(lit, 1.0, vSurface.w);

  // Небо: рассеянный холодный свет сверху. Без него теневой борт машины
  // остаётся ровно фоновой заливкой и от соседнего борта не отличается.
  colour += uSky * (uSkyStrength * max(0.0, normal.z));

  // Блик от того же единственного источника. Металл узнаётся по нему,
  // а не по цвету: у брони он широкий и слабый, у ствола узкий и резкий,
  // у резины его нет.
  vec3 halfway = normalize(normalize(uLight) + uView);
  float spec = pow(max(0.0, dot(normal, halfway)), vSurface.y) * vSurface.z;
  colour += vec3(spec * step(0.001, key));

  // Контровой свет цветом стороны вместо неоновой обводки.
  float rim = pow(1.0 - max(0.0, dot(normal, uView)), uRimFalloff);
  colour += uAccent * (rim * uRimStrength);

  // Отражение — та же машина, приглушённая до цвета поля.
  colour = mix(colour, uGround, uMirror);

  fragColor = vec4(colour, vSurface.x);
}`;

const RESOLVE_VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aUv;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vUv;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUv = aUv;
}`;

const RESOLVE_FRAGMENT = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uAoStrength;
uniform float uAoRadius;
uniform float uAoBias;

out vec4 fragColor;

const int SUPER = ${SUPERSAMPLE};

const vec2 RING[8] = vec2[8](
  vec2(1.0, 0.0), vec2(0.7071, 0.7071), vec2(0.0, 1.0), vec2(-0.7071, 0.7071),
  vec2(-1.0, 0.0), vec2(-0.7071, -0.7071), vec2(0.0, -1.0), vec2(0.7071, -0.7071));

/**
 * Затенение в стыке.
 *
 * Считается по удалённости: если вокруг точки много таких, что лежат
 * ближе к зрителю, значит, над ней что-то нависает. Пустой фон
 * перекрытием не считается — иначе тёмной каймой обвело бы весь силуэт,
 * а это ровно та обводка, от которой мы уходим.
 */
float occlusion(vec2 uv, float depth) {
  float sum = 0.0;

  for (int index = 0; index < 8; index += 1) {
    float radius = uAoRadius * (index % 2 == 0 ? 1.0 : 2.0);
    vec4 probe = texture(uSource, uv + RING[index] * uTexel * radius);
    if (probe.a <= 0.0) continue;

    float closer = probe.a - depth - uAoBias;
    if (closer > 0.0) sum += min(1.0, closer * 90.0);
  }

  return sum / 8.0;
}

void main() {
  vec3 colour = vec3(0.0);
  float coverage = 0.0;
  float total = float(SUPER * SUPER);

  for (int row = 0; row < SUPER; row += 1) {
    for (int column = 0; column < SUPER; column += 1) {
      vec2 uv = vUv + (vec2(float(column), float(row)) + 0.5 - float(SUPER) * 0.5) * uTexel;
      vec4 probe = texture(uSource, uv);
      if (probe.a <= 0.0) continue;

      float shade = 1.0 - uAoStrength * occlusion(uv, probe.a);
      colour += probe.rgb * shade;
      coverage += 1.0;
    }
  }

  // Цвет уже предумножен на покрытие: делится на полное число проб,
  // а не на число попавших. Слой рисуется в режиме с предумноженной
  // альфой, и иначе по краю пошла бы светлая кайма.
  fragColor = vec4(colour / total, coverage / total);
}`;

const toVector = (color: number): Float32Array =>
  new Float32Array([((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255]);

export interface ArmourColors {
  /** Цвета материалов по номерам из `Material`. */
  readonly palette: readonly number[];
  /** Цвет стороны: им светится контровой свет. */
  readonly accent: number;
  /** Цвет неба: холодный подсвет сверху. */
  readonly sky: number;
  /** Цвет поверхности поля: к нему приглушается отражение. */
  readonly ground: number;
}

/** Готовый спрайт машины и его положение относительно точки опоры. */
export interface BakedArmour {
  readonly texture: Texture;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly modelHeight: number;
}

const buildGeometry = (mesh: ArmourMesh, palette: readonly number[]): Geometry => {
  const count = mesh.surface.length / 2;
  const albedo = new Float32Array(count * 3);
  const surface = new Float32Array(count * 4);

  for (let index = 0; index < count; index += 1) {
    const material = mesh.surface[index * 2] ?? 0;
    const colour = palette[material] ?? palette[0] ?? 0;

    albedo[index * 3] = ((colour >> 16) & 255) / 255;
    albedo[index * 3 + 1] = ((colour >> 8) & 255) / 255;
    albedo[index * 3 + 2] = (colour & 255) / 255;

    // Удалённость едет первой: второй проход читает её из альфа-канала.
    surface[index * 4] = mesh.surface[index * 2 + 1] ?? 0;
    surface[index * 4 + 1] = MATERIAL_GLOSS[material] ?? 16;
    surface[index * 4 + 2] = MATERIAL_SPECULAR[material] ?? 0.2;
    surface[index * 4 + 3] = MATERIAL_EMISSIVE[material] ?? 0;
  }

  return new Geometry({
    attributes: {
      aPosition: { buffer: mesh.positions, format: 'float32x2' },
      aNormal: { buffer: mesh.normals, format: 'float32x3' },
      aLocal: { buffer: mesh.locals, format: 'float32x3' },
      aAlbedo: { buffer: albedo, format: 'float32x3' },
      aSurface: { buffer: surface, format: 'float32x4' },
    },
    indexBuffer: mesh.indices,
  });
};

const buildQuad = (width: number, height: number): Geometry =>
  new Geometry({
    attributes: {
      aPosition: {
        buffer: new Float32Array([0, 0, width, 0, width, height, 0, height]),
        format: 'float32x2',
      },
      aUv: { buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), format: 'float32x2' },
    },
    indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });

/**
 * Запечь одну комбинацию в текстуру.
 *
 * `mirror` строит отражение: та же машина, приглушённая до цвета поля.
 * Отдельной сборки геометрии для него не нужно — опрокидывание деталей
 * делает вызывающий код, здесь остаётся только приглушение цвета.
 */
export const bakeArmour = (
  renderer: Renderer,
  solids: readonly Solid[],
  facing: number,
  colors: ArmourColors,
  mirror: boolean,
  resolution: number,
  tuning: ArmourTuning = DEFAULT_TUNING,
  bevel: BevelTuning = DEFAULT_BEVEL,
): BakedArmour => {
  const mesh = buildArmourMesh(solids, facing, mirror, bevel);

  const draft = RenderTexture.create({
    width: mesh.width,
    height: mesh.height,
    resolution: resolution * SUPERSAMPLE,
    antialias: false,
  });
  // Буфер глубины у текстуры по умолчанию не заводится: слоям с плоской
  // графикой он не нужен. Здесь нужен, и просить его надо до первой
  // отрисовки — иначе цель уже создана без него.
  renderer.renderTarget.getRenderTarget(draft).depth = true;

  const shader = new Shader({
    glProgram: GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT }),
    resources: {
      armourUniforms: {
        uLight: { value: new Float32Array(LIGHT), type: 'vec3<f32>' },
        uView: {
          value: new Float32Array([VIEW_DIRECTION_3D.x, VIEW_DIRECTION_3D.y, VIEW_DIRECTION_3D.z]),
          type: 'vec3<f32>',
        },
        uSky: { value: toVector(colors.sky), type: 'vec3<f32>' },
        uAccent: { value: toVector(colors.accent), type: 'vec3<f32>' },
        uGround: { value: toVector(colors.ground), type: 'vec3<f32>' },
        uAmbient: { value: AMBIENT, type: 'f32' },
        uSkyStrength: { value: tuning.skyStrength, type: 'f32' },
        uRimStrength: { value: mirror ? 0 : tuning.rimStrength, type: 'f32' },
        uRimFalloff: { value: tuning.rimFalloff, type: 'f32' },
        uBumpScale: { value: tuning.bumpScale, type: 'f32' },
        uSeamFrequency: { value: tuning.seamFrequency, type: 'f32' },
        uSeamWidth: { value: tuning.seamWidth, type: 'f32' },
        uSeamDepth: { value: tuning.seamDepth, type: 'f32' },
        uGrainFrequency: { value: tuning.grainFrequency, type: 'f32' },
        uGrainAmplitude: { value: tuning.grainAmplitude, type: 'f32' },
        uMirror: { value: mirror ? 1 - MIRROR_KEEP : 0, type: 'f32' },
      },
    },
  });

  // Смешивание выключено намеренно: в альфа-канале едет удалённость,
  // а не прозрачность, и смешивать её с фоном нельзя.
  const state = new State();
  state.blend = false;
  // Буфер глубины, а не порядок отрисовки.
  //
  // Пока машина состояла из десяти коробок, хватало алгоритма художника:
  // тела сортировались по удалённости центра и клались одно на другое.
  // На трёх десятках тел этого стало мало, и вот почему: у длинного
  // корпуса и маленького колеса центры сравнивать бессмысленно — колесо
  // с дальнего борта имеет бо́льшую удалённость центра, чем корпус,
  // и ложится ПОВЕРХ корпуса, за которым обязано прятаться. Корпус
  // становится будто прозрачным.
  //
  // Порядком это не чинится вовсе: одна и та же пара тел перекрывает
  // друг друга по-разному в разных местах экрана. Нужна глубина в точке,
  // а не у тела, — и она у нас уже есть, ею же считается затенение
  // в стыках. Остаётся включить сравнение.
  state.depthTest = true;

  const geometry = buildGeometry(mesh, colors.palette);
  const model = new Mesh({ geometry, shader, state });
  renderer.render({ container: model, target: draft, clear: true });
  model.destroy(true);

  const texture = RenderTexture.create({
    width: mesh.width,
    height: mesh.height,
    resolution,
    antialias: false,
  });

  const resolveShader = new Shader({
    glProgram: GlProgram.from({ vertex: RESOLVE_VERTEX, fragment: RESOLVE_FRAGMENT }),
    resources: {
      uSource: draft.source,
      resolveUniforms: {
        uTexel: {
          value: new Float32Array([
            1 / (mesh.width * resolution * SUPERSAMPLE),
            1 / (mesh.height * resolution * SUPERSAMPLE),
          ]),
          type: 'vec2<f32>',
        },
        uAoStrength: { value: tuning.aoStrength, type: 'f32' },
        uAoRadius: { value: tuning.aoRadius * SUPERSAMPLE * resolution, type: 'f32' },
        uAoBias: { value: tuning.aoBias, type: 'f32' },
      },
    },
  });

  const resolve = new Mesh({ geometry: buildQuad(mesh.width, mesh.height), shader: resolveShader });
  renderer.render({ container: resolve, target: texture, clear: true });
  finishBakedTexture(texture);
  resolve.destroy(true);
  draft.destroy(true);

  return {
    texture,
    offsetX: mesh.offsetX,
    offsetY: mesh.offsetY,
    modelHeight: mesh.modelHeight,
  };
};
