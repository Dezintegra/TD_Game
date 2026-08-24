import { MAP_HEIGHT_CELLS, MAP_WIDTH_CELLS, StructureKind } from '@td/shared';
import type { StructureState } from '@td/sim';
import { cellIndex, cellX, cellY } from '@td/sim';
import { WALL_LINK_STEPS } from './structures.js';

/**
 * Связи стен: кто с кем слился в одну линию.
 *
 * Прежде десять стен в ряд давали десять отдельных плит со столбами
 * по углам, и заграждения из них не получалось. При этом в правилах ряд
 * стен уже был сплошной преградой: стена — единственный вид построек,
 * перекрывающий линию огня с земли (`sight.ts`). Картинка противоречила
 * правилу, а игрок читает картинку.
 *
 * ## Что считается связью
 *
 * Клетка по стороне — не по углу, — в ней стена, владелец тот же,
 * и **обе постройки достроены**.
 *
 * Последнее условие делает отношение симметричным по построению.
 * Свяжись достроенная стена с недостроенной — достроенная нарисовала бы
 * плечо до границы клетки, а недострой ответил бы столбом: получился бы
 * мост в один пролёт, упирающийся в пустоту. Побочная выгода
 * обязательна и желательна: момент достройки стал виден — стена
 * не просто дорастает, она защёлкивается в линию.
 *
 * Диагональ связью не считается: между стенами, соприкоснувшимися
 * углами, юнит проходит, и перемычка соврала бы о проходимости.
 *
 * ## Почему это здесь, а не в симуляции
 *
 * Тумана войны нет, список построек у клиента полный, а величина нужна
 * одной отрисовке. В состоянии мира она означала бы новое поле
 * в контрольной сумме и сдвиг обоих эталонов детерминизма — ради картинки.
 */

/** Владельцы достроенных стен по клеткам. Ноль — стены нет. */
const owners = new Uint8Array(MAP_WIDTH_CELLS * MAP_HEIGHT_CELLS);

/**
 * Владелец записывается со сдвигом на единицу.
 *
 * Игрок с номером ноль иначе был бы неотличим от пустой клетки, и стены
 * первого игрока не связывались бы между собой вовсе — ошибка, которая
 * проявилась бы только у одной стороны и потому долго считалась бы
 * «мерцанием».
 */
const OWNER_OFFSET = 1;

const isBuilt = (structure: StructureState, tick: number): boolean => tick >= structure.builtAtTick;

/**
 * Маски связей всех достроенных стен, по индексу клетки.
 *
 * Считается двумя проходами, и порядок обязателен: за один проход
 * стена, идущая в списке раньше соседа, соседа ещё не увидела бы,
 * и половина связей вышла бы односторонней.
 */
export const wallLinks = (
  structures: readonly StructureState[],
  tick: number,
): ReadonlyMap<number, number> => {
  const masks = new Map<number, number>();

  let walls = 0;
  for (const structure of structures) {
    if (structure.kind !== StructureKind.Wall) continue;
    if (!isBuilt(structure, tick)) continue;
    walls += 1;
  }

  // Пустой матч — обычное дело, и чистить две с лишним тысячи байт
  // ради него незачем.
  if (walls === 0) return masks;

  owners.fill(0);

  for (const structure of structures) {
    if (structure.kind !== StructureKind.Wall) continue;
    if (!isBuilt(structure, tick)) continue;
    owners[structure.cell] = structure.owner + OWNER_OFFSET;
  }

  for (const structure of structures) {
    if (structure.kind !== StructureKind.Wall) continue;
    if (!isBuilt(structure, tick)) continue;

    const x = cellX(structure.cell);
    const y = cellY(structure.cell);
    const mine = structure.owner + OWNER_OFFSET;

    let mask = 0;
    for (let bit = 0; bit < WALL_LINK_STEPS.length; bit += 1) {
      const step = WALL_LINK_STEPS[bit];
      if (step === undefined) continue;

      const nextX = x + step[0];
      const nextY = y + step[1];

      // Выход за карту проверяется по обеим осям отдельно. Одного
      // сравнения индекса с длиной массива мало: клетка за левым краем
      // ряда — это последняя клетка ряда предыдущего, и стены на разных
      // краях карты связались бы через всю карту.
      if (nextX < 0 || nextY < 0 || nextX >= MAP_WIDTH_CELLS || nextY >= MAP_HEIGHT_CELLS) {
        continue;
      }

      if (owners[cellIndex(nextX, nextY)] === mine) mask |= 1 << bit;
    }

    masks.set(structure.cell, mask);
  }

  return masks;
};
