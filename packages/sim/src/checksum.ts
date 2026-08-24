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
    hash = mix(hash, player.stance);

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
    hash = mix(hash, structure.kills);
    hash = mix(hash, structure.readyAtTick);
    hash = mix(hash, structure.builtAtTick);
    hash = mix(hash, structure.demolishAtTick);
    hash = mix(hash, structure.facing);
  }

  for (const unit of state.units) {
    hash = mix(hash, unit.id);
    hash = mix(hash, unit.owner);
    hash = mix(hash, unit.unitType);
    hash = mix(hash, unit.position.x);
    hash = mix(hash, unit.position.y);
    hash = mix(hash, unit.health);
    hash = mix(hash, unit.facing);
    hash = mix(hash, unit.readyAtTick);
    hash = mix(hash, unit.kills);
  }

  for (const general of state.generals) {
    hash = mix(hash, general.owner);
    hash = mix(hash, general.position.x);
    hash = mix(hash, general.position.y);
    hash = mix(hash, general.health);
    hash = mix(hash, general.direction);
    hash = mix(hash, general.facing);
    hash = mix(hash, general.readyAtTick);
    hash = mix(hash, general.alive ? 1 : 0);
    hash = mix(hash, general.respawnAtTick);
    // Борт следующей ракеты НЕ входит, и это решение, а не пропуск.
    //
    // Довода «величина косметическая» здесь мало: разворот юнита тоже
    // нужен одному рендеру, а в сумме он есть. Решает другое, и это
    // то же соображение, по которому ниже не входят отказы команд.
    //
    // Борт полностью выводится из последовательности выстрелов, а она
    // в сумме уже есть — через готовность генерала, здоровье целей
    // и положения всех участников. Разойтись по борту, не разойдясь
    // по стрельбе, невозможно, и включение не поймает ни одного лишнего
    // расхождения. Зато привяжет эталон детерминизма к чисто
    // косметическому решению: захотим начинать с правого борта вместо
    // левого — и эталон придётся обновлять, хотя правила не менялись.
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
  // исключительно рендеру. Взрывы на местах погибших — ровно того же
  // рода запись и не входят по той же причине. Проверить это легко:
  // сам факт гибели в сумме уже есть — погибшего нет в массивах, —
  // и добавить взрыв значило бы посчитать одно и то же дважды.
  //
  // Отказы команд не входят по той же причине и по ещё одной, более
  // важной. Отказ полностью выводится из состояния и списка команд,
  // а оба у клиента и у сервера одинаковы: разойтись по отказам,
  // не разойдясь по состоянию, невозможно. Включить их в сумму значило бы
  // не поймать ни одного лишнего расхождения, зато сделать величину
  // чувствительной к тому, как именно сформулированы проверки, — и любая
  // правка формулировки отказа требовала бы нового эталона, хотя правила
  // игры не менялись.

  return hash >>> 0;
};
