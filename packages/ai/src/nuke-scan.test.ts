import { describe, expect, it } from 'vitest';
import {
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  UNIT_STATS,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
} from '@td/shared';
import type { Vec2 } from '@td/shared';
import { cellCentre, cellIndex, createWorld, playerStats } from '@td/sim';
import type { WorldState } from '@td/sim';
import { approachOf } from './approach.js';
import { BASELINE_PROFILE } from './profile.js';
import { nukeOutcome } from './value.js';
import { findNukeTarget } from './opponent.js';

/**
 * Во что обходится огрубление поиска цели сеткой.
 *
 * Место удара противник ищет перебором узлов сетки с шагом
 * `profile.nuke.scanStep` — три клетки. Шаг этот заводился, когда радиус
 * поражения был десять клеток: узел отстоял от идеальной точки не больше
 * чем на пятую часть радиуса, и потеря была незаметна. Радиус с тех пор
 * сократили до четырёх, а шаг остался прежним, и худший отступ — полтора
 * шага по каждой оси, то есть 2,12 клетки, — стал больше половины радиуса.
 *
 * Тест НИЧЕГО НЕ МЕНЯЕТ. Он называет цену нынешнего шага числом, а решение
 * о шаге принимается по названной цене: правка вслепую дала бы сдвиг
 * поведения, который потом не с чем сравнить.
 *
 * Порога на само отношение здесь нет намеренно — это был бы тот самый
 * подобранный вес, от которого уходит вся оценка удара. Требование к тесту
 * одно: он обязан падать, если оценка на сетке сравнялась с оценкой
 * в лучшей точке. Совпадение означает, что скопление поставлено в узел,
 * то есть измерять нечего.
 */

const SEED = 4242;
const ME = asPlayerId(0);
const FOE = asPlayerId(1);

const STEP = BASELINE_PROFILE.nuke.scanStep;

/**
 * Узел сетки поближе к середине карты: обе базы далеко, и запретная зона
 * наведения ни один из соседних узлов не отсекает.
 */
const NODE = cellIndex(
  Math.floor(MAP_WIDTH_CELLS / 2 / STEP) * STEP,
  Math.floor(MAP_HEIGHT_CELLS / 2 / STEP) * STEP,
);

/**
 * Худший случай, заданный прямо: центр скопления приходится на середину
 * между четырьмя узлами. Отступ до ближайшего узла — половина шага
 * по каждой оси, то есть 1,5·√2 ≈ 2,12 клетки.
 */
const CROWD_CENTRE: Vec2 = {
  x: cellCentre(NODE).x + cellsToUnits(STEP / 2),
  y: cellCentre(NODE).y + cellsToUnits(STEP / 2),
};

/** Сколько машин в ряду скопления и на сколько клеток они разнесены. */
const ROW = 5;
const SPACING = 1;

/**
 * Мир со скоплением чужих машин вокруг заданной точки.
 *
 * Скопление РАЗНЕСЕНО, а не свалено в одну точку, и это существенно:
 * машины в одной точке накрылись бы кругом с любого из четырёх соседних
 * узлов целиком, отношение вышло бы единицей, и мерить было бы нечего.
 * Разнос в одну клетку при радиусе четыре — самая обычная толпа.
 *
 * Генералы убраны с поля, чтобы в оценку не попало ничего, кроме
 * скопления: цена гибели генерала сравнима с ценой всей толпы, и один
 * случайно накрытый узел решал бы исход измерения.
 */
const withCrowd = (world: WorldState, centre: Vec2): WorldState => {
  const offset = (index: number): number => cellsToUnits((index - (ROW - 1) / 2) * SPACING);

  return {
    ...world,
    generals: world.generals.map((general) => ({ ...general, alive: false })),
    units: Array.from({ length: ROW * ROW }, (_unused, index) => ({
      id: asEntityId(9000 + index),
      owner: FOE,
      unitType: UnitType.Assault,
      position: {
        x: centre.x + offset(index % ROW),
        y: centre.y + offset(Math.floor(index / ROW)),
      },
      health: UNIT_STATS[UnitType.Assault].health,
      facing: 1,
      readyAtTick: asTickNumber(0),
      kills: 0,
    })),
  };
};

/** Чистая ценность удара в точку — та же оценка, что и у поиска. */
const netAt = (world: WorldState, centre: Vec2): number => {
  const mine = world.players[ME];
  const foe = world.players[FOE];
  if (mine === undefined || foe === undefined) throw new Error('мир без стороны');

  const outcome = nukeOutcome(world, ME, centre, playerStats(mine), playerStats(foe), () => 0);

  return outcome.gain - outcome.loss;
};

/** Радиус поражения в клетках — для печати рядом с шагом сетки. */
const radiusCells = (world: WorldState): number => {
  const mine = world.players[ME];
  if (mine === undefined) throw new Error('мир без стороны');

  return playerStats(mine).nuke.radius / cellsToUnits(1);
};

/** Лучшее, что находит настоящий обход карты — по своей сетке. */
const netOnGrid = (world: WorldState): number => {
  const mine = world.players[ME];
  const approach = approachOf(world, ME);
  if (mine === undefined || approach === undefined) throw new Error('мир без стороны');

  const found = findNukeTarget(world, ME, BASELINE_PROFILE, approach, playerStats(mine));
  if (found === undefined) throw new Error('обход не нашёл ни одной точки');

  return found.net;
};

describe('цена шага сетки при поиске места удара', () => {
  const world = withCrowd(createWorld(SEED), CROWD_CENTRE);

  it('скопление между узлами: сетка теряет часть его, и потеря названа числом', () => {
    const best = netAt(world, CROWD_CENTRE);
    const grid = netOnGrid(world);

    // Мерить есть что: скопление накрывается и стои́т чего-то.
    expect(best).toBeGreaterThan(0);

    // Здесь тест и обязан падать при совпадении: равенство означало бы,
    // что скопление стоит в узле сетки и худший случай не воспроизведён.
    expect(grid).toBeLessThan(best);

    console.info(
      `шаг сетки ${String(STEP)} кл. при радиусе ${radiusCells(world).toFixed(1)} кл.: ` +
        `лучший узел даёт ${grid.toFixed(1)} из ${best.toFixed(1)} — ` +
        `${((grid / best) * 100).toFixed(1)}% ценности лучшей точки`,
    );
  });

  it('то же скопление в узле сетки: терять нечего — и это контроль измерения', () => {
    // Контроль к проверке выше: если сетка не теряет ничего ТАМ, где терять
    // нечего, значит она теряет именно из-за отступа, а не из-за того, что
    // обход устроен как-то иначе, чем прямая оценка.
    const centred = withCrowd(createWorld(SEED), cellCentre(NODE));

    expect(netOnGrid(centred)).toBe(netAt(centred, cellCentre(NODE)));
  });
});
