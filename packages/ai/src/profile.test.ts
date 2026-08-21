import { describe, expect, it } from 'vitest';
import {
  AI_DECISION_INTERVAL_TICKS,
  CommandKind,
  NUKE_COST,
  TICKS_PER_SECOND,
  UPGRADE_BRANCHES,
  UpgradeTarget,
  asPlayerId,
  cellsToUnits,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { createWorld, playerStats, step } from '@td/sim';
import { createOpponent } from './opponent.js';
import {
  BASELINE_PROFILE,
  escortRadius,
  patienceDecisions,
  reserveOf,
  savingLimit,
} from './profile.js';
import type { AiProfile } from './profile.js';
import type { AttemptRecord, DecisionRecord } from './observer.js';

/**
 * Настройка трат: горизонт накопления и выведенный из него предел терпения.
 *
 * Проверяется главное свойство — что второго числа об одном и том же
 * в профиле нет. Раньше их было два, они разошлись в одиннадцать раз,
 * и обнаружить это удалось только прогоном пачки матчей.
 */

const SEED = 20260821;
const AI: PlayerId = asPlayerId(1);

const withHorizon = (seconds: number): AiProfile => ({
  ...BASELINE_PROFILE,
  id: `test-horizon-${String(seconds)}`,
  spending: { ...BASELINE_PROFILE.spending, savingHorizonSeconds: seconds },
});

/** Все попытки трат за короткий матч. */
const attemptsOf = (profile: AiProfile, seconds: number): readonly AttemptRecord[] => {
  const attempts: AttemptRecord[] = [];
  const observe = (record: DecisionRecord): void => {
    attempts.push(...record.attempts);
  };

  const opponent = createOpponent(AI, SEED, profile, observe);

  let world = createWorld(SEED);
  for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
    world = step(world, opponent.decide(world));
  }

  return attempts;
};

describe('прикрытие генерала считается рядом с ним', () => {
  it('радиус соседства равен сумме дальностей генерала и юнита', () => {
    // Пять клеток у генерала плюс две у штурмовика дают семь: на таком
    // расстоянии юнит и генерал достают до одного противника, то есть
    // действительно дерутся вместе. Величина выводится, а не задаётся,
    // и потому подросла сама вместе с дальностью генерала.
    const player = createWorld(SEED).players[AI];
    if (player === undefined) throw new Error('нет игрока');

    expect(escortRadius(playerStats(player))).toBe(cellsToUnits(7));
  });

  it('юниты у своей базы прикрытием дальнего генерала не считаются', () => {
    // Замер поймал это сразу: в шести случаях из десяти признак «прикрыт»
    // выполнялся, когда рядом с генералом не было ни одного своего.
    const records: DecisionRecord[] = [];
    const opponent = createOpponent(AI, SEED, BASELINE_PROFILE, (record) => {
      records.push(record);
    });

    let world = createWorld(SEED);
    for (let tick = 0; tick < 180 * TICKS_PER_SECOND; tick += 1) {
      world = step(world, opponent.decide(world));
    }

    const apart = records.filter((record) => record.liveUnits > record.nearbyUnits);

    expect(records.length).toBeGreaterThan(0);
    expect(apart.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.nearbyUnits).toBeLessThanOrEqual(record.liveUnits);
    }
  });
});

describe('цели прокачки выбираются долями, а не порядком', () => {
  /** Все ветки, купленные противником за матч. */
  const boughtBranches = (profile: AiProfile, seconds: number): readonly number[] => {
    const opponent = createOpponent(AI, SEED, profile);
    const branches: number[] = [];

    let world = createWorld(SEED);
    for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
      const commands = opponent.decide(world);
      for (const command of commands) {
        if (command.kind === CommandKind.BuyUpgrade) branches.push(command.branch);
      }
      world = step(world, commands);
    }

    return branches;
  };

  // Цель выбрана не случайно: штурмовиков у противника всегда много,
  // значит прокачке будет что умножать и покупки действительно случатся.
  // С целью, которой у игрока нет вовсе, тест проверял бы не веса,
  // а сравнение выгоды: умножать ноль незачем, и покупок не было бы
  // по совсем другой причине.
  const onlyAssault: AiProfile = {
    ...BASELINE_PROFILE,
    id: 'test-only-assault',
    phases: BASELINE_PROFILE.phases.map((phase) => ({
      ...phase,
      upgrades: { [UpgradeTarget.UnitAssault]: 1 },
    })),
  };

  it('цель с нулевым весом не выбирается никогда', () => {
    const branches = boughtBranches(onlyAssault, 240);

    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      expect(UPGRADE_BRANCHES[branch]?.target).toBe(UpgradeTarget.UnitAssault);
    }
  });

  it('названные в фазе цели покупки действительно получают', () => {
    // Прежний порядок «по предпочтению» вырождался в первый пункт: ветка
    // не кончается никогда, поэтому до второй цели очередь не доходила
    // ни разу за матч. Из восьми названных целей покупки получали две.
    const targets = new Set(
      boughtBranches(BASELINE_PROFILE, 240).map((branch) => UPGRADE_BRANCHES[branch]?.target),
    );

    expect(targets.size).toBeGreaterThan(1);
  });
});

describe('предел терпения выводится из горизонта накопления', () => {
  it('сорок пять секунд при решении раз в полсекунды дают девяносто решений', () => {
    expect(patienceDecisions(BASELINE_PROFILE)).toBe(90);
  });

  it('предел равен горизонту, выраженному в решениях', () => {
    // Смысл всей правки одной строкой: два числа об одном и том же
    // разойтись больше не могут, потому что число одно.
    const decisionsPerSecond = TICKS_PER_SECOND / AI_DECISION_INTERVAL_TICKS;

    expect(patienceDecisions(BASELINE_PROFILE)).toBe(
      BASELINE_PROFILE.spending.savingHorizonSeconds * decisionsPerSecond,
    );
  });

  it('нулевой горизонт отбрасывает недостижимое желание, а не копит на него', () => {
    // При нулевом горизонте ждать нельзя ничего: любая нехватка энергии
    // обязана давать «пропускаю», а не «коплю».
    const attempts = attemptsOf(withHorizon(0), 60);

    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.some((attempt) => attempt.result === 'wait')).toBe(false);
  });

  it('при обычном горизонте накопление всё-таки случается', () => {
    // Обратная страховка: без неё предыдущий тест проходил бы и на
    // противнике, который вообще разучился копить.
    const attempts = attemptsOf(BASELINE_PROFILE, 60);

    expect(attempts.some((attempt) => attempt.result === 'wait')).toBe(true);
  });
});

describe('неприкосновенный запас держится, только пока достижим', () => {
  /**
   * Фаза с запасом под ядерный удар. Берётся последняя фаза базового
   * профиля — именно она его и объявляет.
   */
  const withReserve = BASELINE_PROFILE.phases[BASELINE_PROFILE.phases.length - 1];
  if (withReserve === undefined) throw new Error('в базовом профиле нет фаз');

  /** Доход, при котором запас ровно набирается за горизонт накопления. */
  const enough = NUKE_COST / (TICKS_PER_SECOND * BASELINE_PROFILE.spending.savingHorizonSeconds);

  it('при доходе замера запас нулевой', () => {
    // Четырнадцать за тик — доход, выше которого противник в замере
    // на двадцати матчах не поднимался. При нём на удар копить больше
    // минуты, и запас запрещал бы вообще все покупки.
    expect(reserveOf(withReserve, 14, BASELINE_PROFILE)).toBe(0);
  });

  it('при достаточном доходе запас равен цене удара', () => {
    expect(reserveOf(withReserve, Math.ceil(enough), BASELINE_PROFILE)).toBe(NUKE_COST);
  });

  it('граница проходит ровно там, где кончается горизонт накопления', () => {
    // Смысл правила одной строкой: тот же вопрос, который уже задаётся
    // о каждой отдельной покупке, задан о запасе, и ответ на него один.
    expect(savingLimit(Math.ceil(enough), BASELINE_PROFILE)).toBeGreaterThanOrEqual(NUKE_COST);
    expect(savingLimit(Math.floor(enough) - 1, BASELINE_PROFILE)).toBeLessThan(NUKE_COST);
  });

  it('фаза без запаса не держит его ни при каком доходе', () => {
    const plain = BASELINE_PROFILE.phases[0];
    if (plain === undefined) throw new Error('в базовом профиле нет фаз');

    expect(reserveOf(plain, 1, BASELINE_PROFILE)).toBe(0);
    expect(reserveOf(plain, 1000, BASELINE_PROFILE)).toBe(0);
  });

  it('фаза с недостижимым запасом всё равно покупает', () => {
    // Главное следствие правила, и проверяется оно на фазе, а не на
    // поздней минуте матча: замер до правки дал 1014 решений подряд,
    // в каждом из которых и постройка, и юнит, и улучшение отвечали
    // «не по карману» — при энергии, которой хватало на шесть башен.
    //
    // Запас объявлен с первой секунды, чтобы проверка не зависела
    // от того, доживёт ли матч до третьей минуты.
    const reserved: AiProfile = {
      ...BASELINE_PROFILE,
      id: 'test-reserve-from-start',
      phases: BASELINE_PROFILE.phases.map((phase) => ({ ...phase, reserve: 'nuke' as const })),
    };

    const bought = attemptsOf(reserved, 60).filter((attempt) => attempt.result === 'bought');

    expect(bought.length).toBeGreaterThan(0);
  });
});
