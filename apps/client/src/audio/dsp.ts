/**
 * Арифметика звука: генераторы, фильтры, огибающие.
 *
 * Здесь нет ни одного игрового понятия и ни одного обращения к браузеру.
 * Модуль превращает числа в числа — и ровно поэтому проверяется обычным
 * тестом в окружении `node`, где Web Audio нет и не будет.
 *
 * Своя арифметика вместо графа узлов Web Audio выбрана осознанно.
 * Голос, собранный из осцилляторов и фильтров браузера, невозможно
 * ни проверить, ни отладить без браузера, а стоит он вдесятеро дороже:
 * в бою бывает по двадцать выстрелов за тик, и двести живых узлов
 * в секунду — это не бюджет кадра, это его отсутствие. Здесь каждый
 * голос считается один раз при запуске и дальше только воспроизводится.
 *
 * Всё, что ниже, работает с отсчётами в диапазоне [-1, 1] и с частотой
 * дискретизации, переданной снаружи: она берётся у звукового контекста
 * и на разных машинах разная (обычно 44 100 или 48 000).
 */

import { noiseFrom } from '../game/noise.js';

// ─────────────────────────────────────────────────────────────────────────
// Развёртки и огибающие
// ─────────────────────────────────────────────────────────────────────────

/**
 * Частота, идущая от одной к другой по экспоненте.
 *
 * Именно по экспоненте, а не по прямой: слух воспринимает высоту
 * логарифмически, и линейная развёртка от 1800 к 320 Гц слышна как
 * мгновенный провал в конце, а не как ровное падение.
 *
 * `phase` — доля пути от нуля до единицы. За пределами отрезка значение
 * прижимается к краю: голосу не нужна экстраполяция, ему нужна полка.
 */
export const sweepAt = (from: number, to: number, phase: number): number => {
  const clamped = phase <= 0 ? 0 : phase >= 1 ? 1 : phase;
  // Ноль в основании степени даёт ноль или бесконечность, поэтому нижняя
  // граница — не ноль, а герц: ниже него нет ни слуха, ни смысла.
  const start = Math.max(1, from);
  const end = Math.max(1, to);
  return start * Math.pow(end / start, clamped);
};

/**
 * Нарастание за отрезок. Нужно не ради красоты, а против щелчка:
 * голос, начатый с полной громкости, даёт разрыв первой производной,
 * и слышен он именно щелчком, а не громким началом.
 */
export const attackAt = (seconds: number, attack: number): number => {
  if (attack <= 0) return 1;
  return seconds >= attack ? 1 : seconds / attack;
};

/** Экспоненциальное затухание с постоянной времени `tau` в секундах. */
export const decayAt = (seconds: number, tau: number): number =>
  tau <= 0 ? 0 : Math.exp(-seconds / tau);

/**
 * То же затухание, но шагами по отсчёту и одним умножением.
 *
 * Экспонента от кратного аргумента — это степень: `exp(-(n+1)/k)` равно
 * `exp(-n/k)` умножить на `exp(-1/k)`. Множитель считается один раз,
 * и вместо трансцендентной функции на каждом отсчёте остаётся умножение.
 *
 * Разница не косметическая. У взрыва пять затуханий, и посчитанные
 * «в лоб» они дают миллионы вызовов `Math.exp` за одну выпечку —
 * это секунды работы там, где хватает десятков миллисекунд.
 *
 * Цена — обязанность вызывать шаг РОВНО раз на отсчёт, даже когда
 * слой промолчал: пропущенный вызов сдвинет огибающую во времени.
 */
export const createDecay = (sampleRate: number, tau: number): (() => number) => {
  if (tau <= 0) return () => 0;

  const factor = Math.exp(-1 / (tau * sampleRate));
  let value = 1 / factor;

  return (): number => {
    value *= factor;
    return value;
  };
};

/**
 * Затухание шагами, гарантированно приходящее в ноль к концу отрезка.
 *
 * Чистая экспонента до нуля не доходит никогда, и звук, оборванный
 * на её хвосте, щёлкает.
 */
export const createDecayTo = (sampleRate: number, total: number, tau: number): (() => number) => {
  const step = createDecay(sampleRate, tau);
  const tail = decayAt(total, tau);
  const scale = 1 / (1 - tail);

  return (): number => Math.max(0, (step() - tail) * scale);
};

/**
 * Развёртка частоты с заранее посчитанным логарифмом.
 *
 * `sweepAt` внутри вызывает `Math.pow`, а тот раскладывается
 * в логарифм и экспоненту. Логарифм здесь один на всю развёртку,
 * и в цикле остаётся только экспонента.
 */
export const createSweep = (from: number, to: number): ((phase: number) => number) => {
  const start = Math.max(1, from);
  const ratio = Math.log(Math.max(1, to) / start);

  return (phase: number): number =>
    start * Math.exp(ratio * (phase <= 0 ? 0 : phase >= 1 ? 1 : phase));
};

/**
 * Затухание с гарантированным нулём в конце.
 *
 * Чистая экспонента до нуля не доходит никогда, и голос, оборванный
 * на её хвосте, щёлкает. Вычитание уровня в точке обрыва убирает разрыв,
 * а деление на остаток сохраняет единицу в начале.
 */
export const decayTo = (seconds: number, total: number, tau: number): number => {
  if (seconds >= total) return 0;
  const tail = decayAt(total, tau);
  return (decayAt(seconds, tau) - tail) / (1 - tail);
};

// ─────────────────────────────────────────────────────────────────────────
// Фильтры
// ─────────────────────────────────────────────────────────────────────────

/**
 * Верхняя граница коэффициента настройки фильтра состояния переменных.
 *
 * Схема устойчива, пока `f + затухание < 2`; на границе она звенит
 * и уходит в бесконечность за десяток отсчётов. Значение 1.16
 * соответствует срезу примерно в пятую долю частоты дискретизации —
 * около 9,6 кГц при 48 000, чего хватает и хэту, и шипению разряда.
 */
const MAX_TUNING = 1.16;

/**
 * Предохранитель на внутреннее состояние фильтра.
 *
 * Не должен срабатывать никогда: параметры голосов подобраны внутри
 * области устойчивости. Но фильтр с бегущим срезом — самое хрупкое
 * место всей арифметики, и разойдись он однажды, в динамики уехал бы
 * не звук, а щелчок на полной громкости.
 */
const STATE_LIMIT = 8;

const clampState = (value: number): number =>
  Number.isFinite(value) ? Math.max(-STATE_LIMIT, Math.min(STATE_LIMIT, value)) : 0;

export type FilterMode = 'low' | 'band' | 'high';

/**
 * Фильтр состояния переменных (схема Чемберлина).
 *
 * Выбран из-за бегущего среза. У разряда Теслы срез падает с шести
 * килогерц до двухсот за треть секунды, у ядерного удара — с четырёх
 * до шестидесяти за секунду с лишним; биквад пришлось бы пересчитывать
 * на каждом отсчёте, а это четыре тригонометрические функции вместо
 * одной. Здесь же срез — это прямо параметр шага.
 *
 * Три выхода схемы получаются за один проход, но наружу отдаётся один:
 * возвращать объект значило бы создавать по объекту на отсчёт, то есть
 * полтора миллиона объектов за выпечку.
 */
export const createFilter = (
  sampleRate: number,
  mode: FilterMode,
): ((input: number, cutoffHz: number, resonance: number) => number) => {
  let low = 0;
  let band = 0;

  // Настройка пересчитывается только при смене среза. Огибающие среза
  // считаются с управляющей частотой — раз в шестнадцать отсчётов, —
  // поэтому пятнадцать вызовов из шестнадцати попадают в кеш, а синус
  // из внутреннего цикла исчезает.
  let lastCutoff = Number.NaN;
  let tuning = 0;
  let lastResonance = Number.NaN;
  let damping = 1;

  return (input: number, cutoffHz: number, resonance: number): number => {
    if (cutoffHz !== lastCutoff) {
      lastCutoff = cutoffHz;
      tuning = Math.min(MAX_TUNING, 2 * Math.sin((Math.PI * Math.max(1, cutoffHz)) / sampleRate));
    }

    // Резонанс приходит «добротностью»: чем больше, тем острее пик.
    // Схема же принимает затухание — величину обратную, и нижняя
    // граница здесь важнее верхней: нулевое затухание это генератор.
    if (resonance !== lastResonance) {
      lastResonance = resonance;
      damping = Math.max(0.05, Math.min(2, 1 / Math.max(0.5, resonance)));
    }

    const high = input - low - damping * band;
    band = clampState(band + tuning * high);
    low = clampState(low + tuning * band);

    return mode === 'low' ? low : mode === 'band' ? band : high;
  };
};

/**
 * Однополюсный низкочастотный: один умножитель на отсчёт.
 *
 * Берётся там, где резонанс не нужен и нужна дешевизна — например,
 * чтобы сгладить шум ротора, который считается по полсекунды за раз.
 */
export const createOnePole = (
  sampleRate: number,
): ((input: number, cutoffHz: number) => number) => {
  let state = 0;

  return (input: number, cutoffHz: number): number => {
    const rate = 1 - Math.exp((-2 * Math.PI * Math.max(1, cutoffHz)) / sampleRate);
    state += rate * (input - state);
    return state;
  };
};

/**
 * Резонатор: двухполюсный звон на заданной частоте.
 *
 * Это то, чем звучит ударенное тело — колокол, лист брони, обломок трубы.
 * Толчок на входе выходит затухающим синусом, и несколько резонаторов
 * на негармонических частотах дают безошибочно узнаваемый металл:
 * ухо отличает металл от дерева и камня именно по тому, что призвуки
 * не складываются в аккорд.
 *
 * Разрушение постройки без этого слоя звучит взрывом бочки с порохом,
 * а не гибелью бронированного сооружения.
 */
export const createResonator = (
  sampleRate: number,
  frequencyHz: number,
  decaySeconds: number,
): ((input: number) => number) => {
  const omega = (2 * Math.PI * Math.max(1, frequencyHz)) / sampleRate;
  // Радиус полюса: чем ближе к единице, тем дольше звон. Единицы он
  // достигать не должен никогда — это уже генератор, а не резонатор.
  const radius = Math.min(0.9999, Math.exp(-1 / Math.max(1, decaySeconds * sampleRate)));

  const a1 = 2 * radius * Math.cos(omega);
  const a2 = -radius * radius;

  // Нормировка по толчку. Без неё резонатор с секундным звоном усиливает
  // вход в десятки тысяч раз — не «звонко», а мгновенный уход
  // в ограничитель. Синус угла ставит отклик на единичный толчок ровно
  // в единицу, и дальше громкостью звона распоряжается вызывающий.
  //
  // Отсюда же правило пользования: резонатор кормят толчками, а не
  // сплошным шумом. Сплошной шум он накапливает, и накопление
  // тем сильнее, чем дольше звон.
  const strike = Math.sin(omega);

  let previous = 0;
  let older = 0;

  return (input: number): number => {
    const output = clampState(input * strike + a1 * previous + a2 * older);
    older = previous;
    previous = output;
    return output;
  };
};

/**
 * Рассеянные толчки: обломки, осколки, электрический треск.
 *
 * Плотность задаётся числом толчков в секунду и меняется во времени —
 * у обломков она спадает, у электрического разряда обрывается сразу.
 * Каждый толчок получает свою случайную величину, и именно это отличает
 * сыплющиеся обломки от ровного шипения: шум одинаков в каждое мгновение,
 * а осыпь состоит из различимых отдельных событий.
 */
export const createScatter = (
  seed: number,
  sampleRate: number,
): ((densityPerSecond: number) => number) => {
  const random = noiseFrom(seed);

  return (densityPerSecond: number): number => {
    // Вероятность толчка на одном отсчёте. Поток из `noiseFrom` лежит
    // в [-1, 1), поэтому порог отмеряется от единицы вдвое большей долей.
    const probability = Math.max(0, densityPerSecond) / sampleRate;
    if (random() <= 1 - 2 * probability) return 0;

    // Величина толчка случайна и распределена неровно: квадрат делает
    // мелкие толчки частыми, а крупные редкими. Ровная величина слышна
    // как машинная строчка.
    const amplitude = random();
    return amplitude * Math.abs(amplitude);
  };
};

/**
 * Медленное качание громкости.
 *
 * То, что превращает шипение в раскат. Далёкий гром «перекатывается»
 * именно из-за этого: до слушателя приходит не один фронт, а множество
 * отражённых, и суммарная громкость гуляет несколько раз в секунду.
 * Ровный по громкости хвост слышен как шум водопада, а не как гул взрыва.
 *
 * Два несоизмеримых периода вместо одного — чтобы качание не сложилось
 * в узнаваемый ритм.
 */
export const tremolo = (time: number, rateHz: number, depth: number): number => {
  const first = Math.sin(2 * Math.PI * rateHz * time);
  const second = Math.sin(2 * Math.PI * rateHz * 0.41 * time + 1.7);
  return 1 - depth + depth * (0.5 + 0.35 * first + 0.15 * second);
};

/**
 * Насыщение с заданной силой.
 *
 * Не громкость, а плотность. Тангенс складывает верхушку волны и порождает
 * гармоники, которых во входном сигнале не было; на слух это «мощно»,
 * хотя пик не изменился. Деление на насыщение самой единицы сохраняет
 * уровень, чтобы сила насыщения не превращалась в регулятор громкости.
 */
export const createDrive = (amount: number): ((value: number) => number) => {
  if (amount <= 1) return (value: number): number => value;

  const scale = 1 / softClip(amount);
  return (value: number): number => softClip(value * amount) * scale;
};

// ─────────────────────────────────────────────────────────────────────────
// Обработка готового массива
// ─────────────────────────────────────────────────────────────────────────

/**
 * Мягкое ограничение.
 *
 * Слои складываются, и сумма легко выходит за единицу. Жёсткое обрезание
 * превращает превышение в резкий призвук; тангенс сжимает верхушку
 * и на тихих местах не меняет ничего — он почти равен своему аргументу
 * вблизи нуля.
 *
 * Считается не `Math.tanh`, а его дробно-рациональным приближением.
 * Вызывается ограничение на каждом отсчёте каждого звука — это больше
 * миллиона раз за выпечку, — а расходится приближение с настоящим
 * тангенсом меньше чем на тысячную долю на всём рабочем участке.
 */
export const softClip = (value: number): number => {
  if (value > 4) return 1;
  if (value < -4) return -1;

  const square = value * value;
  const numerator = value * (135135 + square * (17325 + square * (378 + square)));
  const denominator = 135135 + square * (62370 + square * (3150 + 28 * square));
  return numerator / denominator;
};

/** Наибольшее отклонение от нуля. */
export const peakOf = (samples: Float32Array): number => {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
};

/**
 * Приведение к заданному пику.
 *
 * Громкости голосов задаются относительно друг друга, а не абсолютной
 * величиной слагаемых: подбирать амплитуду каждого слоя так, чтобы сумма
 * попала в нужный уровень, — занятие без конца. Проще посчитать как
 * получится и привести результат.
 */
export const normalise = (samples: Float32Array, peak: number): Float32Array => {
  const current = peakOf(samples);
  if (current === 0) return samples;

  const scale = peak / current;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = (samples[index] ?? 0) * scale;
  }
  return samples;
};

/**
 * Обнуление краёв короткими скатами.
 *
 * Голос обязан начинаться и кончаться нулём, иначе воспроизведение даёт
 * ступеньку, а ступенька — это щелчок. Скат в две миллисекунды короче
 * различимой длительности и на слышимую форму голоса не влияет.
 */
export const fadeEnds = (
  samples: Float32Array,
  sampleRate: number,
  seconds = 0.002,
): Float32Array => {
  const ramp = Math.max(
    1,
    Math.min(Math.floor(samples.length / 2), Math.round(seconds * sampleRate)),
  );

  for (let index = 0; index < ramp; index += 1) {
    const gain = index / ramp;
    const head = samples[index] ?? 0;
    const tailIndex = samples.length - 1 - index;
    const tail = samples[tailIndex] ?? 0;
    samples[index] = head * gain;
    samples[tailIndex] = tail * gain;
  }

  return samples;
};

// ─────────────────────────────────────────────────────────────────────────
// Выпечка
// ─────────────────────────────────────────────────────────────────────────

/**
 * Посчитать голос целиком: отсчёт за отсчётом, потом ограничить,
 * обнулить края и привести к заданному пику.
 *
 * Функция шага получает время в секундах и номер отсчёта. Состояние —
 * фазы генераторов, память фильтров — живёт в замыкании вызывающего:
 * так у каждого голоса своя арифметика, а общая обвязка одна.
 *
 * `looping` отменяет обнуление краёв. Зацикленному голосу оно противопоказано:
 * ноль на стыке даёт провал громкости четырежды в секунду, и слышен он
 * отчётливее того щелчка, от которого спасает.
 */
export const bake = (
  sampleRate: number,
  seconds: number,
  peak: number,
  step: (time: number, index: number) => number,
  looping = false,
): Float32Array => {
  const samples = new Float32Array(Math.max(1, Math.round(seconds * sampleRate)));

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = softClip(step(index / sampleRate, index));
  }

  if (!looping) fadeEnds(samples, sampleRate);
  return normalise(samples, peak);
};

// ─────────────────────────────────────────────────────────────────────────
// Измерения
// ─────────────────────────────────────────────────────────────────────────

/**
 * Число переходов через ноль на отрезке.
 *
 * Нужно не звуку, а тестам. «Тон падает» и «яркость уходит» — про спектр,
 * а спектр без преобразования Фурье не посчитать; зато частота переходов
 * через ноль растёт вместе со спектральным центром, и для проверки
 * «в конце ниже, чем в начале» этого достаточно. Мерка грубая, но она
 * ловит ровно то, ради чего заведена: перепутанное направление развёртки.
 */
export const zeroCrossings = (samples: Float32Array, from = 0, to = samples.length): number => {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);

  let crossings = 0;
  let previous = samples[start] ?? 0;

  for (let index = start + 1; index < end; index += 1) {
    const value = samples[index] ?? 0;
    if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) crossings += 1;
    previous = value;
  }

  return crossings;
};

/** Среднеквадратичное значение на отрезке — мерка громкости, а не пика. */
export const rms = (samples: Float32Array, from = 0, to = samples.length): number => {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  if (end <= start) return 0;

  let sum = 0;
  for (let index = start; index < end; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }

  return Math.sqrt(sum / (end - start));
};
