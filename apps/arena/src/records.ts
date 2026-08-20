import type { AttemptNote, AttemptResult, DecisionRecord } from '@td/ai';

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
  | MatchHeader
  | MatchFooter
  | SampleRecord
  | CommandRecord
  | DecisionLogRecord;

// ─────────────────────────────────────────────────────────────────────────
// Тонкая запись матча человека
// ─────────────────────────────────────────────────────────────────────────

/**
 * Записывается браузером и содержит только то, из чего матч
 * воспроизводится: seed, версию кода и команды человека с номерами тиков.
 *
 * Состояние мира сюда не входит: оно полностью выводится из
 * перечисленного, а его хранение сделало бы запись на порядки больше
 * без единого дополнительного сведения. Подробности — решения, оценки
 * рубежей, отказы — арена восстанавливает, прогоняя матч заново.
 *
 * Отсюда и название: пятьдесят килобайт против пяти мегабайт подробного
 * лога.
 */
export interface ThinHeader {
  readonly t: 'thin';
  readonly matchId: string;
  readonly worldSeed: number;
  readonly aiSeeds: readonly number[];
  readonly profiles: readonly string[];
  readonly gitSha: string;
  readonly gitDirty: boolean;
  readonly startedAt: string;
  /** За кого играл человек: его команды и записаны. */
  readonly humanPlayer: number;
}

export interface ThinCommand {
  readonly t: 'cmd';
  readonly tick: number;
  readonly player: number;
  readonly kind: number;
  readonly arg0: number;
  readonly arg1: number;
}

/**
 * Контрольная сумма мира на тике.
 *
 * Тонкая запись бесполезна, если воспроизведение молча разойдётся
 * с оригиналом: разбирать будут выдуманный матч. Суммы снимаются
 * с постоянным шагом, и воспроизведение обязано их сверять.
 */
export interface ThinChecksum {
  readonly t: 'sum';
  readonly tick: number;
  readonly value: number;
}

export type ThinRecord = ThinHeader | ThinCommand | ThinChecksum;
