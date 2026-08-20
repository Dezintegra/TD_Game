import type { Graphics } from 'pixi.js';
import { FACE_LIGHT, blend, drawPrism, shade } from './prism.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';
import type { Point } from './iso.js';

/**
 * Командный центр — база игрока.
 *
 * Это главная цель матча, поэтому она обязана опознаваться с одного взгляда
 * и с любого расстояния. Отсюда состав: несколько разновысоких объёмов
 * вместо одной коробки, и антенна, которая выше любой скалы на карте.
 *
 * Про цвет отдельно. Первая версия заливала базу сплошным неоном стороны,
 * и это оказалось ошибкой: крупный объект в чистом #00FF29 светится ровным
 * пятном, в котором тонут и грани, и детали. Работает обратное — тёмный
 * корпус с небольшой примесью цвета стороны и яркая неоновая окантовка
 * по рёбрам. Тогда силуэт читается издали по свечению контура, а вблизи
 * видно устройство постройки.
 */
interface BasePart {
  readonly label: string;
  /** Смещение от центра базы в клетках. */
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

/** Высота антенны. База должна быть выше любой скалы — см. игровой дизайн. */
export const BASE_ANTENNA_HEIGHT = 3.2;

/**
 * Мачта антенны: смещение от центра базы и сторона основания.
 *
 * Вынесено в константы не для красоты: этими же числами считается точка
 * над гребнем базы, к которой цепляется полоса прочности. Продублируй мы
 * их там ещё раз — сдвиг мачты молча оставил бы полосу на старом месте.
 */
const MAST_OFFSET = -1.35;
const MAST_SIZE = 0.26;

/** Смещение оси мачты от центра базы: угол основания плюс его половина. */
const MAST_CENTRE = MAST_OFFSET + MAST_SIZE / 2;

/**
 * Части командного центра.
 *
 * Порядок в таблице значения не имеет: перед отрисовкой части сортируются
 * по удалённости от зрителя. Полагаться на ручной порядок было бы хрупко —
 * достаточно поправить одно смещение, и перекрытие сломается молча.
 */
const BASE_PARTS: readonly BasePart[] = [
  {
    label: 'мачта антенны',
    dx: MAST_OFFSET,
    dy: MAST_OFFSET,
    width: MAST_SIZE,
    depth: MAST_SIZE,
    height: BASE_ANTENNA_HEIGHT,
  },
  { label: 'пристройка север', dx: 0.2, dy: -1.5, width: 1, depth: 0.5, height: 0.75 },
  { label: 'главный корпус', dx: -1, dy: -1, width: 2, depth: 2, height: 1.15 },
  { label: 'пристройка запад', dx: -1.5, dy: 0.2, width: 0.5, depth: 1, height: 0.75 },
  // Площадка установки вынесена на восточный угол намеренно. В изометрии
  // «ближняя» сторона оказывается на экране ПОД постройкой, и любая высокая
  // деталь там уезжает прямо в корпус. Восточный угол смещён вбок, поэтому
  // направляющая поднимается рядом со зданием, а не сквозь него.
  { label: 'площадка установки', dx: 1.1, dy: -0.45, width: 0.9, depth: 0.9, height: 0.5 },
];

/** Площадь основания базы в клетках. */
export const BASE_FOOTPRINT_CELLS = 9;

export const BASE_PART_COUNT = BASE_PARTS.length;

/**
 * Корпус: тёмная основа с примесью цвета стороны.
 *
 * Доля примеси подобрана так, чтобы постройка читалась как объём, а не как
 * проволочный контур: слишком тёмный корпус пропадает на тёмной земле,
 * и остаётся одна окантовка.
 */
const HULL_TINT = 0.3;
const HULL_DARK = 0x23271f;

export const drawBase = (
  graphics: Graphics,
  centreX: number,
  centreY: number,
  accent: number,
): void => {
  const hull = blend(HULL_DARK, accent, HULL_TINT);

  // Сортировка по удалённости: сумма смещений тем больше, чем ближе часть
  // к зрителю, а значит тем позже её надо рисовать.
  const ordered = [...BASE_PARTS].sort((a, b) => a.dx + a.dy - (b.dx + b.dy));

  for (const part of ordered) {
    drawPrism(
      graphics,
      {
        x: centreX + part.dx,
        y: centreY + part.dy,
        width: part.width,
        depth: part.depth,
        height: part.height,
      },
      { hull, accent },
    );
  }

  drawAntennaDish(graphics, centreX + MAST_CENTRE, centreY + MAST_CENTRE, accent);
  drawRocketLauncher(graphics, centreX + 1.55, centreY, hull, accent);
};

/**
 * Тарелка на вершине мачты.
 *
 * Рисуется вытянутым ромбом: в изометрии круглая тарелка, наклонённая
 * к горизонту, выглядит именно так. Полноценная кривая здесь ничего
 * не добавит — на экране это объект в полсотни пикселей.
 */
const DISH_RADIUS_X = 34;
const DISH_RADIUS_Y = 17;

/** Штырь облучателя: вынос вбок, вынос вверх и радиус точки на конце. */
const FEED_SIDE_PX = 9;
const FEED_LIFT_PX = 14;
const FEED_TIP_RADIUS_PX = 3;

/** Насколько тарелка со штырём поднимается над вершиной мачты. */
const DISH_CREST_PX = DISH_RADIUS_Y + FEED_LIFT_PX + FEED_TIP_RADIUS_PX;

/** Просвет между гребнем и полосой прочности, в экранных пикселях. */
const CREST_CLEARANCE_PX = 12;

/**
 * Подъём гребня над центром базы, в экранных пикселях.
 *
 * Величина постоянная, и это следствие линейности проекции: расстояние
 * между центром базы и вершиной её мачты на экране одно и то же, где бы
 * база ни стояла. Поэтому оно считается один раз при загрузке модуля,
 * а не на каждом кадре.
 *
 * Слагаемые: мачта вынесена в северо-западный угол и потому уже стоит выше
 * центра на экране, дальше её собственная высота, тарелка со штырём
 * и просвет.
 */
export const BASE_CREST_LIFT_PX =
  -worldToScreen(MAST_CENTRE, MAST_CENTRE).y +
  BASE_ANTENNA_HEIGHT * ELEVATION_PX_PER_CELL +
  DISH_CREST_PX +
  CREST_CLEARANCE_PX;

/**
 * Точка над гребнем базы: сюда цепляется полоса прочности.
 *
 * Знание о том, где у базы верх, живёт здесь, а не в отрисовке сущностей,
 * которая эту полосу рисует. Причина простая: гребень задают части базы,
 * а из чего собрана база, знает только этот модуль. Иначе устройство
 * командного центра пришлось бы воспроизводить в двух местах.
 *
 * По горизонтали точка берётся от центра базы: полоса должна висеть
 * над серединой сооружения, а не над антенной, смещённой в угол.
 */
export const baseCrestPoint = (centreX: number, centreY: number): Point => {
  const centre = worldToScreen(centreX, centreY);

  return { x: centre.x, y: centre.y - BASE_CREST_LIFT_PX };
};

const drawAntennaDish = (graphics: Graphics, x: number, y: number, accent: number): void => {
  const centre = worldToScreen(x, y);
  const top = centre.y - BASE_ANTENNA_HEIGHT * ELEVATION_PX_PER_CELL;

  // Внешняя чаша.
  graphics
    .moveTo(centre.x - DISH_RADIUS_X, top)
    .lineTo(centre.x, top - DISH_RADIUS_Y)
    .lineTo(centre.x + DISH_RADIUS_X, top)
    .lineTo(centre.x, top + DISH_RADIUS_Y)
    .closePath();
  graphics.fill({ color: shade(accent, 0.32) });

  // Ближняя половина светлее: тарелка вогнутая и развёрнута к зрителю.
  graphics
    .moveTo(centre.x - DISH_RADIUS_X, top)
    .lineTo(centre.x + DISH_RADIUS_X, top)
    .lineTo(centre.x, top + DISH_RADIUS_Y)
    .closePath();
  graphics.fill({ color: shade(accent, 0.62) });

  graphics
    .moveTo(centre.x - DISH_RADIUS_X, top)
    .lineTo(centre.x, top - DISH_RADIUS_Y)
    .lineTo(centre.x + DISH_RADIUS_X, top)
    .lineTo(centre.x, top + DISH_RADIUS_Y)
    .closePath();
  graphics.stroke({ width: 2, color: accent, alpha: 0.95 });

  // Штырь облучателя с точкой на конце.
  const feedX = centre.x + FEED_SIDE_PX;
  const feedY = top - DISH_RADIUS_Y - FEED_LIFT_PX;

  graphics.moveTo(centre.x, top).lineTo(feedX, feedY).stroke({
    width: 2,
    color: accent,
    alpha: 0.9,
  });
  graphics.circle(feedX, feedY, FEED_TIP_RADIUS_PX).fill({ color: accent });
};

/**
 * Ракетная установка: наклонная направляющая с ракетой.
 *
 * Единственная часть базы, которая не является призмой — она наклонена,
 * а призма по определению вертикальна. Поэтому рисуется отдельным
 * примитивом: толстая тёмная направляющая, поверх неё неоновая ракета.
 */
const drawRocketLauncher = (
  graphics: Graphics,
  x: number,
  y: number,
  hull: number,
  accent: number,
): void => {
  const foot = worldToScreen(x, y);
  const startX = foot.x;
  const startY = foot.y - 0.5 * ELEVATION_PX_PER_CELL;
  // Направляющая почти вертикальна: так она читается как пусковая, а не как
  // случайная палка, и не задевает силуэт главного корпуса.
  const tipX = startX + 16;
  const tipY = startY - 82;

  // Направляющая: тёмный корпус с неоновой кромкой.
  graphics
    .moveTo(startX, startY)
    .lineTo(tipX, tipY)
    .stroke({
      width: 11,
      color: shade(hull, FACE_LIGHT.top),
    });
  graphics
    .moveTo(startX, startY)
    .lineTo(tipX, tipY)
    .stroke({ width: 11, color: accent, alpha: 0.35 });

  // Ракета на направляющей: короче направляющей и смещена к её концу,
  // чтобы читалось, что она лежит на ней, а не является её продолжением.
  const rocketFromX = startX + 16;
  const rocketFromY = startY - 26;
  graphics
    .moveTo(rocketFromX, rocketFromY)
    .lineTo(tipX + 6, tipY - 10)
    .stroke({ width: 6, color: accent, alpha: 0.95 });

  // Носовая точка.
  graphics.circle(tipX + 6, tipY - 10, 3.5).fill({ color: 0xffffff });
};
