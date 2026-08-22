import { SOUND_PRIORITY, Sound } from './sounds.js';

/**
 * Сколько звуков начинать в этом кадре и насколько громко.
 *
 * Ограничение не про экономию, а про то, как складывается звук. Двадцать
 * одинаковых транзиентов, начатых в одну миллисекунду, — это не двадцать
 * выстрелов, а один перегруженный треск: амплитуды складываются, сумма
 * выходит за единицу, и звуковая карта её обрезает. Двести юнитов дают
 * до двадцати выстрелов за тик, и без потолка бой звучал бы именно так.
 *
 * Модуль чистый: числа на входе, числа на выходе.
 */

export interface Candidate {
  readonly sound: Sound;
  readonly key: number;
  readonly cellX: number;
  readonly cellY: number;
  /** Громкость по размещению: чем дальше, тем меньше. */
  readonly gain: number;
}

export interface Chosen extends Candidate {
  /**
   * Прибавка за отброшенных соседей.
   *
   * Отброшенные не пропадают бесследно: некоррелированные источники
   * складываются по энергии, и залп из двенадцати выстрелов обязан
   * звучать громче одиночного — но не в двенадцать раз.
   */
  readonly boost: number;
}

/**
 * Потолки на вид события за кадр.
 *
 * Числа не выведены, а подобраны, и логика подбора одна: чем чаще
 * событие и чем оно короче, тем выше потолок, потому что тем меньше
 * каждое из них значит по отдельности. Трассеров в перестрелке десятки,
 * и четырёх с разбросом высоты хватает, чтобы получилась стрельба;
 * ядерный удар за кадр может быть только один, потому что второй
 * в ту же миллисекунду — это не событие, а сложение двух в кашу.
 */
const PER_SOUND: Readonly<Record<Sound, number>> = {
  [Sound.BoltUnit]: 4,
  [Sound.BoltTower]: 3,
  [Sound.BeamUnit]: 3,
  [Sound.BeamTower]: 2,
  [Sound.Arc]: 3,
  [Sound.Missile]: 2,
  [Sound.BlastUnit]: 3,
  [Sound.BlastGeneral]: 1,
  [Sound.BlastStructure]: 2,
  [Sound.NukeFall]: 1,
  [Sound.NukeBlast]: 1,
  // Ротор не событие, а непрерывный звук: сюда он не попадает вовсе.
  [Sound.Rotor]: 0,
};

/** Общий потолок на кадр поверх поштучных. */
export const PER_FRAME = 12;

/**
 * Предел прибавки за слияние.
 *
 * Честная прибавка — корень из отношения «всего к оставленным», и при
 * двадцати событиях на четыре она дала бы 2,2. Столько давать нельзя:
 * оставленные и так самые близкие, то есть самые громкие, и прибавка
 * поверх этого выбивает их за единицу. Полтора — та величина, при
 * которой залп заметно весомее одиночного выстрела и всё ещё звучит.
 */
const MAX_BOOST = 1.6;

export const chooseCues = (candidates: readonly Candidate[]): readonly Chosen[] => {
  if (candidates.length === 0) return [];

  const bySound = new Map<Sound, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.gain <= 0) continue;
    const group = bySound.get(candidate.sound);
    if (group === undefined) bySound.set(candidate.sound, [candidate]);
    else group.push(candidate);
  }

  const chosen: Chosen[] = [];

  for (const [sound, group] of bySound) {
    const cap = PER_SOUND[sound];
    if (cap <= 0) continue;

    // Ближайшие, то есть самые громкие. Дальнее событие и так тише,
    // и отбрасывать в первую очередь надо его.
    group.sort((a, b) => b.gain - a.gain);

    const kept = Math.min(cap, group.length);
    const boost = Math.min(MAX_BOOST, Math.sqrt(group.length / kept));

    for (let index = 0; index < kept; index += 1) {
      const candidate = group[index];
      if (candidate !== undefined) chosen.push({ ...candidate, boost });
    }
  }

  // Сортировка идёт ВСЕГДА, а не только при переполнении, и порядок
  // здесь важнее отсева. Мест может хватить в этом кадре и не хватить
  // в движке — там свой потолок на одновременно звучащее, — и кто
  // окажется в начале списка, тот и прозвучит. Ядерный удар обязан
  // оказаться первым, даже когда рядом гибнет полсотни машин.
  chosen.sort(
    (a, b) =>
      SOUND_PRIORITY[b.sound] - SOUND_PRIORITY[a.sound] || b.gain * b.boost - a.gain * a.boost,
  );

  return chosen.length <= PER_FRAME ? chosen : chosen.slice(0, PER_FRAME);
};

/**
 * Пулы одновременно звучащего.
 *
 * Общий потолок был один на всех, и это оказалось прямой ошибкой:
 * стрельба и гибель машин выедали его подчистую, а ядерный удар —
 * событие, ради которого копят полматча, — не звучал вовсе. Ждать,
 * что важное само пробьётся сквозь мелочь, нельзя: мелочи всегда
 * больше.
 *
 * Поэтому мест теперь три набора, и они не сообщаются. Сколько бы
 * ни шло стрельбы, она занимает только свой набор; сколько бы ни гибло
 * машин — только свой. Под ядерный удар место свободно ВСЕГДА, потому
 * что занять его больше нечем: в его наборе только он и свист
 * его же ракеты.
 */
export const Pool = {
  Shots: 'shots',
  Blasts: 'blasts',
  Nuke: 'nuke',
} as const;

export type Pool = (typeof Pool)[keyof typeof Pool];

export const POOL_OF: Readonly<Record<Sound, Pool>> = {
  [Sound.BoltUnit]: Pool.Shots,
  [Sound.BoltTower]: Pool.Shots,
  [Sound.BeamUnit]: Pool.Shots,
  [Sound.BeamTower]: Pool.Shots,
  [Sound.Arc]: Pool.Shots,
  [Sound.Missile]: Pool.Shots,
  [Sound.BlastUnit]: Pool.Blasts,
  [Sound.BlastGeneral]: Pool.Blasts,
  [Sound.BlastStructure]: Pool.Blasts,
  [Sound.NukeFall]: Pool.Nuke,
  [Sound.NukeBlast]: Pool.Nuke,
  // Ротор не событие и через эти наборы не проходит: у него свой
  // источник на генерала, живущий столько же, сколько сам генерал.
  [Sound.Rotor]: Pool.Shots,
};

/**
 * Сколько мест в каждом наборе.
 *
 * Выстрелов больше всех, потому что их и происходит больше всех, а живут
 * они десятые доли секунды. Взрывов вдвое меньше: каждый тянется секунду
 * с лишним, и восьми одновременных хватает на любую свалку. Ядерных
 * ровно два — сам удар и свист падающей ракеты; больше двух ядерных
 * событий разом в игре не бывает.
 */
export const POOL_LIMIT: Readonly<Record<Pool, number>> = {
  [Pool.Shots]: 12,
  [Pool.Blasts]: 8,
  [Pool.Nuke]: 2,
};
