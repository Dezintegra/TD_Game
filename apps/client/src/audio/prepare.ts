import { createFilter, peakOf } from './dsp.js';

/**
 * Приведение загруженной записи к тому виду, в котором её можно играть.
 *
 * Всё здесь — арифметика над массивами отсчётов, поэтому проверяется
 * обычным тестом. Из браузера нужна ровно одна вещь, которой тут нет, —
 * само декодирование MP3; она живёт в `engine.ts`.
 *
 * Зачем это вообще нужно. Записи обрезаны по границам кадров MP3, потому
 * что перекодирование испортило бы то самое, ради чего запись и берут.
 * Границы кадров грубые (26 миллисекунд), кодировщик добавляет к началу
 * свою задержку, уровни у разных записей различаются впятеро, а обрезка
 * попадает в произвольную точку волны. Каждую из этих бед лечит одна
 * из функций ниже.
 */

export type Channels = readonly Float32Array[];

/**
 * Ниже какого уровня отсчёт считается тишиной.
 *
 * Не ноль: после декодирования в «тишине» остаётся шум квантования
 * и хвост фильтра кодировщика, и порог в ноль не срезал бы ничего.
 */
const SILENCE = 0.004;

/**
 * Сколько тишины оставить перед звуком.
 *
 * Совсем ничего оставлять нельзя: атака начинается не с нуля, и срезав
 * её впритык, мы получим щелчок вместо удара.
 */
const KEEP_BEFORE_SECONDS = 0.002;

/**
 * Срезать тишину в начале.
 *
 * Кадр MP3 длится 26 миллисекунд, а кодировщик добавляет к записи свою
 * задержку; вместе это тридцать-сорок миллисекунд молчания. Ровно
 * столько выстрел и опаздывал бы за собственной вспышкой — а это
 * половина кадра при тридцати тиках в секунду.
 */
export const trimLeadingSilence = (channels: Channels, sampleRate: number): Channels => {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return channels;

  let onset = 0;
  outer: for (; onset < length; onset += 1) {
    for (const channel of channels) {
      if (Math.abs(channel[onset] ?? 0) > SILENCE) break outer;
    }
  }

  const keep = Math.round(KEEP_BEFORE_SECONDS * sampleRate);
  const from = Math.max(0, Math.min(onset, length - 1) - keep);
  if (from === 0) return channels;

  return channels.map((channel) => channel.slice(from));
};

/**
 * Сыграть с другой скоростью, запёкши результат.
 *
 * Так из одной записи получается несколько вариантов: тот же звук,
 * сыгранный чуть выше и чуть ниже. Отдельными массивами, а не скоростью
 * на лету, потому что скорость всё равно разбрасывается сверху по ключу
 * события — два разброса поверх друг друга дают больше разнообразия.
 *
 * Пересчёт линейный. Для разброса в проценты этого более чем достаточно:
 * искажения от линейной интерполяции лежат на сорок децибел ниже сигнала
 * и в шуме взрыва не существуют.
 */
export const resample = (channels: Channels, rate: number): Channels => {
  if (rate === 1) return channels;

  const source = channels[0]?.length ?? 0;
  const length = Math.max(1, Math.floor(source / rate));

  return channels.map((channel) => {
    const out = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      const position = index * rate;
      const left = Math.floor(position);
      const fraction = position - left;
      const a = channel[left] ?? 0;
      const b = channel[left + 1] ?? a;
      out[index] = a + (b - a) * fraction;
    }
    return out;
  });
};

/**
 * Взять от записи только начало.
 *
 * Затухание этого не заменяет, и разница видна на числах. Скат
 * у `fadeFrom` растягивается на весь остаток записи: в записи длиной
 * 1,23 с затухание от 0,34 с к середине сбавляет громкость всего
 * на децибел с небольшим. Событию же, случающемуся четыре раза
 * в секунду, нужна не тихая длинная запись, а короткая.
 *
 * Обрезка идёт до затухания: скат должен считаться от новой длины,
 * иначе он окажется рассчитан на хвост, которого уже нет.
 */
export const take = (channels: Channels, sampleRate: number, seconds: number): Channels => {
  const length = channels[0]?.length ?? 0;
  const keep = Math.round(seconds * sampleRate);
  if (keep <= 0 || keep >= length) return channels;

  return channels.map((channel) => channel.slice(0, keep));
};

/**
 * Увести хвост в тишину, начиная с заданной секунды.
 *
 * Кривая — четверть косинуса: она начинается с нулевым наклоном, поэтому
 * начала затухания не слышно, и приходит ровно в ноль, поэтому обрыва
 * в конце тоже нет. Прямая заметна обоими концами: сначала «кто-то тронул
 * ручку», потом ступенька.
 */
export const fadeFrom = (channels: Channels, sampleRate: number, seconds: number): Channels => {
  const length = channels[0]?.length ?? 0;
  const start = Math.round(seconds * sampleRate);
  if (start >= length) return channels;

  const span = length - start;
  for (const channel of channels) {
    for (let index = start; index < length; index += 1) {
      const share = (index - start) / span;
      channel[index] = (channel[index] ?? 0) * Math.cos((Math.PI * share) / 2);
    }
  }

  return channels;
};

/**
 * Сгладить края.
 *
 * Обрезка попадает в произвольную точку волны, и разрыв на краю — это
 * щелчок. Два миллисекундных ската короче различимой длительности
 * и на слышимую форму не влияют.
 */
export const smoothEdges = (channels: Channels, sampleRate: number, seconds = 0.002): Channels => {
  const length = channels[0]?.length ?? 0;
  const ramp = Math.max(1, Math.min(Math.floor(length / 2), Math.round(seconds * sampleRate)));

  for (const channel of channels) {
    for (let index = 0; index < ramp; index += 1) {
      const gain = index / ramp;
      const tail = length - 1 - index;
      channel[index] = (channel[index] ?? 0) * gain;
      channel[tail] = (channel[tail] ?? 0) * gain;
    }
  }

  return channels;
};

/**
 * Привести к заданному пику, считая пик по всем каналам разом.
 *
 * По всем сразу, а не по каждому отдельно: поканальная нормировка
 * съезжает панораму записи — тихий канал подтягивается к громкому,
 * и стереообраз схлопывается в середину.
 */
export const normaliseChannels = (channels: Channels, peak: number): Channels => {
  let current = 0;
  for (const channel of channels) current = Math.max(current, peakOf(channel));
  if (current === 0) return channels;

  const scale = peak / current;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = (channel[index] ?? 0) * scale;
    }
  }

  return channels;
};

/**
 * Сшить конец с началом, чтобы петля не щёлкала.
 *
 * В записи двигателя нет ни малейшего повода сойтись концу с началом,
 * а играть её предстоит по кругу, пока генерал движется. Хвост
 * накладывается на голову перекрёстным затуханием: голова становится
 * смесью себя и хвоста, а сам хвост отбрасывается. Стык после этого
 * непрерывен по построению.
 *
 * Плата — потерянные миллисекунды в конце и слегка приглушённая
 * дисперсия в зоне склейки. На ровном гуле и то и другое неразличимо.
 */
export const closeLoop = (channels: Channels, sampleRate: number, seconds = 0.05): Channels => {
  const length = channels[0]?.length ?? 0;
  const overlap = Math.min(Math.floor(length / 3), Math.round(seconds * sampleRate));
  if (overlap < 2) return channels;

  const kept = length - overlap;

  return channels.map((channel) => {
    const out = new Float32Array(kept);
    out.set(channel.subarray(0, kept));

    for (let index = 0; index < overlap; index += 1) {
      const share = index / overlap;
      const head = out[index] ?? 0;
      const tail = channel[kept + index] ?? 0;
      out[index] = head * share + tail * (1 - share);
    }

    return out;
  });
};

/**
 * Срезать низ.
 *
 * Записи техники приходят с гулом в полсотни герц и ниже. На отдельном
 * прослушивании он читается «мощно», а в игре — гулко: этот низ ничего
 * не сообщает, ни от чего не отличается и просто заполняет собой
 * диапазон, в котором живут взрывы.
 *
 * Особенно достаётся зацикленному: он звучит непрерывно, и его гул
 * не гаснет никогда.
 */
export const highPass = (channels: Channels, sampleRate: number, cutoffHz: number): Channels =>
  channels.map((channel) => {
    const filter = createFilter(sampleRate, 'high');
    const out = new Float32Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      out[index] = filter(channel[index] ?? 0, cutoffHz, 0.7);
    }
    return out;
  });

/**
 * Подмешать вторую запись поверх первой.
 *
 * Нужно там, где одной записи не хватает по устройству, а не по качеству.
 * Разряд Теслы должен и трещать, и греметь: треск сообщает «электричество»,
 * гром — «попало». Записи такой в природе не нашлось, зато нашлись
 * две — искры без низа и молния без внятного треска, — и сложенные они
 * дают ровно то, что нужно.
 *
 * Складывается прямо, без выравнивания: уровни у обеих уже приведены,
 * а общий пик выправит нормировка в конце. Слой короче основы — просто
 * кончается раньше; длиннее — обрезается по ней, потому что длину звука
 * задаёт основа.
 */
export const mixInto = (
  base: Channels,
  layer: Channels,
  gain: number,
  sampleRate: number,
  atSeconds = 0,
): Channels => {
  const offset = Math.max(0, Math.round(atSeconds * sampleRate));

  return base.map((channel, index) => {
    // Каналов у слоя может быть меньше: моно поверх стерео ложится
    // в оба канала одинаково, и это правильнее, чем молчащий правый.
    const source = layer[index] ?? layer[0];
    if (source === undefined) return channel;

    for (let at = 0; at + offset < channel.length && at < source.length; at += 1) {
      channel[at + offset] = (channel[at + offset] ?? 0) + (source[at] ?? 0) * gain;
    }
    return channel;
  });
};

/**
 * Развернуть запись задом наперёд.
 *
 * Приём старый и в звуковом деле обыденный: разгон, проигранный
 * наоборот, становится затуханием. Нужен там, где запись сама по себе
 * нарастает, а событию положено начинаться с полной силы и гаснуть —
 * то есть у выстрела.
 *
 * Разворот идёт ПЕРВЫМ, до срезания тишины: тишина, которая была
 * в конце, после разворота оказывается в начале, и срезать её надо
 * уже там.
 */
export const reverse = (channels: Channels): Channels =>
  channels.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      out[index] = channel[channel.length - 1 - index] ?? 0;
    }
    return out;
  });

/**
 * Размножить запись до нужной длины повторением.
 *
 * Нужно слою у зацикленного звука. Слой короче основы прозвучал бы
 * один раз в начале круга и пропал до конца — а у петли начала и конца
 * нет, круг идёт непрерывно. Стык между повторами сгладит замыкание
 * петли, которое всё равно идёт следом.
 */
export const tile = (channels: Channels, length: number): Channels =>
  channels.map((channel) => {
    if (channel.length === 0) return channel;

    const out = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      out[index] = channel[index % channel.length] ?? 0;
    }
    return out;
  });

export interface PrepareOptions {
  readonly sampleRate: number;
  /** Множитель скорости для варианта. */
  readonly rate: number;
  /** К какому пику привести. */
  readonly peak: number;
  /** Сколько секунд взять от начала записи; остальное отбрасывается. */
  readonly takeSeconds?: number | undefined;
  /** С какой секунды уводить в тишину. */
  readonly fadeFromSeconds?: number | undefined;
  /** Ниже какой частоты срезать. */
  readonly highPassHz?: number | undefined;
  /** Развернуть задом наперёд: разгон становится затуханием. */
  readonly reversed?: boolean | undefined;
  /** Вторая запись поверх первой, уже декодированная. */
  readonly layer?: { readonly channels: Channels; readonly gain: number } | undefined;
  /** Зацикленным сшивается стык, остальным сглаживаются края. */
  readonly looping: boolean;
}

/**
 * Всё вместе, в единственно верном порядке.
 *
 * Порядок здесь не вкусовщина. Тишина срезается до пересчёта скорости —
 * иначе её длина зависела бы от варианта. Обрезка и затухание идут после
 * пересчёта — обе заданы в секундах готового звука, а не исходника,
 * и обрезка раньше затухания, чтобы скат считался от новой длины.
 * Нормировка идёт последней из громкостных: приведи мы уровень раньше,
 * затухание и края снова его изменили бы.
 */
export const prepareFile = (channels: Channels, options: PrepareOptions): Channels => {
  const { sampleRate, rate, peak, looping } = options;

  let result = options.reversed === true ? reverse(channels) : channels;
  result = trimLeadingSilence(result, sampleRate);
  result = resample(result, rate);

  // Обрезка длины идёт сразу после пересчёта скорости: длина задана
  // в секундах готового звука, а не исходника, и слой ложится уже
  // на укороченную основу — длину звука задаёт основа.
  if (options.takeSeconds !== undefined) {
    result = take(result, sampleRate, options.takeSeconds);
  }

  // Слой ложится ДО среза, затухания и нормировки: он часть звука,
  // а не добавка к готовому. Отсюда и порядок — срез применяется
  // к сумме, потому что причина среза (непрерывный гул) относится
  // и к слою тоже.
  //
  // У зацикленного звука слой ещё и размножается: короткий прозвучал бы
  // один раз в начале круга и пропал, а у петли начала и конца нет.
  if (options.layer !== undefined) {
    const trimmed = trimLeadingSilence(options.layer.channels, sampleRate);
    const base = result[0]?.length ?? 0;
    const layer = looping && (trimmed[0]?.length ?? 0) < base ? tile(trimmed, base) : trimmed;

    result = mixInto(
      result.map((channel) => channel.slice()),
      layer,
      options.layer.gain,
      sampleRate,
    );
  }

  // Срез идёт ДО сшивания петли: у фильтра есть память, и запущенный
  // после сшивания он разошёлся бы на стыке ровно тем щелчком,
  // от которого сшивание и спасает.
  if (options.highPassHz !== undefined) {
    result = highPass(result, sampleRate, options.highPassHz);
  }

  if (options.fadeFromSeconds !== undefined) {
    result = fadeFrom(result, sampleRate, options.fadeFromSeconds);
  }

  result = looping ? closeLoop(result, sampleRate) : smoothEdges(result, sampleRate);
  return normaliseChannels(result, peak);
};
