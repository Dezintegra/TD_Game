import { describe, expect, it } from 'vitest';
import {
  BLAST_LIFETIME_TICKS,
  BlastKind,
  DIRECTION_SOUTH,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  StructureKind,
  UnitType,
  asEntityId,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import { createWorld } from './world.js';
import type { BlastState, GeneralState, StructureState, UnitState, WorldState } from './world.js';
import { step } from './step.js';
import { checksum } from './checksum.js';
import { cellCentre, cellIndex } from './map.js';

/**
 * Записи о взрывах.
 *
 * Проверяется ровно одно: что ядро сообщает наружу о каждой гибели.
 * Как это выглядит — забота отрисовки, и здесь про облик нет ни слова.
 *
 * Расстановки готовятся точечно, как и в проверках боя: мир создаётся
 * обычным способом, а нужные сущности помещаются в него руками. Так тест
 * говорит о правиле, а не о том, что успело нагенерироваться на карте.
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

const unit = (id: number, owner: number, dx: number, dy: number, health: number): UnitState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  unitType: UnitType.Assault,
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
  demolishAtTick = 0,
): StructureState => ({
  id: asEntityId(id),
  owner: asPlayerId(owner),
  kind,
  cell: cellOffset(dx, dy),
  health,
  kills: 0,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
  demolishAtTick: asTickNumber(demolishAtTick),
  facing: DIRECTION_SOUTH,
});

interface Arrangement {
  readonly structures?: readonly StructureState[];
  readonly units?: readonly UnitState[];
  /** Генерал нулевого игрока: куда его поставить и с каким здоровьем. */
  readonly general?: { readonly dx: number; readonly dy: number; readonly health: number };
  readonly nukeAtTick?: number;
}

/**
 * Расстановка на карте без единой скалы.
 *
 * Скалы убраны по той же причине, что и в проверках боя: генерация кладёт
 * их куда угодно, а случайная скала между стрелком и целью отменила бы
 * выстрел — и тест поймал бы карту, а не правило.
 */
const arrange = (setup: Arrangement): WorldState => {
  const world = createWorld(SEED);

  const generals: GeneralState[] =
    setup.general === undefined
      ? world.generals
      : world.generals.map((general, index) =>
          index === 0
            ? {
                ...general,
                position: at(setup.general?.dx ?? 0, setup.general?.dy ?? 0),
                health: setup.general?.health ?? general.health,
              }
            : general,
        );

  return {
    ...world,
    map: { cells: new Uint8Array(MAP_CELL_COUNT), baseCells: world.map.baseCells },
    structures: [...world.structures, ...(setup.structures ?? [])],
    units: [...(setup.units ?? [])],
    generals,
    nukes:
      setup.nukeAtTick === undefined
        ? []
        : [
            {
              id: asEntityId(900),
              owner: asPlayerId(0),
              cell: FIELD,
              detonateAtTick: asTickNumber(setup.nukeAtTick),
            },
          ],
  };
};

const blastsOf = (world: WorldState, kind: BlastKind): readonly BlastState[] =>
  world.blasts.filter((blast) => blast.kind === kind);

describe('запись о взрыве', () => {
  it('остаётся от погибшего юнита', () => {
    const world = arrange({
      structures: [structure(50, 0, StructureKind.TowerBasic, 0, 0, 200)],
      units: [unit(60, 1, 1, 0, 1)],
    });

    const after = step(world, []);
    const blasts = blastsOf(after, BlastKind.Unit);

    expect(after.units).toHaveLength(0);
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.owner).toBe(asPlayerId(1));

    // Взрыв стоит там, где юнит погиб, а не там, где он был в начале тика:
    // движение идёт раньше стрельбы, и за тик машина успевает сдвинуться
    // на малую долю клетки. Отсюда и допуск в полклетки вместо равенства.
    const start = at(1, 0);
    expect(Math.abs((blasts[0]?.at.x ?? 0) - start.x)).toBeLessThan(500);
    expect(Math.abs((blasts[0]?.at.y ?? 0) - start.y)).toBeLessThan(500);
  });

  it('остаётся от погибшей постройки', () => {
    const world = arrange({
      structures: [structure(51, 1, StructureKind.Wall, 0, 0, 1)],
      units: [unit(61, 0, 1, 0, 10_000)],
    });

    const after = step(world, []);
    const blasts = blastsOf(after, BlastKind.Structure);

    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.owner).toBe(asPlayerId(1));
    expect(blasts[0]?.at).toEqual(cellCentre(cellOffset(0, 0)));
  });

  it('остаётся от погибшего генерала', () => {
    const world = arrange({
      general: { dx: 0, dy: 0, health: 1 },
      units: [unit(62, 1, 1, 0, 10_000)],
    });

    const after = step(world, []);

    expect(after.generals[0]?.alive).toBe(false);
    expect(blastsOf(after, BlastKind.General)).toHaveLength(1);
  });

  it('не остаётся от разобранной по приказу постройки', () => {
    const world = arrange({
      structures: [structure(52, 0, StructureKind.Wall, 0, 0, 1, 1)],
    });

    const after = step(world, []);

    expect(after.structures.some((entry) => entry.id === asEntityId(52))).toBe(false);
    expect(after.blasts).toHaveLength(0);
  });

  it('живёт свой срок и исчезает', () => {
    const world = arrange({
      structures: [structure(53, 0, StructureKind.TowerBasic, 0, 0, 200)],
      units: [unit(63, 1, 1, 0, 1)],
    });

    let current = step(world, []);
    expect(current.blasts).toHaveLength(1);

    const expiresAt = current.blasts[0]?.expiresAtTick ?? 0;
    expect(expiresAt).toBe(current.tick + BLAST_LIFETIME_TICKS[BlastKind.Unit]);

    while (current.tick < expiresAt - 1) current = step(current, []);
    expect(current.blasts).toHaveLength(1);

    current = step(current, []);
    expect(current.blasts).toHaveLength(0);
  });

  it('в контрольную сумму не входит', () => {
    const world = createWorld(SEED);
    const withBlast: WorldState = {
      ...world,
      blasts: [
        {
          at: at(0, 0),
          kind: BlastKind.Nuke,
          owner: asPlayerId(0),
          expiresAtTick: asTickNumber(100),
        },
      ],
    };

    expect(checksum(withBlast)).toBe(checksum(world));
  });
});

describe('запись о взрыве при ядерном ударе', () => {
  /**
   * Удар кладётся в мир готовым, а не отдаётся командой.
   *
   * Разница в трёх секундах ожидания: за них юниты успевают отойти,
   * а расставленные друг против друга — ещё и перестрелять друг друга.
   * Тест про записи, а не про то, кто кого переживёт, поэтому взрыв
   * происходит на первом же тике.
   */
  const detonate = (setup: Arrangement): WorldState =>
    step(arrange({ ...setup, nukeAtTick: 1 }), []);

  it('оставляет запись в эпицентре', () => {
    const after = detonate({});
    const blasts = blastsOf(after, BlastKind.Nuke);

    expect(after.nukes).toHaveLength(0);
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.at).toEqual(cellCentre(FIELD));
  });

  it('оставляет запись каждому погибшему в радиусе', () => {
    // Юниты одной стороны: разные стороны успели бы обменяться выстрелами
    // ещё до взрыва, и счёт погибших перестал бы быть проверяемым.
    const after = detonate({
      units: [unit(70, 0, 0, 0, 100), unit(71, 0, 1, 0, 100)],
      structures: [structure(54, 1, StructureKind.Wall, 0, 1, 500)],
    });

    expect(after.units).toHaveLength(0);
    expect(blastsOf(after, BlastKind.Unit)).toHaveLength(2);
    expect(blastsOf(after, BlastKind.Structure)).toHaveLength(1);
    expect(blastsOf(after, BlastKind.Nuke)).toHaveLength(1);
  });
});
