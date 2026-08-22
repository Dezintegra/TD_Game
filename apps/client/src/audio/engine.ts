import { MAX_ACTIVE, chooseCues } from './budget.js';
import type { Candidate } from './budget.js';
import { SOUND_FILES } from './assets.js';
import { prepareFile } from './prepare.js';
import { LOOPING, SOUNDS, SOUND_PEAK, Sound } from './sounds.js';
import { place } from './placement.js';
import type { Listener } from './placement.js';
import { MUSIC_VOICES, STEP_SECONDS, musicBaseHz, notesAt } from './music.js';
import type { MusicVoice } from './music.js';
import { DEFAULT_SOUND_SETTINGS } from './settings.js';
import type { SoundSettings } from './settings.js';
import type { Cue } from './cues.js';
import type { BakeMessage, BakeRequest } from './bake.worker.js';

/**
 * Обвязка над Web Audio: шины, воспроизведение, размещение.
 *
 * Здесь и только здесь живёт всё, что знает про браузер. Всё, что можно
 * было вынести в чистую арифметику, вынесено — в `sounds.ts`, `dsp.ts`,
 * `prepare.ts`, `placement.ts`, `budget.ts`, `cues.ts`, — ровно затем,
 * чтобы непроверяемого тестом осталось как можно меньше. Ветвлений
 * по игровым правилам тут нет ни одного.
 *
 * Устройство сигнала:
 *
 *     источник → срез → панорама → громкость ─┬→ шина боя ─┐
 *                                  └→ посыл → свёртка ──────┤
 *                                                           ├→ общая → выход
 *                                        шина музыки ───────┘
 *
 * Пять узлов на источник вместо трёх — плата за то, чего просил игрок:
 * срез даёт глухоту дальнего, посыл — долю отражений, и оба меняются
 * вместе с прокруткой карты.
 */

export interface Engine {
  /** Один кадр: что прозвучало и откуда теперь слушают. */
  frame(cues: readonly Cue[], listener: Listener): void;
  /** Ротор генерала: у каждого своё состояние. */
  rotors(states: readonly RotorState[], listener: Listener): void;
  setSettings(settings: SoundSettings): void;
  /** Запустить контекст: только по действию игрока. */
  resume(): void;
  stop(): void;
  /** Сколько источников звучит прямо сейчас. Нужно тестам и отладке. */
  readonly active: number;
}

export interface RotorState {
  readonly owner: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly moving: boolean;
}

/** Ротор на месте не молчит: висящая машина, из которой не доносится ничего, читается сломанной. */
const ROTOR_IDLE_GAIN = 0.15;
const ROTOR_MOVING_GAIN = 1;
/** В движении винт «поддают»: чуть выше по тону. */
const ROTOR_IDLE_RATE = 1;
const ROTOR_MOVING_RATE = 1.08;
/** Разгон короче выбега — так винт себя и ведёт. */
const ROTOR_SPIN_UP = 0.12;
const ROTOR_SPIN_DOWN = 0.35;

/** Приглушение при ядерном ударе. */
const DUCK_BATTLE_TO = 0.35;
const DUCK_MUSIC_TO = 0.15;
const DUCK_IN = 0.06;
const DUCK_BATTLE_OUT = 1.6;
const DUCK_MUSIC_OUT = 3;

/** Постоянная времени для слежения параметров за камерой. */
const FOLLOW_TIME = 0.03;

/** Как часто просыпается планировщик музыки и на сколько смотрит вперёд. */
const MUSIC_TICK_MS = 25;
const MUSIC_LOOKAHEAD = 0.12;

interface Voice {
  readonly source: AudioBufferSourceNode;
  readonly filter: BiquadFilterNode;
  readonly panner: StereoPannerNode;
  readonly dry: GainNode;
  readonly send: GainNode;
  readonly cellX: number;
  readonly cellY: number;
  readonly level: number;
}

/** Пустышка на случай, когда звука в окружении нет вовсе. */
const SILENT: Engine = {
  frame: () => undefined,
  rotors: () => undefined,
  setSettings: () => undefined,
  resume: () => undefined,
  stop: () => undefined,
  active: 0,
};

/**
 * Сужение типа массива отсчётов.
 *
 * `copyToChannel` объявлен принимающим только массив поверх обычного
 * `ArrayBuffer`, а `slice` и передача из рабочего потока дают «поверх
 * какого-нибудь буфера» — в том числе разделяемого. Разделяемых буферов
 * мы не создаём нигде, поэтому сужение безопасно, и главное — оно
 * не копирует: массивы здесь бывают по мегабайту.
 */
const owned = (data: Float32Array): Float32Array<ArrayBuffer> =>
  data as Float32Array<ArrayBuffer>;

const contextClass = (): typeof AudioContext | undefined => {
  if (typeof globalThis === 'undefined') return undefined;
  const scope = globalThis as { AudioContext?: typeof AudioContext };
  return scope.AudioContext;
};

export const createEngine = (): Engine => {
  const Context = contextClass();
  if (Context === undefined) return SILENT;

  let ctx: AudioContext | undefined;
  let master: GainNode | undefined;
  let battle: GainNode | undefined;
  let music: GainNode | undefined;
  let convolver: ConvolverNode | undefined;

  let settings: SoundSettings = DEFAULT_SOUND_SETTINGS;

  /** Готовые к игре наборы отсчётов: по массиву вариантов на звук. */
  const buffers = new Map<Sound, AudioBuffer[]>();
  const voices = new Set<Voice>();
  const rotorVoices = new Map<number, Voice>();

  const musicBuffers = new Map<MusicVoice, AudioBuffer>();
  let musicTimer: ReturnType<typeof setInterval> | undefined;
  let nextStepAt = 0;
  let nextStep = 0;

  let worker: Worker | undefined;
  let pendingReverb: readonly [Float32Array, Float32Array] | undefined;

  // ── музыка ──────────────────────────────────────────────────────────

  /**
   * Расписание с упреждением — схема «двух часов».
   *
   * Назначать ноты прямо по таймеру нельзя: таймеры браузера дрожат
   * на десятки миллисекунд, и ритм разъехался бы слышимо. Таймер здесь
   * только смотрит вперёд на сто двадцать миллисекунд и назначает всё,
   * что попадает в это окно, на ТОЧНОЕ время звуковых часов. Дрожание
   * таймера при этом не имеет значения вовсе, пока он успевает
   * просыпаться чаще, чем окно опустеет.
   */
  const scheduleMusic = (context: AudioContext): void => {
    if (music === undefined) return;

    while (nextStepAt < context.currentTime + MUSIC_LOOKAHEAD) {
      for (const note of notesAt(nextStep)) {
        const buffer = musicBuffers.get(note.voice);
        if (buffer === undefined) continue;

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = note.hz / musicBaseHz(note.voice);

        const gain = context.createGain();
        gain.gain.value = note.gain;

        source.connect(gain);
        gain.connect(music);
        source.start(nextStepAt);
        source.onended = (): void => gain.disconnect();
      }

      nextStep += 1;
      nextStepAt += STEP_SECONDS;
    }
  };

  const startMusic = (context: AudioContext): void => {
    if (musicTimer !== undefined) return;
    // Ждём весь набор: петля с недостающим инструментом слышна не как
    // «пока без баса», а как поломка.
    if (musicBuffers.size < MUSIC_VOICES.length) return;

    nextStep = 0;
    nextStepAt = context.currentTime + 0.1;
    musicTimer = setInterval(() => scheduleMusic(context), MUSIC_TICK_MS);
    scheduleMusic(context);
  };

  // ── шины ────────────────────────────────────────────────────────────

  const applyLevels = (): void => {
    if (ctx === undefined || master === undefined || battle === undefined || music === undefined) {
      return;
    }

    const now = ctx.currentTime;
    master.gain.setTargetAtTime(settings.enabled ? settings.master : 0, now, 0.02);
    battle.gain.setTargetAtTime(settings.battle, now, 0.02);
    music.gain.setTargetAtTime(settings.music, now, 0.02);
  };

  const buildGraph = (context: AudioContext): void => {
    master = context.createGain();
    master.connect(context.destination);

    battle = context.createGain();
    battle.connect(master);

    music = context.createGain();
    music.connect(master);

    convolver = context.createConvolver();
    // Приведение уровня отклик получил при расчёте, и второе от браузера
    // ему не нужно: правило нормировки у разных браузеров разное,
    // и предсказуемость дороже.
    convolver.normalize = false;
    convolver.connect(battle);

    applyLevels();
  };

  // ── выпечка и загрузка ──────────────────────────────────────────────

  const putBuffer = (
    context: AudioContext,
    sound: Sound,
    variant: number,
    channels: readonly Float32Array[],
  ): void => {
    const length = channels[0]?.length ?? 0;
    if (length === 0) return;

    const buffer = context.createBuffer(channels.length, length, context.sampleRate);
    for (let channel = 0; channel < channels.length; channel += 1) {
      const data = channels[channel];
      if (data !== undefined) buffer.copyToChannel(owned(data), channel);
    }

    const list = buffers.get(sound) ?? [];
    list[variant] = buffer;
    buffers.set(sound, list);
  };

  const startBaking = (context: AudioContext): void => {
    worker = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<BakeMessage>): void => {
      const message = event.data;

      if (message.kind === 'reverb') {
        pendingReverb = [message.left, message.right];
        if (convolver !== undefined) {
          const impulse = context.createBuffer(2, message.left.length, context.sampleRate);
          impulse.copyToChannel(owned(message.left), 0);
          impulse.copyToChannel(owned(message.right), 1);
          convolver.buffer = impulse;
        }
        return;
      }

      if (message.kind === 'music') {
        const buffer = context.createBuffer(1, message.samples.length, context.sampleRate);
        buffer.copyToChannel(owned(message.samples), 0);
        musicBuffers.set(message.voice, buffer);
        startMusic(context);
        return;
      }

      if (message.kind === 'sound') {
        // Запись, если она есть, перекроет посчитанное позже — но до тех
        // пор играет посчитанное, и это ровно то, ради чего оно считается
        // для всего подряд.
        putBuffer(context, message.sound, message.variant, [message.samples]);
      }
    };

    const request: BakeRequest = { sampleRate: context.sampleRate };
    worker.postMessage(request);
  };

  /**
   * Загрузить записи и подменить ими посчитанное.
   *
   * Всё, что делает загрузчик сверх декодирования, живёт в `prepare.ts`
   * и проверено тестом: срезание тишины в начале, пересчёт скорости
   * для вариантов, затухание хвоста, сглаживание краёв, сшивание петли
   * и приведение громкости к общей таблице.
   *
   * Ошибки глотаются намеренно. Не загрузился файл, не дал браузер
   * его декодировать, оборвалась сеть — игра звучит посчитанным.
   */
  const loadFiles = (context: AudioContext): void => {
    for (const sound of SOUNDS) {
      const files = SOUND_FILES[sound];
      if (files === undefined) continue;

      void (async () => {
        const ready: Float32Array[][] = [];

        for (const file of files) {
          try {
            const response = await fetch(file.url);
            if (!response.ok) continue;

            const decoded = await context.decodeAudioData(await response.arrayBuffer());
            const source: Float32Array[] = [];
            for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
              source.push(decoded.getChannelData(channel).slice());
            }

            for (const rate of file.rates) {
              ready.push(
                prepareFile(
                  source.map((channel) => channel.slice()),
                  {
                    sampleRate: context.sampleRate,
                    rate,
                    // Уровень назначает та же таблица, что и посчитанным.
                    // Записи приходят с пиками от 0,17 до 1,01, и без
                    // приведения соотношение громкостей в игре зависело бы
                    // от того, кто и как сводил исходник.
                    peak: SOUND_PEAK[sound],
                    fadeFromSeconds: file.fadeFrom,
                    looping: LOOPING[sound],
                  },
                ) as Float32Array[],
              );
            }
          } catch {
            // Молча: запасной путь уже играет.
          }
        }

        if (ready.length === 0) return;

        // Подменяется весь набор вариантов разом, а не по одному:
        // иначе часть звука была бы записью, часть выкладкой,
        // и в бою это слышалось бы разнобоем.
        buffers.delete(sound);
        ready.forEach((channels, variant) => {
          putBuffer(context, sound, variant, channels);
        });
      })();
    }
  };

  // ── воспроизведение ─────────────────────────────────────────────────

  const attach = (
    context: AudioContext,
    bus: AudioNode,
    buffer: AudioBuffer,
    cellX: number,
    cellY: number,
    listener: Listener,
    level: number,
    rate: number,
    loop: boolean,
  ): Voice => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.playbackRate.value = rate;

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';

    const panner = context.createStereoPanner();
    const dry = context.createGain();
    const send = context.createGain();

    source.connect(filter);
    filter.connect(panner);
    panner.connect(dry);
    dry.connect(bus);

    // Посыл берётся до панорамы: отклик обязан быть широким и рассеянным,
    // а панорамированный посыл сжал бы его в ту же точку, где и сам звук.
    filter.connect(send);
    if (convolver !== undefined) send.connect(convolver);

    const voice: Voice = { source, filter, panner, dry, send, cellX, cellY, level };
    const placement = place(cellX, cellY, listener);

    filter.frequency.value = placement.cutoff;
    panner.pan.value = placement.pan;
    dry.gain.value = placement.gain * level;
    send.gain.value = placement.gain * level * placement.wet;

    return voice;
  };

  const follow = (voice: Voice, listener: Listener, now: number): void => {
    const placement = place(voice.cellX, voice.cellY, listener);

    // Не присваиванием, а слежением: мгновенная смена величины даёт
    // ступеньку, а ступенька на громкости — щелчок. Тридцать миллисекунд
    // короче кадра при тридцати кадрах в секунду, поэтому за прокруткой
    // звук успевает.
    voice.filter.frequency.setTargetAtTime(placement.cutoff, now, FOLLOW_TIME);
    voice.panner.pan.setTargetAtTime(placement.pan, now, FOLLOW_TIME);
    voice.dry.gain.setTargetAtTime(placement.gain * voice.level, now, FOLLOW_TIME);
    voice.send.gain.setTargetAtTime(placement.gain * voice.level * placement.wet, now, FOLLOW_TIME);
  };

  const duck = (context: AudioContext): void => {
    if (battle === undefined || music === undefined) return;

    // Приём и необходимость разом. Приём: после такого удара мир
    // на секунду оглох. Необходимость: ядерный звук громкий
    // по построению, и сложенный с двумя десятками хлопков от гибнущих
    // в радиусе юнитов он вышел бы за единицу.
    const now = context.currentTime;

    battle.gain.cancelScheduledValues(now);
    battle.gain.setTargetAtTime(settings.battle * DUCK_BATTLE_TO, now, DUCK_IN);
    battle.gain.setTargetAtTime(settings.battle, now + DUCK_IN * 4, DUCK_BATTLE_OUT / 4);

    music.gain.cancelScheduledValues(now);
    music.gain.setTargetAtTime(settings.music * DUCK_MUSIC_TO, now, DUCK_IN);
    music.gain.setTargetAtTime(settings.music, now + DUCK_IN * 4, DUCK_MUSIC_OUT / 4);
  };

  const play = (
    context: AudioContext,
    sound: Sound,
    key: number,
    cellX: number,
    cellY: number,
    gain: number,
    listener: Listener,
  ): void => {
    const list = buffers.get(sound);
    if (list === undefined || battle === undefined) return;

    // Вариант и разброс скорости — из ключа события. Одно и то же
    // событие обязано звучать одинаково при повторной отрисовке.
    const ready = list.filter((buffer) => buffer !== undefined);
    if (ready.length === 0) return;

    const buffer = ready[(key >>> 8) % ready.length];
    if (buffer === undefined) return;

    const rate = 1 + (((key % 1000) / 1000) * 2 - 1) * 0.06;
    const voice = attach(context, battle, buffer, cellX, cellY, listener, gain, rate, false);

    voice.source.onended = (): void => {
      voices.delete(voice);
      voice.dry.disconnect();
      voice.send.disconnect();
      voice.panner.disconnect();
      voice.filter.disconnect();
    };

    voices.add(voice);
    voice.source.start();

    if (sound === Sound.NukeBlast) duck(context);
  };

  // ── ротор ───────────────────────────────────────────────────────────

  const updateRotor = (
    context: AudioContext,
    state: RotorState,
    listener: Listener,
    now: number,
  ): void => {
    let voice = rotorVoices.get(state.owner);

    if (voice === undefined) {
      const list = buffers.get(Sound.Rotor);
      const buffer = list?.find((entry) => entry !== undefined);
      if (buffer === undefined || battle === undefined) return;

      voice = attach(context, battle, buffer, state.cellX, state.cellY, listener, 0, 1, true);
      voice.source.start();
      rotorVoices.set(state.owner, voice);
    }

    // Положение ротора меняется каждый кадр, поэтому воспроизводящая
    // запись хранится не с координатами, а обновляется по месту.
    const placement = place(state.cellX, state.cellY, listener);
    const level = state.moving ? ROTOR_MOVING_GAIN : ROTOR_IDLE_GAIN;
    const rise = state.moving ? ROTOR_SPIN_UP : ROTOR_SPIN_DOWN;

    voice.filter.frequency.setTargetAtTime(placement.cutoff, now, FOLLOW_TIME);
    voice.panner.pan.setTargetAtTime(placement.pan, now, FOLLOW_TIME);
    voice.dry.gain.setTargetAtTime(placement.gain * level, now, rise / 3);
    voice.send.gain.setTargetAtTime(placement.gain * level * placement.wet, now, rise / 3);
    voice.source.playbackRate.setTargetAtTime(
      state.moving ? ROTOR_MOVING_RATE : ROTOR_IDLE_RATE,
      now,
      rise / 2,
    );
  };

  const dropRotor = (owner: number): void => {
    const voice = rotorVoices.get(owner);
    if (voice === undefined) return;

    rotorVoices.delete(owner);
    try {
      voice.source.stop();
    } catch {
      // Уже остановлен — ничего страшного.
    }
    voice.dry.disconnect();
    voice.send.disconnect();
  };

  // ── наружу ──────────────────────────────────────────────────────────

  return {
    get active() {
      return voices.size + rotorVoices.size;
    },

    resume() {
      if (ctx === undefined) {
        ctx = new Context();
        buildGraph(ctx);
        startBaking(ctx);
        loadFiles(ctx);

        if (pendingReverb !== undefined && convolver !== undefined) {
          const [left, right] = pendingReverb;
          const impulse = ctx.createBuffer(2, left.length, ctx.sampleRate);
          impulse.copyToChannel(owned(left), 0);
          impulse.copyToChannel(owned(right), 1);
          convolver.buffer = impulse;
        }
        return;
      }

      if (ctx.state === 'suspended') void ctx.resume();
    },

    setSettings(next: SoundSettings) {
      settings = next;
      applyLevels();
    },

    frame(cues: readonly Cue[], listener: Listener) {
      const context = ctx;
      if (context === undefined) return;

      const now = context.currentTime;
      for (const voice of voices) follow(voice, listener, now);

      if (cues.length === 0) return;

      const candidates: Candidate[] = [];
      for (const cue of cues) {
        const placement = place(cue.cellX, cue.cellY, listener);
        if (placement.gain <= 0) continue;
        candidates.push({
          sound: cue.sound,
          key: cue.key,
          cellX: cue.cellX,
          cellY: cue.cellY,
          gain: placement.gain,
        });
      }

      for (const chosen of chooseCues(candidates)) {
        if (voices.size >= MAX_ACTIVE) break;
        play(
          context,
          chosen.sound,
          chosen.key,
          chosen.cellX,
          chosen.cellY,
          Math.min(1, chosen.boost),
          listener,
        );
      }
    },

    rotors(states: readonly RotorState[], listener: Listener) {
      const context = ctx;
      if (context === undefined) return;

      const now = context.currentTime;
      const alive = new Set<number>();

      for (const state of states) {
        alive.add(state.owner);
        updateRotor(context, state, listener, now);
      }

      for (const owner of [...rotorVoices.keys()]) {
        if (!alive.has(owner)) dropRotor(owner);
      }
    },

    stop() {
      worker?.terminate();
      worker = undefined;

      if (musicTimer !== undefined) clearInterval(musicTimer);
      musicTimer = undefined;

      for (const owner of [...rotorVoices.keys()]) dropRotor(owner);
      for (const voice of voices) {
        try {
          voice.source.stop();
        } catch {
          // Уже кончился сам.
        }
      }
      voices.clear();

      void ctx?.close();
      ctx = undefined;
    },
  };
};

