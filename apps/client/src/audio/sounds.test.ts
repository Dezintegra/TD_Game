import { describe, expect, it } from 'vitest';
import { BLAST_LIFETIME_TICKS, BlastKind, NUKE_DELAY_TICKS, TICKS_PER_SECOND } from '@td/shared';
import { createFilter, peakOf, rms, zeroCrossings } from './dsp.js';
import {
  LOOPING,
  SOUNDS,
  SOUND_PEAK,
  SOUND_SECONDS,
  Sound,
  VARIANTS,
  renderSound,
} from './sounds.js';

/**
 * Тембр тестом не проверяется — что «пиу» звучит как «пиу», слышно только
 * ухом. Проверяется всё остальное, и этого немало: форма, длительности,
 * направление изменения спектра, соотношение фронта и хвоста, различимость
 * вариантов. Ошибки, которые эти проверки ловят, — перепутанное
 * направление развёртки, потерянный слой, щелчок на краю, разошедшаяся
 * с миром длительность — на слух опознаются как «что-то не то»,
 * а числами видны сразу.
 */

const SAMPLE_RATE = 48000;

/** Первый вариант каждого звука. Дальше он и проверяется. */
const first = (sound: Sound): Float32Array => renderSound(sound, 0, SAMPLE_RATE);

const quarter = (samples: Float32Array, index: number): [number, number] => [
  Math.floor((samples.length * index) / 4),
  Math.floor((samples.length * (index + 1)) / 4),
];

/**
 * Среднеквадратичное значение в полосе.
 *
 * Фильтр прогоняется с самого начала, а не с интересующего места: у него
 * есть память, и запущенный с середины он мерил бы собственный переходный
 * процесс.
 */
const bandRms = (
  samples: Float32Array,
  mode: 'low' | 'high',
  cutoffHz: number,
  from: number,
  to: number,
): number => {
  const filter = createFilter(SAMPLE_RATE, mode);

  let sum = 0;
  let count = 0;
  for (let index = 0; index < to; index += 1) {
    const value = filter(samples[index] ?? 0, cutoffHz, 0.7);
    if (index >= from) {
      sum += value * value;
      count += 1;
    }
  }

  return Math.sqrt(sum / Math.max(1, count));
};

describe('форма звуков', () => {
  it.each(SOUNDS)('«%s» не содержит NaN и не выходит за единицу', (sound) => {
    const samples = first(sound);

    let broken = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index] ?? 0;
      if (!Number.isFinite(value) || Math.abs(value) > 1) broken += 1;
    }

    expect(broken).toBe(0);
    expect(peakOf(samples)).toBeGreaterThan(0.1);
  });

  it.each(SOUNDS)('«%s» имеет заявленную длительность', (sound) => {
    const samples = first(sound);
    expect(samples.length).toBe(Math.round(SOUND_SECONDS[sound] * SAMPLE_RATE));
  });

  it.each(SOUNDS.filter((sound) => !LOOPING[sound]))('«%s» не щёлкает на краях', (sound) => {
    // Не «ровно ноль», а «тишина»: у гибели генерала поверх взрыва
    // ложится выбегающий ротор, и на последнем отсчёте от него остаются
    // десятые доли миллиардной. Слышимого щелчка это не даёт, а точного
    // нуля не оставляет.
    const samples = first(sound);
    expect(Math.abs(samples[0] ?? 1)).toBeLessThan(1e-6);
    expect(Math.abs(samples[samples.length - 1] ?? 1)).toBeLessThan(1e-6);
  });

  it('зацикленный звук сходится сам с собой', () => {
    // Ротору обнуление краёв противопоказано: провал громкости
    // четырнадцать раз в секунду слышнее того щелчка, от которого оно
    // спасает. Вместо этого конец петли обязан сойтись с началом.
    const samples = first(Sound.Rotor);
    const head = samples[0] ?? 0;
    const tail = samples[samples.length - 1] ?? 0;
    expect(Math.abs(head - tail)).toBeLessThan(0.01);
  });

  it('длительность не зависит от частоты дискретизации', () => {
    for (const rate of [44100, 48000]) {
      const samples = renderSound(Sound.Rotor, 0, rate);
      expect(samples.length).toBe(Math.round(SOUND_SECONDS[Sound.Rotor] * rate));
    }
  });

  it('ротор тише самого тихого события более чем вдвое', () => {
    // Единственный непрерывный звук в игре, и мерить его надо не сам
    // по себе, а против остальных: он висит над игроком весь матч.
    // При уровне вровень с событиями он становится подложкой, поверх
    // которой чужой стрельбы не слышно.
    const events = SOUNDS.filter((sound) => sound !== Sound.Rotor);
    const quietest = Math.min(...events.map((sound) => SOUND_PEAK[sound]));

    expect(SOUND_PEAK[Sound.Rotor] * 2).toBeLessThan(quietest);
  });
});

describe('варианты', () => {
  it.each(SOUNDS.filter((sound) => VARIANTS[sound] > 1))(
    'у «%s» варианты различаются отсчётами, но не длительностью',
    (sound) => {
      const a = renderSound(sound, 0, SAMPLE_RATE);
      const b = renderSound(sound, 1, SAMPLE_RATE);

      expect(b.length).toBe(a.length);

      let same = 0;
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] === b[index]) same += 1;
      }

      // Совпадать может разве что тишина по краям.
      expect(same / a.length).toBeLessThan(0.05);
    },
  );

  it('один и тот же вариант считается одинаково', () => {
    const a = renderSound(Sound.BlastUnit, 2, SAMPLE_RATE);
    const b = renderSound(Sound.BlastUnit, 2, SAMPLE_RATE);
    expect(Array.from(a.slice(0, 500))).toEqual(Array.from(b.slice(0, 500)));
  });
});

describe('взрывы', () => {
  const BLASTS = [Sound.BlastUnit, Sound.BlastGeneral, Sound.BlastStructure, Sound.NukeBlast];

  it('длительности упорядочены так же, как сроки жизни взрывов в мире', () => {
    const order = [
      BLAST_LIFETIME_TICKS[BlastKind.Unit],
      BLAST_LIFETIME_TICKS[BlastKind.General],
      BLAST_LIFETIME_TICKS[BlastKind.Structure],
      BLAST_LIFETIME_TICKS[BlastKind.Nuke],
    ];

    for (let index = 1; index < BLASTS.length; index += 1) {
      const previous = BLASTS[index - 1] as Sound;
      const current = BLASTS[index] as Sound;
      expect(order[index - 1]).toBeLessThan(order[index] as number);
      expect(SOUND_SECONDS[previous]).toBeLessThan(SOUND_SECONDS[current]);
    }
  });

  it.each(BLASTS)('у «%s» верх умирает быстрее низа', (sound) => {
    // Главное свойство настоящего взрыва: воздух гасит высокие частоты
    // на порядок сильнее низких. Если этого нет, взрыв опознаётся
    // синтезатором с первой ноты.
    //
    // Меряется на первой десятой доле звука, и это не произвол.
    // На хвосте та же мерка врёт: там сыплются обломки, а они по замыслу
    // яркие, и отношение полос снова растёт — но растёт от того, что низ
    // кончился, а не от того, что вернулся верх. Разрыв между кромкой
    // и телом виден именно в начале, и он там кратный.
    const samples = first(sound);
    const crack = Math.round(samples.length * 0.02);
    const body = Math.round(samples.length * 0.1);

    const crackRatio =
      bandRms(samples, 'high', 4000, 0, crack) / bandRms(samples, 'low', 200, 0, crack);
    const bodyRatio =
      bandRms(samples, 'high', 4000, crack, body) / bandRms(samples, 'low', 200, crack, body);

    expect(bodyRatio).toBeLessThan(crackRatio / 4);
  });

  it.each(BLASTS)('у «%s» верхняя полоса гаснет и больше не возвращается', (sound) => {
    const samples = first(sound);
    const crack = Math.round(samples.length * 0.02);
    const body = Math.round(samples.length * 0.1);
    const tail = Math.round(samples.length * 0.75);

    const atCrack = bandRms(samples, 'high', 4000, 0, crack);
    const atBody = bandRms(samples, 'high', 4000, crack, body);
    const atTail = bandRms(samples, 'high', 4000, tail, samples.length);

    expect(atBody).toBeLessThan(atCrack / 5);
    expect(atTail).toBeLessThan(atBody);
  });

  it.each(BLASTS)('у «%s» фронт кратно громче хвоста', (sound) => {
    const samples = first(sound);
    const head = rms(samples, 0, Math.round(0.02 * SAMPLE_RATE));
    const tail = rms(samples, Math.round(samples.length * 0.75));
    expect(head).toBeGreaterThan(tail * 3);
  });

  it('в хвосте у постройки ещё сыплется, а у машины уже нет', () => {
    // Меряется не «спайковостью», а живучестью хвоста относительно
    // собственного фронта. Первая догадка была именно про спайковость —
    // и оказалась неверной ровно наоборот: густая осыпь сооружения
    // сливается в шум и по отношению пика к среднему ПРОИГРЫВАЕТ
    // редким одиночным толчкам. Считать надо не остроту, а то, осталось
    // ли вообще что-нибудь.
    //
    // У машины осыпь кончается на середине звука намеренно: их гибнут
    // десятки, и долгий хвост у каждой превратил бы бой в сплошной гул.
    const liveliness = (sound: Sound): number => {
      const samples = first(sound);
      const front = rms(samples, 0, Math.round(samples.length * 0.02));
      const tail = rms(samples, Math.round(samples.length * 0.75));
      return tail / front;
    };

    expect(liveliness(Sound.BlastStructure)).toBeGreaterThan(liveliness(Sound.BlastUnit) * 3);
  });
});

describe('выстрелы', () => {
  it('трассер падает по высоте', () => {
    const samples = first(Sound.BoltUnit);
    const [headFrom, headTo] = quarter(samples, 0);
    const [tailFrom, tailTo] = quarter(samples, 3);

    expect(zeroCrossings(samples, tailFrom, tailTo) / (tailTo - tailFrom)).toBeLessThan(
      zeroCrossings(samples, headFrom, headTo) / (headTo - headFrom),
    );
  });

  it('трассер башни ниже и длиннее машинного', () => {
    const unit = first(Sound.BoltUnit);
    const tower = first(Sound.BoltTower);

    expect(SOUND_SECONDS[Sound.BoltTower]).toBeGreaterThan(SOUND_SECONDS[Sound.BoltUnit]);
    expect(zeroCrossings(tower) / tower.length).toBeLessThan(zeroCrossings(unit) / unit.length);
  });

  it('луч держит полку, а трассер нет', () => {
    // Разница не в громкости, а в форме: трассер это удар и затухание,
    // луч держится столько, сколько его видно на поле.
    const plateau = (sound: Sound): number => {
      const samples = first(sound);
      const middle = rms(
        samples,
        Math.floor(samples.length * 0.4),
        Math.floor(samples.length * 0.6),
      );
      const loudest = rms(samples, 0, Math.floor(samples.length * 0.2));
      return middle / loudest;
    };

    expect(plateau(Sound.BeamUnit)).toBeGreaterThan(0.8);
    expect(plateau(Sound.BoltUnit)).toBeLessThan(0.5);
  });

  it('луч башни ниже машинного', () => {
    const unit = first(Sound.BeamUnit);
    const tower = first(Sound.BeamTower);
    expect(zeroCrossings(tower) / tower.length).toBeLessThan(zeroCrossings(unit) / unit.length);
  });

  it('разряд Теслы длиннее трассера и тускнеет к концу', () => {
    const samples = first(Sound.Arc);
    expect(SOUND_SECONDS[Sound.Arc]).toBeGreaterThan(SOUND_SECONDS[Sound.BoltUnit] * 3);

    const [headFrom, headTo] = quarter(samples, 0);
    const [tailFrom, tailTo] = quarter(samples, 3);
    expect(zeroCrossings(samples, tailFrom, tailTo) / (tailTo - tailFrom)).toBeLessThan(
      zeroCrossings(samples, headFrom, headTo) / (headTo - headFrom) / 3,
    );
  });

  it('ракета громче всего в момент прилёта, а не в начале', () => {
    const samples = first(Sound.Missile);
    const window = Math.round(0.05 * SAMPLE_RATE);

    let loudest = 0;
    let loudestAt = 0;
    for (let index = 0; index + window < samples.length; index += window) {
      const level = rms(samples, index, index + window);
      if (level > loudest) {
        loudest = level;
        loudestAt = index / SAMPLE_RATE;
      }
    }

    // Полёт занимает половину срока записи о выстреле; прилёт приходится
    // на его конец, и самое громкое место обязано быть там, а не в начале.
    const flight = SOUND_SECONDS[Sound.Missile] - 0.45;
    expect(loudestAt).toBeGreaterThan(flight - 0.1);
    expect(rms(samples, 0, window)).toBeLessThan(loudest);
  });
});

describe('ядерный удар', () => {
  it('свист длится ровно задержку удара', () => {
    expect(SOUND_SECONDS[Sound.NukeFall]).toBeCloseTo(NUKE_DELAY_TICKS / TICKS_PER_SECOND, 6);
  });

  it('свист нарастает и понижается', () => {
    const samples = first(Sound.NukeFall);
    const [headFrom, headTo] = quarter(samples, 0);
    const [tailFrom, tailTo] = quarter(samples, 3);

    expect(rms(samples, tailFrom, tailTo)).toBeGreaterThan(rms(samples, headFrom, headTo) * 3);
    expect(zeroCrossings(samples, tailFrom, tailTo) / (tailTo - tailFrom)).toBeLessThan(
      zeroCrossings(samples, headFrom, headTo) / (headTo - headFrom),
    );
  });

  it('удар — самый долгий звук в игре', () => {
    for (const sound of SOUNDS) {
      if (sound === Sound.NukeBlast) continue;
      expect(SOUND_SECONDS[sound]).toBeLessThan(SOUND_SECONDS[Sound.NukeBlast]);
    }
  });
});
