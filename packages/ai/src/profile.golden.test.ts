import { describe, expect, it } from 'vitest';
import { StructureKind, TICKS_PER_SECOND, asPlayerId } from '@td/shared';
import type { PlayerId } from '@td/shared';
import { cellAt, checksum, createWorld, step } from '@td/sim';
import { approachOf } from './approach.js';
import { createOpponent } from './opponent.js';
import { BASELINE_PROFILE, WALL_LIGHT_PROFILE } from './profile.js';
import type { AiProfile } from './profile.js';

/**
 * Эталон профиля по умолчанию — страж утверждения «перекладывание констант
 * в профиль поведения не изменило игру».
 *
 * Устроен по образцу `determinism.golden.test.ts` в ядре: прогоняем матч
 * фиксированной длины с фиксированным seed и сравниваем контрольную сумму
 * с числом, записанным здесь.
 *
 * Число снято на коде ДО выделения профиля — прогоном той же длины с теми же
 * seed, когда манера игры ещё задавалась константами модулей. Совпадение
 * доказывает, что при переносе пятнадцати с лишним величин ни одна
 * не потерялась и ни в одной не появилось опечатки; такую ошибку иначе
 * не поймать — она не ломает ни типы, ни тесты свойств, а просто делает
 * противника чуть другим.
 *
 * Если тест упал, а профиль по умолчанию менялся намеренно — эталон нужно
 * обновить тем же коммитом, что и правку. Тогда история настройки видна
 * в diff, а не теряется.
 */

const SEED = 20260820;
const SECONDS = 180;
const AI: PlayerId = asPlayerId(1);

/**
 * Снято на правилах изменения `build-towers-in-force`: постройка
 * перестала ограничиваться одной за решение, а неприкосновенный запас
 * фазы стал держаться только тогда, когда он достижим при нынешнем
 * доходе.
 *
 * Сдвиг крупный и ровно тот, которого добивались. Построек за три минуты
 * стало вчетверо больше — одна против четырёх, — а энергии в конце втрое
 * меньше: казна теперь тратится, а не копится под ядерный удар, которого
 * за двадцать матчей арены не случилось ни разу. Войско выросло с пяти
 * машин до тринадцати по той же причине. Уровней прокачки стало меньше
 * (32 против 26): деньги ушли в постройки и войско.
 *
 * Предыдущее число, 502076340, было снято на пяти изменениях —
 * slow-down-construction, protect-base-surroundings, fix-saving-patience,
 * honor-profile-preferences и разделе о сравнении выгоды покупок
 * из fix-ai-spending.
 */
const GOLDEN_CHECKSUM = 161109159;

interface Outcome {
  readonly checksum: number;
  readonly structures: number;
  readonly units: number;
  readonly upgradeLevels: number;
  readonly energy: number;
  readonly commands: number;
  readonly furthestFraction: number;
}

const play = (profile: AiProfile): Outcome => {
  const opponent = createOpponent(AI, SEED, profile);
  const approach = approachOf(createWorld(SEED), AI);
  if (approach === undefined) throw new Error('вероятный путь не посчитан');

  let world = createWorld(SEED);
  let commands = 0;
  let furthest = 0;

  for (let tick = 0; tick < SECONDS * TICKS_PER_SECOND; tick += 1) {
    const issued = opponent.decide(world);
    commands += issued.length;
    world = step(world, issued);

    const general = world.generals[AI];
    if (general === undefined || !general.alive) continue;

    const fromHome = approach.fromHome[cellAt(general.position)] ?? 0;
    if (fromHome > furthest) furthest = fromHome;
  }

  const player = world.players[AI];

  return {
    checksum: checksum(world),
    structures: world.structures.filter(
      (structure) => structure.owner === AI && structure.kind !== StructureKind.Base,
    ).length,
    units: world.units.filter((unit) => unit.owner === AI).length,
    upgradeLevels: player?.upgrades.reduce((sum, upgrade) => sum + upgrade.level, 0) ?? 0,
    energy: player?.energy ?? 0,
    commands,
    furthestFraction: Number((furthest / approach.shortest).toFixed(4)),
  };
};

describe('эталон профиля по умолчанию', () => {
  const outcome = play(BASELINE_PROFILE);

  it('совпадает с контрольной суммой, снятой до выделения профиля', () => {
    expect(outcome.checksum).toBe(GOLDEN_CHECKSUM);
  });

  it('совпадает и по наблюдаемым величинам', () => {
    // Дублирует предыдущую проверку — но не зря. Контрольная сумма
    // говорит только «сошлось» или «не сошлось»; если она разойдётся,
    // именно эти числа покажут, где искать: пропала прокачка, не там
    // построено или генерал не дошёл.
    expect(outcome).toMatchObject({
      structures: 4,
      units: 13,
      upgradeLevels: 26,
      energy: 747,
      commands: 89,
      furthestFraction: 0.8889,
    });
  });

  it('вызов без профиля равнозначен вызову с профилем по умолчанию', () => {
    // Третий аргумент необязателен намеренно: существующие вызовы
    // в клиенте и в тестах от появления профиля не изменились.
    const opponent = createOpponent(AI, SEED);
    const explicit = createOpponent(AI, SEED, BASELINE_PROFILE);

    let a = createWorld(SEED);
    let b = createWorld(SEED);
    for (let tick = 0; tick < 30 * TICKS_PER_SECOND; tick += 1) {
      a = step(a, opponent.decide(a));
      b = step(b, explicit.decide(b));
    }

    expect(checksum(a)).toBe(checksum(b));
  });
});

describe('профиль действительно влияет на игру', () => {
  const patient: AiProfile = {
    ...BASELINE_PROFILE,
    id: 'test-patient',
    spending: { ...BASELINE_PROFILE.spending, savingHorizonSeconds: 5 },
  };

  it('другой профиль даёт другой матч', () => {
    expect(play(patient).checksum).not.toBe(GOLDEN_CHECKSUM);
  });

  it('профиль, различающийся только частотой стен, снова различим', () => {
    // Обещанная хорошая новость.
    //
    // До `build-towers-in-force` этот тест утверждал ОБРАТНОЕ: оба
    // профиля давали побайтово одинаковый матч, потому что противник
    // строил так мало, что счётчик построек не доходил ни до четвёртой,
    // ни до восьмой, и частота стен ни на что не влияла. В комментарии
    // к нему стояло, что он обязан начать падать, когда постройки
    // вернутся в матч.
    //
    // Постройки вернулись: за три минуты их стало четыре вместо одной,
    // счётчик доходит до четвёртой, и `wallEvery` снова что-то значит.
    expect(play(WALL_LIGHT_PROFILE).checksum).not.toBe(GOLDEN_CHECKSUM);
  });
});
