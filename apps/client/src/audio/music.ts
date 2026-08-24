import { noiseFrom } from '../game/noise.js';
import {
  attackAt,
  bake,
  createDecay,
  createDecayTo,
  createDrive,
  createFilter,
  createSweep,
} from './dsp.js';
import { closeLoop, normaliseChannels, take, trimLeadingSilence } from './prepare.js';
import type { Channels } from './prepare.js';

/**
 * Фоновая музыка: записанная петля, а под ней — четыре посчитанных
 * инструмента и расписание на восемь тактов.
 *
 * Правило то же, что у звуков событий: **запись перекрывает выкладку,
 * выкладка запись — никогда**. Петля весит полмегабайта и приходит
 * не мгновенно; пока её нет, играет расписание, и это не запасной звук
 * на случай беды, а полноправное начало матча.
 *
 * Задача у музыки ровно одна — держать пульс матча. Сообщать она не должна
 * ничего: всё, что игроку нужно знать, сообщает бой, и музыка обязана
 * оставить ему середину диапазона. Отсюда и устройство расписания: низ
 * (бочка, бас), самый верх (хэт) и редкие ноты сверху — а между ними
 * пусто, потому что там живут выстрелы.
 *
 * Ля-минорная пентатоника выбрана не за красоту, а за невозможность
 * ошибиться: в ней не бывает фальшивых сочетаний, а для незатейливой
 * петли, которая играет часами, это важнее выразительности.
 *
 * Восемь тактов, а не два. Короткая петля через три круга перестаёт быть
 * фоном и начинает отсчитывать время как метроном — а это ровно то,
 * чего фону делать нельзя.
 */

// ─────────────────────────────────────────────────────────────────────────
// Записанная петля
// ─────────────────────────────────────────────────────────────────────────

/**
 * Темп присланного трека и длина вырезанной из него петли.
 *
 * Числа получены разбором, а не на слух, и повторить нарезку по ним можно
 * с точностью до отсчёта:
 *
 * - темп 129,000 ударов в минуту, такт 1,860465 с — сетка ровная,
 *   трек собран в редакторе;
 * - граница такта проходит в 0,0200 с от начала исходного файла;
 * - фраза четырёхтактовая, поэтому длина петли обязана делиться
 *   на четыре такта: иначе при каждом втором круге фраза начиналась бы
 *   с середины;
 * - взяты такты с 4-го по 16-й, то есть 7,4619 с … 29,7874 с.
 */
export const MUSIC_LOOP_BPM = 129;
export const MUSIC_LOOP_BARS = 12;
export const MUSIC_LOOP_SECONDS = (MUSIC_LOOP_BARS * 4 * 60) / MUSIC_LOOP_BPM;

/**
 * Сколько музыки лежит в файле ЗА концом петли.
 *
 * Ровно на эту длину хвост вливается в голову перекрёстным затуханием.
 * Без него стык щёлкает: последний отсчёт петли равен +0,10, первый
 * равен −0,30, и разрыв в четыре десятых слышен ударом.
 *
 * Двадцать миллисекунд — компромисс: короче не хватает, чтобы разрыв
 * пропал, длиннее начинает смазывать долю.
 */
export const MUSIC_LOOP_SEAM_SECONDS = 0.02;

/**
 * К какому пику приводится петля.
 *
 * Ниже, чем у боевых звуков, и это не совпадение: музыка сидит под боем,
 * а не рядом. Плата за плотное сведение исходника — у него пик мало
 * что говорит о громкости, поэтому число подобрано с запасом вниз;
 * дальше уровень задаёт ползунок музыки, который по умолчанию и так
 * вдвое ниже боевого.
 */
export const MUSIC_LOOP_PEAK = 0.5;

/**
 * Привести декодированную запись к петле.
 *
 * Три вещи, каждая по своей причине.
 *
 * 1. СРЕЗАТЬ ТИШИНУ. В файле перед петлёй лежит четверть секунды
 *    молчания, и лежит она там намеренно: кодировщик добавляет к записи
 *    свою задержку (у нашего файла 22,8 мс), знать её точно нельзя,
 *    а вычитать на глазок — значит сдвинуть петлю. В тишине задержка
 *    тонет целиком.
 * 2. ВЗЯТЬ ДЛИНУ ЧИСЛОМ. Длина петли считается из темпа, а не берётся
 *    у декодированного буфера: у того она зависит и от паддинга
 *    кодировщика, и от того, ресемплировал ли браузер 48 кГц в 44,1.
 * 3. ЗАМКНУТЬ СТЫК. Тем же перекрёстным затуханием, которым сшивается
 *    петля ротора. Хвост для него — не тишина, а настоящая музыка
 *    следующего такта, поэтому и берётся с запасом на склейку.
 *
 * Не хватило материала — петли не будет вовсе: играть огрызок вместо
 * расписания хуже, чем не играть его совсем.
 */
export const prepareMusicLoop = (channels: Channels, sampleRate: number): Channels | undefined => {
  const trimmed = trimLeadingSilence(channels, sampleRate);
  const wanted = Math.round(MUSIC_LOOP_SECONDS * sampleRate);
  const seam = Math.round(MUSIC_LOOP_SEAM_SECONDS * sampleRate);
  if ((trimmed[0]?.length ?? 0) < wanted + seam) return undefined;

  const cut = take(trimmed, sampleRate, (wanted + seam) / sampleRate);
  const closed = closeLoop(cut, sampleRate, seam / sampleRate);
  return normaliseChannels(closed, MUSIC_LOOP_PEAK);
};

// ─────────────────────────────────────────────────────────────────────────
// Расписание из посчитанных инструментов
// ─────────────────────────────────────────────────────────────────────────

export const MusicVoice = {
  Kick: 'kick',
  Hat: 'hat',
  Bass: 'bass',
  Lead: 'lead',
} as const;

export type MusicVoice = (typeof MusicVoice)[keyof typeof MusicVoice];

export const MUSIC_VOICES: readonly MusicVoice[] = Object.values(MusicVoice);

/** Ударов в минуту. Средний темп: не марш и не колыбельная. */
export const MUSIC_BPM = 88;

/** Шагов в такте: шестнадцатые. */
export const STEPS_PER_BAR = 16;

/** Длина петли в шагах. */
export const MUSIC_STEPS = STEPS_PER_BAR * 8;

/** Длительность одного шага в секундах. */
export const STEP_SECONDS = 60 / MUSIC_BPM / 4;

/**
 * Частоты, к которым приведены запечённые образцы.
 *
 * Высота меняется скоростью воспроизведения, поэтому на инструмент
 * достаточно одного образца: нота получается отношением нужной частоты
 * к этой. Заодно меняется и длительность, и для щипковых это ровно то,
 * чего ждёт ухо — низкая нота звучит дольше высокой.
 */
const BASE_HZ: Readonly<Record<MusicVoice, number>> = {
  [MusicVoice.Kick]: 1,
  [MusicVoice.Hat]: 1,
  [MusicVoice.Bass]: 55,
  [MusicVoice.Lead]: 440,
};

const SECONDS: Readonly<Record<MusicVoice, number>> = {
  [MusicVoice.Kick]: 0.32,
  [MusicVoice.Hat]: 0.09,
  [MusicVoice.Bass]: 0.5,
  [MusicVoice.Lead]: 0.9,
};

/**
 * Громкости инструментов относительно друг друга.
 *
 * Все заметно ниже громкостей боя: музыка сидит под ним, а не рядом.
 * Общий уровень музыки игрок задаёт отдельным ползунком, и по умолчанию
 * он вдвое ниже боевого.
 */
const PEAK: Readonly<Record<MusicVoice, number>> = {
  [MusicVoice.Kick]: 0.75,
  [MusicVoice.Hat]: 0.3,
  [MusicVoice.Bass]: 0.55,
  [MusicVoice.Lead]: 0.34,
};

export const musicSeconds = (voice: MusicVoice): number => SECONDS[voice];
export const musicBaseHz = (voice: MusicVoice): number => BASE_HZ[voice];

// ─────────────────────────────────────────────────────────────────────────
// Инструменты
// ─────────────────────────────────────────────────────────────────────────

/** Бочка: тон, съезжающий вниз, и щелчок в начале. */
const renderKick = (sampleRate: number): Float32Array => {
  const total = SECONDS[MusicVoice.Kick];
  const sweep = createSweep(125, 44);
  const body = createDecayTo(sampleRate, total, 0.11);
  const click = createDecay(sampleRate, 0.002);
  const noise = noiseFrom(0x4b1c4);
  const high = createFilter(sampleRate, 'high');
  const drive = createDrive(1.5);

  let phase = 0;
  let hz = 125;

  return bake(sampleRate, total, PEAK[MusicVoice.Kick], (time, index) => {
    // Съезд быстрый: за шестьдесят миллисекунд. Медленный слышен
    // не ударом, а «уууп».
    if (index % 16 === 0) hz = sweep(Math.min(1, time / 0.06));
    phase += hz / sampleRate;

    return drive(Math.sin(2 * Math.PI * phase) * body()) + high(noise(), 2400, 0.7) * click() * 0.5;
  });
};

/** Хэт: шум сквозь верхнюю полосу, очень коротко. */
const renderHat = (sampleRate: number): Float32Array => {
  const total = SECONDS[MusicVoice.Hat];
  const noise = noiseFrom(0x8a7e2);
  const high = createFilter(sampleRate, 'high');
  const decay = createDecayTo(sampleRate, total, 0.014);

  return bake(sampleRate, total, PEAK[MusicVoice.Hat], (time) => {
    return high(noise(), 7200, 0.9) * decay() * attackAt(time, 0.0004);
  });
};

/** Бас: пила сквозь резонансный срез, короткий щипок. */
const renderBass = (sampleRate: number): Float32Array => {
  const total = SECONDS[MusicVoice.Bass];
  const base = BASE_HZ[MusicVoice.Bass];
  const decay = createDecayTo(sampleRate, total, 0.16);
  const filter = createFilter(sampleRate, 'low');
  const sweep = createSweep(base * 9, base * 2.4);
  const drive = createDrive(1.8);

  let phase = 0;
  let cutoff = base * 9;

  return bake(sampleRate, total, PEAK[MusicVoice.Bass], (time, index) => {
    // Срез съезжает вслед за затуханием: так щипок «закрывается»,
    // а не просто тише становится.
    if (index % 16 === 0) cutoff = sweep(Math.min(1, time / 0.25));

    phase += base / sampleRate;
    if (phase >= 1) phase -= Math.floor(phase);

    const saw = 2 * phase - 1;
    return drive(filter(saw, cutoff, 3.2) * decay() * attackAt(time, 0.004));
  });
};

/** Ведущая линия: два расстроенных треугольника, мягкая атака. */
const renderLead = (sampleRate: number): Float32Array => {
  const total = SECONDS[MusicVoice.Lead];
  const base = BASE_HZ[MusicVoice.Lead];
  const decay = createDecayTo(sampleRate, total, 0.28);

  let first = 0;
  let second = 0;

  return bake(sampleRate, total, PEAK[MusicVoice.Lead], (time) => {
    first += base / sampleRate;
    second += (base * 1.004) / sampleRate;
    if (first >= 1) first -= Math.floor(first);
    if (second >= 1) second -= Math.floor(second);

    const triangle = (phase: number): number => 4 * Math.abs(phase - 0.5) - 1;

    // Атака в двадцать миллисекунд: резкая превратила бы ведущую линию
    // в ещё один ударный, а её задача — наоборот, разбавлять их.
    return (triangle(first) * 0.55 + triangle(second) * 0.45) * decay() * attackAt(time, 0.02);
  });
};

export const renderMusicVoice = (voice: MusicVoice, sampleRate: number): Float32Array => {
  switch (voice) {
    case MusicVoice.Kick:
      return renderKick(sampleRate);
    case MusicVoice.Hat:
      return renderHat(sampleRate);
    case MusicVoice.Bass:
      return renderBass(sampleRate);
    case MusicVoice.Lead:
      return renderLead(sampleRate);
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Расписание
// ─────────────────────────────────────────────────────────────────────────

export interface Note {
  readonly voice: MusicVoice;
  readonly hz: number;
  readonly gain: number;
}

/**
 * Басовая последовательность: четыре такта, повторяются дважды.
 *
 * Ля — фа — до — соль. Самый ходовой оборот, какой есть, и это
 * достоинство: фон не должен обращать на себя внимание неожиданной
 * гармонией.
 */
const BASS_ROOTS: readonly number[] = [55, 43.65, 65.41, 49];

/** Ля-минорная пентатоника от четвёртой октавы. */
const PENTATONIC: readonly number[] = [440, 523.25, 587.33, 659.25, 783.99];

/**
 * Что играет на заданном шаге.
 *
 * Чистая функция от номера шага — и потому проверяемая. Шаг берётся
 * по модулю длины петли, поэтому расписание замкнуто по построению:
 * забыть «вернуться в начало» здесь негде.
 */
export const notesAt = (step: number): readonly Note[] => {
  const at = ((step % MUSIC_STEPS) + MUSIC_STEPS) % MUSIC_STEPS;
  const bar = Math.floor(at / STEPS_PER_BAR);
  const inBar = at % STEPS_PER_BAR;

  const notes: Note[] = [];

  // Бочка на первой и третьей доле. В третьем и седьмом тактах —
  // подхват на последней шестнадцатой: он не даёт петле улечься
  // в четырёхтактовую колею.
  if (inBar === 0 || inBar === 8) {
    notes.push({ voice: MusicVoice.Kick, hz: 1, gain: inBar === 0 ? 1 : 0.85 });
  } else if (inBar === 14 && (bar === 2 || bar === 6)) {
    notes.push({ voice: MusicVoice.Kick, hz: 1, gain: 0.45 });
  }

  // Хэт восьмыми, доли громче слабых частей. В четвёртом и восьмом
  // тактах последняя доля дробится на шестнадцатые — единственное
  // место, где петля прибавляет ходу.
  const sixteenths = (bar === 3 || bar === 7) && inBar >= 12;
  if (inBar % 2 === 0 || sixteenths) {
    notes.push({ voice: MusicVoice.Hat, hz: 1, gain: inBar % 4 === 0 ? 0.9 : 0.5 });
  }

  // Бас: пунктирный рисунок внутри такта.
  if (inBar === 0 || inBar === 6 || inBar === 10) {
    const root = BASS_ROOTS[bar % BASS_ROOTS.length] ?? 55;
    notes.push({ voice: MusicVoice.Bass, hz: root, gain: inBar === 0 ? 1 : 0.7 });
  }

  // Ведущая линия молчит первые два такта каждой половины: петля должна
  // сначала установить пульс, и только потом что-то поверх него сказать.
  if ((bar === 2 || bar === 3 || bar === 6 || bar === 7) && (inBar === 4 || inBar === 12)) {
    // Нота выводится из номера шага, а не выбирается случайно: петля
    // обязана повторяться в точности, иначе она не петля.
    const index = (bar * 2 + (inBar === 12 ? 1 : 0)) % PENTATONIC.length;
    notes.push({ voice: MusicVoice.Lead, hz: PENTATONIC[index] ?? 440, gain: 0.8 });
  }

  return notes;
};
