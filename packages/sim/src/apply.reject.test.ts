import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  DIRECTION_SOUTH,
  MAP_CELL_COUNT,
  PRODUCTION_QUEUE_CAP,
  RejectReason,
  StructureKind,
  Terrain,
  UnitType,
  asPlayerId,
  asTickNumber,
  distanceSquared,
} from '@td/shared';
import type { Command, PlayerId } from '@td/shared';
import { createWorld } from './world.js';
import type { PlayerState, Rejection, WorldState } from './world.js';
import { step } from './step.js';
import { cellAt, cellCentre } from './map.js';
import { buildOccupancy } from './occupancy.js';
import { playerStats } from './stats.js';

/**
 * Отказы команд.
 *
 * Проверяется не то, что негодная команда не применилась — это и раньше
 * было так, — а то, что о ней СКАЗАНО и сказано именно то. Смысл в двух
 * вещах сразу: игрок получает отклик на неверное действие, а лог команд
 * перестаёт путать «приказал» с «приказал, и приказ выбросили».
 *
 * Главное здесь — различимость причин. Слитая причина бесполезна
 * одинаково и игроку (не понять, что делать), и разбору матча
 * (не сгруппировать). Поэтому почти каждый тест утверждает не просто
 * «отказано», а «отказано по этой причине и не по соседней».
 */

const SEED = 4242;

const HUMAN = 0;

const patchPlayer = (world: WorldState, id: number, patch: Partial<PlayerState>): WorldState => ({
  ...world,
  players: world.players.map((player, index) => (index === id ? { ...player, ...patch } : player)),
});

const withEnergy = (world: WorldState, energy: number): WorldState =>
  patchPlayer(world, HUMAN, { energy });

const rich = (world: WorldState = createWorld(SEED)): WorldState => withEnergy(world, 10_000_000);

const broke = (world: WorldState = createWorld(SEED)): WorldState => withEnergy(world, 0);

const killGeneralOf = (world: WorldState, owner: number): WorldState => ({
  ...world,
  generals: world.generals.map((general, index) =>
    index === owner ? { ...general, alive: false } : general,
  ),
});

/** Единственный отказ, случившийся на тике. */
const rejectionOf = (world: WorldState, command: Command): Rejection | undefined => {
  const next = step(world, [command]);
  expect(next.rejections.length).toBeLessThanOrEqual(1);
  return next.rejections[0];
};

const reasonOf = (world: WorldState, command: Command): RejectReason | undefined =>
  rejectionOf(world, command)?.reason;

const at = (player: number = HUMAN): { player: PlayerId; tick: ReturnType<typeof asTickNumber> } => ({
  player: asPlayerId(player),
  tick: asTickNumber(0),
});

const buildAt = (cell: number, structure = StructureKind.TowerBasic, player = HUMAN): Command => ({
  kind: CommandKind.Build,
  ...at(player),
  cell,
  structure,
});

// ─────────────────────────────────────────────────────────────────────────
// Поиск клеток с нужными свойствами
// ─────────────────────────────────────────────────────────────────────────

const livingCells = (world: WorldState): ReadonlySet<number> =>
  new Set([
    ...world.units.map((unit) => cellAt(unit.position)),
    ...world.generals.filter((general) => general.alive).map((general) => cellAt(general.position)),
  ]);

/** Клетка, годная под постройку по всему, кроме, возможно, радиуса. */
const buildableCells = (world: WorldState): readonly number[] => {
  const occupancy = buildOccupancy(world.map, world.structures);
  const living = livingCells(world);
  const cells: number[] = [];

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (world.map.cells[cell] !== Terrain.Ground) continue;
    if (occupancy.blocked[cell] === 1) continue;
    if (living.has(cell)) continue;

    cells.push(cell);
  }

  return cells;
};

const buildRadiusOf = (world: WorldState, owner: number): number => {
  const player = world.players[owner];
  if (player === undefined) throw new Error('игрока нет');
  return playerStats(player).general.buildRadius;
};

const generalPositionOf = (world: WorldState, owner: number) => {
  const general = world.generals[owner];
  if (general === undefined) throw new Error('генерала нет');
  return general.position;
};

/** Свободная клетка в радиусе строительства. */
const nearGeneral = (world: WorldState, owner = HUMAN): number => {
  const from = generalPositionOf(world, owner);
  const radius = buildRadiusOf(world, owner);

  const cell = buildableCells(world).find(
    (candidate) => distanceSquared(cellCentre(candidate), from) <= radius * radius,
  );

  if (cell === undefined) throw new Error('рядом с генералом некуда строить');
  return cell;
};

/** Свободная клетка заведомо дальше радиуса строительства. */
const farFromGeneral = (world: WorldState, owner = HUMAN): number => {
  const from = generalPositionOf(world, owner);
  const radius = buildRadiusOf(world, owner);

  const cell = buildableCells(world).find(
    (candidate) => distanceSquared(cellCentre(candidate), from) > radius * radius * 4,
  );

  if (cell === undefined) throw new Error('далёкой свободной клетки нет');
  return cell;
};

const rockCell = (world: WorldState): number => {
  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (world.map.cells[cell] === Terrain.Rock) return cell;
  }
  throw new Error('на карте нет скал');
};

const baseCellOf = (world: WorldState, owner: number): number => {
  const cell = world.map.baseCells[owner];
  if (cell === undefined) throw new Error('базы нет');
  return cell;
};

// ─────────────────────────────────────────────────────────────────────────

describe('отказ в постройке называет свою причину', () => {
  it('клетки с таким номером не существует', () => {
    expect(reasonOf(rich(), buildAt(-1))).toBe(RejectReason.InvalidCell);
    expect(reasonOf(rich(), buildAt(MAP_CELL_COUNT))).toBe(RejectReason.InvalidCell);
  });

  it('базу построить нельзя: её нет среди возводимых', () => {
    const world = rich();
    expect(reasonOf(world, buildAt(nearGeneral(world), StructureKind.Base))).toBe(
      RejectReason.InvalidArgument,
    );
  });

  it('клетка перекрыта скалой', () => {
    const world = rich();
    expect(reasonOf(world, buildAt(rockCell(world)))).toBe(RejectReason.CellBlocked);
  });

  it('клетка перекрыта постройкой', () => {
    const world = rich();
    expect(reasonOf(world, buildAt(baseCellOf(world, HUMAN)))).toBe(RejectReason.CellBlocked);
  });

  it('в клетке стоит живой — и это НЕ то же самое, что занятая клетка', () => {
    const world = rich();
    const under = cellAt(generalPositionOf(world, HUMAN));

    // Клетка под собственным генералом: он строит вокруг себя, поэтому
    // она первый кандидат по построению. Именно на ней противник
    // под управлением компьютера когда-то замуровывал сам себя.
    const reason = reasonOf(world, buildAt(under));

    expect(reason).toBe(RejectReason.CellOccupiedByLiving);
    expect(reason).not.toBe(RejectReason.CellBlocked);
  });

  it('генерал мёртв', () => {
    const world = killGeneralOf(rich(), HUMAN);
    expect(reasonOf(world, buildAt(farFromGeneral(world)))).toBe(RejectReason.GeneralDead);
  });

  it('вне радиуса строительства', () => {
    const world = rich();
    expect(reasonOf(world, buildAt(farFromGeneral(world)))).toBe(RejectReason.OutsideBuildRadius);
  });

  it('не хватает энергии', () => {
    const world = broke();
    expect(reasonOf(world, buildAt(nearGeneral(world)))).toBe(RejectReason.NotEnoughEnergy);
  });

  it('годная постройка следа не оставляет', () => {
    const world = rich();
    const next = step(world, [buildAt(nearGeneral(world))]);

    expect(next.rejections).toHaveLength(0);
    expect(next.structures.length).toBe(world.structures.length + 1);
  });
});

describe('отказ в производстве, прокачке, цели и ударе', () => {
  it('несуществующий тип юнита', () => {
    const command: Command = {
      kind: CommandKind.TrainUnit,
      ...at(),
      unitType: 99 as UnitType,
    };
    expect(reasonOf(rich(), command)).toBe(RejectReason.InvalidArgument);
  });

  it('очередь производства заполнена', () => {
    const world = patchPlayer(rich(), HUMAN, {
      queue: Array.from({ length: PRODUCTION_QUEUE_CAP }, () => UnitType.Assault),
    });
    const command: Command = { kind: CommandKind.TrainUnit, ...at(), unitType: UnitType.Assault };

    expect(reasonOf(world, command)).toBe(RejectReason.QueueFull);
  });

  it('на юнита не хватает энергии', () => {
    const command: Command = { kind: CommandKind.TrainUnit, ...at(), unitType: UnitType.Assault };
    expect(reasonOf(broke(), command)).toBe(RejectReason.NotEnoughEnergy);
  });

  it('ветки прокачки с таким номером нет', () => {
    const command: Command = { kind: CommandKind.BuyUpgrade, ...at(), branch: 999 };
    expect(reasonOf(rich(), command)).toBe(RejectReason.InvalidArgument);
  });

  it('на улучшение не хватает энергии', () => {
    const command: Command = { kind: CommandKind.BuyUpgrade, ...at(), branch: 0 };
    expect(reasonOf(broke(), command)).toBe(RejectReason.NotEnoughEnergy);
  });

  it('в клетке нет постройки, которую можно назначить целью', () => {
    const world = rich();
    const command: Command = { kind: CommandKind.SetTarget, ...at(), cell: nearGeneral(world) };

    expect(reasonOf(world, command)).toBe(RejectReason.InvalidTarget);
  });

  it('своя постройка целью быть не может', () => {
    const world = rich();
    const command: Command = {
      kind: CommandKind.SetTarget,
      ...at(),
      cell: baseCellOf(world, HUMAN),
    };

    expect(reasonOf(world, command)).toBe(RejectReason.InvalidTarget);
  });

  it('повторное назначение той же цели — успех, а не отказ', () => {
    // По умолчанию цель игрока — база противника. Щёлкнув по ней ещё раз,
    // игрок хочет ровно того, что уже есть, и ругаться на него не за что.
    const world = rich();
    const command: Command = {
      kind: CommandKind.SetTarget,
      ...at(),
      cell: baseCellOf(world, 1 - HUMAN),
    };

    expect(step(world, [command]).rejections).toHaveLength(0);
  });

  it('на ядерный удар не хватает энергии', () => {
    // Ноль, а не «цена минус единица»: доход начисляется в начале тика,
    // до применения команд, и почти полная казна за этот тик дорастает
    // до полной. На этом тест и попался в первой своей редакции.
    const world = broke();
    const command: Command = { kind: CommandKind.LaunchNuke, ...at(), cell: farFromGeneral(world) };

    expect(reasonOf(world, command)).toBe(RejectReason.NotEnoughEnergy);
  });

  it('удар в запретной зоне у базы', () => {
    const world = rich();
    const command: Command = {
      kind: CommandKind.LaunchNuke,
      ...at(),
      cell: baseCellOf(world, 1 - HUMAN),
    };

    expect(reasonOf(world, command)).toBe(RejectReason.NukeNearBase);
  });

  it('направление вне диапазона', () => {
    const command: Command = { kind: CommandKind.MoveGeneral, ...at(), direction: 99 };
    expect(reasonOf(rich(), command)).toBe(RejectReason.InvalidArgument);
  });

  it('двигать мёртвого генерала некуда', () => {
    const command: Command = { kind: CommandKind.MoveGeneral, ...at(), direction: DIRECTION_SOUTH };
    expect(reasonOf(killGeneralOf(rich(), HUMAN), command)).toBe(RejectReason.GeneralDead);
  });
});

describe('особые случаи', () => {
  it('после победы отказывают все команды', () => {
    const world: WorldState = { ...rich(), winner: asPlayerId(1) };
    const command: Command = { kind: CommandKind.MoveGeneral, ...at(), direction: DIRECTION_SOUTH };

    const next = step(world, [command]);

    expect(next.rejections[0]?.reason).toBe(RejectReason.MatchOver);
    // Мир при этом действительно замер: направление не изменилось.
    expect(next.generals[HUMAN]?.direction).toBe(world.generals[HUMAN]?.direction);
  });

  it('команде несуществующего игрока никто не отвечает', () => {
    // Адресата у сообщения нет. Приписать отказ кому-то другому значило бы
    // соврать в его логе, а завести отказ «ничей» — засорить список.
    const command: Command = { kind: CommandKind.MoveGeneral, ...at(7), direction: DIRECTION_SOUTH };

    expect(step(rich(), [command]).rejections).toHaveLength(0);
  });

  it('ядро не бросает исключений на заведомо мусорных командах', () => {
    const world = rich();
    const garbage: readonly Command[] = [
      buildAt(-100),
      buildAt(MAP_CELL_COUNT + 5),
      { kind: CommandKind.MoveGeneral, ...at(), direction: -3 },
      { kind: CommandKind.TrainUnit, ...at(), unitType: -1 as UnitType },
      { kind: CommandKind.SetTarget, ...at(), cell: Number.NaN },
      { kind: CommandKind.BuyUpgrade, ...at(), branch: -7 },
      { kind: CommandKind.LaunchNuke, ...at(), cell: 1.5 },
    ];

    const next = step(world, garbage);

    expect(next.rejections).toHaveLength(garbage.length);
    expect(next.winner).toBeNull();
  });

  it('на каждый вид команды есть достижимая причина отказа', () => {
    const world = broke();
    const kinds = [
      CommandKind.MoveGeneral,
      CommandKind.Build,
      CommandKind.TrainUnit,
      CommandKind.SetTarget,
      CommandKind.BuyUpgrade,
      CommandKind.LaunchNuke,
    ];

    const commands: readonly Command[] = [
      { kind: CommandKind.MoveGeneral, ...at(), direction: 99 },
      buildAt(-1),
      { kind: CommandKind.TrainUnit, ...at(), unitType: 99 as UnitType },
      { kind: CommandKind.SetTarget, ...at(), cell: -1 },
      { kind: CommandKind.BuyUpgrade, ...at(), branch: 999 },
      { kind: CommandKind.LaunchNuke, ...at(), cell: -1 },
    ];

    const reported = step(world, commands).rejections.map((rejection) => rejection.kind);

    expect(reported).toEqual(kinds);
  });
});

describe('отказы производны от входов', () => {
  it('пересчёт того же тика даёт те же отказы', () => {
    // Отказы лежат в состоянии тика, а не копятся снаружи. Поэтому
    // повторный просчёт того же тика после отката предсказания обязан
    // дать в точности тот же список — иначе игрок увидел бы один отказ
    // дважды.
    const world = broke();
    const commands: readonly Command[] = [
      buildAt(nearGeneral(world)),
      { kind: CommandKind.TrainUnit, ...at(), unitType: UnitType.Assault },
      { kind: CommandKind.BuyUpgrade, ...at(), branch: 0 },
    ];

    const first = step(world, commands).rejections;
    const second = step(world, commands).rejections;

    expect(first).toEqual(second);
    expect(first.length).toBe(commands.length);
  });

  it('отказы не переезжают в следующий тик', () => {
    const world = broke();
    const after = step(world, [buildAt(nearGeneral(world))]);

    expect(after.rejections).toHaveLength(1);
    expect(step(after, []).rejections).toHaveLength(0);
  });

  it('отказ достаётся тому, кто отдал команду', () => {
    const world = broke();
    const rejection = rejectionOf(world, buildAt(nearGeneral(world)));

    expect(rejection?.player).toBe(asPlayerId(HUMAN));
    expect(rejection?.kind).toBe(CommandKind.Build);
    expect(rejection?.index).toBe(0);
  });

  it('отказ указывает на конкретную команду пачки', () => {
    // Заказ пачки — это несколько отдельных команд. Без номера «часть
    // прошла, часть нет» превратилось бы в «несколько отказов неизвестно
    // на что»: все они одного вида, от одного игрока и с одной причиной.
    const world = rich();
    const cell = nearGeneral(world);
    const commands: readonly Command[] = [
      // Первая пройдёт и займёт клетку, остальные две упрутся в неё же.
      buildAt(cell),
      buildAt(cell),
      buildAt(cell),
    ];

    const rejections = step(world, commands).rejections;

    expect(rejections.map((rejection) => rejection.index)).toEqual([1, 2]);
  });
});
