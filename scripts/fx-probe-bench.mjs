/**
 * Замер цены отрисовки выстрелов и взрывов: «до» против «после».
 *
 * Временная оснастка изменения по облику выстрелов, взрывов и зеркала
 * поля. Гоняет НАСТОЯЩИЕ функции отрисовки в настоящем PixiJS: поднимает
 * своё приложение на дев-сервере клиента и вызывает `drawShots`
 * и `drawBlasts` в цикле.
 *
 * «До» берётся из копий рядом с боевыми модулями:
 *
 *   git show HEAD:apps/client/src/game/shots.ts > apps/client/src/game/shots.before.ts
 *
 * Копия лежит в том же каталоге, поэтому её относительные импорты
 * разрешаются. Удалять сразу после замера — иначе попадёт в линт и tsc.
 *
 * Через Playwright, а не через консоль вкладки, по одной причине:
 * на этой машине рядом работают другие сессии, замер занимает больше
 * тридцати секунд, и вкладка отваливается по таймауту посреди прогона.
 *
 * **Чему здесь верить, а чему нет.** Headless-Chromium рисует не тем же,
 * чем настоящее окно: там, где у окна аппаратный ANGLE поверх Direct3D,
 * здесь может оказаться программный растеризатор. Отношения «до/после»
 * он показывает верно, а вот вес заливки пикселей завышает — эффекты
 * из широких полупрозрачных обводок (свечение) выходят дороже, чем
 * на настоящей видеокарте. Абсолютные миллисекунды снимайте в живой
 * вкладке, отсюда берите только отношения.
 *
 * И обязательно смотрите на контрольный случай: если «до» и «после»
 * на неизменном коде разошлись больше чем на пару процентов, машина
 * шумит и прогон надо повторить.
 *
 *   node scripts/fx-probe-bench.mjs
 */
import { chromium } from '@playwright/test';

const BENCH = `(async () => {
  const src = await (await fetch('/src/game/scene.ts')).text();
  const pixiPath = /from ["']([^"']*pixi[^"']*)["']/.exec(src)[1];
  const PIXI = await import(pixiPath);
  const shared = await import('/@id/@td/shared');
  const iso = await import('/src/game/iso.ts');
  const S1 = await import('/src/game/shots.before.ts');
  const S2 = await import('/src/game/shots.ts');
  const AR = await import('/src/game/arc-render.ts');
  const B1 = await import('/src/game/blasts.before.ts');
  const B2 = await import('/src/game/blasts.ts');

  const app = new PIXI.Application();
  await app.init({ width: 1600, height: 900, background: 0x191919, antialias: true, resolution: 1, preference: 'webgl' });
  const mk = (a) => { const g = new PIXI.Graphics(); if (a) g.blendMode = 'add'; app.stage.addChild(g); return g; };
  const SL1 = { trails: mk(0), glow: mk(1) };
  // Новой версии нужен слой раскладки разрядов: молния рисуется
  // спрайтами и в слой линий не попадает вовсе.
  const arcSprites = AR.createArcSprites(app.renderer, { arc: 0x5aa6ff });
  app.stage.addChild(arcSprites.layer);
  const SL2 = { trails: mk(0), glow: mk(1), arcs: arcSprites };
  const BL = { debris: mk(0), glow: mk(1), flash: mk(1) };

  // Цвет молнии есть уже и в «до»: в HEAD лежит геометрическая версия
  // разряда, которая его читает. Без него она падает на первой обводке.
  const C1 = { self: 0x00ff29, enemy: 0xd264ff, hullDark: 0x23271f, shot: 0xeaffef,
    shotLethal: 0xff5c5c, arc: 0x5aa6ff, core: 0xfff6e0, fire: 0xff8a2b, smoke: 0x2b2622 };
  const C2 = { ...C1 };

  const CX = 24, CY = 24, c = iso.worldToScreen(CX, CY);
  // Область видимости — МИРОВЫЕ экранные координаты. Промахнись мимо,
  // и мерить будешь стоимость отсечения, а не отрисовки.
  const view = { minX: c.x - 800, maxX: c.x + 800, minY: c.y - 450, maxY: c.y + 450 };
  const u = (n) => shared.cellsToUnits(n);

  const mkS = (n, w) => { const life = shared.SHOT_LIFETIME_TICKS[w], o = [];
    for (let i = 0; i < n; i += 1) { const a = (i / n) * 6.283;
      o.push({ owner: i % 2, from: { x: u(CX + Math.cos(a) * 4), y: u(CY + Math.sin(a) * 4) },
        to: { x: u(CX + Math.cos(a + 0.6) * 1.5), y: u(CY + Math.sin(a + 0.6) * 1.5) },
        expiresAtTick: 100 + life - 1.5, lethal: i % 3 === 0, weapon: w, side: 0 }); }
    return { shots: o, structures: [], blasts: [], nukes: [] }; };
  const mkB = (n, k) => { const life = shared.BLAST_LIFETIME_TICKS[k], o = [];
    for (let i = 0; i < n; i += 1) { const a = (i / n) * 6.283;
      o.push({ at: { x: u(CX + Math.cos(a) * 3), y: u(CY + Math.sin(a) * 3) }, kind: k, owner: i % 2,
        expiresAtTick: 100 + life * 0.6 }); }
    return { shots: [], structures: [], blasts: o, nukes: [] }; };

  const clr = () => { SL1.trails.clear(); SL1.glow.clear(); SL2.trails.clear(); SL2.glow.clear();
    BL.debris.clear(); BL.glow.clear(); BL.flash.clear(); arcSprites.begin(); arcSprites.end(); };
  const shots = (mod, colors, w) => () => { clr();
    const layers = mod === S2 ? SL2 : SL1;
    if (mod === S2) arcSprites.begin();
    mod.drawShots(layers, w, 100, view, colors, 0);
    if (mod === S2) arcSprites.end();
    app.render(); };
  const blasts = (mod, colors, w) => () => { clr(); mod.drawBlasts(BL, w, 100, view, { width: 1600, height: 900 }, colors, 0); app.render(); };

  const bolt = mkS(8, shared.ShotWeapon.Bolt);
  const beam = mkS(8, shared.ShotWeapon.Beam);
  const arc = mkS(8, shared.ShotWeapon.Arc);
  const arc15 = mkS(15, shared.ShotWeapon.Arc);
  const b1 = mkB(1, shared.BlastKind.Unit);
  const b10 = mkB(10, shared.BlastKind.Unit);
  const b30 = mkB(30, shared.BlastKind.Unit);

  const cases = {
    'трассеры 8 (контроль) · до': shots(S1, C1, bolt),
    'трассеры 8 (контроль) · после': shots(S2, C2, bolt),
    'лучи 8 · до': shots(S1, C1, beam),
    'лучи 8 · после': shots(S2, C2, beam),
    'разряды 8 · до': shots(S1, C1, arc),
    'разряды 8 · после': shots(S2, C2, arc),
    'разрядов 15 · до': shots(S1, C1, arc15),
    'разрядов 15 · после': shots(S2, C2, arc15),
    'взрыв 1 · до': blasts(B1, C1, b1),
    'взрыв 1 · после': blasts(B2, C2, b1),
    'взрывов 10 · до': blasts(B1, C1, b10),
    'взрывов 10 · после': blasts(B2, C2, b10),
    'взрывов 30 · до': blasts(B1, C1, b30),
    'взрывов 30 · после': blasts(B2, C2, b30),
  };

  const keys = Object.keys(cases), acc = {};
  for (const k of keys) acc[k] = [];
  // Общий разогрев всех вариантов: иначе первый платит за создание
  // конвейеров и текстур градиентов.
  for (const k of keys) for (let i = 0; i < 8; i += 1) cases[k]();
  // Чередование и МИНИМУМ по заходам: помеха может только замедлить,
  // поэтому лучший заход и есть настоящая цена. Контрольный случай
  // в наборе — код, который не менялся: разошёлся он больше чем
  // на пару процентов, значит машина шумит и замер надо повторить.
  for (let r = 0; r < 13; r += 1) for (const k of keys) {
    const t0 = performance.now();
    for (let i = 0; i < 8; i += 1) cases[k]();
    acc[k].push((performance.now() - t0) / 8);
  }
  const out = {};
  for (const k of keys) out[k] = Math.round(Math.min(...acc[k]) * 1000) / 1000;
  app.destroy(true, { children: true });
  return out;
})()`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (error) => console.error('страница:', error.message));

await page.goto('http://localhost:5173/fx-probe.html', { waitUntil: 'domcontentloaded' });
const result = await page.evaluate(BENCH);
await browser.close();

const rows = Object.entries(result);
const width = Math.max(...rows.map(([name]) => name.length));
for (const [name, ms] of rows) console.log(name.padEnd(width), ms.toFixed(3), 'мс');
