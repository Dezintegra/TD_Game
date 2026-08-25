import { describe, expect, it } from 'vitest';
import {
  AI_DECISION_INTERVAL_TICKS,
  CommandKind,
  NUKE_COST,
  TICKS_PER_SECOND,
  UPGRADE_BRANCHES,
  UpgradeStat,
  UpgradeTarget,
  asPlayerId,
  cellsToUnits,
  upgradeBranchIndex,
} from '@td/shared';
import type { PlayerId } from '@td/shared';
import { createWorld, playerStats, step } from '@td/sim';
import { createOpponent } from './opponent.js';
import {
  BASELINE_PROFILE,
  PROFILES,
  LONG_RANGE_PROFILE,
  STRATEGIST_PROFILE,
  escortRadius,
  patienceDecisions,
  reserveOf,
  savingLimit,
} from './profile.js';
import type { AiProfile } from './profile.js';
import { AttemptNote } from './observer.js';
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
  /**
   * Отдельный мир для проверок прокачки.
   *
   * Общий `SEED` файла после перехода на карту 38 × 38 даёт поле, на котором
   * противник за восемь минут покупает всего двенадцать уровней и все —
   * одной цели: войско у него однородное, и умножать остальным целям нечего.
   * Проверять на таком стенде правило «цели выбираются долями» нечем —
   * долям просто не из чего сложиться.
   *
   * Здесь выбран мир, где покупок два десятка и целей три. Это выбор стенда
   * с достаточной выборкой, а не подгонка результата, и страхует его
   * проверка числа покупок ниже: выродится стенд — тест упадёт, а не начнёт
   * молча охранять пустоту.
   */
  const UPGRADE_SEED = 20260820;

  const boughtBranches = (
    profile: AiProfile,
    seconds: number,
    seed: number = UPGRADE_SEED,
  ): readonly number[] => {
    const opponent = createOpponent(AI, seed, profile);
    const branches: number[] = [];

    let world = createWorld(seed);
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
    const branches = boughtBranches(BASELINE_PROFILE, 240);
    const targets = new Set(branches.map((branch) => UPGRADE_BRANCHES[branch]?.target));

    // Сначала — что покупок вообще хватает. Три покупки разошлись бы
    // по целям и при выборе наугад, и тест перестал бы что-либо значить.
    expect(branches.length).toBeGreaterThanOrEqual(10);
    expect(targets.size).toBeGreaterThan(1);
  });

  it('дальнобойный профиль покупает дальность стрелков, а обычный — нет', () => {
    // Ради этого свойства профиль и заведён: без него замерить ветки
    // дальности на арене нечем. Внутри цели противник берёт самую
    // дешёвую ветку, а дальность стоит 240 и 480 при 60 и 120 у прочих
    // веток тех же типов — то есть обычный профиль не выберет её ни разу
    // за матч расчётной длины, и замер показал бы ровно ноль.
    const rangeBranches = new Set([
      upgradeBranchIndex(UpgradeTarget.UnitSniper, UpgradeStat.Range),
      upgradeBranchIndex(UpgradeTarget.UnitTesla, UpgradeStat.Range),
    ]);

    const bought = boughtBranches(LONG_RANGE_PROFILE, 480);
    const range = bought.filter((branch) => rangeBranches.has(branch));

    expect(range.length).toBeGreaterThan(0);
    // И обратная страховка: покупки идут не только в дальность, иначе
    // профиль был бы не манерой, а одной кнопкой.
    expect(bought.length).toBeGreaterThan(range.length);

    // Обычный профиль на том же стенде дальность не берёт вовсе.
    const baseline = boughtBranches(BASELINE_PROFILE, 480);

    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline.filter((branch) => rangeBranches.has(branch))).toEqual([]);
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

  it('базовый профиль не держит запас ни при каком доходе', () => {
    // Прежде это следовало из цены: удар стоил полусотни стоимостей
    // юнита и при доходе замера — четырнадцать за тик — объявлялся
    // недостижимым. Удар подешевел до шестнадцати, и то же самое теперь
    // следует из МАНЕРЫ: запас держит лишь тот, кто в ракету
    // вкладывается.
    //
    // Проверяется обеими границами: и доходом замера, и заведомо
    // избыточным. Одной мало — первая проверяла бы достижимость,
    // а не манеру.
    expect(reserveOf(withReserve, 14, BASELINE_PROFILE)).toBe(0);
    expect(reserveOf(withReserve, Math.ceil(enough) * 10, BASELINE_PROFILE)).toBe(0);
  });

  it('у стратега запас держится, потому что он в ракету и вкладывается', () => {
    const late = STRATEGIST_PROFILE.phases[STRATEGIST_PROFILE.phases.length - 1];
    if (late === undefined) throw new Error('в профиле стратега нет фаз');

    expect(reserveOf(late, 14, STRATEGIST_PROFILE)).toBe(NUKE_COST);
  });

  it('запас исчезает и у стратега, когда доход слишком мал', () => {
    // Правило достижимости никуда не делось, оно лишь стало вторым
    // условием после манеры: копить на то, чего не накопить, значит
    // запрещать себе все покупки разом.
    const late = STRATEGIST_PROFILE.phases[STRATEGIST_PROFILE.phases.length - 1];
    if (late === undefined) throw new Error('в профиле стратега нет фаз');

    const meagre =
      Math.floor(
        NUKE_COST / (TICKS_PER_SECOND * STRATEGIST_PROFILE.spending.savingHorizonSeconds),
      ) - 1;

    expect(reserveOf(late, meagre, STRATEGIST_PROFILE)).toBe(0);
  });

  it('граница проходит ровно там, где кончается горизонт накопления', () => {
    // Смысл правила одной строкой: тот же вопрос, который уже задаётся
    // о каждой отдельной покупке, задан о запасе, и ответ на него один.
    expect(savingLimit(Math.ceil(enough), BASELINE_PROFILE)).toBeGreaterThanOrEqual(NUKE_COST);
    expect(savingLimit(Math.floor(enough) - 1, BASELINE_PROFILE)).toBeLessThan(NUKE_COST);
  });

  it('ядерные ветки прокачки покупает только стратег', () => {
    // Сюда переехало отличие манеры «Стратега», когда удешевление удара
    // стёрло прежнее — экономическое.
    //
    // Правило нужно не только ради манеры, и это важнее. Внутри выпавшей
    // цели берётся самая дешёвая ветка, а обе ядерные сидят на цели
    // «база» рядом с добычей энергии: добыча дорожает на двадцать пять
    // процентов за уровень и уже на шестом стоит дороже мощности заряда.
    // Без запрета всякий, кто качает экономику, молча начинает качать
    // ракету — на осадном профиле это стоило ему Теслы за десять минут
    // матча.
    const buysNuke = (profile: AiProfile): boolean => profile.nuke.invest === true;

    expect(buysNuke(STRATEGIST_PROFILE)).toBe(true);
    expect(Object.values(PROFILES).filter(buysNuke)).toEqual([STRATEGIST_PROFILE]);
  });

  it('стратег отличается от базового ровно двумя настройками', () => {
    // Свидетель того, что манера сделана настройкой, а не веткой в коде:
    // всё, кроме названного здесь, у профилей совпадает. Сломается этот
    // тест — значит, «Стратег» перестал быть базовым профилем с другими
    // настройками, и разбор в его замысле надо переписывать.
    //
    // Настроек стало две, и вторая появилась не от хорошей жизни.
    // Прежде хватало горизонта: удар стоил полусотни стоимостей юнита
    // и был недостижим для нетерпеливых. Удар подешевел до шестнадцати,
    // достижим стал для всех, и отличие переехало на право покупать
    // ядерные ветки прокачки.
    expect(STRATEGIST_PROFILE.spending.savingHorizonSeconds).toBeGreaterThan(
      BASELINE_PROFILE.spending.savingHorizonSeconds,
    );
    expect(STRATEGIST_PROFILE.nuke.invest).toBe(true);
    expect(BASELINE_PROFILE.nuke.invest).toBeUndefined();

    expect({
      ...STRATEGIST_PROFILE,
      id: '',
      spending: BASELINE_PROFILE.spending,
      nuke: BASELINE_PROFILE.nuke,
    }).toEqual({ ...BASELINE_PROFILE, id: '' });
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

describe('накопление уступает очередь тому, что выгоднее', () => {
  /**
   * Решения ОБЕИХ сторон матча компьютера против компьютера.
   *
   * Матч с бездействующим соперником для этой проверки не годится, и это
   * само по себе находка: там укрепления никто не сносит, покрытие вокруг
   * генерала остаётся насыщенным, и новая башня честно ничего не стоит.
   * Обгон накопления в таком матче почти не случается — и правильно
   * делает. Видно его только там, где укрепления теряют и восстанавливают.
   *
   * Seed сторонам разводятся так же, как это делает арена. Взяв их
   * близкими, мы получили бы двух почти одинаковых игроков, чей матч
   * вырождается в симметричное топтание, — на таком матче обгон
   * не наблюдается вовсе.
   */
  const DUEL_SEED = 3000;

  const duel = (seconds: number): readonly DecisionRecord[] => {
    const records: DecisionRecord[] = [];
    const observe = (record: DecisionRecord): void => {
      records.push(record);
    };

    const sides = [DUEL_SEED ^ 0x5bf03635, DUEL_SEED ^ 0x2f6e1a77].map((seed, index) =>
      createOpponent(asPlayerId(index), seed, BASELINE_PROFILE, observe),
    );

    let world = createWorld(DUEL_SEED);
    for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
      world = step(
        world,
        sides.flatMap((side) => side.decide(world)),
      );
    }

    return records;
  };

  const decisions = duel(180);

  it('очередь доходит до постройки, даже когда та не первая', () => {
    // Главная беда, ради которой всё затевалось. До правки первое же
    // «коплю» обрывало перебор, и до постройки очередь не доходила
    // НИ РАЗУ, если она не стояла первой: сто процентов решений в каждом
    // из трёх таких порядков трат.
    const late = decisions.filter((record) => record.spendOrder.indexOf('build') > 0);
    const tried = late.filter((record) =>
      record.attempts.some((attempt) => attempt.spending === 'build'),
    );

    expect(late.length).toBeGreaterThan(0);
    expect(tried.length).toBeGreaterThan(0);
  });

  it('копя на одно, противник покупает другое, если оно выгоднее', () => {
    // Тот самый обгон. До правки решений, где что-то и копится, и
    // покупается, не бывало вовсе: первое же «коплю» обрывало перебор.
    const overtook = decisions.filter(
      (record) =>
        record.attempts.some((attempt) => attempt.result === 'wait') &&
        record.attempts.some((attempt) => attempt.result === 'bought'),
    );

    expect(overtook.length).toBeGreaterThan(0);
  });

  it('обгоняет именно более выгодное, а не более дешёвое', () => {
    // Различие принципиальное и проверено прогоном: «покупай что дешевле
    // цели» вырождается в «покупай юнитов всегда». Купившая трата обязана
    // давать больше прибавки на единицу энергии, чем та, на которую
    // копили, — а раз прибавку мы здесь не видим, проверяем следствие:
    // уступившие очередь помечены своей причиной, и среди них есть юниты.
    const yielded = decisions.flatMap((record) =>
      record.attempts.filter((attempt) => attempt.note === AttemptNote.SavingForBetter),
    );

    expect(yielded.length).toBeGreaterThan(0);
    expect(yielded.some((attempt) => attempt.spending === 'train')).toBe(true);
    for (const attempt of yielded) expect(attempt.result).toBe('pass');
  });

  it('купив, противник не считается копившим', () => {
    // Иначе исправно покупающий башни противник через полторы минуты
    // объявлялся бы потерявшим терпение и начинал тратить казну куда попало.
    for (const record of decisions) {
      const bought = record.attempts.some((attempt) => attempt.result === 'bought');
      if (bought) expect(record.waitStreak).toBe(0);
    }
  });

  it('накопление на несравнимое не пускает вперёд никого', () => {
    // В ранней фазе интересна одна экономика, а её прибавка выражается
    // будущим доходом, а не уроном, и сравнивать её не с чем. Такое
    // накопление обязано отложить всё, что стоит за ним: считать
    // неизвестное малым значило бы пускать вперёд что угодно.
    const waitedOnUpgrade = decisions
      .filter((record) => record.phaseIndex === 0)
      .map((record) => ({
        record,
        at: record.attempts.findIndex(
          (attempt) => attempt.spending === 'upgrade' && attempt.result === 'wait',
        ),
      }))
      .filter((entry) => entry.at >= 0);

    expect(waitedOnUpgrade.length).toBeGreaterThan(0);
    for (const { record, at } of waitedOnUpgrade) {
      for (const attempt of record.attempts.slice(at + 1)) {
        expect(attempt.result).not.toBe('bought');
      }
    }
  });
});
