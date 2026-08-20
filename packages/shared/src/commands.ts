import type { PlayerId, TickNumber } from './branded.js';
import type { StructureKind, UnitType } from './balance.js';

/**
 * Команды игрока — единственное, что меняет мир.
 *
 * Состояние мира по сети не пересылается: и клиент, и сервер вычисляют его
 * сами из одинакового начального состояния и одинакового потока команд.
 * Поэтому трафик измеряется байтами на тик, а не килобайтами.
 *
 * Из того же правила следует и менее очевидное: противник под управлением
 * компьютера тоже отдаёт команды и ничем не отличается от человека
 * с точки зрения ядра. Ни одна сущность не имеет права менять мир в обход
 * этого списка.
 *
 * Позиции передаются индексом клетки, а не координатами с фиксированной
 * точкой. Клетка — это два байта вместо восьми, и вдобавок она не может
 * оказаться «между» клетками, то есть исчезает целый класс проверок.
 */
export const CommandKind = {
  /** Задать генералу направление движения. */
  MoveGeneral: 0,
  /** Построить стену или башню в клетке. */
  Build: 1,
  /** Заказать юнита на базе. */
  TrainUnit: 2,
  /** Назначить общую цель атаки для всех своих юнитов. */
  SetTarget: 3,
  /** Купить уровень прокачки. */
  BuyUpgrade: 4,
  /** Нанести ядерный удар по клетке. */
  LaunchNuke: 5,
} as const;

export type CommandKind = (typeof CommandKind)[keyof typeof CommandKind];

interface CommandBase {
  readonly player: PlayerId;
  /** Тик, на котором команда должна примениться в симуляции. */
  readonly tick: TickNumber;
}

export interface MoveGeneralCommand extends CommandBase {
  readonly kind: typeof CommandKind.MoveGeneral;
  /** Индекс направления, ноль — остановка. См. direction.ts. */
  readonly direction: number;
}

export interface BuildCommand extends CommandBase {
  readonly kind: typeof CommandKind.Build;
  /** Индекс клетки карты. */
  readonly cell: number;
  readonly structure: StructureKind;
}

export interface TrainUnitCommand extends CommandBase {
  readonly kind: typeof CommandKind.TrainUnit;
  readonly unitType: UnitType;
}

export interface SetTargetCommand extends CommandBase {
  readonly kind: typeof CommandKind.SetTarget;
  /** Клетка, в которой стоит вражеская постройка или база. */
  readonly cell: number;
}

export interface BuyUpgradeCommand extends CommandBase {
  readonly kind: typeof CommandKind.BuyUpgrade;
  /** Индекс ветки в таблице UPGRADE_BRANCHES. */
  readonly branch: number;
}

export interface LaunchNukeCommand extends CommandBase {
  readonly kind: typeof CommandKind.LaunchNuke;
  readonly cell: number;
}

export type Command =
  | MoveGeneralCommand
  | BuildCommand
  | TrainUnitCommand
  | SetTargetCommand
  | BuyUpgradeCommand
  | LaunchNukeCommand;

/**
 * Почему команда не была применена.
 *
 * Отказ — штатная ситуация, а не авария: команда приходит от игрока,
 * который нажал не туда, или от противника под управлением компьютера,
 * который не угадал. Ядро на такую команду не падает, а сообщает причину.
 *
 * Перечисление, а не строка. Строку нельзя перевести на другой язык,
 * по ней нельзя сгруппировать при разборе матча, и она незаметно
 * расходится с кодом. Живёт рядом с `CommandKind`, потому что порождает
 * причины ядро, а читают и ядро, и интерфейс.
 *
 * Правило одно: одна проверка — одна причина. Если две проверки требуют
 * от игрока разных действий, сливать их в общую причину нельзя, даже
 * когда с точки зрения кода они соседние строки.
 */
export const RejectReason = {
  /** Энергии меньше цены. */
  NotEnoughEnergy: 0,
  /** Клетка перекрыта рельефом или уже стоящей постройкой. */
  CellBlocked: 1,
  /** В клетке живой юнит или генерал — чей угодно, включая своего. */
  CellOccupiedByLiving: 2,
  /** Клетка дальше радиуса строительства от собственного генерала. */
  OutsideBuildRadius: 3,
  /** Очередь производства заполнена доверху. */
  QueueFull: 4,
  /** Генерал мёртв: строить и двигаться некому. */
  GeneralDead: 5,
  /** Точка удара в запретной зоне вокруг чьей-то базы. */
  NukeNearBase: 6,
  /** Клетки с таким номером на карте не существует. */
  InvalidCell: 7,
  /** Цель своя, либо в клетке нет постройки. */
  InvalidTarget: 8,
  /** Направление, тип юнита или ветка прокачки вне допустимого диапазона. */
  InvalidArgument: 9,
  /** Матч окончен: мир замер и команд больше не принимает. */
  MatchOver: 10,
} as const;

export type RejectReason = (typeof RejectReason)[keyof typeof RejectReason];
