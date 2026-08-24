import { createWriteStream, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { flatten } from '@td/shared';
import type { Command, MatchSide, ThinRecord } from '@td/shared';
import type { MatchObserver } from '@td/netplay';
import { codeVersion } from './version.js';

/**
 * Запись матчей: кто, с кем, чем и когда.
 *
 * Пишет тот, кто матч ведёт. Прежде писал браузер, и это было верно ровно
 * до тех пор, пока браузер матч и считал. Сегодня клиент знает о матче
 * меньше всех участников: компьютерная сторона стала отдельным участником
 * и своего профиля никому не сообщает, а в партии двух людей записывали бы
 * оба клиента — две неполные записи одного матча.
 *
 * ## Что попадает в файл
 *
 * Только входы: seed мира, состав сторон, версия кода, команды всех сторон
 * с номерами тиков и контрольные суммы. Состояния мира нет — оно
 * выводится из перечисленного целиком, а хранение сделало бы запись
 * на порядки больше, не добавив ни одного сведения.
 *
 * ## Почему запись асинхронная, в отличие от арены
 *
 * Писатель арены сбрасывает строки `appendFileSync`, и для безголового
 * прогона это правильно: процесс всё равно занят одним матчем.
 * Здесь цикл событий один на все идущие матчи, и синхронная запись
 * останавливала бы их все разом. Отсюда поток и сброс порциями:
 * требование «запись не задерживает рассылку кадров» иначе не выполнить.
 */

/** Сколько строк копится до сброса в поток. */
const FLUSH_EVERY = 256;

/**
 * Имя файла — только буквы, цифры и дефис.
 *
 * Не «экранируем опасные символы», а «оставляем безопасные»: перечислить
 * разрешённое надёжнее, чем угадать всё запрещённое. Переходы по каталогам,
 * двоеточия дисков и нулевые байты отсеиваются этим сами собой.
 *
 * Идентификатор матча сервер выдаёт сам, и всё же он процеживается: правило
 * «путь не составляется из данных, гуляющих по программе» стоит дешевле
 * разбирательства, откуда однажды взялся неожиданный идентификатор.
 */
export const safeName = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9-]/gu, '').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'match';
};

/**
 * Отметка запуска сервера для имён файлов.
 *
 * Нужна потому, что идентификаторы матчей — счётчик, обнуляемый при
 * перезапуске. В пределах запуска они уникальны и одновременные матчи
 * разделяют надёжно, но `m1` завтрашнего запуска — это `m1` и сегодняшнего.
 * Без отметки завтрашний матч дописался бы в хвост вчерашнего.
 *
 * Часы здесь допустимы: это сервер, а не ядро симуляции. Запрет на время
 * действует в `packages/sim`, и в имени файла симуляции ничего нет.
 */
export const runStamp = (at: Date): string => {
  const two = (value: number): string => String(value).padStart(2, '0');

  return (
    `${String(at.getFullYear())}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  );
};

/** Чем кончился матч и на каком тике. */
export interface MatchEnding {
  readonly tick: number;
  readonly winner: number | null;
  readonly reason: string;
}

export interface MatchRecording extends MatchObserver {
  /** Куда легла запись. Для журнала сервера и для тестов. */
  readonly path: string;
  /**
   * Матч кончился: дописать исход и закрыть файл.
   *
   * Исход может отсутствовать — сервер закрывается посреди матча. Тогда
   * запись просто обрывается на последнем сыгранном тике, и разбор это
   * терпит: воспроизведение кончается там, где кончилась запись.
   *
   * Возвращает обещание, потому что запись асинхронная: файл дописывается
   * не в момент вызова. Ведению матча ждать его незачем — там оно
   * отбрасывается, — а вот проверке нужно, иначе она читала бы пустоту.
   */
  close(outcome: MatchEnding | null): Promise<void>;
}

export interface OpenedMatch {
  readonly matchId: string;
  readonly seed: number;
  readonly sides: readonly MatchSide[];
}

export interface MatchRecorder {
  open(match: OpenedMatch): MatchRecording;
}

export interface RecorderOptions {
  readonly dir: string;
  /** Часы. Внедрены ради проверяемости отметки запуска. */
  readonly now?: () => Date;
}

/**
 * Открыть файл, отказавшись писать в существующий.
 *
 * Дописать в чужой файл хуже, чем упасть: два матча в одном файле
 * не разделяются никаким разбором, и обнаружится это через месяц.
 * Совпадение имени при отметке запуска в нём почти невозможно — тем
 * важнее не проглотить его молча, если оно всё-таки случилось.
 */
const openExclusive = (dir: string, base: string): { path: string; fd: number } => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = join(dir, attempt === 0 ? `${base}.jsonl` : `${base}-${String(attempt)}.jsonl`);

    try {
      return { path, fd: openSync(path, 'wx') };
    } catch {
      // Занято. Следующее имя.
    }
  }

  throw new Error(`не удалось подобрать свободное имя для записи матча в ${dir}`);
};

export const createMatchRecorder = (options: RecorderOptions): MatchRecorder => {
  const now = options.now ?? (() => new Date());
  const stamp = runStamp(now());

  // Версия кода спрашивается один раз и только при включённой записи:
  // запускать git на каждом матче незачем, а на выключенной записи —
  // тем более.
  const version = codeVersion();

  mkdirSync(options.dir, { recursive: true });

  return {
    open(match) {
      const opened = openExclusive(options.dir, `${stamp}-${safeName(match.matchId)}`);
      const stream: WriteStream = createWriteStream(opened.path, { fd: opened.fd });

      let pending: string[] = [];
      let closed = false;

      const flush = (): void => {
        if (pending.length === 0) return;

        const lines = pending;
        pending = [];
        stream.write(`${lines.join('\n')}\n`);
      };

      const write = (record: ThinRecord): void => {
        if (closed) return;

        pending.push(JSON.stringify(record));
        if (pending.length >= FLUSH_EVERY) flush();
      };

      write({
        t: 'thin',
        matchId: match.matchId,
        worldSeed: match.seed,
        sides: match.sides,
        gitSha: version.sha,
        gitDirty: version.dirty,
        startedAt: now().toISOString(),
      });

      /**
       * Начало отсчёта времени — первый посчитанный тик, а не создание
       * записи.
       *
       * Разница существенная: запись заводится, когда матч заведён,
       * а тикать он начинает, только когда подключились оба участника.
       * Между этими мгновениями лежит ожидание — секунды, а иногда
       * и десятки секунд, — и, считай мы от создания, первая же отметка
       * объявила бы матч отставшим на всё время ожидания.
       */
      let firstTickAtMs: number | undefined;

      return {
        path: opened.path,

        frame(tick, commands: readonly Command[]) {
          firstTickAtMs ??= now().getTime();

          // Пустые кадры не пишутся: тик, на котором ничего не произошло,
          // выводится из соседних, а в матче их подавляющее большинство.
          for (const command of commands) {
            const [arg0, arg1] = flatten(command);
            write({ t: 'cmd', tick, player: command.player, kind: command.kind, arg0, arg1 });
          }
        },

        checksum(tick, value) {
          // Отметка идёт рядом с суммой, а не отдельной записью: суммы
          // снимаются раз в игровую секунду, и это ровно та частота,
          // на которой видна неровность темпа. Отдельная запись стоила бы
          // второй строки в секунду и ничего бы не добавила.
          const anchor = firstTickAtMs;
          write(
            anchor === undefined
              ? { t: 'sum', tick, value }
              : { t: 'sum', tick, value, atMs: now().getTime() - anchor },
          );
        },

        close(outcome) {
          if (closed) return Promise.resolve();

          if (outcome !== null) {
            write({
              t: 'over',
              tick: outcome.tick,
              winner: outcome.winner,
              reason: outcome.reason,
            });
          }

          flush();
          closed = true;

          return new Promise((done) => {
            stream.end(() => {
              done();
            });
          });
        },
      };
    },
  };
};
