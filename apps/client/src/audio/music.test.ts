import { describe, expect, it } from 'vitest';
import { peakOf, rms } from './dsp.js';
import {
  MUSIC_BPM,
  MUSIC_LOOP_BARS,
  MUSIC_LOOP_BPM,
  MUSIC_LOOP_PEAK,
  MUSIC_LOOP_SEAM_SECONDS,
  MUSIC_LOOP_SECONDS,
  MUSIC_STEPS,
  MUSIC_VOICES,
  MusicVoice,
  STEPS_PER_BAR,
  STEP_SECONDS,
  musicSeconds,
  notesAt,
  prepareMusicLoop,
  renderMusicVoice,
} from './music.js';

const SAMPLE_RATE = 48000;

describe('инструменты', () => {
  it.each(MUSIC_VOICES)('«%s» имеет заявленную длину и не щёлкает', (voice) => {
    const samples = renderMusicVoice(voice, SAMPLE_RATE);

    expect(samples.length).toBe(Math.round(musicSeconds(voice) * SAMPLE_RATE));
    expect(Math.abs(samples[0] ?? 1)).toBeLessThan(1e-6);
    expect(Math.abs(samples[samples.length - 1] ?? 1)).toBeLessThan(1e-6);
    expect(peakOf(samples)).toBeGreaterThan(0.1);
    expect(peakOf(samples)).toBeLessThanOrEqual(1);
  });

  it.each(MUSIC_VOICES)('«%s» не содержит NaN', (voice) => {
    const samples = renderMusicVoice(voice, SAMPLE_RATE);
    let broken = 0;
    for (let index = 0; index < samples.length; index += 1) {
      if (!Number.isFinite(samples[index] ?? 0)) broken += 1;
    }
    expect(broken).toBe(0);
  });

  it('все инструменты затухают, ни один не тянется ровно', () => {
    // Фон, у которого нота не кончается, слышен гудением, а не музыкой.
    for (const voice of MUSIC_VOICES) {
      const samples = renderMusicVoice(voice, SAMPLE_RATE);
      const head = rms(samples, 0, Math.floor(samples.length * 0.2));
      const tail = rms(samples, Math.floor(samples.length * 0.8));
      expect(tail).toBeLessThan(head / 2);
    }
  });

  it('бочка ниже хэта, а хэт короче всех', () => {
    const crossings = (samples: Float32Array): number => {
      let count = 0;
      let previous = samples[0] ?? 0;
      for (let index = 1; index < samples.length; index += 1) {
        const value = samples[index] ?? 0;
        if (previous < 0 !== value < 0) count += 1;
        previous = value;
      }
      return count / samples.length;
    };

    expect(crossings(renderMusicVoice(MusicVoice.Kick, SAMPLE_RATE))).toBeLessThan(
      crossings(renderMusicVoice(MusicVoice.Hat, SAMPLE_RATE)),
    );

    for (const voice of MUSIC_VOICES) {
      if (voice === MusicVoice.Hat) continue;
      expect(musicSeconds(MusicVoice.Hat)).toBeLessThan(musicSeconds(voice));
    }
  });
});

describe('записанная петля', () => {
  /**
   * Подделка декодированного файла: тишина, потом «музыка».
   *
   * Музыка здесь — пила, потому что у неё есть и разрыв на стыке,
   * и различимые отсчёты: на синусе стык случайно мог бы сойтись сам.
   */
  const decoded = (silenceSeconds: number, musicSeconds: number, hz = 110): Float32Array[] => {
    const silence = Math.round(silenceSeconds * SAMPLE_RATE);
    const music = Math.round(musicSeconds * SAMPLE_RATE);
    const samples = new Float32Array(silence + music);

    for (let index = 0; index < music; index += 1) {
      const phase = ((index * hz) / SAMPLE_RATE) % 1;
      samples[silence + index] = 0.8 * (2 * phase - 1);
    }

    return [samples, samples.slice()];
  };

  it('длина берётся числом отсчётов, а не длиной файла', () => {
    // Ровно то, ради чего длина считается из темпа: у декодированного
    // буфера она зависит и от паддинга кодировщика, и от того,
    // ресемплировал ли браузер частоту.
    const loop = prepareMusicLoop(decoded(0.25, MUSIC_LOOP_SECONDS + 0.4), SAMPLE_RATE);

    expect(loop?.[0]?.length).toBe(Math.round(MUSIC_LOOP_SECONDS * SAMPLE_RATE));
    expect(loop?.[1]?.length).toBe(loop?.[0]?.length);
  });

  it('длина кратна такту исходного трека', () => {
    // Фраза в треке четырёхтактовая: длина, не кратная четырём тактам,
    // при каждом втором круге начинала бы её с середины.
    const bar = (4 * 60) / MUSIC_LOOP_BPM;
    expect(MUSIC_LOOP_SECONDS).toBeCloseTo(MUSIC_LOOP_BARS * bar, 9);
    expect(MUSIC_LOOP_BARS % 4).toBe(0);
    expect(MUSIC_LOOP_SECONDS).toBeGreaterThan(20);
  });

  it('тишина перед петлёй съедается, а музыка остаётся', () => {
    // В файле она лежит намеренно: в ней тонет задержка кодировщика,
    // которую иначе пришлось бы угадывать.
    const loop = prepareMusicLoop(decoded(0.25, MUSIC_LOOP_SECONDS + 0.4), SAMPLE_RATE);
    expect(rms(loop?.[0] as Float32Array, 0, 1000)).toBeGreaterThan(0.05);
  });

  it('стык замкнут: конец сходится с началом', () => {
    const loop = prepareMusicLoop(decoded(0.25, MUSIC_LOOP_SECONDS + 0.4), SAMPLE_RATE);
    const samples = loop?.[0] as Float32Array;
    const head = samples[0] ?? 0;
    const tail = samples[samples.length - 1] ?? 0;

    // Пила, обрезанная в произвольном месте, даёт разрыв под две
    // единицы; замыкание обязано свести его к неслышимому.
    expect(Math.abs(head - tail)).toBeLessThan(0.05);
  });

  it('уровень приведён к музыкальному, а не к боевому', () => {
    const loop = prepareMusicLoop(decoded(0.25, MUSIC_LOOP_SECONDS + 0.4), SAMPLE_RATE);
    expect(peakOf(loop?.[0] as Float32Array)).toBeCloseTo(MUSIC_LOOP_PEAK, 6);
  });

  it('короткой записи петли не получается вовсе', () => {
    // Огрызок вместо расписания хуже, чем расписание.
    const short = decoded(0.25, MUSIC_LOOP_SECONDS - 0.1);
    expect(prepareMusicLoop(short, SAMPLE_RATE)).toBeUndefined();

    // Ровно длины петли тоже мало: на замыкание стыка нужен запас.
    const exact = decoded(0, MUSIC_LOOP_SECONDS + MUSIC_LOOP_SEAM_SECONDS / 2);
    expect(prepareMusicLoop(exact, SAMPLE_RATE)).toBeUndefined();
  });
});

describe('расписание', () => {
  it('длина шага соответствует темпу', () => {
    // Шестнадцатая при 88 ударах в минуту.
    expect(STEP_SECONDS).toBeCloseTo(60 / MUSIC_BPM / 4, 9);
    expect(MUSIC_STEPS).toBe(STEPS_PER_BAR * 8);
  });

  it('петля замкнута: шаг за последним совпадает с первым', () => {
    expect(notesAt(MUSIC_STEPS)).toEqual(notesAt(0));
    expect(notesAt(MUSIC_STEPS * 3 + 7)).toEqual(notesAt(7));
    // И назад тоже: отрицательный шаг не должен ломать выборку.
    expect(notesAt(-1)).toEqual(notesAt(MUSIC_STEPS - 1));
  });

  it('бочка попадает только на доли', () => {
    for (let step = 0; step < MUSIC_STEPS; step += 1) {
      const kick = notesAt(step).some((note) => note.voice === MusicVoice.Kick);
      if (!kick) continue;

      const inBar = step % STEPS_PER_BAR;
      // Первая, третья доля — или подхват на последней шестнадцатой.
      expect([0, 8, 14]).toContain(inBar);
    }
  });

  it('ведущая линия молчит в первых двух тактах каждой половины', () => {
    for (let step = 0; step < MUSIC_STEPS; step += 1) {
      const lead = notesAt(step).some((note) => note.voice === MusicVoice.Lead);
      if (!lead) continue;

      const bar = Math.floor(step / STEPS_PER_BAR);
      expect([2, 3, 6, 7]).toContain(bar);
    }
  });

  it('половины петли не совпадают: иначе она вдвое короче, чем заявлена', () => {
    let different = 0;
    for (let step = 0; step < MUSIC_STEPS / 2; step += 1) {
      const first = JSON.stringify(notesAt(step));
      const second = JSON.stringify(notesAt(step + MUSIC_STEPS / 2));
      if (first !== second) different += 1;
    }
    expect(different).toBeGreaterThan(0);
  });

  it('на каждом шаге звучит не больше трёх инструментов', () => {
    // Фон обязан оставить середину диапазона бою. Плотная петля
    // соревнуется с ним за внимание и проигрывает обоим.
    for (let step = 0; step < MUSIC_STEPS; step += 1) {
      expect(notesAt(step).length).toBeLessThanOrEqual(3);
    }
  });

  it('каждый инструмент за петлю звучит хотя бы раз', () => {
    const heard = new Set<MusicVoice>();
    for (let step = 0; step < MUSIC_STEPS; step += 1) {
      for (const note of notesAt(step)) heard.add(note.voice);
    }
    expect([...heard].sort()).toEqual([...MUSIC_VOICES].sort());
  });

  it('все ноты имеют положительную частоту и громкость', () => {
    for (let step = 0; step < MUSIC_STEPS; step += 1) {
      for (const note of notesAt(step)) {
        expect(note.hz).toBeGreaterThan(0);
        expect(note.gain).toBeGreaterThan(0);
        expect(note.gain).toBeLessThanOrEqual(1);
      }
    }
  });

  it('петля длится больше двадцати секунд', () => {
    // Короткая петля через три круга начинает отсчитывать время
    // как метроном, а это ровно то, чего фону делать нельзя.
    expect(MUSIC_STEPS * STEP_SECONDS).toBeGreaterThan(20);
  });
});
