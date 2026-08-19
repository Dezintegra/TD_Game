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
    hash = mix(hash, player.gold);
    hash = mix(hash, player.lives);
  }

  for (const tower of state.towers) {
    hash = mix(hash, tower.id);
    hash = mix(hash, tower.owner);
    hash = mix(hash, tower.position.x);
    hash = mix(hash, tower.position.y);
    hash = mix(hash, tower.towerType);
    hash = mix(hash, tower.level);
    hash = mix(hash, tower.readyAtTick);
  }

  for (const creep of state.creeps) {
    hash = mix(hash, creep.id);
    hash = mix(hash, creep.target);
    hash = mix(hash, creep.position.x);
    hash = mix(hash, creep.position.y);
    hash = mix(hash, creep.health);
    hash = mix(hash, creep.speed);
  }

  return hash >>> 0;
};
