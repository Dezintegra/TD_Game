import {
  AttackStance,
  BASE_BUILD_EXCLUSION,
  CHECKSUM_INTERVAL_TICKS,
  CommandKind,
  NUKE_BASE_EXCLUSION,
  NUKE_COST,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  Terrain,
  PPM_ONE,
  UNIT_CAP,
  asPlayerId,
  distanceSquared,
  energyToVisible,
  unitsToCells,
} from '@td/shared';
import type { CommandIntent, PlayerId, StructureKind as StructureKindType, UnitType } from '@td/shared';
import {
  buildOccupancy,
  cellAt,
  cellCentre,
  checksum,
  playerStats,
  rockPercent,
  structureAttack,
  structureMaxHealth,
  upgradeCosts,
} from '@td/sim';
import type { Occupancy, WorldState } from '@td/sim';
import { createMatchGuest } from '@td/netplay';
import type { GuestStatus } from '@td/netplay';
import { createRenderLoop } from './loop.js';
import { createNetClient } from './net.js';
import type { NetClient } from './net.js';
import { createScene } from './scene.js';
import { visibleMapPercent } from './iso.js';
import { EMPTY_SIDE, hudActions, setMatchCommands, setSoundCommands } from './store.js';
import type { MatchPhaseView, MatchSnapshot, SelectionView } from './store.js';
import { sidesOf } from './sides.js';
import { statRowsOf } from './stat-rows.js';
import { attachControls } from './controls.js';
import type { ControlState } from './controls.js';
import { createRejectionFeed } from './rejections.js';
import { createAudio } from '../audio/index.js';

/**
 * Сборка игры воедино: сцена, сеть, участие в матче, управление.
 *
 * Живёт вне React намеренно. React-компоненты монтируются и размонтируются
 * по своим правилам, а игра должна пережить любую перерисовку HUD,
 * включая горячую перезагрузку при разработке.
 *
 * Мир здесь больше не считается сам по себе. Его ведёт сервер, а сюда
 * приезжают кадры команд, из которых `@td/netplay` собирает две копии:
 * подтверждённую и предсказанную. Рисуется предсказанная — та, в которой
 * уже применены собственные ещё не подтверждённые действия, — поэтому
 * отклик на нажатие остаётся в том же кадре.
 *
 * Противника под управлением компьютера здесь нет и быть не может:
 * он теперь такой же участник, подключённый к серверу отдельно.
 * Играя против компьютера, клиент не отличает его от человека — и это
 * ровно то свойство, ради которого всё затевалось.
 */
export interface Game {
  stop(): void;
}

export interface GameOptions {
  /** Seed карты, выданный сервером. Приходит и в приветствии — сверяем. */
  readonly seed: number;
  /** За какую сторону играет человек. */
  readonly localPlayer: number;
  /** Билет на вход в матч. */
  readonly ticket: string;
  /**
   * «Начать заново». Матч теперь общий, поэтому перезапуск — не дело
   * игрового поля: сменить карту в одиночку нельзя, можно лишь начать
   * новый матч, а это решает сессия.
   */
  readonly onRestart?: (() => void) | undefined;
  /** Соединение отвергнуто сервером: версия протокола или билет. */
  readonly onRejected?: ((code: number) => void) | undefined;
}

const WS_URL = import.meta.env['VITE_WS_URL'] ?? 'ws://127.0.0.1:3001/game';

/**
 * Как часто снимок матча уезжает в HUD, в тиках.
 *
 * Шесть тиков — это пять обновлений в секунду. Чаще незачем: человек
 * не считывает цифры быстрее, а каждое обновление перерисовывает панели.
 */
const HUD_EVERY_TICKS = 6;

/** Как часто меряется задержка канала. */
const PING_EVERY_MS = 1000;

const PHASES: Readonly<Record<GuestStatus, MatchPhaseView>> = {
  idle: 'connecting',
  'catching-up': 'catching-up',
  playing: 'playing',
  desynced: 'desynced',
  stopped: 'stopped',
  finished: 'finished',
};

export const startGame = async (host: HTMLElement, options: GameOptions): Promise<Game> => {
  const scene = await createScene(host);

  const localPlayer: PlayerId = asPlayerId(options.localPlayer);
  const seed = options.seed;

  // Лента отказов читает подтверждённый мир, а не предсказанный.
  // Предсказание живёт несколько тиков и пересобирается на каждый кадр,
  // поэтому один и тот же отказ показался бы игроку по нескольку раз,
  // а отказ, которого на самом деле не было, — хотя бы раз.
  const rejections = createRejectionFeed(localPlayer);

  /**
   * Звук. Живёт столько же, сколько игра, и кормится в том же кадре,
   * в котором рисуется мир, — иначе он отстал бы от собственной вспышки.
   *
   * Контекст он заводит сам, по первому действию игрока: браузеры
   * запрещают звук до жеста.
   */
  const audio = createAudio();
  hudActions.setSound(audio.settings);
  setSoundCommands({
    apply: (next) => {
      audio.setSettings(next);
      hudActions.setSound(next);
    },
  });

  /**
   * Идёт ли сейчас пересборка мира.
   *
   * Пока она идёт, бой обязан молчать: восстановление проигрывает минуту
   * матча за доли секунды, и озвучивать это нельзя ни в каком виде.
   */
  let replaying = false;

  // Записи матча здесь нет намеренно. Её ведёт сервер: клиент видит матч
  // со своей стороны и не знает ни состава сторон, ни профиля
  // компьютерного участника, а в партии двух людей записывали бы оба
  // клиента — две неполные записи одного матча.

  let mapPublished = false;
  let lastHudTick = -1;
  let lastPingMs = 0;

  // Участник матча и сетевой клиент нужны друг другу: один отдаёт
  // сообщения, второй их доставляет и приносит ответы. Кольцо разорвано
  // порядком: `net` объявлен ниже, но к моменту первой отправки уже
  // создан — до подключения отправлять нечего.
  const guest = createMatchGuest({
    send: (message) => net.send(message),

    onStatus: (status) => {
      // «Играем» сразу после приветствия — это ещё не игра: пока
      // не подключился соперник, сервер не считает ни одного тика.
      // Мир при этом стоит, и неподвижная картинка без объяснения
      // читается игроком как поломка.
      const waiting = status === 'playing' && (guest.confirmed?.tick ?? 0) === 0;
      hudActions.setPhase(waiting ? 'awaiting-opponent' : (PHASES[status] ?? 'playing'));

      replaying = status === 'catching-up' || status === 'desynced' || status === 'stopped';
    },

    onFrame: (tick) => {
      if (tick === 0) hudActions.setPhase('playing');

      const confirmed = guest.confirmed;
      if (confirmed === null) return;

      hudActions.setTick(confirmed.tick);

      // Раз в секунду — свидетельство того, что мир общий. Считать сумму
      // чаще незачем: расхождение никуда не денется, а лишний обход
      // тысяч сущностей на каждом тике заметен.
      if (confirmed.tick % CHECKSUM_INTERVAL_TICKS === 0) {
        hudActions.setSync(confirmed.tick, checksum(confirmed));
      }

      // Отказы читаются на КАЖДОМ кадре, в отличие от снимка матча:
      // запись отказа живёт ровно один тик, и, пойди она через снимок,
      // до игрока доезжал бы примерно один отказ из шести.
      const notices = rejections.accept(confirmed.tick, confirmed.rejections);
      if (notices !== undefined) hudActions.setNotices(notices);
    },

    // Показания HUD снимаются здесь, а не в цикле отрисовки. Разница
    // видна там, где её не ждёшь: браузер замораживает отрисовку
    // в скрытой вкладке, а сеть продолжает идти, и снятые из отрисовки
    // цифры в такой вкладке застывают, хотя матч идёт своим чередом.
    onPredicted: (world) => {
      if (!mapPublished) {
        publishMapInfo(world);
        mapPublished = true;
      }

      const serverTick = guest.serverTick;
      hudActions.setNetwork(
        guest.delayTicks,
        guest.pendingCount,
        serverTick === 0 ? 0 : Math.min(1, (guest.confirmed?.tick ?? 0) / serverTick),
      );

      if (world.tick !== lastHudTick && world.tick % HUD_EVERY_TICKS === 0) {
        lastHudTick = world.tick;
        hudActions.setMatch(snapshot(world, localPlayer, controls.state));
        // Сведения обновляются вместе со снимком: здоровье убывает,
        // стройка и снос идут, и застывшее окно врало бы.
        hudActions.setSelection(selectionOf(world, localPlayer, controls.state.selectedCell));
      }
    },

    onOutcome: (outcome) =>
      hudActions.setOutcome({ winner: outcome.winner, reason: outcome.reason }),

    onDesync: (tick, recovering) => {
      console.warn(
        recovering
          ? `Расхождение с сервером на тике ${String(tick)}: пересобираю мир из истории`
          : `Расхождение с сервером на тике ${String(tick)} осталось после пересборки`,
      );
    },
  });

  const net: NetClient = createNetClient({
    url: WS_URL,
    ticket: options.ticket,
    onMessage: (message) => guest.receive(message),
    ...(options.onRejected === undefined ? {} : { onRejected: options.onRejected }),
  });

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

  const publishMapInfo = (world: WorldState): void => {
    const { width, height } = scene.viewportSize;
    hudActions.setMapInfo(seed, visibleMapPercent(width, height), rockPercent(world.map));
  };

  const loop = createRenderLoop({
    onFrame: () => {
      const now = performance.now();
      if (now - lastPingMs >= PING_EVERY_MS) {
        lastPingMs = now;
        net.ping(guest.confirmed?.tick ?? 0);
      }

      const world = guest.predicted;
      if (world === null) return;

      // setMap перестраивает геометрию только при смене карты, поэтому
      // безопасно вызывать его каждый кадр.
      scene.setMap(world.map);

      const general = world.generals[localPlayer];
      if (general !== undefined && general.alive) {
        scene.follow({
          x: unitsToCells(general.position.x),
          y: unitsToCells(general.position.y),
        });
      }

      const state = controls.state;
      scene.render(world, localPlayer, {
        building: state.building,
        buildKind: state.buildKind,
        aimingNuke: state.aimingNuke,
        // Наведение цели в намерение не идёт: подсветки клетки у него нет.
        // На касании наведения не существует вовсе, а мыши хватает правой
        // кнопки, которая работает и без режима.
        touch: state.touch,
        hoverCell: state.hoverCell,
        hoverAllowed: isHoverAllowed(world, localPlayer, state, occupancyOf(world)),
        selectedCell: state.selectedCell,
      });

      // Звук кормится после отрисовки и тем же миром. Слушатель —
      // центр обзора, а не генерал: игрок слушает оттуда, куда смотрит,
      // и прокрутка карты обязана уводить источники в другое ухо.
      const centre = scene.viewCentre;
      audio.frame(
        world,
        {
          cellX: centre.x,
          cellY: centre.y,
          halfWidth: scene.viewportSize.width / 2,
        },
        replaying,
      );
    },

    onFps: (fps) => hudActions.setFps(fps),
  });

  /**
   * Отдать своё действие.
   *
   * Тик не проставляется здесь намеренно: его знает только сетевой слой,
   * которому известны и задержка ввода, и номер подтверждённого тика.
   * Считать его в каждом обработчике клавиш значило бы завести пять копий
   * одной арифметики, которые рано или поздно разойдутся на единицу.
   */
  const send = (intent: CommandIntent): void => {
    guest.issue(intent);
  };

  /**
   * Заказ пачки юнитов.
   *
   * Это `count` обычных команд заказа, а не одна команда «заказать пачку».
   * Ядро проверяет каждую отдельно — цену, потолок очереди, — и лишние
   * отклоняются молча.
   */
  const train = (unitType: UnitType, count: number): void => {
    for (let order = 0; order < count; order += 1) {
      send({ kind: CommandKind.TrainUnit, unitType });
    }
  };

  const controls = attachControls(host, {
    setDirection: (direction) => send({ kind: CommandKind.MoveGeneral, direction }),
    build: (cell, structure) => send({ kind: CommandKind.Build, cell, structure }),
    train,
    setTarget: (cell) => send({ kind: CommandKind.SetTarget, cell }),
    setStance: (stance) => send({ kind: CommandKind.SetStance, stance }),
    nuke: (cell) => send({ kind: CommandKind.LaunchNuke, cell }),
    pan: (dx, dy) => scene.panBy(dx, dy),
    jumpTo: (cell) => scene.centreOnCell(cell),
    recentre: () => scene.setFollowing(true),
    toggleSound: () => {
      const next = { ...audio.settings, enabled: !audio.settings.enabled };
      audio.setSettings(next);
      hudActions.setSound(next);
    },
    // Выделение обновляется немедленно, а не со снимком матча: снимок
    // снимается раз в несколько тиков, а отклик на нажатие обязан быть
    // в том же кадре.
    select: (cell) => {
      const world = guest.predicted;
      hudActions.setSelection(world === null ? null : selectionOf(world, localPlayer, cell));
    },
    // Меню владеет управлением, а не наоборот: от него зависит, разбирать
    // ли нажатия. Сюда состояние только доносится, чтобы HUD знал,
    // что рисовать.
    menuChanged: (open) => hudActions.setMenuOpen(open),
    toggleStats: () => hudActions.toggleStats(),
    cellAtScreen: (x, y) => scene.cellAtScreen(x, y),
    minimapCellAtScreen: (x, y) => scene.minimapCellAtScreen(x, y),
  });

  setMatchCommands({
    train: (unitType, count) => train(unitType as UnitType, count),
    setBuildKind: (kind) => controls.setBuildKind(kind as StructureKindType | null),
    toggleNukeAim: () => controls.setAimingNuke(!controls.state.aimingNuke),
    toggleTargetAim: () => controls.setAimingTarget(!controls.state.aimingTarget),
    setStance: (stance) => send({ kind: CommandKind.SetStance, stance }),
    buyUpgrade: (branch) => send({ kind: CommandKind.BuyUpgrade, branch }),
    demolish: (cell) => send({ kind: CommandKind.Demolish, cell }),
    setMenuOpen: (open) => controls.setMenuOpen(open),
    toggleStats: () => hudActions.toggleStats(),

    // Перенос камеры к своему генералу или базе — по нажатию плитки
    // в тулбаре. Плитка, нажатие по которой не делает ничего, была бы
    // ловушкой: игрок нажмёт и решит, что интерфейс сломался.
    focusOwn: (what) => {
      if (what === 'general') {
        scene.setFollowing(true);
        return;
      }

      const world = guest.predicted;
      const base = world?.structures.find(
        (structure) =>
          structure.owner === localPlayer && structure.kind === StructureKind.Base,
      );

      if (base !== undefined) scene.centreOnCell(base.cell);
    },

    restart: () => options.onRestart?.(),
  });

  /**
   * Пересчёт при смене размера поля.
   *
   * Источников два, и это не перестраховка ради перестраховки.
   *
   * Наблюдатель за контейнером нужен потому, что поле теперь отступает
   * от краёв экрана на высоту полос интерфейса, а высота эта меняется
   * без участия окна. Обработчик у окна о таком изменении не узнал бы.
   *
   * Обработчик у окна оставлен потому, что наблюдатель молчит, пока
   * вкладка не рисуется: он доставляет уведомления в шаге отрисовки,
   * а в скрытой вкладке этого шага нет. Проверено — в скрытой вкладке
   * наблюдатель не срабатывает ни разу. Для игрока это безвредно (что
   * не рисуется, того он и не видит), но остаться с одним молчащим
   * источником не хочется: цена второго — три строки.
   *
   * Двойного пересчёта не выходит: работа делается, только если размер
   * действительно изменился.
   */
  let laidOutWidth = 0;
  let laidOutHeight = 0;

  const relayout = (): void => {
    const width = host.clientWidth;
    const height = host.clientHeight;

    // Нулевой размер бывает при первом срабатывании наблюдателя — оно
    // происходит сразу при подписке, ещё до того, как контейнер получил
    // высоту. Считать по нему камеру значило бы уложить мир в точку.
    if (width === 0 || height === 0) return;
    if (width === laidOutWidth && height === laidOutHeight) return;

    laidOutWidth = width;
    laidOutHeight = height;

    scene.resize();
    const world = guest.predicted;
    if (world !== null) publishMapInfo(world);
  };

  const observer = new ResizeObserver(relayout);
  observer.observe(host);
  window.addEventListener('resize', relayout);

  hudActions.setPhase('connecting');
  hudActions.setOutcome(null);
  net.connect();
  loop.start();

  return {
    stop() {
      observer.disconnect();
      window.removeEventListener('resize', relayout);
      setMatchCommands(null);
      setSoundCommands(null);
      controls.detach();
      loop.stop();
      net.disconnect();
      audio.stop();
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
 *
 * Считается по предсказанному миру: игрок целится в то, что видит,
 * а видит он предсказание.
 */
const isHoverAllowed = (
  world: WorldState,
  playerId: PlayerId,
  state: ControlState,
  occupancy: Occupancy,
): boolean => {
  if (state.hoverCell < 0) return false;

  const player = world.players[playerId];
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

  const general = world.generals[playerId];
  if (general === undefined || !general.alive) return false;

  // Кольцо вокруг баз. Величина берётся из той же константы, что и в ядре,
  // а не переписывается числом: расхождение подсветки с правилами хуже,
  // чем отсутствие подсветки вовсе.
  const hovered = cellCentre(state.hoverCell);
  if (
    world.map.baseCells.some(
      (base) => distanceSquared(hovered, cellCentre(base)) <= BASE_BUILD_EXCLUSION ** 2,
    )
  ) {
    return false;
  }

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

/**
 * Сведения о постройке в клетке — для окна сведений.
 *
 * Показывается то, что уже есть в состоянии мира, и ничего сверх. Чужие
 * постройки — наравне со своими: тумана войны в игре нет намеренно.
 *
 * Кнопка сноса не прячется при невозможности, а показывается недоступной
 * с причиной. Спрятанная кнопка оставляет игрока гадать, а причин ровно
 * три, и каждая ему что-то говорит.
 */
const selectionOf = (
  world: WorldState,
  playerId: PlayerId,
  cell: number,
): SelectionView | null => {
  if (cell < 0) return null;

  const structure = world.structures.find((entry) => entry.cell === cell);
  if (structure === undefined) return null;

  const owner = world.players[structure.owner];
  const stats = owner === undefined ? undefined : playerStats(owner);
  const baseline = stats?.structures[structure.kind];

  const own = structure.owner === playerId;
  const general = world.generals[playerId];
  const mine = world.players[playerId];

  const radius = mine === undefined ? 0 : playerStats(mine).general.buildRadius;
  const reachable =
    general !== undefined &&
    general.alive &&
    distanceSquared(cellCentre(cell), general.position) <= radius * radius;

  const isBase = structure.kind === StructureKind.Base;

  const blocked = !own
    ? 'Чужая постройка'
    : isBase
      ? 'Командный центр снести нельзя'
      : general === undefined || !general.alive
        ? 'Генерал уничтожен'
        : !reachable
          ? 'Далеко от генерала'
          : '';

  return {
    cell,
    label: STRUCTURE_STATS[structure.kind].label,
    own,
    health: structure.health,
    maxHealth:
      baseline === undefined
        ? STRUCTURE_STATS[structure.kind].health
        : structureMaxHealth(baseline, structure.growthPpm),
    growthPercent: Math.round((structure.growthPpm / PPM_ONE - 1) * 100),
    attack: baseline === undefined ? 0 : structureAttack(baseline, structure.growthPpm),
    rangeCells: baseline === undefined ? 0 : Math.round(unitsToCells(baseline.range)),
    buildingSeconds: Math.max(0, (structure.builtAtTick - world.tick) / TICKS_PER_SECOND),
    demolishSeconds:
      structure.demolishAtTick <= 0
        ? 0
        : Math.max(0, (structure.demolishAtTick - world.tick) / TICKS_PER_SECOND),
    canDemolish: blocked === '' && structure.demolishAtTick <= 0,
    demolishBlocked: blocked,
  };
};

/** Снимок матча для HUD. Все величины уже переведены в «видимые». */
const snapshot = (world: WorldState, playerId: PlayerId, state: ControlState): MatchSnapshot => {
  const player = world.players[playerId];

  if (player === undefined) {
    return {
      localPlayer: playerId,
      energy: 0,
      incomePerSecond: 0,
      unitCap: UNIT_CAP,
      sides: [EMPTY_SIDE, EMPTY_SIDE],
      unitCosts: [],
      structureCosts: [],
      nukeCost: energyToVisible(NUKE_COST),
      stats: [],
      targetLabel: '—',
      matchSeconds: 0,
      winner: world.winner,
      building: state.building,
      buildKind: state.buildKind,
      aimingNuke: state.aimingNuke,
      aimingTarget: state.aimingTarget,
      stance: AttackStance.Breakthrough,
    };
  }

  const stats = playerStats(player);
  const costs = upgradeCosts(player);
  const target = world.structures.find((structure) => structure.id === player.targetStructure);

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
    localPlayer: playerId,
    energy: energyToVisible(player.energy),
    incomePerSecond: energyToVisible(stats.incomePerTick * TICKS_PER_SECOND),
    unitCap: UNIT_CAP,
    sides: sidesOf(world),
    unitCosts: [0, 1, 2].map((type) => energyToVisible(stats.units[type as UnitType].cost)),
    structureCosts,
    nukeCost: energyToVisible(NUKE_COST),
    stats: statRowsOf(stats, costs, player.energy),
    targetLabel: target === undefined ? '—' : STRUCTURE_STATS[target.kind].label,
    matchSeconds: world.tick / TICKS_PER_SECOND,
    winner: world.winner,
    building: state.building,
    buildKind: state.buildKind,
    aimingNuke: state.aimingNuke,
    aimingTarget: state.aimingTarget,
    stance: player.stance,
  };
};
