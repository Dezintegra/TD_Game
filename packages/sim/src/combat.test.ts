import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  FIRST_MISSILE_SIDE,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  GENERAL_STATS,
  MAP_WIDTH_CELLS,
  SPLASH_OUTER_DIVISOR,
  STRUCTURE_STATS,
  ShotSide,
  ShotWeapon,
  StructureKind,
  TOWER_KILL_BOUNTY_PPM,
  Terrain,
  UNIT_STATS,
  UnitType,
  applyPpm,
  asEntityId,
  asPlayerId,
  asTickNumber,
  VETERAN_MAX_RANK,
  VETERAN_RANK_KILLS,
  veteranRank,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { createWorld } from './world.js';
import type { GeneralState, StructureState, UnitState, WorldState } from './world.js';
import { step } from './step.js';
import { checksum } from './checksum.js';
import { playerStats, structureAttack, unitMaxHealth } from './stats.js';
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
  kills: 0,
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
  kills: 0,
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
    expect(weaponOf(duel([structure(50, 0, StructureKind.TowerSniper, 0, 0, 200)], []), 0)).toBe(
      ShotWeapon.Beam,
    );
  });

  it('Тесла помечает выстрел разрядом', () => {
    expect(weaponOf(duel([], [unit(60, 0, UnitType.Tesla, 0, 0, 100)]), 0)).toBe(ShotWeapon.Arc);
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

  it('прочие стрелки бьют по оси, без борта', () => {
    // Борт есть только у ракеты: у неё под него нарисованы пилоны.
    const world = duel(
      [structure(50, 0, StructureKind.TowerBasic, 0, 0, 200)],
      [unit(60, 0, UnitType.Sniper, 0, 0, 10_000)],
    );

    const sides = world.shots
      .filter((shot) => shot.weapon !== ShotWeapon.Missile)
      .map((shot) => shot.side);

    expect(sides.length).toBeGreaterThan(1);
    expect(sides.every((side) => side === ShotSide.Centre)).toBe(true);
  });

  it('ракеты генерала уходят с бортов по очереди', () => {
    // Чередование — свойство последовательности выстрелов, и знает её
    // только стрелок. Клиент вывести её не может: он переигрывает тики
    // при откате предсказания, и счётчик у него насчитал бы лишнее.
    const rounds = 3;
    let world = arrange([], [unit(61, 1, UnitType.Assault, 1, 0, 10_000)], at(0, 0));

    // Ракеты опознаются по сроку истечения: он у каждой свой, потому что
    // выстрелы сделаны на разных тиках. Так пересчёт одного и того же
    // следа на нескольких тиках не превращается в лишний выстрел.
    const seen = new Map<number, number>();

    for (let tick = 0; tick < GENERAL_STATS.cooldownTicks * rounds; tick += 1) {
      world = step(world, []);

      for (const shot of world.shots) {
        if (shot.weapon === ShotWeapon.Missile) seen.set(shot.expiresAtTick, shot.side);
      }
    }

    const order = [...seen.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, side]) => side);

    expect(order.length).toBeGreaterThanOrEqual(rounds);
    order.forEach((side, index) => {
      expect(side).toBe(index % 2 === 0 ? FIRST_MISSILE_SIDE : -FIRST_MISSILE_SIDE);
    });
  });

  it('промолчавший генерал очередь бортов не сбивает', () => {
    // Борт переключается только состоявшимся выстрелом. Иначе очередь
    // считала бы тики, а не пуски, и «по очереди» превратилось бы
    // в «когда как».
    const idle = step(arrange([], [], at(0, 0)), []);

    expect(idle.shots).toHaveLength(0);
    expect(idle.generals[0]?.nextMissileSide).toBe(FIRST_MISSILE_SIDE);
  });

  it('оба генерала начинают с одного борта', () => {
    // Карта симметрична поворотом, а поворот сохраняет право и лево.
    // Разные борта у двух генералов были бы асимметрией там, где её нет.
    const sides = createWorld(SEED).generals.map((general) => general.nextMissileSide);

    expect(sides).toHaveLength(2);
    expect(new Set(sides).size).toBe(1);
    expect(sides[0]).toBe(FIRST_MISSILE_SIDE);
  });

  it('борт не меняет контрольную сумму', () => {
    // Борт полностью выводится из последовательности выстрелов, а она
    // в сумме уже есть. Войди он в неё — и правка облика требовала бы
    // нового эталона детерминизма, хотя правила не менялись.
    const world = duel([], [], at(0, 0));
    const swapped = {
      ...world,
      generals: world.generals.map((general) => ({
        ...general,
        nextMissileSide: -general.nextMissileSide as ShotSide,
      })),
    };

    expect(world.shots.length).toBeGreaterThan(0);
    expect(checksum(swapped)).toBe(checksum(world));
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

  it('стена перекрывает выстрел генералу в пределах его дальности', () => {
    // На прежних двух клетках правило существовало, но почти не проявлялось:
    // между стрелком и целью в упор стена не помещается. С пятёркой оно
    // работает по-настоящему, и проверять его надо на расстоянии, которое
    // прежней дальности было недоступно.
    //
    // Три клетки выбраны именно поэтому: они за старой дальностью
    // и внутри новой. Первое сравнение поэтому сторожит заодно и саму
    // дальность — откатите её к двойке, и оно покраснеет.
    const health = UNIT_STATS[UnitType.Assault].health;
    const wallHealth = STRUCTURE_STATS[StructureKind.Wall].health;

    const open = step(arrange([], [unit(70, 1, UnitType.Assault, 3, 0, health)], at(0, 0)), []);
    const blocked = step(
      arrange(
        [structure(50, 1, StructureKind.Wall, 1, 0, wallHealth)],
        [unit(70, 1, UnitType.Assault, 3, 0, health)],
        at(0, 0),
      ),
      [],
    );

    expect(unitById(open, 70)?.health).toBeLessThan(health);
    expect(unitById(blocked, 70)?.health).toBe(health);
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

describe('ветеранские ранги за убийства', () => {
  const TOWER_HEALTH = STRUCTURE_STATS[StructureKind.TowerBasic].health;
  const TOWER_ATTACK = STRUCTURE_STATS[StructureKind.TowerBasic].attack;

  /**
   * Башня в середине поля и заданное число обречённых рядом с ней.
   *
   * Прочность башни задаётся отдельно, и это не украшение стенда.
   * На длинных прогонах толпа успевает снести башню раньше, чем та
   * наберёт ранги, — и тест ловил бы исход перестрелки, а не правило.
   */
  const gallery = (victims: number, towerHealth = TOWER_HEALTH): WorldState =>
    arrange(
      [structure(50, 0, StructureKind.TowerBasic, 0, 0, towerHealth)],
      Array.from({ length: victims }, (_, index) =>
        // Раскладываем в линию, чтобы каждый был отдельной целью,
        // а не толпой в одной точке.
        unit(60 + index, 1, UnitType.Assault, 1 + index * 0.2, 0, 1),
      ),
    );

  /**
   * Прогон до тех пор, пока башня не наберёт нужное число убийств.
   *
   * Убитая мишень заменяется новой, и это не удобство, а необходимость.
   * Войско по умолчанию идёт на прорыв: оно не задерживается у башни,
   * а проходит мимо и за несколько секунд выходит из её радиуса. Расставь
   * мы двадцать мишеней разом — башня успела бы снять пятерых, а тест
   * поймал бы скорость пехоты, а не потолок ранга.
   *
   * Перезарядка башни — секунда, то есть тридцать тиков на убийство.
   * Запас двойной: тест не должен зависеть от того, попала ли башня
   * в первый же тик.
   */
  const untilKills = (world: WorldState, wanted: number): WorldState => {
    let current = world;
    let nextVictimId = 200;

    for (let tick = 0; tick < wanted * 90 + 90; tick += 1) {
      if ((structureById(current, 50)?.kills ?? 0) >= wanted) break;

      if (current.units.length === 0) {
        nextVictimId += 1;
        current = { ...current, units: [unit(nextVictimId, 1, UnitType.Assault, 1, 0, 1)] };
      }

      current = step(current, []);
    }

    return current;
  };

  const towerAttackIn = (world: WorldState): number => {
    const tower = structureById(world, 50);
    const owner = world.players[0];
    if (tower === undefined || owner === undefined) throw new Error('башня пропала');

    return structureAttack(playerStats(owner).structures[StructureKind.TowerBasic], tower.kills);
  };

  it('первое убийство даёт первый ранг', () => {
    const after = step(gallery(1), []);

    expect(unitById(after, 60)).toBeUndefined();
    expect(structureById(after, 50)?.kills).toBe(1);
    expect(veteranRank(structureById(after, 50)?.kills ?? 0)).toBe(1);
  });

  it('ранг растёт по порогам, а не за каждое убийство', () => {
    const twoKills = untilKills(gallery(3), 2);
    expect(veteranRank(structureById(twoKills, 50)?.kills ?? 0)).toBe(1);

    const threeKills = untilKills(twoKills, 3);
    expect(veteranRank(structureById(threeKills, 50)?.kills ?? 0)).toBe(2);
  });

  it('ранг умножает атаку и максимум здоровья по таблице', () => {
    const first = step(gallery(1), []);

    // Первый ранг — сто десять процентов. Здоровье видно прямо: башня
    // стояла целой, и максимум ей подняли вместе с текущим.
    expect(towerAttackIn(first)).toBe(Math.floor((TOWER_ATTACK * 110) / 100));
    expect(structureById(first, 50)?.health).toBe(Math.floor((TOWER_HEALTH * 110) / 100));

    // Третье убийство — второй ранг, сто двадцать пять процентов.
    const third = untilKills(gallery(3), 3);
    expect(towerAttackIn(third)).toBe(Math.floor((TOWER_ATTACK * 125) / 100));
  });

  it('выше пятого ранга не поднимаются', () => {
    const topKills = VETERAN_RANK_KILLS[VETERAN_MAX_RANK - 1] ?? 15;
    // Башня неубиваемая намеренно: проверяется потолок множителя,
    // а не то, переживёт ли она два десятка штурмовиков.
    const after = untilKills(gallery(topKills + 5, 1_000_000), topKills + 3);
    const tower = structureById(after, 50);
    if (tower === undefined) throw new Error('башня пропала');

    // Счётчик убийств продолжает расти, а множитель — нет.
    expect(tower.kills).toBeGreaterThan(topKills);
    expect(veteranRank(tower.kills)).toBe(VETERAN_MAX_RANK);
    expect(towerAttackIn(after)).toBe(TOWER_ATTACK * 2);
  });

  it('ранг не трогает дальность и перезарядку', () => {
    const after = untilKills(gallery(3), 3);
    const owner = after.players[0];
    if (owner === undefined) throw new Error('игрок пропал');

    const baseline = playerStats(owner).structures[StructureKind.TowerBasic];

    expect(baseline.range).toBe(STRUCTURE_STATS[StructureKind.TowerBasic].range);
    expect(baseline.cooldownTicks).toBe(STRUCTURE_STATS[StructureKind.TowerBasic].cooldownTicks);
  });

  it('ранг не переходит на соседнюю башню того же вида', () => {
    const world = arrange(
      [
        structure(50, 0, StructureKind.TowerBasic, 0, 0, TOWER_HEALTH),
        // Вторая башня намеренно далеко: она не должна ни в кого попасть,
        // иначе тест не докажет, что ранг принадлежит объекту.
        structure(51, 0, StructureKind.TowerBasic, 0, 20, TOWER_HEALTH),
      ],
      [unit(60, 1, UnitType.Assault, 1, 0, 1)],
    );

    const after = step(world, []);

    expect(structureById(after, 50)?.kills).toBe(1);
    expect(structureById(after, 51)?.kills).toBe(0);
  });

  it('юнит набирает ранг наравне с башней', () => {
    const health = UNIT_STATS[UnitType.Assault].health;
    const world = arrange(
      [],
      [unit(60, 0, UnitType.Assault, 0, 0, health), unit(70, 1, UnitType.Assault, 1, 0, 1)],
    );

    const after = step(world, []);

    expect(unitById(after, 70)).toBeUndefined();
    expect(unitById(after, 60)?.kills).toBe(1);
    // Максимум вырос вместе с текущим: доля здоровья не просела.
    //
    // Сто пять процентов, а не сто десять: у машины таблица своя, мягче
    // башенной. Разница выведена замером длины матча — см. `balance.ts`.
    expect(unitById(after, 60)?.health).toBe(Math.floor((health * 105) / 100));
  });

  it('ранг юнита доходит до его выстрела, а не только до прочности', () => {
    // Проверка заведена по следу настоящей ошибки: ранг сперва попал юниту
    // в максимум здоровья, а стрелял он по-прежнему паспортным уроном.
    // Полоса над машиной росла, а бой не менялся — и увидеть это глазами
    // было нельзя.
    //
    // Сравниваются два одинаковых прогона, отличающихся ОДНИМ полем.
    // Так проверка не зависит ни от порядка выстрелов внутри тика,
    // ни от того, куда за это время уехала машина: уедет она одинаково,
    // движение от ранга не зависит.
    const wallHealth = 100_000;

    const damageWith = (kills: number): number => {
      const world = arrange(
        [structure(50, 1, StructureKind.Wall, 1, 0, wallHealth)],
        [{ ...unit(60, 0, UnitType.Assault, 0, 0, 500), kills }],
      );

      let current = world;
      for (let tick = 0; tick < 120; tick += 1) current = step(current, []);

      return wallHealth - (structureById(current, 50)?.health ?? 0);
    };

    const plain = damageWith(0);
    // Пятнадцать убийств — высший ранг машины, полторы силы.
    const veteran = damageWith(VETERAN_RANK_KILLS[VETERAN_MAX_RANK - 1] ?? 15);

    expect(plain).toBeGreaterThan(0);
    expect(veteran).toBe(plain * 1.5);
  });

  it('стена и база рангов не набирают', () => {
    const after = step(gallery(1), []);

    const passive = after.structures.filter(
      (entry) => entry.kind === StructureKind.Wall || entry.kind === StructureKind.Base,
    );

    expect(passive.length).toBeGreaterThan(0);
    expect(passive.every((entry) => entry.kills === 0)).toBe(true);
  });

  it('генерал ранга не набирает: его награда — энергия', () => {
    const world = arrange([], [unit(70, 1, UnitType.Assault, 1, 0, 1)], at(0, 0));
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, []);

    expect(unitById(after, 70)).toBeUndefined();
    expect((after.players[0]?.energy ?? 0) - before).toBeGreaterThanOrEqual(
      UNIT_STATS[UnitType.Assault].cost,
    );
    // Поля ранга у генерала нет вовсе: он не крепчает и погона не носит.
    expect('kills' in (after.generals[0] ?? {})).toBe(false);
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

describe('награда постройке', () => {
  /**
   * Прибавка энергии за тик, в котором башня стреляет по штурмовику.
   *
   * Считается ПРОТИВ КОНТРОЛЯ: тот же мир, та же башня, тот же выстрел —
   * разнится только прочность цели. Иначе в разницу вошёл бы ещё и доход
   * тика, и проверка «выросла хотя бы на столько-то» стерегла бы доход,
   * а не награду.
   */
  const gainWhenTargetHas = (health: number): number => {
    const world = arrange(
      [structure(50, 0, StructureKind.TowerBasic, 0, 0, 100_000)],
      [unit(60, 1, UnitType.Assault, 1, 0, health)],
    );
    const before = world.players[0]?.energy ?? 0;

    return (step(world, []).players[0]?.energy ?? 0) - before;
  };

  it('башня, добившая штурмовика, приносит пятую часть его цены', () => {
    const killed = gainWhenTargetHas(1);
    const survived = gainWhenTargetHas(100_000);

    expect(killed - survived).toBe(
      applyPpm(UNIT_STATS[UnitType.Assault].cost, TOWER_KILL_BOUNTY_PPM),
    );
  });

  it('за добитую стену платится доля цены стены, а не цены машины', () => {
    // Добыча берётся у той же `bounty`, что платит генералу, поэтому вид
    // убитого решает, сколько причитается. Проверка стережёт именно это:
    // при плоской награде обе цены дали бы одно число, и подмена одной
    // другой прошла бы незамеченной.
    const gain = (health: number): number => {
      const world = arrange(
        [
          structure(50, 0, StructureKind.TowerBasic, 0, 0, 100_000),
          structure(51, 1, StructureKind.Wall, 1, 0, health),
        ],
        [],
      );
      const before = world.players[0]?.energy ?? 0;

      return (step(world, []).players[0]?.energy ?? 0) - before;
    };

    const wall = STRUCTURE_STATS[StructureKind.Wall].cost;

    expect(gain(1) - gain(100_000)).toBe(applyPpm(wall, TOWER_KILL_BOUNTY_PPM));
    expect(applyPpm(wall, TOWER_KILL_BOUNTY_PPM)).not.toBe(
      applyPpm(UNIT_STATS[UnitType.Assault].cost, TOWER_KILL_BOUNTY_PPM),
    );
  });

  it('машина не получает и доли: платят только постройке и генералу', () => {
    // Существующая проверка «убийство юнитом награды не даёт» сравнивает
    // прибавку с ПОЛНОЙ ценой убитого и потому зеленела бы, начни машина
    // получать пятую часть. Здесь сравнение точное: прибавка обязана
    // равняться одному лишь доходу тика.
    const attacker: PlayerId = asPlayerId(0);
    const world = arrange(
      [],
      [unit(60, 1, UnitType.Assault, 1, 0, 1), unit(61, attacker, UnitType.Assault, 2, 0, 100)],
    );
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, []);
    const control = arrange(
      [],
      [
        unit(60, 1, UnitType.Assault, 1, 0, 100_000),
        unit(61, attacker, UnitType.Assault, 2, 0, 100),
      ],
    );
    const controlBefore = control.players[0]?.energy ?? 0;
    const controlAfter = step(control, []);

    expect(unitById(after, 60)).toBeUndefined();
    expect((after.players[0]?.energy ?? 0) - before).toBe(
      (controlAfter.players[0]?.energy ?? 0) - controlBefore,
    );
  });

  it('без гибели цели выстрел награды не приносит', () => {
    // Контроль обязан быть пустым: платят за гибель, а не за попадание.
    // Без этой проверки предыдущая сравнивала бы две одинаково щедрые
    // величины и зеленела бы при награде за каждый выстрел.
    const world = arrange(
      [structure(50, 0, StructureKind.TowerBasic, 0, 0, 100_000)],
      [unit(60, 1, UnitType.Assault, 1, 0, 100_000)],
    );
    const before = world.players[0]?.energy ?? 0;
    const after = step(world, []);

    expect(unitById(after, 60)).toBeDefined();
    expect((after.players[0]?.energy ?? 0) - before).toBeLessThan(
      applyPpm(UNIT_STATS[UnitType.Assault].cost, TOWER_KILL_BOUNTY_PPM),
    );
  });
});

describe('накрытие Теслы', () => {
  const ATTACK = UNIT_STATS[UnitType.Tesla].attack;
  const SHARE = Math.floor(ATTACK / SPLASH_OUTER_DIVISOR);

  /**
   * Тесла у середины поля и толпа перед ней.
   *
   * Целью станет ближайшая машина — на три клетки, — а всё остальное
   * получит своё по расстоянию уже от неё. Числа расстановки выбраны
   * с запасом от порогов в одну и две клетки: за тик все успевают
   * сместиться на сотые доли клетки, и попасть на сам порог нельзя.
   */
  const crowd = (): WorldState =>
    arrange(
      [],
      [
        unit(60, 0, UnitType.Tesla, 0, 0, 200),
        unit(70, 1, UnitType.Assault, 3, 0, 100),
        unit(71, 1, UnitType.Assault, 3.5, 0, 100),
        unit(72, 1, UnitType.Assault, 4.5, 0, 100),
        unit(73, 1, UnitType.Assault, 6, 0, 100),
      ],
    );

  it('в ближнем радиусе достаётся полный урон, в дальнем — четверть', () => {
    const after = step(crowd(), []);

    // Прямая цель. Ровно один урон, а не два: из накрытия она исключена,
    // иначе получила бы своё дважды.
    expect(unitById(after, 70)?.health).toBe(100 - ATTACK);
    // Полклетки от точки попадания — полный урон.
    expect(unitById(after, 71)?.health).toBe(100 - ATTACK);
    // Полторы клетки — четверть с округлением вниз.
    expect(unitById(after, 72)?.health).toBe(100 - SHARE);
    // Три клетки — не задело вовсе.
    expect(unitById(after, 73)?.health).toBe(100);
  });

  it('свои под накрытие не попадают', () => {
    // Целью станет стена: живых врагов в радиусе нет. Своя машина стоит
    // от неё в полуклетки, то есть в самой середине накрытия.
    const wallHealth = STRUCTURE_STATS[StructureKind.Wall].health;
    const after = step(
      arrange(
        [structure(50, 1, StructureKind.Wall, 3, 0, wallHealth)],
        [unit(60, 0, UnitType.Tesla, 0, 0, 200), unit(61, 0, UnitType.Assault, 3.5, 0, 100)],
      ),
      [],
    );

    expect(unitById(after, 61)?.health).toBe(100);
  });

  it('постройки накрытие не чувствуют', () => {
    // Стена стоит в полуклетке от точки попадания — в ближнем радиусе,
    // где живые получают полный урон. Иначе стеновая линия оседала бы
    // веером, а не ломалась по одной.
    const wallHealth = STRUCTURE_STATS[StructureKind.Wall].health;
    const after = step(
      arrange(
        [structure(50, 1, StructureKind.Wall, 3.5, 0, wallHealth)],
        [unit(60, 0, UnitType.Tesla, 0, 0, 200), unit(70, 1, UnitType.Assault, 3, 0, 100)],
      ),
      [],
    );

    expect(structureById(after, 50)?.health).toBe(wallHealth);
    expect(unitById(after, 70)?.health).toBe(100 - ATTACK);
  });

  it('вражеский генерал накрывается наравне с машинами', () => {
    // Генерал стоит в шести с половиной клетках — вне досягаемости Теслы
    // с её шестью, поэтому целью он не станет, — но в полутора клетках
    // от точки попадания, то есть в дальнем кольце накрытия. Стрелок
    // здесь второй игрок, потому что расстановка двигает генерала первого.
    //
    // Полклетки запаса и до порога дальности, и до порога кольца: цель
    // ровно на границе за тик успевает с неё сойти, и тест ловил бы
    // движение вместо правила.
    const after = step(
      arrange(
        [],
        [unit(60, 1, UnitType.Tesla, 0, 0, 200), unit(70, 0, UnitType.Assault, 5, 0, 100)],
        at(6.5, 0),
      ),
      [],
    );

    // Сначала — что выстрел вообще был: иначе «генерал цел» означало бы
    // не «накрытие его не тронуло», а «никто не стрелял».
    expect(unitById(after, 70)?.health).toBe(100 - ATTACK);
    expect(after.generals[0]?.health).toBe(GENERAL_STATS.health - SHARE);
  });

  it('стена от накрытия не спасает', () => {
    // Накрытие линию огня не проверяет: это последствие попадания,
    // а не отдельный выстрел, и разряд растекается по земле. Машина
    // за стеной свою четверть получит, хотя выстрелить по ней напрямую
    // было бы нельзя.
    //
    // Следствие сознательное, и тест закрепляет его именно поэтому:
    // без него следующий примет это за недочёт и «починит».
    const wallHealth = STRUCTURE_STATS[StructureKind.Wall].health;
    const after = step(
      arrange(
        [structure(50, 1, StructureKind.Wall, 4, 0, wallHealth)],
        [
          unit(60, 0, UnitType.Tesla, 0, 0, 200),
          unit(70, 1, UnitType.Assault, 3, 0, 100),
          unit(71, 1, UnitType.Assault, 4.5, 0, 100),
        ],
      ),
      [],
    );

    expect(unitById(after, 70)?.health).toBe(100 - ATTACK);
    expect(unitById(after, 71)?.health).toBe(100 - SHARE);
  });

  it('накрытие не приносит добычи', () => {
    // Добыча за убийство полагается только генералу, а стреляет здесь
    // юнит. Проверка нужна потому, что один выстрел убивает многих:
    // отдай накрытие тому, кому награда полагается, — и оно оплатит
    // само себя с одного залпа.
    const world = arrange(
      [],
      [
        unit(60, 0, UnitType.Tesla, 0, 0, 200),
        unit(70, 1, UnitType.Assault, 3, 0, 10),
        unit(71, 1, UnitType.Assault, 3.5, 0, 10),
      ],
    );
    const before = world.players[0]?.energy ?? 0;

    const after = step(world, []);

    expect(unitById(after, 70)).toBeUndefined();
    expect(unitById(after, 71)).toBeUndefined();
    expect((after.players[0]?.energy ?? 0) - before).toBeLessThan(
      UNIT_STATS[UnitType.Assault].cost,
    );
  });

  it('накрытие приносит столько убийств, скольких положило', () => {
    // В этом и смысл урона по площади: оружие против толпы кладёт многих
    // сразу, и засчитывать ему одного значило бы отнимать заслугу за то,
    // ради чего его покупают. Темп набора ранга ограничен не счётом,
    // а таблицей: у машины потолок полтора, а не два.
    const world = arrange(
      [],
      [
        unit(60, 0, UnitType.Tesla, 0, 0, 200),
        unit(70, 1, UnitType.Assault, 3, 0, 1),
        unit(71, 1, UnitType.Assault, 3.5, 0, 1),
        unit(72, 1, UnitType.Assault, 3.7, 0, 1),
      ],
    );

    const after = step(world, []);

    expect(unitById(after, 70)).toBeUndefined();
    expect(unitById(after, 71)).toBeUndefined();
    expect(unitById(after, 72)).toBeUndefined();
    // Трое убитых — три убийства: прямая цель плюс двое из накрытия.
    expect(unitById(after, 60)?.kills).toBe(3);
  });

  it('ранг после залпа пересчитывается один раз, а не по разу на убитого', () => {
    // Ловушка внутри: здоровье добавляется РАЗНИЦЕЙ максимумов. Считай мы
    // по разу на убитого, объект получил бы прибавку трижды подряд —
    // и оказался бы крепче собственного максимума.
    const health = UNIT_STATS[UnitType.Tesla].health;
    const world = arrange(
      [],
      [
        unit(60, 0, UnitType.Tesla, 0, 0, health),
        unit(70, 1, UnitType.Assault, 3, 0, 1),
        unit(71, 1, UnitType.Assault, 3.5, 0, 1),
        unit(72, 1, UnitType.Assault, 3.7, 0, 1),
      ],
    );

    const after = step(world, []);
    const tesla = unitById(after, 60);
    if (tesla === undefined) throw new Error('Тесла пропала');

    const owner = after.players[0];
    if (owner === undefined) throw new Error('игрок пропал');

    // Три убийства — второй ранг. Здоровье ровно на максимуме второго
    // ранга, ни единицей больше.
    expect(tesla.kills).toBe(3);
    expect(tesla.health).toBe(unitMaxHealth(playerStats(owner).units[UnitType.Tesla], tesla.kills));
  });

  it('прочее оружие площадь не поражает', () => {
    // Та же расстановка, но стрелок — снайпер: одинаковая дальность
    // и одинаковый урон, разное оружие. Соседа он не задевает.
    const after = step(
      arrange(
        [],
        [
          unit(60, 0, UnitType.Sniper, 0, 0, 200),
          unit(70, 1, UnitType.Assault, 3, 0, 100),
          unit(71, 1, UnitType.Assault, 3.5, 0, 100),
        ],
      ),
      [],
    );

    expect(unitById(after, 70)?.health).toBeLessThan(100);
    expect(unitById(after, 71)?.health).toBe(100);
  });
});
