import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from './constants.js';
import { cellsToUnits } from './units.js';
import {
  BASE_ATTACK,
  BASE_COOLDOWN_TICKS,
  BASE_HEALTH,
  BASE_UNIT_COST,
  BASE_INCOME_PER_TICK,
  BLAST_LIFETIME_TICKS,
  BUILDABLE_KINDS,
  BlastKind,
  ENERGY_SCALE,
  FIRST_MISSILE_SIDE,
  GENERAL_STATS,
  GENERAL_WEAPON,
  NUKE_COOLDOWN_MAX_LEVEL,
  NUKE_COOLDOWN_MIN_TICKS,
  NUKE_COOLDOWN_TICKS,
  NUKE_COST,
  NUKE_DAMAGE,
  NUKE_DELAY_TICKS,
  NUKE_RADIUS,
  SEPARATION_DAMPING_PERCENT,
  SEPARATION_PUSH_SPEED_PERCENT,
  SEPARATION_WALL_CLEARANCE,
  SHOT_LIFETIME_TICKS,
  SNIPER_TOWER_OVERREACH_CELLS,
  STRUCTURE_STATS,
  STRUCTURE_WEAPON,
  ShotSide,
  ShotWeapon,
  StructureKind,
  UNIT_SEPARATION_RADIUS,
  UNIT_STATS,
  UNIT_TYPES,
  UNIT_WEAPON,
  UPGRADE_BRANCHES,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
  VETERAN_MAX_RANK,
  VETERAN_RANK_KILLS,
  VETERAN_STRUCTURE_PPM,
  VETERAN_UNIT_PPM,
  energy,
  isArmedStructure,
  isUpgradeMaxed,
  killsToNextRank,
  nukeCooldownTicks,
  nukeLaunchCost,
  upgradeBranchIndex,
  veteranStructurePpm,
  veteranStructurePpmOf,
  veteranUnitPpm,
  veteranUnitPpmOf,
  veteranRank,
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
  const tesla = UNIT_STATS[UnitType.Tesla];

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

  it('снайпер и Тесла стреляют втрое реже штурмовика', () => {
    expect(sniper.cooldownTicks).toBeCloseTo(assault.cooldownTicks / 0.3, 0);
    expect(tesla.cooldownTicks).toBeCloseTo(assault.cooldownTicks / 0.3, 0);
  });

  it('Тесла достаёт ровно на клетку дальше базовой башни', () => {
    // Единственное, ради чего Тесла существует: остановившись у цели,
    // она расстреливает её, оставаясь вне досягаемости.
    const tower = STRUCTURE_STATS[StructureKind.TowerBasic];
    expect(tesla.range).toBe(tower.range + cellsToUnits(1));
  });

  it('снайперская башня перекрывает обоих дальнобойных на одно и то же', () => {
    // Башня заведена как ответ дальнобойным, и отвечать она обязана
    // одинаково, а не по-разному в зависимости от того, кто подошёл.
    // Совпадение дальностей Теслы и снайпера — следствие этого правила,
    // а не копия числа из строки в строку.
    const sniperTower = STRUCTURE_STATS[StructureKind.TowerSniper];
    const overreach = cellsToUnits(SNIPER_TOWER_OVERREACH_CELLS);

    expect(sniperTower.range - tesla.range).toBe(overreach);
    expect(sniperTower.range - sniper.range).toBe(overreach);
  });

  it('перекрытие Тесла проходит ровно за одну перезарядку башни', () => {
    // Отсюда и взялись две клетки. Подходя под огонь, Тесла получает
    // ровно ОДНО бесплатное попадание, и дуэль решает тот, кто открыл
    // огонь, а не фора. При прежнем разрыве в четыре клетки бесплатных
    // попаданий было два-три, и решала именно фора.
    const sniperTower = STRUCTURE_STATS[StructureKind.TowerSniper];
    const ticksToClose = cellsToUnits(SNIPER_TOWER_OVERREACH_CELLS) / tesla.speed;

    expect(ticksToClose).toBe(sniperTower.cooldownTicks);
  });

  it('Тесла прочна ровно как базовая башня', () => {
    // Число выведено из подвижности, а не подобрано: Тесла пересекает
    // карту один раз за матч, то есть по подвижности она сооружение.
    // Вернуть ей базовое здоровье значило бы снова сделать самый дорогой
    // юнит самым дешёвым по прочности за энергию.
    expect(tesla.health).toBe(STRUCTURE_STATS[StructureKind.TowerBasic].health);
  });

  it('Тесла втрое медленнее штурмовика и вдесятеро дороже', () => {
    expect(tesla.speed).toBe(Math.round(assault.speed * 0.3));
    expect(tesla.cost).toBe(assault.cost * 10);
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

  it('снайперская башня перекрывает Теслу по дальности', () => {
    expect(STRUCTURE_STATS[StructureKind.TowerSniper].range).toBeGreaterThan(tesla.range);
  });

  it('удар без единого купленного уровня стоит шестнадцать базовых юнитов', () => {
    expect(NUKE_COST).toBe(BASE_UNIT_COST * 16);
    expect(nukeLaunchCost(0, 0)).toBe(NUKE_COST);
  });

  it('уровень радиуса удорожает пуск на пять процентов', () => {
    expect(nukeLaunchCost(1, 0)).toBe(applyPpm(NUKE_COST, compoundPpm(5, 1)));
    expect(nukeLaunchCost(1, 0) / NUKE_COST).toBeCloseTo(1.05, 2);
  });

  it('уровень мощности удорожает пуск на десять процентов', () => {
    expect(nukeLaunchCost(0, 1) / NUKE_COST).toBeCloseTo(1.1, 2);
  });

  it('накрытая площадь растёт быстрее цены пуска', () => {
    // Ровно то, ради чего прежняя цена по площади и была отменена.
    // Уровень радиуса даёт двадцать процентов радиуса, то есть сорок
    // четыре процента накрытой площади, а стоит пять процентов цены.
    // Пока это неравенство держится, прокачка радиуса окупается.
    // Сравниваются ПРИБАВКИ, а не сами величины: 1,44 против 1,05
    // отличаются в полтора раза, а прибавки — 44 процента против пяти —
    // почти в девять, и говорит о выгоде именно вторая пара.
    const areaGain = 1.2 * 1.2 - 1;
    const priceGain = nukeLaunchCost(1, 0) / NUKE_COST - 1;

    expect(areaGain).toBeGreaterThan(priceGain * 8);
  });

  it('откат цену пуска не двигает', () => {
    // Учащение ударов оплачено ценой самой ветки, а не ценой каждого
    // пуска. Довода у `nukeLaunchCost` для отката нет вовсе — этот тест
    // сторожит, что его туда не добавят молча.
    expect(nukeLaunchCost.length).toBe(2);
  });

  it('откат: минута между пусками, тридцать секунд предел, шаг десять', () => {
    expect(NUKE_COOLDOWN_TICKS).toBe(TICKS_PER_SECOND * 60);
    expect(NUKE_COOLDOWN_MIN_TICKS).toBe(TICKS_PER_SECOND * 30);
    expect(nukeCooldownTicks(0)).toBe(TICKS_PER_SECOND * 60);
    expect(nukeCooldownTicks(1)).toBe(TICKS_PER_SECOND * 50);
    expect(nukeCooldownTicks(2)).toBe(TICKS_PER_SECOND * 40);
    expect(nukeCooldownTicks(3)).toBe(TICKS_PER_SECOND * 30);
  });

  it('уровней отката ровно три, и ниже предела он не опускается', () => {
    expect(NUKE_COOLDOWN_MAX_LEVEL).toBe(3);
    // Второй рубеж: покупку четвёртого уровня отклоняет ядро, но и сам
    // расчёт отрицательным откатом не отвечает.
    expect(nukeCooldownTicks(99)).toBe(NUKE_COOLDOWN_MIN_TICKS);
  });

  it('базовый радиус ядерного удара — четыре клетки', () => {
    expect(NUKE_RADIUS).toBe(cellsToUnits(4));
  });

  it('мощность заряда — полторы прочности штурмовика', () => {
    // Число, делящее цели на два разряда: штурмовик и снайперская башня
    // гибнут сразу, башня и генерал выходят с четвертью прочности.
    expect(NUKE_DAMAGE).toBe(Math.round(BASE_HEALTH * 1.5));
    expect(NUKE_DAMAGE).toBeGreaterThan(assault.health);
    expect(NUKE_DAMAGE).toBeLessThan(STRUCTURE_STATS[StructureKind.TowerBasic].health);
  });

  it('базовая атака и базовое здоровье достались штурмовику без изменений', () => {
    expect(assault.attack).toBe(BASE_ATTACK);
    expect(assault.health).toBe(BASE_HEALTH);
  });
});

describe('баланс: дальность генерала', () => {
  const tower = STRUCTURE_STATS[StructureKind.TowerBasic];

  it('равна дальности базовой башни и радиусу строительства', () => {
    // Второе равенство важнее первого: из него следует правило,
    // читаемое без объяснений, — «куда достанешь, там и построишь».
    expect(GENERAL_STATS.range).toBe(tower.range);
    expect(GENERAL_STATS.range).toBe(GENERAL_STATS.buildRadius);
  });

  /** За сколько тиков генерал снимает одну непрокачанную башню. */
  const ticksToTakeTower =
    Math.ceil(tower.health / GENERAL_STATS.attack) * GENERAL_STATS.cooldownTicks;

  /** Сколько тиков генерал живёт под огнём `count` таких башен. */
  const ticksAlive = (count: number): number =>
    Math.ceil(GENERAL_STATS.health / (tower.attack * count)) * tower.cooldownTicks;

  it('одиночную непрокачанную башню генерал разбирает и остаётся жив', () => {
    // Прежде здесь стояло обратное требование — «дуэль генерал
    // проигрывает». Оно отменено сознательно вместе с сокращением
    // перезарядки: генерал перестал быть стрелком уровня штурмовика.
    // Центральную механику замысла отменяет не победа над одной башней,
    // а безнаказанность против укреплённой позиции, и стерегут её
    // две проверки ниже.
    expect(ticksToTakeTower).toBeLessThan(ticksAlive(1));
  });

  it('на паре башен генерал разменивается один к одному', () => {
    // Первую снять успевает, вторую — уже нет: на неё нужно вдвое
    // больше времени, чем ему осталось жить.
    expect(ticksToTakeTower).toBeLessThan(ticksAlive(2));
    expect(ticksToTakeTower * 2).toBeGreaterThan(ticksAlive(2));
  });

  it('трёх башен генерал не переживает вовсе', () => {
    // Вот это и есть укреплённая позиция. Пока линия обороны бьёт
    // втроём, генерал не снимает с неё ни одной башни.
    expect(ticksAlive(3)).toBeLessThan(ticksToTakeTower);
  });

  it('снайпер, Тесла и снайперская башня по-прежнему перестреливают генерала', () => {
    expect(UNIT_STATS[UnitType.Sniper].range).toBeGreaterThan(GENERAL_STATS.range);
    expect(UNIT_STATS[UnitType.Tesla].range).toBeGreaterThan(GENERAL_STATS.range);
    expect(STRUCTURE_STATS[StructureKind.TowerSniper].range).toBeGreaterThan(GENERAL_STATS.range);
  });

  it('добывать энергию убийствами невыгоднее, чем просто ждать доход', () => {
    // Стоит охоте за юнитами стать выгоднее позиционной борьбы —
    // и игра превращается в ферму.
    //
    // Запас здесь БОЛЬШЕ НЕ ОГРОМНЫЙ, и это заявленное последствие
    // сокращения перезарядки: было 2,5 против 10, стало 9,375 против 10.
    // Двух ступеней прокачки атаки хватает, чтобы граница была перейдена.
    // Держит явление не число, а то, что награду даёт только ДОБИВАЮЩИЙ
    // удар генерала: за ним надо стоять в пяти клетках от боя под
    // ответным огнём.
    const assault = UNIT_STATS[UnitType.Assault];
    const shots = Math.ceil(assault.health / GENERAL_STATS.attack);
    const perTick = assault.cost / (shots * GENERAL_STATS.cooldownTicks);

    expect(perTick).toBeLessThan(BASE_INCOME_PER_TICK);
  });
});

describe('баланс: скорострельность генерала', () => {
  it('вчетверо чаще базовой перезарядки, с точностью до целого тика', () => {
    // Ровно вчетверо не выражается: четверть от тридцати тиков —
    // это семь с половиной, а номер тика дробным не бывает.
    expect(GENERAL_STATS.cooldownTicks).toBe(Math.round(BASE_COOLDOWN_TICKS / 4));
  });

  it('урон за выстрел остался базовым', () => {
    // Растёт частота, а не сила удара. Иначе пришлось бы двигать
    // и награду за убийство, и цену прокачки атаки.
    expect(GENERAL_STATS.attack).toBe(BASE_ATTACK);
  });

  it('в воздухе висят ровно два следа ракеты одной машины', () => {
    // То самое, ради чего борта чередуются: залп читается залпом.
    // Больше двух — и небо над генералом превратится в сплошной дым.
    const trails = SHOT_LIFETIME_TICKS[ShotWeapon.Missile] / GENERAL_STATS.cooldownTicks;

    expect(trails).toBe(2);
  });
});

describe('баланс: борта ракеты', () => {
  it('борта противоположны по знаку, а ось даёт ноль', () => {
    // Значения работают множителем смещения, а не порядковым номером:
    // отрисовка умножает на них вылет подвески и обходится без условий.
    expect(ShotSide.Left).toBe(-ShotSide.Right);
    expect(ShotSide.Centre).toBe(0);
  });

  it('первая ракета уходит с борта, а не по оси', () => {
    // По оси у генерала не стреляет ни один выстрел, включая самый
    // первый: «по оси» — это про всех остальных.
    expect(FIRST_MISSILE_SIDE).not.toBe(ShotSide.Centre);
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

describe('оружие и след выстрела', () => {
  it('снайперская башня стреляет тем же, чем снайпер', () => {
    // Соответствие идёт по оружию, а не по тому, кто его держит:
    // луч из башни и луч из машины — один и тот же луч.
    expect(STRUCTURE_WEAPON[StructureKind.TowerSniper]).toBe(UNIT_WEAPON[UnitType.Sniper]);
  });

  it('три типа юнитов стреляют тремя разными видами оружия', () => {
    const weapons = Object.values(UnitType).map((unitType) => UNIT_WEAPON[unitType]);

    expect(new Set(weapons).size).toBe(weapons.length);
  });

  it('у каждого вида постройки задано оружие', () => {
    // Таблица обходится по перечислению, а не по списку руками: иначе
    // первый же новый вид постройки молча получил бы undefined.
    for (const kind of Object.values(StructureKind)) {
      expect(STRUCTURE_WEAPON[kind]).toBeDefined();
    }
  });

  it('у каждого вида оружия задан срок жизни следа', () => {
    for (const weapon of Object.values(ShotWeapon)) {
      expect(SHOT_LIFETIME_TICKS[weapon]).toBeGreaterThan(0);
    }
  });

  it('след луча живёт вдвое дольше следа трассера', () => {
    // Трассеров в бою десятки в секунду, снайперский выстрел редок
    // и весом: вдвое больший срок и делает из него событие.
    expect(SHOT_LIFETIME_TICKS[ShotWeapon.Beam]).toBe(SHOT_LIFETIME_TICKS[ShotWeapon.Bolt] * 2);
  });

  it('след ракеты живёт дольше следа трассера', () => {
    // За срок трассера ракета не успевает ни долететь, ни оставить дым:
    // показ кончается вместе с записью в мире, и всё, что должно быть
    // видно, обязано уложиться внутрь срока.
    expect(SHOT_LIFETIME_TICKS[ShotWeapon.Missile]).toBeGreaterThan(
      SHOT_LIFETIME_TICKS[ShotWeapon.Bolt],
    );
  });

  it('ракетой стреляет один генерал', () => {
    // Отрисовка узнаёт по виду оружия, с какой высоты вышел выстрел.
    // Отдай ракету кому-то ещё — и она поедет по воздуху на чужой высоте.
    expect(GENERAL_WEAPON).toBe(ShotWeapon.Missile);

    for (const weapon of Object.values(UNIT_WEAPON)) {
      expect(weapon).not.toBe(ShotWeapon.Missile);
    }
    for (const weapon of Object.values(STRUCTURE_WEAPON)) {
      expect(weapon).not.toBe(ShotWeapon.Missile);
    }
  });
});

describe('взрывы', () => {
  it('у каждого вида взрыва задан срок жизни', () => {
    // Обход по перечислению, а не по списку руками: иначе первый же
    // новый вид взрыва молча получил бы undefined и не показался вовсе.
    for (const kind of Object.values(BlastKind)) {
      expect(BLAST_LIFETIME_TICKS[kind]).toBeGreaterThan(0);
    }
  });

  it('гибель юнита показывается короче всех', () => {
    // Машин на поле сотни, и гибнут они пачками. Длинный взрыв у каждой
    // превратил бы бой в сплошное зарево, из которого не вычитается
    // ни одно событие.
    const others = [BlastKind.General, BlastKind.Structure, BlastKind.Nuke];

    for (const kind of others) {
      expect(BLAST_LIFETIME_TICKS[BlastKind.Unit]).toBeLessThan(BLAST_LIFETIME_TICKS[kind]);
    }
  });

  it('ядерный взрыв висит над полем дольше ожидания удара', () => {
    // Удар стоит пятидесяти юнитов, и его последствие обязано пережить
    // то самое ожидание, ради которого задержка и заведена.
    expect(BLAST_LIFETIME_TICKS[BlastKind.Nuke]).toBeGreaterThan(NUKE_DELAY_TICKS);
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

describe('баланс: дальность юнитов прокачивается', () => {
  const rangeBranch = (target: UpgradeTarget): number =>
    upgradeBranchIndex(target, UpgradeStat.Range);

  it('ветки дальности есть у снайпера и Теслы, но не у штурмовика', () => {
    // У штурмовика её нет намеренно: он основа ближнего боя, и дальность
    // сделала бы из него дешёвого снайпера.
    expect(rangeBranch(UpgradeTarget.UnitSniper)).toBeGreaterThanOrEqual(0);
    expect(rangeBranch(UpgradeTarget.UnitTesla)).toBeGreaterThanOrEqual(0);
    expect(rangeBranch(UpgradeTarget.UnitAssault)).toBe(-1);
  });

  it('новые ветки стоят вчетверо против прочих веток своего типа', () => {
    const costOf = (index: number): number => UPGRADE_BRANCHES[index]?.baseCost ?? 0;
    const attackOf = (target: UpgradeTarget): number =>
      costOf(upgradeBranchIndex(target, UpgradeStat.Attack));

    expect(costOf(rangeBranch(UpgradeTarget.UnitSniper))).toBe(
      attackOf(UpgradeTarget.UnitSniper) * 4,
    );
    expect(costOf(rangeBranch(UpgradeTarget.UnitTesla))).toBe(
      attackOf(UpgradeTarget.UnitTesla) * 4,
    );
  });

  it('новые ветки дорожают как экономика, а не как прочие', () => {
    // У дальности пороговый эффект: уровень в какой-то момент выводит
    // стрелка за круг ответного огня целиком.
    expect(UPGRADE_BRANCHES[rangeBranch(UpgradeTarget.UnitSniper)]?.costGrowthPercent).toBe(25);
    expect(UPGRADE_BRANCHES[rangeBranch(UpgradeTarget.UnitTesla)]?.costGrowthPercent).toBe(25);
  });

  it('ветки дальности стоят перед ядерными и ничего не сдвинули', () => {
    // Защита сохранённых записей матчей: индекс ветки едет в команде
    // покупки, и вставка в середину превратила бы старые записи
    // в бессмыслицу.
    // Дописано тремя заходами: сначала дальность снайпера и Теслы,
    // затем мощность и радиус ядерного удара, затем откат. Порядок
    // дописывания и есть порядок хвоста.
    const nuclear = 3;
    const ranged = 2;
    const end = UPGRADE_BRANCHES.length;

    for (const branch of UPGRADE_BRANCHES.slice(end - nuclear)) {
      expect(branch.target).toBe(UpgradeTarget.Base);
    }
    for (const branch of UPGRADE_BRANCHES.slice(end - nuclear - ranged, end - nuclear)) {
      expect(branch.stat).toBe(UpgradeStat.Range);
    }

    expect(upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.Attack)).toBe(0);
    expect(upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.Income)).toBe(
      end - nuclear - ranged - 1,
    );
  });

  it('при равном числе уровней снайперская башня остаётся дальше Теслы', () => {
    // То самое свойство, ради которого верхний предел не понадобился:
    // все ветки дальности растут одинаково, поэтому порядок сохраняется.
    const levels = 20;
    const factor = compoundPpm(10, levels);

    expect(applyPpm(STRUCTURE_STATS[StructureKind.TowerSniper].range, factor)).toBeGreaterThan(
      applyPpm(UNIT_STATS[UnitType.Tesla].range, factor),
    );
  });
});

describe('баланс: расталкивание', () => {
  it('личный радиус меньше половины клетки у каждой машины', () => {
    // Радиус больше половины клетки означал бы, что машина претендует
    // на клетку целиком, — а это уже жёсткие столкновения, которых
    // изменение не вводит.
    for (const type of UNIT_TYPES) {
      const radius = UNIT_SEPARATION_RADIUS[type];

      expect(radius).toBeGreaterThan(0);
      expect(radius).toBeLessThan(cellsToUnits(0.5));
    }
  });

  it('порядок радиусов повторяет порядок габаритов корпуса', () => {
    // Тесла — самая широкая машина в игре, снайпер — самая узкая.
    // Порядок здесь и есть та связь с обликом, которую из общего пакета
    // не проверить иначе: модели живут в клиенте, а он сюда не ходит.
    expect(UNIT_SEPARATION_RADIUS[UnitType.Tesla]).toBeGreaterThan(
      UNIT_SEPARATION_RADIUS[UnitType.Assault],
    );
    expect(UNIT_SEPARATION_RADIUS[UnitType.Assault]).toBeGreaterThan(
      UNIT_SEPARATION_RADIUS[UnitType.Sniper],
    );
  });

  it('клиренс от стен больше любого личного радиуса', () => {
    // Иначе правило теряет смысл: центр окажется снаружи, а корпус
    // будет свешиваться за край скалы.
    const widest = Math.max(...UNIT_TYPES.map((type) => UNIT_SEPARATION_RADIUS[type]));

    expect(SEPARATION_WALL_CLEARANCE).toBeGreaterThan(widest);
  });

  it('толчок гасится и ограничен долей собственной скорости', () => {
    expect(SEPARATION_DAMPING_PERCENT).toBeGreaterThan(0);
    expect(SEPARATION_DAMPING_PERCENT).toBeLessThan(100);

    // Потолок в половину скорости: даже самую медленную машину толпа
    // не должна носить быстрее, чем она ездит сама.
    const slowest = UNIT_STATS[UnitType.Tesla].speed;
    const cap = Math.floor((slowest * SEPARATION_PUSH_SPEED_PERCENT) / 100);

    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(slowest);
  });
});

describe('баланс: ветки прокачки', () => {
  it('покрывают все типы юнитов, башен, стену, генерала и экономику', () => {
    const targets = new Set(UPGRADE_BRANCHES.map((entry) => entry.target));

    expect(targets).toEqual(
      new Set([
        UpgradeTarget.UnitAssault,
        UpgradeTarget.UnitSniper,
        UpgradeTarget.UnitTesla,
        UpgradeTarget.TowerBasic,
        UpgradeTarget.TowerSniper,
        UpgradeTarget.Wall,
        UpgradeTarget.General,
        UpgradeTarget.Base,
      ]),
    );
  });

  it('цена уровня растёт по трём ставкам: 10 обычные, 25 пороговые, 20 ядерные', () => {
    // Ускоренный рост цены — не привилегия экономики, а признак ветки,
    // у которой уровень меняет не количество, а качество: у экономики
    // это самоусиление, у дальности юнита — выход за круг ответного
    // огня.
    //
    // Три ядерные ветки стоят особняком и дорожают ОДИНАКОВО между
    // собой. Прежде мощность росла на десять, а радиус на двадцать
    // пять — три соседние строки одного столбца, дорожающие вразнобой,
    // читаются не как решение, а как недосмотр.
    const NUCLEAR: readonly UpgradeStat[] = [
      UpgradeStat.NukeDamage,
      UpgradeStat.NukeRadius,
      UpgradeStat.NukeCooldown,
    ];

    const rateOf = (entry: (typeof UPGRADE_BRANCHES)[number]): number => {
      if (NUCLEAR.includes(entry.stat)) return 20;
      if (entry.target === UpgradeTarget.Base) return 25;
      if (
        entry.stat === UpgradeStat.Range &&
        (entry.target === UpgradeTarget.UnitSniper || entry.target === UpgradeTarget.UnitTesla)
      ) {
        return 25;
      }
      return 10;
    };

    for (const entry of UPGRADE_BRANCHES) {
      expect(entry.costGrowthPercent).toBe(rateOf(entry));
    }
  });

  it('у каждой ветки положительная цена', () => {
    for (const entry of UPGRADE_BRANCHES) {
      expect(entry.baseCost).toBeGreaterThan(0);
    }
  });

  it('нулевая прибавка за уровень есть ровно у одной ветки — у отката', () => {
    // Ноль здесь означает «множитель не используется», а не «уровень
    // ничего не даёт»: откат считается ступенями прямо из уровня.
    // Исключение обязано оставаться единственным, иначе следующая
    // ветка с нулём окажется просто забытой.
    const idle = UPGRADE_BRANCHES.filter((entry) => entry.effectPercent === 0);

    expect(idle.map((entry) => entry.stat)).toEqual([UpgradeStat.NukeCooldown]);
  });

  it('потолок уровня есть ровно у одной ветки — у отката', () => {
    const capped = UPGRADE_BRANCHES.filter((entry) => entry.maxLevel !== undefined);

    expect(capped.map((entry) => entry.stat)).toEqual([UpgradeStat.NukeCooldown]);
    expect(capped[0]?.maxLevel).toBe(NUKE_COOLDOWN_MAX_LEVEL);
  });

  it('ветка без потолка не достигает его никогда', () => {
    const attack =
      UPGRADE_BRANCHES[upgradeBranchIndex(UpgradeTarget.UnitAssault, UpgradeStat.Attack)];
    const cooldown =
      UPGRADE_BRANCHES[upgradeBranchIndex(UpgradeTarget.Base, UpgradeStat.NukeCooldown)];

    expect(attack).toBeDefined();
    expect(cooldown).toBeDefined();
    if (attack === undefined || cooldown === undefined) return;

    expect(isUpgradeMaxed(attack, 1_000)).toBe(false);
    expect(isUpgradeMaxed(cooldown, NUKE_COOLDOWN_MAX_LEVEL - 1)).toBe(false);
    expect(isUpgradeMaxed(cooldown, NUKE_COOLDOWN_MAX_LEVEL)).toBe(true);
  });

  it('шаг вдвое против общего есть только у двух ядерных веток', () => {
    // Правило «прибавка единая для всех веток» сохраняется, и его
    // единственное исключение обязано оставаться единственным. Ветка
    // юнита действует на десятки объектов весь матч, ядерная — на одно
    // событие за игру, и за обе вдобавок платят дважды: ценой уровня
    // и ценой каждого пуска.
    const doubled = UPGRADE_BRANCHES.filter((entry) => entry.effectPercent === 20);

    expect(doubled.map((entry) => entry.stat)).toEqual([
      UpgradeStat.NukeDamage,
      UpgradeStat.NukeRadius,
    ]);
    expect(doubled.every((entry) => entry.target === UpgradeTarget.Base)).toBe(true);
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

  it('два шага по пять процентов дают сложный, а не простой процент', () => {
    // 1,05^2 = 1,1025 — это и отличает сложный процент от простого,
    // который дал бы 1,10.
    expect(compoundPpm(5, 2)).toBe(1_102_500);
  });
});

describe('ветеранские ранги', () => {
  it('ранг растёт по порогам, а не за каждое убийство', () => {
    expect(veteranRank(0)).toBe(0);
    expect(veteranRank(1)).toBe(1);
    expect(veteranRank(2)).toBe(1);
    expect(veteranRank(3)).toBe(2);
    expect(veteranRank(5)).toBe(2);
    expect(veteranRank(6)).toBe(3);
    expect(veteranRank(9)).toBe(3);
    expect(veteranRank(10)).toBe(4);
    expect(veteranRank(14)).toBe(4);
    expect(veteranRank(15)).toBe(5);
  });

  it('выше пятого ранга не поднимаются, сколько бы ни набрали', () => {
    expect(veteranRank(40)).toBe(VETERAN_MAX_RANK);
    expect(veteranRank(1000)).toBe(VETERAN_MAX_RANK);
    expect(veteranStructurePpmOf(1000)).toBe(2 * PPM_ONE);
    expect(veteranUnitPpmOf(1000)).toBe(1_500_000);
  });

  it('пороги — треугольные числа: каждый ранг дороже на одно убийство', () => {
    // Правило, которое игрок должен уметь пересказать одной фразой.
    // Разойдись пороги с ним — фраза перестанет быть правдой.
    let previous = 0;
    VETERAN_RANK_KILLS.forEach((threshold, index) => {
      expect(threshold - previous).toBe(index + 1);
      previous = threshold;
    });
  });

  it('множители башни растут и кончаются ровно на удвоении', () => {
    expect(veteranStructurePpm(0)).toBe(PPM_ONE);
    expect(veteranStructurePpm(1)).toBe(1_100_000);
    expect(veteranStructurePpm(2)).toBe(1_250_000);
    expect(veteranStructurePpm(3)).toBe(1_450_000);
    expect(veteranStructurePpm(4)).toBe(1_700_000);
    // Ровно вдвое: круглое число проговаривается вслух и потому
    // запоминается.
    expect(veteranStructurePpm(VETERAN_MAX_RANK)).toBe(2 * PPM_ONE);
  });

  it('машина крепчает заметно мягче башни на каждом ранге', () => {
    // Это не украшение таблицы, а замер: при общей таблице матч уходил
    // вниз из проектной вилки 10–15 минут, потому что исход решают
    // живые юниты. Разойдись таблицы обратно — вернётся и перекос.
    for (let rank = 1; rank <= VETERAN_MAX_RANK; rank += 1) {
      expect(veteranUnitPpm(rank)).toBeLessThan(veteranStructurePpm(rank));
      expect(veteranUnitPpm(rank)).toBeGreaterThan(PPM_ONE);
    }

    expect(veteranUnitPpm(VETERAN_MAX_RANK)).toBe(1_500_000);
  });

  it('пороги у башни и машины общие', () => {
    // Знак различия один на обоих, и означать он обязан одно и то же
    // число убийств. Разъедься пороги — три ёлочки над башней и три
    // над машиной перестали бы значить одинаковое.
    expect(VETERAN_STRUCTURE_PPM).toHaveLength(VETERAN_MAX_RANK);
    expect(VETERAN_UNIT_PPM).toHaveLength(VETERAN_MAX_RANK);
  });

  it('шаг награды башни растёт вместе с ценой ранга', () => {
    // Цена ранга растёт на одно убийство, награда — на пять процентных
    // пунктов. Обе прогрессии арифметические, поэтому последние ранги
    // имеет смысл брать осознанно.
    const steps = VETERAN_STRUCTURE_PPM.map(
      (ppm, index) => ppm - (VETERAN_STRUCTURE_PPM[index - 1] ?? PPM_ONE),
    );

    expect(steps).toEqual([100_000, 150_000, 200_000, 250_000, 300_000]);
  });

  it('ход к следующему рангу считается по порогам', () => {
    expect(killsToNextRank(0)).toBe(1);
    expect(killsToNextRank(1)).toBe(2);
    expect(killsToNextRank(4)).toBe(2);
    // У высшего ранга следующего нет — обещать нечего.
    expect(killsToNextRank(15)).toBe(0);
    expect(killsToNextRank(99)).toBe(0);
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

describe('баланс: какая постройка считается стреляющей', () => {
  it('башни стреляют, стена и база — нет', () => {
    expect(isArmedStructure(StructureKind.TowerBasic)).toBe(true);
    expect(isArmedStructure(StructureKind.TowerSniper)).toBe(true);
    expect(isArmedStructure(StructureKind.Wall)).toBe(false);
    expect(isArmedStructure(StructureKind.Base)).toBe(false);
  });

  it('ответ есть у каждого вида, а не только у названных', () => {
    // Признак выводится из таблицы, а не перечисляет виды поимённо,
    // и проверка сторожит именно это: новый вид постройки не должен
    // молча получить `undefined` вместо ответа.
    for (const kind of Object.values(StructureKind)) {
      expect(typeof isArmedStructure(kind)).toBe('boolean');
    }
  });

  it('стреляющим считается тот, у кого положительны и атака, и дальность', () => {
    // Оба условия обязательны, и одного мало: постройка с уроном,
    // но нулевой дальностью, стрелять всё равно не может.
    for (const kind of Object.values(StructureKind)) {
      const stats = STRUCTURE_STATS[kind];
      expect(isArmedStructure(kind)).toBe(stats.attack > 0 && stats.range > 0);
    }
  });
});
