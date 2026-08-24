import { Container, Graphics, RenderTexture, Sprite } from 'pixi.js';
import type { Renderer, Texture } from 'pixi.js';
import type { Point } from './iso.js';
import {
  ARC_TILE_H,
  ARC_TILE_PX,
  ARC_VARIANTS,
  arcStrands,
  arcTileCount,
  arcVariantAt,
  arcWaveGain,
  arcWaveHeadAlpha,
} from './arc-shape.js';
import type { ArcLine, ArcSink, ArcStyle } from './arc-shape.js';

/**
 * Разряд Теслы спрайтами: выпечка заготовок и раскладка по каналу.
 *
 * Три заготовки, и у каждой своя причина быть отдельной.
 *
 *   плитка ядра  — подробность. Её нельзя растягивать, иначе зигзаг
 *                  меняет масштаб вместе с дальностью;
 *   полоса света — цвет стороны. Подробностей в ней нет, растягивать
 *                  нечего, поэтому одна заготовка годится на любую длину.
 *                  Резать её на плитки НЕЛЬЗЯ: свечение каждой обрезалось
 *                  бы её краями, и по молнии пошли бы тёмные перехваты
 *                  каждые 64 пикселя — проверено картинкой;
 *   голова волны — бегущее пятно. Одной яркости плиток для волны мало:
 *                  фронт по ломаной читается плохо, ему нужен свет
 *                  вокруг, который глаз ловит раньше формы.
 *
 * Всё печётся белым: цвет наводится тинтом спрайта. Так одна выпечка
 * годится и своему разряду, и чужому, и любой будущей палитре.
 *
 * Состояния между кадрами здесь нет: пул спрайтов — не состояние мира,
 * а место, куда кадр складывает свою картинку. Клиент откатывает
 * предсказание и рисует один и тот же тик по нескольку раз; всё,
 * что видно, выводится из записи о выстреле и номера тика, поэтому
 * повторная отрисовка совпадает точка в точку.
 */

export interface ArcColors {
  /**
   * Сине-белое тело молнии.
   *
   * Единственный цвет здесь: плитки печутся белыми и красятся тинтом,
   * а цвет стороны приходит с каждым разрядом отдельно — он свой
   * у своего и у чужого.
   */
  readonly arc: number;
}

export interface ArcSprites extends ArcSink {
  /** Слой со спрайтами. Сцена кладёт его в мировой контейнер. */
  readonly layer: Container;
  /** Начало кадра: разряды прошлого кадра гасятся. */
  begin(): void;
  /** Конец кадра: лишние спрайты пула прячутся. */
  end(): void;
  destroy(): void;
  /** Сколько спрайтов занято. Нужно тестам и замерам. */
  readonly used: number;
}

/** Длина заготовки полосы света. Растягивается по всей длине разряда. */
const BAR_PX = 256;
const BAR_H = 64;

/** Поперечник бегущего пятна. */
const HEAD_PX = 96;

/**
 * Яркость полосы света.
 *
 * Низкая нарочно. Слой складывает цвет, вложенные обводки заготовки
 * накладываются друг на друга, и первый заход — вчетверо ярче этого —
 * дал сплошную зелёную колбасу вместо свечения. Ореол обязан оставаться
 * подсветкой ВОКРУГ ядра, а не телом молнии: тело у неё сине-белое.
 */
const BAR_ALPHA = 1;

/** Насколько добивающий разряд толще обычного. */
const LETHAL_SCALE = 1.3;

/**
 * Свет, который разряд кладёт на землю под собой.
 *
 * Ради него всё и затевалось на прошлом заходе: без отсвета на поле
 * молния остаётся рисунком ПОВЕРХ поля, а не событием В нём. Раньше
 * это были заливки градиентом — самый дорогой примитив поштучно;
 * теперь та же заготовка, что у головы волны, и цена ей ноль.
 */
const POOL_SCALE = 0.85;
const POOL_ALPHA = 0.4;

const paint = (renderer: Renderer, graphics: Graphics, width: number, height: number): Texture => {
  // Плотность вдвое: молния — тонкая штриховка, и на единичной плотности
  // ядро в полтора пикселя рассыпается в пунктир при повороте.
  const texture = RenderTexture.create({ width, height, resolution: 2, antialias: true });
  renderer.render({ container: graphics, target: texture, clear: true });
  graphics.destroy();
  return texture;
};

const traceStrand = (graphics: Graphics, nodes: readonly Point[]): void => {
  const first = nodes[0];
  if (first === undefined) return;

  graphics.moveTo(first.x, first.y);
  for (let index = 1; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node !== undefined) graphics.lineTo(node.x, node.y);
  }
};

/** Плитка ядра: пучок жил и раскалённая нить в главной. */
const bakeTile = (renderer: Renderer, variant: number): Texture => {
  const graphics = new Graphics();
  const [main, ...sides] = arcStrands(variant);

  for (const strand of sides) traceStrand(graphics, strand);
  graphics.stroke({ width: 1.2, color: 0xffffff, alpha: 0.5, cap: 'round' });

  if (main !== undefined) {
    traceStrand(graphics, main);
    graphics.stroke({ width: 3.2, color: 0xffffff, alpha: 0.85, cap: 'round' });
    traceStrand(graphics, main);
    graphics.stroke({ width: 1.4, color: 0xffffff, alpha: 1, cap: 'round' });
  }

  return paint(renderer, graphics, ARC_TILE_PX, ARC_TILE_H);
};

/**
 * Полоса света: мягкий поперечный разрез, гаснущий и к краям, и к торцам.
 *
 * Строится вложенными обводками с закруглёнными концами. Печётся один
 * раз за запуск, поэтому «дорого» здесь не бывает.
 */
const bakeBar = (renderer: Renderer): Texture => {
  const graphics = new Graphics();
  const mid = BAR_H / 2;

  for (const [width, alpha] of [
    [24, 0.05],
    [17, 0.065],
    [11, 0.085],
    [6, 0.1],
  ] as const) {
    graphics.moveTo(width / 2, mid).lineTo(BAR_PX - width / 2, mid);
    graphics.stroke({ width, color: 0xffffff, alpha, cap: 'round' });
  }

  return paint(renderer, graphics, BAR_PX, BAR_H);
};

/** Голова волны: мягкий круг без единой подробности. */
const bakeHead = (renderer: Renderer): Texture => {
  const graphics = new Graphics();
  const mid = HEAD_PX / 2;

  for (const [radius, alpha] of [
    [46, 0.05],
    [34, 0.07],
    [23, 0.1],
    [13, 0.14],
    [6, 0.2],
  ] as const) {
    graphics.circle(mid, mid, radius);
    graphics.fill({ color: 0xffffff, alpha });
  }

  return paint(renderer, graphics, HEAD_PX, HEAD_PX);
};

export const createArcSprites = (renderer: Renderer, colors: ArcColors): ArcSprites => {
  const tiles: Texture[] = [];
  for (let variant = 0; variant < ARC_VARIANTS; variant += 1) {
    tiles.push(bakeTile(renderer, variant));
  }
  const bar = bakeBar(renderer);
  const head = bakeHead(renderer);

  const layer = new Container();
  // Свет складывается, а не закрашивает: два разряда, пересёкшиеся
  // на экране, ярче одного. Задаётся слою целиком — ровно поэтому
  // разряд и живёт в своём слое, а не подмешан к телам.
  layer.blendMode = 'add';

  const pool: Sprite[] = [];
  let used = 0;

  const take = (texture: Texture): Sprite => {
    let sprite = pool[used];
    if (sprite === undefined) {
      sprite = new Sprite();
      pool.push(sprite);
      layer.addChild(sprite);
    }
    used += 1;

    sprite.texture = texture;
    sprite.visible = true;
    return sprite;
  };

  return {
    layer,

    get used() {
      return used;
    },

    begin() {
      used = 0;
    },

    place(bolt: ArcLine, ground: ArcLine, style: ArcStyle) {
      const { from, to } = bolt;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);

      // Выстрел в упор раскладывать не по чему.
      if (length === 0) return;

      const angle = Math.atan2(dy, dx);
      const thickness = style.lethal ? LETHAL_SCALE : 1;

      // Свет первым: он лежит под ядром и не должен его перебивать.
      const glow = take(bar);
      glow.anchor.set(0, 0.5);
      glow.position.set(from.x, from.y);
      glow.rotation = angle;
      glow.scale.set(length / BAR_PX, thickness);
      glow.tint = style.accent;
      glow.alpha = Math.min(1, style.alpha * BAR_ALPHA);

      const count = arcTileCount(length);
      const step = length / count;

      for (let index = 0; index < count; index += 1) {
        const variant = arcVariantAt(style.seed, index, style.phase);
        const tile = take(tiles[variant] as Texture);
        tile.anchor.set(0, 0.5);
        tile.position.set(from.x + (dx * index) / count, from.y + (dy * index) / count);
        tile.rotation = angle;
        // По длине плитка растягивается под подогнанный шаг, поперёк —
        // не растягивается вовсе, иначе у дальнего выстрела молния
        // станет вдвое толще ближнего.
        tile.scale.set(step / ARC_TILE_PX, thickness);
        tile.tint = colors.arc;
        tile.alpha = Math.min(
          1,
          style.alpha * 1.7 * arcWaveGain((index + 0.5) / count, style.front),
        );
      }

      // Свет на земле под разрядом. Той же заготовкой, что и голова
      // волны: мягкое пятно есть мягкое пятно, второй такой же texture
      // заводить незачем.
      const pools = 2;
      for (let index = 0; index < pools; index += 1) {
        const along = (index + 1) / (pools + 1);
        const flicker =
          0.62 + 0.38 * Math.abs(Math.sin(style.seed * 0.37 + index * 2.1 + style.phase));
        const pool = take(head);
        pool.anchor.set(0.5);
        pool.position.set(
          ground.from.x + (ground.to.x - ground.from.x) * along,
          ground.from.y + (ground.to.y - ground.from.y) * along,
        );
        pool.rotation = 0;
        pool.scale.set(POOL_SCALE * (0.8 + flicker * 0.3));
        pool.tint = style.accent;
        pool.alpha = Math.min(1, style.alpha * POOL_ALPHA * flicker);
      }

      const headAlpha = arcWaveHeadAlpha(style.front) * style.alpha;
      if (headAlpha > 0.01 && style.front !== undefined) {
        const spark = take(head);
        spark.anchor.set(0.5);
        spark.position.set(from.x + dx * style.front, from.y + dy * style.front);
        spark.rotation = 0;
        spark.scale.set(thickness);
        spark.tint = style.accent;
        spark.alpha = headAlpha;
      }
    },

    end() {
      for (let index = used; index < pool.length; index += 1) {
        const sprite = pool[index];
        if (sprite !== undefined) sprite.visible = false;
      }
    },

    destroy() {
      // Текстуры живут в видеопамяти, а сборщик мусора о ней не знает.
      for (const texture of tiles) texture.destroy(true);
      bar.destroy(true);
      head.destroy(true);
      layer.destroy({ children: true });
    },
  };
};
