import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_INCOME_PER_TICK,
  GENERAL_STATS,
  SEPARATION_WALL_CLEARANCE,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_SEPARATION_RADIUS,
  UNIT_STATS,
  UnitType,
} from './balance.js';
import { BASE_INSET_CELLS, MAP_CELL_COUNT, MAP_WIDTH_CELLS } from './constants.js';
import { applyRuleTuning, resetRuleTuning, ruleTuningIsNeutral } from './rules.js';

/**
 * Настройка правил.
 *
 * Проверок здесь два вида, и второй важнее первого.
 *
 * Первый: заказанное доехало. Множитель обязан сдвинуть не только корень,
 * но и всё, что из корня выведено, — иначе замер получит мир, где доход
 * новый, а решения противника считаются по старому.
 *
 * Второй: незаказанное не сдвинулось. Это и есть главная опасность
 * подвижных правил. Множитель прочности башен не смеет тронуть стену
 * и базу, множитель скорости — цены, множитель карты — вообще ничего,
 * кроме карты. Без этих проверок «прочность башен ×2» тихо означало бы
 * «и база ×2», а вывод замера был бы про сумму двух правок.
 */

afterEach(() => {
  // Правила глобальны на весь процесс, поэтому возвращаются после каждой
  // проверки. Иначе следующий файл тестов начался бы в чужом мире.
  resetRuleTuning();
});

describe('настройка правил', () => {
  it('без вызова оставляет правила задуманными', () => {
    expect(ruleTuningIsNeutral()).toBe(true);
    expect(BASE_INCOME_PER_TICK).toBe(10);
    expect(MAP_WIDTH_CELLS).toBe(38);
    expect(UNIT_STATS[UnitType.Assault].speed).toBe(67);
  });

  it('доход двигается и остаётся целым', () => {
    applyRuleTuning({ income: 1.5 });
    expect(BASE_INCOME_PER_TICK).toBe(15);

    applyRuleTuning({ income: 2 });
    expect(BASE_INCOME_PER_TICK).toBe(20);
  });

  it('скорость тянет за собой Теслу и генерала', () => {
    // Связи замысла: Тесла идёт треть базовой скорости, генерал — полторы.
    // Они обязаны сохраниться, иначе «ускорить войско» означало бы заодно
    // «переставить Теслу и генерала относительно него».
    applyRuleTuning({ speed: 1.5 });

    expect(UNIT_STATS[UnitType.Assault].speed).toBe(101);
    expect(UNIT_STATS[UnitType.Tesla].speed).toBe(Math.round(101 * 0.3));
    expect(GENERAL_STATS.speed).toBe(Math.round(101 * 1.5));
  });

  it('прочность трогает стреляющие постройки и не трогает прочие', () => {
    const wall = STRUCTURE_STATS[StructureKind.Wall].health;
    const base = STRUCTURE_STATS[StructureKind.Base].health;

    applyRuleTuning({ towerHealth: 2 });

    expect(STRUCTURE_STATS[StructureKind.TowerBasic].health).toBe(400);
    expect(STRUCTURE_STATS[StructureKind.TowerSniper].health).toBe(300);

    // Вот ради этих двух строк проверка и написана.
    expect(STRUCTURE_STATS[StructureKind.Wall].health).toBe(wall);
    expect(STRUCTURE_STATS[StructureKind.Base].health).toBe(base);
  });

  it('прочность базы двигается отдельно от прочности башен', () => {
    // Разделение и есть смысл этих двух множителей: прочность базы —
    // регулятор длины матча, прочность башен — размен у обороны. Слитые
    // в один, они дали бы замеру сумму двух правок вместо одной.
    //
    // Ожидания считаются от задуманных величин, а не повторяют их цифрой.
    // Запас базы — свободное число, его двигают ради темпа, и проверка,
    // прибитая к его нынешнему значению, падала бы при каждой такой
    // правке, ничего при этом не проверяя.
    const base = STRUCTURE_STATS[StructureKind.Base].health;
    const tower = STRUCTURE_STATS[StructureKind.TowerBasic].health;
    const wall = STRUCTURE_STATS[StructureKind.Wall].health;

    applyRuleTuning({ baseHealth: 0.75 });

    expect(STRUCTURE_STATS[StructureKind.Base].health).toBe(Math.round(base * 0.75));
    expect(STRUCTURE_STATS[StructureKind.TowerBasic].health).toBe(tower);
    expect(STRUCTURE_STATS[StructureKind.Wall].health).toBe(wall);
  });

  it('прочность башен не трогает базу, даже если двигать обе', () => {
    const base = STRUCTURE_STATS[StructureKind.Base].health;
    const tower = STRUCTURE_STATS[StructureKind.TowerBasic].health;

    applyRuleTuning({ baseHealth: 0.5, towerHealth: 2 });

    expect(STRUCTURE_STATS[StructureKind.Base].health).toBe(Math.round(base * 0.5));
    expect(STRUCTURE_STATS[StructureKind.TowerBasic].health).toBe(tower * 2);
  });

  it('радиус машины тянет за собой зазор до стены', () => {
    // Зазор обязан оставаться больше любого радиуса: иначе корпус свесится
    // за край скалы, и мы померяем не плотность строя, а правило обхода.
    applyRuleTuning({ unitRadius: 1.25 });

    expect(UNIT_SEPARATION_RADIUS[UnitType.Assault]).toBe(250);
    expect(UNIT_SEPARATION_RADIUS[UnitType.Tesla]).toBe(300);
    expect(SEPARATION_WALL_CLEARANCE).toBe(325);
    expect(SEPARATION_WALL_CLEARANCE).toBeGreaterThan(UNIT_SEPARATION_RADIUS[UnitType.Tesla]);
  });

  it('карта меняет сторону, число клеток и отступ базы', () => {
    applyRuleTuning({ map: 0.5 });

    expect(MAP_WIDTH_CELLS).toBe(20);
    expect(MAP_CELL_COUNT).toBe(400);
    // Отступ едет подобно стороне, а не остаётся прежним.
    expect(BASE_INSET_CELLS).toBe(3);
  });

  it('сторона карты всегда чётная', () => {
    // Половина стороны берётся в расчётах, и нечётная сторона дала бы
    // дробный номер клетки. 38 × 1,5 = 57 — округляется вверх до 58.
    applyRuleTuning({ map: 1.5 });
    expect(MAP_WIDTH_CELLS % 2).toBe(0);
    expect(MAP_WIDTH_CELLS).toBe(58);
  });

  it('карта не трогает ничего, кроме карты', () => {
    const income = BASE_INCOME_PER_TICK;
    const speed = UNIT_STATS[UnitType.Assault].speed;
    const tower = STRUCTURE_STATS[StructureKind.TowerBasic].health;

    applyRuleTuning({ map: 0.5 });

    expect(BASE_INCOME_PER_TICK).toBe(income);
    expect(UNIT_STATS[UnitType.Assault].speed).toBe(speed);
    expect(STRUCTURE_STATS[StructureKind.TowerBasic].health).toBe(tower);
  });

  it('множители складываются, а не отменяют друг друга', () => {
    applyRuleTuning({ income: 2 });
    applyRuleTuning({ speed: 0.75 });

    // Второй вызов не должен сбросить первый: настройка накапливается.
    expect(BASE_INCOME_PER_TICK).toBe(20);
    expect(UNIT_STATS[UnitType.Assault].speed).toBe(50);
  });

  it('отвергает бессмысленный множитель', () => {
    expect(() => {
      applyRuleTuning({ income: 0 });
    }).toThrow();
    expect(() => {
      applyRuleTuning({ speed: Number.NaN });
    }).toThrow();
  });
});
