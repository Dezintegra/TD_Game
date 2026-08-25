import { describe, expect, it } from 'vitest';
import {
  ATTACK_STANCES,
  ATTACK_STANCE_LABEL,
  AttackStance,
  BASE_BUILD_EXCLUSION,
  BASE_INCOME_PER_TICK,
  BASE_INSET_CELLS,
  BUILDABLE_KINDS,
  CommandKind,
  DIRECTION_SOUTH,
  GENERAL_KILL_REWARD,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  NUKE_COOLDOWN_MAX_LEVEL,
  NUKE_COOLDOWN_MIN_TICKS,
  NUKE_COOLDOWN_TICKS,
  NUKE_COST,
  NUKE_DAMAGE,
  NUKE_DELAY_TICKS,
  NUKE_RADIUS,
  PRODUCTION_QUEUE_CAP,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
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
  nukeBaseExclusion,
  upgradeBranchIndex,
} from '@td/shared';
import type { Command, PlayerId, Vec2 } from '@td/shared';
import { createWorld } from './world.js';
import type { PlayerState, StructureState, WorldState } from './world.js';
import { step } from './step.js';
import { checksum } from './checksum.js';
import { cellAt, cellCentre, cellIndex, cellX, squaredDistanceToFootprint } from './map.js';
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
    const branch = UPGRADE_BRANCHES.findIndex((entry) => entry.target === UpgradeTarget.Base);
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
        kills: 0,
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

    expect(after.units[UnitType.Sniper].range).toBeGreaterThan(before.units[UnitType.Sniper].range);
    // У штурмовика ветки нет, и множитель для него остаётся единичным.
    expect(after.units[UnitType.Assault].range).toBe(before.units[UnitType.Assault].range);
    // Ветки разных типов независимы: покупка у снайпера Теслу
    // не трогает.
    expect(after.units[UnitType.Tesla].range).toBe(before.units[UnitType.Tesla].range);
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
    expect(target?.demolishAtTick).toBe(
      started.tick + STRUCTURE_STATS[StructureKind.Wall].buildTicks,
    );

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
          kills: 0,
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

    const after = step(poor, [train(0, UnitType.Tesla)]);

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

  /**
   * Мир с записью об ударе, готовой сработать на следующем тике.
   *
   * Запись кладётся прямо в состояние, а не добывается командой пуска,
   * и это не обход правил, а единственный способ проверить сам взрыв.
   * Через команду пришлось бы ждать три секунды, а за три секунды машины
   * уходят с места: при радиусе в четыре клетки тест мерил бы скорость
   * хода, а не урон. Прежде это сходило с рук — радиус был в десять
   * клеток, и уйти из круга за три секунды машина не успевала.
   */
  const armed = (
    world: WorldState,
    cell: number,
    damage = NUKE_DAMAGE,
    radius = NUKE_RADIUS,
  ): WorldState => ({
    ...world,
    nukes: [
      {
        id: asEntityId(900),
        owner: asPlayerId(0),
        cell,
        detonateAtTick: asTickNumber(world.tick + 1),
        radius,
        damage,
      },
    ],
  });

  /** Машины заданного вида в самом эпицентре, по одной на каждого владельца. */
  const crowd = (world: WorldState, cell: number, type: UnitType, owners: number[]): WorldState => {
    const epicentre = cellCentre(cell);

    return {
      ...world,
      units: owners.map((owner, index) => ({
        id: asEntityId(100 + index),
        owner: asPlayerId(owner),
        unitType: type,
        position: { x: epicentre.x, y: epicentre.y },
        health: UNIT_STATS[type].health,
        facing: 1,
        readyAtTick: asTickNumber(0),
        kills: 0,
      })),
    };
  };

  it('создаёт запись об ударе и списывает энергию', () => {
    const world = richWorld();
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [nuke(0, CENTRE)]);

    expect(after.nukes).toHaveLength(1);
    expect(after.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK - NUKE_COST);
  });

  it('первый удар в матче откатом не задержан', () => {
    // Откат разделяет ПУСКИ, а не отделяет первый пуск от начала матча.
    // Проверяется на нетронутом мире: тик готовности там нулевой.
    expect(step(richWorld(), [nuke(0, CENTRE)]).nukes).toHaveLength(1);
  });

  it('второй удар подряд отклонён, и энергия за него не списана', () => {
    const first = step(richWorld(), [nuke(0, CENTRE)]);
    const before = first.players[0]?.energy ?? 0;

    const second = step(first, [nuke(0, CENTRE)]);

    // Записей об ударе по-прежнему одна — та, первая.
    expect(second.nukes).toHaveLength(1);
    expect(second.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK);
  });

  it('через минуту установка снова готова', () => {
    const first = step(richWorld(), [nuke(0, CENTRE)]);
    const cooled = run(first, NUKE_COOLDOWN_TICKS);

    expect(step(cooled, [nuke(0, CENTRE)]).nukes.length).toBeGreaterThan(0);
  });

  it('откат считается от пуска, а не от взрыва', () => {
    // Задержка в три секунды — свойство летящей ракеты, откат —
    // свойство установки. Сложить их значило бы наказать дважды
    // за одно, и следующий удар пришлось бы ждать шестьдесят три
    // секунды вместо шестидесяти.
    const first = step(richWorld(), [nuke(0, CENTRE)]);

    expect(first.players[0]?.nukeReadyAtTick).toBe(first.tick + NUKE_COOLDOWN_TICKS);
  });

  it('откат не достаётся противнику', () => {
    const first = step(richWorld(), [nuke(0, CENTRE)]);

    expect(step(first, [nuke(1, CENTRE)]).nukes).toHaveLength(2);
  });

  it('тик готовности входит в контрольную сумму', () => {
    // Величина меняет исход команд — пуск либо состоится, либо будет
    // отклонён. Не войди она в сумму, расхождение клиента с сервером
    // обнаружилось бы не сверкой, а через минуту по разошедшимся мирам.
    const world = richWorld();
    const armedLater = patchPlayer(world, 0, { nukeReadyAtTick: asTickNumber(500) });

    expect(checksum(armedLater)).not.toBe(checksum(world));
  });

  it('запись об ударе несёт мощность и радиус момента пуска', () => {
    const after = step(richWorld(), [nuke(0, CENTRE)]);

    expect(after.nukes[0]?.damage).toBe(NUKE_DAMAGE);
    expect(after.nukes[0]?.radius).toBe(NUKE_RADIUS);
  });

  it('взрывается по истечении задержки', () => {
    const after = run(richWorld(), NUKE_DELAY_TICKS + 2, [nuke(0, CENTRE)]);

    expect(after.nukes).toHaveLength(0);
  });

  it('слабые машины обеих сторон гибнут', () => {
    const world = crowd(richWorld(), CENTRE, UnitType.Assault, [0, 1]);

    expect(step(armed(world, CENTRE), []).units).toHaveLength(0);
  });

  it('крепкая машина выживает, потеряв ровно мощность заряда', () => {
    // Тесла прочнее заряда — в этом и весь смысл перехода от стирания
    // к урону: пережившего добивают обычным оружием.
    const world = crowd(richWorld(), CENTRE, UnitType.Tesla, [1]);

    const after = step(armed(world, CENTRE), []);

    expect(after.units).toHaveLength(1);
    expect(after.units[0]?.health).toBe(UNIT_STATS[UnitType.Tesla].health - NUKE_DAMAGE);
  });

  it('мощность берётся из записи, а не из баланса', () => {
    const world = crowd(richWorld(), CENTRE, UnitType.Tesla, [1]);
    const strong = UNIT_STATS[UnitType.Tesla].health + 1;

    expect(step(armed(world, CENTRE, strong), []).units).toHaveLength(0);
  });

  it('вне радиуса урона нет', () => {
    const world = richWorld();
    const epicentre = cellCentre(CENTRE);
    const away: WorldState = {
      ...world,
      units: [
        {
          id: asEntityId(100),
          owner: asPlayerId(1),
          unitType: UnitType.Assault,
          position: { x: epicentre.x + cellsToUnits(6), y: epicentre.y },
          health: UNIT_STATS[UnitType.Assault].health,
          facing: 1,
          readyAtTick: asTickNumber(0),
          kills: 0,
        },
      ],
    };

    const after = step(armed(away, CENTRE), []);

    expect(after.units).toHaveLength(1);
    expect(after.units[0]?.health).toBe(UNIT_STATS[UnitType.Assault].health);
  });

  it('база урона не получает даже под самым взрывом', () => {
    // Наведение в базу отклоняется, и потому эта проверка — второй замок,
    // а не первый. Замок нужен: запретная зона считается от ЦЕНТРА базы,
    // а основание у неё три на три, и держаться правило «база неуязвима»
    // обязано само по себе, а не совпадением расстояний.
    const world = richWorld();
    const base = baseCellOf(world, 1);
    const before = world.structures.find((entry) => entry.cell === base)?.health ?? 0;

    const after = step(armed(world, base), []);

    expect(after.structures.find((entry) => entry.cell === base)?.health).toBe(before);
  });

  it('убитые ударом рангов никому не приносят', () => {
    // У взрыва нет стрелка: он идёт мимо `dealDamage`, а значит,
    // и мимо награды. Правило записано тестом, потому что соблазн
    // «раздать ранги за ядерку тому, кто её запустил» возникнет снова.
    const world = crowd(richWorld(), CENTRE, UnitType.Assault, [0, 1, 0, 1]);

    const after = step(armed(world, CENTRE), []);

    expect(after.units).toHaveLength(0);
    expect(after.structures.every((entry) => entry.kills === 0)).toBe(true);
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

describe('прокачка ядерного удара', () => {
  const damageBranch = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeDamage);
  const radiusBranch = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeRadius);
  const cooldownBranch = upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeCooldown);

  /** Та же середина карты, что и в описании выше: вне запретных зон обеих баз. */
  const CENTRE = cellIndex(MAP_WIDTH_CELLS / 2, MAP_HEIGHT_CELLS / 2);

  /** Мир, в котором игрок 0 купил заданное число уровней одной ветки. */
  const levelled = (branch: number, levels: number): WorldState => {
    let world = richWorld();
    for (let level = 0; level < levels; level += 1) {
      world = step(world, [buy(0, branch)]);
    }
    return world;
  };

  it('ветки существуют и принадлежат базе', () => {
    expect(damageBranch).toBeGreaterThanOrEqual(0);
    expect(radiusBranch).toBeGreaterThanOrEqual(0);
    expect(cooldownBranch).toBeGreaterThanOrEqual(0);
  });

  it('уровень мощности усиливает заряд, не трогая радиус', () => {
    const world = levelled(damageBranch, 1);
    const nuclear = playerStats(world.players[0] as PlayerState).nuke;

    expect(nuclear.damage).toBeGreaterThan(NUKE_DAMAGE);
    expect(nuclear.radius).toBe(NUKE_RADIUS);
  });

  it('уровень радиуса расширяет круг вдесятеро сильнее, чем удорожает пуск', () => {
    const world = levelled(radiusBranch, 1);
    const nuclear = playerStats(world.players[0] as PlayerState).nuke;

    expect(nuclear.radius).toBeGreaterThan(NUKE_RADIUS);
    expect(nuclear.damage).toBe(NUKE_DAMAGE);

    // Прежде цена росла квадратом радиуса — сорок четыре процента
    // за уровень, — и ветку не покупали вовсе. Теперь пять процентов,
    // и прокачка окупается. Это и есть суть правки, поэтому число
    // проверяется, а не подразумевается.
    expect(nuclear.cost / NUKE_COST).toBeCloseTo(1.05, 2);
  });

  it('уровень мощности удорожает пуск вдвое против уровня радиуса', () => {
    const damaged = playerStats(levelled(damageBranch, 1).players[0] as PlayerState).nuke;
    const widened = playerStats(levelled(radiusBranch, 1).players[0] as PlayerState).nuke;

    expect(damaged.cost / NUKE_COST).toBeCloseTo(1.1, 2);
    expect(damaged.cost).toBeGreaterThan(widened.cost);
  });

  it('уровень отката снимает десять секунд, три уровня доводят до предела', () => {
    const nuclearAt = (levels: number): number =>
      playerStats(levelled(cooldownBranch, levels).players[0] as PlayerState).nuke.cooldownTicks;

    expect(nuclearAt(0)).toBe(NUKE_COOLDOWN_TICKS);
    expect(nuclearAt(1)).toBe(NUKE_COOLDOWN_TICKS - TICKS_PER_SECOND * 10);
    expect(nuclearAt(3)).toBe(NUKE_COOLDOWN_MIN_TICKS);
  });

  it('прокачанный откат и правда учащает удары', () => {
    // Уровень мог бы покупаться, считаться и не доезжать до пуска —
    // ровно так ветка «продаётся и не работает». Проверяется поэтому
    // не характеристика, а сам второй удар.
    const world = levelled(cooldownBranch, 3);
    const first = step(world, [nuke(0, CENTRE)]);
    const cooled = run(first, NUKE_COOLDOWN_MIN_TICKS);

    expect(step(cooled, [nuke(0, CENTRE)]).nukes.length).toBeGreaterThan(0);
  });

  it('откат цену пуска не двигает', () => {
    const world = levelled(cooldownBranch, 3);

    expect(playerStats(world.players[0] as PlayerState).nuke.cost).toBe(NUKE_COST);
  });

  it('четвёртый уровень отката не покупается', () => {
    const world = levelled(cooldownBranch, 3);
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, [buy(0, cooldownBranch)]);

    expect(after.players[0]?.upgrades[cooldownBranch]?.level).toBe(NUKE_COOLDOWN_MAX_LEVEL);
    expect(after.players[0]?.energy).toBe(before + BASE_INCOME_PER_TICK);
  });

  it('прокачка не достаётся противнику', () => {
    const world = levelled(damageBranch, 3);

    expect(playerStats(world.players[1] as PlayerState).nuke.damage).toBe(NUKE_DAMAGE);
  });

  it('прокачанный радиус расширяет запретную зону', () => {
    // Размен, оплаченный вместе с радиусом: круг шире, а бить у баз
    // больше нельзя. Клетка выбирается ровно на прежней границе.
    const world = richWorld();
    const base = cellCentre(baseCellOf(world, 1));

    const allowed = world.map.cells.findIndex((_, cell) => {
      const distance = distanceSquared(cellCentre(cell), base);
      return (
        distance > nukeBaseExclusion(NUKE_RADIUS) ** 2 &&
        distance < nukeBaseExclusion(NUKE_RADIUS * 2) ** 2
      );
    });

    expect(step(world, [nuke(0, allowed)]).nukes).toHaveLength(1);

    const wide = levelled(radiusBranch, 8);
    expect(playerStats(wide.players[0] as PlayerState).nuke.radius).toBeGreaterThan(
      NUKE_RADIUS * 2,
    );
    expect(step(wide, [nuke(0, allowed)]).nukes).toHaveLength(0);
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
  unitType: UnitType = UnitType.Assault,
): WorldState => ({
  ...world,
  units: [
    ...world.units,
    {
      id: asEntityId(id),
      owner: asPlayerId(owner),
      unitType,
      position: cellCentre(cell),
      health,
      readyAtTick: asTickNumber(0),
      kills: 0,
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
  kills: 0,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
  facing: DIRECTION_SOUTH,
});

/**
 * Постройка на том же месте и с теми же сроками, но стреляющая.
 *
 * Собрана из стены заменой вида: тесты ниже сравнивают именно
 * «стреляет — не стреляет», и любое второе различие между двумя
 * расстановками сделало бы сравнение недоказательным.
 */
const towerAt = (
  cell: number,
  owner: number,
  id: number,
  kind: StructureKind = StructureKind.TowerBasic,
  health = 10_000,
) => ({ ...wallAt(cell, owner, id), kind, health });

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

// ─────────────────────────────────────────────────────────────────────────
// Огонь на ходу
// ─────────────────────────────────────────────────────────────────────────

/**
 * Движущийся юнит стреляет.
 *
 * Механика не новая: стрельба решается отдельно от движения и от него
 * не зависит вовсе. Но заявлена она нигде не была, и до режимов атаки это
 * ничего не стоило — встретивший противника юнит всё равно вставал.
 * С «Прорывом» по умолчанию огонь на ходу стал обычным делом, и первая же
 * правка движения сломала бы его молча.
 *
 * Поэтому тесты раздела зелены и на нынешнем коде. Так и задумано: они
 * защищают, а не чинят.
 */
describe('огонь на ходу', () => {
  const MINE = cellIndex(20, 20);
  /** Ровно две клетки — дальность штурмовика, то есть впритык. */
  const THEIRS = cellIndex(20, 22);

  /** Здоровья с запасом: тесты про выстрелы, а не про то, кто кого убьёт. */
  const TOUGH = 1_000_000;

  const ASSAULT = UNIT_STATS[UnitType.Assault];

  const unitOf = (world: WorldState, id: number) =>
    world.units.find((unit) => unit.id === asEntityId(id));

  /** Мой юнит и чужой в двух клетках от него. Режим у обоих — «Прорыв». */
  const facingEachOther = (): WorldState =>
    withUnitAt(withUnitAt(openWorld(), 0, MINE, TOUGH, 900), 1, THEIRS, TOUGH, 901);

  /** Обе стороны в «Бою»: оба юнита сцепляются и стоят. */
  const bothEngage = (world: WorldState): WorldState => ({
    ...world,
    players: world.players.map((player) => ({ ...player, stance: AttackStance.Engage })),
  });

  /**
   * В «Бою» только соперник: мой юнит идёт, чужой стои́т.
   *
   * Стоящая мишень нужна затем, чтобы отрезок сравнения был честным:
   * уйди она сама, число выстрелов различалось бы из-за её перемещения,
   * а не из-за моего.
   */
  const enemyEngages = (world: WorldState): WorldState =>
    patchPlayer(world, 1, { stance: AttackStance.Engage });

  /**
   * Окно ровно на два выстрела: первый на первом тике, второй — как только
   * истечёт перезарядка. Выражено через перезарядку, а не числом: правка
   * скорострельности не должна молча превращать окно в один выстрел.
   */
  const TWO_SHOTS = ASSAULT.cooldownTicks + 1;

  /** Куда пришёл мой юнит за окно и сколько урона он успел нанести. */
  const outcome = (world: WorldState): { position: Vec2 | undefined; damage: number } => {
    const after = run(world, TWO_SHOTS);
    return {
      position: unitOf(after, 900)?.position,
      damage: TOUGH - (unitOf(after, 901)?.health ?? 0),
    };
  };

  it('юнит стреляет и смещается за один и тот же тик', () => {
    const after = step(facingEachOther(), []);

    // Урон проверяется точным числом, а не «меньше прежнего»: так видно,
    // что выстрел был ровно один и полной силы, а не что кто-то кого-то
    // задел по дороге.
    expect(unitOf(after, 900)?.position).not.toEqual(cellCentre(MINE));
    expect(unitOf(after, 901)?.health).toBe(TOUGH - ASSAULT.attack);
  });

  it('число выстрелов не зависит от того, идёт юнит или стоит', () => {
    const standing = outcome(bothEngage(facingEachOther()));
    const moving = outcome(enemyEngages(facingEachOther()));

    // Контроль: миры и правда различаются тем, ради чего заведены, —
    // один юнит стои́т, другой идёт. Без него тест сравнивал бы две
    // одинаковые расстановки и проходил бы всегда.
    expect(standing.position).toEqual(cellCentre(MINE));
    expect(moving.position).not.toEqual(cellCentre(MINE));

    expect(standing.damage / ASSAULT.attack).toBe(2);
    expect(moving.damage / ASSAULT.attack).toBe(2);
  });

  it('урон на ходу равен урону с места', () => {
    expect(outcome(enemyEngages(facingEachOther())).damage).toBe(
      outcome(bothEngage(facingEachOther())).damage,
    );
  });

  it('встречные колонны расходятся, обменявшись огнём', () => {
    // Ситуация, которую замысел прежде объявлял ошибкой, а теперь считает
    // штатной: две колонны прошли друг мимо друга, каждая понесла потери,
    // и ни одна не встала. Отсутствием события было бы, если бы они
    // не стреляли.
    //
    // Дороги параллельны и разведены на полторы клетки: колонны всю
    // дорогу остаются в радиусе друг у друга, но бортами не задевают,
    // и расталкивание в исход не вмешивается.
    const AHEAD = cellIndex(21, 20);
    const ONCOMING = cellIndex(21, 22);

    let world = withUnitAt(withUnitAt(openWorld(), 0, AHEAD, TOUGH, 900), 1, ONCOMING, TOUGH, 901);
    const apartAtStart = distanceSquared(cellCentre(AHEAD), cellCentre(ONCOMING));

    for (let tick = 0; tick < TWO_SHOTS; tick += 1) {
      const before = world;
      world = step(world, []);

      // Остановка — это несдвинувшийся за тик юнит, и ловить её надо
      // каждый тик. Проверка одного лишь итога пропустила бы юнита,
      // простоявшего половину отрезка: дойти он всё равно успел бы.
      expect(unitOf(world, 900)?.position).not.toEqual(unitOf(before, 900)?.position);
      expect(unitOf(world, 901)?.position).not.toEqual(unitOf(before, 901)?.position);
    }

    // Обменялись именно огнём, а не поводом: по выстрелу с каждой стороны
    // и оба полной силы.
    expect(unitOf(world, 900)?.health).toBe(TOUGH - ASSAULT.attack);
    expect(unitOf(world, 901)?.health).toBe(TOUGH - ASSAULT.attack);

    const mine = unitOf(world, 900)?.position ?? cellCentre(AHEAD);
    const theirs = unitOf(world, 901)?.position ?? cellCentre(ONCOMING);
    expect(distanceSquared(mine, theirs)).toBeGreaterThan(apartAtStart);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Остановка юнита на стреляющей постройке
// ─────────────────────────────────────────────────────────────────────────

/**
 * Войско снимает башни, а не проходит их строй насквозь.
 *
 * До этого правила остановка была только на живых, и войско, нацеленное
 * на базу, шло сквозь строй башен под их огнём. Расплата двойная: и потери,
 * и бесплатное усиление обороны — башня получает прибавку к силе за каждое
 * убийство.
 *
 * Стена по-прежнему не останавливает, и это не забытый случай, а граница
 * правила: стена не стреляет, и сносить её просто так нечего ради.
 */
describe('остановка юнита на стреляющей постройке', () => {
  const MINE = cellIndex(20, 20);
  /** Ровно две клетки — дальность штурмовика, то есть впритык. */
  const THEIRS = cellIndex(20, 22);

  const TOUGH = 1_000_000;

  const engaging = (world: WorldState): WorldState => ({
    ...world,
    players: world.players.map((player) => ({ ...player, stance: AttackStance.Engage })),
  });

  /** Мир с одним моим юнитом и одной чужой постройкой. */
  const facing = (
    structure: ReturnType<typeof wallAt>,
    stance: (world: WorldState) => WorldState = engaging,
    unitType: UnitType = UnitType.Assault,
  ): WorldState => {
    const world = stance(withUnitAt(openWorld(), 0, MINE, TOUGH, 900, unitType));
    return { ...world, structures: [...world.structures, structure] };
  };

  const positionAfter = (world: WorldState, ticks: number) =>
    run(world, ticks).units.find((unit) => unit.id === asEntityId(900))?.position;

  it('в режиме «Бой» вражеская башня останавливает', () => {
    expect(positionAfter(facing(towerAt(THEIRS, 1, 902)), 4)).toEqual(cellCentre(MINE));
  });

  it('стена на том же месте не останавливает', () => {
    // Разница между этим тестом и предыдущим — ровно один признак:
    // стреляет постройка или нет.
    expect(positionAfter(facing(wallAt(THEIRS, 1, 902)), 4)).not.toEqual(cellCentre(MINE));
  });

  it('в режиме «Прорыв» башня не останавливает', () => {
    const asIs = (world: WorldState): WorldState => world;

    expect(positionAfter(facing(towerAt(THEIRS, 1, 902), asIs), 4)).not.toEqual(cellCentre(MINE));
  });

  it('после разрушения башни движение возобновляется', () => {
    // Прочности ровно на один выстрел штурмовика. На первом тике юнит
    // стоит и стреляет, дальше идти уже некуда — башни нет.
    const world = facing(towerAt(THEIRS, 1, 902, StructureKind.TowerBasic, 10));
    const after = run(world, 6);

    expect(after.structures.some((entry) => entry.id === asEntityId(902))).toBe(false);
    expect(after.units.find((unit) => unit.id === asEntityId(900))?.position).not.toEqual(
      cellCentre(MINE),
    );
  });

  it('башня за стеной не останавливает пехоту, но останавливает Теслу', () => {
    // Пара, ради которой у Теслы отдельный столбец в линии огня: навесом
    // бьют по тому, что стоит, поэтому башню за стеной она достаёт —
    // а значит, и стоять ради неё обязана.
    const withWall = (world: WorldState): WorldState => ({
      ...world,
      structures: [...world.structures, wallAt(cellIndex(20, 21), 1, 903)],
    });

    const infantry = withWall(facing(towerAt(THEIRS, 1, 902)));
    const tesla = withWall(facing(towerAt(THEIRS, 1, 902), engaging, UnitType.Tesla));
    // Контроль: без башни за той же стеной Тесла идёт вперёд. Без него
    // тест не отличал бы остановку ради башни от остановки по любой
    // другой причине.
    const alone = withWall(facing(wallAt(THEIRS, 1, 902), engaging, UnitType.Tesla));

    expect(positionAfter(infantry, 4)).not.toEqual(cellCentre(MINE));
    expect(positionAfter(tesla, 4)).toEqual(cellCentre(MINE));
    expect(positionAfter(alone, 4)).not.toEqual(cellCentre(MINE));
  });

  it('башня вне радиуса юнита с маршрута его не сбивает', () => {
    // Снайперская башня достаёт на восемь клеток и стреляет по юниту,
    // а он до неё не дотягивается. Преследования в игре нет: юнит идёт
    // дальше, а не разворачивается на обидчика.
    const far = towerAt(cellIndex(20, 26), 1, 902, StructureKind.TowerSniper);

    expect(positionAfter(facing(far), 4)).not.toEqual(cellCentre(MINE));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Остановка у назначенной цели
// ─────────────────────────────────────────────────────────────────────────

/**
 * Тесла обстреливает назначенную цель, не входя в радиус башни.
 *
 * Это единственное, ради чего она существует: дальность у неё на клетку
 * больше дальности базовой башни, и остановка ровно на своей дальности
 * означает, что башню достаёт она, а башня её — нет.
 *
 * Режим на это не влияет и не должен. «Прорыв» отменяет остановку
 * на встречном — на живом противнике и на стреляющей постройке, — а не
 * на назначенной цели: дошедшему до цели идти больше некуда. Перебор
 * идёт по всем режимам списком, а не по двум названным: появится третий —
 * и он проверится сам, а не будет забыт.
 */
describe('остановка у назначенной цели', () => {
  const START = cellIndex(20, 20);
  /** Семь клеток — на клетку дальше, чем достаёт Тесла: ей есть куда идти. */
  const TARGET = cellIndex(20, 27);

  const TOUGH = 1_000_000;
  const TESLA = UNIT_STATS[UnitType.Tesla];
  const TOWER_RANGE = STRUCTURE_STATS[StructureKind.TowerBasic].range;

  /**
   * Тиков с запасом на лишнюю клетку подхода. Считается от скорости Теслы,
   * а не берётся числом: Тесла ходит втрое медленнее пехоты, и правка
   * её скорости не должна молча обрывать тест на полдороге.
   */
  const LONG_ENOUGH = 2 * Math.ceil(cellsToUnits(1) / TESLA.speed);

  /** Мир, где назначенная цель игрока — вражеская башня в семи клетках. */
  const aimedAtTower = (stance: AttackStance): WorldState => {
    const world = withUnitAt(openWorld(), 0, START, TOUGH, 900, UnitType.Tesla);
    return patchPlayer(
      { ...world, structures: [...world.structures, towerAt(TARGET, 1, 902)] },
      0,
      {
        targetStructure: asEntityId(902),
        stance,
      },
    );
  };

  const positionOf = (world: WorldState): Vec2 | undefined =>
    world.units.find((unit) => unit.id === asEntityId(900))?.position;

  for (const stance of ATTACK_STANCES) {
    it(`в режиме «${ATTACK_STANCE_LABEL[stance]}» Тесла встаёт вне радиуса башни`, () => {
      const arrived = run(aimedAtTower(stance), LONG_ENOUGH);
      const settled = positionOf(arrived);

      // Дошла: иначе «встала вне радиуса» означало бы всего лишь «стои́т
      // там, где её поставили», и тест проходил бы при сломанном движении.
      expect(settled).not.toEqual(cellCentre(START));
      // И встала: лишний тик её больше не сдвигает.
      expect(positionOf(step(arrived, []))).toEqual(settled);

      // Встала между двумя дальностями: своей достаёт, в чужую не вошла.
      // Верхняя граница здесь не украшение — без неё «дошла и встала»
      // было бы выполнено и юнитом, шагнувшим на единицу и залипшим.
      //
      // Меряется расстояние до ОСНОВАНИЯ, а не до центра клетки: ровно им
      // меряют и правило остановки, и наводка башни. По центру числа вышли
      // бы на полклетки больше, и обе границы поехали бы вместе с ними.
      const apart = squaredDistanceToFootprint(
        settled ?? cellCentre(START),
        TARGET,
        STRUCTURE_STATS[StructureKind.TowerBasic].footprintRadius,
      );
      expect(apart).toBeLessThanOrEqual(TESLA.range * TESLA.range);
      expect(apart).toBeGreaterThan(TOWER_RANGE * TOWER_RANGE);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Пролом перегородившей путь постройки
// ─────────────────────────────────────────────────────────────────────────

/**
 * Преграда останавливает юнита в любом режиме, и он её ломает.
 *
 * Это вторая из двух остановок, не зависящих от режима, и причина у неё
 * простая: не остановившийся у преграды юнит не сможет её сломать
 * и упрётся в неё навсегда. «Прорыв» отменяет остановку на ВСТРЕЧНОМ,
 * а перегородившая путь стена — не встречный, а дорога.
 *
 * Стена стои́т поперёк всей карты: пока существует обход, юнит идёт
 * в обход, каким бы длинным тот ни был, и пролом не включается вовсе.
 */
describe('пролом преграды в любом режиме', () => {
  const START = cellIndex(20, 20);
  const FENCE_X = 24;

  const TOUGH = 1_000_000;
  /** Прочность одной секции: с запасом, чтобы за отрезок её не снесли. */
  const PLANK = 10_000;

  /** Тиков с запасом на четыре клетки до стены. */
  const LONG_ENOUGH = 2 * Math.ceil(cellsToUnits(4) / UNIT_STATS[UnitType.Assault].speed);

  const fenced = (stance: AttackStance): WorldState => {
    const world = withUnitAt(openWorld(), 0, START, TOUGH, 900);
    const fence = Array.from({ length: MAP_HEIGHT_CELLS }, (_, y) => ({
      ...wallAt(cellIndex(FENCE_X, y), 1, 9000 + y),
      health: PLANK,
    }));

    return patchPlayer({ ...world, structures: [...world.structures, ...fence] }, 0, { stance });
  };

  const fenceHealth = (world: WorldState): number =>
    world.structures
      .filter((structure) => cellX(structure.cell) === FENCE_X)
      .reduce((sum, structure) => sum + structure.health, 0);

  const cellOfUnit = (world: WorldState): number =>
    cellAt(world.units.find((unit) => unit.id === asEntityId(900))?.position ?? cellCentre(START));

  for (const stance of ATTACK_STANCES) {
    it(`в режиме «${ATTACK_STANCE_LABEL[stance]}» юнит встаёт у стены и ломает её`, () => {
      const arrived = run(fenced(stance), LONG_ENOUGH);

      // Дошёл до стены и упёрся в неё, а не прошёл насквозь и не застрял
      // на полдороге.
      expect(cellX(cellOfUnit(arrived))).toBe(FENCE_X - 1);

      // Урон проверяется ПОСЛЕ остановки, а не за весь путь. Стена
      // попадает в радиус ещё на подходе, и юнит успевает задеть её
      // мимоходом; такой урон доказывал бы, что юнит стрелял, но ничего
      // не говорил бы о том, ломает ли он преграду, стоя перед ней.
      const standing = run(arrived, UNIT_STATS[UnitType.Assault].cooldownTicks + 1);

      expect(cellOfUnit(standing)).toBe(cellOfUnit(arrived));
      expect(fenceHealth(standing)).toBeLessThan(fenceHealth(arrived));
    });
  }
});

describe('расталкивание в связке с движением и боем', () => {
  /** Скальная гряда через всю карту с единственным проходом в клетку. */
  const GAP_X = 24;
  const WALL_Y = 24;

  const walledWorld = (): WorldState => {
    const world = openWorld();
    const cells = new Uint8Array(MAP_CELL_COUNT);

    for (let x = 0; x < MAP_WIDTH_CELLS; x += 1) {
      if (x === GAP_X) continue;
      cells[cellIndex(x, WALL_Y)] = Terrain.Rock;
    }

    return { ...world, map: { cells, baseCells: world.map.baseCells } };
  };

  const stacked = (count: number, at: { x: number; y: number }): WorldState => ({
    ...walledWorld(),
    units: Array.from({ length: count }, (_unused, index) => ({
      id: asEntityId(700 + index),
      owner: asPlayerId(0),
      unitType: UnitType.Assault,
      position: { ...at },
      health: 1_000_000,
      facing: DIRECTION_SOUTH,
      readyAtTick: asTickNumber(0),
    })),
  });

  const CROWD = 40;
  const START = cellCentre(cellIndex(GAP_X, WALL_Y - 4));

  it('слипшаяся толпа протискивается сквозь проход шириной в клетку', () => {
    // Главная проверка мягкости правила. Жёсткий запрет на сближение
    // запер бы войско перед узким местом навсегда, и увидеть это можно
    // только на полном шаге: расталкивание, движение и занятость клеток
    // должны ужиться втроём.
    const after = run(stacked(CROWD, START), 900);
    const passed = after.units.filter((unit) => unit.position.y > (WALL_Y + 1) * 1000);

    expect(passed).toHaveLength(CROWD);
  });

  it('ни одна машина при этом не оказывается внутри скалы', () => {
    const after = run(stacked(CROWD, START), 900);
    const occupancy = buildOccupancy(after.map, after.structures);
    const inside = after.units.filter((unit) => occupancy.blocked[cellAt(unit.position)] === 1);

    expect(inside).toHaveLength(0);
  });

  it('установившаяся толпа не переминается на месте', () => {
    // Требование про затухание толчка. Без него хвост войска каждый тик
    // заново вдавливает передних друг в друга, и обложившая цель толпа
    // шевелится до конца матча — на поле это читается как муравейник,
    // а не как войско на позиции.
    // Место — у чужой базы, куда войско и приходит. Считается от размера
    // карты: вписанные числа были сняты на поле 48 × 48 и на поле 38 × 38
    // уехали за его край, а `cellIndex` за краем не ошибается, а молча
    // заворачивает на другую строку. Толпа тогда встаёт не там, где
    // задумано, и тест меряет что угодно, кроме затухания толчка.
    const spot = cellCentre(
      cellIndex(
        MAP_WIDTH_CELLS - 1 - BASE_INSET_CELLS,
        MAP_HEIGHT_CELLS - 1 - BASE_INSET_CELLS - 4,
      ),
    );
    const crowd = 40;

    let world: WorldState = {
      ...openWorld(),
      units: Array.from({ length: crowd }, (_unused, index) => ({
        id: asEntityId(700 + index),
        owner: asPlayerId(0),
        unitType: UnitType.Assault,
        position: { ...spot },
        health: 1_000_000,
        facing: DIRECTION_SOUTH,
        readyAtTick: asTickNumber(0),
      })),
    };

    // Даём войску дойти и разойтись.
    world = run(world, 300);

    const before = world.units.map((unit) => unit.position);
    let path = 0;

    for (let tick = 0; tick < 100; tick += 1) {
      const previous = world.units.map((unit) => unit.position);
      world = step(world, []);
      world.units.forEach((unit, index) => {
        const was = previous[index];
        if (was === undefined) return;
        path += Math.abs(unit.position.x - was.x) + Math.abs(unit.position.y - was.y);
      });
    }

    const perMachine = path / world.units.length;

    // Клетка за сто тиков — это чуть больше трёх секунд еле заметного
    // шевеления. Полный толчок без затухания давал вчетверо больше.
    expect(perMachine).toBeLessThan(1000);
    // И толпа при этом действительно стоит на месте, а не уползает.
    expect(before.length).toBe(world.units.length);
  });

  it('остановившаяся у цели машина стреляет в тот же тик, когда её сдвинуло', () => {
    // Толчок — это не движение. Машина, дошедшая до цели, остаётся
    // дошедшей: правило остановки продолжает действовать, стрельба тоже.
    const spot = cellCentre(
      cellIndex(
        MAP_WIDTH_CELLS - 1 - BASE_INSET_CELLS,
        MAP_HEIGHT_CELLS - 1 - BASE_INSET_CELLS - 3,
      ),
    );
    const world: WorldState = {
      ...openWorld(),
      units: [700, 701].map((id) => ({
        id: asEntityId(id),
        owner: asPlayerId(0),
        unitType: UnitType.Assault,
        position: { ...spot },
        health: 1_000_000,
        facing: DIRECTION_SOUTH,
        readyAtTick: asTickNumber(0),
      })),
    };

    const before = world.structures.find((entry) => entry.owner === asPlayerId(1));
    const after = step(world, []);
    const afterBase = after.structures.find((entry) => entry.owner === asPlayerId(1));

    // Сдвинуло — значит расталкивание сработало...
    expect(after.units[0]?.position).not.toEqual(spot);
    // ...и при этом выстрел по назначенной цели состоялся в том же тике.
    expect(afterBase?.health ?? 0).toBeLessThan(before?.health ?? 0);
  });
});
