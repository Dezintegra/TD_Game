import type { Graphics } from 'pixi.js';
import {
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  StructureKind,
  Terrain,
  unitsToCells,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellIndex, cellX, cellY } from '@td/sim';
import type { GameMap, WorldState } from '@td/sim';
import { MAP_BOUNDS, screenToWorld, worldToScreen } from './iso.js';
import type { Point } from './iso.js';
import { traceGroundCircle } from './ground-circle.js';

/**
 * Миникарта.
 *
 * Тумана войны в игре нет, поэтому миникарта — не схема местности,
 * а инструмент управления вниманием: узкое место игрока не в знании,
 * а в том, что за раз видно около трети поля.
 *
 * Рисуется средствами PixiJS в экранных координатах, а не React. Иначе
 * пришлось бы возить позиции сотен сущностей через store, а store
 * по правилам проекта возит только то, что видно в HUD.
 *
 * Проекция здесь ТА ЖЕ, что у поля.
 *
 * Прежде миникарта показывала карту прямым видом сверху, и обосновывалось
 * это так: «квадрат отвечает на вопрос „где что“ точнее, чем ромб,
 * в котором расстояния по осям выглядят по-разному». Довод не выдержал
 * практики. Две картинки одного мира оказывались развёрнуты друг
 * относительно друга на угол проекции, и перенести замеченное с одной
 * на другую можно было только мысленным доворотом — то есть прибор
 * управления вниманием сам требовал внимания.
 *
 * Заметнее всего это было по рамке обзора: прямоугольная область экрана
 * в прямых координатах карты прямоугольником не остаётся, и рамка рисовалась
 * косым ромбом, регулярно вылезающим за край миникарты. С общей проекцией
 * она становится прямоугольником — сама, без единой строки про рамку.
 *
 * Одного поворота на 40 градусов для этого мало. Проекция — это поворот
 * И сжатие по наклону камеры; при повороте без сжатия направления всё равно
 * не совпадут, и отрезок под произвольным углом ляжет на поле и на миникарту
 * по-разному. Совпадение даёт только полная матрица.
 *
 * ОДНА ФИГУРА ЗДЕСЬ ВЫВЕДЕНА ИЗ-ПОД ПРАВИЛА ПОСТОЯННОГО ЭКРАННОГО РАЗМЕРА —
 * круг накрываемой площади ядерного удара.
 *
 * Правило это написано про отметки сущностей: точка, растянутая проекцией
 * в овал, читалась бы направлением, которого у неё нет. Отметка эпицентра —
 * такая же точка и правилу подчиняется: она отвечает на вопрос «куда именно»,
 * и размер ей для этого не нужен.
 *
 * Круг поражения отвечает на другой вопрос — «накроет ли моих», — и сам
 * и есть размер. Круг постоянного экранного размера соврал бы о накрываемой
 * площади, то есть ровно о том, ради чего нарисован; ровный круг на месте
 * эллипса соврал бы о ней же, потому что на поле удар тоже рисуется
 * в проекции. Поэтому он идёт в масштабе карты и той же проекцией, что
 * и всё остальное, — наклонным эллипсом.
 *
 * Два правила здесь не спорят, а делят между собой две разные вещи.
 */

export interface MinimapLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MinimapColors {
  readonly background: number;
  readonly border: number;
  readonly rock: number;
  readonly self: number;
  readonly enemy: number;
  readonly viewport: number;
  /**
   * Цвет угрозы: чужой ядерный удар.
   *
   * Тот же `--td-strike`, которым удар размечен на поле, а не фиолетовый
   * `enemy`. Фиолетовый на миникарте означает «чужой объект» — юнит,
   * постройка, генерал; чужая ракета не объект соперника, а угроза мне,
   * и красный уже несёт этот смысл на поле. Фиолетовое кольцо стоило бы
   * игроку такта на истолкование ровно там, где такта нет.
   */
  readonly strike: number;
}

const PADDING_PX = 16;

/**
 * Сколько отрезков берётся на круг ядерного удара.
 *
 * Вдвое с лишним меньше, чем на поле (там 56), и это не экономия наугад.
 * Круг базового радиуса — эллипс около 38 × 22 точек при миникарте
 * 254 × 146, то есть наибольший радиус на экране около 19 точек. Стрела
 * прогиба хорды при двадцати отрезках — `19 · (1 − cos 9°) ≈ 0,23` точки,
 * меньше четверти пикселя. Пятьдесят шесть отрезков дали бы то же
 * изображение втрое дороже.
 */
const NUKE_CIRCLE_STEPS = 20;

/** Радиус отметки эпицентра, в точках экрана. */
const NUKE_MARK_PX = 3;

/** Габариты спроецированной карты. Считаются один раз при загрузке модуля. */
const PROJECTED_WIDTH = MAP_BOUNDS.maxX - MAP_BOUNDS.minX;
const PROJECTED_HEIGHT = MAP_BOUNDS.maxY - MAP_BOUNDS.minY;

/**
 * Отношение сторон спроецированной карты.
 *
 * Выводится из `MAP_BOUNDS`, а не вписано числом: сменятся углы проекции —
 * отношение поедет само. При нынешних 40 и 35 градусах выходит около 1,743.
 */
export const MINIMAP_ASPECT = PROJECTED_WIDTH / PROJECTED_HEIGHT;

/**
 * Раскладка миникарты: высота от высоты поля, ширина из отношения сторон.
 *
 * Вписывать карту в квадрат больше нельзя: в проекции она параллелограмм,
 * и в квадрате заняла бы меньше трети площади, а остальное игрок принимал бы
 * за часть прибора.
 *
 * Стоит у ЛЕВОГО края, под своей сводкой. Прежде была у правого, и это
 * перестало работать разом с двух сторон: сверху справа теперь сводка
 * соперника со строкой связи, снизу справа — рейка заказа. Слева же
 * над ней только своя сводка, а под ней до самого низа пусто.
 *
 * `insetTop` — высота того, что лежит поверх поля сверху: сводка своей
 * стороны. Без этого отступа миникарта уезжает ей под низ, и прибор
 * ориентирования, наполовину закрытый панелью, перестаёт быть прибором.
 *
 * Число приходит снаружи, а не вычисляется здесь: высоту сводки знает
 * вёрстка, и второе её объявление в коде разошлось бы с первым молча.
 */
export const minimapLayout = (
  viewportWidth: number,
  viewportHeight: number,
  insetTop = 0,
): MinimapLayout => {
  const height = Math.round(Math.min(150, Math.max(96, viewportHeight * 0.17)));
  const width = Math.round(height * MINIMAP_ASPECT);

  return {
    x: PADDING_PX,
    y: PADDING_PX + insetTop,
    width,
    height,
  };
};

/** Во сколько раз спроецированная карта ужимается до размера миникарты. */
const scaleOf = (layout: MinimapLayout): number =>
  Math.min(layout.width / PROJECTED_WIDTH, layout.height / PROJECTED_HEIGHT);

/**
 * Клетка карты — в точку на экране.
 *
 * Та же `worldToScreen`, что рисует поле, ужатая под размер миникарты
 * и сдвинутая в её угол. Своего преобразования здесь нет намеренно:
 * второе, независимо написанное, разошлось бы с первым при первой же правке
 * углов — и перенос камеры уехал бы ровно на угол поворота, молча.
 */
export const projectToMinimap = (cellsX: number, cellsY: number, layout: MinimapLayout): Point => {
  const scale = scaleOf(layout);
  const point = worldToScreen(cellsX, cellsY);

  return {
    x: layout.x + (point.x - MAP_BOUNDS.minX) * scale,
    y: layout.y + (point.y - MAP_BOUNDS.minY) * scale,
  };
};

/** Четыре угла клетки, спроецированные на миникарту. */
const cellQuad = (
  cellsX: number,
  cellsY: number,
  size: number,
  layout: MinimapLayout,
): readonly Point[] => [
  projectToMinimap(cellsX, cellsY, layout),
  projectToMinimap(cellsX + size, cellsY, layout),
  projectToMinimap(cellsX + size, cellsY + size, layout),
  projectToMinimap(cellsX, cellsY + size, layout),
];

const tracePolygon = (graphics: Graphics, points: readonly Point[]): void => {
  const first = points[0];
  if (first === undefined) return;

  graphics.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point !== undefined) graphics.lineTo(point.x, point.y);
  }
  graphics.closePath();
};

/**
 * Отрисовка неподвижной части: подложки и скал.
 *
 * Вынесена отдельно, потому что перестраивается только при смене карты.
 * Две тысячи клеток каждый кадр не стоят ничего полезного.
 *
 * Подложка повторяет форму карты, а прямоугольника вокруг неё нет.
 * Это не украшение: нажатие сперва спрашивают у миникарты, и только
 * получив отказ, отдают полю. В углах описанного прямоугольника оказались
 * бы места, которые выглядят прибором, но клетке не соответствуют, —
 * и пришлось бы выбирать между «нажатие проваливается сквозь видимую
 * панель» и «камера едет не туда». Без подложки такого места не возникает.
 */
export const drawMinimapTerrain = (
  graphics: Graphics,
  map: GameMap,
  layout: MinimapLayout,
  colors: MinimapColors,
): void => {
  graphics.clear();

  tracePolygon(graphics, cellQuad(0, 0, MAP_WIDTH_CELLS, layout));
  graphics.fill({ color: colors.background, alpha: 0.75 });

  tracePolygon(graphics, cellQuad(0, 0, MAP_WIDTH_CELLS, layout));
  graphics.stroke({ width: 1, color: colors.border, alpha: 0.9 });

  // Клетка рисуется четырёхугольником, а не прямоугольником, но счёт
  // остаётся прежним: и то и другое тесселируется в два треугольника.
  for (let y = 0; y < MAP_HEIGHT_CELLS; y += 1) {
    for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
      if (map.cells[cellIndex(x, y)] === Terrain.Ground) continue;

      tracePolygon(graphics, cellQuad(x, y, 1, layout));
    }
  }

  graphics.fill({ color: colors.rock, alpha: 0.55 });
};

/**
 * Подлетающие ядерные удары: круг накрываемой площади и отметка эпицентра.
 *
 * Своего состояния у метки нет вовсе: она целиком выводится из `world.nukes`
 * того мира, который отрисовщику дали на этот кадр. Отсюда и её поведение
 * при откате предсказания — свой удар появляется на миникарте до
 * подтверждения сервером, и если сервер команду отклонит, переигрывание
 * тиков вернёт мир без этой ракеты, а метка исчезнет сама. Заведи мы рядом
 * собственный таймер или счётчик мигания — он бы откат пережил, и на
 * миникарте осталась бы метка удара, которого нет.
 *
 * Круг у края карты не обрезается. Маска стоила бы отдельного прохода
 * отрисовки для всех двух тысяч клеток рельефа, а пересечение с
 * четырёхугольником карты завело бы второе независимое правило геометрии
 * рядом с проекцией. Выступ до двадцати точек говорит правду: удар
 * действительно накрывает площадь, часть которой уходит за край карты.
 */
const drawNukes = (
  graphics: Graphics,
  world: WorldState,
  layout: MinimapLayout,
  colors: MinimapColors,
): void => {
  for (const nuke of world.nukes) {
    const centreX = cellX(nuke.cell) + 0.5;
    const centreY = cellY(nuke.cell) + 0.5;

    // Радиус берётся у самой ракеты, а не из балансной постоянной:
    // он прокачивается, и круг обязан показывать границу ИМЕННО ЭТОЙ
    // ракеты. Иначе игрок уводил бы войска по нарисованной границе,
    // а погибали бы они по настоящей.
    const radiusCells = unitsToCells(nuke.radius);

    traceGroundCircle(
      graphics,
      centreX,
      centreY,
      radiusCells,
      (cellsX, cellsY) => projectToMinimap(cellsX, cellsY, layout),
      NUKE_CIRCLE_STEPS,
    );
    graphics.stroke({ width: 1.5, color: colors.strike, alpha: 0.9 });

    // Эпицентр отдельной отметкой: круг накрываемой площади на миникарте
    // меньше сорока точек в поперечнике, и его геометрический центр
    // на глаз не определяется.
    const centre = projectToMinimap(centreX, centreY, layout);
    graphics.circle(centre.x, centre.y, NUKE_MARK_PX);
    graphics.fill({ color: colors.strike, alpha: 0.95 });
  }
};

/**
 * Отрисовка подвижной части: построек, юнитов, генералов, отметок ядерных
 * ударов и рамки обзора.
 *
 * Вызывается не каждый кадр, а несколько раз в секунду: миникарта нужна
 * для оценки обстановки, и десять обновлений в секунду человек не отличит
 * от шестидесяти, а рисовать приходится сотни точек.
 *
 * Отметки сущностей имеют постоянный ЭКРАННЫЙ размер: проецируется только
 * центр. Растянуть их проекцией значило бы дать точке направление,
 * которого у неё нет. Круг накрываемой площади ядерного удара — исключение,
 * и почему именно, сказано в шапке модуля.
 *
 * Удары рисуются ПОСЛЕ построек, юнитов и генералов, но ПЕРЕД рамкой
 * обзора. После сущностей — потому что кольцо, перечёркнутое десятком
 * точек, перестаёт быть кольцом. Перед рамкой — потому что рамка отвечает
 * на вопрос «а где я сейчас смотрю», и его игрок задаёт следующим, увидев
 * метку.
 */
export const drawMinimapEntities = (
  graphics: Graphics,
  world: WorldState,
  localPlayer: PlayerId,
  viewCorners: readonly { readonly x: number; readonly y: number }[],
  layout: MinimapLayout,
  colors: MinimapColors,
): void => {
  graphics.clear();

  const paint = (owner: PlayerId, plot: () => void): void => {
    plot();
    graphics.fill({ color: owner === localPlayer ? colors.self : colors.enemy, alpha: 0.9 });
  };

  for (const structure of world.structures) {
    const size = structure.kind === StructureKind.Base ? 7 : 3;
    // Центр клетки, а не её угол: отметка ставится по середине постройки.
    const centre = projectToMinimap(
      cellX(structure.cell) + 0.5,
      cellY(structure.cell) + 0.5,
      layout,
    );

    paint(structure.owner, () =>
      graphics.rect(centre.x - size / 2, centre.y - size / 2, size, size),
    );
  }

  for (const unit of world.units) {
    const centre = projectToMinimap(
      unitsToCells(unit.position.x),
      unitsToCells(unit.position.y),
      layout,
    );

    paint(unit.owner, () => graphics.rect(centre.x - 1, centre.y - 1, 2, 2));
  }

  for (const general of world.generals) {
    if (!general.alive) continue;

    const centre = projectToMinimap(
      unitsToCells(general.position.x),
      unitsToCells(general.position.y),
      layout,
    );

    paint(general.owner, () => graphics.circle(centre.x, centre.y, 4));
  }

  drawNukes(graphics, world, layout, colors);

  // Рамка обзора. Прямоугольником она становится сама: область экрана
  // прямоугольна, и та же проекция переводит её в прямоугольник. Прежний
  // косой ромб был не свойством области обзора, а следствием того, что
  // проекции у поля и миникарты были разные.
  if (viewCorners.length === 4) {
    tracePolygon(
      graphics,
      viewCorners.map((corner) => projectToMinimap(corner.x, corner.y, layout)),
    );
    graphics.stroke({ width: 1, color: colors.viewport, alpha: 0.8 });
  }
};

/**
 * Клетка карты под точкой экрана, либо -1, если точка вне миникарты.
 *
 * Нужна для перевода камеры кликом: раз миникарта показывает, что
 * происходит за краем экрана, по ней должно быть можно туда и перейти.
 *
 * Обращается ТА ЖЕ матрица, которой миникарта рисуется. Отдельного правила
 * перевода здесь нет намеренно: два независимых преобразования разойдутся
 * при первой же правке проекции, и камера начнёт ездить не туда — молча,
 * без единого признака поломки.
 */
export const minimapCellAt = (screenX: number, screenY: number, layout: MinimapLayout): number => {
  const scale = scaleOf(layout);

  const point = screenToWorld(
    (screenX - layout.x) / scale + MAP_BOUNDS.minX,
    (screenY - layout.y) / scale + MAP_BOUNDS.minY,
  );

  const x = Math.floor(point.x);
  const y = Math.floor(point.y);

  // Точка вне карты — это отказ, а не ближайшая клетка. Подтягивание
  // к ближайшей означало бы перенос камеры не туда, куда целились.
  if (x < 0 || y < 0 || x >= MAP_WIDTH_CELLS || y >= MAP_HEIGHT_CELLS) return -1;

  return cellIndex(x, y);
};
