import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  PPM_ONE,
  STRUCTURE_STATS,
  ShotWeapon,
  StructureKind,
  Terrain,
  UNIT_STATS,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
  compoundPpm,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { createWorld } from './world.js';
import type { GeneralState, StructureState, UnitState, WorldState } from './world.js';
import { step } from './step.js';
import { checksum } from './checksum.js';
import { cellCentre, cellIndex } from './map.js';

/**
 * Бой проверяется на подготовленных расстановках: мир создаётся обычным
 * способом, а затем в него точечно помещаются нужные сущности. Так тест
 * говорит ровно о правиле боя, а не о том, что успело нагенерироваться
 * на карте.
 */

const SEED = 909;

/** Клетка вдали от обеих баз: там ничто не помешает расстановке. */
const FIELD_X = MAP_WIDTH_CELLS / 2;
const FIELD_Y = MAP_HEIGHT_CELLS / 2;
const FIELD = cellIndex(FIELD_X, FIELD_Y);

const cellOffset = (dx: number, dy: number): number => cellIndex(FIELD_X + dx, FIELD_Y + dy);

const at = (dx: number, dy: number): { x: number; y: number } => {
  const centre = cellCentre(FIELD);
  return { x: centre.x + dx * 1000, y: centre.y + dy * 1000 };
};

const unit = (
  id: number,
  owner: number,
  unitType: UnitType,
  dx: number,
  dy: number,
  health: number,
): UnitState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  unitType,
  position: at(dx, dy),
  health,
  facing: DIRECTION_SOUTH,
  readyAtTick: asTickNumber(0),
});

const structure = (
  id: number,
  owner: number,
  kind: StructureKind,
  dx: number,
  dy: number,
  health: number,
): StructureState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  kind,
  cell: cellOffset(dx, dy),
  health,
  growthPpm: PPM_ONE,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
  facing: DIRECTION_SOUTH,
});

/**
 * Расстановка строится на карте без единой скалы.
 *
 * Расстояния здесь заданы числами, а генерация кладёт скалы куда угодно.
 * После появления линии огня случайная скала между стрелком и целью
 * отменяла бы выстрел, и тест ловил бы карту, а не правило боя. Скалы,
 * если они нужны, ставятся явно.
 */
const arrange = (
  extraStructures: readonly StructureState[],
  units: readonly UnitState[],
  generalAt?: { x: number; y: number },
  rocks: readonly number[] = [],
): WorldState => {
  const world = createWorld(SEED);

  const generals: GeneralState[] =
    generalAt === undefined
      ? world.generals
      : world.generals.map((general, index) =>
          index === 0 ? { ...general, position: generalAt } : general,
        );

  const cells = new Uint8Array(MAP_CELL_COUNT);
  for (const cell of rocks) cells[cell] = Terrain.Rock;

  return {
    ...world,
    map: { cells, baseCells: world.map.baseCells },
    structures: [...world.structures, ...extraStructures],
    units: [...units],
    generals,
  };
};

const structureById = (world: WorldState, id: number): StructureState | undefined =>
  world.structures.find((entry) => entry.id === asEntityId(id));

const unitById = (world: WorldState, id: number): UnitState | undefined =>
  world.units.find((entry) => entry.id === asEntityId(id));

describe('стрельба и урон', () => {
  it('башня бьёт вражеского юнита', () => {
    const world = arrange(
      [structure(50, 0, StructureKind.TowerBasic, 0, 0, 200)],
      [unit(60, 1, UnitType.Assault, 1, 0, 100)],
    );

    const after = step(world, []);

    expect(unitById(after, 60)?.health).toBeLessThan(100);
  });

  it('снайпер бьёт постройки в десятую силу', () => {
    const wallHealth = STRUCTURE_STATS[StructureKind.Wall].health;

    const bySniper = step(
      arrange(
        [structure(50, 1, StructureKind.Wall, 0, 0, wallHealth)],
        [unit(60, 0, UnitType.Sniper, 2, 0, 100)],
      ),
      [],
    );
    const byAssault = step(
      arrange(
        [structure(50, 1, StructureKind.Wall, 0, 0, wallHealth)],
        [unit(60, 0, UnitType.Assault, 1, 0, 100)],
      ),
      [],
    );

    const sniperDamage = wallHealth - (structureById(bySniper, 50)?.health ?? 0);
    const assaultDamage = wallHealth - (structureById(byAssault, 50)?.health ?? 0);

    expect(sniperDamage).toBeGreaterThan(0);
    expect(sniperDamage).toBeLessThan(assaultDamage);
  });

  it('живая цель важнее постройки', () => {
    const wallHealth = STRUCTURE_STATS[StructureKind.Wall].health;

    const world = arrange(
      [
        structure(50, 0, StructureKind.TowerBasic, 0, 0, 200),
        structure(51, 1, StructureKind.Wall, 1, 0, wallHealth),
      ],
      [unit(60, 1, UnitType.Assault, 2, 0, 100)],
    );

    const after = step(world, []);

    expect(unitById(after, 60)?.health).toBeLessThan(100);
    expect(structureById(after, 51)?.health).toBe(wallHealth);
  });

  it('перезарядка не даёт стрелять каждый тик', () => {
    const world = arrange(
      [structure(50, 0, StructureKind.TowerBasic, 0, 0, 200)],
      [unit(60, 1, UnitType.Assault, 1, 0, 10_000)],
    );

    let current = world;
    for (let tick = 0; tick < 10; tick += 1) current = step(current, []);

    const damage = 10_000 - (unitById(current, 60)?.health ?? 0);
    const attack = STRUCTURE_STATS[StructureKind.TowerBasic].attack;

    // Десять тиков — это треть секунды, то есть не больше одного выстрела
    // при базовой скорострельности в выстрел в секунду.
    expect(damage).toBeLessThanOrEqual(attack);
  });
});

/**
 * След выстрела нужен одной лишь отрисовке, но записывает его ядро:
 * опознать стрелка по точке выстрела клиент не может — след живёт дольше
 * стрелка, и погибший снайпер посреди показа превратил бы свой луч
 * в чужой трассер.
 */
describe('след выстрела', () => {
  /** Расстановка «стрелок игрока 0 и живая мишень игрока 1 в клетке рядом». */
  const duel = (
    shooter: readonly StructureState[],
    shooterUnits: readonly UnitState[],
    generalAt?: { x: number; y: number },
  ): WorldState =>
    step(
      arrange(shooter, [...shooterUnits, unit(61, 1, UnitType.Assault, 1, 0, 10_000)], generalAt),
      [],
    );

  const weaponOf = (world: WorldState, owner: number): ShotWeapon | undefined =>
    world.shots.find((shot) => shot.owner === asPlayerId(owner))?.weapon;

  it('снайпер и снайперская башня помечают выстрел лучом', () => {
    expect(weaponOf(duel([], [unit(60, 0, UnitType.Sniper, 0, 0, 100)]), 0)).toBe(ShotWeapon.Beam);
    expect(
      weaponOf(duel([structure(50, 0, StructureKind.TowerSniper, 0, 0, 200)], []), 0),
    ).toBe(ShotWeapon.Beam);
  });

  it('Тесла помечает выстрел разрядом', () => {
    expect(weaponOf(duel([], [unit(60, 0, UnitType.Tesla, 0, 0, 100)]), 0)).toBe(
      ShotWeapon.Arc,
    );
  });

  it('штурмовик и базовая башня помечают выстрел трассером', () => {
    expect(weaponOf(duel([], [unit(60, 0, UnitType.Assault, 0, 0, 100)]), 0)).toBe(ShotWeapon.Bolt);
    expect(weaponOf(duel([structure(50, 0, StructureKind.TowerBasic, 0, 0, 200)], []), 0)).toBe(
      ShotWeapon.Bolt,
    );
  });

  it('генерал помечает выстрел ракетой', () => {
    // Ракета принадлежит одному генералу, и это условие, которым
    // пользуется отрисовка: по виду оружия она узнаёт, что выстрел
    // вышел с высоты машины генерала, а не с плеча пехоты.
    expect(weaponOf(duel([], [], at(0, 0)), 0)).toBe(ShotWeapon.Missile);
  });

  it('след луча живёт вдвое дольше следа трассера', () => {
    // Оба выстрела сделаны в один тик, поэтому сравнивать можно остатки
    // сроков: общее начало отсчёта сокращается.
    const world = duel([], [unit(60, 0, UnitType.Sniper, 0, 0, 10_000)]);

    const beam = world.shots.find((shot) => shot.weapon === ShotWeapon.Beam);
    const bolt = world.shots.find((shot) => shot.weapon === ShotWeapon.Bolt);
    if (beam === undefined || bolt === undefined) throw new Error('в тике не было обоих выстрелов');

    expect(beam.expiresAtTick - world.tick).toBe((bolt.expiresAtTick - world.tick) * 2);
  });

  it('вид оружия не меняет контрольную сумму', () => {
    // Следы не входят в сумму намеренно: они производны от боя и нужны
    // рендеру. Войди вид оружия в неё — правка облика выстрела требовала бы
    // нового эталона детерминизма, хотя правила не менялись.
    const world = duel([], [unit(60, 0, UnitType.Sniper, 0, 0, 10_000)]);
    const repainted = {
      ...world,
      shots: world.shots.map((shot) => ({ ...shot, weapon: ShotWeapon.Arc })),
    };

    expect(world.shots.length).toBeGreaterThan(0);
    expect(checksum(repainted)).toBe(checksum(world));
  });
});

describe('линия огня', () => {
  it('башня стреляет поверх стены', () => {
    const world = arrange(
      [
        structure(50, 0, StructureKind.TowerBasic, 0, 0, 200),
        structure(51, 1, StructureKind.Wall, 1, 0, 10_000),
      ],
      [unit(60, 1, UnitType.Assault, 2, 0, 100)],
    );

    const after = step(world, []);

    expect(unitById(after, 60)?.health).toBeLessThan(100);
  });

  it('юнит не стреляет сквозь стену', () => {
    const world = arrange(
      [structure(51, 1, StructureKind.Wall, 1, 0, 10_000)],
      [unit(60, 1, UnitType.Assault, 2, 0, 100), unit(61, 0, UnitType.Assault, 0, 0, 10_000)],
    );

    const after = step(world, []);

    expect(unitById(after, 60)?.health).toBe(100);
  });

  it('скала прячет юнита и от башни, и от юнита', () => {
    const rock = [cellOffset(1, 0)];

    const fromTower = step(
      arrange(
        [structure(50, 0, StructureKind.TowerBasic, 0, 0, 200)],
        [unit(60, 1, UnitType.Assault, 2, 0, 100)],
        undefined,
        rock,
      ),
      [],
    );
    const fromUnit = step(
      arrange(
        [],
        [unit(60, 1, UnitType.Assault, 2, 0, 100), unit(61, 0, UnitType.Assault, 0, 0, 10_000)],
        undefined,
        rock,
      ),
      [],
    );

    expect(unitById(fromTower, 60)?.health).toBe(100);
    expect(unitById(fromUnit, 60)?.health).toBe(100);
  });

  it('стена как цель обстреливается, а не прячет сама себя', () => {
    const wallHealth = STRUCTURE_STATS[StructureKind.Wall].health;

    const world = arrange(
      [structure(51, 1, StructureKind.Wall, 1, 0, wallHealth)],
      [unit(61, 0, UnitType.Assault, 0, 0, 10_000)],
    );

    const after = step(world, []);

    expect(structureById(after, 51)?.health).toBeLessThan(wallHealth);
  });
});

describe('усиление башни за убийства', () => {
  it('добив юнита, башня получает пять процентов к силе', () => {
    const world = arrange(
      [structure(50, 0, StructureKind.TowerBasic, 0, 0, 200)],
      [unit(60, 1, UnitType.Assault, 1, 0, 1)],
    );

    const after = step(world, []);

    expect(unitById(after, 60)).toBeUndefined();
    expect(structureById(after, 50)?.growthPpm).toBe(compoundPpm(5, 1));
  });

  it('усиление копится сложным процентом и не переходит на соседей', () => {
    const world = arrange(
      [
        structure(50, 0, StructureKind.TowerBasic, 0, 0, 200),
        // Вторая башня намеренно далеко: она не должна ни в кого попасть,
        // иначе тест не докажет, что усиление не переходит на соседей.
        structure(51, 0, StructureKind.TowerBasic, 0, 20, 200),
      ],
      [unit(60, 1, UnitType.Assault, 1, 0, 1), unit(61, 1, UnitType.Assault, 1, 1, 1)],
    );

    // Перезарядка в секунду не даёт убить обоих сразу, поэтому ждём,
    // пока башня отстреляется дважды.
    let current = world;
    for (let tick = 0; tick < 70; tick += 1) current = step(current, []);

    expect(structureById(current, 50)?.growthPpm).toBe(compoundPpm(5, 2));
    // Соседняя башня стоит вне радиуса от юнитов и потому не усилилась.
    expect(structureById(current, 51)?.growthPpm).toBe(PPM_ONE);
  });

  it('усиление добавляет здоровье, а не отнимает долю', () => {
    const world = arrange(
      [structure(50, 0, StructureKind.TowerBasic, 0, 0, 200)],
      [unit(60, 1, UnitType.Assault, 1, 0, 1)],
    );

    const after = step(world, []);

    expect(structureById(after, 50)?.health).toBeGreaterThan(200);
  });
});

describe('награда генералу', () => {
  it('убийство юнита генералом приносит его базовую стоимость', () => {
    const world = arrange([], [unit(60, 1, UnitType.Assault, 1, 0, 1)], at(0, 0));
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, []);

    expect(unitById(after, 60)).toBeUndefined();
    // Доход тика плюс награда. Награда — базовая цена штурмовика.
    expect((after.players[0]?.energy ?? 0) - before).toBeGreaterThanOrEqual(
      UNIT_STATS[UnitType.Assault].cost,
    );
  });

  it('убийство юнитом награды не даёт', () => {
    const attacker: PlayerId = asPlayerId(0);
    const world = arrange(
      [],
      [unit(60, 1, UnitType.Assault, 1, 0, 1), unit(61, attacker, UnitType.Assault, 2, 0, 100)],
    );
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, []);

    expect(unitById(after, 60)).toBeUndefined();
    expect((after.players[0]?.energy ?? 0) - before).toBeLessThan(
      UNIT_STATS[UnitType.Assault].cost,
    );
  });
});

