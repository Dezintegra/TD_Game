import {
  BLAST_LIFETIME_TICKS,
  BlastKind,
  SHOT_LIFETIME_TICKS,
  ShotWeapon,
  StructureKind,
  TICKS_PER_SECOND,
  unitsToCells,
} from '@td/shared';
import { cellIndex, cellX, cellY } from '@td/sim';
import type { WorldState } from '@td/sim';
import { hashOf } from '../game/noise.js';
import { NUKE_FALL_TICKS, Sound } from './sounds.js';

/**
 * Что и где сейчас прозвучало.
 *
 * Событий в клиенте не существует — ни одного колбэка вида «выстрелили».
 * Есть записи в мире с известным сроком жизни, и отрисовка выводит из них
 * возраст арифметикой (`shots.ts`, `blasts.ts`). Звуку приходится так же,
 * но с одной добавкой, без которой всё разваливается.
 *
 * Клиент рисует ПРЕДСКАЗАННЫЙ мир. Он пересобирается откатом на каждом
 * кадре, один и тот же тик отрисовывается по нескольку раз, а номер тика
 * умеет уменьшаться (`clock.ts`). Картинке это безразлично: она чистая
 * функция от снимка, нарисовать её дважды — значит получить то же самое.
 * Звук так не умеет: сыгранное не отыграть назад, и выстрел, «случившийся»
 * пять раз за пять кадров, слышен пятикратным.
 *
 * Отсюда единственное состояние во всём модуле — множество уже сыгранных
 * ключей.
 *
 * Почему не подтверждённый мир, где такой беды нет вовсе. Он отстаёт
 * от предсказанного на задержку ввода, то есть на 2–9 тиков, то есть
 * на 67–300 миллисекунд. Звук, отстающий от собственной вспышки на треть
 * секунды, воспринимается не задержкой, а поломкой. Ценой становится
 * редкий звук события, которого в подтверждённом мире не случилось, —
 * и это правильный размен: промолчать там, где стреляли, хуже, чем
 * хлопнуть там, где почти стреляли.
 */

export interface Cue {
  readonly sound: Sound;
  /** Где случилось, в клетках карты. */
  readonly cellX: number;
  readonly cellY: number;
  /**
   * Ключ события.
   *
   * Он же зерно: из него берётся выбор варианта и разброс скорости.
   * Одно и то же событие обязано звучать одинаково при повторной
   * отрисовке, иначе откат менял бы звук на глазах.
   */
  readonly key: number;
}

export interface CueFeed {
  /**
   * Что нового в мире.
   *
   * `silent` наполняет множество и не возвращает ничего: так проходит
   * первый кадр матча и вся пересборка мира.
   */
  accept(world: WorldState, silent: boolean): readonly Cue[];
  /** Сколько ключей сейчас хранится. Нужно тестам. */
  readonly size: number;
}

/**
 * Запас на уборку, в тиках.
 *
 * Ключ можно забыть, когда породившая его запись заведомо истекла.
 * Самая долгая запись — ядерный взрыв, пять секунд. Запас взят
 * десятикратным намеренно: номер тика умеет уменьшаться, и подметать
 * впритык значило бы забыть о событии, которое после отката вернётся
 * и прозвучит вторично.
 */
const KEEP_TICKS = BLAST_LIFETIME_TICKS[BlastKind.Nuke] * 10;

/** Как часто подметать. Каждый кадр незачем: обход множества не бесплатен. */
const SWEEP_EVERY_TICKS = TICKS_PER_SECOND * 5;

/**
 * Примета, которой ключ свиста отличается от ключа пуска.
 *
 * У ракеты два звука и один идентификатор. Возьми оба ключом сам
 * идентификатор — первый же сыгранный пуск запретил бы свист навсегда:
 * множество сыгранного не знает, какой это был звук, оно знает ключ.
 */
const FALL_KEY_SALT = 0x0f411;

const BLAST_SOUND: Readonly<Record<BlastKind, Sound>> = {
  [BlastKind.Unit]: Sound.BlastUnit,
  [BlastKind.General]: Sound.BlastGeneral,
  [BlastKind.Structure]: Sound.BlastStructure,
  [BlastKind.Nuke]: Sound.NukeBlast,
};

/**
 * Стреляла ли постройка.
 *
 * Опознаётся по точному совпадению точки выстрела с центром клетки:
 * постройка стреляет из центра всегда и стоит в центре всегда, а машина
 * попадает туда разве что случайно.
 *
 * Тот же приём применяет `shots.ts` для высоты дульного среза, но взят он
 * оттуда мыслью, а не импортом: `shots.ts` тянет за собой PixiJS целиком,
 * и звуковой модуль из-за восьми строк начал бы зависеть от рендерера.
 * Расхождения бояться нечего — «постройка стоит в центре клетки» это
 * свойство мира, а не решение отрисовки.
 */
const firedFromStructure = (world: WorldState, cellX: number, cellY: number): boolean => {
  const column = Math.floor(cellX);
  const row = Math.floor(cellY);
  if (cellX - column !== 0.5 || cellY - row !== 0.5) return false;

  const cell = cellIndex(column, row);
  return world.structures.some((structure) => structure.cell === cell);
};

/**
 * Какой звук у выстрела.
 *
 * Вид стрелка в записи не хранится — след живёт дольше стрелка, — поэтому
 * выводится из оружия и из того, стоит ли в клетке выстрела постройка.
 * Разряд бывает только у Теслы, ракета — только у генерала, и спрашивать
 * там не о чем.
 */
const shotSound = (weapon: ShotWeapon, fromStructure: boolean): Sound => {
  switch (weapon) {
    case ShotWeapon.Bolt:
      return fromStructure ? Sound.BoltTower : Sound.BoltUnit;
    case ShotWeapon.Beam:
      return fromStructure ? Sound.BeamTower : Sound.BeamUnit;
    case ShotWeapon.Arc:
      return Sound.Arc;
    case ShotWeapon.Missile:
      return Sound.Missile;
  }
};

export const createCueFeed = (): CueFeed => {
  /** Ключ события → тик, после которого его можно забыть. */
  const played = new Map<number, number>();
  let lastSweepTick = 0;

  const sweep = (tick: number): void => {
    if (Math.abs(tick - lastSweepTick) < SWEEP_EVERY_TICKS) return;
    lastSweepTick = tick;

    for (const [key, until] of played) {
      if (until < tick) played.delete(key);
    }
  };

  return {
    get size() {
      return played.size;
    },

    accept(world: WorldState, silent: boolean): readonly Cue[] {
      const cues: Cue[] = [];
      const tick = world.tick;

      const take = (key: number, sound: Sound, cellX: number, cellY: number): void => {
        if (played.has(key)) return;
        played.set(key, tick + KEEP_TICKS);
        if (!silent) cues.push({ sound, cellX, cellY, key });
      };

      for (const shot of world.shots) {
        const fromX = unitsToCells(shot.from.x);
        const fromY = unitsToCells(shot.from.y);

        // Ключ тот же, каким `shots.ts` задаёт форму искр. Второй копии
        // не заводится: разойдись они, звук и картинка описывали бы
        // разные события.
        const key = hashOf([shot.from.x, shot.from.y, shot.to.x, shot.to.y, shot.expiresAtTick]);
        take(key, shotSound(shot.weapon, firedFromStructure(world, fromX, fromY)), fromX, fromY);
      }

      for (const blast of world.blasts) {
        const key = hashOf([blast.at.x, blast.at.y, blast.expiresAtTick, blast.kind]);
        const sound = BLAST_SOUND[blast.kind];
        take(key, sound, unitsToCells(blast.at.x), unitsToCells(blast.at.y));
      }

      // Ядерная ракета — единственная запись с собственным
      // идентификатором, и ключ у неё поэтому не хеш, а он сам. Звуков
      // у неё два, поэтому ключа тоже два: сам идентификатор у пуска
      // и его же хеш с приметой у свиста. Один ключ на два звука
      // означал бы, что второй не прозвучит никогда.
      for (const nuke of world.nukes) {
        // Пуск — в тот момент, когда запись появилась, и НЕ у цели,
        // а у базы стрелявшего: пускают оттуда. Точки старта в мире
        // не хранится вовсе (`NukeState` знает только цель), и другого
        // способа узнать место нет.
        const base = world.structures.find(
          (structure) => structure.owner === nuke.owner && structure.kind === StructureKind.Base,
        );
        if (base !== undefined) {
          take(nuke.id, Sound.NukeLaunch, cellX(base.cell) + 0.5, cellY(base.cell) + 0.5);
        }

        // Свист — у цели и ТОЛЬКО на последних тиках подлёта. Звучи он
        // с пуска, он занял бы собой все три секунды и перестал бы быть
        // предупреждением; о пуске сообщает свой звук у чужой базы.
        //
        // Сравнение по номеру тика, а не отсчёт от появления записи:
        // номер тика умеет уменьшаться при откате предсказания, и всё,
        // что здесь считается, обязано зависеть только от снимка.
        if (tick >= nuke.detonateAtTick - NUKE_FALL_TICKS) {
          const key = hashOf([nuke.id, FALL_KEY_SALT]);
          take(key, Sound.NukeFall, cellX(nuke.cell) + 0.5, cellY(nuke.cell) + 0.5);
        }
      }

      sweep(tick);
      return cues;
    },
  };
};

/**
 * Сколько живёт запись о событии, в тиках. Нужно тестам и проверке того,
 * что звук не переживает картинку без причины.
 */
export const cueLifetimeTicks = (sound: Sound): number => {
  switch (sound) {
    case Sound.BoltUnit:
    case Sound.BoltTower:
      return SHOT_LIFETIME_TICKS[ShotWeapon.Bolt];
    case Sound.BeamUnit:
    case Sound.BeamTower:
      return SHOT_LIFETIME_TICKS[ShotWeapon.Beam];
    case Sound.Arc:
      return SHOT_LIFETIME_TICKS[ShotWeapon.Arc];
    case Sound.Missile:
      return SHOT_LIFETIME_TICKS[ShotWeapon.Missile];
    case Sound.BlastUnit:
      return BLAST_LIFETIME_TICKS[BlastKind.Unit];
    case Sound.BlastGeneral:
      return BLAST_LIFETIME_TICKS[BlastKind.General];
    case Sound.BlastStructure:
      return BLAST_LIFETIME_TICKS[BlastKind.Structure];
    case Sound.NukeBlast:
      return BLAST_LIFETIME_TICKS[BlastKind.Nuke];
    case Sound.NukeFall:
      return NUKE_FALL_TICKS;
    // Пуск живёт столько же, сколько свист: обе записи говорят об одной
    // ракете, и переживать её ни одна не вправе.
    case Sound.NukeLaunch:
      return NUKE_FALL_TICKS;
    case Sound.Rotor:
      return 0;
  }
};
