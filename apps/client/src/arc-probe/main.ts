import { Application, Container, Graphics, RenderTexture, Sprite, Text } from 'pixi.js';
import type { Renderer, Texture } from 'pixi.js';
import {
  SHOT_LIFETIME_TICKS,
  ShotSide,
  ShotWeapon,
  TICKS_PER_SECOND,
  cellsToUnits,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import type { ShotState, WorldState } from '@td/sim';
import { worldToScreen } from '../game/iso.js';
import { drawShots } from '../game/shots.js';
import type { ShotColors, ShotLayers } from '../game/shots.js';
import type { ArcSink } from '../game/arc-shape.js';

/**
 * Проба: молния, собранная из запечённых плиток.
 *
 * Временная страница, в сборку не входит. Отвечает на четыре вопроса,
 * которых не видно в замере:
 *
 *   1. читаются ли стыки плиток и не распадается ли канал в пунктир;
 *   2. держится ли облик на разных дистанциях — от трёх клеток
 *      до пятнадцати, куда дальность уезжает после прокачки;
 *   3. виден ли цвет стороны, если красить им ТОЛЬКО ореол;
 *   4. как выглядит рассинхрон плиток по фазе.
 *
 * Сравнение идёт с нынешней геометрией — её рисует боевая `drawShots`,
 * а не подделка, иначе сравнивать было бы не с чем.
 */

const COLORS = {
  self: 0x00ff29,
  enemy: 0xd264ff,
  hullDark: 0x23271f,
  shot: 0xeaffef,
  shotLethal: 0xff5c5c,
  arc: 0x5aa6ff,
  core: 0xfff6e0,
  fire: 0xff8a2b,
  smoke: 0x2b2622,
} as const;

const SHOT_COLORS: ShotColors = COLORS;
const LOCAL = 0 as PlayerId;
const WIDE = { minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6 };

/** Разряды пробе не нужны: она сравнивает облик, а не считает спрайты. */
const NO_ARCS: ArcSink = { place: () => undefined };

// ─────────────────────────────────────────────────────────────────────────
// Выпечка
// ─────────────────────────────────────────────────────────────────────────

/**
 * Длина плитки в ЭКРАННЫХ пикселях, а не в клетках.
 *
 * Клетка проецируется в 36–63 пикселя в зависимости от того, куда
 * стреляют: вдоль мировой оси X она почти вдвое длиннее, чем вдоль Y.
 * Плитка в клетку дала бы крупнозернистую молнию при стрельбе на юг
 * и мелкую при стрельбе на восток — при одинаковом расстоянии.
 */
const TILE = 64;

/** Высота плитки: размах ломаной плюс запас на толщину ядра. */
const TILE_H = 40;

/** Сколько разных плиток печётся. Больше — реже повторяется рисунок. */
const VARIANTS = 8;

/**
 * Поперечный размах ломаной внутри плитки.
 *
 * Первый заход стоял на одиннадцати, и на ×3 плитка читалась не молнией,
 * а плетёнкой: жилы при таком размахе на коротком звене пересекаются
 * по нескольку раз и складываются в решётку. Молния — это редкие
 * длинные изломы, а не частая рябь.
 */
const SWING = 7;

/**
 * Сколько звеньев в плитке. Число СВОЁ у каждого варианта, и это важнее,
 * чем кажется.
 *
 * При одинаковом числе звеньев период излома получается один и тот же —
 * двадцать с небольшим пикселей, — и сколько вариантов ни печатай, глаз
 * ловит равномерную волну, а не молнию. Проверено картинкой: три звена
 * на все восемь вариантов дали ровную синусоиду.
 *
 * Два, три или четыре звена вперемешку сбивают ритм: соседние плитки
 * ломаются с разной частотой, и рисунок перестаёт быть механическим.
 */
const stepsOf = (variant: number): number => 2 + (variant % 3);

/** Детерминированный шум для выпечки: одна и та же плитка каждый запуск. */
const noiseFrom = (seed: number): (() => number) => {
  let state = (seed * 9973 + 7) >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
};

const bakeTo = (renderer: Renderer, graphics: Graphics, width: number, height: number): Texture => {
  const texture = RenderTexture.create({ width, height, resolution: 2, antialias: true });
  renderer.render({ container: graphics, target: texture, clear: true });
  graphics.destroy();
  return texture;
};

/**
 * Ядро молнии: пучок жил на прозрачном, белым.
 *
 * Главное правило: ломаная ВХОДИТ и ВЫХОДИТ строго по осевой. Тогда
 * любая плитка стыкуется с любой, подбирать пары не нужно, а единственный
 * след стыка — излом наклона. Для молнии это не изъян: молния из изломов
 * и состоит.
 *
 * Белым, потому что цвет наводится тинтом спрайта: одна выпечка годится
 * и телу разряда, и его отражению, и любой будущей палитре.
 */
const bakeCore = (renderer: Renderer, variant: number): Texture => {
  const graphics = new Graphics();
  const noise = noiseFrom(variant);
  const mid = TILE_H / 2;

  const steps = stepsOf(variant);
  const strand = (scale: number): void => {
    graphics.moveTo(0, mid);
    for (let step = 1; step <= steps; step += 1) {
      // Излом гуляет и вдоль: равномерно расставленные узлы дают
      // одинаковые звенья, а у молнии они разной длины.
      const along = step === steps ? 1 : (step + noise() * 0.3) / steps;
      // Последняя точка садится на осевую — это и есть условие стыковки.
      const swing = step === steps ? 0 : noise() * SWING * scale;
      graphics.lineTo(along * TILE, mid + swing);
    }
  };

  // Побочные жилы: пучок, а не одна трещина. Две, а не четыре —
  // на плитке в 64 пикселя больше просто не помещается без плетёнки.
  for (let index = 1; index < 3; index += 1) {
    strand(index % 2 === 0 ? 1.4 : -1.4);
  }
  graphics.stroke({ width: 1.2, color: 0xffffff, alpha: 0.5, cap: 'round' });

  // Главная жила и раскалённая нить внутри неё.
  strand(1);
  graphics.stroke({ width: 3.2, color: 0xffffff, alpha: 0.85, cap: 'round' });
  strand(1);
  graphics.stroke({ width: 1.4, color: 0xffffff, alpha: 1, cap: 'round' });

  return bakeTo(renderer, graphics, TILE, TILE_H);
};

/**
 * Ореол одной плитки — вариант «Б», для сравнения.
 *
 * Плох ровно тем, ради чего заведён: свечение каждой плитки обрезано
 * её краями, и на стыках складывается меньше света, чем в середине.
 * По молнии идут тёмные перехваты каждые 64 пикселя. Печётся здесь,
 * чтобы это было видно глазом, а не только в рассуждении.
 */
const bakeGlowTile = (renderer: Renderer, variant: number): Texture => {
  const graphics = new Graphics();
  const noise = noiseFrom(variant);
  const mid = TILE_H / 2;

  const steps = stepsOf(variant);
  const strand = (): void => {
    graphics.moveTo(0, mid);
    for (let step = 1; step <= steps; step += 1) {
      const along = step === steps ? 1 : (step + noise() * 0.3) / steps;
      graphics.lineTo(along * TILE, mid + (step === steps ? 0 : noise() * SWING));
    }
  };

  for (const [width, alpha] of [
    [26, 0.045],
    [17, 0.06],
    [10, 0.08],
    [5, 0.1],
  ] as const) {
    strand();
    graphics.stroke({ width, color: 0xffffff, alpha, cap: 'round' });
  }

  return bakeTo(renderer, graphics, TILE, TILE_H);
};

/** Длина заготовки ореола-полосы. Растягивается по всей длине разряда. */
const BAR = 256;
const BAR_H = 64;

/**
 * Ореол полосой на весь разряд — вариант «А».
 *
 * У ореола нет подробностей, растягивать в нём нечего, поэтому одна
 * заготовка годится на любую длину: на дальнем выстреле она вытянется
 * втрое и этого не будет видно. Зато свечение выходит непрерывным —
 * ни стыков, ни перехватов.
 *
 * Поперечный разрез строится вложенными обводками с закруглёнными
 * концами: к краю полосы яркость сходит на нет, и по торцам тоже.
 * Печётся один раз, поэтому «дорого» здесь не бывает.
 */
const bakeGlowBar = (renderer: Renderer): Texture => {
  const graphics = new Graphics();
  const mid = BAR_H / 2;

  // Яркости низкие нарочно. Первый заход стоял вчетверо выше и дал
  // сплошную зелёную колбасу: на слое сложения вложенные обводки
  // складываются, и в середине полосы яркость доходила до непрозрачной.
  // Ореол обязан оставаться подсветкой вокруг ядра, а не телом молнии.
  for (const [width, alpha] of [
    [24, 0.05],
    [17, 0.065],
    [11, 0.085],
    [6, 0.1],
  ] as const) {
    graphics.moveTo(width / 2, mid).lineTo(BAR - width / 2, mid);
    graphics.stroke({ width, color: 0xffffff, alpha, cap: 'round' });
  }

  return bakeTo(renderer, graphics, BAR, BAR_H);
};

/** Поперечник бегущего пятна света. */
const SPARKLE = 96;

/**
 * Бегущее пятно — голова волны.
 *
 * Мягкий круг без единой подробности, поэтому одной заготовки хватает
 * на всё: она и растягивается, и красится тинтом. Смысл её в том, что
 * одной яркости плиток для волны мало — фронт по ломаной читается плохо,
 * ему нужен свет вокруг, который глаз ловит раньше, чем форму.
 */
const bakeSparkle = (renderer: Renderer): Texture => {
  const graphics = new Graphics();
  const mid = SPARKLE / 2;
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
  return bakeTo(renderer, graphics, SPARKLE, SPARKLE);
};

// ─────────────────────────────────────────────────────────────────────────
// Раскладка молнии
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ширина фронта волны в долях длины разряда.
 *
 * Узкий фронт читается бегущей искрой, широкий — общим разгоранием.
 * Десятая часть длины — это примерно полторы плитки: видно, что бежит
 * именно волна, и при этом канал не распадается на «до» и «после».
 */
const WAVE_WIDTH = 0.11;

/** Насколько фронт ярче остального канала. */
const WAVE_GAIN = 1.15;

/** Яркость канала вне фронта. Не ноль: разряд виден весь, а не кусками. */
const WAVE_FLOOR = 0.42;

/** Подъём яркости плитки под фронтом волны. */
const waveGain = (share: number, front: number): number => {
  const off = (share - front) / WAVE_WIDTH;
  return WAVE_FLOOR + WAVE_GAIN * Math.exp(-0.5 * off * off);
};

/** Предел числа плиток. Страховка: дальность растёт прокачкой без потолка. */
const MAX_TILES = 16;

interface BoltStyle {
  /** Ореол полосой на весь разряд (А) или в каждой плитке (Б). */
  readonly barGlow: boolean;
  /** Цвет стороны: им красится ореол. */
  readonly accent: number;
  /** Сдвиг фазы: рассинхрон плиток по времени. */
  readonly phase: number;
  /**
   * Положение фронта волны в долях длины, от нуля у ствола до единицы
   * в цели. `undefined` — волны нет, канал горит ровно.
   */
  readonly wave?: number;
  /** Заготовка бегущего пятна. Нужна только когда есть волна. */
  readonly sparkle?: Texture;
}

interface Baked {
  readonly cores: readonly Texture[];
  readonly glowTiles: readonly Texture[];
  readonly bar: Texture;
}

/**
 * Разложить молнию от точки к точке.
 *
 * Шаг НЕ равен длине плитки: расстояние непрерывно и в целое число
 * плиток не укладывается никогда. Берётся ближайшее целое число плиток,
 * а шаг подгоняется под остаток — каждая растягивается на единицы
 * процентов, зато разряд начинается точно у ствола и кончается точно
 * в точке попадания. Это не косметика: облик не имеет права врать
 * о том, куда пришёлся урон.
 */
const layBolt = (
  into: Container,
  baked: Baked,
  from: { x: number; y: number },
  to: { x: number; y: number },
  style: BoltStyle,
): number => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;

  const angle = Math.atan2(dy, dx);
  const count = Math.max(2, Math.min(MAX_TILES, Math.round(length / TILE)));
  const step = length / count;

  let sprites = 0;

  if (style.barGlow) {
    const glow = new Sprite(baked.bar);
    glow.anchor.set(0, 0.5);
    glow.position.set(from.x, from.y);
    glow.rotation = angle;
    glow.scale.set(length / BAR, 1);
    glow.tint = style.accent;
    into.addChild(glow);
    sprites += 1;
  }

  for (let index = 0; index < count; index += 1) {
    // Рассинхрон: у каждой плитки своя фаза, поэтому потрескивание бежит
    // вдоль канала, а не вся молния мигает разом.
    const variant = (index * 5 + style.phase * 3) % VARIANTS;
    const x = from.x + (dx * index) / count;
    const y = from.y + (dy * index) / count;

    if (!style.barGlow) {
      const glow = new Sprite(baked.glowTiles[variant] as Texture);
      glow.anchor.set(0, 0.5);
      glow.position.set(x, y);
      glow.rotation = angle;
      glow.scale.set(step / TILE, 1);
      glow.tint = style.accent;
      into.addChild(glow);
      sprites += 1;
    }

    const core = new Sprite(baked.cores[variant] as Texture);
    core.anchor.set(0, 0.5);
    core.position.set(x, y);
    core.rotation = angle;
    core.scale.set(step / TILE, 1);
    core.tint = COLORS.arc;
    // Волна — это яркость плитки, а не её форма: канал стоит на месте,
    // по нему бежит свет. Форму трогать нельзя, иначе разряд начнёт
    // извиваться, а он за свою четверть секунды извиваться не должен.
    core.alpha =
      style.wave === undefined ? 1 : Math.min(1, waveGain((index + 0.5) / count, style.wave));
    into.addChild(core);
    sprites += 1;
  }

  // Голова волны: одно пятно света цвета стороны, бегущее по каналу.
  if (style.wave !== undefined && style.sparkle !== undefined) {
    const head = new Sprite(style.sparkle);
    head.anchor.set(0.5);
    head.position.set(from.x + dx * style.wave, from.y + dy * style.wave);
    head.tint = style.accent;
    // Гаснет у обоих концов: у ствола её перебивает вспышка выстрела,
    // в цели — вспышка попадания, и лишний свет там только мешает.
    head.alpha = Math.sin(Math.PI * Math.min(1, Math.max(0, style.wave))) ** 0.6;
    into.addChild(head);
    sprites += 1;
  }

  return sprites;
};

// ─────────────────────────────────────────────────────────────────────────
// Лист
// ─────────────────────────────────────────────────────────────────────────

const label = (text: string, x: number, y: number, size = 13, fill = 0x9a9a9a): Text =>
  new Text({ text, x, y, style: { fill, fontFamily: 'system-ui', fontSize: size } });

const head = (text: string, x: number, y: number): Text => label(text, x, y, 16, 0xececec);

const shotAt = (from: readonly [number, number], to: readonly [number, number]): ShotState =>
  ({
    owner: LOCAL,
    from: { x: cellsToUnits(from[0]), y: cellsToUnits(from[1]) },
    to: { x: cellsToUnits(to[0]), y: cellsToUnits(to[1]) },
    expiresAtTick: SHOT_LIFETIME_TICKS[ShotWeapon.Arc],
    lethal: false,
    weapon: ShotWeapon.Arc,
    side: ShotSide.Centre,
  }) as unknown as ShotState;

/**
 * Строка состояния на самой странице.
 *
 * Нужна не для красоты: проба почти всё время рисует в холст, а пока
 * она собирается, экран пуст. Пустой экран у собирающейся пробы
 * и у сломанной выглядит одинаково, а разбираться в них приходится
 * по-разному. Отметка `stage` заодно говорит сторожу в разметке,
 * что модуль всё-таки запустился.
 */
const step = (text: string): void => {
  const state = document.querySelector('#state');
  if (state === null || !(state instanceof HTMLElement)) return;
  state.dataset.stage = text;
  state.textContent = `собираю пробу: ${text}…`;
};

const start = async (): Promise<void> => {
  step('поднимаю PixiJS');
  const app = new Application();
  await app.init({
    width: 1560,
    height: 2920,
    background: 0x191919,
    antialias: true,
    resolution: 1,
    autoDensity: true,
    preference: 'webgl',
  });

  document.querySelector('#probe')?.appendChild(app.canvas);

  const sheet = new Container();
  app.stage.addChild(sheet);

  step('пеку плитки молнии');
  const cores: Texture[] = [];
  const glowTiles: Texture[] = [];
  for (let variant = 0; variant < VARIANTS; variant += 1) {
    cores.push(bakeCore(app.renderer, variant));
    glowTiles.push(bakeGlowTile(app.renderer, variant));
  }
  const baked: Baked = { cores, glowTiles, bar: bakeGlowBar(app.renderer) };
  const sparkle = bakeSparkle(app.renderer);
  step('раскладываю панели');

  /** Слой сложения: молния светится, а не закрашивает. */
  const glowLayer = (): Container => {
    const layer = new Container();
    layer.blendMode = 'add';
    sheet.addChild(layer);
    return layer;
  };

  // Дистанции: ближний бой, нынешняя дальность и то, куда она уезжает
  // после прокачки при базе восемь клеток.
  const RANGES = [3, 8, 15] as const;

  /** Прямая линия нужной длины в экранных пикселях, от точки листа. */
  const line = (
    x: number,
    y: number,
    cells: number,
  ): [{ x: number; y: number }, { x: number; y: number }] => {
    const step = worldToScreen(cells, 0);
    const length = Math.hypot(step.x, step.y);
    return [
      { x, y },
      { x: x + length, y: y - length * 0.08 },
    ];
  };

  // ── Заготовки ───────────────────────────────────────────────────────
  sheet.addChild(head('ЗАГОТОВКИ — что именно печётся', 16, 14));
  sheet.addChild(label('плитка ядра, четыре варианта из восьми · 1:1', 40, 40));
  const assets = glowLayer();
  for (let variant = 0; variant < 4; variant += 1) {
    const sprite = new Sprite(cores[variant] as Texture);
    sprite.anchor.set(0, 0.5);
    sprite.position.set(40 + variant * 80, 80);
    sprite.tint = COLORS.arc;
    assets.addChild(sprite);
  }
  sheet.addChild(label('они же ×3 — видно, что концы садятся на осевую', 380, 40));
  for (let variant = 0; variant < 3; variant += 1) {
    const sprite = new Sprite(cores[variant] as Texture);
    sprite.anchor.set(0, 0.5);
    sprite.position.set(380 + variant * 200, 90);
    sprite.scale.set(3);
    sprite.tint = COLORS.arc;
    assets.addChild(sprite);
  }
  sheet.addChild(label('полоса ореола: свой и чужой', 1030, 40));
  {
    const one = new Sprite(baked.bar);
    one.anchor.set(0, 0.5);
    one.position.set(1030, 74);
    one.tint = COLORS.self;
    assets.addChild(one);

    const three = new Sprite(baked.bar);
    three.anchor.set(0, 0.5);
    three.position.set(1030, 118);
    three.scale.set(1, 1);
    three.tint = COLORS.enemy;
    assets.addChild(three);
  }

  // ── Сейчас: геометрия ───────────────────────────────────────────────
  sheet.addChild(head('СЕЙЧАС — геометрия, три дистанции', 16, 170));
  RANGES.forEach((cells, index) => {
    const top = 206 + index * 116;
    sheet.addChild(label(`${cells} клеток`, 16, top, 12));

    // Каждый ряд в своей рамке: на пятнадцати клетках разряд уходит
    // на семьсот пикселей вкось и без обрезки лёг бы на соседние ряды.
    const row = new Container();
    sheet.addChild(row);
    const clip = new Graphics();
    clip.rect(120, top - 6, 1420, 112);
    clip.fill({ color: 0xffffff });
    row.addChild(clip);
    row.mask = clip;

    const box = new Container();
    const anchor = worldToScreen(10, 10);
    box.position.set(140 - anchor.x, top + 16 - anchor.y);
    const trails = new Graphics();
    const glow = new Graphics();
    glow.blendMode = 'add';
    box.addChild(trails, glow);
    row.addChild(box);

    const layers: ShotLayers = { trails, glow, arcs: NO_ARCS };
    const world = {
      shots: [shotAt([10, 10], [10 + cells, 10])],
      structures: [],
      blasts: [],
      nukes: [],
    } as unknown as WorldState;
    drawShots(layers, world, 0.03 * TICKS_PER_SECOND, WIDE, SHOT_COLORS, LOCAL);
  });

  // ── Плитками ────────────────────────────────────────────────────────
  const rows: readonly {
    readonly title: string;
    readonly accent: number;
    readonly barGlow: boolean;
  }[] = [
    { title: 'А · ПЛИТКИ + ОРЕОЛ ПОЛОСОЙ — свой', accent: COLORS.self, barGlow: true },
    { title: 'А · то же, чужой', accent: COLORS.enemy, barGlow: true },
    {
      title: 'Б · ОРЕОЛ В КАЖДОЙ ПЛИТКЕ — свой (сравнить стыки)',
      accent: COLORS.self,
      barGlow: false,
    },
  ];

  let cursor = 566;
  let spriteCount = 0;
  for (const row of rows) {
    sheet.addChild(head(row.title, 16, cursor));
    RANGES.forEach((cells, index) => {
      const top = cursor + 44 + index * 78;
      sheet.addChild(label(`${cells} кл.`, 16, top - 12, 12));
      const layer = glowLayer();
      const [from, to] = line(140, top + 22, cells);
      spriteCount += layBolt(layer, baked, from, to, {
        barGlow: row.barGlow,
        accent: row.accent,
        phase: 0,
      });
    });
    cursor += 44 + RANGES.length * 78 + 22;
  }

  // ── Рассинхрон ──────────────────────────────────────────────────────
  sheet.addChild(head('РАССИНХРОН — один разряд, четыре тика подряд', 16, cursor));
  for (let phase = 0; phase < 4; phase += 1) {
    const top = cursor + 44 + phase * 62;
    sheet.addChild(label(`тик +${phase}`, 16, top - 10, 12));
    const layer = glowLayer();
    const [from, to] = line(140, top + 16, 8);
    layBolt(layer, baked, from, to, { barGlow: true, accent: COLORS.self, phase });
  }
  cursor += 44 + 4 * 62 + 24;

  // ── Волна ───────────────────────────────────────────────────────────
  sheet.addChild(head('ВОЛНА — фронт бежит от ствола к цели, шесть мгновений', 16, cursor));
  const FRONTS = [0.08, 0.26, 0.44, 0.62, 0.8, 0.97] as const;
  FRONTS.forEach((front, index) => {
    const top = cursor + 44 + index * 58;
    sheet.addChild(label(`${Math.round(front * 100)}%`, 16, top - 10, 12));
    const layer = glowLayer();
    const [from, to] = line(140, top + 14, 8);
    layBolt(layer, baked, from, to, {
      barGlow: true,
      accent: COLORS.self,
      phase: index,
      wave: front,
      sparkle,
    });
  });
  cursor += 44 + FRONTS.length * 58 + 26;

  sheet.addChild(head('ВОЛНА — то же у чужого, и без бегущего пятна для сравнения', 16, cursor));
  FRONTS.forEach((front, index) => {
    const top = cursor + 44 + index * 58;
    const layer = glowLayer();
    const [from, to] = line(140, top + 14, 8);
    layBolt(layer, baked, from, to, {
      barGlow: true,
      accent: COLORS.enemy,
      phase: index,
      wave: front,
      sparkle,
    });

    const bare = glowLayer();
    const [from2, to2] = line(820, top + 14, 8);
    layBolt(bare, baked, from2, to2, {
      barGlow: true,
      accent: COLORS.enemy,
      phase: index,
      wave: front,
    });
  });
  sheet.addChild(label('с пятном', 140, cursor + 30, 12));
  sheet.addChild(label('только яркость плиток', 820, cursor + 30, 12));
  cursor += 44 + FRONTS.length * 58 + 26;

  // ── Стыки крупно ────────────────────────────────────────────────────
  sheet.addChild(head('СТЫКИ ×3 — распадается ли канал в пунктир', 16, cursor));
  {
    const zoom = new Container();
    zoom.blendMode = 'add';
    zoom.scale.set(3);
    zoom.position.set(40, cursor + 46);
    sheet.addChild(zoom);

    const inner = new Container();
    zoom.addChild(inner);
    layBolt(
      inner,
      baked,
      { x: 0, y: 22 },
      { x: 158, y: 22 },
      {
        barGlow: true,
        accent: COLORS.self,
        phase: 1,
      },
    );

    const zoomB = new Container();
    zoomB.blendMode = 'add';
    zoomB.scale.set(3);
    zoomB.position.set(560, cursor + 46);
    sheet.addChild(zoomB);
    const innerB = new Container();
    zoomB.addChild(innerB);
    layBolt(
      innerB,
      baked,
      { x: 0, y: 22 },
      { x: 158, y: 22 },
      {
        barGlow: false,
        accent: COLORS.self,
        phase: 1,
      },
    );

    sheet.addChild(label('А · ореол полосой', 40, cursor + 40, 12));
    sheet.addChild(label('Б · ореол в плитках', 560, cursor + 40, 12));
  }

  app.render();
  document.querySelector('#state')?.remove();
  document.title = `проба готова · спрайтов на девять разрядов: ${spriteCount}`;
};

void start().catch((error: unknown) => {
  document.title = 'проба сломалась';
  // Поломку показываем НА СТРАНИЦЕ, а не только в консоли: пустой холст
  // и пустой холст с ошибкой выглядят одинаково, а разбираться в них
  // приходится по-разному.
  const state = document.querySelector('#state');
  if (state !== null) {
    state.setAttribute('data-broken', '');
    state.textContent = `проба сломалась: ${String(error)}`;
  }
  console.error(error);
});
