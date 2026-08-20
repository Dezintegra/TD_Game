import { TICKS_PER_SECOND } from '@td/shared';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Сводка по матчу и по пачке матчей.
 *
 * Сводка **приводит величины и не выносит суждений**. Различие
 * не педантичное: инструмент, который сам решает, что хорошо и что плохо,
 * незаметно начинает измерять то, что подтверждает его представление
 * о хорошем. Вывод из чисел — работа человека, читающего сводку.
 *
 * Объём — десятки строк. Полмиллиона строк лога глазами не читаются,
 * и если сводка не помещается на экран целиком, она не выполнила
 * свою задачу: её роль — указать минуту, на которую стоит посмотреть
 * запросом.
 */

const seconds = (ticks: number): string => {
  const total = Math.round(ticks / TICKS_PER_SECOND);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
};

const bar = (value: number, max: number, width = 24): string => {
  if (max <= 0) return '';
  return '█'.repeat(Math.max(0, Math.round((value / max) * width)));
};

const pad = (value: string | number, width: number): string => String(value).padStart(width);

const padEnd = (value: string | number, width: number): string => String(value).padEnd(width);

type Row = Record<string, unknown>;

const num = (row: Row, key: string): number => Number(row[key] ?? 0);
const str = (row: Row, key: string): string => String(row[key] ?? '');

const query = (db: DatabaseSync, sql: string, ...params: (string | number)[]): Row[] =>
  db.prepare(sql).all(...params) as Row[];

/** Доли пути, по которым раскладывается путь генерала. */
const BUCKETS = 10;

export const reportMatch = (db: DatabaseSync, matchId: string): string => {
  const out: string[] = [];

  const match = query(db, 'select * from match where match_id = ?', matchId)[0];
  if (match === undefined) return `матч «${matchId}» в базе не найден`;

  out.push(`# матч ${matchId}`);
  out.push(
    `  seed ${pad(num(match, 'world_seed'), 10)}   ` +
      `профили ${str(match, 'profile_0')} против ${str(match, 'profile_1')}`,
  );
  out.push(
    `  исход: ${str(match, 'end_reason')}   ` +
      `победитель: ${match['winner'] === null ? 'нет' : String(match['winner'])}   ` +
      `длительность ${seconds(num(match, 'ticks'))}   ` +
      `счёт занял ${(num(match, 'wall_ms') / 1000).toFixed(1)} с`,
  );
  out.push(
    `  код ${str(match, 'git_sha').slice(0, 8)}${num(match, 'git_dirty') === 1 ? ' (дерево грязное)' : ''}`,
  );

  const players = query(
    db,
    'select distinct player from decision where match_id = ? order by player',
    matchId,
  ).map((row) => num(row, 'player'));

  for (const player of players) {
    out.push('');
    out.push(`## игрок ${String(player)}`);

    // ── Путь генерала по долям вероятного пути ──────────────────────
    const path = query(
      db,
      `select general_from_home as d, approach_shortest as total
         from decision
        where match_id = ? and player = ? and general_from_home >= 0 and approach_shortest > 0`,
      matchId,
      player,
    );

    const spread = new Array<number>(BUCKETS).fill(0);
    let furthest = 0;
    for (const row of path) {
      const fraction = num(row, 'd') / num(row, 'total');
      furthest = Math.max(furthest, fraction);
      const slot = Math.min(BUCKETS - 1, Math.max(0, Math.floor(fraction * BUCKETS)));
      spread[slot] = (spread[slot] ?? 0) + 1;
    }

    const peak = Math.max(...spread, 1);
    out.push(`  где стоял генерал (доля пути к чужой базе, решений):`);
    spread.forEach((count, index) => {
      const from = (index / BUCKETS).toFixed(1);
      const to = ((index + 1) / BUCKETS).toFixed(1);
      out.push(`    ${from}–${to}  ${pad(count, 5)} ${bar(count, peak)}`);
    });
    out.push(`    дальше всего заходил: ${furthest.toFixed(3)} пути`);

    // ── Ведомость трат по фазам ─────────────────────────────────────
    const spending = query(
      db,
      `select d.phase_index as phase, a.spending as what, a.result as result, count(*) as n
         from attempt a
         join decision d
           on d.match_id = a.match_id and d.tick = a.tick and d.player = a.player
        where a.match_id = ? and a.player = ?
        group by phase, what, result
        order by phase, what, result`,
      matchId,
      player,
    );

    out.push('');
    out.push('  попытки потратить энергию (фаза / на что / исход):');
    for (const row of spending) {
      out.push(
        `    фаза ${pad(num(row, 'phase'), 1)}  ${padEnd(str(row, 'what'), 8)} ` +
          `${padEnd(str(row, 'result'), 7)} ${pad(num(row, 'n'), 5)}`,
      );
    }

    // ── Что помешало ────────────────────────────────────────────────
    const blocked = query(
      db,
      `select note, count(*) as n
         from attempt
        where match_id = ? and player = ? and note is not null
        group by note
        order by n desc`,
      matchId,
      player,
    );

    const blockedPeak = Math.max(...blocked.map((row) => num(row, 'n')), 1);
    out.push('');
    out.push('  что помешало покупке:');
    for (const row of blocked) {
      out.push(
        `    ${padEnd(str(row, 'note'), 24)} ${pad(num(row, 'n'), 5)} ` +
          `${bar(num(row, 'n'), blockedPeak, 16)}`,
      );
    }

    // ── Отрыв выбранного рубежа от следующего ───────────────────────
    const gaps = query(
      db,
      `select max(case when chosen = 1 then score end) -
              max(case when chosen = 0 then score end) as gap
         from frontier
        where match_id = ? and player = ?
        group by tick
       having gap is not null`,
      matchId,
      player,
    ).map((row) => num(row, 'gap'));

    if (gaps.length > 0) {
      const sorted = [...gaps].sort((a, b) => a - b);
      const at = (share: number): number => sorted[Math.floor(sorted.length * share)] ?? 0;
      const tiny = gaps.filter((gap) => Math.abs(gap) < 1).length;

      out.push('');
      out.push('  отрыв выбранного рубежа от следующего по оценке:');
      out.push(
        `    медиана ${at(0.5).toFixed(1)}   ` +
          `нижние 10% ${at(0.1).toFixed(1)}   верхние 10% ${at(0.9).toFixed(1)}`,
      );
      out.push(
        `    решений с отрывом меньше единицы: ${String(tiny)} из ${String(gaps.length)}`,
      );
    }

    // ── Отклонённые команды ─────────────────────────────────────────
    const refused = query(
      db,
      `select reject_reason as reason, count(*) as n
         from command
        where match_id = ? and player = ? and accepted = 0
        group by reason order by n desc`,
      matchId,
      player,
    );

    out.push('');
    if (refused.length === 0) {
      out.push('  отклонённых команд нет');
    } else {
      out.push('  отклонённые команды (код причины / сколько):');
      for (const row of refused) {
        out.push(`    ${pad(num(row, 'reason'), 3)} ${pad(num(row, 'n'), 6)}`);
      }
    }
  }

  return out.join('\n');
};

export const reportBatch = (db: DatabaseSync): string => {
  const out: string[] = [];

  const totals = query(
    db,
    `select count(*) as n,
            sum(case when end_reason = 'timeout' then 1 else 0 end) as timeouts,
            avg(ticks) as avg_ticks,
            avg(wall_ms) as avg_wall
       from match`,
  )[0];

  if (totals === undefined || num(totals, 'n') === 0) return 'в базе нет матчей';

  out.push('# пачка матчей');
  out.push(`  всего ${String(num(totals, 'n'))}`);
  out.push(
    `  ничьих по времени: ${String(num(totals, 'timeouts'))}   ` +
      `средняя длительность ${seconds(num(totals, 'avg_ticks'))}   ` +
      `средний счёт ${(num(totals, 'avg_wall') / 1000).toFixed(1)} с`,
  );

  // Победы по профилям. Профиль победителя определяется его номером:
  // нулевой игрок играет profile_0, первый — profile_1.
  const byProfile = query(
    db,
    `select profile, sum(won) as wins, sum(played) as played from (
       select profile_0 as profile,
              case when winner = 0 then 1 else 0 end as won, 1 as played from match
       union all
       select profile_1 as profile,
              case when winner = 1 then 1 else 0 end as won, 1 as played from match
     ) group by profile order by wins desc`,
  );

  out.push('');
  out.push('  победы по профилям:');
  for (const row of byProfile) {
    const played = num(row, 'played');
    const wins = num(row, 'wins');
    out.push(
      `    ${padEnd(str(row, 'profile'), 22)} ${pad(wins, 4)} из ${pad(played, 4)}` +
        `   ${played > 0 ? ((wins / played) * 100).toFixed(0) : '0'}%`,
    );
  }

  // Как далеко заходили генералы. Разброс важнее среднего: если половина
  // матчей упирается в свою половину карты, среднее это скроет.
  const reach = query(
    db,
    `select match_id, player, max(cast(general_from_home as real) / approach_shortest) as furthest
       from decision
      where approach_shortest > 0 and general_from_home >= 0
      group by match_id, player`,
  ).map((row) => num(row, 'furthest'));

  if (reach.length > 0) {
    const sorted = [...reach].sort((a, b) => a - b);
    const at = (share: number): number => sorted[Math.floor(sorted.length * share)] ?? 0;

    out.push('');
    out.push('  дальше всего заходил генерал (доля пути):');
    out.push(
      `    минимум ${at(0).toFixed(2)}   медиана ${at(0.5).toFixed(2)}   ` +
        `максимум ${(sorted[sorted.length - 1] ?? 0).toFixed(2)}`,
    );
  }

  const versions = query(
    db,
    `select substr(git_sha, 1, 8) as sha, git_dirty as dirty, count(*) as n
       from match group by sha, dirty order by n desc`,
  );

  out.push('');
  out.push('  версии кода:');
  for (const row of versions) {
    out.push(
      `    ${padEnd(str(row, 'sha'), 10)} ${pad(num(row, 'n'), 4)} матчей` +
        `${num(row, 'dirty') === 1 ? '   (дерево грязное — прогон невоспроизводим)' : ''}`,
    );
  }

  return out.join('\n');
};
