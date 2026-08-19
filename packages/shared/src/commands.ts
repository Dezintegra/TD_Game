import type { PlayerId, TickNumber } from './branded.js';
import type { Vec2 } from './units.js';

/**
 * Команды игрока — единственное, что ходит по сети во время матча.
 *
 * Состояние мира не пересылается: и клиент, и сервер вычисляют его сами
 * из одинакового начального состояния и одинакового потока команд.
 * Поэтому трафик измеряется байтами на тик, а не килобайтами.
 */
export const CommandKind = {
  PlaceTower: 0,
  SellTower: 1,
  UpgradeTower: 2,
  SendWave: 3,
} as const;

export type CommandKind = (typeof CommandKind)[keyof typeof CommandKind];

interface CommandBase {
  readonly player: PlayerId;
  /** Тик, на котором команда должна примениться в симуляции. */
  readonly tick: TickNumber;
}

export interface PlaceTowerCommand extends CommandBase {
  readonly kind: typeof CommandKind.PlaceTower;
  readonly position: Vec2;
  readonly towerType: number;
}

export interface SellTowerCommand extends CommandBase {
  readonly kind: typeof CommandKind.SellTower;
  readonly position: Vec2;
}

export interface UpgradeTowerCommand extends CommandBase {
  readonly kind: typeof CommandKind.UpgradeTower;
  readonly position: Vec2;
}

export interface SendWaveCommand extends CommandBase {
  readonly kind: typeof CommandKind.SendWave;
  readonly unitType: number;
}

export type Command = PlaceTowerCommand | SellTowerCommand | UpgradeTowerCommand | SendWaveCommand;
