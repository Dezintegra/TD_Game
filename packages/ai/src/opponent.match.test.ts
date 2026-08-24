import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  FIXED_POINT_SCALE,
  MAP_CELL_COUNT,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  Terrain,
  asPlayerId,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellAt, cellIndex, cellX, cellY, createWorld, isInsideMap, step } from '@td/sim';
import type { WorldState } from '@td/sim';
import { approachOf } from './approach.js';
import { createOpponent } from './opponent.js';

/**
 * Противник проверяется прогоном настоящего матча без всякого рендера.
 *
 * Это возможно ровно потому, что он не является частью ядра и общается
 * с миром только командами: берём мир, берём противника, крутим тики.
 * Если бы он лез в состояние напрямую, такой тест пришлось бы писать
 * через браузер.
 */

const SEED = 20260820;
const AI_PLAYER: PlayerId = asPlayerId(1);

interface Outcome {
  readonly world: WorldState;
  /** На скольких тиках противник вообще отдавал команды. */
  readonly activeTicks: number;
  readonly totalCommands: number;
}

const playMatch = (seconds: number, seed = SEED): Outcome => {
  const opponent = createOpponent(AI_PLAYER, seed);
  let world = createWorld(seed);

  let activeTicks = 0;
  let totalCommands = 0;

  for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
    const commands = opponent.decide(world);

    if (commands.length > 0) {
      activeTicks += 1;
      totalCommands += commands.length;
    }

    world = step(world, commands);
  }

  return { world, activeTicks, totalCommands };
};

const ownedBy = (world: WorldState, owner: PlayerId) => ({
  units: world.units.filter((unit) => unit.owner === owner),
  buildings: world.structures.filter(
    (structure) => structure.owner === owner && structure.kind !== StructureKind.Base,
  ),
});

describe('противник под управлением компьютера', () => {
  const outcome = playMatch(120);

  it('строит постройки', () => {
    expect(ownedBy(outcome.world, AI_PLAYER).buildings.length).toBeGreaterThan(0);
  });

  it('производит юнитов', () => {
    expect(ownedBy(outcome.world, AI_PLAYER).units.length).toBeGreaterThan(0);
  });

  it('вкладывается в экономику в начале матча', () => {
    const player = outcome.world.players[AI_PLAYER];
    const levels = player?.upgrades.reduce((sum, upgrade) => sum + upgrade.level, 0) ?? 0;

    expect(levels).toBeGreaterThan(0);
  });

  it('двигает генерала', () => {
    const start = createWorld(SEED).generals[AI_PLAYER]?.position;
    const now = outcome.world.generals[AI_PLAYER]?.position;

    expect(start).toBeDefined();
    expect(now).toBeDefined();
    expect(now?.x !== start?.x || now?.y !== start?.y).toBe(true);
  });

  it('не уходит в минус по энергии', () => {
    expect(outcome.world.players[AI_PLAYER]?.energy).toBeGreaterThanOrEqual(0);
  });

  it('не отдаёт команды каждый тик', () => {
    // Ограничение осознанное: человек не может отдавать тридцать команд
    // в секунду, и противник, который может, выигрывает не умом,
    // а частотой.
    expect(outcome.activeTicks).toBeLessThan(120 * TICKS_PER_SECOND * 0.2);
    expect(outcome.totalCommands).toBeGreaterThan(0);
  });

  it('не трогает чужие сущности', () => {
    // Противник играет за второго игрока. Если бы он как-то влиял на мир
    // в обход команд, у первого игрока появились бы постройки и юниты,
    // которых никто не заказывал.
    const mine = ownedBy(outcome.world, asPlayerId(0));

    expect(mine.buildings).toHaveLength(0);
    expect(mine.units).toHaveLength(0);
  });

  it('играет одинаково при одинаковом seed', () => {
    const first = playMatch(30, 777);
    const second = playMatch(30, 777);

    expect(first.totalCommands).toBe(second.totalCommands);
    expect(first.world.units.length).toBe(second.world.units.length);
    expect(first.world.structures.length).toBe(second.world.structures.length);
  });
});

describe('вероятный путь вражеских войск', () => {
  const approach = approachOf(createWorld(SEED), AI_PLAYER);

  it('вычисляется и не пуст', () => {
    expect(approach).toBeDefined();

    let count = 0;
    for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
      if (approach?.onPath[cell] === 1) count += 1;
    }

    expect(count).toBeGreaterThan(0);
  });

  it('состоит только из проходимых клеток', () => {
    const world = createWorld(SEED);

    for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
      if (approach?.onPath[cell] !== 1) continue;

      expect(world.map.cells[cell]).toBe(Terrain.Ground);
    }
  });
});

describe('размещение построек противника', () => {
  const outcome = playMatch(180);
  const approach = approachOf(createWorld(SEED), AI_PLAYER);

  /** Есть ли в радиусе клетки хоть одна клетка вероятного пути. */
  const coversPath = (cell: number, rangeCells: number): boolean => {
    const cx = cellX(cell);
    const cy = cellY(cell);

    for (let dy = -rangeCells; dy <= rangeCells; dy += 1) {
      for (let dx = -rangeCells; dx <= rangeCells; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (!isInsideMap(x, y)) continue;
        if (approach?.onPath[cellIndex(x, y)] === 1) return true;
      }
    }

    return false;
  };

  it('каждая башня накрывает вероятный путь', () => {
    const towers = ownedBy(outcome.world, AI_PLAYER).buildings.filter(
      (structure) => structure.kind !== StructureKind.Wall,
    );
    const range = Math.round(STRUCTURE_STATS[StructureKind.TowerBasic].range / FIXED_POINT_SCALE);

    expect(towers.length).toBeGreaterThan(0);
    for (const tower of towers) {
      expect(coversPath(tower.cell, range)).toBe(true);
    }
  });
});

/**
 * Постройки, заказанные за один тик, — по тикам, где их было хоть сколько.
 *
 * Заодно проверяется, что заказ прошёл: сразу после `step` в каждой
 * названной клетке обязана стоять постройка противника. Ядро отклоняет
 * и покупку не по карману, и постройку в занятую клетку, поэтому одна
 * эта проверка ловит обе беды, ради которых группа ведёт свои записи.
 */
const buildGroups = (seconds: number, seed = SEED): readonly (readonly number[])[] => {
  const opponent = createOpponent(AI_PLAYER, seed);
  let world = createWorld(seed);

  const groups: number[][] = [];

  for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
    const commands = opponent.decide(world);
    const cells = commands.flatMap((issued) =>
      issued.kind === CommandKind.Build ? [issued.cell] : [],
    );

    world = step(world, commands);

    if (cells.length === 0) continue;

    for (const cell of cells) {
      const standing = world.structures.some(
        (structure) => structure.owner === AI_PLAYER && structure.cell === cell,
      );
      expect(standing).toBe(true);
    }

    groups.push(cells);
  }

  return groups;
};

describe('постройки ставятся группой', () => {
  const groups = buildGroups(180);

  it('за одно решение случается больше одной постройки', () => {
    // Ради этого всё и затевалось. До правки решение отдавало не более
    // одной команды постройки, и группа из трёх башен собиралась
    // полторы минуты — если казна вообще дотерпит.
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.some((group) => group.length > 1)).toBe(true);
  });

  it('клетки внутри группы не повторяются', () => {
    // Мир между командами одного решения не меняется, поэтому вторая
    // башня, спрошенная у тех же функций, назвала бы ту же клетку.
    // От этого группу и берегут копии покрытия и занятости.
    for (const group of groups) {
      expect(new Set(group).size).toBe(group.length);
    }
  });

  it('послабление касается только построек', () => {
    // Правило «одна покупка за решение» заводилось против обратной беды:
    // юнит стоит вчетверо дешевле башни и вдесятеро дешевле улучшения
    // экономики, поэтому «юниты первыми» без ограничения означает «юниты
    // всегда». Башня из правила выведена потому, что самоограничена:
    // ставить её некуда, как только путь в радиусе накрыт.
    //
    // Добивающий рывок сюда не попадает: он заказывает волну одним
    // залпом и по построению тратит казну целиком, поэтому решения
    // с несколькими заказами юнитов из проверки исключаются, а не
    // объявляются ошибкой.
    const opponent = createOpponent(AI_PLAYER, SEED);
    let world = createWorld(SEED);

    let upgradeBursts = 0;

    for (let tick = 0; tick < 180 * TICKS_PER_SECOND; tick += 1) {
      const commands = opponent.decide(world);
      world = step(world, commands);

      const upgrades = commands.filter((issued) => issued.kind === CommandKind.BuyUpgrade);
      if (upgrades.length > 1) upgradeBursts += 1;
    }

    expect(upgradeBursts).toBe(0);
  });

  it('группа кончается насыщением, а не упирается в геометрию', () => {
    // Потолка «не больше N за решение» в коде нет намеренно: предел
    // задаётся убывающей отдачей. Сторожить надо именно её, и порог
    // поэтому взят не с потолка, а от той границы, которая осталась бы
    // единственной, если бы покрытие перестало учитываться: радиус
    // строительства в пять клеток — это круг в восемь десятков клеток,
    // и группа, ограниченная одной геометрией, разрослась бы до них.
    //
    // Наблюдаемая величина много меньше: четыре постройки на этом seed,
    // девять — самая большая за пачку матчей арены. Запас между
    // наблюдаемым и порогом оставлен нарочно: тест обязан ловить
    // пропажу убывающей отдачи, а не колебания в пределах горсти клеток.
    const largest = groups.reduce((best, group) => Math.max(best, group.length), 0);

    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThan(20);
  });
});

/**
 * Путь генерала за матч: последовательность посещённых клеток без повторов
 * подряд. По ней видно и то, что он вообще ходит, и то, что он не топчется.
 */
const generalTrail = (seconds: number, seed = SEED): readonly number[] => {
  const opponent = createOpponent(AI_PLAYER, seed);
  let world = createWorld(seed);

  const trail: number[] = [];

  for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
    world = step(world, opponent.decide(world));

    const general = world.generals[AI_PLAYER];
    if (general === undefined || !general.alive) continue;

    const cell = cellAt(general.position);
    if (trail[trail.length - 1] !== cell) trail.push(cell);
  }

  return trail;
};

describe('генерал противника', () => {
  const trail = generalTrail(180);

  it('ходит по карте', () => {
    expect(new Set(trail).size).toBeGreaterThan(5);
  });

  it('не топчется взад-вперёд', () => {
    // Топтание — это возврат в клетку, из которой только что вышел.
    // Немного таких шагов неизбежно: генерал идёт по сетке, а цель
    // не обязана лежать по её линиям. Но их не должно быть больше,
    // чем шагов вперёд, иначе это и есть метание.
    let bounces = 0;
    for (let index = 2; index < trail.length; index += 1) {
      if (trail[index] === trail[index - 2]) bounces += 1;
    }

    expect(trail.length).toBeGreaterThan(10);
    expect(bounces * 2).toBeLessThan(trail.length);
  });

  it('за матч уходит на вражескую половину пути', () => {
    // Прежняя версия упиралась в потолок продвижения 0,45 и дальше
    // середины карты не заходила никогда. Экспансия — главное, ради чего
    // затевалась развесовка.
    const approach = approachOf(createWorld(SEED), AI_PLAYER);
    if (approach === undefined) throw new Error('вероятный путь не посчитан');

    const furthest = trail.reduce((best, cell) => Math.max(best, approach.fromHome[cell] ?? 0), 0);

    expect(furthest / approach.shortest).toBeGreaterThan(0.5);
  });
});

describe('стоимость тика', () => {
  it('полный матч считается заметно быстрее реального времени', () => {
    // Проверка не столько скорости, сколько отсутствия квадратичных
    // зависимостей: если поиск цели или путь начнут перебирать всех
    // против всех, этот тест станет первым, кто это заметит.
    const started = performance.now();
    playMatch(60);
    const elapsed = performance.now() - started;

    // Минута игры должна считаться быстрее, чем идёт минута, с большим
    // запасом. Порог намеренно щедрый: на нагруженной машине измерение
    // шумит, а ловим мы порядок величины, а не проценты.
    expect(elapsed).toBeLessThan(20_000);
  });
});
