import { asPlayerId, asTickNumber } from './branded.js';
import type { PlayerId, TickNumber } from './branded.js';
import { CommandKind } from './commands.js';
import type { Command } from './commands.js';
import type { StructureKind, UnitType } from './balance.js';

/**
 * Формат тонкой записи матча — общий для того, кто пишет, и того, кто читает.
 *
 * Пишет запись игровой сервер, читает её арена, а приложения друг друга
 * не импортируют. Значит, у формата остаётся ровно одно допустимое место —
 * здесь: `@td/shared` доступен обоим и не зависит ни от чего.
 *
 * ## Почему это важнее, чем кажется
 *
 * Преобразование «команда — три числа» было написано трижды: в записи
 * клиента, в логе арены и обратное — в воспроизведении. Два первых
 * перечисляли все восемь видов команд, третье — шесть: `Demolish`
 * и `SetStance` в нём забыли. Забыть было легко, потому что у него была
 * ветка `default`, вежливо отвечавшая «не знаю такой».
 *
 * Расплата вышла несоразмерной: воспроизведение молча теряло команду
 * и расходилось с записью, а сообщение об ошибке указывало на изменение
 * правил игры — то есть на совершенно не то место.
 *
 * Поэтому обратное преобразование здесь написано таблицей с проверкой
 * полноты на этапе компиляции, а не `switch` с `default`. Появится
 * девятый вид команды — не соберётся сборка, и произойдёт это в тот же
 * день, когда вид добавили, а не через месяц при разборе матча.
 *
 * ## Что в записи есть и чего в ней нет
 *
 * Есть входы: seed мира, состав сторон, версия кода и команды всех сторон
 * с номерами тиков. Состояния мира нет — оно полностью выводится
 * из перечисленного, а хранение сделало бы запись на порядки больше,
 * не добавив ни одного сведения.
 */

/**
 * Кем занята сторона. Для компьютера — ещё и чем именно он думал.
 *
 * Живёт здесь, а не в записи: состав сторон знает тот, кто сводит игроков
 * за стол, и он же передаёт его дальше — записи, разбору и всем прочим.
 * Пустой список профилей и нулевые seed, которые писал клиент, были хуже
 * отсутствия поля: они выглядели достоверными.
 */
export type MatchSide =
  | { readonly who: 'human' }
  | {
      readonly who: 'computer';
      /** Идентификатор профиля: по нему воспроизведение соберёт того же противника. */
      readonly profile: string;
      /** Seed решений. Отличается от seed мира: манера игры не привязана к карте. */
      readonly seed: number;
    };

/** Сторона, занятая компьютером: тем, кому нужен именно этот случай. */
export type ComputerSide = Extract<MatchSide, { who: 'computer' }>;

/** Заголовок записи. Первая строка файла. */
export interface ThinHeader {
  readonly t: 'thin';
  readonly matchId: string;
  readonly worldSeed: number;
  /** Стороны по порядку: индекс — номер стороны в симуляции. */
  readonly sides: readonly MatchSide[];
  readonly gitSha: string;
  readonly gitDirty: boolean;
  readonly startedAt: string;
}

/**
 * Команда, исполненная на тике.
 *
 * Записывается тик ИСПОЛНЕНИЯ, а не тик, в который команду отдали:
 * ведущий матча знает только первый. Разница не нулевая — между ними
 * лежит входная задержка, — и для воспроизведения нужен именно тик
 * исполнения: по нему команда подаётся в мир.
 */
export interface ThinCommand {
  readonly t: 'cmd';
  readonly tick: number;
  readonly player: number;
  readonly kind: number;
  /** Аргументы в порядке объявления вида команды. Смысл зависит от вида. */
  readonly arg0: number;
  readonly arg1: number;
}

/**
 * Контрольная сумма мира на тике.
 *
 * Запись бесполезна, если воспроизведение молча разойдётся с оригиналом:
 * разбирать будут выдуманный матч.
 */
export interface ThinChecksum {
  readonly t: 'sum';
  readonly tick: number;
  readonly value: number;
  /**
   * Сколько миллисекунд реального времени прошло от начала матча.
   *
   * Запись без этого поля безвременна по построению: в ней есть номера
   * тиков и нет ни одной отметки часов, — и восстановить по ней **темп**
   * матча невозможно. Видно, что случилось, и не видно, вовремя ли.
   *
   * Ряд «ожидалось 1000 мс, прошло 1180» показывает всю неровность
   * без всякого хранилища метрик: суммы снимаются раз в игровую секунду,
   * значит и отметки идут раз в секунду.
   *
   * Необязательное: записи, снятые раньше, обязаны читаться по-прежнему,
   * а воспроизведение обязано идти и без отметок. На воспроизведение
   * поле не влияет вовсе — мир восстанавливается из seed и команд,
   * а время говорит о том, как матч шёл, а не о том, что в нём
   * произошло.
   */
  readonly atMs?: number;
}

/** Исход матча. Последняя строка файла. */
export interface ThinOutcome {
  readonly t: 'over';
  readonly tick: number;
  readonly winner: number | null;
  readonly reason: string;
}

export type ThinRecord = ThinHeader | ThinCommand | ThinChecksum | ThinOutcome;

/**
 * Команда в плоский вид: два числа.
 *
 * Ветки `default` нет намеренно — новый вид команды обязан сломать сборку
 * здесь, а не тихо превратиться в пару нулей.
 */
export const flatten = (command: Command): readonly [number, number] => {
  switch (command.kind) {
    case CommandKind.MoveGeneral:
      return [command.direction, 0];
    case CommandKind.Build:
      return [command.cell, command.structure];
    case CommandKind.TrainUnit:
      return [command.unitType, 0];
    case CommandKind.SetTarget:
      return [command.cell, 0];
    case CommandKind.BuyUpgrade:
      return [command.branch, 0];
    case CommandKind.LaunchNuke:
      return [command.cell, 0];
    case CommandKind.Demolish:
      return [command.cell, 0];
    case CommandKind.SetStance:
      return [command.stance, 0];
  }
};

interface CommandBase {
  readonly player: PlayerId;
  readonly tick: TickNumber;
}

type Builder = (base: CommandBase, arg0: number, arg1: number) => Command;

/**
 * Сборка команды обратно из плоского вида.
 *
 * `satisfies Record<CommandKind, Builder>` — не украшение. Он требует
 * запись для КАЖДОГО вида команды, и пропуск обнаруживается сборкой,
 * а не расхождением воспроизведения через месяц.
 *
 * Приведения `as` при аргументах осознанные: числа пришли из файла,
 * то есть из недоверенного источника, и верить им нельзя. Проверит их
 * ядро — оно всё равно проверяет каждую команду и негодную отклонит
 * с причиной. Здесь же задача одна: не потерять команду молча.
 */
const BUILDERS = {
  [CommandKind.MoveGeneral]: (base, arg0) => ({
    ...base,
    kind: CommandKind.MoveGeneral,
    direction: arg0,
  }),
  [CommandKind.Build]: (base, arg0, arg1) => ({
    ...base,
    kind: CommandKind.Build,
    cell: arg0,
    structure: arg1 as StructureKind,
  }),
  [CommandKind.TrainUnit]: (base, arg0) => ({
    ...base,
    kind: CommandKind.TrainUnit,
    unitType: arg0 as UnitType,
  }),
  [CommandKind.SetTarget]: (base, arg0) => ({ ...base, kind: CommandKind.SetTarget, cell: arg0 }),
  [CommandKind.BuyUpgrade]: (base, arg0) => ({
    ...base,
    kind: CommandKind.BuyUpgrade,
    branch: arg0,
  }),
  [CommandKind.LaunchNuke]: (base, arg0) => ({ ...base, kind: CommandKind.LaunchNuke, cell: arg0 }),
  [CommandKind.Demolish]: (base, arg0) => ({ ...base, kind: CommandKind.Demolish, cell: arg0 }),
  [CommandKind.SetStance]: (base, arg0) => ({ ...base, kind: CommandKind.SetStance, stance: arg0 }),
} satisfies Record<CommandKind, Builder>;

/**
 * Плоский вид обратно в команду.
 *
 * Возвращает `undefined` для неизвестного вида, а не бросает исключение
 * и не пропускает молча. Решать, что с этим делать, — дело читающего:
 * воспроизведение обязано остановиться, потому что пропуск команды даёт
 * расхождение, причину которого потом не найти.
 */
export const unflatten = (record: ThinCommand): Command | undefined => {
  const build = (BUILDERS as Partial<Record<number, Builder>>)[record.kind];
  if (build === undefined) return undefined;

  return build(
    { player: asPlayerId(record.player), tick: asTickNumber(record.tick) },
    record.arg0,
    record.arg1,
  );
};

/** Совпадают ли команды по существу: вид и аргументы. Сторона и тик не в счёт. */
export const sameAction = (left: Command, right: Command): boolean => {
  if (left.kind !== right.kind) return false;

  const [leftArg0, leftArg1] = flatten(left);
  const [rightArg0, rightArg1] = flatten(right);

  return leftArg0 === rightArg0 && leftArg1 === rightArg1;
};
