import { Sound } from './sounds.js';

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

  if (chosen.length <= PER_FRAME) return chosen;

  // Общий потолок срабатывает редко — только когда одновременно
  // случилось несколько разных видов событий. Отбор тот же: громче
  // значит важнее.
  chosen.sort((a, b) => b.gain * b.boost - a.gain * a.boost);
  return chosen.slice(0, PER_FRAME);
};

/**
 * Потолок одновременно звучащих источников.
 *
 * Держится сверх покадрового: тот ограничивает начатое за кадр,
 * а этот — накопившееся. Ядерный удар звучит семь секунд, обвал
 * постройки три, и без общего потолка к середине осады их набралось бы
 * несколько десятков разом.
 */
export const MAX_ACTIVE = 24;
