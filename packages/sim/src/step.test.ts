import { describe, expect, it } from 'vitest';
import {
  AttackStance,
  BASE_BUILD_EXCLUSION,
  BASE_INCOME_PER_TICK,
  BUILDABLE_KINDS,
  CommandKind,
  DIRECTION_SOUTH,
  GENERAL_KILL_REWARD,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  NUKE_COST,
  NUKE_DELAY_TICKS,
  PPM_ONE,
  PRODUCTION_QUEUE_CAP,
  STRUCTURE_STATS,
  StructureKind,
  Terrain,
  UNIT_STATS,
  UPGRADE_BRANCHES,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
  distanceSquared,
  upgradeBranchIndex,
} from '@td/shared';
import type { Command, PlayerId } from '@td/shared';
import { createWorld } from './world.js';
import type { PlayerState, StructureState, WorldState } from './world.js';
import { step } from './step.js';
import { checksum } from './checksum.js';
import { cellAt, cellCentre, cellIndex } from './map.js';
import { buildOccupancy } from './occupancy.js';
import { playerStats } from './stats.js';

const SEED = 4242;

/**
 * Мир строится генерацией, а тестам нужны точные позиции. Поэтому
 * состояние правится точечно: это обычный объект, и подмена одного поля
 * не ломает остальные инварианты.
 */
const patchPlayer = (world: WorldState, id: number, patch: Partial<PlayerState>): WorldState => ({
  ...world,
  players: world.players.map((player, index) => (index === id ? { ...player, ...patch } : player)),
});

const richWorld = (seed = SEED, energy = 10_000_000): WorldState =>
  patchPlayer(patchPlayer(createWorld(seed), 0, { energy }), 1, { energy });

const baseCellOf = (world: WorldState, player: number): number => world.map.baseCells[player] ?? 0;

const run = (world: WorldState, ticks: number, commands: readonly Command[] = []): WorldState => {
  let current = step(world, commands);
  for (let tick = 1; tick < ticks; tick += 1) {
    current = step(current, []);
  }
  return current;
};

const command = <T extends Command>(value: T): T => value;

const build = (player: number, cell: number, structure: StructureKind): Command =>
  command({
    kind: CommandKind.Build,
    player: asPlayerId(player),
    tick: asTickNumber(0),
    cell,
    structure,
  });

const train = (player: number, unitType: UnitType): Command =>
  command({
    kind: CommandKind.TrainUnit,
    player: asPlayerId(player),
    tick: asTickNumber(0),
    unitType,
  });

const buy = (player: number, branch: number): Command =>
  command({
    kind: CommandKind.BuyUpgrade,
    player: asPlayerId(player),
    tick: asTickNumber(0),
    branch,
  });

const demolish = (player: number, cell: number): Command =>
  command({
    kind: CommandKind.Demolish,
    player: asPlayerId(player),
    tick: asTickNumber(0),
    cell,
  });

const nuke = (player: number, cell: number): Command =>
  command({
    kind: CommandKind.LaunchNuke,
    player: asPlayerId(player),
    tick: asTickNumber(0),
    cell,
  });

/**
 * Ближайшая к генералу клетка, где постройка пройдёт все проверки ядра.
 *
 * Раньше здесь стояло фиксированное смещение в две клетки от базы, и оно
 * перестало годиться, когда вокруг базы появилось защищённое кольцо.
 * Поиск вместо смещения переживёт и следующую правку правил: помощник
 * спрашивает у мира, а не помнит числа.
 */
const nearBaseCell = (world: WorldState, player: number): number => {
  const general = world.generals[player];
  if (general === undefined) throw new Error(`Нет генерала ${String(player)}`);

  const state = world.players[player];
  if (state === undefined) throw new Error(`Нет игрока ${String(player)}`);

  const occupancy = buildOccupancy(world.map, world.structures);
  const radius = playerStats(state).general.buildRadius;

  const living = new Set([
    ...world.units.map((unit) => cellAt(unit.position)),
    ...world.generals.map((entry) => cellAt(entry.position)),
  ]);

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (occupancy.blocked[cell] === 1 || living.has(cell)) continue;

    const centre = cellCentre(cell);

    const distance = distanceSquared(centre, general.position);
    if (distance > radius * radius || distance >= bestDistance) continue;

    const nearBase = world.map.baseCells.some(
      (base) => distanceSquared(centre, cellCentre(base)) <= BASE_BUILD_EXCLUSION ** 2,
    );
    if (nearBase) continue;

    bestDistance = distance;
    best = cell;
  }

  if (best < 0) throw new Error(`Негде строить игроку ${String(player)}`);

  return best;
};

/** Игрок из состояния мира. Обёртка ради читаемости — индекс всегда валиден. */
const playerOf = (world: WorldState, index: number): PlayerState => {
  const found = world.players[index];
  if (found === undefined) throw new Error(`Нет игрока ${String(index)}`);
  return found;
};

describe('шаг симуляции: основы', () => {
  it('не мутирует входное состояние', () => {
    const world = richWorld();
    const before = checksum(world);

    step(world, [build(0, nearBaseCell(world, 0), StructureKind.Wall)]);

    // Сравниваем контрольные суммы, а не объекты через structuredClone:
    // в браузерном окружении клон типизированного массива приходит
    // из другого realm, и глубокое сравнение спотыкается о разные
    // конструкторы при полностью одинаковом содержимом.
    expect(checksum(world)).toBe(before);
  });

  it('увеличивает номер тика ровно на единицу', () => {
    expect(step(createWorld(SEED), []).tick).toBe(1);
  });

  it('создаёт по базе и генералу на каждого игрока', () => {
    const world = createWorld(SEED);

    expect(world.structures.filter((s) => s.kind === StructureKind.Base)).toHaveLength(2);
    expect(world.generals).toHaveLength(2);
    expect(world.generals.every((general) => general.alive)).toBe(true);
  });

  it('целью по умолчанию является база противника', () => {
    const world = createWorld(SEED);
    const enemyBase = world.structures.find((s) => s.owner === asPlayerId(1));

    expect(world.players[0]?.targetStructure).toBe(enemyBase?.id);
  });
});

describe('экономика', () => {
  it('энергия начисляется каждый тик сама по себе', () => {
    const world = createWorld(SEED);
    const before = world.players[0]?.energy ?? 0;

    const after = run(world, 30);

    expect((after.players[0]?.energy ?? 0) - before).toBe(BASE_INCOME_PER_TICK * 30);
  });

  it('прокачка экономики ускоряет доход', () => {
    const branch = UPGRADE_BRANCHES.findIndex((entry) => entry.target === UpgradeTarget.Economy);
    const world = step(richWorld(), [buy(0, branch)]);

    expect(playerStats(playerOf(world, 0)).incomePerTick).toBeGreaterThan(BASE_INCOME_PER_TICK);
  });
});

describe('строительство', () => {
  it('ставит стену рядом с генералом и списывает энергию', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [build(0, cell, StructureKind.Wall)]);

    expect(after.structures.some((s) => s.cell === cell && s.kind === StructureKind.Wall)).toBe(
      true,
    );
    expect(after.players[0]?.energy).toBeLessThan(before);
  });

  it('не ставит вторую постройку в ту же клетку', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);

    const after = step(world, [
      build(0, cell, StructureKind.Wall),
      build(0, cell, StructureKind.Wall),
    ]);

    expect(after.structures.filter((s) => s.cell === cell)).toHaveLength(1);
  });

  it('не ставит постройку вне радиуса строительства', () => {
    const world = richWorld();
    // Противоположный угол карты: заведомо вне радиуса и при этом внутри
    // карты — иначе команду отклонила бы проверка индекса, а не радиуса,
    // и тест охранял бы не то правило.
    const far = cellIndex(MAP_WIDTH_CELLS - 5, MAP_HEIGHT_CELLS - 5);
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [build(0, far, StructureKind.Wall)]);

    expect(after.structures.some((s) => s.cell === far)).toBe(false);
    // Энергия не тронута: команда либо применяется целиком, либо никак.
    expect(after.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK);
  });

  it('не ставит постройку при нехватке энергии', () => {
    const world = patchPlayer(createWorld(SEED), 0, { energy: 0 });
    const cell = nearBaseCell(world, 0);

    const after = step(world, [build(0, cell, StructureKind.Wall)]);

    expect(after.structures.some((s) => s.cell === cell)).toBe(false);
  });

  it('недостроенная постройка слабее готовой и не стреляет', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);

    const fresh = step(world, [build(0, cell, StructureKind.TowerBasic)]);
    const tower = fresh.structures.find((s) => s.cell === cell);

    expect(tower).toBeDefined();
    expect(tower?.health).toBeLessThan(STRUCTURE_STATS[StructureKind.TowerBasic].health);
    expect(tower?.builtAtTick).toBeGreaterThan(fresh.tick);
  });

  it('по завершении возведения здоровье достигает максимума', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const buildTicks = STRUCTURE_STATS[StructureKind.TowerBasic].buildTicks;

    const after = run(world, buildTicks + 2, [build(0, cell, StructureKind.TowerBasic)]);
    const tower = after.structures.find((s) => s.cell === cell);

    expect(tower?.health).toBe(STRUCTURE_STATS[StructureKind.TowerBasic].health);
  });

  /** Догнать мир до тика, на котором постройка считается готовой. */
  const runUntilBuilt = (world: WorldState, cell: number): WorldState => {
    const builtAt = world.structures.find((s) => s.cell === cell)?.builtAtTick ?? 0;

    let current = world;
    while (current.tick < builtAt) current = step(current, []);

    return current;
  };

  /** Догнать мир до тика, на котором сносимая постройка исчезает. */
  const runUntilGone = (world: WorldState, cell: number): WorldState => {
    const goneAt = world.structures.find((s) => s.cell === cell)?.demolishAtTick ?? 0;

    let current = world;
    while (current.tick < goneAt) current = step(current, []);

    return current;
  };

  it('снайперская башня на середине возведения заметно слабее готовой', () => {
    // Тот самый случай, который ломало округление вверх: сто двадцать
    // единиц прочности раздавались за сто двадцать тиков из двухсот
    // семидесяти, и башня стояла целой, но не стреляющей, пять секунд.
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const placed = step(world, [build(0, cell, StructureKind.TowerSniper)]);
    const builtAt = placed.structures.find((s) => s.cell === cell)?.builtAtTick ?? 0;

    let current = placed;
    while (current.tick < Math.floor(builtAt / 2)) current = step(current, []);

    const max = STRUCTURE_STATS[StructureKind.TowerSniper].health;
    const half = current.structures.find((s) => s.cell === cell);

    expect(half?.health).toBeLessThan(max * 0.7);
    expect(half?.health).toBeGreaterThan(max * 0.3);
  });

  it('к концу возведения набрано ровно столько, сколько нужно', () => {
    for (const kind of BUILDABLE_KINDS) {
      const world = richWorld();
      const cell = nearBaseCell(world, 0);
      const done = runUntilBuilt(step(world, [build(0, cell, kind)]), cell);

      expect(done.structures.find((s) => s.cell === cell)?.health).toBe(
        STRUCTURE_STATS[kind].health,
      );
    }
  });

  it('подстреленная во время стройки постройка не долечивается', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const placed = step(world, [build(0, cell, StructureKind.TowerBasic)]);

    // Урон наносится правкой состояния, а не боем: рядом с базой стрелять
    // некому, а заводить ради одного теста целую расстановку незачем.
    const damage = 30;
    const wounded: WorldState = {
      ...placed,
      structures: placed.structures.map((entry) =>
        entry.cell === cell ? { ...entry, health: entry.health - damage } : entry,
      ),
    };

    const done = runUntilBuilt(wounded, cell);

    // Набор идёт по расписанию и не зависит от текущей прочности, поэтому
    // недостача сохраняется до конца возведения.
    expect(done.structures.find((s) => s.cell === cell)?.health).toBe(
      STRUCTURE_STATS[StructureKind.TowerBasic].health - damage,
    );
  });

  /**
   * Обстроить базу настолько, насколько правила это позволяют.
   *
   * Стены ставятся прямо в состояние, а не командами: команд понадобилось бы
   * несколько сотен, а генерал всё равно не дотянулся бы до дальних клеток.
   * Проверяем мы не то, как их построили, а то, что база работает,
   * когда их построили.
   */
  const besiege = (world: WorldState, player: number): WorldState => {
    const base = cellCentre(baseCellOf(world, player));
    const outer = cellsToUnits(9);

    const walls: StructureState[] = [];
    let nextId = world.nextEntityId;

    for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
      if (world.map.cells[cell] !== Terrain.Ground) continue;

      const distance = distanceSquared(cellCentre(cell), base);
      if (distance <= BASE_BUILD_EXCLUSION ** 2 || distance > outer * outer) continue;

      walls.push({
        id: asEntityId(nextId),
        owner: asPlayerId(player),
        kind: StructureKind.Wall,
        cell,
        health: STRUCTURE_STATS[StructureKind.Wall].health,
        growthPpm: PPM_ONE,
        readyAtTick: asTickNumber(0),
        builtAtTick: asTickNumber(0),
        demolishAtTick: asTickNumber(0),
        facing: DIRECTION_SOUTH,
      });
      nextId += 1;
    }

    return { ...world, structures: [...world.structures, ...walls], nextEntityId: nextId };
  };

  it('обстроенная по правилам база всё равно выпускает юнитов', () => {
    // Главный тест изменения: ради этого кольцо и заводилось. Раньше базу
    // можно было обложить вплотную, и производство вставало намертво.
    const world = besiege(richWorld(), 0);
    const after = run(world, 5, [train(0, UnitType.Assault)]);

    expect(after.units.some((unit) => unit.owner === 0)).toBe(true);
  });

  it('обстроенная по правилам база всё равно возвращает генерала', () => {
    const world = besiege(richWorld(), 0);
    const dead: WorldState = {
      ...world,
      generals: world.generals.map((general, index) =>
        index === 0
          ? { ...general, alive: false, respawnAtTick: asTickNumber(world.tick + 1) }
          : general,
      ),
    };

    const after = run(dead, 5);

    expect(after.generals[0]?.alive).toBe(true);
  });

  it('дальность снайпера растёт от прокачки, а штурмовика — нет', () => {
    const world = richWorld();
    const branch = upgradeBranchIndex(UpgradeTarget.UnitSniper, UpgradeStat.Range);

    const before = playerStats(playerOf(world, 0));
    const after = playerStats(playerOf(run(world, 3, [buy(0, branch)]), 0));

    expect(after.units[UnitType.Sniper].range).toBeGreaterThan(
      before.units[UnitType.Sniper].range,
    );
    // У штурмовика ветки нет, и множитель для него остаётся единичным.
    expect(after.units[UnitType.Assault].range).toBe(before.units[UnitType.Assault].range);
    // Ветки разных типов независимы: покупка у снайпера гранатомётчика
    // не трогает.
    expect(after.units[UnitType.Grenadier].range).toBe(before.units[UnitType.Grenadier].range);
  });

  it('прокачка дальности действует на уже выпущенных юнитов', () => {
    // Характеристики считаются из состояния игрока каждый тик, а не
    // запоминаются юнитом при рождении, — но проверить это надо, а не
    // поверить.
    const world = richWorld();
    const branch = upgradeBranchIndex(UpgradeTarget.UnitSniper, UpgradeStat.Range);

    const withUnit = run(world, 3, [train(0, UnitType.Sniper)]);
    expect(withUnit.units.some((unit) => unit.owner === 0)).toBe(true);

    const before = playerStats(playerOf(withUnit, 0)).units[UnitType.Sniper].range;
    const after = playerStats(playerOf(run(withUnit, 3, [buy(0, branch)]), 0)).units[
      UnitType.Sniper
    ].range;

    expect(after).toBeGreaterThan(before);
  });

  it('снос идёт столько же, сколько возведение, и освобождает клетку в конце', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const built = runUntilBuilt(step(world, [build(0, cell, StructureKind.Wall)]), cell);

    const started = step(built, [demolish(0, cell)]);
    const target = started.structures.find((s) => s.cell === cell);
    expect(target?.demolishAtTick).toBe(started.tick + STRUCTURE_STATS[StructureKind.Wall].buildTicks);

    // На середине сноса клетка ещё непроходима: разбираемая стена
    // продолжает перекрывать проход.
    let current = started;
    const half = Math.floor((started.tick + (target?.demolishAtTick ?? 0)) / 2);
    while (current.tick < half) current = step(current, []);

    expect(buildOccupancy(current.map, current.structures).blocked[cell]).toBe(1);
    expect(current.structures.find((s) => s.cell === cell)?.health).toBeLessThan(
      STRUCTURE_STATS[StructureKind.Wall].health,
    );

    while (current.tick < (target?.demolishAtTick ?? 0)) current = step(current, []);

    expect(current.structures.some((s) => s.cell === cell)).toBe(false);
    expect(buildOccupancy(current.map, current.structures).blocked[cell]).toBe(0);
  });

  it('снос не меняет энергию ни в начале, ни в конце', () => {
    // Возврата нет намеренно: он потребовал бы хранить у каждой постройки
    // цену покупки, а вместе с нею лишнее число в контрольной сумме.
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const built = runUntilBuilt(step(world, [build(0, cell, StructureKind.Wall)]), cell);

    const before = playerOf(built, 0).energy;
    const started = step(built, [demolish(0, cell)]);
    const done = runUntilGone(started, cell);

    const income = BASE_INCOME_PER_TICK * (done.tick - built.tick);
    expect(playerOf(done, 0).energy).toBe(before + income);
  });

  it('начатый снос не отменяется повторной командой', () => {
    // Отмена вернула бы мгновенность через чёрный ход: начал сносить,
    // увидел волну, передумал.
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const built = runUntilBuilt(step(world, [build(0, cell, StructureKind.Wall)]), cell);

    const started = step(built, [demolish(0, cell)]);
    const at = started.structures.find((s) => s.cell === cell)?.demolishAtTick;

    const again = step(started, [demolish(0, cell)]);

    expect(again.rejections).toHaveLength(0);
    expect(again.structures.find((s) => s.cell === cell)?.demolishAtTick).toBe(at);
  });

  it('разрушенная постройка исчезает и освобождает клетку', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);

    // Стену надо сначала достроить: пока идёт возведение, здоровье
    // прибавляется каждый тик быстрее, чем его успевает снимать один
    // стрелок, и стена бы просто не умерла.
    const built = run(world, STRUCTURE_STATS[StructureKind.Wall].buildTicks + 2, [
      build(0, cell, StructureKind.Wall),
    ]);
    const centre = cellCentre(cell);

    const doomed: WorldState = {
      ...built,
      structures: built.structures.map((s) => (s.cell === cell ? { ...s, health: 1 } : s)),
      units: [
        {
          id: asEntityId(500),
          owner: asPlayerId(1),
          unitType: UnitType.Assault,
          // Две клетки от стены, а не одна. Ближе нельзя: расстояние
          // до построек считается до основания, и с одной клетки юнит
          // достаёт уже до самой базы, а назначенная цель важнее
          // случайной стены — он выстрелил бы по базе.
          position: { x: centre.x + 2000, y: centre.y },
          health: 100,
          facing: DIRECTION_SOUTH,
          readyAtTick: asTickNumber(0),
        },
      ],
    };

    const after = run(doomed, 2);

    expect(after.structures.some((s) => s.cell === cell)).toBe(false);
    // Клетка снова проходима — это и проверяет, что сетка занятости
    // пересобралась после гибели постройки.
    expect(buildOccupancy(after.map, after.structures).blocked[cell]).toBe(0);
  });
});

describe('производство юнитов', () => {
  it('списывает энергию сразу', () => {
    const world = richWorld();
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [train(0, UnitType.Assault)]);

    expect(after.players[0]?.energy).toBeLessThan(before + BASE_INCOME_PER_TICK);
  });

  it('выпускает юнита без отката, за тот же тик', () => {
    const after = step(richWorld(), [train(0, UnitType.Assault)]);

    expect(after.units).toHaveLength(1);
    expect(after.units[0]?.owner).toBe(asPlayerId(0));
    // Очередь при мгновенном производстве остаётся пустой: она нужна
    // только для ожидания места, а место есть.
    expect(after.players[0]?.queue).toHaveLength(0);
  });

  it('соблюдает порядок очереди', () => {
    const after = step(richWorld(), [train(0, UnitType.Assault), train(0, UnitType.Sniper)]);

    expect(after.units[0]?.unitType).toBe(UnitType.Assault);
    expect(after.units[1]?.unitType).toBe(UnitType.Sniper);
  });

  it('не ставит в очередь при нехватке энергии', () => {
    const poor = patchPlayer(createWorld(SEED), 0, { energy: 0 });

    const after = step(poor, [train(0, UnitType.Grenadier)]);

    expect(after.players[0]?.queue).toHaveLength(0);
    expect(after.units).toHaveLength(0);
  });

  it('не превышает потолок очереди', () => {
    const orders = Array.from({ length: PRODUCTION_QUEUE_CAP + 5 }, () =>
      train(0, UnitType.Assault),
    );

    const after = step(richWorld(), orders);

    // Лишние заказы отклонены на входе, принятые вышли на карту сразу.
    expect(after.units).toHaveLength(PRODUCTION_QUEUE_CAP);
  });

  it('пачка юнитов появляется в разных клетках', () => {
    const orders = Array.from({ length: 10 }, () => train(0, UnitType.Assault));

    const after = step(richWorld(), orders);
    const places = new Set(after.units.map((unit) => `${unit.position.x}:${unit.position.y}`));

    // Иначе десяток заказанных разом встал бы в одну точку и двигался
    // дальше слитно — на поле это неотличимо от одного юнита.
    expect(places.size).toBe(after.units.length);
  });
});

describe('прокачка', () => {
  const attackBranch = UPGRADE_BRANCHES.findIndex(
    (entry) => entry.target === UpgradeTarget.UnitAssault && entry.stat === UpgradeStat.Attack,
  );
  const healthBranch = UPGRADE_BRANCHES.findIndex(
    (entry) => entry.target === UpgradeTarget.TowerBasic && entry.stat === UpgradeStat.Health,
  );

  it('поднимает уровень и списывает энергию', () => {
    const world = richWorld();
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [buy(0, attackBranch)]);

    expect(after.players[0]?.upgrades[attackBranch]?.level).toBe(1);
    expect(after.players[0]?.energy).toBeLessThan(before);
  });

  it('усиливает все юниты своего типа и не трогает чужой', () => {
    const after = step(richWorld(), [buy(0, attackBranch)]);
    const stats = playerStats(playerOf(after, 0));

    expect(stats.units[UnitType.Assault].attack).toBeGreaterThan(
      UNIT_STATS[UnitType.Assault].attack,
    );
    expect(stats.units[UnitType.Sniper].attack).toBe(UNIT_STATS[UnitType.Sniper].attack);
  });

  it('удорожает покупку своего типа примерно на два процента', () => {
    const after = step(richWorld(), [buy(0, attackBranch)]);
    const stats = playerStats(playerOf(after, 0));

    const grown = stats.units[UnitType.Assault].cost / UNIT_STATS[UnitType.Assault].cost;
    expect(grown).toBeGreaterThan(1.019);
    expect(grown).toBeLessThan(1.021);
  });

  it('прокачка генерала цен не двигает', () => {
    const branch = UPGRADE_BRANCHES.findIndex(
      (entry) => entry.target === UpgradeTarget.General && entry.stat === UpgradeStat.Speed,
    );

    const after = step(richWorld(), [buy(0, branch)]);
    const stats = playerStats(playerOf(after, 0));

    expect(stats.units[UnitType.Assault].cost).toBe(UNIT_STATS[UnitType.Assault].cost);
  });

  it('цена следующего уровня растёт', () => {
    const once = step(richWorld(), [buy(0, attackBranch)]);
    const twice = step(once, [buy(0, attackBranch)]);

    expect(twice.players[0]?.upgrades[attackBranch]?.costPpm).toBeGreaterThan(
      once.players[0]?.upgrades[attackBranch]?.costPpm ?? 0,
    );
  });

  it('прочность добавляется уже построенной башне', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);

    const built = run(world, STRUCTURE_STATS[StructureKind.TowerBasic].buildTicks + 2, [
      build(0, cell, StructureKind.TowerBasic),
    ]);
    const before = built.structures.find((s) => s.cell === cell)?.health ?? 0;

    const upgraded = step(built, [buy(0, healthBranch)]);
    const after = upgraded.structures.find((s) => s.cell === cell)?.health ?? 0;

    expect(after).toBeGreaterThan(before);
  });

  it('число покупок не ограничено', () => {
    let world = richWorld();
    for (let index = 0; index < 40; index += 1) {
      world = step(world, [buy(0, attackBranch)]);
    }

    expect(world.players[0]?.upgrades[attackBranch]?.level).toBe(40);
  });
});

describe('ядерный удар', () => {
  // Середина карты — единственная точка, заведомо лежащая вне запретных
  // зон обеих баз. Считается от размера карты, а не вписана числом:
  // карта уже однажды меняла размер.
  const CENTRE = cellIndex(MAP_WIDTH_CELLS / 2, MAP_HEIGHT_CELLS / 2);

  it('создаёт запись об ударе и списывает энергию', () => {
    const world = richWorld();
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [nuke(0, CENTRE)]);

    expect(after.nukes).toHaveLength(1);
    expect(after.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK - NUKE_COST);
  });

  it('взрывается по истечении задержки', () => {
    const after = run(richWorld(), NUKE_DELAY_TICKS + 2, [nuke(0, CENTRE)]);

    expect(after.nukes).toHaveLength(0);
  });

  it('уничтожает юнитов обеих сторон в радиусе', () => {
    const world = richWorld();
    const epicentre = cellCentre(CENTRE);

    const withUnits: WorldState = {
      ...world,
      units: [0, 1].map((owner) => ({
        id: asEntityId(100 + owner),
        owner: asPlayerId(owner),
        unitType: UnitType.Assault,
        position: { x: epicentre.x + owner * 1000, y: epicentre.y },
        health: 100,
        readyAtTick: asTickNumber(0),
      })),
    };

    const after = run(withUnits, NUKE_DELAY_TICKS + 2, [nuke(0, CENTRE)]);

    expect(after.units).toHaveLength(0);
  });

  it('отклоняется при наведении рядом с базой', () => {
    const world = richWorld();
    const base = baseCellOf(world, 1);
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [nuke(0, base)]);

    expect(after.nukes).toHaveLength(0);
    expect(after.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK);
  });

  it('отклоняется при нехватке энергии', () => {
    const poor = patchPlayer(createWorld(SEED), 0, { energy: 0 });

    expect(step(poor, [nuke(0, CENTRE)]).nukes).toHaveLength(0);
  });
});

describe('генерал', () => {
  it('гибнет и возвращается на базу', () => {
    const world = createWorld(SEED);
    const wounded: WorldState = {
      ...world,
      generals: world.generals.map((general, index) =>
        index === 0
          ? { ...general, health: 0, alive: false, respawnAtTick: asTickNumber(5) }
          : general,
      ),
    };

    const soon = run(wounded, 3);
    expect(soon.generals[0]?.alive).toBe(false);

    const later = run(wounded, 8);
    expect(later.generals[0]?.alive).toBe(true);
    expect(later.generals[0]?.health).toBeGreaterThan(0);
  });

  it('мёртвый генерал не строит', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const dead: WorldState = {
      ...world,
      generals: world.generals.map((general, index) =>
        index === 0
          ? { ...general, alive: false, health: 0, respawnAtTick: asTickNumber(10_000) }
          : general,
      ),
    };

    const after = step(dead, [build(0, cell, StructureKind.Wall)]);

    expect(after.structures.some((s) => s.cell === cell)).toBe(false);
  });

  it('награда за убийство чужого генерала — двадцать базовых стоимостей', () => {
    expect(GENERAL_KILL_REWARD).toBe(UNIT_STATS[UnitType.Assault].cost * 20);
  });
});

describe('победа', () => {
  const withoutBase = (world: WorldState, owner: PlayerId): WorldState => ({
    ...world,
    structures: world.structures.filter(
      (s) => !(s.owner === owner && s.kind === StructureKind.Base),
    ),
  });

  it('разрушение базы завершает матч', () => {
    const after = step(withoutBase(createWorld(SEED), asPlayerId(1)), []);

    expect(after.winner).toBe(asPlayerId(0));
  });

  it('после победы мир замирает', () => {
    const won = step(withoutBase(richWorld(), asPlayerId(1)), []);
    const energyAtWin = won.players[0]?.energy ?? 0;

    const later = run(won, 100, [train(0, UnitType.Assault)]);

    expect(later.winner).toBe(asPlayerId(0));
    expect(later.players[0]?.energy).toBe(energyAtWin);
    expect(later.units).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Постройка и юниты в клетке
// ─────────────────────────────────────────────────────────────────────────

/** Мир с юнитом, поставленным в заданную клетку. */
const withUnitAt = (
  world: WorldState,
  owner: number,
  cell: number,
  health = 100,
  id = 900,
): WorldState => ({
  ...world,
  units: [
    ...world.units,
    {
      id: asEntityId(id),
      owner: asPlayerId(owner),
      unitType: UnitType.Assault,
      position: cellCentre(cell),
      health,
      readyAtTick: asTickNumber(0),
    },
  ],
});

describe('постройка в клетке с юнитом', () => {
  it('своя башня не встаёт на своего юнита', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const before = world.players[0]?.energy ?? 0;

    const after = step(withUnitAt(world, 0, cell), [build(0, cell, StructureKind.TowerBasic)]);

    expect(after.structures.some((s) => s.cell === cell)).toBe(false);
    expect(after.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK);
  });

  it('башня не встаёт на вражеского юнита', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);
    const before = world.players[0]?.energy ?? 0;

    const after = step(withUnitAt(world, 1, cell), [build(0, cell, StructureKind.TowerBasic)]);

    expect(after.structures.some((s) => s.cell === cell)).toBe(false);
    expect(after.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK);
  });

  it('в пустой клетке постройка появляется', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);

    const after = step(world, [build(0, cell, StructureKind.TowerBasic)]);

    expect(after.structures.some((s) => s.cell === cell)).toBe(true);
  });

  it('генерал не замуровывает сам себя', () => {
    const world = richWorld();
    const general = world.generals[0];
    const under = cellAt(general?.position ?? { x: 0, y: 0 });
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [build(0, under, StructureKind.TowerBasic)]);

    expect(after.structures.some((s) => s.cell === under)).toBe(false);
    expect(after.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK);
  });

  it('внутри постройки не остаётся живых', () => {
    const world = richWorld();
    const cell = nearBaseCell(world, 0);

    const after = step(withUnitAt(world, 1, cell), [build(0, cell, StructureKind.TowerBasic)]);

    const occupied = new Set(after.structures.map((structure) => structure.cell));
    for (const unit of after.units) {
      expect(occupied.has(cellAt(unit.position))).toBe(false);
    }
    for (const general of after.generals) {
      if (!general.alive) continue;
      expect(occupied.has(cellAt(general.position))).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Остановка юнита на противнике
// ─────────────────────────────────────────────────────────────────────────

/**
 * Мир с ровной картой без единой скалы.
 *
 * Положения юнитов в тестах ниже заданы числами, а генерация может
 * положить скалу куда угодно. Базы остаются на своих местах, поэтому
 * навигация продолжает работать.
 */
const openWorld = (): WorldState => {
  const world = richWorld();
  return {
    ...world,
    map: { cells: new Uint8Array(MAP_CELL_COUNT), baseCells: world.map.baseCells },
  };
};

const wallAt = (cell: number, owner: number, id: number) => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  kind: StructureKind.Wall,
  cell,
  health: 10_000,
  growthPpm: 1_000_000,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
  facing: DIRECTION_SOUTH,
});

describe('остановка юнита на противнике', () => {
  const MINE = cellIndex(20, 20);
  const THEIRS = cellIndex(20, 22);

  /** Здоровья с запасом: тест про движение, а не про то, кто кого убьёт. */
  const TOUGH = 1_000_000;

  /**
   * Мир, где обе стороны дерутся, а не прорываются.
   *
   * Режим по умолчанию — «Прорыв», и в нём остановки на встречном нет
   * вовсе. Эти тесты проверяют именно «Бой», поэтому режим ставится явно:
   * иначе они проверяли бы отсутствие правила, а не правило.
   */
  const engaging = (world: WorldState): WorldState => ({
    ...world,
    players: world.players.map((player) => ({ ...player, stance: AttackStance.Engage })),
  });
  it('в режиме «Бой» встречный противник останавливает', () => {
    const world = engaging(
      withUnitAt(withUnitAt(openWorld(), 0, MINE, TOUGH, 900), 1, THEIRS, TOUGH, 901),
    );

    const after = run(world, 4);
    const mine = after.units.find((unit) => unit.id === asEntityId(900));

    expect(mine?.position).toEqual(cellCentre(MINE));
  });

  it('в режиме «Прорыв» встречный противник не останавливает', () => {
    // Главное свойство режима: волна идёт к цели, ведя огонь на ходу,
    // и не вязнет в первом же заслоне.
    const world = withUnitAt(withUnitAt(openWorld(), 0, MINE, TOUGH, 900), 1, THEIRS, TOUGH, 901);

    const after = run(world, 4);
    const mine = after.units.find((unit) => unit.id === asEntityId(900));

    expect(mine?.position).not.toEqual(cellCentre(MINE));
  });

  it('в одиночестве тот же юнит идёт вперёд', () => {
    const after = run(withUnitAt(openWorld(), 0, MINE, TOUGH, 900), 4);
    const mine = after.units.find((unit) => unit.id === asEntityId(900));

    expect(mine?.position).not.toEqual(cellCentre(MINE));
  });

  it('противник за стеной не останавливает даже в «Бою»', () => {
    const world = engaging(
      withUnitAt(withUnitAt(openWorld(), 0, MINE, TOUGH, 900), 1, THEIRS, TOUGH, 901),
    );
    const walled: WorldState = {
      ...world,
      structures: [...world.structures, wallAt(cellIndex(20, 21), 1, 902)],
    };

    const after = run(walled, 4);
    const mine = after.units.find((unit) => unit.id === asEntityId(900));

    expect(mine?.position).not.toEqual(cellCentre(MINE));
  });
});
