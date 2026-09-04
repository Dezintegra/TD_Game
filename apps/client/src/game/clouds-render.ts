import { Container, Sprite, Texture } from 'pixi.js';
import { fbm } from './relief.js';
import { CLOUD_PUFF_LIMIT, CLOUD_VARIANTS, cloudCellSize, cloudPuffs } from './clouds.js';
import type { CloudCamera, CloudViewport } from './clouds.js';

/**
 * Мгла за границами поля: запекание пятна и слой на экране.
 *
 * Отрисовка отдельно от раскладки — как у `relief.ts` и `relief-render.ts`,
 * `arc-shape.ts` и `arc-render.ts`. Здесь живут PixiJS и видеопамять,
 * в `clouds.ts` — счёт, который можно проверить числами.
 *
 * Файлов ресурсов не прибавляется: пятно строится процедурно — тем же
 * приёмом и по тому же обоснованию, что плитка фактуры породы (`grain.ts`)
 * и дым взрывов.
 */

/**
 * Сторона запечённого пятна.
 *
 * Двести пятьдесят шесть при поперечнике на экране около семисот точек —
 * это меньше единицы к одной, и так и задумано: у мглы нет ни одной резкой
 * черты, растягивать нечего. Четыре таких текстуры (три варианта плюс
 * мип-уровни) стоят десятые доли мегабайта, тогда как 512 стоили бы
 * вчетверо больше ради разницы, которой не видно.
 */
export const CLOUD_TEXTURE_SIZE = 256;

/**
 * Поперечник пятна в шагах решётки.
 *
 * Больше единицы, чтобы соседние клубы перекрывались и между ними
 * не проступали швы. Но и не втрое: пятна полупрозрачные, платятся они
 * закраской, и при 1,4 шага шестнадцать пятен дают около трёх с половиной
 * полноэкранных закрасок — тот бюджет, под который слой и считался.
 * Первый запасной ход при просадке кадров — уменьшать именно это число.
 */
const CLOUD_SPREAD = 1.4;

/**
 * Мягкость края. Показатель больше единицы убирает видимую окружность:
 * при линейном спаде граница пятна читается кольцом.
 */
const CLOUD_EDGE_FALLOFF = 1.7;

/** Насколько шум съедает плотность: от «дырявого» до сплошного. */
const CLOUD_NOISE_FLOOR = 0.45;

/** Частота шума внутри пятна, в периодах на поперечник. */
const CLOUD_NOISE_SCALE = 2.6;

/** Сколько октав в шуме пятна. Четыре: пятое приближение уже не видно. */
const CLOUD_NOISE_OCTAVES = 4;

export interface CloudColors {
  /** Основной серый. */
  readonly cloud: number;
  /** Тёмный серый: им красится каждый второй вариант — ради глубины. */
  readonly deep: number;
}

export interface CloudLayer {
  readonly layer: Container;
  /** Разложить пятна по кадру. Время — часы кадра, а не номер тика. */
  update(timeMs: number, camera: CloudCamera, viewport: CloudViewport): void;
  destroy(): void;
}

/**
 * Пиксели одного варианта пятна.
 *
 * Радиальный спад умножается на `fbm`: спад отвечает за то, чтобы пятно
 * было пятном, а шум — за то, чтобы оно не было кругом. Цвет здесь белый,
 * а вся картинка лежит в прозрачности: красится пятно тинтом, и один
 * и тот же запечённый вариант годится и светлому клубу, и тёмному.
 */
const buildPuffPixels = (size: number, variant: number): Uint8ClampedArray => {
  const pixels = new Uint8ClampedArray(size * size * 4);

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      // Координаты в [-1, 1]: центр пятна в нуле, край окружности в единице.
      const nx = ((column + 0.5) / size) * 2 - 1;
      const ny = ((row + 0.5) / size) * 2 - 1;
      const offset = (row * size + column) * 4;

      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;

      const distance = Math.hypot(nx, ny);
      if (distance >= 1) {
        pixels[offset + 3] = 0;
        continue;
      }

      const edge = (1 - distance) ** CLOUD_EDGE_FALLOFF;
      // Варианты разведены и сдвигом поля, и зерном: одного сдвига мало —
      // при общем зерне соседние варианты остаются кусками одной картины.
      const noise = fbm(
        nx * CLOUD_NOISE_SCALE + variant * 31,
        ny * CLOUD_NOISE_SCALE - variant * 17,
        1337 + variant,
        CLOUD_NOISE_OCTAVES,
      );

      pixels[offset + 3] = Math.round(
        255 * edge * (CLOUD_NOISE_FLOOR + (1 - CLOUD_NOISE_FLOOR) * noise),
      );
    }
  }

  return pixels;
};

const bakePuffTexture = (variant: number): Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = CLOUD_TEXTURE_SIZE;
  canvas.height = CLOUD_TEXTURE_SIZE;

  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('нет двумерного контекста для пятна мглы');

  // Копия, а не сам массив: `ImageData` требует буфер, которым владеет сам.
  const image = ctx.createImageData(CLOUD_TEXTURE_SIZE, CLOUD_TEXTURE_SIZE);
  image.data.set(buildPuffPixels(CLOUD_TEXTURE_SIZE, variant));
  ctx.putImageData(image, 0, 0);

  return Texture.from(canvas);
};

/**
 * Слой мглы.
 *
 * Спрайты заводятся один раз и с тех пор только переставляются: пятен
 * ровно столько, сколько узлов у решётки, и это число постоянно. Текстуры
 * печутся здесь же — все три разом, доли миллисекунды на всё, — и живут
 * до конца матча.
 */
export const createCloudLayer = (colors: CloudColors): CloudLayer => {
  const layer = new Container();

  const textures: Texture[] = [];
  for (let variant = 0; variant < CLOUD_VARIANTS; variant += 1) {
    textures.push(bakePuffTexture(variant));
  }

  const sprites: Sprite[] = [];
  for (let index = 0; index < CLOUD_PUFF_LIMIT; index += 1) {
    const sprite = new Sprite(textures[index % CLOUD_VARIANTS]);
    // Точка привязки в центре: пятно и поворачивается, и дышит вокруг
    // своей середины, а не вокруг левого верхнего угла.
    sprite.anchor.set(0.5);
    sprites.push(sprite);
    layer.addChild(sprite);
  }

  return {
    layer,

    update(timeMs, camera, viewport) {
      const puffs = cloudPuffs(timeMs, camera, viewport);
      const cell = cloudCellSize(viewport);
      // Размер считается от шага решётки, а не задан в точках: на узком
      // экране и решётка мельче, и клубы обязаны измельчать вместе с ней,
      // иначе три пятна закроют собой всё окно.
      const spread = (CLOUD_SPREAD * cell.width) / CLOUD_TEXTURE_SIZE;

      for (let index = 0; index < sprites.length; index += 1) {
        const sprite = sprites[index];
        const puff = puffs[index];
        if (sprite === undefined) continue;

        // Пятен нет вовсе только у свёрнутого окна. Прятать спрайты,
        // а не оставлять их на прежних местах: окно вернётся с другим
        // размером, и старая раскладка окажется чужой.
        if (puff === undefined) {
          sprite.visible = false;
          continue;
        }

        sprite.visible = true;
        sprite.texture = textures[puff.variant] ?? sprite.texture;
        sprite.tint = puff.variant % 2 === 0 ? colors.cloud : colors.deep;
        sprite.position.set(puff.x, puff.y);
        sprite.rotation = puff.rotation;
        sprite.scale.set(puff.scale * spread);
        sprite.alpha = puff.alpha;
      }
    },

    destroy() {
      // Текстуры живут в видеопамяти, и сборщик мусора о ней не знает:
      // без уборки утечка копилась бы матч за матчем.
      for (const texture of textures) texture.destroy(true);
      layer.destroy({ children: true });
    },
  };
};
