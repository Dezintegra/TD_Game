import { hashOf } from './noise.js';

/**
 * Клубящаяся мгла за границами поля: раскладка и движение.
 *
 * Здесь только счёт — ни одного обращения к PixiJS. Разделение то же, что
 * у `relief.ts` и `relief-render.ts`, `arc-shape.ts` и `arc-render.ts`:
 * чистая геометрия отдельно, отрисовка отдельно. Отсюда и проверяемость —
 * раскладка проверяется числами, без живой видеокарты.
 *
 * **Слой экранный, а не мировой.** Пятна раскладываются в координатах
 * экрана и заворачиваются по модулю: уехавшее за край появляется
 * с противоположной стороны. Ради трёх следствий:
 *
 * - число пятен постоянно и не зависит ни от размера карты, ни
 *   от приближения. Мировой слой пришлось бы стелить по площади, видимой
 *   при наименьшем масштабе: при `MIN_SCALE = 0,4` половина окна — это
 *   2400 мировых точек по горизонтали, и пятен понадобилось бы кратно
 *   больше при том же покрытии экрана;
 * - зум мглу не масштабирует, и это верно по смыслу: мгла далёкая,
 *   а далёкое при том же угле обзора почти не меняется;
 * - покрытие гарантировано по построению — см. решётку ниже.
 *
 * **Внутри поля мглы не видно** не потому, что она туда не кладётся, а
 * потому, что слой лежит НИЖЕ мира, а поверхность поля залита сплошь.
 * Карта закрывает мглу собой; видна мгла ровно там, где карты нет.
 *
 * **Случайности нет.** `Math.random` здесь запрещён по той же причине,
 * что у обломков и молний: клиент переигрывает тики при откате
 * предсказания, один и тот же кадр может рисоваться дважды, и раскладка
 * обязана совпасть. Всё выводится чистой функцией от номера пятна
 * и времени.
 *
 * **Время — часы кадра, а не номер тика.** При догоне истории мир
 * проматывается пачками тиков, и мгла, привязанная к тику, скакала бы
 * рывками ровно там, где игрок ждёт спокойного фона.
 */

/**
 * Решётка пятен: четыре столбца на четыре ряда.
 *
 * Решётка, а не «набросать шестнадцать штук по хешу», — ради покрытия,
 * и держится оно на одном условии: пятно НИКОГДА не покидает своей ячейки
 * (см. `CLOUD_JITTER` и `CLOUD_WANDER`). Тогда любое окно размером
 * в четверть экрана — это два шага решётки по каждой стороне, а отрезок
 * длиной в два шага непременно содержит целую ячейку; пятно этой ячейки
 * лежит внутри неё, значит и внутри окна. Пустой четверти не бывает
 * ни в какое мгновение матча и ни при каком положении камеры.
 *
 * Свободный снос — «у каждого пятна своя скорость и своё направление» —
 * этого свойства НЕ даёт: за десять минут матча пятно уходит на тысячи
 * точек, решётка расползается, и покрытие превращается из построения
 * в везение. Поэтому движение здесь ограниченное: пятно блуждает вокруг
 * своего узла, а не улетает от него.
 *
 * Шестнадцать — и есть те «полтора десятка», в которые уложен бюджет
 * закраски: пятна крупные и полупрозрачные, и каждое стоит своей площади.
 */
const CLOUD_COLUMNS = 4;
const CLOUD_ROWS = 4;

/** Сколько пятен на экране. Число постоянно: решётка заполнена всегда. */
export const CLOUD_PUFF_LIMIT = CLOUD_COLUMNS * CLOUD_ROWS;

/**
 * Постоянный сдвиг узла внутри ячейки, в долях шага. Нужен, чтобы решётка
 * не читалась решёткой.
 */
const CLOUD_JITTER = 0.15;

/**
 * Размах блуждания вокруг узла, в долях шага.
 *
 * Сумма с `CLOUD_JITTER` — 0,4, то есть меньше половины шага: пятно
 * не дотягивается до края своей ячейки, и покрытие остаётся свойством
 * построения. Это единственное, чем ограничены оба числа; трогая их,
 * держите сумму ниже 0,5.
 */
const CLOUD_WANDER = 0.25;

/**
 * Периоды блуждания по каждой оси, в секундах.
 *
 * Свои у каждого пятна и свои у каждой оси — оттого путь выходит не кругом
 * и не отрезком, а незамкнутой петлёй, которая не повторяется за матч
 * ни разу. Медленно намеренно: при размахе в четверть ячейки и периоде
 * в полминуты выходит около двадцати точек в секунду — это воздух,
 * а не ветер.
 */
const CLOUD_WANDER_PERIOD_MIN = 26;
const CLOUD_WANDER_PERIOD_MAX = 47;

/**
 * Скорость вращения, радиан в секунду.
 *
 * Нижняя граница ненулевая: пятно, которое стоит, читается наклейкой.
 * Верхняя мала — заметное вращение круглого пятна выглядит вертолётом,
 * а не клубами.
 */
const CLOUD_SPIN_MIN = 0.004;
const CLOUD_SPIN_MAX = 0.02;

/**
 * Периоды «дыхания» — размера и прозрачности, в секундах.
 *
 * Взаимно не кратны намеренно: совпади они, все пятна дышали бы в такт,
 * а такт читается не движением воздуха, а ошибкой синхронизации. Тот же
 * довод, по которому разведены периоды покачивания машин.
 */
const CLOUD_SCALE_PERIOD = 17;
const CLOUD_ALPHA_PERIOD = 23;

/** Размер пятна: своя доля у каждого плюс дыхание вокруг неё. */
const CLOUD_SCALE_MIN = 0.7;
const CLOUD_SCALE_MAX = 1.3;
const CLOUD_SCALE_SWING = 0.18;

/** Прозрачность: мгла плотная, но не глухая — за ней виден фон страницы. */
const CLOUD_ALPHA_BASE = 0.5;
const CLOUD_ALPHA_SWING = 0.15;

/**
 * Доля смещения камеры, которую забирает мгла.
 *
 * Мгла едет за миром, но втрое медленнее: так она читается далёкой.
 * Двигается при этом не контейнер, а сами пятна внутри своего тора —
 * контейнер за долгую партию уехал бы сколь угодно далеко, и пятна
 * пришлось бы догонять.
 */
export const CLOUD_PARALLAX = 0.3;

/** Сколько разных пятен запекается. Меньше двух — соседи читаются копиями. */
export const CLOUD_VARIANTS = 3;

export interface CloudPuff {
  /** Центр пятна в координатах экрана. */
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scale: number;
  readonly alpha: number;
  /** Номер запечённого варианта, от нуля до `CLOUD_VARIANTS - 1`. */
  readonly variant: number;
}

export interface CloudViewport {
  readonly width: number;
  readonly height: number;
}

/** Смещение мира на экране: то самое, которое сцена ставит контейнеру. */
export interface CloudCamera {
  readonly x: number;
  readonly y: number;
}

/**
 * Шаг решётки в экранных точках.
 *
 * Отдан наружу, потому что от него считается и размер пятна: пятно обязано
 * с запасом перекрывать свою ячейку, иначе между клубами проступят швы.
 */
export const cloudCellSize = (viewport: CloudViewport): CloudViewport => ({
  width: viewport.width / CLOUD_COLUMNS,
  height: viewport.height / CLOUD_ROWS,
});

/** Доля [0, 1) из хеша номера пятна и приметы величины. */
const unit = (index: number, salt: number): number => hashOf([index, salt]) / 0x1_0000_0000;

/** Значение в [from, to) по той же доле. */
const between = (index: number, salt: number, from: number, to: number): number =>
  from + unit(index, salt) * (to - from);

/** Заворот в [0, span). Отрицательное тоже: -1 % 10 в JavaScript даёт -1. */
const wrap = (value: number, span: number): number => ((value % span) + span) % span;

/**
 * Где сейчас каждое пятно.
 *
 * Функция чистая: одни и те же доводы дают один и тот же ответ до числа.
 * Зовётся раз в кадр, считает шестнадцать раз по пять величин — счёта
 * здесь исчезающе мало, вся цена слоя лежит в закраске.
 */
export const cloudPuffs = (
  timeMs: number,
  camera: CloudCamera,
  viewport: CloudViewport,
): readonly CloudPuff[] => {
  // Окно нулевой высоты бывает у свёрнутой вкладки. Делить на ноль здесь
  // нечем и незачем: рисовать всё равно некуда.
  if (viewport.width <= 0 || viewport.height <= 0) return [];

  const { width: cellWidth, height: cellHeight } = cloudCellSize(viewport);
  const seconds = timeMs / 1000;

  const puffs: CloudPuff[] = [];

  for (let index = 0; index < CLOUD_PUFF_LIMIT; index += 1) {
    const column = index % CLOUD_COLUMNS;
    const row = Math.floor(index / CLOUD_COLUMNS);

    // Блуждание: своя петля у каждого пятна, но целиком внутри ячейки.
    const wanderX =
      Math.sin(
        (seconds / between(index, 1, CLOUD_WANDER_PERIOD_MIN, CLOUD_WANDER_PERIOD_MAX)) *
          Math.PI *
          2 +
          unit(index, 2) * Math.PI * 2,
      ) * CLOUD_WANDER;
    const wanderY =
      Math.sin(
        (seconds / between(index, 12, CLOUD_WANDER_PERIOD_MIN, CLOUD_WANDER_PERIOD_MAX)) *
          Math.PI *
          2 +
          unit(index, 13) * Math.PI * 2,
      ) * CLOUD_WANDER;

    const homeX = (column + 0.5 + (unit(index, 3) * 2 - 1) * CLOUD_JITTER + wanderX) * cellWidth;
    const homeY = (row + 0.5 + (unit(index, 4) * 2 - 1) * CLOUD_JITTER + wanderY) * cellHeight;

    const spin =
      between(index, 5, CLOUD_SPIN_MIN, CLOUD_SPIN_MAX) * (unit(index, 6) < 0.5 ? -1 : 1);

    const scalePhase = unit(index, 7) * Math.PI * 2;
    const alphaPhase = unit(index, 8) * Math.PI * 2;
    const scaleBase = between(index, 9, CLOUD_SCALE_MIN, CLOUD_SCALE_MAX);

    puffs.push({
      x: wrap(homeX + camera.x * CLOUD_PARALLAX, viewport.width),
      y: wrap(homeY + camera.y * CLOUD_PARALLAX, viewport.height),
      rotation: unit(index, 10) * Math.PI * 2 + spin * seconds,
      scale:
        scaleBase *
        (1 +
          CLOUD_SCALE_SWING * Math.sin((seconds / CLOUD_SCALE_PERIOD) * Math.PI * 2 + scalePhase)),
      alpha:
        CLOUD_ALPHA_BASE +
        CLOUD_ALPHA_SWING * Math.sin((seconds / CLOUD_ALPHA_PERIOD) * Math.PI * 2 + alphaPhase),
      variant: hashOf([index, 11]) % CLOUD_VARIANTS,
    });
  }

  return puffs;
};
