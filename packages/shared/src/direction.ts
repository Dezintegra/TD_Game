/**
 * Восемь направлений движения.
 *
 * Направление передаётся индексом, а не вектором: команда должна быть
 * компактной, а вектор из двух чисел с фиксированной точкой — это восемь
 * байт вместо одного. Заодно исчезает целый класс проблем: клиент
 * физически не может прислать «направление» длиной в десять клеток.
 *
 * Ноль означает «стоять». Это не пустое значение и не ошибка: остановка —
 * такое же осмысленное состояние, как движение, и хранится в мире так же.
 */
export const DIRECTION_STOP = 0;
export const DIRECTION_COUNT = 9;

/**
 * Масштаб компонент вектора направления.
 *
 * Компоненты целые, поэтому единичный вектор записывается как тысяча.
 * Диагональ — 707, то есть корень из двух пополам, округлённый до целого.
 * Благодаря этому диагональное движение имеет ту же длину, что и прямое,
 * а не в полтора раза большую, как получилось бы при наивных (1, 1).
 */
export const DIRECTION_SCALE = 1000;

const DIAGONAL = 707;

export interface DirectionVector {
  readonly x: number;
  readonly y: number;
}

/**
 * Векторы направлений по индексу. Оси мировые: X растёт на восток,
 * Y — на юг. Порядок — по часовой стрелке от востока.
 */
export const DIRECTION_VECTORS: readonly DirectionVector[] = [
  { x: 0, y: 0 }, // 0 — стоять
  { x: DIRECTION_SCALE, y: 0 }, // 1 — восток
  { x: DIAGONAL, y: DIAGONAL }, // 2 — юго-восток
  { x: 0, y: DIRECTION_SCALE }, // 3 — юг
  { x: -DIAGONAL, y: DIAGONAL }, // 4 — юго-запад
  { x: -DIRECTION_SCALE, y: 0 }, // 5 — запад
  { x: -DIAGONAL, y: -DIAGONAL }, // 6 — северо-запад
  { x: 0, y: -DIRECTION_SCALE }, // 7 — север
  { x: DIAGONAL, y: -DIAGONAL }, // 8 — северо-восток
];

export const isValidDirection = (direction: number): boolean =>
  Number.isInteger(direction) && direction >= 0 && direction < DIRECTION_COUNT;

/**
 * Ближайшее из восьми направлений к произвольному вектору.
 *
 * Нужна тем, кто мыслит не индексами, а «туда»: противнику под управлением
 * компьютера, который знает, куда хочет идти генерал, и клиенту, который
 * переводит нажатые клавиши в направление мира.
 *
 * Считается через скалярное произведение — то есть без тригонометрии
 * и без деления, одними умножениями и сравнениями.
 */
export const directionTowards = (dx: number, dy: number): number => {
  if (dx === 0 && dy === 0) return DIRECTION_STOP;

  let best = DIRECTION_STOP;
  let bestScore = -Infinity;

  for (let index = 1; index < DIRECTION_COUNT; index += 1) {
    const vector = DIRECTION_VECTORS[index];
    if (vector === undefined) continue;

    const score = dx * vector.x + dy * vector.y;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }

  return best;
};
