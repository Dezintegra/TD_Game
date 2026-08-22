import { MAP_WIDTH_CELLS, StructureKind } from '@td/shared';
import type { PlayerId } from '@td/shared';
import type { WorldState } from '@td/sim';
import type { Approach } from './approach.js';
import type { IslandsDoctrine } from './profile.js';

/**
 * Острова: башни скоплением, а не россыпью.
 *
 * Зачем это отдельно от обычного строительства. Место под башню
 * выбирается по накрытию пути в радиусе генерала, а генерал ходит туда,
 * где выгода минус риск больше. Обе величины пересчитываются дважды
 * в секунду, и узла из этого не складывается: до появления группового
 * строительства на карте одновременно стояло 0,56 башни при семнадцати
 * построенных за матч.
 *
 * Человек в живом матче играл иначе — ставил башни группами, немедленно
 * прикрывал стенами и переносил узел вперёд, — и выиграл, не потеряв
 * ни очка базы. Здесь эта манера и записана.
 *
 * ## Что здесь есть и чего нет
 *
 * Есть два вопроса: где середина текущего острова и полон ли он. Всё
 * остальное — выбор клетки под башню, стены, движение — делают те же
 * функции, что и всегда. Доктрина назначает МЕСТО РАБОТЫ, а не второй
 * способ строить.
 */

/** Клетки-середины островов по порядку: от своей базы к чужой. */
export const islandSites = (
  approach: Approach,
  doctrine: IslandsDoctrine,
): readonly number[] => {
  if (approach.shortest <= 0) return [];

  // Для каждой доли ищется клетка пути, отстоящая от своей базы примерно
  // на эту долю кратчайшего маршрута. Обход один на все доли: карта
  // большая, а долей несколько.
  const wanted = doctrine.fractions.map((fraction) =>
    Math.round(approach.shortest * fraction),
  );
  const best = wanted.map(() => -1);
  const error = wanted.map(() => Number.POSITIVE_INFINITY);

  for (let cell = 0; cell < approach.onPath.length; cell += 1) {
    if (approach.onPath[cell] !== 1) continue;

    const from = approach.fromHome[cell] ?? -1;
    if (from < 0) continue;

    wanted.forEach((target, index) => {
      const gap = Math.abs(from - target);
      if (gap >= (error[index] ?? Number.POSITIVE_INFINITY)) return;

      error[index] = gap;
      best[index] = cell;
    });
  }

  return best.filter((cell) => cell >= 0);
};

/**
 * Сколько своих башен стоит вокруг середины острова.
 *
 * Считается по миру, а не по счётчику построенного, и это главное решение
 * модуля. Счётчик расходится с миром, едва башню разрушат; выведенная
 * величина расходиться не может, и починка разрушенного получается даром:
 * остров сам перестаёт быть полным.
 *
 * Стены в счёт не идут. Полон остров или нет, решают стволы; стены при них
 * появятся сами — обычным счётчиком `wallEvery`, который ставит стену
 * рядом с уже стоящей своей башней.
 */
export const towersAround = (
  world: WorldState,
  me: PlayerId,
  centre: number,
  radiusCells: number,
): number => {
  const cx = centre % MAP_WIDTH_CELLS;
  const cy = Math.floor(centre / MAP_WIDTH_CELLS);
  let count = 0;

  for (const structure of world.structures) {
    if (structure.owner !== me) continue;
    if (structure.kind === StructureKind.Base || structure.kind === StructureKind.Wall) continue;

    const x = structure.cell % MAP_WIDTH_CELLS;
    const y = Math.floor(structure.cell / MAP_WIDTH_CELLS);
    if (Math.abs(x - cx) > radiusCells || Math.abs(y - cy) > radiusCells) continue;

    count += 1;
  }

  return count;
};

export interface IslandAim {
  /** Клетка, к которой идёт генерал. */
  readonly centre: number;
  /** Номер острова по порядку: ноль — ближайший к своей базе. */
  readonly index: number;
  /** Башен уже стоит вокруг середины. */
  readonly towers: number;
  /** Остров полон: башен набрано столько, сколько назначено. */
  readonly full: boolean;
}

/**
 * Куда работать сейчас.
 *
 * Берётся первый неполный остров начиная с `from` — номера, до которого
 * противник уже дошёл. Возврат назад не предусмотрен намеренно: остров
 * позади мог опустеть, но бросать передний ради него значило бы ходить
 * между ними без конца. Починка заднего случится, когда работа дойдёт
 * до конца списка.
 */
export const islandAim = (
  world: WorldState,
  me: PlayerId,
  approach: Approach,
  doctrine: IslandsDoctrine,
  from: number,
): IslandAim | undefined => {
  const sites = islandSites(approach, doctrine);
  if (sites.length === 0) return undefined;

  for (let index = Math.min(from, sites.length - 1); index < sites.length; index += 1) {
    const centre = sites[index];
    if (centre === undefined) continue;

    const towers = towersAround(world, me, centre, doctrine.clusterRadiusCells);
    if (towers < doctrine.clusterSize) {
      return { centre, index, towers, full: false };
    }
  }

  // Все острова полны — работа остаётся на последнем: он ближе всех
  // к противнику, и защищать его осмысленнее, чем уходить в тыл.
  const index = sites.length - 1;
  const centre = sites[index];
  if (centre === undefined) return undefined;

  return {
    centre,
    index,
    towers: towersAround(world, me, centre, doctrine.clusterRadiusCells),
    full: true,
  };
};
