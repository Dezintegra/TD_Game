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
 * Снято на правилах изменения `value-towers-honestly`: покупка башни
 * оценивается своей меркой — уроном, горизонтом и курсом энергии, —
 * а не выгодой рубежа генерала; и решение «коплю» перестало обрывать
 * очередь тратам, дающим больше прибавки на единицу энергии.
 *
 * Сдвиг ожидаемый и объясним построчно. Построек шесть против четырёх:
 * до постройки наконец доходит очередь, а прежде она не доходила ни разу,
 * если не стояла в порядке первой. Войско выросло вдвое, с тринадцати
 * машин до двадцати шести, а уровней прокачки стало меньше (17 против
 * 26) — это та же причина с другой стороны: пока войско мало, прокачка
 * умножает почти пустое место и честно проигрывает сравнение и юниту,
 * и башне. Генерал заходит дальше — 0,956 пути против 0,889.
 *
 * Следом добавился разворот постройки (`turn-fire-into-spectacle`).
 * Поведения противника он не трогает вовсе: сектора обстрела нет,
 * разворот мгновенный, выбор цели от него не зависит. Но это величина
 * состояния мира, и она входит в контрольную сумму наравне с разворотом
 * юнита, — поэтому сумма сдвинулась, а наблюдаемые величины профиля
 * (постройки, войско, прокачка, путь генерала) остались прежними.
 *
 * Предыдущие числа: 3349686969 — `value-towers-honestly`; 161109159 —
 * `build-towers-in-force` (постройка группой и достижимый ядерный
 * запас), 502076340 — на пяти изменениях до него.
 */
const GOLDEN_CHECKSUM = 1815286486;

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
      structures: 6,
      units: 26,
      upgradeLevels: 17,
      energy: 996,
      commands: 81,
      furthestFraction: 0.9556,
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
    // Постройки вернулись: за три минуты их стало шесть вместо одной,
    // счётчик доходит до четвёртой, и `wallEvery` снова что-то значит.
    expect(play(WALL_LIGHT_PROFILE).checksum).not.toBe(GOLDEN_CHECKSUM);
  });
});
