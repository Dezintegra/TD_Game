import { Application, Container, Graphics, Sprite } from 'pixi.js';
import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS } from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellIndex, cellX, cellY } from '@td/sim';
import type { GameMap, WorldState } from '@td/sim';
import { clampCamera, clampZoom, createCamera, moveCamera, scaleOf, zoomAt } from './camera.js';
import type { Camera } from './camera.js';
import { TERRAIN_DIAGONAL_COUNT, drawGround } from './terrain.js';
import { clearRockLayer, mountRockDiagonal } from './relief-render.js';
import type { TerrainColors } from './terrain.js';
import { placeBase } from './base-structure.js';
import type { BaseColors } from './base-structure.js';
import { drawEntities } from './entities.js';
import { createIconBaker } from './icon-sprites.js';
import type { IconBaker, IconMap } from './icon-sprites.js';
import { createMachineSprites } from './machine-sprites.js';
import { createStructureSprites } from './structure-sprites.js';
import type { StructureSpriteColors, StructureSprites } from './structure-sprites.js';
import type { MachineSpriteColors, MachineSprites } from './machine-sprites.js';
import type { EntityColors, EntityLayers, ViewBounds } from './entities.js';
import { drawShots } from './shots.js';
import type { ShotColors, ShotLayers } from './shots.js';
import { createArcSprites } from './arc-render.js';
import type { ArcSprites } from './arc-render.js';
import { drawBlasts, shakeOffset } from './blasts.js';
import type { BlastColors, BlastLayers } from './blasts.js';
import { createFrameClock } from './clock.js';
import { drawOverlays } from './overlays.js';
import type { OverlayColors, OverlayIntent } from './overlays.js';
import { drawTouchStick } from './touch-stick.js';
import type { TouchStickColors } from './touch-stick.js';
import {
  drawMinimapEntities,
  drawMinimapTerrain,
  minimapCellAt,
  minimapLayout,
} from './minimap.js';
import type { MinimapColors, MinimapLayout } from './minimap.js';
import { screenToWorld, worldToScreen } from './iso.js';
import type { CellPoint } from './iso.js';

/**
 * Сцена PixiJS: всё, что рисуется на игровом поле.
 *
 * React сюда не заглядывает. Это принципиально: поле обновляется каждый
 * кадр, и прогон таких обновлений через виртуальный DOM съел бы весь бюджет
 * времени. PixiJS рисует через WebGL и держит тысячи объектов на стабильных
 * 60 кадрах.
 *
 * Слои разделены по частоте изменения:
 *
 *   земля       — перестраивается при смене карты, то есть почти никогда;
 *   территория  — то же самое, но разложена по диагоналям;
 *   сущности    — каждый кадр;
 *   трассеры    — каждый кадр, поверх всех тел;
 *   поверх тел  — каждый кадр: то, чему прятаться за телами нельзя;
 *   подсказки   — каждый кадр, но зависят от намерения игрока, а не мира;
 *   миникарта   — несколько раз в секунду и в экранных координатах.
 *
 * Разделение по частоте важнее разделения по смыслу: слой, который
 * не изменился, не должен платить за соседа, который изменился.
 *
 * Но одного разделения по частоте мало. Первая версия держала всю
 * территорию одним слоем под слоем сущностей, и юнит за скалой рисовался
 * поверх неё: порядок «ближний перекрывает дальнего» действовал внутри
 * каждого слоя и не действовал между ними.
 *
 * Поэтому территория и сущности чередуются по полосам глубины. Слой
 * территории с номером `d` содержит клетки диагонали `x + y = d`, то есть
 * объекты глубины ровно `d + 1`. Слой сущностей с номером `k` собирает
 * объекты глубины из полуинтервала `[k, k + 1)`. Выставленные в порядке
 *
 *   сущности[0], территория[0], сущности[1], территория[1], ...
 *
 * они дают ровно тот порядок, который нужен: сущности слоя `d` дальше
 * скалы диагонали `d` и рисуются раньше неё, сущности слоя `d + 1` ближе
 * и рисуются позже.
 *
 * Совпадение глубины возможно только у объектов одной диагонали, а такие
 * в аксонометрии стоят на экране бок о бок и не перекрываются вовсе —
 * их взаимный порядок безразличен.
 *
 * Геометрия территории при этом по-прежнему строится один раз на карту:
 * разложить её по слоям — не то же самое, что перестраивать её на кадре.
 *
 * Цвета берутся из тех же дизайн-токенов, что и HUD, — читаются из CSS.
 * Так палитра остаётся в одном месте, а не расползается по двум рендерерам.
 */
export interface Scene {
  /**
   * Показывает карту. Геометрия перестраивается только при смене карты.
   *
   * Кто здесь играет — нужно самой карте, а не только сущностям: базы
   * стоят на ней, и красятся они по принадлежности, а принадлежность
   * без номера местного игрока не выводится.
   */
  setMap(map: GameMap, localPlayer: PlayerId): void;
  /**
   * Продолжить запекание скал, потратив не больше отпущенного.
   *
   * Возвращает `true`, пока осталась работа. Вызывать положено каждый
   * кадр: скалы карты стоят около полутора секунд счёта, и одним куском
   * их печь нельзя — столько же простоял бы главный поток, а вместе с ним
   * и разбор кадров матча, которые всё это время копятся в сокете.
   */
  bakeTerrain(budgetMs: number): boolean;
  /**
   * Запечь очередную иконку интерфейса.
   *
   * Возвращает пополненную карту, пока работа есть, и `null`, когда всё
   * запечено. Вызывать положено из кадра и ПОСЛЕ того, как допечён
   * рельеф: одну работу в кадре мы уже держим, и вторая рядом с ней
   * означала бы съеденный кадр вместо отложенного запекания.
   *
   * Иконки отдаются наружу, а не ставятся сценой на место: рисует их
   * React, а сцена о нём не знает и знать не должна.
   */
  bakeIcons(): IconMap | null;
  /** Рисует текущее состояние мира и подсказки. */
  render(world: WorldState, localPlayer: PlayerId, intent: OverlayIntent): void;
  /** Сдвигает камеру на заданное число экранных пикселей и снимает слежение. */
  panBy(dx: number, dy: number): void;
  /** Ставит камеру в клетку карты и снимает слежение. */
  centreOnCell(cell: number): void;
  /** Включает слежение камеры за точкой (в клетках). */
  follow(point: CellPoint | undefined): void;
  setFollowing(enabled: boolean): void;
  readonly following: boolean;
  /**
   * Меняет приближение, оставляя точку под пальцем на месте.
   *
   * `factor` — во сколько раз приблизить относительно нынешнего;
   * больше единицы приближает, меньше — отдаляет. Точка отсчёта
   * задаётся в координатах контейнера сцены: для колеса это курсор,
   * для щипка — середина между пальцами.
   *
   * Границы диапазона держит сама сцена: отдалить дальше дефолтного
   * масштаба нельзя, приблизить — не больше чем вчетверо. Управлению
   * знать эти числа незачем, оно сообщает жест, а не результат.
   */
  zoomBy(factor: number, anchorX: number, anchorY: number): void;
  /** Во сколько раз игрок приблизил картинку относительно дефолта. */
  readonly zoom: number;
  /** Действующий масштаб мира. Нужен проверкам и замерам. */
  readonly scale: number;
  /** Клетка карты под точкой экрана, либо -1. */
  cellAtScreen(screenX: number, screenY: number): number;
  /** Клетка карты под точкой миникарты, либо -1. */
  minimapCellAtScreen(screenX: number, screenY: number): number;
  resize(): void;
  destroy(): void;
  /**
   * Центр обзора в клетках карты.
   *
   * Камера хранит точку в экранных координатах мира, а звуку нужно
   * мировое удаление: громкость зависит от того, как далеко событие
   * произошло на самом деле, а не от того, во сколько пикселей это
   * вылилось в косой проекции.
   */
  readonly viewCentre: CellPoint;
  /** Сколько раз перестраивалась геометрия территории. Нужно тестам. */
  readonly terrainRebuildCount: number;
  readonly viewportSize: { readonly width: number; readonly height: number };
}

/**
 * В каком порядке печь диагонали территории.
 *
 * От базы местного игрока наружу, а не от нулевой диагонали к последней.
 * Порядок ПЕРЕКРЫТИЯ от этого не зависит вовсе: слои созданы заранее
 * и лежат в контейнере мира в своём порядке, так что кто кого заслоняет,
 * решено до всякого запекания. Зависит другое — что игрок увидит первым.
 *
 * А это существенно, потому что печётся теперь не всё разом. Камера
 * в начале матча стоит на базе игрока, и при обходе с нулевой диагонали
 * его собственный командный центр появлялся бы через полсотни кадров
 * после начала матча — на пустом поле, посреди уже идущей игры.
 * Проверено снимком: выглядит поломкой.
 */
const bakeOrderOf = (map: GameMap, localPlayer: PlayerId, count: number): number[] => {
  const home = map.baseCells[localPlayer];
  const centre = home === undefined ? 0 : cellX(home) + cellY(home);

  return Array.from({ length: count }, (_unused, diagonal) => diagonal).sort(
    (left, right) => Math.abs(left - centre) - Math.abs(right - centre),
  );
};

const readToken = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
};

/** Переводит цвет из CSS в число, понятное PixiJS. */
const toPixiColor = (cssColor: string, fallback: number): number => {
  const match = /^#([0-9a-f]{6})$/i.exec(cssColor);
  return match?.[1] === undefined ? fallback : Number.parseInt(match[1], 16);
};

const token = (name: string, fallback: number): number =>
  toPixiColor(readToken(name, ''), fallback);

/**
 * Размер из токена, в точках.
 *
 * Читается так же, как цвета, и по той же причине: величина живёт в CSS,
 * потому что от размера экрана зависит она, а не игровая логика. Второе
 * её объявление здесь числом разошлось бы с первым при первой же правке
 * раскладки — и разошлось бы молча.
 */
const sizeToken = (name: string, fallback: number): number => {
  const found = /^(-?[\d.]+)px$/.exec(readToken(name, ''));
  return found?.[1] === undefined ? fallback : Number(found[1]);
};

const readTerrainColors = (): TerrainColors => ({
  grid: token('--td-border-subtle', 0x3a3a3a),
  gridMajor: token('--td-border-control', 0x4d4d4d),
  rock: token('--td-rock', 0x6e6a63),
  rockSky: token('--td-rock-sky', 0x5c7ea8),
  border: token('--td-text-muted-4', 0x6b6b6b),
});

/**
 * Цвета командного центра.
 *
 * Цвет стороны приходит отдельным доводом: базы две, и различаются они
 * только им. Читаем --td-accent, а не --td-player-self: последний
 * объявлен через var(), и получить из него готовый цвет средствами
 * getComputedStyle надёжно не выйдет.
 */
const readBaseColors = (accent: number): BaseColors => ({
  concrete: token('--td-concrete', 0x6b6f72),
  metal: token('--td-metal', 0x8b9299),
  accent,
  // Свет неба тот же, что у скал: источник один на весь мир.
  sky: token('--td-rock-sky', 0x5c7ea8),
});

/**
 * Цвета брони.
 *
 * Машина покрашена в графит, а цвет стороны несут маркеры и подсветка
 * по краю тела. Поэтому здесь четыре нейтральных оттенка и два цвета
 * сторон, а не «тёмная основа плюс примесь», как было у заливок.
 */
const readMachineColors = (): MachineSpriteColors => ({
  plate: token('--td-hull-plate', 0x3d4245),
  metal: token('--td-hull-metal', 0x585e62),
  shadow: token('--td-hull-shadow', 0x131618),
  glass: token('--td-hull-glass', 0x232e36),
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  // Небо то же, что подсвечивает скалы: разный подсвет у соседних
  // предметов читается ошибкой.
  sky: token('--td-rock-sky', 0x5c7ea8),
  ground: token('--td-bg-page', 0x191919),
});

/**
 * Цвета постройки.
 *
 * Броня и остекление те же, что у машин: башня и танк рядом обязаны быть
 * из одного вещества, иначе поле распадается на два мира. Бетон тот же,
 * что у командного центра, и по той же причине — бетон на карте один.
 *
 * Отдельного тёмного оттенка под тень здесь нет: у постройки нет ни
 * колёс, ни решёток, ни выхлопа, а место второго тёмного материала
 * занял бетон.
 */
const readStructureColors = (): StructureSpriteColors => ({
  plate: token('--td-hull-plate', 0x3d4245),
  steel: token('--td-hull-metal', 0x585e62),
  concrete: token('--td-concrete', 0x6b6f72),
  glass: token('--td-hull-glass', 0x232e36),
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  sky: token('--td-rock-sky', 0x5c7ea8),
  ground: token('--td-bg-page', 0x191919),
});

const readEntityColors = (): EntityColors => ({
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  // Цвет поверхности — тот же, которым залит фон сцены. Земля рисуется
  // линиями и заливок не имеет, поэтому под отражением всегда именно он.
  ground: token('--td-bg-page', 0x191919),
  health: token('--td-health-full', 0x00ff29),
  healthLow: token('--td-health-low', 0xff5c5c),
  beacon: token('--td-beacon', 0xff3b30),
  // Погон. Цвета одни на обе стороны: на нём цвет занят переходом
  // «сталь → золото», а не принадлежностью.
  rank: {
    field: token('--td-rank-field', 0x14171a),
    stripe: token('--td-rank-stripe', 0xcfd6da),
    gold: token('--td-rank-gold', 0xffc83d),
  },
});

/**
 * Цвета выстрела.
 *
 * Огонь, дым и белое ядро берутся из тех же токенов, что у взрыва,
 * и это требование, а не экономия: пламя на дульном срезе и пламя
 * горящей машины — один и тот же огонь, и разойдись они хоть на оттенок,
 * поле распалось бы на два разных мира.
 */
const readShotColors = (): ShotColors => ({
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  hullDark: token('--td-hull-dark', 0x23271f),
  shot: token('--td-projectile', 0xeaffef),
  shotLethal: token('--td-health-low', 0xff5c5c),
  arc: token('--td-arc', 0x5aa6ff),
  core: token('--td-blast-core', 0xfff6e0),
  fire: token('--td-blast-fire', 0xff8a2b),
  smoke: token('--td-blast-smoke', 0x2b2622),
});

const readBlastColors = (): BlastColors => ({
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  hullDark: token('--td-hull-dark', 0x23271f),
  core: token('--td-blast-core', 0xfff6e0),
  fire: token('--td-blast-fire', 0xff8a2b),
  smoke: token('--td-blast-smoke', 0x2b2622),
});

const readOverlayColors = (): OverlayColors => ({
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  valid: token('--td-build-valid', 0x00ff29),
  invalid: token('--td-build-invalid', 0xff5c5c),
  danger: token('--td-strike', 0xff5c5c),
});

const readMinimapColors = (): MinimapColors => ({
  background: token('--td-bg-panel', 0x141414),
  border: token('--td-border-control', 0x4d4d4d),
  rock: token('--td-rock', 0x6e6a63),
  self: token('--td-accent', 0x00ff29),
  enemy: token('--td-player-enemy', 0xd264ff),
  viewport: token('--td-text-secondary', 0xc4c4c4),
});

/**
 * Как часто перерисовывается миникарта, в кадрах.
 *
 * Раз в шесть кадров — это десять обновлений в секунду. От шестидесяти
 * человек их не отличит, а рисовать там приходится сотни точек.
 */
const MINIMAP_EVERY_FRAMES = 6;

export const createScene = async (host: HTMLElement): Promise<Scene> => {
  const app = new Application();

  await app.init({
    background: token('--td-bg-page', 0x191919),
    antialias: true,
    // Учитываем плотность пикселей монитора, иначе на ретине картинка мылит.
    resolution: window.devicePixelRatio,
    autoDensity: true,
    resizeTo: host,
  });

  host.appendChild(app.canvas);

  // Мировой контейнер несёт камеру, внешний — только тряску. Разделение
  // не косметическое: положение мирового контейнера читает наведение,
  // и подмешивать в него дрожание нельзя. Подробности у `applyShake`.
  const shakeContainer = new Container();
  const worldContainer = new Container();
  shakeContainer.addChild(worldContainer);

  const groundGraphics = new Graphics();
  worldContainer.addChild(groundGraphics);

  // Слоёв получается около четырёхсот. Это дёшево: пустой Graphics ничего
  // не рисует, а обход четырёхсот детей на кадр не измеряется. Заливок
  // при этом не прибавляется ни одной — они просто разъехались по разным
  // объектам.
  const terrainBands: Container[] = [];
  const entityBands: Graphics[] = [];
  const machineBands: Container[] = [];

  for (let band = 0; band <= TERRAIN_DIAGONAL_COUNT; band += 1) {
    const entities = new Graphics();
    entityBands.push(entities);
    worldContainer.addChild(entities);

    // Машины идут сразу за постройками своей полосы. Спрайт в Graphics
    // не положишь, поэтому у них свой контейнер; порядок при этом верен
    // сам собой: глубина постройки — центр её клетки, то есть целое
    // число, а глубина юнита той же полосы лежит в [k, k+1).
    const machines = new Container();
    machineBands.push(machines);
    worldContainer.addChild(machines);

    if (band < TERRAIN_DIAGONAL_COUNT) {
      // Территория — контейнер, а не Graphics: и скалы, и командный центр
      // теперь запечённые спрайты, а спрайт в Graphics не положишь.
      // Диагональ при этом осталась единицей слоя, поэтому порядок
      // перекрытия не меняется.
      const terrain = new Container();
      terrainBands.push(terrain);
      worldContainer.addChild(terrain);
    }
  }

  // Порядок слоёв эффектов снизу вверх:
  //
  //   дым и обломки взрывов
  //   дым выстрелов и корпуса ракет
  //   свет выстрелов          (сложение)
  //   свет взрывов            (сложение)
  //
  // Дым — это тело: его можно заслонить, и вспышка, случившаяся перед
  // ним, должна быть видна. Свет заслонить нельзя ничем, поэтому оба
  // светящихся слоя лежат выше всех дымов сразу, а не каждый над своим.
  //
  // Свет взрыва выше света выстрела намеренно: взрыв — событие более
  // крупное, и перекрывать его вспышками очередей незачем.
  // Цвета выстрела читаются раньше остальных: слою разрядов нужен цвет
  // молнии прямо при создании — плитки печются один раз и красятся тинтом.
  const shotColors = readShotColors();

  const blastDebrisGraphics = new Graphics();
  const shotTrailGraphics = new Graphics();
  const shotGlowGraphics = new Graphics();
  const blastGlowGraphics = new Graphics();

  // Сложение цвета вместо закрашивания: две пересёкшиеся искры ярче одной,
  // а вспышка высветляет то, что под ней. Задаётся слою целиком — ровно
  // поэтому светящееся и несветящееся здесь разложены по разным слоям.
  shotGlowGraphics.blendMode = 'add';
  blastGlowGraphics.blendMode = 'add';

  /**
   * Разряды Теслы: единственный выстрел, который рисуется спрайтами,
   * а не линиями. Ломаная в `Graphics` режется на треугольники заново
   * каждый кадр, и пятнадцать одновременных разрядов стоили половину
   * бюджета кадра; те же пятнадцать спрайтами — сотую его часть.
   *
   * Свой слой ему нужен по той же причине, по какой свет вообще отделён
   * от тел: режим смешивания в PixiJS задаётся слою целиком. Лежит он
   * между светом выстрелов и светом взрывов — разряд ярче очереди
   * штурмовика, но тише гибели.
   */
  const arcs: ArcSprites = createArcSprites(app.renderer, { arc: shotColors.arc });

  const flashGraphics = new Graphics();
  flashGraphics.blendMode = 'add';

  // Слой поверх тел лежит выше выстрелов: полосы прочности баз показывают
  // положение дел в матче, и перечёркивать их линиями выстрелов незачем.
  const overheadGraphics = new Graphics();
  const overlayGraphics = new Graphics();
  worldContainer.addChild(
    blastDebrisGraphics,
    shotTrailGraphics,
    shotGlowGraphics,
    arcs.layer,
    blastGlowGraphics,
    overheadGraphics,
    overlayGraphics,
  );

  /**
   * Слои сущностей, в которые что-то попало на прошлом кадре.
   *
   * Очищаются только они. Обходить все четыреста ради полудюжины занятых
   * значило бы платить за пустоту каждый кадр.
   */
  const usedBands: number[] = [];
  const bandUsed = new Uint8Array(entityBands.length);

  /**
   * Пул спрайтов.
   *
   * В нём живут и машины, и постройки: спрайт — это положение и ссылка
   * на текстуру, и разницы между ними на этом уровне нет никакой.
   *
   * Машин на экране до двух сотен, и каждая берёт по два спрайта — тело
   * и отражение; постройка берёт один, потому что она стоит, а не висит.
   * Создавать их заново каждый кадр значило бы двадцать тысяч объектов
   * в секунду на ровном месте.
   */
  const spritePool: Sprite[] = [];
  let spritesUsed = 0;

  const markBand = (index: number): void => {
    if (bandUsed[index] === 0) {
      bandUsed[index] = 1;
      usedBands.push(index);
    }
  };

  const layers: EntityLayers = {
    band(index) {
      markBand(index);
      // Полоса гарантированно существует: её номер уже прижат к диапазону
      // на стороне отрисовки сущностей.
      return entityBands[index] as Graphics;
    },
    sprite(index, baked, anchorX, anchorY) {
      markBand(index);

      let sprite = spritePool[spritesUsed];
      if (sprite === undefined) {
        sprite = new Sprite();
        spritePool.push(sprite);
      }
      spritesUsed += 1;

      sprite.texture = baked.texture;
      sprite.position.set(anchorX + baked.offsetX, anchorY + baked.offsetY);
      (machineBands[index] as Container).addChild(sprite);
    },
    overhead: overheadGraphics,
  };

  const shotLayers: ShotLayers = {
    arcs,
    trails: shotTrailGraphics,
    glow: shotGlowGraphics,
  };

  const blastLayers: BlastLayers = {
    debris: blastDebrisGraphics,
    glow: blastGlowGraphics,
    flash: flashGraphics,
  };

  const clearEntityLayers = (): void => {
    for (const band of usedBands) {
      entityBands[band]?.clear();
      // Спрайты снимаются, но не уничтожаются: они вернутся из пула
      // на следующем кадре.
      machineBands[band]?.removeChildren();
      bandUsed[band] = 0;
    }
    usedBands.length = 0;
    spritesUsed = 0;
    shotTrailGraphics.clear();
    shotGlowGraphics.clear();
    // Спрайты не чистятся, а переиспользуются: пул один на матч,
    // и кадр просто берёт из него столько, сколько нужно.
    arcs.begin();
    overheadGraphics.clear();
    blastDebrisGraphics.clear();
    blastGlowGraphics.clear();
    flashGraphics.clear();
  };

  // Миникарта живёт в экранных координатах, поэтому лежит не в мировом
  // контейнере, а прямо на сцене: сдвиг камеры её двигать не должен.
  const minimapContainer = new Container();
  const minimapTerrain = new Graphics();
  const minimapEntities = new Graphics();
  minimapContainer.addChild(minimapTerrain, minimapEntities);

  // Засветка экрана лежит вне мирового контейнера: она не привязана
  // к точке карты и ездить с камерой не должна. Миникарта — выше неё:
  // засветить единственный прибор ориентирования значило бы отнять
  // ориентирование ровно тогда, когда оно нужнее всего.
  // Джойстик — поверх всего, включая миникарту: палец физически лежит
  // на экране, и всё, что окажется над ним, будет выглядеть налипшим
  // на палец. Живёт он вне мирового контейнера: привязан к пальцу,
  // а не к клетке, и ездить с камерой не должен.
  const touchGraphics = new Graphics();

  app.stage.addChild(shakeContainer, flashGraphics, minimapContainer, touchGraphics);

  const terrainColors = readTerrainColors();
  const baseSelfColors = readBaseColors(token('--td-accent', 0x00ff29));
  const baseEnemyColors = readBaseColors(token('--td-player-enemy', 0xd264ff));
  const entityColors = readEntityColors();
  /**
   * Кеш запечённых машин.
   *
   * Разрешение берётся то же, с которым работает приложение: спрайт
   * рисуется один к одному, и на экране с плотными пикселями машина
   * обязана быть подробнее, а не крупнее.
   */
  const machines: MachineSprites = createMachineSprites(
    app.renderer,
    readMachineColors(),
    app.renderer.resolution,
  );

  /**
   * Кеш запечённых построек.
   *
   * Отдельный от машинного, хотя приём тот же: у постройки другой ключ
   * (облик вместо ступеней прокачки), другая палитра и другая фактура,
   * а общего осталось бы одно только слово «спрайт».
   */
  const structures: StructureSprites = createStructureSprites(
    app.renderer,
    readStructureColors(),
    app.renderer.resolution,
  );

  /**
   * Запекатель иконок интерфейса.
   *
   * Заводится здесь, потому что здесь живут и отрисовщик, и прочитанные
   * из CSS цвета сторон, — но НЕ работает, пока его не позовут. Зовут
   * из кадра и только после того, как допечён рельеф: старт матча уже
   * держит его запекание, и складывать одно с другим нельзя.
   */
  const iconBaker: IconBaker = createIconBaker(
    app.renderer,
    readMachineColors(),
    readStructureColors(),
  );

  const blastColors = readBlastColors();
  const overlayColors = readOverlayColors();
  const minimapColors = readMinimapColors();
  const touchColors: TouchStickColors = {
    self: token('--td-player-self', 0x00ff29),
    idle: token('--td-text-muted-3', 0x808080),
  };

  let camera: Camera = createCamera();

  /**
   * Приближение игрока — КРАТНОСТЬ дефолтного масштаба, а не сам масштаб.
   *
   * Дефолт зависит от высоты, оставшейся полю, и меняется при каждом
   * повороте телефона. Храни мы абсолютный масштаб — после поворота он
   * оказался бы либо ниже нового дефолта, либо выше четырёхкратного,
   * то есть за границей диапазона, и его пришлось бы молча подрезать.
   * Кратность переживает поворот сама: игрок остаётся в бою, а не
   * выбрасывается на общий план.
   */
  let zoom = 1;
  let scale = scaleOf(app.screen.height, zoom);

  let currentMap: GameMap | undefined;
  /**
   * Незаконченное запекание скал; `undefined` — работы нет.
   *
   * Карта и местный игрок лежат вместе с курсором намеренно: они нужны
   * каждому шагу, а порознь их легко рассогласовать — карту сменить,
   * а курсор забыть.
   */
  let baking:
    | {
        readonly map: GameMap;
        readonly localPlayer: PlayerId;
        /** Диагонали в порядке запекания, а не по возрастанию номера. */
        readonly order: readonly number[];
        at: number;
      }
    | undefined;
  let terrainRebuildCount = 0;
  let following = true;
  let layout: MinimapLayout = minimapLayout(
    app.screen.width,
    app.screen.height,
    sizeToken('--td-field-inset-right', 0),
  );
  let frame = 0;

  const clock = createFrameClock();

  /**
   * Сдвиг контейнера так, чтобы точка camera оказалась в центре экрана.
   * Это единственное, что происходит при движении камеры: три числа,
   * никакого перестроения геометрии.
   *
   * Масштаб ставится на МИРОВОЙ контейнер, а не на сцену целиком.
   * Разница существенная: миникарта, засветка и джойстик лежат на сцене
   * отдельно именно затем, чтобы жить в экранных координатах. Миникарта —
   * прибор, а не часть мира; джойстик привязан к пальцу. Отмасштабируй
   * мы сцену — уехали бы и они.
   *
   * Тряска остаётся СНАРУЖИ масштаба, во внешнем контейнере: её размах
   * задан в экранных точках, и на четырёхкратном приближении экран
   * трясло бы вчетверо сильнее.
   *
   * Округление положения — прежнее, а вот масштаб не округляется:
   * дефолт в ландшафте равен 0,611, и округли его — вернулись бы либо
   * к прежним шести клеткам, либо к нечитаемой мелочи.
   */
  const applyCamera = (): void => {
    camera = clampCamera(camera, app.screen.width, app.screen.height, scale);
    worldContainer.scale.set(scale);
    worldContainer.x = Math.round(app.screen.width / 2 - camera.x * scale);
    worldContainer.y = Math.round(app.screen.height / 2 - camera.y * scale);
  };

  /**
   * Пересчитать масштаб от нынешней высоты поля, сохранив приближение.
   *
   * Зовётся и при смене размера контейнера, и при жесте: и то и другое
   * меняет действующий масштаб, а высота поля — единственный его
   * источник.
   */
  const applyScale = (): void => {
    scale = scaleOf(app.screen.height, zoom);
    applyCamera();
  };

  /**
   * Тряска от взрыва.
   *
   * Смещается ВНЕШНИЙ контейнер, а не мировой, и это не мелочь. Клетка
   * под курсором считается из положения мирового контейнера (см.
   * `cellAtScreen`); подмешай мы тряску туда, во время взрыва прицел
   * уезжал бы на полклетки — а целится игрок как раз тогда, когда что-то
   * взрывается.
   *
   * Отдельный контейнер, а не запоминание «положения без тряски», выбран
   * намеренно: при запоминании правило держится на том, что каждый будущий
   * читатель положения не забудет взять запомненное. Здесь оно держится
   * на устройстве сцены и забыть о нём нельзя.
   */
  const applyShake = (amplitude: number, time: number): void => {
    const offset = shakeOffset(amplitude, time);
    shakeContainer.x = offset.x;
    shakeContainer.y = offset.y;
  };

  const relayoutMinimap = (): void => {
    // Отступ справа читается из токена при каждой перекладке, а не один
    // раз при создании сцены: на телефоне он ненулевой, на мониторе ноль,
    // и меняется он поворотом экрана — то есть ровно тогда, когда
    // миникарта и перекладывается.
    layout = minimapLayout(
      app.screen.width,
      app.screen.height,
      sizeToken('--td-field-inset-right', 0),
    );
    if (currentMap !== undefined) {
      drawMinimapTerrain(minimapTerrain, currentMap, layout, minimapColors);
    }
  };

  /**
   * Видимая область в координатах мира.
   *
   * Половина окна делится на масштаб: при уменьшенной картинке то же
   * окно охватывает больше мира. Забудь это деление — отсечение
   * выбросило бы из кадра ровно то, ради чего игрок отдалялся, и он
   * увидел бы пустоту там, где стоят юниты.
   */
  const viewBounds = (): ViewBounds => ({
    minX: camera.x - app.screen.width / 2 / scale,
    maxX: camera.x + app.screen.width / 2 / scale,
    minY: camera.y - app.screen.height / 2 / scale,
    maxY: camera.y + app.screen.height / 2 / scale,
  });

  /** Четыре угла экрана в координатах клеток. Нужны рамке на миникарте. */
  const viewCorners = (): readonly CellPoint[] => {
    const bounds = viewBounds();
    return [
      screenToWorld(bounds.minX, bounds.minY),
      screenToWorld(bounds.maxX, bounds.minY),
      screenToWorld(bounds.maxX, bounds.maxY),
      screenToWorld(bounds.minX, bounds.maxY),
    ];
  };

  applyCamera();
  relayoutMinimap();

  return {
    setMap(map, localPlayer) {
      // Перестраиваем только если карта действительно другая. Вызов на
      // каждом кадре с той же картой — обычное дело для игрового цикла,
      // и он не должен стоить ничего.
      if (currentMap === map) return;

      currentMap = map;
      terrainRebuildCount += 1;

      // Дешёвое делается сразу: земля — одна заливка, миникарта — обход
      // клеток без запекания. Игрок видит поле и свою карту немедленно.
      drawGround(groundGraphics, terrainColors);
      drawMinimapTerrain(minimapTerrain, map, layout, minimapColors);

      // Скалы — нет. Их запекание стоит около полутора секунд, и одним
      // куском оно перекрыло бы начало матча целиком: пока главный поток
      // занят, браузер не разбирает кадры, пришедшие по сокету, и первый
      // подтверждённый тик доезжает до игрока не раньше конца запекания.
      //
      // Замерено на боевой сборке: 2,8 с от «играть» до первого
      // подтверждённого тика, из них около 1,3 с — вот эта самая работа.
      // На сборке для разработки и на занятой машине выходило до шести
      // секунд, и всё это время игрок смотрел на неподвижный мир.
      //
      // Слои чистятся здесь, все разом: иначе на смене карты под новыми
      // скалами остались бы старые.
      for (const layer of terrainBands) clearRockLayer(layer);

      baking = {
        map,
        localPlayer,
        order: bakeOrderOf(map, localPlayer, terrainBands.length),
        at: 0,
      };
    },

    bakeTerrain(budgetMs) {
      const job = baking;
      if (job === undefined) return false;

      const started = performance.now();

      // Бюджет проверяется МЕЖДУ диагоналями, а не внутри. Диагональ —
      // это слой перекрытия целиком, и брошенная на середине оставила бы
      // соседние клетки одной гряды в разных кадрах, то есть видимый шов.
      // Одна диагональ печётся всегда, даже при нулевом бюджете: иначе
      // на медленной машине работа не сдвинулась бы вовсе.
      do {
        const diagonal = job.order[job.at] ?? 0;
        const layer = terrainBands[diagonal];
        if (layer !== undefined) {
          mountRockDiagonal(layer, app.renderer, job.map, diagonal, {
            rock: terrainColors.rock,
            sky: terrainColors.rockSky,
          });

          // База ставится ПОСЛЕ скал своей диагонали: `mountRockDiagonal`
          // чистит слой целиком, и база, положенная раньше, была бы
          // уничтожена вместе со скалами. Порядок внутри диагонали
          // безразличен — вокруг базы расчищена площадка, и скал на её
          // диагонали рядом нет.
          //
          // Цвет берётся по ВЛАДЕЛЬЦУ, а не по номеру базы в списке. База
          // с индексом `i` принадлежит игроку `i` (см. `createWorld`), и
          // прежний код красил нулевую в свой цвет всегда — то есть
          // у второго игрока свою базу показывал чужим цветом, а чужую
          // своим. На поле, где цвет означает принадлежность, это худшая
          // из возможных ошибок.
          job.map.baseCells.forEach((cell, index) => {
            const x = cellX(cell);
            const y = cellY(cell);
            if (x + y !== diagonal) return;

            placeBase(
              layer,
              app.renderer,
              x,
              y,
              index === job.localPlayer ? baseSelfColors : baseEnemyColors,
            );
          });
        }

        job.at += 1;
      } while (job.at < job.order.length && performance.now() - started < budgetMs);

      if (job.at < job.order.length) return true;

      baking = undefined;
      return false;
    },

    bakeIcons: () => iconBaker.step(),

    render(world, localPlayer, intent) {
      clearEntityLayers();

      // Дробный номер тика: мир идёт тридцать раз в секунду, кадров вдвое
      // больше, и эффект, посчитанный от целого номера, дёргался бы через
      // кадр. Снимается один раз на кадр — он же и отмечает смену тика.
      const time = clock.sample(world.tick, performance.now());
      const bounds = viewBounds();

      drawEntities(layers, world, bounds, entityColors, localPlayer, machines, structures);

      // Выстрелы поверх всех тел: выстрел — это событие, и прятать его
      // за телами не нужно, иначе бой в толпе перестаёт читаться.
      drawShots(shotLayers, world, time, bounds, shotColors, localPlayer);
      // Спрайты, не занятые в этом кадре, прячутся: пул один на матч,
      // и в нём остаются разряды прошлых, более людных кадров.
      arcs.end();

      // Размах тряски приходит оттуда же, откуда взрывы: слоями владеет
      // сцена, а решает, насколько тряхнуть, тот, кто знает про взрывы.
      const shake = drawBlasts(
        blastLayers,
        world,
        time,
        bounds,
        { width: app.screen.width, height: app.screen.height },
        blastColors,
        localPlayer,
      );
      applyShake(shake, time);

      drawOverlays(overlayGraphics, world, localPlayer, intent, overlayColors);

      // Каждый кадр, а не раз в шесть, как миникарта: джойстик лежит
      // под пальцем, и запаздывание в шесть кадров игрок читает как
      // «экран меня не слышит» — то есть ровно как поломку.
      drawTouchStick(touchGraphics, intent.touch, touchColors);

      frame += 1;
      if (frame % MINIMAP_EVERY_FRAMES === 0) {
        drawMinimapEntities(
          minimapEntities,
          world,
          localPlayer,
          viewCorners(),
          layout,
          minimapColors,
        );
      }
    },

    panBy(dx, dy) {
      following = false;
      // Сдвиг приходит в точках ЭКРАНА — столько прошёл курсор. Камера
      // живёт в координатах мира, поэтому делится на масштаб: иначе при
      // уменьшенной картинке карта тащилась бы за курсором медленнее,
      // чем сам курсор, и «прилипание» карты к руке пропало бы.
      camera = moveCamera(camera, dx / scale, dy / scale);
      applyCamera();
    },

    zoomBy(factor, anchorX, anchorY) {
      const next = clampZoom(zoom * factor);
      if (next === zoom) return;

      const before = scale;
      zoom = next;
      scale = scaleOf(app.screen.height, zoom);

      // Камера переезжает ДО применения: иначе точка под пальцем успела бы
      // уехать на кадр, и жест выглядел бы дёрганым.
      camera = zoomAt(camera, before, scale, {
        x: anchorX,
        y: anchorY,
        width: app.screen.width,
        height: app.screen.height,
      });

      // Приближение — это выбор игрока смотреть сюда, а не за генералом.
      // Оставь мы слежение — камера уехала бы обратно к генералу первым
      // же кадром, и жест выглядел бы сорвавшимся.
      following = false;
      applyCamera();
    },

    get zoom() {
      return zoom;
    },

    get scale() {
      return scale;
    },

    centreOnCell(cell) {
      following = false;
      const point = worldToScreen(
        (cell % MAP_WIDTH_CELLS) + 0.5,
        Math.floor(cell / MAP_WIDTH_CELLS) + 0.5,
      );
      camera = { x: point.x, y: point.y };
      applyCamera();
    },

    follow(point) {
      if (!following || point === undefined) return;

      const screen = worldToScreen(point.x, point.y);
      camera = { x: screen.x, y: screen.y };
      applyCamera();
    },

    setFollowing(enabled) {
      following = enabled;
    },

    get following() {
      return following;
    },

    cellAtScreen(screenX, screenY) {
      // Читается положение мирового контейнера, а не внешнего: тряска
      // живёт во внешнем и на наведение влиять не должна.
      //
      // Деление на масштаб обязательно: экранная точка переводится
      // в мир через масштаб, и без деления промах рос бы вместе
      // с приближением — игрок ставил бы постройку не туда, куда целился.
      const point = screenToWorld(
        (screenX - worldContainer.x) / scale,
        (screenY - worldContainer.y) / scale,
      );
      const x = Math.floor(point.x);
      const y = Math.floor(point.y);

      if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return -1;

      return cellIndex(x, y);
    },

    minimapCellAtScreen(screenX, screenY) {
      return minimapCellAt(screenX, screenY, layout);
    },

    resize() {
      // Сначала пересчитывается сам рендерер, и только потом всё, что
      // от его размеров зависит.
      //
      // Порядок важен. PixiJS с `resizeTo` подписан на событие resize
      // ОКНА, а размер контейнера меняется и без него: полосы интерфейса
      // задают его отступами, и смена высоты тулбара окна не трогает.
      // Без этой строки `app.screen` остался бы прежним, и камера
      // с миникартой улеглись бы по размерам, которых уже нет.
      app.resize();

      // Масштаб пересчитывается от НОВОЙ высоты поля, а приближение
      // остаётся прежней кратностью. Поворот телефона тогда не сбрасывает
      // игрока на общий план: он видит то же, только шире или уже.
      applyScale();
      relayoutMinimap();
    },

    destroy() {
      // Текстуры живут в видеопамяти, и сборщик мусора о ней не знает:
      // без уборки утечка копилась бы матч за матчем. И разряды,
      // и машины — до самого приложения.
      arcs.destroy();
      machines.dispose();
      structures.dispose();
      app.destroy(true, { children: true });
    },

    get terrainRebuildCount() {
      return terrainRebuildCount;
    },

    get viewportSize() {
      return { width: app.screen.width, height: app.screen.height };
    },

    get viewCentre() {
      return screenToWorld(camera.x, camera.y);
    },
  };
};
