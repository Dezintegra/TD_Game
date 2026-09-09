import type { AttemptNote, AttemptResult, DecisionRecord } from '@td/ai';
import type { RuleTuning } from '@td/shared';
import type { CombatObservation } from '@td/sim';

export type AssaultTraceRecord = CombatObservation extends infer E
  ? E extends CombatObservation
    ? E & { readonly t: E['type'] }
    : never
  : never;
export interface AssaultTowerRecord {
  readonly t: 'assault-tower';
  readonly tick: number;
  readonly sequence: number;
  readonly id: number;
  readonly owner: number;
  readonly event: 'appeared' | 'ready' | 'removed';
}

/**
 * Строки лога.
 *
 * Формат — JSONL: одна запись в строке, файл дописывается. Выбран
 * не от бедности. База данных потребовала бы решить схему заранее,
 * а первые же разборы покажут, что половина столбцов не нужна, а трёх
 * недостаёт. JSONL позволяет пересобрать базу из тех же логов, не переигрывая
 * матчи; заодно он читается грепом, что незаменимо, когда непонятно даже,
 * что искать.
 *
 * Поле `t` — вид записи. Короткое, потому что повторяется в каждой строке
 * сотни тысяч раз; остальные имена полей читаемые, потому что их читают
 * люди.
 */

/** Заголовок матча. Первая строка файла. */
export interface MatchHeader {
  readonly tuning?: Readonly<RuleTuning>;
  readonly effectiveAssaultRange?: number;
  readonly traceVersion?: number;
  readonly traceEnabled?: boolean;
  readonly tickRate?: number;
  readonly tickCap?: number;
  readonly t: 'match';
  readonly matchId: string;
  readonly kind: 'arena' | 'replay';
  readonly worldSeed: number;
  readonly aiSeeds: readonly number[];
  readonly profiles: readonly string[];
  /**
   * Версия кода и признак незакоммиченных изменений.
   *
   * Без них сравнение «до правки / после правки» превращается в гадание,
   * какой половиной матчей какая версия сыграна. Признак грязного дерева
   * важен отдельно: прогон на незакоммиченном коде воспроизвести нельзя,
   * и знать об этом надо сразу, а не через месяц.
   */
  readonly gitSha: string;
  readonly gitDirty: boolean;
  readonly startedAt: string;
}

/** Итог матча. Последняя строка файла. */
export interface MatchFooter {
  readonly t: 'end';
  readonly ticks: number;
  readonly winner: number | null;
  /** Почему матч кончился. Ничья по времени — полноценный исход. */
  readonly endReason: 'base-destroyed' | 'timeout';
  readonly wallMs: number;
}

/** Состояние стороны на момент времени. Снимается раз в игровую секунду. */
export interface SampleRecord {
  readonly readyTowers?: number;
  readonly underConstructionTowers?: number;
  readonly t: 'sample';
  readonly tick: number;
  readonly player: number;
  readonly energy: number;
  readonly incomePerTick: number;
  readonly unitsAlive: number;
  readonly structures: number;
  readonly towers: number;
  readonly walls: number;
  readonly baseHp: number;
  readonly generalCell: number;
  readonly generalHp: number;
  readonly generalAlive: boolean;
  readonly queueLen: number;
  readonly upgradeTotalLevel: number;
  readonly targetStructure: number;
  /**
   * Есть ли у войск стороны путь от своей базы к чужой по проходимым
   * клеткам.
   *
   * Своя постройка непроходима, и ломать своё юнит не станет
   * (`navigation.ts`), поэтому перекрывший коридор запирает собственную
   * армию. В мире это не оставляет никакого следа: юниты просто перестают
   * доходить, и со стороны выглядит, будто их перебили по дороге.
   *
   * Признак одинаков у обеих сторон — занятость не различает владельцев, —
   * но пишется по стороне: вопрос-то про её войска.
   */
  readonly pathToEnemy: boolean;
}

/**
 * Клетки живых башен стороны. Снимаются реже состояния — раз в десять
 * игровых секунд, см. `TOWERS_EVERY`.
 *
 * Клетки, а не готовый разброс: в базе живут факты, а не выводы
 * (см. `schema.ts`). Среднее расстояние между башнями — вывод, и считает
 * его сводка; из клеток же можно спросить и другое — например, сбились ли
 * башни в кучу у одного горла или растянулись вдоль всего коридора.
 *
 * Стены сюда не идут: они не стреляют, и вопрос о взаимном прикрытии
 * к ним не относится.
 */
export interface TowersRecord {
  readonly t: 'towers';
  readonly tick: number;
  readonly player: number;
  readonly cells: readonly number[];
}

/**
 * Место, куда легла стена, вместе с геометрией подхода на тот момент.
 *
 * Записывается при постройке, а не считается потом: коридор подхода
 * зависит от расстановки скал И построек, и через минуту он уже другой.
 * Восстановить его по базе нельзя — мира в базе нет.
 *
 * Здесь лежат факты (глубина, ширина, самое узкое место коридора),
 * а не вывод «стена в горле»: что считать горлом, решает сводка,
 * и решение это можно передумать, не переигрывая матчей.
 */
export interface WallSiteRecord {
  readonly t: 'wallsite';
  readonly tick: number;
  readonly player: number;
  readonly cell: number;
  /** Глубина клетки от своей базы по проходимым клеткам. −1 — недостижима. */
  readonly depth: number;
  /** Ширина коридора на этой глубине, в клетках. Ноль — клетка вне коридора. */
  readonly width: number;
  /** Самое узкое место коридора на тот момент. Есть с чем сравнить ширину. */
  readonly narrowest: number;
  /** Лежит ли клетка в коридоре вероятного пути. */
  readonly onPath: boolean;
}

export interface CommandRecord {
  readonly t: 'command';
  readonly tick: number;
  readonly player: number;
  readonly kind: number;
  /** Аргументы команды в порядке объявления. Смысл зависит от вида. */
  readonly arg0: number;
  readonly arg1: number;
  readonly accepted: boolean;
  /** Причина отказа, если команда отклонена. */
  readonly rejectReason: number | null;
}

/** Решение противника: то, чего в мире не видно. */
export interface DecisionLogRecord extends Omit<DecisionRecord, 'attempts' | 'frontiers'> {
  readonly t: 'decision';
  readonly attempts: readonly {
    readonly spending: string;
    readonly result: AttemptResult;
    readonly note?: AttemptNote;
    /** Цена желаемого: без неё «коплю» не говорит, на что именно. */
    readonly price?: number;
  }[];
  readonly frontiers: readonly {
    readonly fraction: number;
    readonly cell: number;
    readonly coverage: number;
    readonly gain: number;
    readonly risk: number;
    readonly score: number;
    readonly deathChance: number;
    readonly chosen: boolean;
  }[];
}

export type LogRecord =
  | AssaultTraceRecord
  | AssaultTowerRecord
  | MatchHeader
  | MatchFooter
  | SampleRecord
  | TowersRecord
  | WallSiteRecord
  | CommandRecord
  | DecisionLogRecord;

// Тонкая запись матча живёт не здесь, а в `@td/shared`: пишет её игровой
// сервер, читает арена, и приложения друг друга не импортируют. См.
// `packages/shared/src/matchlog.ts` — там же лежит и преобразование
// команды в плоский вид, общее для записи и чтения.
