import { asPlayerId, asTickNumber, PLAYERS_PER_MATCH } from '@td/shared';
import type { EntityId, PlayerId, TickNumber, Vec2 } from '@td/shared';
import { createRng } from './prng.js';
import type { RngState } from './prng.js';

/**
 * Состояние одного игрока.
 *
 * Все величины целочисленные — это требование детерминизма,
 * подробности в packages/shared/src/units.ts.
 */
export interface PlayerState {
  readonly id: PlayerId;
  /** Валюта на постройку башен. */
  readonly gold: number;
  /** Оставшиеся жизни. Ноль — поражение. */
  readonly lives: number;
}

export interface TowerState {
  readonly id: EntityId;
  readonly owner: PlayerId;
  readonly position: Vec2;
  readonly towerType: number;
  readonly level: number;
  /** Номер тика, когда башня сможет выстрелить снова. */
  readonly readyAtTick: TickNumber;
}

export interface CreepState {
  readonly id: EntityId;
  /** Игрок, по чьей полосе идёт этот враг. */
  readonly target: PlayerId;
  readonly position: Vec2;
  readonly health: number;
  /** Скорость во внутренних единицах за тик. */
  readonly speed: number;
}

/**
 * Полное состояние игрового мира на конкретном тике.
 *
 * Всё состояние собрано в одном объекте намеренно: так его можно целиком
 * сохранить для rollback, посчитать от него контрольную сумму и отправить
 * снимком при рассинхроне. Ничего "снаружи" симуляция не хранит.
 */
export interface WorldState {
  readonly tick: TickNumber;
  readonly rng: RngState;
  readonly players: readonly PlayerState[];
  readonly towers: readonly TowerState[];
  readonly creeps: readonly CreepState[];
  /** Счётчик для выдачи идентификаторов новым сущностям. */
  readonly nextEntityId: number;
}

export const STARTING_GOLD = 200;
export const STARTING_LIVES = 20;

export const createWorld = (seed: number): WorldState => ({
  tick: asTickNumber(0),
  rng: createRng(seed),
  players: Array.from({ length: PLAYERS_PER_MATCH }, (_unused, index) => ({
    id: asPlayerId(index),
    gold: STARTING_GOLD,
    lives: STARTING_LIVES,
  })),
  towers: [],
  creeps: [],
  nextEntityId: 1,
});
