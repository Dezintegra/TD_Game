import { VETERAN_MAX_RANK } from '@td/shared';
import type { Graphics } from 'pixi.js';

/**
 * Погоны: знаки ветеранского ранга над башнями и машинами.
 *
 * Ранг растёт за убийства и упирается в пятый — это правило ядра,
 * здесь только его облик. Знаков пять, и они делятся на две группы:
 * ёлочки первых трёх рангов и звёзды двух последних. Граница между
 * группами показана и формой, и цветом сразу: сталь против золота.
 * Одной формы было бы мало — три ёлочки и звезда на четырнадцати
 * пикселях различаются хуже, чем кажется за монитором.
 *
 * Рисуется в кадре, а не запекается в текстуру, — в отличие от самих
 * машин. Запекание там решало другую задачу: модель машины это десятки
 * многоугольников со скосами брони, и её тесселяция ставила потолок
 * на число деталей.
 *
 * Замерено (вызовов к `Graphics` / вершин на один знак):
 *
 *     ранг 1   7 / 7      ранг 4   5 / 14
 *     ранг 2  11 / 10     ранг 5   5 / 14
 *     ранг 3  15 / 13     полоса здоровья  4 / 8
 *
 * То есть погон ДОРОЖЕ полосы здоровья — до четырёх раз по вызовам
 * и вдвое по вершинам. Здесь прежде стояло обратное утверждение,
 * и оно было выдумано, а не измерено.
 *
 * Запекание всё равно не нужно, но довод другой: погон висит
 * над ОТЛИЧИВШИМИСЯ, а полоса — над ПОВРЕЖДЁННЫМИ. Повреждённых
 * в осадном бою сотни, отличившихся — единицы, и полтора десятка
 * вызовов на десяток объектов теряются рядом с сотнями полос.
 * Перестанет теряться — тогда и запекать, шестью текстурами
 * по числу рангов.
 */

export interface RankColors {
  /** Подложка погона. */
  readonly field: number;
  /** Ёлочки первых трёх рангов. */
  readonly stripe: number;
  /** Звёзды двух последних. */
  readonly gold: number;
}

/**
 * Размер погона в экранных пикселях при `CELL_SCALE_PX = 63` —
 * чуть больше трети клетки по ширине.
 *
 * Числа выбраны по предпросмотру в натуральную величину, и первый заход
 * был вдвое мельче. На увеличении он смотрелся хорошо, а в кадре
 * превращался в крапинку: башня занимает на экране около сорока
 * пикселей, и знак в шестнадцать читался пылью на объективе. Мерка
 * здесь — полоса здоровья: её ширина 26 пикселей, и погон обязан быть
 * с ней сравним, иначе он не предмет, а помеха.
 *
 * Больше делать нельзя: погон начнёт спорить с самой башней. Высота
 * задана под самый крупный знак — закрашенную звезду высшего ранга:
 * упрись она в кромку, погон читался бы тесным, а не полным.
 */
export const RANK_FIELD_WIDTH_PX = 22;
export const RANK_FIELD_HEIGHT_PX = 18;

/** Скругление подложки. Погон, а не наклейка. */
const FIELD_RADIUS_PX = 3;

/**
 * Кромка подложки.
 *
 * Без неё погон на тёмной земле пропадает целиком — заливка совпадает
 * с цветом поля, — и знак повисает в пустоте сам по себе. Тусклая
 * кромка возвращает ему края, не превращая в яркое пятно.
 */
const FIELD_EDGE_PX = 1;
const FIELD_EDGE_ALPHA = 0.3;

/** Ёлочка: половина ширины, высота и толщина линии. */
const CHEVRON_HALF_WIDTH_PX = 6;
const CHEVRON_HEIGHT_PX = 3.4;
const CHEVRON_THICKNESS_PX = 1.8;

/** Шаг между ёлочками по вертикали. */
const CHEVRON_PITCH_PX = 4.6;

/**
 * Звезда: внешний радиус и доля внутреннего.
 *
 * 0,382 — канонические пропорции пятиконечной звезды (обратный квадрат
 * золотого сечения). При большем внутреннем радиусе лучи тупеют,
 * и звезда становится похожа на цветок.
 *
 * Радиусов ДВА, и разница между ними работает вместе с заливкой,
 * а не вместо неё. Контурная звезда мельче, закрашенная крупнее —
 * так высший ранг читается высшим с одного взгляда, даже когда
 * четвёртый и пятый стоят не рядом и сравнить их не с чем. Одной
 * заливки для этого мало: на сорока пикселях «контур против пятна»
 * различается хуже, чем «мельче против крупнее».
 */
const STAR_OUTLINE_OUTER_PX = 5.4;
const STAR_FILLED_OUTER_PX = 7.4;
const STAR_INNER_RATIO = 0.382;
const STAR_POINTS = 5;
const STAR_OUTLINE_PX = 1.7;

/** Ранг, с которого ёлочки сменяются звездой. */
const FIRST_STAR_RANK = 4;

/**
 * Вершины пятиконечной звезды вокруг точки.
 *
 * Первая вершина смотрит строго вверх (`-π/2`), дальше по кругу
 * чередуются внешние и внутренние — десять точек на пять лучей.
 */
export const starPoints = (
  centreX: number,
  centreY: number,
  outer: number = STAR_FILLED_OUTER_PX,
): number[] => {
  const points: number[] = [];
  const step = Math.PI / STAR_POINTS;

  for (let index = 0; index < STAR_POINTS * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : outer * STAR_INNER_RATIO;
    const angle = -Math.PI / 2 + index * step;

    points.push(centreX + radius * Math.cos(angle), centreY + radius * Math.sin(angle));
  }

  return points;
};

/** Сколько ёлочек несёт ранг. Ноль — значит, там звезда либо ничего. */
export const chevronCount = (rank: number): number =>
  rank >= 1 && rank < FIRST_STAR_RANK ? rank : 0;

/** Звезда закрашена только на высшем ранге — она и есть вершина. */
export const isStarFilled = (rank: number): boolean => rank >= VETERAN_MAX_RANK;

/** Есть ли на погоне звезда вообще. */
export const hasStar = (rank: number): boolean => rank >= FIRST_STAR_RANK;

/**
 * Нарисовать погон.
 *
 * `x` и `y` — ЦЕНТР погона в экранных координатах. Не левый верхний
 * угол: звезда строится от центра, и приводить её к углу пришлось бы
 * в каждом вызове.
 *
 * Нулевой ранг не рисуется вовсе. Пустой погон над каждой машиной был бы
 * чистым шумом — по той же причине, по которой не рисуется полная полоса
 * здоровья.
 */
export const drawRankInsignia = (
  graphics: Graphics,
  x: number,
  y: number,
  rank: number,
  colors: RankColors,
): void => {
  if (rank <= 0) return;

  graphics
    .roundRect(
      x - RANK_FIELD_WIDTH_PX / 2,
      y - RANK_FIELD_HEIGHT_PX / 2,
      RANK_FIELD_WIDTH_PX,
      RANK_FIELD_HEIGHT_PX,
      FIELD_RADIUS_PX,
    )
    .fill({ color: colors.field, alpha: 0.82 })
    .stroke({ width: FIELD_EDGE_PX, color: colors.stripe, alpha: FIELD_EDGE_ALPHA });

  if (hasStar(rank)) {
    if (isStarFilled(rank)) {
      graphics.poly(starPoints(x, y, STAR_FILLED_OUTER_PX)).fill({ color: colors.gold });
    } else {
      graphics
        .poly(starPoints(x, y, STAR_OUTLINE_OUTER_PX))
        .stroke({ width: STAR_OUTLINE_PX, color: colors.gold });
    }

    return;
  }

  // Ёлочки идут снизу вверх, как нашивки на настоящем погоне, и стоят
  // по центру подложки: одна посередине, три — заполняя её целиком.
  const count = chevronCount(rank);
  const top = y - ((count - 1) * CHEVRON_PITCH_PX) / 2;

  for (let index = 0; index < count; index += 1) {
    const centreY = top + index * CHEVRON_PITCH_PX;

    // Обводкой, а не заливкой: залитый треугольник в две с половиной
    // точки высотой сливается в пятно и перестаёт быть ёлочкой.
    graphics
      .moveTo(x - CHEVRON_HALF_WIDTH_PX, centreY + CHEVRON_HEIGHT_PX / 2)
      .lineTo(x, centreY - CHEVRON_HEIGHT_PX / 2)
      .lineTo(x + CHEVRON_HALF_WIDTH_PX, centreY + CHEVRON_HEIGHT_PX / 2)
      .stroke({ width: CHEVRON_THICKNESS_PX, color: colors.stripe });
  }
};
