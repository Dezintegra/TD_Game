import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SOUTH,
  FIXED_POINT_SCALE,
  GENERAL_STATS,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  Terrain,
  UNIT_STATS,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { PlayerId, Vec2 } from '@td/shared';
import { createWorld } from './world.js';
import type { GeneralState, StructureState, UnitState, WorldState } from './world.js';
import { step } from './step.js';
import { cellCentre, cellIndex } from './map.js';
import { TargetKind, buildCombatIndices, chooseTarget } from './combat.js';
import type { Target } from './combat.js';
import { toWorking } from './working.js';

/**
 * Порядок приоритетов в выборе цели.
 *
 * Проверяется вызовом `chooseTarget` напрямую, а не прогоном тика.
 * Причина в том, что тик отвечает сразу на два вопроса — «кого выбрали»
 * и «сколько урона нанесли», — и по упавшему здоровью не отличить
 * «выбрал не того» от «выбрал того, но промазал линией огня».
 * Отдельно от этого один прогон тика всё же есть: он доказывает,
 * что правило доходит до настоящего боя, а не живёт в одной функции.
 *
 * Расстановки строятся на карте без единой скалы: генерация кладёт их
 * куда угодно, и случайная скала между стрелком и целью отменяла бы
 * выстрел. Скалы, где они нужны, ставятся явно.
 */

const SEED = 4242;

/** Середина карты: там ничто не мешает расстановке. */
const FIELD_X = MAP_WIDTH_CELLS / 2;
const FIELD_Y = MAP_HEIGHT_CELLS / 2;
const FIELD = cellIndex(FIELD_X, FIELD_Y);

const ME: PlayerId = asPlayerId(0);
const FOE = asPlayerId(1);

const cellOffset = (dx: number, dy: number): number => cellIndex(FIELD_X + dx, FIELD_Y + dy);

/** Точка в клетках от середины поля. Доли клетки допустимы. */
const at = (dx: number, dy: number): Vec2 => {
  const centre = cellCentre(FIELD);
  return {
    x: centre.x + Math.round(dx * FIXED_POINT_SCALE),
    y: centre.y + Math.round(dy * FIXED_POINT_SCALE),
  };
};

const ORIGIN = at(0, 0);

/** Дальности стрелков, во внутренних единицах. */
const TOWER_RANGE = STRUCTURE_STATS[StructureKind.TowerBasic].range;
const UNIT_RANGE = UNIT_STATS[UnitType.Assault].range;

const unit = (id: number, owner: number, dx: number, dy: number): UnitState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  unitType: UnitType.Assault,
  position: at(dx, dy),
  health: UNIT_STATS[UnitType.Assault].health,
  facing: 1,
  readyAtTick: asTickNumber(0),
  kills: 0,
});

const structure = (
  id: number,
  owner: number,
  kind: StructureKind,
  dx: number,
  dy: number,
): StructureState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  kind,
  cell: cellOffset(dx, dy),
  health: STRUCTURE_STATS[kind].health,
  kills: 0,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(0),
  facing: DIRECTION_SOUTH,
});

interface Scene {
  readonly structures?: readonly StructureState[];
  readonly units?: readonly UnitState[];
  /** Куда поставить генерала игрока. Не указан — остаётся у своей базы. */
  readonly mine?: Vec2;
  /** Куда поставить генерала противника. Не указан — остаётся у своей базы. */
  readonly foe?: Vec2;
  readonly rocks?: readonly number[];
}

const arrange = (scene: Scene): WorldState => {
  const world = createWorld(SEED);

  const generals: GeneralState[] = world.generals.map((general) => {
    const place = general.owner === ME ? scene.mine : scene.foe;
    return place === undefined ? general : { ...general, position: place };
  });

  const cells = new Uint8Array(MAP_CELL_COUNT);
  for (const cell of scene.rocks ?? []) cells[cell] = Terrain.Rock;

  return {
    ...world,
    map: { cells, baseCells: world.map.baseCells },
    structures: [...world.structures, ...(scene.structures ?? [])],
    units: [...(scene.units ?? [])],
    generals,
  };
};

interface Shot {
  readonly range: number;
  /** Стрелок выше стен: башня или база. Юнит и генерал — нет. */
  readonly elevated: boolean;
  /**
   * Навесной огонь: постройки видны поверх стен, живые — нет. Это Тесла.
   * Задаётся отдельно от `elevated`, потому что у неё эти два значения
   * впервые разошлись.
   */
  readonly indirect?: boolean;
  readonly globalTarget?: number;
  readonly blockedBy?: number;
}

/** Кого выберет стрелок игрока, стоящий в середине поля. */
const targetOf = (world: WorldState, shot: Shot): Target | undefined => {
  const working = toWorking(world);

  return chooseTarget(
    working,
    buildCombatIndices(working),
    ME,
    ORIGIN,
    shot.range,
    shot.globalTarget ?? -1,
    shot.blockedBy ?? -1,
    shot.indirect === true
      ? { living: false, structures: true }
      : { living: shot.elevated, structures: shot.elevated },
  );
};

/** Индекс постройки в рабочем состоянии. Базы занимают первые места. */
const structureIndex = (world: WorldState, id: number): number =>
  world.structures.findIndex((entry) => entry.id === asEntityId(id));

describe('генерал как цель', () => {
  it('важнее ближайшего юнита', () => {
    // Юнит вдвое ближе генерала — и всё равно проигрывает ему ступень.
    // Это и есть суть правила: раньше в такой расстановке по генералу
    // не стреляли никогда, потому что рядом с ним всегда кто-то свой.
    const world = arrange({
      units: [unit(60, FOE, 1, 0)],
      foe: at(2, 0),
    });

    expect(targetOf(world, { range: TOWER_RANGE, elevated: true })?.kind).toBe(TargetKind.General);
  });

  it('важнее преграды, перегородившей путь', () => {
    const wall = structure(50, FOE, StructureKind.Wall, 1, 0);
    const world = arrange({ structures: [wall], foe: at(0, 1) });

    const target = targetOf(world, {
      range: UNIT_RANGE,
      elevated: false,
      blockedBy: structureIndex(world, 50),
    });

    expect(target?.kind).toBe(TargetKind.General);
  });

  it('уступает назначенной игроком цели', () => {
    const wall = structure(50, FOE, StructureKind.Wall, 1, 0);
    const world = arrange({ structures: [wall], foe: at(0, 1) });
    const wallIndex = structureIndex(world, 50);

    const target = targetOf(world, {
      range: UNIT_RANGE,
      elevated: false,
      globalTarget: wallIndex,
    });

    expect(target).toEqual({ kind: TargetKind.Structure, index: wallIndex });
  });

  it('за скалой ступень не занимает', () => {
    // Генерал ближе юнита, но закрыт скалой. Стрелок обязан перейти
    // к следующей ступени, а не отказаться от выстрела вовсе.
    const world = arrange({
      units: [unit(60, FOE, 0, 3)],
      foe: at(2, 0),
      rocks: [cellOffset(1, 0)],
    });

    expect(targetOf(world, { range: TOWER_RANGE, elevated: true })?.kind).toBe(TargetKind.Unit);
  });

  it('свой генерал целью не становится', () => {
    const world = arrange({ mine: at(1, 0), units: [unit(60, FOE, 2, 0)] });

    expect(targetOf(world, { range: TOWER_RANGE, elevated: true })?.kind).toBe(TargetKind.Unit);
  });

  it('мёртвый генерал целью не становится', () => {
    const alive = arrange({ units: [unit(60, FOE, 2, 0)], foe: at(1, 0) });
    const dead: WorldState = {
      ...alive,
      generals: alive.generals.map((general) =>
        general.owner === ME ? general : { ...general, alive: false },
      ),
    };

    expect(targetOf(alive, { range: TOWER_RANGE, elevated: true })?.kind).toBe(TargetKind.General);
    expect(targetOf(dead, { range: TOWER_RANGE, elevated: true })?.kind).toBe(TargetKind.Unit);
  });
});

describe('приоритет доходит до настоящего боя', () => {
  it('башня бьёт генерала, а стоящий ближе юнит остаётся цел', () => {
    const world = arrange({
      structures: [structure(50, ME, StructureKind.TowerBasic, 0, 0)],
      units: [unit(60, FOE, 1, 0)],
      foe: at(2, 0),
    });

    const health = world.generals.find((general) => general.owner !== ME)?.health ?? 0;
    const after = step(world, []);

    expect(after.generals.find((general) => general.owner !== ME)?.health).toBeLessThan(health);
    expect(after.units.find((entry) => entry.id === asEntityId(60))?.health).toBe(
      UNIT_STATS[UnitType.Assault].health,
    );
  });

  it('башня, юнит и генерал выбирают одного и того же', () => {
    // Все трое видят и вражеского генерала, и вражеского юнита. Если бы
    // приоритет зависел от типа стрелка, юнит получил бы хоть какой-то
    // урон — а он обязан остаться нетронутым.
    const world = arrange({
      structures: [structure(50, ME, StructureKind.TowerBasic, 0, 0)],
      units: [unit(60, ME, 0, -1), unit(61, FOE, 0, 1)],
      mine: at(-1, 0),
      foe: at(1, 0),
    });

    const health = world.generals.find((general) => general.owner !== ME)?.health ?? 0;
    const after = step(world, []);

    expect(after.units.find((entry) => entry.id === asEntityId(61))?.health).toBe(
      UNIT_STATS[UnitType.Assault].health,
    );
    // Трое стрелков за один тик: башня, юнит и генерал.
    const damage = health - (after.generals.find((general) => general.owner !== ME)?.health ?? 0);
    expect(damage).toBe(
      STRUCTURE_STATS[StructureKind.TowerBasic].attack +
        UNIT_STATS[UnitType.Assault].attack +
        GENERAL_STATS.attack,
    );
  });

  it('генерал, зашедший под башни, гибнет за считаные секунды', () => {
    // Обратная сторона правила и главная плата за него: вылазка
    // в укреплённое место теперь стоит генералу жизни. Три базовые башни
    // дают сорок пять урона в секунду против двухсот здоровья.
    const world = arrange({
      structures: [
        structure(50, ME, StructureKind.TowerBasic, 0, 0),
        structure(51, ME, StructureKind.TowerBasic, 1, 1),
        structure(52, ME, StructureKind.TowerBasic, -1, 1),
      ],
      foe: at(0, 2),
    });

    // Шесть секунд: гибели хватает четырёх с половиной, а возрождение
    // наступит только через десять после неё.
    let current = world;
    for (let tick = 0; tick < TICKS_PER_SECOND * 6; tick += 1) current = step(current, []);

    expect(current.generals.find((general) => general.owner !== ME)?.alive).toBe(false);
  });
});

describe('навесной огонь Теслы', () => {
  const TESLA_RANGE = UNIT_STATS[UnitType.Tesla].range;

  const WALL_ID = 70;
  const TOWER_ID = 71;

  /** Стена вплотную перед башней — тот самый случай из замысла. */
  const behindWall = (): WorldState =>
    arrange({
      structures: [
        structure(WALL_ID, FOE, StructureKind.Wall, 2, 0),
        structure(TOWER_ID, FOE, StructureKind.TowerBasic, 3, 0),
      ],
    });

  const towerTarget = (world: WorldState): Target => ({
    kind: TargetKind.Structure,
    index: structureIndex(world, TOWER_ID),
  });

  it('назначенная башня достаётся через стену', () => {
    const world = behindWall();

    expect(
      targetOf(world, {
        range: TESLA_RANGE,
        elevated: false,
        indirect: true,
        globalTarget: structureIndex(world, TOWER_ID),
      }),
    ).toEqual(towerTarget(world));
  });

  it('без навеса та же башня недосягаема', () => {
    // Штурмовику стена перекрывает линию огня целиком, и назначенная
    // цель за ней не выбирается вовсе. Ровно это навес и отменяет.
    const world = behindWall();

    expect(
      targetOf(world, {
        range: TESLA_RANGE,
        elevated: false,
        globalTarget: structureIndex(world, TOWER_ID),
      }),
    ).not.toEqual(towerTarget(world));
  });

  it('скала не пропускает и навес', () => {
    // Непрозрачность скалы — свойство мира, а не чья-то постройка,
    // и исключений из неё нет ни у кого.
    const world = arrange({
      structures: [structure(TOWER_ID, FOE, StructureKind.TowerBasic, 3, 0)],
      rocks: [cellOffset(2, 0)],
    });

    expect(
      targetOf(world, {
        range: TESLA_RANGE,
        elevated: false,
        indirect: true,
        globalTarget: structureIndex(world, TOWER_ID),
      }),
    ).toBeUndefined();
  });

  it('машина за стеной по-прежнему укрыта', () => {
    // Навес только по постройкам. Пусти его по живым — и Тесла из-за
    // своей стены расстреливала бы тех, кто эту стену ломает, а ответить
    // ей было бы нечем.
    const world = arrange({
      structures: [structure(WALL_ID, FOE, StructureKind.Wall, 2, 0)],
      units: [unit(80, FOE, 3, 0)],
    });

    expect(targetOf(world, { range: TESLA_RANGE, elevated: false, indirect: true })).not.toEqual({
      kind: TargetKind.Unit,
      index: 0,
    });
  });

  it('без назначенной цели ближайшей постройкой остаётся стена', () => {
    // Порядок выбора цели навес не меняет: среди построек по-прежнему
    // берётся ближайшая. Способность работает через назначенную игроком
    // цель — первую ступень и единственный прямой приказ игрока в выборе
    // цели. Тест закрепляет решение, чтобы следующий не «починил» его
    // молча, приняв за недочёт.
    const world = behindWall();

    expect(targetOf(world, { range: TESLA_RANGE, elevated: false, indirect: true })).toEqual({
      kind: TargetKind.Structure,
      index: structureIndex(world, WALL_ID),
    });
  });
});
