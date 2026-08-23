import { BUILDABLE_KINDS, StructureKind, TICKS_PER_SECOND, UNIT_TYPES } from '@td/shared';
import { playerStats } from '@td/sim';
import type { WorldState } from '@td/sim';
import type { SideView } from './store.js';

/**
 * Положение дел по каждой стороне матча: состав войск, число построек,
 * прочность базы и состояние генерала.
 *
 * Вынесено из сборки снимка отдельным модулем ровно затем, чтобы это
 * можно было проверить тестом. Внутри `bootstrap.ts` та же функция
 * тянула бы за собой сцену, сеть и участие в матче — то есть половину
 * клиента ради подсчёта шести чисел.
 *
 * Чужая сторона считается наравне со своей. Тумана войны в игре нет
 * намеренно; всё перечисленное игрок и так видит на поле, и мы избавляем
 * его не от незнания, а от счёта в уме.
 */

/**
 * Сколько бывает видов построек. База не строится, но существует
 * и считается наравне с остальными — отсюда прибавка единицы.
 */
export const STRUCTURE_KIND_COUNT = BUILDABLE_KINDS.length + 1;

export const sidesOf = (world: WorldState): readonly SideView[] => {
  const count = world.players.length;

  const unitCounts = Array.from({ length: count }, () =>
    new Array<number>(UNIT_TYPES.length).fill(0),
  );
  const structureCounts = Array.from({ length: count }, () =>
    new Array<number>(STRUCTURE_KIND_COUNT).fill(0),
  );

  // Ноль здесь означает «базы больше нет»: разрушенная постройка
  // из списка исчезает, и отличать её от уцелевшей с нулевым здоровьем
  // не нужно — такой не бывает.
  const baseHealth = new Array<number>(count).fill(0);

  // По одному проходу на список, а не по проходу на сторону.
  //
  // Разница не умозрительная: потолок численности — двести юнитов
  // на игрока, и обход войска дважды за снимок стоил бы вдвое дороже
  // ровно в тот момент, когда на поле и так тесно.
  for (const unit of world.units) {
    const row = unitCounts[unit.owner];
    if (row !== undefined) row[unit.unitType] = (row[unit.unitType] ?? 0) + 1;
  }

  for (const structure of world.structures) {
    const row = structureCounts[structure.owner];
    if (row !== undefined) row[structure.kind] = (row[structure.kind] ?? 0) + 1;
    if (structure.kind === StructureKind.Base) baseHealth[structure.owner] = structure.health;
  }

  return world.players.map((player, index) => {
    const general = world.generals[index];

    return {
      baseHealth: baseHealth[index] ?? 0,

      // Через таблицу характеристик, а не из STRUCTURE_STATS напрямую.
      // Сегодня база не прокачивается и разницы нет никакой, но появится
      // ветка её прочности — предел поедет сам, без правки здесь.
      baseMaxHealth: playerStats(player).structures[StructureKind.Base].health,

      generalAlive: general?.alive ?? false,
      respawnInSeconds:
        general === undefined || general.alive
          ? 0
          : Math.max(0, Math.ceil((general.respawnAtTick - world.tick) / TICKS_PER_SECOND)),

      unitCounts: unitCounts[index] ?? [],
      structureCounts: structureCounts[index] ?? [],
    };
  });
};
