import {
  RejectReason,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_STATS,
  UnitType,
  UpgradeTarget,
} from '@td/shared';

/**
 * Подписи для HUD.
 *
 * Названия сущностей берутся из таблицы баланса, а не дублируются здесь:
 * там они уже есть, и две копии одного названия неизбежно разойдутся.
 * Здесь остаётся только то, чего в балансе нет, — заголовки групп
 * прокачки и подсказки по управлению.
 */

export const unitLabel = (type: UnitType): string => UNIT_STATS[type]?.label ?? '—';

export const structureLabel = (kind: StructureKind): string => STRUCTURE_STATS[kind]?.label ?? '—';

/** Короткие подписи для кнопок: полные названия в узкую кнопку не влезают. */
export const UNIT_SHORT: Readonly<Record<UnitType, string>> = {
  [UnitType.Assault]: 'Штурм',
  [UnitType.Sniper]: 'Снайпер',
  [UnitType.Grenadier]: 'Гранат',
};

export const STRUCTURE_SHORT: Readonly<Record<StructureKind, string>> = {
  [StructureKind.Base]: 'База',
  [StructureKind.Wall]: 'Стена',
  [StructureKind.TowerBasic]: 'Башня',
  [StructureKind.TowerSniper]: 'Снайп. башня',
};

export const UPGRADE_GROUP: Readonly<Record<UpgradeTarget, string>> = {
  [UpgradeTarget.UnitAssault]: 'Штурмовик',
  [UpgradeTarget.UnitSniper]: 'Снайпер',
  [UpgradeTarget.UnitGrenadier]: 'Гранатомётчик',
  [UpgradeTarget.TowerBasic]: 'Башня',
  [UpgradeTarget.TowerSniper]: 'Снайперская башня',
  [UpgradeTarget.Wall]: 'Стена',
  [UpgradeTarget.General]: 'Генерал',
  [UpgradeTarget.Economy]: 'Экономика',
};

/**
 * Почему действие не прошло — словами.
 *
 * Пишется от лица игрока и в повелительном наклонении там, где есть что
 * делать: он читает эту строку боковым зрением посреди боя, и «нужно
 * подойти ближе» действует, а «нарушено ограничение радиуса
 * строительства» — нет.
 *
 * Причины различаются не для полноты, а потому что действия разные.
 * «Клетка занята» означает «целься в другое место», «в клетке техника» —
 * «подожди пару секунд». Слить их в общее «сюда нельзя» значило бы
 * отнять у игрока подсказку и оставить одно раздражение.
 */
export const REJECT_LABEL: Readonly<Record<RejectReason, string>> = {
  [RejectReason.NotEnoughEnergy]: 'Не хватает энергии',
  [RejectReason.CellBlocked]: 'Клетка занята',
  [RejectReason.CellOccupiedByLiving]: 'В клетке техника — подождите',
  [RejectReason.OutsideBuildRadius]: 'Далеко от генерала — подойдите ближе',
  [RejectReason.QueueFull]: 'Очередь производства заполнена',
  [RejectReason.GeneralDead]: 'Генерал уничтожен',
  [RejectReason.NukeNearBase]: 'Слишком близко к базе',
  [RejectReason.InvalidCell]: 'Мимо карты',
  [RejectReason.InvalidTarget]: 'Целью может быть только чужая постройка',
  [RejectReason.InvalidArgument]: 'Так нельзя',
  [RejectReason.MatchOver]: 'Матч окончен',
};

export interface Hotkey {
  readonly keys: string;
  readonly what: string;
}

/**
 * Подсказки по управлению.
 *
 * Держатся на экране постоянно, а не прячутся в меню помощи: игра
 * с полной информацией и десятком горячих клавиш требует, чтобы игрок
 * не тратил внимание на вспоминание.
 */
export const HOTKEYS: readonly Hotkey[] = [
  { keys: 'WASD', what: 'движение генерала' },
  { keys: '1 2 3', what: 'заказать юнита' },
  // Ctrl+цифра браузер оставляет себе — это переключение вкладок,
  // и перехватить его со страницы нельзя. Поэтому у пакета два модификатора:
  // Ctrl работает по кнопке панели, Shift — и по кнопке, и с клавиатуры.
  { keys: 'Ctrl / Shift', what: 'заказать сразу десять' },
  { keys: 'Q E R', what: 'стена, башня, снайперская' },
  { keys: 'F', what: 'ядерный удар' },
  { keys: 'ЛКМ', what: 'поставить выбранное' },
  { keys: 'ПКМ', what: 'назначить цель атаки' },
  { keys: 'Пробел', what: 'камера к генералу' },
  { keys: 'Esc', what: 'отменить режим' },
];
