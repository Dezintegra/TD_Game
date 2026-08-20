import type { Graphics } from 'pixi.js';
import { FACE_LIGHT, blend, drawPrism, shade } from './prism.js';
import { ELEVATION_PX_PER_CELL, worldToScreen } from './iso.js';

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

/**
 * Части командного центра.
 *
 * Порядок в таблице значения не имеет: перед отрисовкой части сортируются
 * по удалённости от зрителя. Полагаться на ручной порядок было бы хрупко —
 * достаточно поправить одно смещение, и перекрытие сломается молча.
 */
const BASE_PARTS: readonly BasePart[] = [
  { label: 'мачта антенны', dx: -1.35, dy: -1.35, width: 0.26, depth: 0.26, height: 3.2 },
  { label: 'пристройка север', dx: 0.2, dy: -1.5, width: 1, depth: 0.5, height: 0.75 },
  { label: 'главный корпус', dx: -1, dy: -1, width: 2, depth: 2, height: 1.15 },
  { label: 'пристройка запад', dx: -1.5, dy: 0.2, width: 0.5, depth: 1, height: 0.75 },
  // Площадка установки вынесена на восточный угол намеренно. В изометрии
  // «ближняя» сторона оказывается на экране ПОД постройкой, и любая высокая
  // деталь там уезжает прямо в корпус. Восточный угол смещён вбок, поэтому
  // направляющая поднимается рядом со зданием, а не сквозь него.
  { label: 'площадка установки', dx: 1.1, dy: -0.45, width: 0.9, depth: 0.9, height: 0.5 },
];

/** Высота антенны. База должна быть выше любой скалы — см. игровой дизайн. */
export const BASE_ANTENNA_HEIGHT = 3.2;

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

  drawAntennaDish(graphics, centreX - 1.35 + 0.13, centreY - 1.35 + 0.13, accent);
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
  graphics
    .moveTo(centre.x, top)
    .lineTo(centre.x + 9, top - DISH_RADIUS_Y - 14)
    .stroke({ width: 2, color: accent, alpha: 0.9 });
  graphics.circle(centre.x + 9, top - DISH_RADIUS_Y - 14, 3).fill({ color: accent });
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
