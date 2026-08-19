import { CommandKind, asEntityId, asTickNumber, cellsToUnits, FIELD_WIDTH_CELLS } from '@td/shared';
import type { Command } from '@td/shared';
import type { CreepState, WorldState } from './world.js';

/**
 * Один шаг симуляции: чистая функция (состояние, команды) -> новое состояние.
 *
 * Три свойства этой функции делают возможным сетевой PvP:
 *
 * 1. Она чистая — входное состояние не мутируется, возвращается новое.
 *    Значит, старые состояния можно хранить и откатываться к ним.
 * 2. Она детерминированная — одинаковые аргументы всегда дают одинаковый
 *    результат. Значит, клиент может считать вперёд, не дожидаясь сервера.
 * 3. Она не знает ни про сеть, ни про рендер. Значит, один и тот же код
 *    исполняется и в браузере, и в Node.js.
 *
 * Пока здесь только каркас: команды применяются, враги движутся.
 * Боевая механика приедет отдельными изменениями по OpenSpec.
 */
export const step = (state: WorldState, commands: readonly Command[]): WorldState => {
  let next: WorldState = { ...state, tick: asTickNumber(state.tick + 1) };

  for (const command of commands) {
    next = applyCommand(next, command);
  }

  return { ...next, creeps: next.creeps.map(moveCreep).filter(isAlive) };
};

const applyCommand = (state: WorldState, command: Command): WorldState => {
  switch (command.kind) {
    case CommandKind.PlaceTower:
      return placeTower(state, command);
    case CommandKind.SellTower:
    case CommandKind.UpgradeTower:
    case CommandKind.SendWave:
      // Заглушки: обрабатываются в последующих изменениях.
      return state;
  }
};

const TOWER_COST = 50;
const TOWER_COOLDOWN_TICKS = 15;

const placeTower = (
  state: WorldState,
  command: Extract<Command, { kind: typeof CommandKind.PlaceTower }>,
): WorldState => {
  const player = state.players.find((candidate) => candidate.id === command.player);
  if (!player || player.gold < TOWER_COST) {
    // Недостаточно золота — команда молча игнорируется.
    // Важно: и клиент, и сервер придут к одному решению, потому что
    // проверка опирается только на состояние мира.
    return state;
  }

  const occupied = state.towers.some(
    (tower) => tower.position.x === command.position.x && tower.position.y === command.position.y,
  );
  if (occupied) return state;

  return {
    ...state,
    nextEntityId: state.nextEntityId + 1,
    players: state.players.map((candidate) =>
      candidate.id === command.player
        ? { ...candidate, gold: candidate.gold - TOWER_COST }
        : candidate,
    ),
    towers: [
      ...state.towers,
      {
        id: asEntityId(state.nextEntityId),
        owner: command.player,
        position: command.position,
        towerType: command.towerType,
        level: 1,
        readyAtTick: asTickNumber(state.tick + TOWER_COOLDOWN_TICKS),
      },
    ],
  };
};

const FIELD_END_UNITS = cellsToUnits(FIELD_WIDTH_CELLS);

const moveCreep = (creep: CreepState): CreepState => ({
  ...creep,
  position: { x: creep.position.x + creep.speed, y: creep.position.y },
});

const isAlive = (creep: CreepState): boolean =>
  creep.health > 0 && creep.position.x < FIELD_END_UNITS;
