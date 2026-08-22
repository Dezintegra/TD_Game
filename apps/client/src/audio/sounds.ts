import {
  BLAST_LIFETIME_TICKS,
  BlastKind,
  MISSILE_FLIGHT_SHARE,
  NUKE_DELAY_TICKS,
  SHOT_LIFETIME_TICKS,
  ShotWeapon,
  TICKS_PER_SECOND,
} from '@td/shared';
import { noiseFrom } from '../game/noise.js';
import {
  attackAt,
  bake,
  createDecay,
  createDecayTo,
  createDrive,
  createFilter,
  createOnePole,
  createResonator,
  createScatter,
  createSweep,
  normalise,
  softClip,
  tremolo,
} from './dsp.js';

/**
 * Звуки игры, посчитанные арифметикой: каждый — массив отсчётов.
 *
 * Считается ЗДЕСЬ ВСЁ, включая то, для чего есть запись. Записи
 * (`assets.ts`) перекрывают посчитанное после загрузки, а до тех пор
 * и вместо него — если файл не загрузился, не декодировался или сеть
 * оборвалась — играет то, что здесь. Выкладка стоит недорого, идёт
 * в рабочем потоке и не касается кадра, зато делает тишину невозможной.
 *
 * Устройство взрыва
 * ─────────────────
 * Взрыв — не «низкий хлопок». Настоящий взрыв слышен семью наложенными
 * слоями, и каждый отвечает за своё; уберите любой, и звук развалится
 * в узнаваемую дешёвку.
 *
 * 1. КРОМКА — ударный фронт. Три-десять миллисекунд широкополосного
 *    треска. Без неё взрыв читается «пухом», а не разрывом: именно
 *    кромка сообщает уху, что событие мгновенное.
 * 2. ТЕЛО — шум сквозь резонансный фильтр, срез которого рушится
 *    с полутора килогерц до полутора сотен герц за десятые доли
 *    секунды. Насыщено: тангенс добавляет гармоник, и звук становится
 *    плотным, не становясь громче.
 * 3. НИЗ — синус, съезжающий со ста тридцати герц к сорока. То, что
 *    чувствуется грудью, а не слышится ухом.
 * 4. ОТРАЖЕНИЕ — второй, приглушённый удар через несколько десятков
 *    миллисекунд. Это не украшение: разница хода между прямым фронтом
 *    и отражённым и есть то, по чему ухо определяет масштаб события.
 *    Взрыв без отражения слышен маленьким, каким бы громким он ни был.
 * 5. ОБЛОМКИ — рассыпанные во времени отдельные толчки, а не шум.
 *    Ухо различает осыпь именно как череду событий; ровное шипение
 *    на их месте читается помехой в тракте.
 * 6. МЕТАЛЛ — несколько резонаторов на негармонических частотах. Ухо
 *    отличает металл от камня по тому, что призвуки не складываются
 *    в аккорд.
 * 7. РАСКАТ — длинный низкий хвост с медленным качанием громкости.
 *    Качание обязательно: далёкий гром перекатывается потому, что
 *    приходит множеством отражённых фронтов, а ровный хвост слышен
 *    шумом водопада.
 *
 * И общее правило, которое важнее всех семи: ВЕРХ УМИРАЕТ БЫСТРЕЕ НИЗА.
 * Воздух гасит высокие частоты на порядок сильнее низких, поэтому
 * у кромки постоянная времени в миллисекундах, у тела — в десятках,
 * у низа — в сотнях, а у раската — в секундах. Взрыв, у которого все
 * слои затухают одинаково, звучит синтезатором с первой же ноты.
 *
 * Цена вычислений
 * ───────────────
 * Двадцать семь секунд звука — это больше миллиона отсчётов, и наивная
 * запись выкладок обошлась бы почти в две секунды работы на запуске.
 * Отсюда два приёма, которыми она сведена к десяткам миллисекунд:
 * затухания идут шагами (`createDecay`), а огибающие частоты среза
 * считаются с управляющей частотой — раз в шестнадцать отсчётов.
 * Слух разницы не улавливает: срез, меняющийся три тысячи раз
 * в секунду, для него непрерывен.
 */

// ─────────────────────────────────────────────────────────────────────────
// Перечень
// ─────────────────────────────────────────────────────────────────────────

export const Sound = {
  /** Трассер штурмовика. */
  BoltUnit: 'bolt-unit',
  /** Трассер базовой башни: ниже и тяжелее. */
  BoltTower: 'bolt-tower',
  /** Луч снайпера. */
  BeamUnit: 'beam-unit',
  /** Луч снайперской башни. */
  BeamTower: 'beam-tower',
  /** Разряд Теслы. */
  Arc: 'arc',
  /** Ракета генерала: полёт и приход в цель. */
  Missile: 'missile',
  /** Гибель машины. */
  BlastUnit: 'blast-unit',
  /** Гибель генерала. */
  BlastGeneral: 'blast-general',
  /** Разрушение постройки. */
  BlastStructure: 'blast-structure',
  /** Свист снижающейся ядерной ракеты. */
  NukeFall: 'nuke-fall',
  /** Ядерный удар. */
  NukeBlast: 'nuke-blast',
  /** Винты генерала. Зацикленный. */
  Rotor: 'rotor',
} as const;

export type Sound = (typeof Sound)[keyof typeof Sound];

export const SOUNDS: readonly Sound[] = Object.values(Sound);

/** Как часто пересчитываются огибающие частоты среза, в отсчётах. */
const CONTROL_STEP = 16;

const seconds = (ticks: number): number => ticks / TICKS_PER_SECOND;

const MISSILE_FLIGHT_SECONDS =
  seconds(SHOT_LIFETIME_TICKS[ShotWeapon.Missile]) * MISSILE_FLIGHT_SHARE;

/**
 * Длительности.
 *
 * Там, где событие имеет срок в мире, длительность берётся из него,
 * а не подбирается на слух: разойдись они, ракета взрывалась бы
 * в тишине, а грохот приходил бы к пустому месту.
 *
 * Там, где звук вправе пережить картинку, он её переживает. Гром
 * перекатывается уже после того, как молния погасла, — и разряд Теслы
 * звучит втрое дольше, чем виден.
 */
export const SOUND_SECONDS: Readonly<Record<Sound, number>> = {
  [Sound.BoltUnit]: 0.11,
  [Sound.BoltTower]: 0.17,
  [Sound.BeamUnit]: seconds(SHOT_LIFETIME_TICKS[ShotWeapon.Beam]),
  [Sound.BeamTower]: seconds(SHOT_LIFETIME_TICKS[ShotWeapon.Beam]) * 1.3,
  [Sound.Arc]: 0.9,
  [Sound.Missile]: MISSILE_FLIGHT_SECONDS + 0.45,
  [Sound.BlastUnit]: seconds(BLAST_LIFETIME_TICKS[BlastKind.Unit]) + 0.05,
  [Sound.BlastGeneral]: seconds(BLAST_LIFETIME_TICKS[BlastKind.General]) + 0.3,
  [Sound.BlastStructure]: seconds(BLAST_LIFETIME_TICKS[BlastKind.Structure]) + 0.5,
  [Sound.NukeFall]: seconds(NUKE_DELAY_TICKS),
  [Sound.NukeBlast]: seconds(BLAST_LIFETIME_TICKS[BlastKind.Nuke]),
  [Sound.Rotor]: 0.5,
};

/**
 * Относительная громкость.
 *
 * Задаётся пиком, к которому приводится посчитанный звук. Пик — не то же
 * самое, что слышимая громкость: у трассера пик занимает почти весь
 * звук, у ядерного удара — десять миллисекунд ударного фронта. Поэтому
 * удар с пиком 1.0 слышен несравнимо тяжелее трассера с пиком 0.42,
 * и это ровно то соотношение, которое нужно.
 */
export const SOUND_PEAK: Readonly<Record<Sound, number>> = {
  [Sound.BoltUnit]: 0.42,
  [Sound.BoltTower]: 0.5,
  [Sound.BeamUnit]: 0.5,
  [Sound.BeamTower]: 0.58,
  [Sound.Arc]: 0.78,
  [Sound.Missile]: 0.72,
  // Гибель машины намеренно тише всех взрывов. Их случается по нескольку
  // в секунду, и громкая гибель каждой перекрыла бы собой всё остальное,
  // включая то, что игроку важнее, — чей это был юнит и что рядом рушится
  // постройка. Гибель генерала тоже убавлена: он один, но и событие это
  // не того веса, что потерянная позиция.
  [Sound.BlastUnit]: 0.42,
  [Sound.BlastGeneral]: 0.58,
  [Sound.BlastStructure]: 0.88,
  [Sound.NukeFall]: 0.5,
  [Sound.NukeBlast]: 1,
  [Sound.Rotor]: 0.5,
};

/**
 * Сколько разных вариантов печётся на каждый звук.
 *
 * Один и тот же массив отсчётов, сыгранный полсотни раз в секунду,
 * слышен дребезжанием пулемёта, а не полусотней выстрелов, — и никакой
 * разброс скорости воспроизведения этого до конца не лечит: ухо ловит
 * повторяющийся рисунок шума, а не высоту.
 *
 * Поэтому у частых событий вариантов несколько: они отличаются зерном
 * случайности, то есть каждым отдельным толчком обломков и каждым
 * мгновением шума, оставаясь одним и тем же звуком по устройству.
 * У редких вариант один: ядерный удар случается за матч дважды.
 */
export const VARIANTS: Readonly<Record<Sound, number>> = {
  [Sound.BoltUnit]: 4,
  [Sound.BoltTower]: 3,
  [Sound.BeamUnit]: 3,
  [Sound.BeamTower]: 2,
  [Sound.Arc]: 3,
  [Sound.Missile]: 2,
  [Sound.BlastUnit]: 4,
  [Sound.BlastGeneral]: 2,
  [Sound.BlastStructure]: 3,
  [Sound.NukeFall]: 1,
  [Sound.NukeBlast]: 1,
  [Sound.Rotor]: 1,
};

/** Зацикленные звуки не глушатся по краям: провал на стыке слышнее щелчка. */
export const LOOPING: Readonly<Record<Sound, boolean>> = {
  [Sound.BoltUnit]: false,
  [Sound.BoltTower]: false,
  [Sound.BeamUnit]: false,
  [Sound.BeamTower]: false,
  [Sound.Arc]: false,
  [Sound.Missile]: false,
  [Sound.BlastUnit]: false,
  [Sound.BlastGeneral]: false,
  [Sound.BlastStructure]: false,
  [Sound.NukeFall]: false,
  [Sound.NukeBlast]: false,
  [Sound.Rotor]: true,
};

/** Зерно варианта. Разные звуки и разные варианты не должны совпадать. */
const seedOf = (sound: Sound, variant: number): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sound.length; index += 1) {
    hash = Math.imul(hash ^ sound.charCodeAt(index), 0x01000193) >>> 0;
  }
  return Math.imul(hash ^ (variant + 1), 0x01000193) >>> 0;
};

// ─────────────────────────────────────────────────────────────────────────
// Взрыв
// ─────────────────────────────────────────────────────────────────────────

/** Отражение фронта от препятствия: тот же удар, позже и глуше. */
interface Reflection {
  /** Через сколько секунд после прямого фронта. */
  readonly at: number;
  readonly gain: number;
  readonly cutoff: number;
}

interface BlastSpec {
  readonly seconds: number;
  readonly peak: number;

  /** Ударный фронт. */
  readonly crackGain: number;
  readonly crackTau: number;

  /** Тело: срез рушится отсюда сюда за `bodyFall` секунд. */
  readonly bodyFrom: number;
  readonly bodyTo: number;
  readonly bodyFall: number;
  readonly bodyTau: number;
  readonly bodyGain: number;
  readonly bodyDrive: number;

  /** Низ. */
  readonly subFrom: number;
  readonly subTo: number;
  readonly subTau: number;
  readonly subGain: number;

  /** Раскат. */
  readonly tailFrom: number;
  readonly tailTo: number;
  readonly tailTau: number;
  readonly tailGain: number;
  readonly tailRate: number;
  readonly tailDepth: number;

  /** Обломки. */
  readonly debrisAt: number;
  readonly debrisSeconds: number;
  readonly debrisDensity: number;
  readonly debrisHz: number;
  readonly debrisGain: number;

  /** Металл: частоты резонаторов и звонкость. */
  readonly modes: readonly number[];
  readonly modeGain: number;
  readonly modeDecay: number;

  readonly reflections: readonly Reflection[];
}

const renderBlast = (sampleRate: number, seed: number, spec: BlastSpec): Float32Array => {
  const crackNoise = noiseFrom(seed ^ 0x9e3779b9);
  const crackFilter = createFilter(sampleRate, 'high');
  const crackDecay = createDecay(sampleRate, spec.crackTau);

  const bodyNoise = noiseFrom(seed ^ 0x85ebca6b);
  const bodyFilter = createFilter(sampleRate, 'low');
  const bodyDecay = createDecayTo(sampleRate, spec.seconds, spec.bodyTau);
  const bodySweep = createSweep(spec.bodyFrom, spec.bodyTo);
  const bodyDrive = createDrive(spec.bodyDrive);

  const subDecay = createDecayTo(sampleRate, spec.seconds, spec.subTau);
  const subSweep = createSweep(spec.subFrom, spec.subTo);

  const tailNoise = noiseFrom(seed ^ 0xc2b2ae35);
  const tailFilter = createFilter(sampleRate, 'low');
  const tailDecay = createDecayTo(sampleRate, spec.seconds, spec.tailTau);
  const tailSweep = createSweep(spec.tailFrom, spec.tailTo);

  const debrisScatter = createScatter(seed ^ 0x27d4eb2f, sampleRate);
  const debrisFilter = createFilter(sampleRate, 'band');

  const reflections = spec.reflections.map((reflection, index) => ({
    at: reflection.at,
    gain: reflection.gain,
    cutoff: reflection.cutoff,
    noise: noiseFrom(seed ^ (0x165667b1 + index)),
    filter: createFilter(sampleRate, 'low'),
    decay: createDecay(sampleRate, spec.crackTau * 3.5),
  }));

  // Резонаторы затухают по-разному: одинаковое затухание слышно
  // аккордом, а не ударом по металлу.
  const modes = spec.modes.map((hz, index) =>
    createResonator(sampleRate, hz, spec.modeDecay * (1 - index * 0.14)),
  );
  const modeScatter = createScatter(seed ^ 0x9e3779b1, sampleRate);

  // Поля набора вынуты в локальные переменные, а обходы массивов
  // записаны по индексу, а не через `for..of`. И то и другое — не вкус:
  // обращение к полю объекта и создание перебирающего объекта на каждом
  // отсчёте стоят больше, чем вся остальная арифметика слоя, а отсчётов
  // здесь миллион с четвертью.
  const {
    crackGain,
    bodyGain,
    subGain,
    tailGain,
    tailRate,
    tailDepth,
    debrisAt,
    debrisSeconds,
    debrisDensity,
    debrisHz,
    debrisGain,
    modeGain,
    bodyFall,
    subTau,
    seconds: total,
  } = spec;

  const modeCount = modes.length;
  const reflectionCount = reflections.length;

  let bodyCutoff = spec.bodyFrom;
  let subHz = spec.subFrom;
  let tailCutoff = spec.tailFrom;
  let swing = 1;
  let subPhase = 0;

  return bake(sampleRate, spec.seconds, spec.peak, (time, index) => {
    if (index % CONTROL_STEP === 0) {
      bodyCutoff = bodySweep(Math.pow(Math.min(1, time / bodyFall), 0.65));
      subHz = subSweep(Math.min(1, time / (subTau * 2.2)));
      tailCutoff = tailSweep(Math.min(1, time / (total * 0.7)));
      swing = tremolo(time, tailRate, tailDepth);
    }

    // Затухания шагают всегда, даже когда слой промолчал: пропущенный
    // шаг сдвинул бы огибающую во времени.
    const crackEnvelope = crackDecay();
    const bodyEnvelope = bodyDecay();
    const subEnvelope = subDecay();
    const tailEnvelope = tailDecay();

    let sum = 0;

    // 1. Кромка.
    if (crackEnvelope > 1e-4) {
      sum += crackFilter(crackNoise(), 2600, 0.9) * crackEnvelope * crackGain;
    }

    // 2. Тело.
    sum += bodyDrive(bodyFilter(bodyNoise(), bodyCutoff, 1.7) * bodyEnvelope) * bodyGain;

    // 3. Низ. Фаза копится, а не считается от времени: иначе развёртка
    //    частоты даёт вдвое больший ход, чем задан.
    subPhase += subHz / sampleRate;
    sum += Math.sin(2 * Math.PI * subPhase) * subEnvelope * subGain;

    // 4. Отражения.
    for (let slot = 0; slot < reflectionCount; slot += 1) {
      const reflection = reflections[slot];
      if (reflection === undefined || time < reflection.at) continue;

      const envelope = reflection.decay();
      if (envelope <= 1e-4) continue;

      sum +=
        reflection.filter(reflection.noise(), reflection.cutoff, 1.1) * envelope * reflection.gain;
    }

    // 5. Обломки. Плотность спадает: сначала сыплется густо, потом
    //    поодиночке — как оно и бывает. Полосовой фильтр опрашивается
    //    и на нулевом входе: его звон после толчка и есть звук
    //    отдельного обломка.
    const debrisLocal = time - debrisAt;
    let impulse = 0;
    if (debrisLocal >= 0 && debrisLocal < debrisSeconds) {
      const share = 1 - debrisLocal / debrisSeconds;
      impulse = debrisScatter(debrisDensity * share * share);
      sum += debrisFilter(impulse, debrisHz, 2.4) * debrisGain * share;
    }

    // 6. Металл. Резонаторы бьются фронтом и обломками: сооружение
    //    звенит и в момент разрыва, и потом — от падающих кусков.
    if (modeGain > 0) {
      const strike =
        crackEnvelope * crackNoise() * 0.6 +
        impulse * 0.8 +
        modeScatter(time < 0.05 ? 900 : 40) * 0.5;

      for (let slot = 0; slot < modeCount; slot += 1) {
        const resonator = modes[slot];
        if (resonator !== undefined) sum += resonator(strike) * modeGain;
      }
    }

    // 7. Раскат.
    sum += tailFilter(tailNoise(), tailCutoff, 1.2) * tailEnvelope * swing * tailGain;

    return sum;
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Наборы взрывов
// ─────────────────────────────────────────────────────────────────────────

/**
 * Машина. Короткий и злой.
 *
 * Их гибнут десятки, и длинный взрыв у каждой превратил бы бой
 * в сплошное зарево — то же правило, по которому устроена картинка
 * (замысел, 7.2). Металл есть, но его немного: корпус мелкий.
 */
const UNIT_BLAST: BlastSpec = {
  seconds: SOUND_SECONDS[Sound.BlastUnit],
  peak: SOUND_PEAK[Sound.BlastUnit],
  crackGain: 0.9,
  crackTau: 0.004,
  bodyFrom: 1500,
  bodyTo: 180,
  bodyFall: 0.14,
  bodyTau: 0.05,
  bodyGain: 1,
  bodyDrive: 2.3,
  subFrom: 132,
  subTo: 42,
  subTau: 0.13,
  subGain: 0.95,
  tailFrom: 900,
  tailTo: 140,
  tailTau: 0.2,
  tailGain: 0.33,
  tailRate: 7.5,
  tailDepth: 0.5,
  debrisAt: 0.045,
  debrisSeconds: 0.38,
  debrisDensity: 260,
  debrisHz: 2200,
  debrisGain: 0.34,
  modes: [437, 719, 1163],
  modeGain: 0.05,
  modeDecay: 0.13,
  reflections: [{ at: 0.032, gain: 0.34, cutoff: 900 }],
};

/**
 * Генерал. Тяжелее машины, и с выбегающим ротором в хвосте.
 *
 * Ротор — не украшение: генерал опознаётся на поле высотой и винтами,
 * и его гибель обязана звучать гибелью именно вертолёта. Выбег даёт
 * то же, что и картинка, — «упал он, а не расстреляли коробку».
 */
const GENERAL_BLAST: BlastSpec = {
  seconds: SOUND_SECONDS[Sound.BlastGeneral],
  peak: SOUND_PEAK[Sound.BlastGeneral],
  crackGain: 1,
  crackTau: 0.005,
  bodyFrom: 1300,
  bodyTo: 130,
  bodyFall: 0.2,
  bodyTau: 0.08,
  bodyGain: 1.05,
  bodyDrive: 2.7,
  subFrom: 112,
  subTo: 33,
  subTau: 0.3,
  subGain: 1.05,
  tailFrom: 800,
  tailTo: 110,
  tailTau: 0.5,
  tailGain: 0.45,
  tailRate: 5.5,
  tailDepth: 0.55,
  debrisAt: 0.06,
  debrisSeconds: 0.8,
  debrisDensity: 330,
  debrisHz: 1900,
  debrisGain: 0.36,
  modes: [321, 509, 867, 1297],
  modeGain: 0.07,
  modeDecay: 0.28,
  reflections: [{ at: 0.05, gain: 0.44, cutoff: 700 }],
};

/**
 * Постройка. Обвал.
 *
 * Башня — это вложенная энергия и потерянная позиция, её обломки тяжелее,
 * а дым держится дольше (замысел, 7.2). В звуке то же самое: обломков
 * вдвое больше и сыплются они вчетверо дольше, металла столько же,
 * сколько в самом сооружении, а раскат уходит за две секунды.
 */
const STRUCTURE_BLAST: BlastSpec = {
  seconds: SOUND_SECONDS[Sound.BlastStructure],
  peak: SOUND_PEAK[Sound.BlastStructure],
  crackGain: 0.85,
  crackTau: 0.006,
  bodyFrom: 1100,
  bodyTo: 110,
  bodyFall: 0.26,
  bodyTau: 0.11,
  bodyGain: 1,
  bodyDrive: 2.5,
  subFrom: 96,
  subTo: 28,
  subTau: 0.4,
  subGain: 1.1,
  tailFrom: 700,
  tailTo: 90,
  tailTau: 0.8,
  tailGain: 0.55,
  tailRate: 4.5,
  tailDepth: 0.6,
  debrisAt: 0.085,
  debrisSeconds: 1.45,
  debrisDensity: 460,
  debrisHz: 1600,
  debrisGain: 0.5,
  modes: [197, 299, 461, 709, 1049],
  modeGain: 0.1,
  modeDecay: 0.42,
  reflections: [{ at: 0.07, gain: 0.5, cutoff: 620 }],
};

/**
 * Ядерный удар.
 *
 * Всё то же самое, но в другом масштабе, и масштаб делают не громкость,
 * а два обстоятельства.
 *
 * Первое — время. Низ съезжает к девятнадцати герцам за секунду
 * с лишним, раскат живёт четыре секунды. Ухо оценивает величину события
 * по тому, как долго оно разворачивается, а не по тому, как громко.
 *
 * Второе — два отражения вместо одного: близкое от земли и далёкое,
 * почти через полсекунды, — от того, что стоит на горизонте. Именно
 * второе отличает удар, накрывший полкарты, от удара, накрывшего клетку.
 */
const NUKE_BLAST: BlastSpec = {
  seconds: SOUND_SECONDS[Sound.NukeBlast],
  peak: SOUND_PEAK[Sound.NukeBlast],
  crackGain: 1,
  crackTau: 0.011,
  bodyFrom: 3200,
  bodyTo: 70,
  bodyFall: 0.75,
  bodyTau: 0.32,
  bodyGain: 1.1,
  bodyDrive: 3,
  subFrom: 82,
  subTo: 19,
  subTau: 1.15,
  subGain: 1.35,
  tailFrom: 520,
  tailTo: 52,
  tailTau: 2.5,
  tailGain: 0.95,
  tailRate: 3.2,
  tailDepth: 0.65,
  debrisAt: 0.16,
  debrisSeconds: 2.6,
  debrisDensity: 280,
  debrisHz: 1150,
  debrisGain: 0.3,
  modes: [61, 97, 149],
  modeGain: 0.09,
  modeDecay: 1.1,
  reflections: [
    { at: 0.13, gain: 0.7, cutoff: 520 },
    { at: 0.44, gain: 0.4, cutoff: 260 },
  ],
};

/** Сколько раз в секунду лопасть проходит мимо. */
const BLADE_HZ = 14;

/**
 * Гибель генерала: взрыв плюс выбегающий ротор.
 *
 * Ротор замедляется с четырнадцати ударов в секунду до четырёх и стихает.
 * Считается поверх готового взрыва, а не отдельным слоем внутри него:
 * взрыв у всех устроен одинаково, и вставлять в общее устройство
 * исключение ради одного случая значило бы усложнить все четыре набора
 * ради одного.
 */
const renderGeneralBlast = (sampleRate: number, seed: number): Float32Array => {
  const samples = renderBlast(sampleRate, seed, GENERAL_BLAST);
  const total = SOUND_SECONDS[Sound.BlastGeneral];

  const noise = noiseFrom(seed ^ 0x6a09e667);
  const low = createOnePole(sampleRate);
  const fade = createDecayTo(sampleRate, total, total * 0.3);

  let bladePhase = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate;
    const share = Math.min(1, time / total);

    // Обороты падают, и падают быстрее к концу: винт не тормозят,
    // он останавливается сам.
    const bladeHz = BLADE_HZ * (1 - 0.72 * Math.sqrt(share));
    bladePhase += bladeHz / sampleRate;

    const chop = Math.pow((1 - Math.cos(2 * Math.PI * bladePhase)) / 2, 2.2);
    const carrier = low(noise(), 900 - 500 * share);

    // Вступает не сразу: первые полтораста миллисекунд занят сам взрыв,
    // и ротор в них всё равно не слышен.
    const envelope = Math.min(1, Math.max(0, (time - 0.15) / 0.2)) * fade();

    samples[index] = softClip((samples[index] ?? 0) + carrier * chop * envelope * 0.5);
  }

  return normalise(samples, SOUND_PEAK[Sound.BlastGeneral]);
};

// ─────────────────────────────────────────────────────────────────────────
// Выстрелы
// ─────────────────────────────────────────────────────────────────────────

interface BoltSpec {
  readonly seconds: number;
  readonly peak: number;
  readonly from: number;
  readonly to: number;
  readonly tau: number;
  readonly subFrom: number;
  readonly subGain: number;
}

/**
 * Трассер: то самое «пиу».
 *
 * Устроен падением высоты — и падение экспоненциальное, потому что слух
 * воспринимает высоту логарифмически. Резонансный фильтр идёт следом
 * за тоном на удвоенной частоте: он даёт «клюв», по которому лазерный
 * выстрел и опознаётся.
 *
 * Щелчок шума в первые три миллисекунды — то же, что кромка у взрыва:
 * без него выстрел начинается плавно и звучит свистком, а не ударом.
 */
const renderBolt = (sampleRate: number, seed: number, spec: BoltSpec): Float32Array => {
  const clickNoise = noiseFrom(seed ^ 0x2545f491);
  const clickFilter = createFilter(sampleRate, 'high');
  const clickDecay = createDecay(sampleRate, 0.0028);

  const toneFilter = createFilter(sampleRate, 'low');
  const toneDecay = createDecayTo(sampleRate, spec.seconds, spec.tau);
  const toneSweep = createSweep(spec.from, spec.to);
  const toneDrive = createDrive(1.6);

  const subDecay = createDecayTo(sampleRate, spec.seconds, spec.tau * 0.7);
  const subSweep = createSweep(spec.subFrom, spec.subFrom * 0.32);

  let hz = spec.from;
  let subHz = spec.subFrom;
  let cutoff = spec.from * 2.2;
  let phase = 0;
  let subPhase = 0;

  return bake(sampleRate, spec.seconds, spec.peak, (time, index) => {
    if (index % CONTROL_STEP === 0) {
      const share = Math.min(1, time / spec.seconds);
      hz = toneSweep(Math.sqrt(share));
      subHz = subSweep(share);
      cutoff = Math.max(320, hz * 2.2);
    }

    phase += hz / sampleRate;
    if (phase >= 1) phase -= Math.floor(phase);

    // Пила и меандр вместе: у пилы все гармоники, у меандра только
    // нечётные. Смесь даёт электрический тембр, которого не даёт
    // ни та, ни другой поодиночке.
    const saw = 2 * phase - 1;
    const square = phase < 0.5 ? 1 : -1;
    const tone = 0.62 * saw + 0.38 * square;

    const envelope = attackAt(time, 0.0015) * toneDecay();
    const click = clickFilter(clickNoise(), 3200, 0.8) * clickDecay() * 0.4;

    subPhase += subHz / sampleRate;
    const sub = Math.sin(2 * Math.PI * subPhase) * subDecay() * spec.subGain;

    return toneDrive(toneFilter(tone, cutoff, 5) * envelope) + click + sub;
  });
};

interface BeamSpec {
  readonly seconds: number;
  readonly peak: number;
  readonly base: number;
}

/**
 * Луч: гудение.
 *
 * Три пилы, расстроенные на шесть тысячных, дают биение около двух герц —
 * это и есть «гудит». Полосовой фильтр, съезжающий с 1900 к 700 герцам,
 * превращает пилу в луч: у выстрела появляется тело, а не только тон.
 *
 * Огибающая с полкой — то, чем луч отличается от трассера. Трассер это
 * удар и затухание; луч держится, и держится ровно столько, сколько его
 * видно на поле.
 */
const renderBeam = (sampleRate: number, seed: number, spec: BeamSpec): Float32Array => {
  // Полосы привязаны к основному тону, а не заданы в герцах.
  //
  // Так и обнаружилась ошибка: у башенного луча основа ниже машинной
  // в полтора раза, а полосы стояли на месте — и вместо низкого
  // и тяжёлого он выходил тонким, потому что от его тона в неподвижной
  // полосе оставалось меньше, а шипение поверх звучало прежним.
  // Множители подобраны так, чтобы машинный луч остался ровно таким,
  // каким был.
  const airNoise = noiseFrom(seed ^ 0x5bd1e995);
  const airFilter = createFilter(sampleRate, 'band');
  const airSweep = createSweep(spec.base * 13.8, spec.base * 7.9);

  const bodyFilter = createFilter(sampleRate, 'band');
  const bodySweep = createSweep(spec.base * 6.2, spec.base * 2.3);
  const bodyDrive = createDrive(1.9);

  const hold = spec.seconds * 0.5;
  const release = spec.seconds - hold;
  const releaseDecay = createDecayTo(sampleRate, release, release * 0.42);

  const subSweep = createSweep(spec.base * 0.5, spec.base * 0.34);
  const subDecay = createDecayTo(sampleRate, spec.seconds, 0.05);

  let centre = spec.base * 6.2;
  let airCentre = spec.base * 13.8;
  let subHz = spec.base * 0.5;
  let swing = 1;

  let first = 0;
  let second = 0;
  let third = 0;
  let subPhase = 0;

  return bake(sampleRate, spec.seconds, spec.peak, (time, index) => {
    if (index % CONTROL_STEP === 0) {
      const share = Math.min(1, time / spec.seconds);
      centre = bodySweep(share);
      airCentre = airSweep(share);
      subHz = subSweep(share);
      // Медленное качание — то самое «гудение», которое слышно поверх
      // биения расстроенных пил.
      swing = tremolo(time, 26, 0.3);
    }

    first += spec.base / sampleRate;
    second += (spec.base * 1.006) / sampleRate;
    third += (spec.base * 0.9935) / sampleRate;
    if (first >= 1) first -= Math.floor(first);
    if (second >= 1) second -= Math.floor(second);
    if (third >= 1) third -= Math.floor(third);

    const stack = (2 * first - 1) * 0.4 + (2 * second - 1) * 0.32 + (2 * third - 1) * 0.28;
    const body = bodyFilter(stack, centre, 4);

    // Шипение вокруг луча: без него он звучит нотой синтезатора.
    const air = airFilter(airNoise(), airCentre, 1.8) * 0.22;

    // Затухание шагает только на спаде, поэтому и заведено на его длину.
    const envelope = attackAt(time, 0.012) * (time < hold ? 1 : releaseDecay());

    subPhase += subHz / sampleRate;
    const sub = Math.sin(2 * Math.PI * subPhase) * subDecay() * 0.35;

    return (bodyDrive(body) + air) * envelope * swing + sub * envelope;
  });
};

/**
 * Разряд Теслы: «птыщщщ» и раскат.
 *
 * Четыре слоя, и первый из них — не шум, а отдельные толчки.
 * Электрическая дуга трещит именно потому, что состоит из различимых
 * пробоев; ровный шум на их месте даёт шипение примуса, а не разряд.
 *
 * Толчки бьют по трём резонаторам на высоких частотах — так дуга
 * получает металлический призвук, которого у простого треска нет.
 *
 * Дальше шипящий хвост на срезе, рушащемся с семи килогерц до двухсот,
 * и гром: низ и раскат. Раскат длиннее самого разряда втрое — гром
 * и должен догонять молнию.
 */
const renderArc = (sampleRate: number, seed: number): Float32Array => {
  const total = SOUND_SECONDS[Sound.Arc];

  const sparkScatter = createScatter(seed ^ 0x1b873593, sampleRate);
  const sparkModes = [1830, 3170, 4720].map((hz, index) =>
    createResonator(sampleRate, hz, 0.02 - index * 0.004),
  );

  const hissNoise = noiseFrom(seed ^ 0xcc9e2d51);
  const hissFilter = createFilter(sampleRate, 'low');
  const hissDecay = createDecayTo(sampleRate, total, 0.17);
  const hissSweep = createSweep(7000, 210);
  const hissDrive = createDrive(2);

  const subDecay = createDecayTo(sampleRate, total, 0.28);
  const subSweep = createSweep(98, 37);

  const rollNoise = noiseFrom(seed ^ 0x85ebca6b);
  const rollFilter = createFilter(sampleRate, 'low');
  const rollDecay = createDecayTo(sampleRate, total, 0.45);
  const rollSweep = createSweep(620, 95);

  let hissCutoff = 7000;
  let rollCutoff = 620;
  let subHz = 98;
  let swing = 1;
  let subPhase = 0;

  return bake(sampleRate, total, SOUND_PEAK[Sound.Arc], (time, index) => {
    if (index % CONTROL_STEP === 0) {
      hissCutoff = hissSweep(Math.pow(Math.min(1, time / 0.45), 0.45));
      rollCutoff = rollSweep(Math.min(1, time / 0.7));
      subHz = subSweep(Math.min(1, time / 0.55));
      swing = tremolo(time, 5.2, 0.6);
    }

    let sum = 0;

    // Пробои: густо в первые восемьдесят миллисекунд, дальше редкие.
    const sparkShare = Math.max(0, 1 - time / 0.085);
    const spark = sparkScatter(3200 * sparkShare * sparkShare + 25 * Math.max(0, 1 - time / 0.4));
    sum += spark * 0.5;

    for (let slot = 0; slot < sparkModes.length; slot += 1) {
      const resonator = sparkModes[slot];
      if (resonator !== undefined) sum += resonator(spark) * 0.14;
    }

    // Шипящий хвост.
    sum += hissDrive(hissFilter(hissNoise(), hissCutoff, 2.2) * hissDecay()) * 0.85;

    // Гром: низ.
    subPhase += subHz / sampleRate;
    sum += Math.sin(2 * Math.PI * subPhase) * subDecay() * 0.8;

    // Гром: раскат.
    sum += rollFilter(rollNoise(), rollCutoff, 1.2) * rollDecay() * swing * 0.45;

    return sum;
  });
};

/**
 * Ракета генерала: полёт и приход.
 *
 * Полёт длится ровно столько, сколько ракета летит на экране, — величина
 * общая с отрисовкой и берётся из `@td/shared`. Центр полосы шума
 * поднимается с шестисот герц до двух с половиной тысяч: ракета
 * приближается, и это слышно раньше, чем видно.
 *
 * Приход — компактный взрыв со всеми положенными слоями, начинающийся
 * ровно в тот момент, когда картинка показывает попадание.
 */
const renderMissile = (sampleRate: number, seed: number): Float32Array => {
  const total = SOUND_SECONDS[Sound.Missile];
  const flight = MISSILE_FLIGHT_SECONDS;
  const rest = total - flight;

  const flightNoise = noiseFrom(seed ^ 0x3243f6a8);
  const flightFilter = createFilter(sampleRate, 'band');
  const flightSweep = createSweep(600, 2500);
  const rumbleNoise = noiseFrom(seed ^ 0x885a308d);
  const rumbleFilter = createFilter(sampleRate, 'low');

  const crackNoise = noiseFrom(seed ^ 0x03707344);
  const crackFilter = createFilter(sampleRate, 'high');
  const crackDecay = createDecay(sampleRate, 0.0045);

  const hitNoise = noiseFrom(seed ^ 0x13198a2e);
  const hitFilter = createFilter(sampleRate, 'low');
  const hitDecay = createDecayTo(sampleRate, rest, 0.06);
  const hitSweep = createSweep(1700, 150);
  const hitDrive = createDrive(2.4);

  const subDecay = createDecayTo(sampleRate, rest, 0.15);
  const subSweep = createSweep(124, 38);

  const debrisScatter = createScatter(seed ^ 0xa4093822, sampleRate);
  const debrisFilter = createFilter(sampleRate, 'band');

  let centre = 600;
  let hitCutoff = 1700;
  let subHz = 124;
  let subPhase = 0;

  return bake(sampleRate, total, SOUND_PEAK[Sound.Missile], (time, index) => {
    if (time < flight) {
      const share = time / flight;
      if (index % CONTROL_STEP === 0) centre = flightSweep(share);

      // Нарастание квадратом: ракета приближается, и громкость растёт
      // не линейно, а тем быстрее, чем она ближе.
      const envelope = attackAt(time, 0.02) * (0.25 + 0.75 * share * share);
      return (
        flightFilter(flightNoise(), centre, 3.2) * envelope * 0.75 +
        rumbleFilter(rumbleNoise(), 320, 1) * envelope * 0.3
      );
    }

    const local = time - flight;
    if (index % CONTROL_STEP === 0) {
      hitCutoff = hitSweep(Math.pow(Math.min(1, local / 0.16), 0.65));
      subHz = subSweep(Math.min(1, local / 0.3));
    }

    let sum = 0;

    const crackEnvelope = crackDecay();
    if (crackEnvelope > 1e-4) sum += crackFilter(crackNoise(), 2800, 0.9) * crackEnvelope * 0.95;

    sum += hitDrive(hitFilter(hitNoise(), hitCutoff, 1.7) * hitDecay());

    subPhase += subHz / sampleRate;
    sum += Math.sin(2 * Math.PI * subPhase) * subDecay() * 1.05;

    if (local > 0.05) {
      const share = Math.max(0, 1 - (local - 0.05) / 0.3);
      sum += debrisFilter(debrisScatter(240 * share * share), 2000, 2.4) * 0.3 * share;
    }

    return sum;
  });
};

/**
 * Свист снижающейся ядерной ракеты.
 *
 * Высота падает, громкость растёт — сочетание, которое ухо читает как
 * «падает прямо сюда» без всякого обучения. Три секунды ровно:
 * это `NUKE_DELAY_TICKS`, то самое время на реакцию, ради которого
 * задержка и заведена.
 *
 * Вибрато в полтора процента — то, что отличает падающее тело
 * от лабораторного генератора.
 */
const renderNukeFall = (sampleRate: number, seed: number): Float32Array => {
  const total = SOUND_SECONDS[Sound.NukeFall];

  const windNoise = noiseFrom(seed ^ 0x71374491);
  const windFilter = createFilter(sampleRate, 'band');
  const windSweep = createSweep(520, 2100);
  const toneSweep = createSweep(1700, 250);

  let windCentre = 520;
  let base = 1700;
  let phase = 0;
  let lowPhase = 0;
  let highPhase = 0;

  return bake(sampleRate, total, SOUND_PEAK[Sound.NukeFall], (time, index) => {
    const share = Math.min(1, time / total);
    if (index % CONTROL_STEP === 0) {
      base = toneSweep(Math.pow(share, 1.5));
      windCentre = windSweep(share);
    }

    const hz = base * (1 + 0.015 * Math.sin(2 * Math.PI * 5.5 * time));

    phase += hz / sampleRate;
    lowPhase += (hz * 0.5) / sampleRate;
    highPhase += (hz * 2.02) / sampleRate;

    const tone =
      0.55 * Math.sin(2 * Math.PI * phase) +
      0.3 * (4 * Math.abs((lowPhase % 1) - 0.5) - 1) +
      0.15 * Math.sin(2 * Math.PI * highPhase);

    const wind = windFilter(windNoise(), windCentre, 1.4) * 0.5;

    // Нарастание степенью: последняя секунда громче первых двух вместе.
    return (tone + wind) * share * share;
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Ротор
// ─────────────────────────────────────────────────────────────────────────

/**
 * Винты генерала. Зацикленный звук.
 *
 * Петля обязана сходиться сама с собой, иначе на стыке щёлкает
 * четырнадцать раз в секунду. Поэтому в ней нет ничего непериодического:
 * длина ровно семь оборотов лопасти, тоны кратны частоте петли,
 * а шум — единственное, что периодичным быть не может, — сшит сам
 * с собой перекрёстным затуханием на стыке.
 *
 * Отдельно про форму. Вертолёт узнаётся не гулом, а «чоп-чоп-чоп»:
 * лопасть проходит мимо и рубит воздух. Степень у косинуса и делает
 * рубку рубкой — при первой степени это ровное качание, при второй
 * с половиной уже удары.
 */
const renderRotor = (sampleRate: number, seed: number): Float32Array => {
  const total = SOUND_SECONDS[Sound.Rotor];
  const length = Math.round(total * sampleRate);
  const overlap = Math.round(0.012 * sampleRate);

  // Шум считается с запасом, чтобы хвост можно было наложить на голову.
  const carrier = new Float32Array(length + overlap);
  const noise = noiseFrom(seed ^ 0x428a2f98);
  const low = createOnePole(sampleRate);
  const high = createFilter(sampleRate, 'high');

  for (let index = 0; index < carrier.length; index += 1) {
    carrier[index] = low(high(noise(), 110, 0.7), 1150);
  }

  for (let index = 0; index < overlap; index += 1) {
    const fade = index / overlap;
    carrier[index] = (carrier[index] ?? 0) * fade + (carrier[length + index] ?? 0) * (1 - fade);
  }

  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate;

    // Ноль в начале периода: петля начинается и кончается в провале
    // между ударами лопастей, и стык оказывается в самом тихом месте.
    const chop = Math.pow((1 - Math.cos(2 * Math.PI * BLADE_HZ * time)) / 2, 2.5);

    // Частоты кратны частоте петли (двум герцам), поэтому периодичны
    // на её длине точно.
    const hum =
      0.3 * Math.sin(2 * Math.PI * 28 * time) +
      0.22 * Math.sin(2 * Math.PI * 56 * time) +
      0.12 * Math.sin(2 * Math.PI * 112 * time);

    samples[index] = softClip((carrier[index] ?? 0) * chop * 1.1 + hum * (0.45 + 0.55 * chop));
  }

  return normalise(samples, SOUND_PEAK[Sound.Rotor]);
};

// ─────────────────────────────────────────────────────────────────────────
// Сборка
// ─────────────────────────────────────────────────────────────────────────

const BOLT_UNIT: BoltSpec = {
  seconds: SOUND_SECONDS[Sound.BoltUnit],
  peak: SOUND_PEAK[Sound.BoltUnit],
  from: 1900,
  to: 260,
  tau: 0.028,
  subFrom: 300,
  subGain: 0.22,
};

/**
 * Трассер башни.
 *
 * Ниже и длиннее машинного, и это не разнообразие ради разнообразия:
 * башня вчетверо крупнее и неподвижна. Низкий голос — ровно то, чем
 * крупное тело отличается от мелкого, и различать «по мне бьёт башня»
 * и «по мне бьёт пехота» игрок должен на слух.
 */
const BOLT_TOWER: BoltSpec = {
  seconds: SOUND_SECONDS[Sound.BoltTower],
  peak: SOUND_PEAK[Sound.BoltTower],
  from: 1180,
  to: 165,
  tau: 0.05,
  subFrom: 210,
  subGain: 0.4,
};

const BEAM_UNIT: BeamSpec = {
  seconds: SOUND_SECONDS[Sound.BeamUnit],
  peak: SOUND_PEAK[Sound.BeamUnit],
  base: 305,
};

const BEAM_TOWER: BeamSpec = {
  seconds: SOUND_SECONDS[Sound.BeamTower],
  peak: SOUND_PEAK[Sound.BeamTower],
  base: 202,
};

/**
 * Посчитать звук.
 *
 * Вызывается один раз на пару «звук, вариант» за сеанс. В кадре
 * не вызывается никогда: в кадре только воспроизведение посчитанного.
 */
export const renderSound = (sound: Sound, variant: number, sampleRate: number): Float32Array => {
  const seed = seedOf(sound, variant);

  switch (sound) {
    case Sound.BoltUnit:
      return renderBolt(sampleRate, seed, BOLT_UNIT);
    case Sound.BoltTower:
      return renderBolt(sampleRate, seed, BOLT_TOWER);
    case Sound.BeamUnit:
      return renderBeam(sampleRate, seed, BEAM_UNIT);
    case Sound.BeamTower:
      return renderBeam(sampleRate, seed, BEAM_TOWER);
    case Sound.Arc:
      return renderArc(sampleRate, seed);
    case Sound.Missile:
      return renderMissile(sampleRate, seed);
    case Sound.BlastUnit:
      return renderBlast(sampleRate, seed, UNIT_BLAST);
    case Sound.BlastGeneral:
      return renderGeneralBlast(sampleRate, seed);
    case Sound.BlastStructure:
      return renderBlast(sampleRate, seed, STRUCTURE_BLAST);
    case Sound.NukeFall:
      return renderNukeFall(sampleRate, seed);
    case Sound.NukeBlast:
      return renderBlast(sampleRate, seed, NUKE_BLAST);
    case Sound.Rotor:
      return renderRotor(sampleRate, seed);
  }
};
