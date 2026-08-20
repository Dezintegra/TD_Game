import { MAP_CELL_COUNT, StructureKind, Terrain } from '@td/shared';
import type { Vec2 } from '@td/shared';
import { cellAt, cellIndex, cellX, cellY } from './map.js';
import type { GameMap } from './map.js';

/**
 * Линия огня.
 *
 * Правило одно и читается с поля без объяснений: скала прячет всех,
 * стена прячет пеших. Башня стоит выше стены и стреляет поверх неё,
 * юнит и генерал — нет.
 *
 * Отсюда вторая роль стены. До этого стена только перекрывала проход,
 * и построить её означало купить противнику время на обход. Теперь стена
 * перед башней превращает башню в укрепление: она бьёт по подходящим,
 * а они ответить не могут, пока не снесут стену — под огнём той же башни.
 *
 * Скала не различает сторон намеренно. Её неразрушимость — свойство мира,
 * а не чья-то постройка, и давать ей игровую асимметрию не за что.
 */

/**
 * Две сетки непрозрачности на карту.
 *
 * Две, а не одна с флагами: проверка внутри обхода линии выполняется
 * на каждую пройденную клетку, и одно обращение по индексу дешевле,
 * чем обращение с последующим разбором битов. Памяти это стоит двух
 * килобайт на карту 48 × 48.
 */
export interface SightGrid {
  /** Непрозрачно для всех: скала. */
  readonly solid: Uint8Array;
  /** Непрозрачно для стреляющих с земли: скала или стена. */
  readonly ground: Uint8Array;
}

/** Постройка глазами линии огня. Нужны только вид и клетка. */
interface SightStructure {
  readonly kind: StructureKind;
  readonly cell: number;
  readonly alive?: boolean;
}

export const buildSightGrid = (map: GameMap, structures: readonly SightStructure[]): SightGrid => {
  const solid = new Uint8Array(MAP_CELL_COUNT);

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (map.cells[cell] !== Terrain.Ground) solid[cell] = 1;
  }

  // Пеший видит всё то же, что и башня, плюс упирается в стены.
  // Копия, а не пересчёт с нуля: скальные клетки уже разложены.
  const ground = solid.slice();

  for (const structure of structures) {
    if (structure.alive === false) continue;
    if (structure.kind !== StructureKind.Wall) continue;

    ground[structure.cell] = 1;
  }

  return { solid, ground };
};

/**
 * Обход клеток по линии между двумя точками.
 *
 * Алгоритм Брезенхэма на целых числах: ни деления, ни округления,
 * то есть один и тот же набор клеток на любой платформе. Тот же приём,
 * что и в прорубании коридора при генерации карты, и по той же причине.
 *
 * Диагональный шаг здесь разрешён, то есть линия может пройти между
 * двумя постройками, стоящими углом. Это осознанно: сквозь щель шириной
 * с ноль клеток стрелять нельзя, а вот увидеть просвет между двумя
 * стенами по диагонали — можно, и играется это понятнее, чем запрет.
 *
 * Клетки самого стрелка и всего основания цели пропускаются: стрелок
 * не загораживает себе, а цель — это то, во что стреляют, а не то,
 * что мешает.
 */
export const hasLineOfSight = (
  grid: SightGrid,
  /** Стрелок выше стен: башня или база. Юнит и генерал — нет. */
  elevated: boolean,
  from: Vec2,
  to: Vec2,
  /** Центр основания цели. Для юнита и генерала — его клетка. */
  targetCell: number,
  /** Радиус основания цели в клетках. Для юнита и генерала — ноль. */
  targetRadius: number,
): boolean => {
  const opaque = elevated ? grid.solid : grid.ground;

  const startCell = cellAt(from);
  const endCell = cellAt(to);
  if (startCell === endCell) return true;

  const targetMinX = cellX(targetCell) - targetRadius;
  const targetMaxX = cellX(targetCell) + targetRadius;
  const targetMinY = cellY(targetCell) - targetRadius;
  const targetMaxY = cellY(targetCell) + targetRadius;

  let x = cellX(startCell);
  let y = cellY(startCell);
  const endX = cellX(endCell);
  const endY = cellY(endCell);

  const stepX = Math.sign(endX - x);
  const stepY = Math.sign(endY - y);
  const deltaX = Math.abs(endX - x);
  const deltaY = -Math.abs(endY - y);

  let error = deltaX + deltaY;

  for (;;) {
    if (x === endX && y === endY) return true;

    const doubledError = 2 * error;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }

    // Основание цели прозрачно целиком, а не только её центральная клетка:
    // у базы основание три на три, и стрелять по её краю значило бы
    // упираться в её же угол.
    if (x >= targetMinX && x <= targetMaxX && y >= targetMinY && y <= targetMaxY) continue;

    if (opaque[cellIndex(x, y)] === 1) return false;
  }
};
