import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TICKS_PER_SECOND, flatten, sameAction, unflatten } from '@td/shared';
import type { Command, ThinHeader, ThinRecord } from '@td/shared';
import { createLogWriter } from './log.js';
import { runMatch } from './match.js';
import { stripBom } from './ingest.js';

/**
 * Воспроизведение записанного матча.
 *
 * Мир ведут записанные команды обеих сторон, а компьютерные стороны
 * думают рядом с миром: получают то же состояние, что видели в матче,
 * и пишут в лог свои решения. Ради решений всё и затевается — состояние
 * мира показывает, что случилось, и не показывает, чего противник хотел.
 *
 * Отсюда же две сверки вместо одной. Мир воспроизведён из записанных
 * команд, поэтому контрольные суммы совпадут по построению и доказывают
 * теперь только неизменность правил игры. Неизменность противника
 * доказывает совпадение восстановленных им команд с записанными —
 * и ничто другое.
 */

/** Откуда запись и на чём сыграна — хвост любого сообщения о расхождении. */
const madeOn = (header: ThinHeader): string =>
  `Запись сделана на ${header.gitSha === '' ? 'неизвестной версии' : header.gitSha.slice(0, 8)}` +
  `${header.gitDirty ? ', дерево было грязным' : ''}.`;

const shownAs = (command: Command): string => {
  const [arg0, arg1] = flatten(command);
  return `вид ${String(command.kind)}, аргументы ${String(arg0)}/${String(arg1)}`;
};

export interface ReplayResult {
  /** Куда лёг подробный лог. */
  readonly logPath: string;
  readonly matchId: string;
  readonly ticks: number;
  /** Сколько контрольных сумм сверено. */
  readonly checksums: number;
  /** Сколько команд компьютера сверено. */
  readonly commands: number;
  /** Какие стороны были компьютерными. */
  readonly computerSides: readonly number[];
}

export const replay = (path: string, logDir: string): ReplayResult => {
  const records = stripBom(readFileSync(path, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line): ThinRecord[] => {
      try {
        return [JSON.parse(line) as ThinRecord];
      } catch {
        // Оборванный хвост прерванной записи. Годные строки от этого
        // годными быть не перестали.
        return [];
      }
    });

  const header = records.find((record) => record.t === 'thin');
  if (header === undefined) throw new Error(`в файле ${path} нет заголовка записи`);

  const scripted = new Map<number, Command[]>();
  /** Записанные команды каждой стороны по порядку — для сверки. */
  const recordedByPlayer = new Map<number, Command[]>();

  for (const record of records) {
    if (record.t !== 'cmd') continue;

    const command = unflatten(record);
    if (command === undefined) {
      // Молча пропустить нельзя. Пропуск даёт расхождение, которое
      // выглядит как изменение правил игры, и ищут его потом не там.
      // Ровно так потерялись Demolish и SetStance.
      throw new Error(
        `в записи команда неизвестного вида ${String(record.kind)} на тике ${String(record.tick)}. ` +
          'Воспроизвести её нечем: скорее всего, вид команды добавлен позже записи ' +
          'и не описан в packages/shared/src/matchlog.ts.',
      );
    }

    const bucket = scripted.get(record.tick) ?? [];
    bucket.push(command);
    scripted.set(record.tick, bucket);

    const own = recordedByPlayer.get(record.player) ?? [];
    own.push(command);
    recordedByPlayer.set(record.player, own);
  }

  const expected = new Map<number, number>();
  for (const record of records) {
    if (record.t === 'sum') expected.set(record.tick, record.value);
  }

  const matchId = `${header.matchId}-replay`;
  const logPath = join(logDir, `${matchId}.jsonl`);
  const log = createLogWriter(logPath);

  // Воспроизведение кончается там, где кончилась запись.
  //
  // Продолжать дальше технически можно — противник детерминирован
  // и доиграл бы сам, — но это было бы враньём: получилось бы «что было
  // бы, если бы человек бросил играть», выданное за запись матча.
  const recorded = Math.max(0, ...expected.keys(), ...scripted.keys());

  const computerSides = header.sides.flatMap((side, index) =>
    side.who === 'computer' ? [index] : [],
  );

  const result = runMatch({
    matchId,
    worldSeed: header.worldSeed,
    aiSeeds: header.sides.map((side) => (side.who === 'computer' ? side.seed : 0)),
    // Человеческой стороне профиля нет и быть не может. Строка «human»
    // стоит здесь ради базы, где столбец профиля читается человеком;
    // `profileByName` её не увидит — противники заводятся только
    // для перечисленных ниже сторон.
    profiles: header.sides.map((side) => (side.who === 'computer' ? side.profile : 'human')),
    log,
    scripted,
    tickCap: recorded,
    computerPlayers: [],
    verifiedPlayers: computerSides,
  });

  /**
   * Разбор не должен пережить расхождение: он был бы разбором выдумки.
   *
   * Тип у переменной проставлен явно, а не выведен: без него TypeScript
   * не считает вызов обрывающим поток и не сужает типы после него.
   */
  const refuse: (message: string) => never = (message) => {
    rmSync(logPath, { force: true });
    throw new Error(message);
  };

  // Сверка первая: мир. Она ловит изменение правил игры.
  for (const [tick, value] of expected) {
    const got = result.checksums.get(tick);
    if (got === undefined) continue;

    if (got !== value) {
      refuse(
        `воспроизведение разошлось с записью на тике ${String(tick)}: ` +
          `ожидалось ${String(value)}, получено ${String(got)}. ` +
          `Скорее всего, изменились правила игры. ${madeOn(header)}`,
      );
    }
  }

  // Сверка вторая: решения компьютера.
  let checked = 0;
  for (const player of computerSides) {
    const want = recordedByPlayer.get(player) ?? [];
    const got = result.recovered.get(player) ?? [];

    for (let index = 0; index < want.length; index += 1) {
      const wanted = want[index];
      const gotten = got[index];
      if (wanted === undefined) continue;

      if (gotten === undefined) {
        refuse(
          `компьютер стороны ${String(player)} отдал меньше команд, чем записано: ` +
            `ожидалась ${String(index + 1)}-я (${shownAs(wanted)}, тик ${String(wanted.tick)}), ` +
            `а он остановился на ${String(got.length)}. ` +
            `Скорее всего, изменилось его устройство. ${madeOn(header)}`,
        );
      }

      if (!sameAction(wanted, gotten)) {
        refuse(
          `компьютер стороны ${String(player)} принял другое решение: ` +
            `на тике ${String(wanted.tick)} записана команда «${shownAs(wanted)}», ` +
            `а восстановлена «${shownAs(gotten)}» (${String(index + 1)}-я по счёту). ` +
            `Скорее всего, изменилось его устройство. ${madeOn(header)}`,
        );
      }

      checked += 1;
    }

    // Хвост восстановленных команд сверх записанных расхождением
    // не считается: команда исполняется через входную задержку, и решения
    // последних тиков просто не успели попасть в запись — исполниться им
    // было уже негде.
  }

  return {
    logPath,
    matchId,
    ticks: result.ticks,
    checksums: expected.size,
    commands: checked,
    computerSides,
  };
};

/** Та же работа, но с отчётом человеку. Зовётся из командной строки. */
export const replayAndReport = (path: string, logDir: string): void => {
  const result = replay(path, logDir);

  process.stdout.write(
    `${result.matchId}: воспроизведено, сверено ${String(result.checksums)} контрольных сумм ` +
      `и ${String(result.commands)} команд компьютера ` +
      `(${result.computerSides.length === 0 ? 'сторон компьютера нет' : `сторон: ${String(result.computerSides.length)}`}), ` +
      `${String(Math.round(result.ticks / TICKS_PER_SECOND))} с игры\n`,
  );
};
