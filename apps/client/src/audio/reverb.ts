import { noiseFrom } from '../game/noise.js';
import { createOnePole, createSweep, normalise } from './dsp.js';

/**
 * Отклик помещения: то, чем свёртка превращает сухой звук в звук,
 * случившийся где-то.
 *
 * Считается арифметикой, как и всё остальное. Файла отклика нет и не надо:
 * отклик — это затухающий шум с ранними отражениями, и записать его
 * выкладкой проще, чем найти подходящий.
 *
 * Что именно моделируется. Поле открытое: ни стен, ни потолка. Значит,
 * ни густого гула, ни длинного хвоста быть не должно — иначе бой звучит
 * в подвале. Зато есть земля, скалы и постройки, и от них приходят
 * различимые ранние отражения; они и дают ощущение простора, а не хвост.
 *
 * Отсюда устройство: короткая задержка, десяток отдельных отражений
 * в первые семьдесят миллисекунд, и негустой рассеянный хвост в полторы
 * секунды, темнеющий по мере затухания — воздух гасит верх быстрее низа
 * и здесь тоже.
 *
 * Каналы считаются от разных зёрен. Совпади они, отклик оказался бы
 * ровно посередине головы, и никакого простора бы не дал: ширину слышно
 * именно из различия между ушами.
 */

/** Длина отклика. Открытое поле, а не собор. */
export const REVERB_SECONDS = 1.4;

/** Задержка до первого отражения: звук успевает дойти до земли и обратно. */
const PREDELAY_SECONDS = 0.017;

/**
 * Ранние отражения: когда приходит и насколько тише прямого звука.
 *
 * Времена намеренно не кратны друг другу. Кратные дают гребёнку —
 * окраску вроде трубы, которую ухо мгновенно опознаёт как искусственную.
 */
const EARLY: readonly (readonly [number, number])[] = [
  [0.011, 0.62],
  [0.019, 0.48],
  [0.027, 0.39],
  [0.038, 0.31],
  [0.049, 0.26],
  [0.063, 0.2],
  [0.081, 0.16],
  [0.104, 0.12],
];

/**
 * Один канал отклика.
 *
 * Хвост — шум, затухающий по экспоненте и темнеющий вместе с ней. Форма
 * затухания не чистая экспонента: степень чуть больше единицы даёт
 * «провал» сразу после ранних отражений, и без него хвост слышится
 * приклеенным.
 */
const renderChannel = (sampleRate: number, seed: number, spread: number): Float32Array => {
  const length = Math.round(REVERB_SECONDS * sampleRate);
  const samples = new Float32Array(length);

  const noise = noiseFrom(seed);
  const dark = createOnePole(sampleRate);
  const cutoff = createSweep(7000, 600);

  const predelay = Math.round(PREDELAY_SECONDS * sampleRate);
  let cutoffHz = 7000;

  for (let index = predelay; index < length; index += 1) {
    const share = (index - predelay) / (length - predelay);
    if (index % 16 === 0) cutoffHz = cutoff(share);

    const decay = Math.pow(1 - share, 2.2) * Math.exp(-share * 3.4);
    samples[index] = dark(noise(), cutoffHz) * decay;
  }

  // Ранние отражения кладутся поверх хвоста отдельными толчками. Каналы
  // сдвинуты друг относительно друга: отражение приходит в уши не разом.
  for (const [at, gain] of EARLY) {
    const position = Math.round((PREDELAY_SECONDS + at * spread) * sampleRate);
    if (position >= length) continue;

    // Толчок размазан на пару миллисекунд: мгновенный дал бы щелчок,
    // а отражение от неровной поверхности мгновенным и не бывает.
    const width = Math.max(1, Math.round(0.0015 * sampleRate));
    for (let offset = 0; offset < width && position + offset < length; offset += 1) {
      const shape = 1 - offset / width;
      samples[position + offset] =
        (samples[position + offset] ?? 0) + noise() * gain * shape * shape;
    }
  }

  return samples;
};

/**
 * Отклик целиком: два канала.
 *
 * `normalize` у `ConvolverNode` включён по умолчанию и приводит громкость
 * сам, но полагаться на это не стоит: правило нормировки в разных
 * браузерах доводилось до ума в разное время. Приведение к своему пику
 * делает уровень предсказуемым.
 */
export const renderReverb = (sampleRate: number): readonly [Float32Array, Float32Array] => [
  normalise(renderChannel(sampleRate, 0x517e7a1, 1), 0.7),
  normalise(renderChannel(sampleRate, 0x9e3ce7b, 1.07), 0.7),
];
