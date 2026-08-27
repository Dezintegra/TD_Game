import {
  FIXED_POINT_SCALE,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  SEPARATION_DAMPING_PERCENT,
  SEPARATION_PUSH_SPEED_PERCENT,
  SEPARATION_WALL_CLEARANCE,
  UNIT_SEPARATION_RADIUS,
  onRuleTuningApplied,
} from '@td/shared';
import { cellIndex } from './map.js';
import { statsOf } from './stats.js';
import type { PlayerStats } from './stats.js';
import type { Working, WorkingUnit } from './working.js';

/**
 * Расталкивание: машины перестают стоять одна в другой.
 *
 * Зачем. Поле потока ведёт всех в один и тот же центр клетки, а движение
 * доводит ровно до цели, поэтому одинаково идущие машины сходятся в точку
 * и больше никогда не расходятся. Замер: у двухсот машин, обложивших базу,
 * координаты совпадали до единицы — на поле видна одна машина вместо
 * войска, и численность противника прочесть нельзя.
 *
 * Расталкивание МЯГКОЕ. Оно смещает машину, но никогда не запрещает ей
 * шаг: жёсткий запрет на сближение запер бы войско в проходе шириной
 * в клетку и в диагональной щели между скалами, которую поле потока
 * считает проходимой, — и машина осталась бы там до конца матча.
 *
 * Про арифметику — то же, что и в `movement.ts`: `Math.sqrt` и деление
 * здесь встречаются, но только в промежуточных вычислениях. Стандарт
 * IEEE 754 требует для них корректного округления, поэтому на любой
 * платформе они дают бит в бит одинаковый результат, а в состоянии мира
 * остаются целые числа.
 */

let MAP_MAX_X = MAP_WIDTH_CELLS * FIXED_POINT_SCALE - 1;
let MAP_MAX_Y = MAP_HEIGHT_CELLS * FIXED_POINT_SCALE - 1;

/**
 * Центр карты во внутренних единицах.
 *
 * Нужен для разведения совпавших в точку — см. `apartDirection`. Совпадает
 * с центром поворота из `rotatedCell`: сумма координат клетки и её
 * повёрнутой пары равна ширине карты, значит центр — ровно половина.
 */
let CENTRE_X = (MAP_WIDTH_CELLS * FIXED_POINT_SCALE) / 2;
let CENTRE_Y = (MAP_HEIGHT_CELLS * FIXED_POINT_SCALE) / 2;

// Обе пары величин выведены из размера карты, а он подвижен до создания
// первого мира. Пересчёт заявлен настройке правил: иначе разведение
// совпавших машин тянуло бы их к центру ПРЕЖНЕЙ карты, то есть в сторону.
onRuleTuningApplied(() => {
  MAP_MAX_X = MAP_WIDTH_CELLS * FIXED_POINT_SCALE - 1;
  MAP_MAX_Y = MAP_HEIGHT_CELLS * FIXED_POINT_SCALE - 1;
  CENTRE_X = (MAP_WIDTH_CELLS * FIXED_POINT_SCALE) / 2;
  CENTRE_Y = (MAP_HEIGHT_CELLS * FIXED_POINT_SCALE) / 2;
});

const clamp = (value: number, max: number): number => (value < 0 ? 0 : value > max ? max : value);

/**
 * Округление, симметричное относительно нуля.
 *
 * `Math.round` симметричным не является: половину он всегда округляет
 * вверх, поэтому `Math.round(2.5)` даёт 3, а `Math.round(-2.5)` — минус
 * два. На повёрнутой карте это разводило бы зеркальные войска по-разному,
 * а симметрия карты — требование замысла, а не совпадение генератора.
 */
const roundSymmetric = (value: number): number =>
  value < 0 ? -Math.round(-value) : Math.round(value);

/**
 * Куда расходятся машины, оказавшиеся в одной точке.
 *
 * Расстояние ноль направления не даёт, а случай этот не редкий, а самый
 * частый: именно так стои́т слипшееся войско. Случайность здесь запрещена —
 * ядро детерминировано.
 *
 * Направление берётся вдоль луча от центра карты. Это единственный выбор,
 * который переживает симметрию: карта повёрнута на пол-оборота
 * (`rotatedCell`), а поворот на пол-оборота меняет знак у любого вектора —
 * ровно то же самое делает с этим лучом переход к зеркальной паре. Любое
 * направление, выведенное из номеров сущностей, симметрию бы сломало:
 * у машин противника номера другие.
 *
 * Кто из пары идёт наружу, а кто к центру, решает номер сущности —
 * и решает одинаково для обеих сторон, потому что войска нумеруются
 * в одном и том же порядке.
 */
const apartDirection = (x: number, y: number): { x: number; y: number } => {
  const dx = x - CENTRE_X;
  const dy = y - CENTRE_Y;
  const length = Math.sqrt(dx * dx + dy * dy);

  // Ровно в центре карты луча не существует. Случай вырожденный —
  // в игре центр карты это одна точка из двух миллиардов, — но молча
  // полагаться на это нельзя.
  if (length === 0) return { x: FIXED_POINT_SCALE, y: 0 };

  return {
    x: roundSymmetric((dx * FIXED_POINT_SCALE) / length),
    y: roundSymmetric((dy * FIXED_POINT_SCALE) / length),
  };
};

/**
 * Сетка соседей с ячейкой в одну клетку.
 *
 * Боевой индекс держит корзины по восемь клеток — размер выбран под
 * дальность снайперской башни. Здесь это слишком крупно: в одну корзину
 * попала бы вся толпа, и платить пришлось бы за всех. Личный радиус
 * меньше половины клетки, поэтому соседей достаточно искать в девяти
 * ячейках вокруг.
 *
 * Хранится связными списками, а не массивами массивов: за тик сетка
 * строится заново, и две типизированные полосы дешевле двух тысяч
 * маленьких массивов.
 */
interface Neighbours {
  readonly heads: Int32Array;
  readonly next: Int32Array;
}

const NO_UNIT = -1;

const cellOf = (x: number, y: number): number => {
  const cx = Math.min(MAP_WIDTH_CELLS - 1, Math.max(0, Math.floor(x / FIXED_POINT_SCALE)));
  const cy = Math.min(MAP_HEIGHT_CELLS - 1, Math.max(0, Math.floor(y / FIXED_POINT_SCALE)));
  return cellIndex(cx, cy);
};

const buildNeighbours = (working: Working): Neighbours => {
  const heads = new Int32Array(MAP_CELL_COUNT).fill(NO_UNIT);
  const next = new Int32Array(working.units.length).fill(NO_UNIT);

  working.units.forEach((unit, index) => {
    if (!unit.alive) return;

    const cell = cellOf(unit.x, unit.y);
    next[index] = heads[cell] ?? NO_UNIT;
    heads[cell] = index;
  });

  return { heads, next };
};

/**
 * Один проход расталкивания.
 *
 * Проход ДВУХФАЗНЫЙ: сначала считаются все смещения от положений на начало
 * прохода, и только потом применяются. Последовательный вариант — «A
 * подвинулся, B видит уже новое место» — тоже детерминирован, но
 * несимметричен: у пары есть первый и второй, и зеркальные войска
 * разъехались бы по-разному.
 *
 * Вызывается между движением и боем: бой обязан видеть окончательные
 * положения, иначе выстрел уходит туда, где машины уже нет.
 */
export const separateUnits = (working: Working, statsTable: readonly PlayerStats[]): void => {
  const count = working.units.length;
  if (count === 0) return;

  const neighbours = buildNeighbours(working);
  const pushX = new Int32Array(count);
  const pushY = new Int32Array(count);

  accumulate(working, neighbours, pushX, pushY);
  apply(working, statsTable, pushX, pushY);
};

/** Первая фаза: сколько и куда каждую машину толкает. */
const accumulate = (
  working: Working,
  neighbours: Neighbours,
  pushX: Int32Array,
  pushY: Int32Array,
): void => {
  const { heads, next } = neighbours;

  for (let index = 0; index < working.units.length; index += 1) {
    const unit = working.units[index];
    if (unit === undefined || !unit.alive) continue;

    const radius = UNIT_SEPARATION_RADIUS[unit.unitType];
    const cx = Math.min(MAP_WIDTH_CELLS - 1, Math.max(0, Math.floor(unit.x / FIXED_POINT_SCALE)));
    const cy = Math.min(MAP_HEIGHT_CELLS - 1, Math.max(0, Math.floor(unit.y / FIXED_POINT_SCALE)));

    for (let y = cy - 1; y <= cy + 1; y += 1) {
      if (y < 0 || y >= MAP_HEIGHT_CELLS) continue;

      for (let x = cx - 1; x <= cx + 1; x += 1) {
        if (x < 0 || x >= MAP_WIDTH_CELLS) continue;

        const cell = cellIndex(x, y);

        // Соседи. Каждая пара разбирается ровно один раз — отсюда
        // условие на номер, — и оба получают равное смещение
        // в противоположные стороны. Из этого и следует независимость
        // от порядка перебора: сумма целых слагаемых не зависит от того,
        // в каком порядке их складывать.
        for (
          let other = heads[cell] ?? NO_UNIT;
          other !== NO_UNIT;
          other = next[other] ?? NO_UNIT
        ) {
          if (other <= index) continue;

          const partner = working.units[other];
          if (partner === undefined || !partner.alive) continue;

          pairPush(unit, partner, radius, index, other, pushX, pushY);
        }

        // Стена. Отталкивает на клиренс больше личного радиуса: иначе
        // центр окажется снаружи, а корпус будет свешиваться за край.
        if (working.occupancy.blocked[cell] === 1) {
          wallPush(unit, x, y, index, pushX, pushY);
        }
      }
    }
  }
};

const pairPush = (
  unit: WorkingUnit,
  partner: WorkingUnit,
  radius: number,
  index: number,
  other: number,
  pushX: Int32Array,
  pushY: Int32Array,
): void => {
  const wanted = radius + UNIT_SEPARATION_RADIUS[partner.unitType];

  const dx = partner.x - unit.x;
  const dy = partner.y - unit.y;
  const squared = dx * dx + dy * dy;
  if (squared >= wanted * wanted) return;

  let stepX: number;
  let stepY: number;

  if (squared === 0) {
    // Совпали в точку. Каждый уходит на половину нужного расстояния:
    // младший по номеру — наружу от центра карты, старший — к центру.
    const away = apartDirection(unit.x, unit.y);
    const half = wanted / 2;
    const sign = unit.id < partner.id ? -1 : 1;

    stepX = roundSymmetric((away.x * half * sign) / FIXED_POINT_SCALE);
    stepY = roundSymmetric((away.y * half * sign) / FIXED_POINT_SCALE);
  } else {
    const distance = Math.sqrt(squared);
    const half = (wanted - distance) / 2;

    stepX = roundSymmetric((dx * half) / distance);
    stepY = roundSymmetric((dy * half) / distance);
  }

  pushX[index] = (pushX[index] ?? 0) - stepX;
  pushY[index] = (pushY[index] ?? 0) - stepY;
  pushX[other] = (pushX[other] ?? 0) + stepX;
  pushY[other] = (pushY[other] ?? 0) + stepY;
};

const wallPush = (
  unit: WorkingUnit,
  cellX: number,
  cellY: number,
  index: number,
  pushX: Int32Array,
  pushY: Int32Array,
): void => {
  // Ближайшая к машине точка квадрата клетки. Считать от центра клетки
  // нельзя: у прижавшейся к длинной стене машины ближе всего именно край,
  // и толчок от центра увёл бы её вдоль стены вместо того, чтобы отодвинуть.
  const left = cellX * FIXED_POINT_SCALE;
  const top = cellY * FIXED_POINT_SCALE;
  const nearestX = Math.min(Math.max(unit.x, left), left + FIXED_POINT_SCALE);
  const nearestY = Math.min(Math.max(unit.y, top), top + FIXED_POINT_SCALE);

  const dx = unit.x - nearestX;
  const dy = unit.y - nearestY;
  const squared = dx * dx + dy * dy;

  // Ноль означает, что центр машины уже внутри занятой клетки. Направления
  // это не даёт, а выталкивать наугад некуда: движение туда не пускает,
  // и попасть внутрь машина могла только до появления этого правила.
  if (squared === 0 || squared >= SEPARATION_WALL_CLEARANCE * SEPARATION_WALL_CLEARANCE) return;

  const distance = Math.sqrt(squared);
  const push = SEPARATION_WALL_CLEARANCE - distance;

  pushX[index] = (pushX[index] ?? 0) + roundSymmetric((dx * push) / distance);
  pushY[index] = (pushY[index] ?? 0) + roundSymmetric((dy * push) / distance);
};

/** Вторая фаза: затухание, потолок, проверка стены — и только потом сдвиг. */
const apply = (
  working: Working,
  statsTable: readonly PlayerStats[],
  pushX: Int32Array,
  pushY: Int32Array,
): void => {
  for (let index = 0; index < working.units.length; index += 1) {
    const unit = working.units[index];
    if (unit === undefined || !unit.alive) continue;

    let stepX = roundSymmetric(((pushX[index] ?? 0) * SEPARATION_DAMPING_PERCENT) / 100);
    let stepY = roundSymmetric(((pushY[index] ?? 0) * SEPARATION_DAMPING_PERCENT) / 100);
    if (stepX === 0 && stepY === 0) continue;

    // Потолок от СВОЕЙ скорости: Тесла втрое медленнее штурмовика,
    // и общая величина носила бы её по полю быстрее, чем она едет сама.
    const speed = statsOf(statsTable, unit.owner).units[unit.unitType].speed;
    const cap = Math.floor((speed * SEPARATION_PUSH_SPEED_PERCENT) / 100);
    const squared = stepX * stepX + stepY * stepY;

    if (cap <= 0) continue;
    if (squared > cap * cap) {
      const length = Math.sqrt(squared);
      stepX = roundSymmetric((stepX * cap) / length);
      stepY = roundSymmetric((stepY * cap) / length);
    }

    place(working, unit, stepX, stepY);
  }
};

/**
 * Сдвиг с проверкой занятости.
 *
 * Толчок не имеет права занести машину в скалу или в постройку. Если
 * полный шаг упирается, пробуем каждую ось по отдельности — так же, как
 * это делает генерал в `movement.ts`. Не вышло и это — машина остаётся
 * на месте: перекрытие с соседом переживаемо, а машина внутри стены нет.
 *
 * Разворот здесь не трогается намеренно. Толчок — это не движение:
 * машину сдвинули, а смотрит она по-прежнему туда, куда ехала.
 */
const place = (working: Working, unit: WorkingUnit, stepX: number, stepY: number): void => {
  const free = (x: number, y: number): boolean => working.occupancy.blocked[cellOf(x, y)] !== 1;

  const full = { x: clamp(unit.x + stepX, MAP_MAX_X), y: clamp(unit.y + stepY, MAP_MAX_Y) };
  if (free(full.x, full.y)) {
    unit.x = full.x;
    unit.y = full.y;
    return;
  }

  const alongX = { x: clamp(unit.x + stepX, MAP_MAX_X), y: unit.y };
  if (stepX !== 0 && free(alongX.x, alongX.y)) {
    unit.x = alongX.x;
    return;
  }

  const alongY = { x: unit.x, y: clamp(unit.y + stepY, MAP_MAX_Y) };
  if (stepY !== 0 && free(alongY.x, alongY.y)) {
    unit.y = alongY.y;
  }
};
