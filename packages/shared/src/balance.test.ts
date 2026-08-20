import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from './constants.js';
import { cellsToUnits } from './units.js';
import {
  BASE_ATTACK,
  BASE_HEALTH,
  BASE_TOWER_RANGE_CELLS,
  BASE_UNIT_COST,
  BASE_INCOME_PER_TICK,
  BUILDABLE_KINDS,
  ENERGY_SCALE,
  NUKE_COST,
  NUKE_RADIUS,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_STATS,
  UPGRADE_BRANCHES,
  UnitType,
  UpgradeTarget,
  energy,
} from './balance.js';
import { PPM_ONE, applyPpm, compoundPpm, growPpm } from './percent.js';
import { DIRECTION_SCALE, DIRECTION_VECTORS, directionTowards } from './direction.js';

/**
 * Тесты баланса сверяют числа не друг с другом, а с формулировками
 * игрового замысла: «снайпер бьёт втрое сильнее», «стена вдесятеро
 * прочнее базового», «ядерный удар стоит пятьдесят юнитов».
 *
 * Смысл именно в этом. Числа в таблице будут меняться от правки к правке,
 * а соотношения между ними — это и есть замысел, и их поломка должна
 * останавливать сборку.
 */
describe('баланс: соотношения из игрового замысла', () => {
  const assault = UNIT_STATS[UnitType.Assault];
  const sniper = UNIT_STATS[UnitType.Sniper];
  const grenadier = UNIT_STATS[UnitType.Grenadier];

  it('снайпер бьёт втрое сильнее штурмовика', () => {
    expect(sniper.attack).toBe(assault.attack * 3);
  });

  it('снайпер почти не вредит постройкам', () => {
    expect(sniper.structureDamagePercent).toBe(10);
    expect(assault.structureDamagePercent).toBe(100);
  });

  it('снайпер живучестью уступает штурмовику', () => {
    expect(sniper.health).toBe(Math.round(assault.health * 0.75));
  });

  it('снайпер и гранатомётчик стреляют втрое реже штурмовика', () => {
    expect(sniper.cooldownTicks).toBeCloseTo(assault.cooldownTicks / 0.3, 0);
    expect(grenadier.cooldownTicks).toBeCloseTo(assault.cooldownTicks / 0.3, 0);
  });

  it('гранатомётчик достаёт ровно на клетку дальше базовой башни', () => {
    const tower = STRUCTURE_STATS[StructureKind.TowerBasic];
    expect(grenadier.range).toBe(tower.range + cellsToUnits(1));
  });

  it('гранатомётчик втрое медленнее штурмовика и вдесятеро дороже', () => {
    expect(grenadier.speed).toBe(Math.round(assault.speed * 0.3));
    expect(grenadier.cost).toBe(assault.cost * 10);
  });

  it('стена вдесятеро прочнее базового здоровья', () => {
    expect(STRUCTURE_STATS[StructureKind.Wall].health).toBe(BASE_HEALTH * 10);
  });

  it('стена не стреляет', () => {
    expect(STRUCTURE_STATS[StructureKind.Wall].attack).toBe(0);
  });

  it('снайперская башня бьёт дальше базовой', () => {
    expect(STRUCTURE_STATS[StructureKind.TowerSniper].range).toBeGreaterThan(
      STRUCTURE_STATS[StructureKind.TowerBasic].range,
    );
  });

  it('снайперская башня перекрывает гранатомётчика по дальности', () => {
    expect(STRUCTURE_STATS[StructureKind.TowerSniper].range).toBeGreaterThan(grenadier.range);
  });

  it('ядерный удар стоит пятьдесят базовых юнитов', () => {
    expect(NUKE_COST).toBe(BASE_UNIT_COST * 50);
  });

  it('радиус ядерного удара — две базовые дальности башни', () => {
    expect(NUKE_RADIUS).toBe(cellsToUnits(BASE_TOWER_RANGE_CELLS * 2));
  });

  it('базовая атака и базовое здоровье достались штурмовику без изменений', () => {
    expect(assault.attack).toBe(BASE_ATTACK);
    expect(assault.health).toBe(BASE_HEALTH);
  });
});

describe('баланс: время возведения', () => {
  /**
   * У постройки два ограничителя: цена — сколько её копить, и время
   * возведения — сколько рядом с ней стоять. Работает тот, который длиннее,
   * поэтому оба сравниваются в одной единице: в тиках при базовом доходе.
   */
  const savingTicks = (kind: StructureKind): number =>
    STRUCTURE_STATS[kind].cost / BASE_INCOME_PER_TICK;

  it('время возведения перестало быть незначимым ни у одной постройки', () => {
    // Главное свойство изменения. До него стена возводилась полсекунды
    // против двух секунд накопления, то есть время не значило ничего.
    for (const kind of BUILDABLE_KINDS) {
      expect(STRUCTURE_STATS[kind].buildTicks).toBeGreaterThanOrEqual(savingTicks(kind) / 2);
    }
  });

  it('стену ограничивает время, а не цена', () => {
    // Стена стоит две секунды дохода: ценой её не ограничить в принципе.
    expect(STRUCTURE_STATS[StructureKind.Wall].buildTicks).toBeGreaterThan(
      savingTicks(StructureKind.Wall),
    );
  });

  it('у базовой башни цена и время сравнялись', () => {
    expect(STRUCTURE_STATS[StructureKind.TowerBasic].buildTicks).toBe(
      savingTicks(StructureKind.TowerBasic),
    );
  });

  it('снайперскую башню по-прежнему ограничивает цена', () => {
    // Так и задумано: дорогое специализированное сооружение. От времени
    // требовалось лишь перестать быть незаметным.
    expect(STRUCTURE_STATS[StructureKind.TowerSniper].buildTicks).toBeLessThan(
      savingTicks(StructureKind.TowerSniper),
    );
  });
});

describe('баланс: энергия', () => {
  it('масштаб энергии равен числу тиков в секунде', () => {
    // Ровно из-за этого доход в N единиц в секунду даёт целое число
    // внутренних единиц за тик и не требует накопителя дробной части.
    expect(ENERGY_SCALE).toBe(TICKS_PER_SECOND);
  });

  it('базовый доход даёт десять видимых единиц в секунду', () => {
    expect(BASE_INCOME_PER_TICK * TICKS_PER_SECOND).toBe(energy(10));
  });
});

describe('баланс: ветки прокачки', () => {
  it('покрывают все типы юнитов, башен, стену, генерала и экономику', () => {
    const targets = new Set(UPGRADE_BRANCHES.map((entry) => entry.target));

    expect(targets).toEqual(
      new Set([
        UpgradeTarget.UnitAssault,
        UpgradeTarget.UnitSniper,
        UpgradeTarget.UnitGrenadier,
        UpgradeTarget.TowerBasic,
        UpgradeTarget.TowerSniper,
        UpgradeTarget.Wall,
        UpgradeTarget.General,
        UpgradeTarget.Economy,
      ]),
    );
  });

  it('экономика дорожает на 25 процентов, прочие ветки на 10', () => {
    for (const entry of UPGRADE_BRANCHES) {
      expect(entry.costGrowthPercent).toBe(entry.target === UpgradeTarget.Economy ? 25 : 10);
    }
  });

  it('у каждой ветки положительная цена и ненулевой эффект', () => {
    for (const entry of UPGRADE_BRANCHES) {
      expect(entry.baseCost).toBeGreaterThan(0);
      expect(entry.effectPercent).not.toBe(0);
    }
  });
});

describe('сложные проценты', () => {
  it('прогрессия не замирает на малых величинах', () => {
    // Ровно та ловушка, ради которой множитель и хранится в миллионных
    // долях: наивное `floor(10 * 102 / 100)` вернуло бы те же 10 навсегда.
    let multiplier = PPM_ONE;
    for (let step = 0; step < 20; step += 1) {
      multiplier = growPpm(multiplier, 2);
    }

    expect(applyPpm(10, multiplier)).toBe(14);
  });

  it('двадцать шагов по два процента дают примерно полуторный множитель', () => {
    // 1,02^20 = 1,4859...
    expect(compoundPpm(2, 20)).toBeGreaterThan(1_485_000);
    expect(compoundPpm(2, 20)).toBeLessThan(1_486_000);
  });

  it('отрицательный процент уменьшает множитель', () => {
    expect(compoundPpm(-6, 10)).toBeLessThan(PPM_ONE);
  });

  it('ноль шагов оставляет множитель единичным', () => {
    expect(compoundPpm(5, 0)).toBe(PPM_ONE);
    expect(applyPpm(123, PPM_ONE)).toBe(123);
  });

  it('два убийства подряд усиливают башню сложным процентом', () => {
    // 1,05^2 = 1,1025 — это и отличает сложный процент от простого,
    // который дал бы 1,10.
    expect(compoundPpm(5, 2)).toBe(1_102_500);
  });
});

describe('направления', () => {
  it('диагональ имеет ту же длину, что и прямая', () => {
    for (let index = 1; index < DIRECTION_VECTORS.length; index += 1) {
      const vector = DIRECTION_VECTORS[index];
      if (vector === undefined) continue;

      const length = Math.hypot(vector.x, vector.y);
      // Допуск в одну единицу из тысячи: 707 — округлённый корень из двух
      // пополам, точнее целыми числами не выразить.
      expect(Math.abs(length - DIRECTION_SCALE)).toBeLessThanOrEqual(1);
    }
  });

  it('нулевой вектор означает остановку', () => {
    expect(directionTowards(0, 0)).toBe(0);
  });

  it('выбирает ближайшее направление', () => {
    expect(DIRECTION_VECTORS[directionTowards(1000, 0)]).toEqual({ x: 1000, y: 0 });
    expect(DIRECTION_VECTORS[directionTowards(-5, -5)]).toEqual({ x: -707, y: -707 });
    expect(DIRECTION_VECTORS[directionTowards(0, 42)]).toEqual({ x: 0, y: 1000 });
  });
});
