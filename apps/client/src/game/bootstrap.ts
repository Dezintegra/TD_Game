import {
  CommandKind,
  NUKE_BASE_EXCLUSION,
  NUKE_COST,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  Terrain,
  UNIT_CAP,
  asPlayerId,
  asTickNumber,
  distanceSquared,
  energyToVisible,
  unitsToCells,
} from '@td/shared';
import type { Command, PlayerId, StructureKind as StructureKindType, UnitType } from '@td/shared';
import {
  buildOccupancy,
  cellAt,
  cellCentre,
  playerStats,
  rockPercent,
  upgradeCosts,
} from '@td/sim';
import type { Occupancy, WorldState } from '@td/sim';
import { createGameLoop } from './loop.js';
import { createNetClient } from './net.js';
import { createScene } from './scene.js';
import { visibleMapPercent } from './iso.js';
import { hudActions, setMatchCommands } from './store.js';
import type { MatchSnapshot } from './store.js';
import { attachControls } from './controls.js';
import type { ControlState } from './controls.js';
import { createOpponent } from './ai/opponent.js';

/**
 * Сборка игры воедино: сцена, цикл, сеть, управление, противник.
 *
 * Живёт вне React намеренно. React-компоненты монтируются и размонтируются
 * по своим правилам, а игровой цикл должен пережить любую перерисовку HUD,
 * включая горячую перезагрузку при разработке.
 *
 * Матч идёт целиком в браузере: за второго игрока играет противник
 * под управлением компьютера, и его команды попадают в тот же поток,
 * что и команды человека. Соединение с сервером остаётся диагностическим —
 * ping и pong, — и на матч не влияет.
 */
export interface Game {
  stop(): void;
}

const WS_URL = import.meta.env['VITE_WS_URL'] ?? 'ws://127.0.0.1:3001/game';

/** Стартовый seed. Карта воспроизводима, пока его не сменят. */
const INITIAL_SEED = 1337;

/** За кого играет человек. Противник — второй. */
const LOCAL_PLAYER: PlayerId = asPlayerId(0);
const OPPONENT_PLAYER: PlayerId = asPlayerId(1);

/**
 * Как часто снимок матча уезжает в HUD, в тиках.
 *
 * Шесть тиков — это пять обновлений в секунду. Чаще незачем: человек
 * не считывает цифры быстрее, а каждое обновление перерисовывает панели.
 */
const HUD_EVERY_TICKS = 6;

export const startGame = async (host: HTMLElement): Promise<Game> => {
  const scene = await createScene(host);
  const net = createNetClient(WS_URL);

  let seed = INITIAL_SEED;
  let opponent = createOpponent(OPPONENT_PLAYER, seed ^ 0x5bf03635);

  /**
   * Сетка занятости пересобирается не каждый кадр, а при смене набора
   * построек. Она нужна только подсказке «сюда можно строить», и обходить
   * ради неё девять тысяч клеток по шестьдесят раз в секунду расточительно.
   */
  let occupancy: Occupancy | undefined;
  let occupancyFor: WorldState['structures'] | undefined;

  const occupancyOf = (world: WorldState): Occupancy => {
    if (occupancy === undefined || occupancyFor !== world.structures) {
      occupancy = buildOccupancy(world.map, world.structures);
      occupancyFor = world.structures;
    }
    return occupancy;
  };

  const loop = createGameLoop({
    seed,

    commands: (world) => opponent.decide(world),

    onTick: (world) => {
      hudActions.setTick(world.tick);

      if (world.tick % HUD_EVERY_TICKS === 0) {
        hudActions.setMatch(snapshot(world, controls.state));
      }

      // Пингуем раз в секунду: этого достаточно для оценки задержки
      // и не создаёт лишнего трафика.
      if (world.tick % TICKS_PER_SECOND === 0) {
        net.ping(world.tick);
      }
    },

    onRender: (world) => {
      // setMap перестраивает геометрию только при смене карты, поэтому
      // безопасно вызывать его каждый кадр.
      scene.setMap(world.map);

      const general = world.generals[LOCAL_PLAYER];
      if (general !== undefined && general.alive) {
        scene.follow({
          x: unitsToCells(general.position.x),
          y: unitsToCells(general.position.y),
        });
      }

      const state = controls.state;
      scene.render(world, LOCAL_PLAYER, {
        buildKind: state.buildKind,
        aimingNuke: state.aimingNuke,
        hoverCell: state.hoverCell,
        hoverAllowed: isHoverAllowed(world, state, occupancyOf(world)),
      });
    },

    onFps: (fps) => hudActions.setFps(fps),
  });

  const send = (command: Command): void => loop.enqueue(command);

  const at = (): { player: PlayerId; tick: ReturnType<typeof asTickNumber> } => ({
    player: LOCAL_PLAYER,
    tick: asTickNumber(loop.world.tick),
  });

  /**
   * Заказ пачки юнитов.
   *
   * Это `count` обычных команд заказа, а не одна команда «заказать пачку».
   * Ядро проверяет каждую отдельно — цену, потолок очереди, — и лишние
   * отклоняются молча. Отдельная команда потребовала бы дублировать
   * эти проверки в частичном виде.
   */
  const train = (unitType: UnitType, count: number): void => {
    for (let order = 0; order < count; order += 1) {
      send({ kind: CommandKind.TrainUnit, ...at(), unitType });
    }
  };

  const controls = attachControls(host, {
    setDirection: (direction) => send({ kind: CommandKind.MoveGeneral, ...at(), direction }),
    build: (cell, structure) => send({ kind: CommandKind.Build, ...at(), cell, structure }),
    train,
    setTarget: (cell) => send({ kind: CommandKind.SetTarget, ...at(), cell }),
    nuke: (cell) => send({ kind: CommandKind.LaunchNuke, ...at(), cell }),
    pan: (dx, dy) => scene.panBy(dx, dy),
    jumpTo: (cell) => scene.centreOnCell(cell),
    recentre: () => scene.setFollowing(true),
    cellAtScreen: (x, y) => scene.cellAtScreen(x, y),
    minimapCellAtScreen: (x, y) => scene.minimapCellAtScreen(x, y),
  });

  const publishMapInfo = (): void => {
    const { width, height } = scene.viewportSize;
    hudActions.setMapInfo(seed, visibleMapPercent(width, height), rockPercent(loop.world.map));
  };

  const restart = (): void => {
    // Тот же генератор, что и в старом управлении картой: линейный
    // конгруэнтный шаг. Он не претендует на качество — от него нужна лишь
    // непохожесть соседних seed.
    seed = (seed * 1664525 + 1013904223) >>> 0;
    opponent = createOpponent(OPPONENT_PLAYER, seed ^ 0x5bf03635);

    loop.reset(seed);
    occupancy = undefined;
    occupancyFor = undefined;

    controls.setBuildKind(null);
    controls.setAimingNuke(false);
    scene.setFollowing(true);

    publishMapInfo();
    hudActions.setMatch(snapshot(loop.world, controls.state));
  };

  setMatchCommands({
    train: (unitType, count) => train(unitType as UnitType, count),
    setBuildKind: (kind) => controls.setBuildKind(kind as StructureKindType | null),
    toggleNukeAim: () => controls.setAimingNuke(!controls.state.aimingNuke),
    buyUpgrade: (branch) => send({ kind: CommandKind.BuyUpgrade, ...at(), branch }),
    restart,
  });

  const onResize = (): void => {
    scene.resize();
    publishMapInfo();
  };
  window.addEventListener('resize', onResize);

  net.connect();
  loop.start();
  publishMapInfo();
  hudActions.setMatch(snapshot(loop.world, controls.state));

  return {
    stop() {
      window.removeEventListener('resize', onResize);
      setMatchCommands(null);
      controls.detach();
      loop.stop();
      net.disconnect();
      scene.destroy();
    },
  };
};

/**
 * Можно ли выполнить задуманное в клетке под курсором.
 *
 * Это подсказка, а не проверка правил: настоящее решение принимает ядро,
 * и оно проверяет то же самое ещё раз. Дублирование здесь осознанное —
 * подсветка обязана появиться в том же кадре, в котором двинулась мышь,
 * то есть до того, как команда куда-либо уйдёт.
 */
const isHoverAllowed = (world: WorldState, state: ControlState, occupancy: Occupancy): boolean => {
  if (state.hoverCell < 0) return false;

  const player = world.players[LOCAL_PLAYER];
  if (player === undefined) return false;

  if (state.aimingNuke) {
    if (player.energy < NUKE_COST) return false;

    const centre = cellCentre(state.hoverCell);
    return !world.structures.some(
      (structure) =>
        structure.kind === StructureKind.Base &&
        distanceSquared(centre, cellCentre(structure.cell)) < NUKE_BASE_EXCLUSION ** 2,
    );
  }

  if (state.buildKind === null) return false;

  const general = world.generals[LOCAL_PLAYER];
  if (general === undefined || !general.alive) return false;

  if (world.map.cells[state.hoverCell] !== Terrain.Ground) return false;
  if (occupancy.blocked[state.hoverCell] === 1) return false;

  // Клетка с живым юнитом или генералом — чьим угодно — под постройку
  // не годится. Проверка дублирует ядро намеренно: подсветка обязана
  // покраснеть в том же кадре, в котором курсор наехал на клетку.
  if (world.units.some((unit) => cellAt(unit.position) === state.hoverCell)) return false;
  if (world.generals.some((entry) => entry.alive && cellAt(entry.position) === state.hoverCell)) {
    return false;
  }

  const stats = playerStats(player);
  if (player.energy < stats.structures[state.buildKind].cost) return false;

  const radius = stats.general.buildRadius;
  return distanceSquared(cellCentre(state.hoverCell), general.position) <= radius * radius;
};

/** Снимок матча для HUD. Все величины уже переведены в «видимые». */
const snapshot = (world: WorldState, state: ControlState): MatchSnapshot => {
  const player = world.players[LOCAL_PLAYER];

  if (player === undefined) {
    return {
      energy: 0,
      incomePerSecond: 0,
      unitCount: 0,
      unitCap: UNIT_CAP,
      queue: [],
      unitCosts: [],
      structureCosts: [],
      nukeCost: energyToVisible(NUKE_COST),
      upgrades: [],
      targetLabel: '—',
      generalAlive: false,
      respawnInSeconds: 0,
      matchSeconds: 0,
      winner: world.winner,
      buildKind: state.buildKind,
      aimingNuke: state.aimingNuke,
    };
  }

  const stats = playerStats(player);
  const costs = upgradeCosts(player);
  const general = world.generals[LOCAL_PLAYER];
  const target = world.structures.find((structure) => structure.id === player.targetStructure);

  let unitCount = 0;
  for (const unit of world.units) {
    if (unit.owner === LOCAL_PLAYER) unitCount += 1;
  }

  const structureCosts: number[] = [];
  for (const kind of [
    StructureKind.Base,
    StructureKind.Wall,
    StructureKind.TowerBasic,
    StructureKind.TowerSniper,
  ]) {
    structureCosts[kind] = energyToVisible(stats.structures[kind].cost);
  }

  return {
    energy: energyToVisible(player.energy),
    incomePerSecond: energyToVisible(stats.incomePerTick * TICKS_PER_SECOND),
    unitCount,
    unitCap: UNIT_CAP,
    queue: [...player.queue],
    unitCosts: [0, 1, 2].map((type) => energyToVisible(stats.units[type as UnitType].cost)),
    structureCosts,
    nukeCost: energyToVisible(NUKE_COST),
    upgrades: player.upgrades.map((upgrade, index) => ({
      level: upgrade.level,
      cost: energyToVisible(costs[index] ?? 0),
      affordable: player.energy >= (costs[index] ?? Number.POSITIVE_INFINITY),
    })),
    targetLabel: target === undefined ? '—' : STRUCTURE_STATS[target.kind].label,
    generalAlive: general?.alive ?? false,
    respawnInSeconds:
      general === undefined || general.alive
        ? 0
        : Math.max(0, Math.ceil((general.respawnAtTick - world.tick) / TICKS_PER_SECOND)),
    matchSeconds: world.tick / TICKS_PER_SECOND,
    winner: world.winner,
    buildKind: state.buildKind,
    aimingNuke: state.aimingNuke,
  };
};
