import type { WorldState } from './world.js';

/**
 * Контрольная сумма состояния мира (алгоритм FNV-1a, 32 бита).
 *
 * Зачем: клиент и сервер считают симуляцию независимо. Каждые несколько
 * тиков они сравнивают контрольные суммы. Совпали — миры идентичны,
 * всё хорошо. Разошлись — произошёл рассинхрон, и клиент запрашивает
 * снимок состояния, чтобы догнать сервер.
 *
 * Пересылать полное состояние ради сверки было бы дорого; 4 байта суммы
 * решают ту же задачу.
 *
 * Важное свойство: порядок обхода полей и элементов массивов строго
 * фиксирован. Если обходить объект как попало, две одинаковые по смыслу
 * копии мира дадут разные суммы, и мы получим ложный рассинхрон.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const mix = (hash: number, value: number): number => {
  // Умножение на 32-битное простое через Math.imul: обычный оператор `*`
  // на больших числах уходит в плавающую точку и теряет младшие биты.
  return Math.imul(hash ^ (value | 0), FNV_PRIME) >>> 0;
};

export const checksum = (state: WorldState): number => {
  let hash = FNV_OFFSET_BASIS;

  hash = mix(hash, state.tick);
  hash = mix(hash, state.rng.value);
  hash = mix(hash, state.nextEntityId);
  hash = mix(hash, state.navRevision);
  // null у победителя и игрок с номером ноль — разные вещи, поэтому
  // отсутствие победителя кодируется значением, которого у игрока быть
  // не может.
  hash = mix(hash, state.winner ?? -1);

  // Карта входит в сумму целиком. Если детерминизм генерации сломается,
  // расхождение обнаружится на первой же сверке, а не через сотню тиков
  // по разошедшимся траекториям юнитов.
  for (const cell of state.map.cells) {
    hash = mix(hash, cell);
  }
  for (const base of state.map.baseCells) {
    hash = mix(hash, base);
  }

  for (const player of state.players) {
    hash = mix(hash, player.id);
    hash = mix(hash, player.energy);
    hash = mix(hash, player.targetStructure);

    for (const upgrade of player.upgrades) {
      hash = mix(hash, upgrade.level);
      hash = mix(hash, upgrade.effectPpm);
      hash = mix(hash, upgrade.costPpm);
    }
    for (const multiplier of player.purchasePpm) {
      hash = mix(hash, multiplier);
    }
    for (const queued of player.queue) {
      hash = mix(hash, queued);
    }
  }

  for (const structure of state.structures) {
    hash = mix(hash, structure.id);
    hash = mix(hash, structure.owner);
    hash = mix(hash, structure.kind);
    hash = mix(hash, structure.cell);
    hash = mix(hash, structure.health);
    hash = mix(hash, structure.growthPpm);
    hash = mix(hash, structure.readyAtTick);
    hash = mix(hash, structure.builtAtTick);
  }

  for (const unit of state.units) {
    hash = mix(hash, unit.id);
    hash = mix(hash, unit.owner);
    hash = mix(hash, unit.unitType);
    hash = mix(hash, unit.position.x);
    hash = mix(hash, unit.position.y);
    hash = mix(hash, unit.health);
    hash = mix(hash, unit.readyAtTick);
  }

  for (const general of state.generals) {
    hash = mix(hash, general.owner);
    hash = mix(hash, general.position.x);
    hash = mix(hash, general.position.y);
    hash = mix(hash, general.health);
    hash = mix(hash, general.direction);
    hash = mix(hash, general.readyAtTick);
    hash = mix(hash, general.alive ? 1 : 0);
    hash = mix(hash, general.respawnAtTick);
  }

  for (const nuke of state.nukes) {
    hash = mix(hash, nuke.id);
    hash = mix(hash, nuke.owner);
    hash = mix(hash, nuke.cell);
    hash = mix(hash, nuke.detonateAtTick);
  }

  // Поля потока в сумму не входят намеренно, хотя и лежат в состоянии мира.
  //
  // Они полностью выводятся из карты, построек и цели, а всё это в сумме
  // уже есть. Перемешивать девять тысяч чисел на каждой сверке — дорого
  // и не добавляет ни одного шанса поймать расхождение. Номер ревизии
  // при этом учтён выше, поэтому «поле пересчитали в разные моменты»
  // мы всё-таки заметим.
  //
  // Следы выстрелов тоже не входят: они живут несколько тиков и нужны
  // исключительно рендеру.

  return hash >>> 0;
};
