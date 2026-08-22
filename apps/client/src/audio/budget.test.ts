import { describe, expect, it } from 'vitest';
import { PER_FRAME, chooseCues } from './budget.js';
import type { Candidate } from './budget.js';
import { Sound } from './sounds.js';
import {
  DEFAULT_SOUND_SETTINGS,
  parseSoundSettings,
  serializeSoundSettings,
} from './settings.js';

const candidate = (sound: Sound, gain: number, key = Math.round(gain * 1e6)): Candidate => ({
  sound,
  key,
  cellX: 24,
  cellY: 24,
  gain,
});

describe('бюджет одновременных звуков', () => {
  it('пустой кадр даёт пустой список', () => {
    expect(chooseCues([])).toEqual([]);
  });

  it('неслышные отбрасываются и места не занимают', () => {
    const chosen = chooseCues([candidate(Sound.BoltUnit, 0), candidate(Sound.BoltUnit, 0.5)]);
    expect(chosen).toHaveLength(1);
  });

  it('потолок на вид соблюдается', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      candidate(Sound.BoltUnit, 1 - index * 0.03, index),
    );
    expect(chooseCues(many)).toHaveLength(4);
  });

  it('отбираются самые громкие, то есть ближайшие', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      candidate(Sound.BoltUnit, index / 20, index),
    );

    const chosen = chooseCues(many);
    const quietest = Math.min(...chosen.map((cue) => cue.gain));
    const loudestDropped = Math.max(
      ...many.filter((cue) => !chosen.some((kept) => kept.key === cue.key)).map((cue) => cue.gain),
    );

    expect(quietest).toBeGreaterThan(loudestDropped);
  });

  it('залп громче одиночного выстрела, но не во столько же раз', () => {
    const single = chooseCues([candidate(Sound.BoltUnit, 0.5)]);
    expect(single[0]?.boost).toBe(1);

    const volley = chooseCues(
      Array.from({ length: 12 }, (_, index) => candidate(Sound.BoltUnit, 0.5, index)),
    );

    const boost = volley[0]?.boost ?? 0;
    expect(boost).toBeGreaterThan(1);
    expect(boost).toBeLessThanOrEqual(1.6);
  });

  it('прибавка не превышает предела даже при сотне событий', () => {
    const storm = Array.from({ length: 100 }, (_, index) =>
      candidate(Sound.BlastUnit, 0.5, index),
    );
    for (const cue of chooseCues(storm)) expect(cue.boost).toBeLessThanOrEqual(1.6);
  });

  it('общий потолок кадра соблюдается поверх поштучных', () => {
    const mixed: Candidate[] = [];
    let key = 0;
    for (const sound of [
      Sound.BoltUnit,
      Sound.BoltTower,
      Sound.BeamUnit,
      Sound.BeamTower,
      Sound.Arc,
      Sound.Missile,
      Sound.BlastUnit,
      Sound.BlastStructure,
    ]) {
      for (let index = 0; index < 6; index += 1) mixed.push(candidate(sound, 0.9, key++));
    }

    expect(chooseCues(mixed).length).toBe(PER_FRAME);
  });

  it('ротор через бюджет не проходит: он не событие', () => {
    expect(chooseCues([candidate(Sound.Rotor, 1)])).toEqual([]);
  });
});

describe('настройки звука', () => {
  it('пустое и отсутствующее дают значения по умолчанию', () => {
    expect(parseSoundSettings(null)).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(parseSoundSettings(undefined)).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(parseSoundSettings('')).toEqual(DEFAULT_SOUND_SETTINGS);
  });

  it('испорченный JSON не бросает', () => {
    expect(parseSoundSettings('{не json')).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(parseSoundSettings('42')).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(parseSoundSettings('null')).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(parseSoundSettings('[]')).toEqual({ ...DEFAULT_SOUND_SETTINGS });
  });

  it('недостающее поле не отменяет остальных', () => {
    // Запись из прошлой версии клиента, где громкости музыки не было,
    // обязана сохранить то, что игрок настроил про бой.
    const parsed = parseSoundSettings('{"enabled":false,"battle":0.25}');
    expect(parsed.enabled).toBe(false);
    expect(parsed.battle).toBe(0.25);
    expect(parsed.music).toBe(DEFAULT_SOUND_SETTINGS.music);
    expect(parsed.master).toBe(DEFAULT_SOUND_SETTINGS.master);
  });

  it('значения за границами прижимаются к диапазону', () => {
    const parsed = parseSoundSettings('{"master":50,"battle":-3,"music":"громко"}');
    expect(parsed.master).toBe(1);
    expect(parsed.battle).toBe(0);
    expect(parsed.music).toBe(DEFAULT_SOUND_SETTINGS.music);
  });

  it('нечисловые и нечестные числа не проходят', () => {
    const parsed = parseSoundSettings('{"master":null,"battle":true}');
    expect(parsed.master).toBe(DEFAULT_SOUND_SETTINGS.master);
    expect(parsed.battle).toBe(DEFAULT_SOUND_SETTINGS.battle);
  });

  it('записанное читается обратно без изменений', () => {
    const settings = { enabled: false, master: 0.3, battle: 0.7, music: 0 };
    expect(parseSoundSettings(serializeSoundSettings(settings))).toEqual(settings);
  });
});
