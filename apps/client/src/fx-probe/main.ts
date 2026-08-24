import { Application, Container, Graphics, Text } from 'pixi.js';
import {
  BLAST_LIFETIME_TICKS,
  BlastKind,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  SHOT_LIFETIME_TICKS,
  ShotSide,
  ShotWeapon,
  TICKS_PER_SECOND,
  cellsToUnits,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { createWorld } from '@td/sim';
import type { BlastState, ShotState, WorldState } from '@td/sim';
import { worldToScreen } from '../game/iso.js';
import { drawShots } from '../game/shots.js';
import type { ShotColors, ShotLayers } from '../game/shots.js';
import { createArcSprites } from '../game/arc-render.js';
import { drawBlasts } from '../game/blasts.js';
import type { BlastColors, BlastLayers } from '../game/blasts.js';
import { mountRockDiagonal } from '../game/relief-render.js';

/**
 * Проба облика выстрелов, взрывов и зеркала поля.
 *
 * Временная страница, в сборку не входит. Нужна ровно затем, чтобы снять
 * пару картинок «до» и «после» одним и тем же кодом: панель браузера
 * в сессии не отображается, а Playwright эту страницу снимает.
 *
 * Ничего своего страница не рисует — она вызывает боевые функции
 * отрисовки. Иначе сравнение показывало бы макет, а не игру.
 */

const COLORS = {
  self: 0x00ff29,
  enemy: 0xd264ff,
  hullDark: 0x23271f,
  shot: 0xeaffef,
  shotLethal: 0xff5c5c,
  core: 0xfff6e0,
  fire: 0xff8a2b,
  smoke: 0x2b2622,
  arc: 0x5aa6ff,
} as const;

const SHOT_COLORS: ShotColors = COLORS;
const BLAST_COLORS: BlastColors = COLORS;

const LOCAL: PlayerId = 0 as PlayerId;
const WIDE = { minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6 };

/**
 * Разряд рисуется боевой раскладкой спрайтов, а не заглушкой.
 *
 * Иначе проба сравнивала бы облик, которого в игре нет: молния —
 * единственный выстрел, который не попадает в слой линий вовсе.
 */

const label = (text: string, x: number, y: number, size = 14, fill = 0xececec): Text =>
  new Text({ text, x, y, style: { fill, fontFamily: 'system-ui', fontSize: size } });

const shotAt = (
  from: readonly [number, number],
  to: readonly [number, number],
  weapon: ShotWeapon,
  lethal: boolean,
  owner: number = LOCAL,
): ShotState =>
  ({
    owner,
    from: { x: cellsToUnits(from[0]), y: cellsToUnits(from[1]) },
    to: { x: cellsToUnits(to[0]), y: cellsToUnits(to[1]) },
    // Срок жизни отсчитывается назад от возраста: возраст задаёт вызывающий.
    expiresAtTick: SHOT_LIFETIME_TICKS[weapon],
    lethal,
    weapon,
    side: ShotSide.Centre,
  }) as unknown as ShotState;

const blastAt = (at: readonly [number, number], kind: BlastKind, owner: number): BlastState =>
  ({
    at: { x: cellsToUnits(at[0]), y: cellsToUnits(at[1]) },
    kind,
    owner,
    expiresAtTick: BLAST_LIFETIME_TICKS[kind],
  }) as unknown as BlastState;

const emptyWorld = (): WorldState =>
  ({ shots: [], structures: [], blasts: [], nukes: [] }) as unknown as WorldState;

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
    height: 1400,
    background: 0x191919,
    antialias: true,
    resolution: 1,
    autoDensity: true,
    preference: 'webgl',
  });

  document.querySelector('#probe')?.appendChild(app.canvas);

  const sheet = new Container();
  app.stage.addChild(sheet);

  /**
   * Панель: свои слои эффектов, сдвинутые так, чтобы мировая точка
   * `centre` легла в точку листа `(x, y)`.
   */
  const panel = (
    x: number,
    y: number,
    centre: readonly [number, number],
    paint: (shots: ShotLayers, blasts: BlastLayers, world: WorldState, time: number) => void,
    time: number,
  ): void => {
    const box = new Container();
    const anchor = worldToScreen(centre[0], centre[1]);
    box.position.set(x - anchor.x, y - anchor.y);

    const trails = new Graphics();
    const debris = new Graphics();
    const shotGlow = new Graphics();
    const blastGlow = new Graphics();
    const flash = new Graphics();
    shotGlow.blendMode = 'add';
    blastGlow.blendMode = 'add';
    flash.blendMode = 'add';

    // Своя раскладка разрядов на панель: контейнер живёт у одного
    // родителя, а панелей на листе много.
    const arcs = createArcSprites(app.renderer, { arc: COLORS.arc });
    arcs.begin();

    box.addChild(debris, trails, shotGlow, arcs.layer, blastGlow);
    sheet.addChild(box);

    paint({ trails, glow: shotGlow, arcs }, { debris, glow: blastGlow, flash }, emptyWorld(), time);
    arcs.end();
  };

  const shotPanel = (
    x: number,
    y: number,
    centre: readonly [number, number],
    shots: readonly ShotState[],
    ageSeconds: number,
  ): void => {
    const world = { shots, structures: [], blasts: [], nukes: [] } as unknown as WorldState;
    panel(
      x,
      y,
      centre,
      (layers) => {
        drawShots(layers, world, ageSeconds * TICKS_PER_SECOND, WIDE, SHOT_COLORS, LOCAL);
      },
      0,
    );
  };

  const blastPanel = (
    x: number,
    y: number,
    centre: readonly [number, number],
    blasts: readonly BlastState[],
    ageSeconds: number,
  ): void => {
    const world = { shots: [], structures: [], blasts, nukes: [] } as unknown as WorldState;
    panel(
      x,
      y,
      centre,
      (_shots, layers) => {
        drawBlasts(
          layers,
          world,
          ageSeconds * TICKS_PER_SECOND,
          WIDE,
          { width: 1560, height: 1400 },
          BLAST_COLORS,
          LOCAL,
        );
      },
      0,
    );
  };

  // ── Луч снайпера ────────────────────────────────────────────────────
  sheet.addChild(label('ЛУЧ СНАЙПЕРА — попадание и добивание', 16, 14, 16));
  sheet.addChild(label('в полёте, 0,03 с', 40, 38, 12, 0x9a9a9a));
  shotPanel(300, 130, [24, 24], [shotAt([22, 26], [26, 22], ShotWeapon.Beam, false)], 0.03);
  sheet.addChild(label('добивающий, 0,03 с', 800, 38, 12, 0x9a9a9a));
  shotPanel(1060, 130, [24, 24], [shotAt([22, 26], [26, 22], ShotWeapon.Beam, true)], 0.03);

  // ── Разряд Теслы ────────────────────────────────────────────────────
  sheet.addChild(label('РАЗРЯД ТЕСЛЫ — свой и чужой', 16, 240, 16));
  sheet.addChild(label('свой: зелёное свечение', 40, 264, 12, 0x9a9a9a));
  shotPanel(340, 380, [24, 24], [shotAt([22, 26], [25, 23], ShotWeapon.Arc, false)], 0.03);
  sheet.addChild(label('чужой: фиолетовое свечение', 800, 264, 12, 0x9a9a9a));
  shotPanel(1100, 380, [24, 24], [shotAt([22, 26], [25, 23], ShotWeapon.Arc, false, 1)], 0.03);

  // ── Взрыв юнита ─────────────────────────────────────────────────────
  sheet.addChild(label('ВЗРЫВ ЮНИТА — пять мгновений одного взрыва', 16, 500, 16));
  const moments = [0.04, 0.15, 0.32, 0.55, 0.76];
  moments.forEach((seconds, index) => {
    sheet.addChild(label(`${seconds.toFixed(2)} с`, 60 + index * 300, 524, 12, 0x9a9a9a));
    blastPanel(170 + index * 300, 660, [24, 24], [blastAt([24, 24], BlastKind.Unit, 0)], seconds);
  });

  // ── Поле и горы ─────────────────────────────────────────────────────
  sheet.addChild(label('ПОЛЕ КАК ЗЕРКАЛО — сетка, гряда и то, что она отражает', 16, 800, 16));

  step('строю карту');
  const world = createWorld(20260823);
  const map = world.map;

  const field = new Container();
  sheet.addChild(field);

  // Сетка земли рисуется здесь, а не берётся из terrain.ts: проба должна
  // держаться за как можно меньшее число чужих модулей.
  const ground = new Graphics();
  for (const major of [false, true]) {
    for (let x = 0; x <= MAP_WIDTH_CELLS; x += 1) {
      if ((x % 4 === 0) !== major) continue;
      const a = worldToScreen(x, 0);
      const b = worldToScreen(x, MAP_HEIGHT_CELLS);
      ground.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    for (let y = 0; y <= MAP_HEIGHT_CELLS; y += 1) {
      if ((y % 4 === 0) !== major) continue;
      const a = worldToScreen(0, y);
      const b = worldToScreen(MAP_WIDTH_CELLS, y);
      ground.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    ground.stroke({ width: 1, color: major ? 0x4d4d4d : 0x3a3a3a });
  }
  field.addChild(ground);

  // Самое долгое место пробы: три с половиной сотни скальных клеток,
  // каждая со своей сеткой и своей выпечкой. Несколько секунд.
  step('пеку скалы, это несколько секунд');
  for (let diagonal = 0; diagonal < MAP_WIDTH_CELLS + MAP_HEIGHT_CELLS - 1; diagonal += 1) {
    const band = new Container();
    field.addChild(band);
    mountRockDiagonal(band, app.renderer, map, diagonal, { rock: 0x6e6a63, sky: 0x5c7ea8 });
  }

  // Ищем самую густую гряду: панель обязана показывать горы, а не пустое
  // поле, и место для неё выбирается по карте, а не на глаз.
  let bestX = 24;
  let bestY = 24;
  let bestCount = -1;
  for (let y = 4; y < MAP_HEIGHT_CELLS - 4; y += 2) {
    for (let x = 4; x < MAP_WIDTH_CELLS - 4; x += 2) {
      let count = 0;
      for (let dy = -3; dy <= 3; dy += 1) {
        for (let dx = -3; dx <= 3; dx += 1) {
          if (map.cells[(y + dy) * MAP_WIDTH_CELLS + (x + dx)] !== 0) count += 1;
        }
      }
      if (count > bestCount) {
        bestCount = count;
        bestX = x;
        bestY = y;
      }
    }
  }

  const focus = worldToScreen(bestX + 1, bestY + 1);
  field.position.set(780 - focus.x, 1120 - focus.y);

  const clip = new Graphics();
  clip.rect(16, 826, 1528, 560);
  clip.fill({ color: 0xffffff });
  field.mask = clip;
  sheet.addChild(clip);

  app.render();
  document.querySelector('#state')?.remove();
  document.title = 'проба готова';
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
