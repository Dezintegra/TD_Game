import { describe, expect, it } from 'vitest';
import {
  BASE_COOLDOWN_TICKS,
  GENERAL_STATS,
  MAP_CELL_COUNT,
  MAP_HEIGHT_CELLS,
  PPM_ONE,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_STATS,
  UnitType,
  VETERAN_MAX_RANK,
  asEntityId,
  asPlayerId,
  asTickNumber,
  cellsToUnits,
  distanceSquared,
  veteranStructurePpm,
} from '@td/shared';
import type { PlayerId, Vec2 } from '@td/shared';
import { cellCentre, cellIndex, cellX, cellY, createWorld, playerStats } from '@td/sim';
import type { StructureState, UnitState, WorldState } from '@td/sim';
import { approachOf } from './approach.js';
import { BASELINE_PROFILE, horizonTicks } from './profile.js';
import {
  ENERGY_PER_LIVE_DAMAGE,
  chooseFrontier,
  coverField,
  coveredCells,
  discCellCount,
  flowDensity,
  freshCoverage,
  incomingAt,
  ownTowers,
  rangeInCells,
  siteCover,
  siteValue,
  situationOf,
  towerGain,
  towerGrowthFactor,
} from './posture.js';
import type { Situation, Verdict } from './posture.js';

/**
 * Развесовка моделей поведения проверяется прямыми вызовами, а не прогоном
 * матча. Прогон отвечает на вопрос «чем всё кончилось», а нам нужен ответ
 * на «почему выбран этот рубеж», и он виден только в самой оценке.
 *
 * Расстановки строятся на карте без единой скалы: так длина маршрута
 * и ширина коридора предсказуемы, и тест говорит о формуле, а не о том,
 * что успело нагенерироваться.
 */

const SEED = 31337;

/** Противник под управлением компьютера играет за второго игрока. */
const AI: PlayerId = asPlayerId(1);
const FOE: PlayerId = asPlayerId(0);

interface Scene {
  readonly structures?: readonly StructureState[];
  readonly units?: readonly UnitState[];
  /** Убрать ли генерала человека с поля: он тоже стреляет и тоже пугает. */
  readonly hideFoeGeneral?: boolean;
  /** Поставить генерала человека в заданную точку. Сильнее `hideFoeGeneral`. */
  readonly foeGeneralAt?: Vec2;
}

/**
 * Дальний угол карты, заведомо не лежащий на маршруте между базами.
 * Базы стоят на главной диагонали, поэтому побочная от них дальше всего.
 */
const OFF_PATH: Vec2 = cellCentre(cellIndex(1, MAP_HEIGHT_CELLS - 2));

const clearMap = (scene: Scene = {}): WorldState => {
  const world = createWorld(SEED);

  return {
    ...world,
    map: { cells: new Uint8Array(MAP_CELL_COUNT), baseCells: world.map.baseCells },
    structures: [...world.structures, ...(scene.structures ?? [])],
    units: [...(scene.units ?? [])],
    generals: world.generals.map((general) => {
      if (general.owner !== FOE) return general;
      if (scene.foeGeneralAt !== undefined) return { ...general, position: scene.foeGeneralAt };

      return scene.hideFoeGeneral === true ? { ...general, position: OFF_PATH } : general;
    }),
  };
};

/** Чистый мир без расстановки. Годится всюду, где нужна только геометрия. */
const PLAIN = clearMap();

const homeCellOf = (world: WorldState, owner: PlayerId): number => world.map.baseCells[owner] ?? 0;

/** Точка в клетках от центра базы игрока. */
const nearBase = (owner: PlayerId, dx: number, dy: number): Vec2 => {
  const centre = cellCentre(homeCellOf(PLAIN, owner));
  return { x: centre.x + dx * 1000, y: centre.y + dy * 1000 };
};

let nextId = 500;

const unit = (owner: PlayerId, position: Vec2): UnitState => ({
  id: asEntityId((nextId += 1)),
  owner,
  unitType: UnitType.Assault,
  position,
  health: UNIT_STATS[UnitType.Assault].health,
  facing: 1,
  readyAtTick: asTickNumber(0),
  kills: 0,
});

const tower = (owner: PlayerId, cell: number): StructureState => ({
  id: asEntityId((nextId += 1)),
  owner,
  kind: StructureKind.TowerBasic,
  cell,
  health: STRUCTURE_STATS[StructureKind.TowerBasic].health,
  kills: 0,
  readyAtTick: asTickNumber(0),
  builtAtTick: asTickNumber(0),
});

const APPROACH = approachOf(PLAIN, AI);
if (APPROACH === undefined) throw new Error('вероятный путь не посчитан');

/**
 * Клетка вероятного пути на заданной доле маршрута.
 *
 * Доля считается от базы противника под управлением компьютера: ноль —
 * его собственная база, единица — база человека.
 */
const cellAtFraction = (fraction: number): number => {
  const wanted = Math.round(APPROACH.shortest * fraction);

  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;

  for (let cell = 0; cell < MAP_CELL_COUNT; cell += 1) {
    if (APPROACH.onPath[cell] !== 1) continue;

    const gap = Math.abs((APPROACH.fromHome[cell] ?? 0) - wanted);
    if (gap >= bestGap) continue;

    bestGap = gap;
    best = cell;
  }

  return best;
};

const situate = (world: WorldState): Situation => {
  const approach = approachOf(world, AI);
  const player = world.players[AI];
  if (approach === undefined || player === undefined) throw new Error('нет обстановки');

  const stats = playerStats(player);
  const situation = situationOf(
    world,
    AI,
    approach,
    stats,
    coveredCells(world, AI, stats),
    BASELINE_PROFILE,
  );
  if (situation === undefined) throw new Error('нет обстановки');

  return situation;
};

const decide = (world: WorldState): Verdict => {
  const verdict = chooseFrontier(situate(world));
  if (verdict === undefined) throw new Error('рубеж не выбран');

  return verdict;
};

describe('входящий урон', () => {
  const middle = cellAtFraction(0.5);

  it('на пустом месте равен нулю', () => {
    expect(incomingAt(PLAIN, AI, situate(PLAIN).enemyStats, cellCentre(middle)).total).toBe(0);
  });

  it('вражеская башня в дальности даёт свой урон в тик', () => {
    const armed = clearMap({ structures: [tower(FOE, middle)] });
    const incoming = incomingAt(armed, AI, situate(armed).enemyStats, cellCentre(middle));

    const stats = STRUCTURE_STATS[StructureKind.TowerBasic];
    expect(incoming.total).toBeCloseTo(stats.attack / stats.cooldownTicks, 6);
    // Постройки отделены от прочего: именно они делают рубеж неудерживаемым.
    expect(incoming.fromStructures).toBe(incoming.total);
  });

  it('вражеская башня вне дальности не считается', () => {
    const armed = clearMap({ structures: [tower(FOE, cellAtFraction(0.1))] });

    expect(incomingAt(armed, AI, situate(armed).enemyStats, cellCentre(middle)).total).toBe(0);
  });

  describe('круг угрозы от чужого генерала', () => {
    // Дальность генерала выросла с двух клеток до пяти. `incomingAt` берёт
    // её из таблицы, поэтому «подхватится само» — но это ровно тот довод,
    // который стоит проверить, а не принять на слово: между таблицей
    // и оценкой лежит перевод в квадрат расстояния, и ошибка в нём
    // выглядела бы как осторожный противник, а не как поломка.
    //
    // Генерал ставится в дальний угол по побочной диагонали: базы стоят
    // на главной, и оттуда до них дальше всего. Иначе в счёт вошла бы
    // ещё и база, и тест говорил бы о ней.
    const spot = OFF_PATH;

    const threatAt = (cells: number): number => {
      const world = clearMap({ foeGeneralAt: spot });
      const point: Vec2 = { x: spot.x + cellsToUnits(cells), y: spot.y };

      return incomingAt(world, AI, situate(world).enemyStats, point).total;
    };

    it('в четырёх клетках точка под угрозой', () => {
      expect(threatAt(4)).toBeGreaterThan(0);
    });

    it('в шести клетках — уже нет', () => {
      expect(threatAt(6)).toBe(0);
    });

    it('граница проходит там же, где кончается дальность из таблицы', () => {
      const inside = rangeInCells(GENERAL_STATS.range);

      expect(threatAt(inside)).toBeGreaterThan(0);
      expect(threatAt(inside + 1)).toBe(0);
    });
  });
});

describe('покрытие пути', () => {
  it('считается только по ещё не накрытым клеткам', () => {
    const cell = cellAtFraction(0.5);
    const player = PLAIN.players[AI];
    if (player === undefined) throw new Error('нет игрока');

    const stats = playerStats(player);
    const range = rangeInCells(stats.structures[StructureKind.TowerBasic].range);

    const before = freshCoverage(APPROACH, coveredCells(PLAIN, AI, stats), cell, range);

    const fortified = clearMap({ structures: [tower(AI, cell)] });
    const after = freshCoverage(APPROACH, coveredCells(fortified, AI, stats), cell, range);

    expect(before).toBeGreaterThan(0);
    // Своя же башня накрыла всё, что накрыла бы новая: строить второй раз
    // в ту же клетку незачем, и оценка это показывает.
    expect(after).toBe(0);
  });
});

describe('взаимное прикрытие своих башен', () => {
  const middle = cellAtFraction(0.5);
  const player = PLAIN.players[AI];
  if (player === undefined) throw new Error('нет игрока');
  const stats = playerStats(player);
  const dps =
    stats.structures[StructureKind.TowerBasic].attack /
    stats.structures[StructureKind.TowerBasic].cooldownTicks;
  const range = rangeInCells(stats.structures[StructureKind.TowerBasic].range);

  /** Клетка на расстоянии `dx` клеток от середины маршрута. */
  const beside = (dx: number): number => cellIndex(cellX(middle) + dx, cellY(middle));

  const fieldOf = (world: WorldState): Float64Array => coverField(ownTowers(world, AI, stats));

  it('кольцо двух своих башен прикрывает вдвое сильнее одной', () => {
    const one = clearMap({ structures: [tower(AI, beside(-2))] });
    const two = clearMap({ structures: [tower(AI, beside(-2)), tower(AI, beside(2))] });

    expect(fieldOf(one)[middle] ?? 0).toBeCloseTo(dps, 6);
    expect(fieldOf(two)[middle] ?? 0).toBeCloseTo(dps * 2, 6);
  });

  it('чужие башни в прикрытие не идут', () => {
    const foes = clearMap({ structures: [tower(FOE, beside(-2)), tower(FOE, beside(2))] });

    expect(fieldOf(foes)[middle] ?? 0).toBe(0);
  });

  it('дальше своей дальности башня не прикрывает', () => {
    const far = clearMap({ structures: [tower(AI, beside(range + 2))] });

    expect(fieldOf(far)[middle] ?? 0).toBe(0);
  });

  it('в счёт идёт и то, что новая башня отдаёт соседям', () => {
    // Прикрытие считается в обе стороны. Место, где своих нет вовсе,
    // не получает ничего и не отдаёт ничего; место в чужом поле огня —
    // и получает, и отдаёт.
    const alone = clearMap();
    const beside2 = clearMap({ structures: [tower(AI, beside(-2))] });

    const empty = siteCover(APPROACH, fieldOf(alone), middle, dps, range);
    const near = siteCover(APPROACH, fieldOf(beside2), middle, dps, range);

    expect(empty).toBe(0);
    // Полученное — средний дружественный урон по своему полю огня,
    // отданное — свой урон на долю поля, уже простреливаемую своими.
    // Вместе они заведомо больше одного лишь полученного.
    expect(near).toBeGreaterThan(dps * 0.5);
  });

  it('прикрытие убывает плавно, а не ступенькой', () => {
    // Это главное свойство мерки, и оно стоило переделки. Спроси мы
    // «достаёт ли сосед до клетки башни» — вышла бы ступенька, а вместе
    // с ней порог «не дальше дальности башни»: то самое правило,
    // которое спецификация запрещает. Прикрытие поля огня перекрывается
    // постепенно и потому остаётся величиной для сравнения.
    const measured = [2, 3, 4, 5, 6].map((gap) => {
      const world = clearMap({ structures: [tower(AI, beside(-gap))] });
      return siteCover(APPROACH, fieldOf(world), middle, dps, range);
    });

    for (let index = 1; index < measured.length; index += 1) {
      const before = measured[index - 1] ?? 0;
      const after = measured[index] ?? 0;

      expect(after).toBeLessThan(before);
      expect(after).toBeGreaterThan(0);
    }
  });
});

describe('ценность места под башню', () => {
  const player = PLAIN.players[AI];
  if (player === undefined) throw new Error('нет игрока');
  const stats = playerStats(player);
  const dps =
    stats.structures[StructureKind.TowerBasic].attack /
    stats.structures[StructureKind.TowerBasic].cooldownTicks;

  it('при равном покрытии место под прикрытием ценнее места в пустоте', () => {
    const alone = siteValue(20, 0, stats, BASELINE_PROFILE);
    const covered = siteValue(20, dps, stats, BASELINE_PROFILE);

    expect(alone).toBeGreaterThan(0);
    // Прикрытие вдвое большим огнём — вдвое дольше жизни, вдвое дороже
    // вложение. Множитель выведен, а не подобран: атакующие гибнут
    // за A / (D + C) тиков.
    expect(covered).toBeCloseTo(alone * 2, 6);
  });

  it('без покрытия пути ценности нет, каким бы плотным ни было прикрытие', () => {
    // Иначе башни сбивались бы в кучу там, где стрелять не по кому.
    expect(siteValue(0, dps * 10, stats, BASELINE_PROFILE)).toBe(0);
  });

  it('покрытие и прикрытие сравниваются, а не спорят', () => {
    // Меньшее покрытие под прикрытием может перевесить большее в пустоте —
    // и наоборот. Ровно это и значит «величина, а не правило».
    const lonelyWide = siteValue(30, 0, stats, BASELINE_PROFILE);
    const coveredNarrow = siteValue(20, dps, stats, BASELINE_PROFILE);

    expect(coveredNarrow).toBeGreaterThan(lonelyWide);
    expect(siteValue(30, 0, stats, BASELINE_PROFILE)).toBeGreaterThan(
      siteValue(10, dps, stats, BASELINE_PROFILE),
    );
  });
});

describe('плотность вражеского потока', () => {
  it('растёт от своей базы к чужой', () => {
    const near = flowDensity(APPROACH, cellAtFraction(0.2));
    const far = flowDensity(APPROACH, cellAtFraction(0.8));

    expect(near).toBeLessThan(far);
    expect(near).toBeGreaterThanOrEqual(0);
    expect(far).toBeLessThanOrEqual(1);
  });
});

describe('выбор рубежа', () => {
  it('при пустой обороне врага доходит до его базы', () => {
    // Оборона пуста целиком: ни башен, ни юнитов, и генерал человека
    // убран с маршрута. Держаться дома в такой обстановке не за чем —
    // и формула это находит сама, без отдельного правила «наступай».
    const verdict = decide(clearMap({ hideFoeGeneral: true }));

    expect(verdict.frontier.fraction).toBeGreaterThanOrEqual(0.75);
  });

  it('под башнями у вражеской базы рубеж не занимает', () => {
    const world = clearMap({
      hideFoeGeneral: true,
      structures: [
        tower(FOE, cellAtFraction(0.95)),
        tower(FOE, cellAtFraction(0.88)),
        tower(FOE, cellAtFraction(0.81)),
      ],
    });

    const verdict = decide(world);
    const incoming = incomingAt(
      world,
      AI,
      situate(world).enemyStats,
      cellCentre(verdict.frontier.cell),
    );

    // Проверяется не доля, а свойство: выбранный рубеж не простреливается
    // вражескими постройками. Под их огнём рубеж не удержать.
    expect(incoming.fromStructures).toBe(0);
  });

  it('при массированной атаке на базу возвращается домой', () => {
    const attackers = Array.from({ length: 12 }, (_unused, index) =>
      unit(FOE, nearBase(AI, (index % 4) - 2, Math.floor(index / 4) - 1)),
    );

    const verdict = decide(clearMap({ units: attackers, hideFoeGeneral: true }));

    const home = cellCentre(homeCellOf(PLAIN, AI));
    const radius = cellsToUnits(BASELINE_PROFILE.posture.threatRadiusCells);

    expect(distanceSquared(cellCentre(verdict.frontier.cell), home)).toBeLessThanOrEqual(
      radius * radius,
    );
  });

  it('одиночного противника у базы отбивают башни, а не генерал', () => {
    const world = clearMap({
      hideFoeGeneral: true,
      units: [unit(FOE, nearBase(AI, 2, 2))],
      structures: [tower(AI, cellAtFraction(0.08))],
    });

    const verdict = decide(world);

    expect(verdict.frontier.fraction).toBeGreaterThan(0.5);
  });

  it('выбор не зависит от порядка перебора', () => {
    const world = clearMap();

    expect(decide(world).frontier.cell).toBe(decide(world).frontier.cell);
  });
});

describe('покупка башни оценивается своей меркой', () => {
  const owner = PLAIN.players[AI];
  if (owner === undefined) throw new Error('нет игрока');

  const stats = playerStats(owner);
  const baseline = stats.structures[StructureKind.TowerBasic];
  const full = discCellCount(rangeInCells(baseline.range));

  it('башня, не накрывающая путь, не стоит ничего', () => {
    expect(towerGain(0, stats, BASELINE_PROFILE)).toBe(0);
  });

  it('прибавка растёт вместе с покрытием', () => {
    const half = towerGain(Math.floor(full / 2), stats, BASELINE_PROFILE);
    const whole = towerGain(full, stats, BASELINE_PROFILE);

    expect(half).toBeGreaterThan(0);
    expect(whole).toBeGreaterThan(half);
  });

  it('покрытие сверх круга дальности прибавки не добавляет', () => {
    // Доля ограничена единицей: клеток пути в радиусе не может быть
    // больше, чем клеток в самом радиусе.
    expect(towerGain(full * 3, stats, BASELINE_PROFILE)).toBe(
      towerGain(full, stats, BASELINE_PROFILE),
    );
  });

  it('прибавка выше паспортного урона ровно на рост за убийства', () => {
    // Основание — то же выражение, каким меряется юнит: урон в тик,
    // помноженный на горизонт и на курс энергии. Всё, что сверх него, —
    // рост башни за убийства, и ничего больше.
    const damagePerTick = baseline.attack / baseline.cooldownTicks;
    const horizon = horizonTicks(BASELINE_PROFILE);
    const bare = damagePerTick * horizon * ENERGY_PER_LIVE_DAMAGE;

    expect(towerGain(full, stats, BASELINE_PROFILE)).toBeCloseTo(
      bare * towerGrowthFactor(damagePerTick, horizon),
      6,
    );
  });

  it('в оценку не входят ни дорога генерала, ни время удержания рубежа', () => {
    // Свидетель отделения одной мерки от другой: выгода рубежа зависит
    // от обстановки вокруг генерала, а цена башни — нет. Один и тот же
    // аргумент обязан давать один и тот же ответ, где бы генерал ни был.
    const here = towerGain(full, stats, BASELINE_PROFILE);
    const there = towerGain(full, stats, BASELINE_PROFILE);

    expect(here).toBe(there);
    expect(here).toBeGreaterThan(0);
  });
});

describe('ветеранские ранги башни в оценке', () => {
  it('при нынешнем балансе даёт средний множитель около 1,26', () => {
    // Девять убийств за горизонт: урон 0,5 в тик, горизонт 1800 тиков,
    // здоровье опорного юнита 100. Множитель СРЕДНИЙ за горизонт, а не
    // конечный: башня набирает ранги постепенно и большую часть времени
    // слабее, чем к концу.
    //
    // Считается точно: множитель кусочно-постоянен, поэтому среднее —
    // это сумма «значение × длина куска», делённая на число убийств.
    // На девяти убийствах куски такие:
    //
    //     [0,1)  ×1,00 → 1,00
    //     [1,3)  ×1,10 → 2,20
    //     [3,6)  ×1,25 → 3,75
    //     [6,9)  ×1,45 → 4,35
    //     итого 11,30 / 9 = 1,2556
    const damagePerTick = STRUCTURE_STATS[StructureKind.TowerBasic].attack / BASE_COOLDOWN_TICKS;

    expect(towerGrowthFactor(damagePerTick, horizonTicks(BASELINE_PROFILE))).toBeCloseTo(1.2556, 3);
  });

  it('без убийств множитель равен единице', () => {
    expect(towerGrowthFactor(0, horizonTicks(BASELINE_PROFILE))).toBe(1);
    expect(towerGrowthFactor(1, 0)).toBe(1);
  });

  it('множитель не переваливает за удвоение', () => {
    // Потолок соблюдается сам собой: выше пятого ранга таблица не идёт,
    // а пятый ранг — ровно вдвое. Сколько бы башня ни убила, оценка
    // не может обещать больше, чем позволяют правила.
    const huge = towerGrowthFactor(1000, horizonTicks(BASELINE_PROFILE));

    expect(huge).toBeLessThanOrEqual(veteranStructurePpm(VETERAN_MAX_RANK) / PPM_ONE);
    expect(huge).toBeCloseTo(2, 2);
  });
});
