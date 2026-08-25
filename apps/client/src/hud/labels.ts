import {
  RejectReason,
  STRUCTURE_STATS,
  StructureKind,
  UNIT_STATS,
  UnitType,
  UpgradeStat,
  UpgradeTarget,
} from '@td/shared';
import { CONTROL_LAYOUT } from '../game/controls.js';

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
  [UnitType.Tesla]: 'Тесла',
};

export const STRUCTURE_SHORT: Readonly<Record<StructureKind, string>> = {
  [StructureKind.Base]: 'База',
  [StructureKind.Wall]: 'Стена',
  [StructureKind.TowerBasic]: 'Башня',
  [StructureKind.TowerSniper]: 'Снайп. башня',
};

/**
 * Названия плиток тулбара — по цели прокачки.
 *
 * Цель 7 называется «База», а не «Экономика». Группы без объекта на поле
 * больше нет: по игровому замыслу энергию начисляет база, и ветка добычи
 * принадлежит ей.
 */
export const UPGRADE_GROUP: Readonly<Record<UpgradeTarget, string>> = {
  [UpgradeTarget.UnitAssault]: 'Штурмовик',
  [UpgradeTarget.UnitSniper]: 'Снайпер',
  [UpgradeTarget.UnitTesla]: 'Тесла',
  [UpgradeTarget.TowerBasic]: 'Башня',
  [UpgradeTarget.TowerSniper]: 'Снайперская башня',
  [UpgradeTarget.Wall]: 'Стена',
  [UpgradeTarget.General]: 'Генерал',
  [UpgradeTarget.Base]: 'База',
};

/**
 * В чём измеряется характеристика — для строки под плиткой.
 *
 * Единица пишется рядом с числом, а не подразумевается: «дальность 6»
 * без «кл» читается то ли клетками, то ли внутренними единицами,
 * а решение о покупке принимается по величине.
 */
/**
 * Короткие подписи характеристик — для строк под плиткой.
 *
 * Полные названия из таблицы веток («Скорострельность», «Радиус стройки»)
 * в столбец не помещаются: плиток девять, и каждая лишняя дюжина точек
 * на строке выталкивает тулбар за край экрана на ноутбуке.
 *
 * Сокращения общепринятые и читаются без обучения; там, где сокращать
 * нечего, стоит полное слово.
 */
export const UPGRADE_STAT_SHORT: Readonly<Record<UpgradeStat, string>> = {
  [UpgradeStat.Attack]: 'атака',
  [UpgradeStat.Health]: 'прочн.',
  [UpgradeStat.FireRate]: 'темп',
  [UpgradeStat.Range]: 'дальн.',
  [UpgradeStat.Speed]: 'скор.',
  [UpgradeStat.BuildRadius]: 'радиус',
  [UpgradeStat.RespawnTime]: 'возрожд.',
  [UpgradeStat.Income]: 'добыча',
  [UpgradeStat.NukeDamage]: 'мощн.',
  [UpgradeStat.NukeRadius]: 'радиус',
  [UpgradeStat.NukeCooldown]: 'откат',
};

export const UPGRADE_UNIT: Readonly<Record<UpgradeStat, string>> = {
  [UpgradeStat.Attack]: '',
  [UpgradeStat.Health]: '',
  [UpgradeStat.FireRate]: '/с',
  [UpgradeStat.Range]: ' кл',
  [UpgradeStat.Speed]: ' кл/с',
  [UpgradeStat.BuildRadius]: ' кл',
  [UpgradeStat.RespawnTime]: ' с',
  [UpgradeStat.Income]: '/с',
  [UpgradeStat.NukeDamage]: '',
  [UpgradeStat.NukeRadius]: ' кл',
  [UpgradeStat.NukeCooldown]: ' с',
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
  // Про очередь игроку больше не сообщается: её убрали с экрана, потому
  // что очередью в прежнем смысле она быть перестала. Сообщать об отказе
  // словом, которого в интерфейсе нет, значит объяснять непонятное через
  // неизвестное. Отказ этот приходит, когда выводить войска некуда —
  // упёрлись в потолок численности либо вокруг базы нет свободной клетки, —
  // и сказано ровно это.
  [RejectReason.QueueFull]: 'Некуда выводить войска — подождите',
  [RejectReason.GeneralDead]: 'Генерал уничтожен',
  [RejectReason.NukeNearBase]: 'Слишком близко к базе',
  [RejectReason.InvalidCell]: 'Мимо карты',
  [RejectReason.InvalidTarget]: 'Целью может быть только чужая постройка',
  [RejectReason.InvalidArgument]: 'Так нельзя',
  [RejectReason.MatchOver]: 'Матч окончен',
  // Отличается от «Клетка занята» намеренно: там надо целиться в другое
  // место, здесь — отойти от базы. И от одноимённого запрета для удара
  // отличается словом «строить»: правила разные, и путать их нельзя.
  [RejectReason.TooCloseToBase]: 'Вплотную к базе строить нельзя — отойдите',
  // Отдельно от «Так нельзя»: игрок целился осмысленно — это его
  // постройка, она рядом, генерал жив, — и отказ пришёл по особому правилу.
  [RejectReason.CannotDemolishBase]: 'Командный центр снести нельзя',
  // Не «Так нельзя»: ветка существует, команда осмысленна, и отказ
  // пришёл по игровому правилу. Игроку сказано, что делать дальше, —
  // вкладывать в другое.
  [RejectReason.UpgradeMaxed]: 'Предельный уровень — вложите в другое',
  // Отдельно от «Не хватает энергии», и разница для игрока
  // принципиальная: там надо копить, здесь — ждать. Кошелёк при этом
  // может быть полон.
  [RejectReason.NukeOnCooldown]: 'Установка не остыла — подождите',
};

/**
 * Подсказки по управлению.
 *
 * Не свой список, а та же таблица, по которой разбираются нажатия.
 * Два независимых перечня разошлись бы при первой же правке раскладки,
 * и игрок читал бы подсказку, которая врёт, — а врущая подсказка выглядит
 * достоверной, и сверять её нечем.
 *
 * Живут в меню матча, а не постоянно на экране: нужны они раз за партию,
 * а место занимали весь матч.
 */
export const HOTKEYS = CONTROL_LAYOUT;
