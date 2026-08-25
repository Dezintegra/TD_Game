import {
  AI_DECISION_INTERVAL_TICKS,
  CommandKind,
  GENERAL_STATS,
  NUKE_DELAY_TICKS,
  STRUCTURE_STATS,
  StructureKind,
  TICKS_PER_SECOND,
  UNIT_STATS,
  UPGRADE_BRANCHES,
  UpgradeTarget,
} from '@td/shared';
import type { UnitType } from '@td/shared';
import { cellX, cellY } from '@td/sim';
import { profileByName } from '@td/ai';
import type { AiProfile } from '@td/ai';
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

/**
 * Горизонт «ближайшего времени» в сверке предсказания с исходом.
 *
 * Не подобран: это то же время отхода, которым пользуется сама оценка
 * риска (`escapeTicks` в `posture.ts`) — одно решение на то, чтобы
 * заметить обстрел, плюс время пересечь дальность башни на скорости
 * генерала. Сверять предсказание на другом горизонте значит спрашивать
 * формулу не о том, что она обещала.
 *
 * Берутся базовые характеристики: у сторон прокачка разная, а горизонт
 * сводки один на всю пачку.
 */
const ESCAPE_TICKS = Math.round(
  AI_DECISION_INTERVAL_TICKS +
    STRUCTURE_STATS[StructureKind.TowerBasic].range / Math.max(1, GENERAL_STATS.speed),
);

/**
 * Через сколько тиков после команды удара смотреть последствия.
 *
 * Задержка удара плюс секунда: взрыв случается не в тик команды, а спустя
 * `NUKE_DELAY_TICKS`, и снимки идут раз в секунду — без запаса можно
 * попасть на снимок, снятый до взрыва.
 */
const NUKE_AFTER_TICKS = NUKE_DELAY_TICKS + TICKS_PER_SECOND;

/** Имена целей прокачки. Берутся из самой таблицы, чтобы не разъезжались. */
const TARGET_NAME: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(UpgradeTarget).map(([name, value]) => [value, name]),
);

const percent = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';

/**
 * Профиль по имени из записи матча — или ничего.
 *
 * Молча, без исключения: в базе лежат матчи, сыгранные прежним кодом,
 * и профиль с тех пор могли переименовать или убрать. Сводка по такому
 * матчу должна печататься без заявленных весов, а не падать.
 */
const profileOf = (id: string): AiProfile | undefined => {
  try {
    return profileByName(id);
  } catch {
    return undefined;
  }
};

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

    // ── Длина накопления ────────────────────────────────────────────
    //
    // Накопление — череда решений подряд, в которых куплено ничего.
    // Интересна не каждая ступень, а вершина: докуда накопление дошло,
    // прежде чем оборвалось покупкой или пределом терпения. Предел,
    // срабатывающий на каждом накоплении, означает, что копить
    // не дают вовсе.
    const streaks = query(
      db,
      `with runs as (
         select wait_streak, impatient,
                lead(wait_streak) over (order by tick) as next
           from decision where match_id = ? and player = ?
       )
       select wait_streak as len, count(*) as n, sum(impatient) as hit
         from runs
        where wait_streak > 0 and (next is null or next < wait_streak)
        group by len order by len`,
      matchId,
      player,
    );

    if (streaks.length > 0) {
      const runs = streaks.reduce((sum, row) => sum + num(row, 'n'), 0);
      const hits = streaks.reduce((sum, row) => sum + num(row, 'hit'), 0);
      const streakPeak = Math.max(...streaks.map((row) => num(row, 'n')), 1);

      out.push('');
      out.push(`  длина накопления (накоплений ${String(runs)}, решений подряд):`);
      for (const row of streaks) {
        out.push(
          `    ${pad(num(row, 'len'), 4)} ${pad(num(row, 'n'), 5)} ` +
            `${bar(num(row, 'n'), streakPeak, 16)}` +
            `${num(row, 'hit') > 0 ? `  из них уперлось в предел ${String(num(row, 'hit'))}` : ''}`,
        );
      }
      out.push(
        `    уперлось в предел терпения: ${String(hits)} из ${String(runs)} (${percent(hits, runs)})`,
      );
    }

    // ── Заказанные юниты против объявленных профилем весов ──────────
    //
    // Профиль объявляет состав войска. Исполняется он или нет — видно
    // только рядом: сами по себе «девяносто штурмовиков» не говорят
    // ничего, а рядом с заявленными сорока четырьмя процентами говорят всё.
    //
    // Решение записывается ДО шага, команда — после, отсюда `c.tick - 1`.
    const trained = query(
      db,
      `select d.phase_index as phase, c.arg0 as unit_type, count(*) as n
         from command c
         join decision d
           on d.match_id = c.match_id and d.player = c.player and d.tick = c.tick - 1
        where c.match_id = ? and c.player = ? and c.kind = ${String(CommandKind.TrainUnit)}
          and c.accepted = 1
        group by phase, unit_type
        order by phase, unit_type`,
      matchId,
      player,
    );

    const profile = profileOf(str(match, player === 0 ? 'profile_0' : 'profile_1'));

    if (trained.length > 0) {
      out.push('');
      out.push('  заказано юнитов (фаза / тип / сколько / заявлено профилем):');

      const byPhase = new Map<number, number>();
      for (const row of trained) {
        const phase = num(row, 'phase');
        byPhase.set(phase, (byPhase.get(phase) ?? 0) + num(row, 'n'));
      }

      for (const row of trained) {
        const phase = num(row, 'phase');
        const unitType = num(row, 'unit_type') as UnitType;
        const stats = UNIT_STATS[unitType] as { label: string } | undefined;
        const total = byPhase.get(phase) ?? 0;

        const mix = profile?.phases[phase]?.mix;
        const declaredTotal =
          mix === undefined ? 0 : Object.values(mix).reduce((sum, weight) => sum + weight, 0);
        const declared =
          mix === undefined || declaredTotal <= 0
            ? '—'
            : percent(mix[unitType] ?? 0, declaredTotal);

        out.push(
          `    фаза ${pad(phase, 1)}  ${padEnd(stats?.label ?? `тип ${String(unitType)}`, 12)}` +
            ` ${pad(num(row, 'n'), 5)} ${pad(percent(num(row, 'n'), total), 7)}` +
            `   заявлено ${declared}`,
        );
      }
    }

    // ── Покупки прокачки по целям ───────────────────────────────────
    //
    // Профиль называет несколько целей. Список, из которого покупается
    // одна и та же цель, списком предпочтения не является, и увидеть это
    // можно только разложив покупки по целям.
    const upgrades = query(
      db,
      `select d.phase_index as phase, c.arg0 as branch, count(*) as n
         from command c
         join decision d
           on d.match_id = c.match_id and d.player = c.player and d.tick = c.tick - 1
        where c.match_id = ? and c.player = ? and c.kind = ${String(CommandKind.BuyUpgrade)}
          and c.accepted = 1
        group by phase, branch
        order by phase, n desc`,
      matchId,
      player,
    );

    out.push('');
    if (upgrades.length === 0) {
      out.push('  прокачка не покупалась ни разу');
    } else {
      const targets = new Map<string, number>();
      for (const row of upgrades) {
        const branch = UPGRADE_BRANCHES[num(row, 'branch')];
        const key =
          branch === undefined
            ? `ветка ${String(num(row, 'branch'))}`
            : `${TARGET_NAME[branch.target] ?? String(branch.target)} / ${branch.label}`;
        targets.set(key, (targets.get(key) ?? 0) + num(row, 'n'));
      }

      const declaredTargets = new Set<string>();
      for (const phase of profile?.phases ?? []) {
        for (const [target, weight] of Object.entries(phase.upgrades)) {
          if (weight > 0) declaredTargets.add(TARGET_NAME[Number(target)] ?? target);
        }
      }

      const bought = new Set([...targets.keys()].map((key) => key.split(' / ')[0] ?? key));

      out.push(
        `  куплено прокачки по целям (целей с ненулевым весом в профиле: ${String(declaredTargets.size)}):`,
      );
      const upgradePeak = Math.max(...targets.values(), 1);
      for (const [key, count] of [...targets.entries()].sort((a, b) => b[1] - a[1])) {
        out.push(`    ${padEnd(key, 32)} ${pad(count, 5)} ${bar(count, upgradePeak, 14)}`);
      }

      const untouched = [...declaredTargets].filter((target) => !bought.has(target));
      if (untouched.length > 0) {
        out.push(`    объявлены, но не куплены ни разу: ${untouched.join(', ')}`);
      }
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
      out.push(`    решений с отрывом меньше единицы: ${String(tiny)} из ${String(gaps.length)}`);
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

/**
 * Живучесть башен и их разброс по карте.
 *
 * Две величины, ради которых понадобилось мерило. Первая — доля
 * потерянных за матч башен: противник строит много и теряет почти всё,
 * а из одного числа «башен к концу» этого не видно, потому что оно
 * одинаково у того, кто построил четыре, и у того, кто построил
 * двенадцать и потерял восемь.
 *
 * Пик и конец, а не «построено и осталось»: часть построек — стены,
 * и смешивать их с башнями в одном счёте нельзя. Пик берётся по снимкам
 * состояния (раз в секунду), конец — по последнему снимку матча.
 *
 * Вторая — среднее расстояние между своими башнями. Нынешняя мерка места
 * считает только ЕЩЁ НЕ накрытые клетки пути, то есть прямо расталкивает
 * башни; величина показывает, насколько сильно. Считается по парам
 * башен, живым на один и тот же момент, и усредняется сначала по
 * моментам, потом по сторонам — иначе матч, в котором башен было много,
 * перевесил бы десяток матчей, где их было две.
 */
const towerLife = (db: DatabaseSync): string[] => {
  const out: string[] = [];

  const sides = query(
    db,
    `with last as (select match_id, player, max(tick) as tick from sample group by match_id, player)
     select s.match_id as match_id, s.player as player, s.towers as ending,
            (select max(towers) from sample p
              where p.match_id = s.match_id and p.player = s.player) as peak
       from sample s
       join last l on l.match_id = s.match_id and l.player = s.player and l.tick = s.tick`,
  );

  if (sides.length === 0) return out;

  const withTowers = sides.filter((row) => num(row, 'peak') > 0);
  const avg = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const peak = avg(withTowers.map((row) => num(row, 'peak')));
  const ending = avg(withTowers.map((row) => num(row, 'ending')));
  const lost = avg(
    withTowers.map((row) => (num(row, 'peak') - num(row, 'ending')) / num(row, 'peak')),
  );

  const built = query(
    db,
    `select count(*) as n from command
      where kind = ${String(CommandKind.Build)} and accepted = 1`,
  )[0];

  out.push('');
  out.push(`  башни и их потери (сторон в счёте ${String(withTowers.length)}):`);
  out.push(
    `    построек за матч на сторону ${(num(built ?? {}, 'n') / Math.max(1, sides.length)).toFixed(1)}`,
  );
  out.push(
    `    башен на пике ${peak.toFixed(1)}   к концу матча ${ending.toFixed(1)}   ` +
      `потеряно ${(lost * 100).toFixed(0)}%`,
  );

  // ── Разброс своих башен ───────────────────────────────────────────
  const towers = query(
    db,
    'select match_id, player, tick, cell from tower order by match_id, player, tick',
  );

  const perMoment: number[] = [];
  const perSide = new Map<string, number[]>();

  let key = '';
  let cells: number[] = [];

  const flush = (): void => {
    if (cells.length >= 2) {
      let sum = 0;
      let pairs = 0;

      for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
          const a = cells[i] ?? 0;
          const b = cells[j] ?? 0;
          sum += Math.hypot(cellX(a) - cellX(b), cellY(a) - cellY(b));
          pairs += 1;
        }
      }

      const mean = sum / pairs;
      perMoment.push(mean);

      const side = key.slice(0, key.lastIndexOf('|'));
      const list = perSide.get(side) ?? [];
      list.push(mean);
      perSide.set(side, list);
    }

    cells = [];
  };

  for (const row of towers) {
    const rowKey = `${str(row, 'match_id')}|${String(num(row, 'player'))}|${String(num(row, 'tick'))}`;
    if (rowKey !== key) {
      flush();
      key = rowKey;
    }
    cells.push(num(row, 'cell'));
  }
  flush();

  if (perMoment.length > 0) {
    const bySide = [...perSide.values()].map((list) => avg(list));
    out.push(
      `    среднее расстояние между своими башнями ${avg(bySide).toFixed(1)} клеток ` +
        `(моментов с двумя башнями и более: ${String(perMoment.length)})`,
    );
  } else {
    out.push('    двух башен разом на карте не было ни разу: разброс мерить не на чем');
  }

  return out;
};

/**
 * Ширина коридора, при которой место считается горлом, в клетках.
 *
 * Не подобрана. Генерация не оставляет на карте проходов уже трёх клеток
 * (§ 2.1 замысла: «проход уже трёх клеток на карте не встречается,
 * генерация заращивает такие места скалой»). Значит коридор в три клетки
 * узок настолько, насколько карта вообще позволяет, и называть горлом
 * что-то шире означало бы называть горлом обычное место.
 *
 * Величина живёт в сводке, а не в противнике, и это существенно: она
 * нужна, чтобы НАЗВАТЬ долю, а не чтобы принять решение. Сам противник
 * никакого порога узости не знает — ценность перекрытия у него обратна
 * ширине, непрерывно.
 */
const THROAT_WIDTH_CELLS = 3;

/**
 * Куда ложатся стены: в горло подхода или где придётся.
 *
 * Величина, ради которой заведена таблица `wall_site`. Стена в узком
 * месте стоит десяти стен в широком: перекрыть одну клетку из трёх —
 * треть подхода, одну из тридцати — ничего. Нынешний противник о ширине
 * коридора не знает вовсе и ставит стену рядом со своей башней, так что
 * доля показывает, сколько попаданий в горло вышло случайно.
 *
 * Рядом с долей печатается ширина: сама по себе доля не говорит, было ли
 * куда попадать. Если самое узкое место коридора в матче — девять клеток,
 * то нулевая доля означает не промах, а отсутствие горла.
 */
const wallSites = (db: DatabaseSync): string[] => {
  const out: string[] = [];

  const walls = query(db, 'select width, narrowest, on_path from wall_site');
  if (walls.length === 0) return out;

  const onPath = walls.filter((row) => num(row, 'on_path') === 1);
  const throats = walls.filter(
    (row) => num(row, 'on_path') === 1 && num(row, 'width') <= THROAT_WIDTH_CELLS,
  );

  const median = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };

  out.push('');
  out.push(`  куда ложатся стены (стен ${String(walls.length)}):`);
  out.push(
    `    ${padEnd('в коридоре вероятного пути', 30)}${pad(onPath.length, 5)} ` +
      `${pad(percent(onPath.length, walls.length), 7)}`,
  );
  out.push(
    `    ${padEnd(`в горле, не шире ${String(THROAT_WIDTH_CELLS)} клеток`, 30)}` +
      `${pad(throats.length, 5)} ${pad(percent(throats.length, walls.length), 7)}`,
  );
  out.push(
    `    ширина коридора на глубине стены: медиана ` +
      `${median(onPath.map((row) => num(row, 'width'))).toFixed(0)} клеток   ` +
      `самое узкое место коридора: медиана ` +
      `${median(walls.map((row) => num(row, 'narrowest'))).toFixed(0)}`,
  );

  return out;
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
  // Доля ничьих и средняя длительность — две величины, по которым видно,
  // попадает ли игра в проектную вилку. Доля печатается рядом со счётом:
  // «семь ничьих» без знаменателя ни о чём не говорит.
  out.push(
    `  ничьих по времени: ${String(num(totals, 'timeouts'))} ` +
      `(${percent(num(totals, 'timeouts'), num(totals, 'n'))})   ` +
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

  out.push(...towerLife(db));
  out.push(...wallSites(db));

  // ── Сверка предсказания с исходом ─────────────────────────────────
  //
  // Оценка рубежа обещает вероятность гибели генерала. Обещание проверяемо:
  // группируем решения по обещанной вероятности и смотрим, в какой доле
  // из них генерал действительно погиб за время отхода. Без этой сверки
  // всякая правка формулы риска проверяется ощущением.
  const calibration = query(
    db,
    `with picked as (
       select match_id, player, tick, death_chance from frontier where chosen = 1
     )
     select case
              when p.death_chance <= 0   then '0'
              when p.death_chance < 0.05 then '0–5%'
              when p.death_chance < 0.20 then '5–20%'
              when p.death_chance < 0.50 then '20–50%'
              else '50%+'
            end as bucket,
            count(*) as decisions,
            avg(p.death_chance) as predicted,
            sum(case when exists (
                  select 1 from sample s
                   where s.match_id = p.match_id and s.player = p.player
                     and s.tick > p.tick and s.tick <= p.tick + ${String(ESCAPE_TICKS)}
                     and s.general_alive = 0
                ) then 1 else 0 end) as died
       from picked p
      group by bucket
      order by predicted`,
  );

  const picked = calibration.reduce((sum, row) => sum + num(row, 'decisions'), 0);

  if (picked > 0) {
    const dead = query(db, `select avg(1.0 - general_alive) as share from sample`)[0];

    out.push('');
    out.push(
      `  предсказание против исхода (горизонт отхода ${String(ESCAPE_TICKS)} тиков, ` +
        `решений ${String(picked)}):`,
    );
    out.push('    обещано     решений   в среднем   погиб на деле');
    for (const row of calibration) {
      const decisions = num(row, 'decisions');
      out.push(
        `    ${padEnd(str(row, 'bucket'), 10)} ${pad(decisions, 8)}` +
          `   ${pad(`${(num(row, 'predicted') * 100).toFixed(1)}%`, 9)}` +
          `   ${pad(percent(num(row, 'died'), decisions), 13)}`,
      );
    }
    out.push(
      `    доля времени с мёртвым генералом по всем матчам: ` +
        `${(num(dead ?? {}, 'share') * 100).toFixed(1)}%`,
    );
  }

  // ── Сопровождение генерала ────────────────────────────────────────
  //
  // Признак «прикрыт» управляет тратами, и обоснование требования говорит
  // про юнитов РЯДОМ. В записи решения лежат оба числа сразу, поэтому
  // старая мерка и новая сравниваются без переигрывания матчей.
  const far = `approach_shortest > 0 and general_from_home >= 0
               and cast(general_from_home as real) / approach_shortest > 0.5`;

  const escort = query(
    db,
    `select count(*) as decisions,
            sum(case when live_units > 0 then 1 else 0 end) as by_live,
            sum(case when live_units > 0 and nearby_units = 0 then 1 else 0 end) as live_but_alone,
            sum(case when nearby_units > 0 then 1 else 0 end) as by_nearby,
            avg(nearby_units) as avg_nearby,
            avg(live_units) as avg_live
       from decision where ${far}`,
  )[0];

  if (escort !== undefined && num(escort, 'decisions') > 0) {
    const byLive = num(escort, 'by_live');

    out.push('');
    out.push(
      `  сопровождение генерала на дальнем рубеже (решений ${String(num(escort, 'decisions'))}):`,
    );
    out.push(
      `    живые юниты есть где угодно: ${pad(byLive, 6)}   ` +
        `из них рядом с генералом никого: ${percent(num(escort, 'live_but_alone'), byLive)}`,
    );
    out.push(`    свои юниты есть рядом:       ${pad(num(escort, 'by_nearby'), 6)}`);
    out.push(
      `    своих рядом в среднем ${num(escort, 'avg_nearby').toFixed(2)}, ` +
        `всего живых ${num(escort, 'avg_live').toFixed(2)}`,
    );
  }

  // ── Последствия ядерного удара ────────────────────────────────────
  //
  // Взрыв не разбирает, чьё накрыл. Считаем по снимкам до и после: разность
  // числа живых и построек у обеих сторон. Величина приблизительная — в то же
  // окно попадает и обычный бой, — но систематической ошибки в ней нет,
  // и до и после правки она считается одинаково.
  const nukes = query(
    db,
    `with strike as (
       select c.match_id, c.player, c.tick,
              (select s.tick from sample s
                where s.match_id = c.match_id and s.player = c.player and s.tick <= c.tick
                order by s.tick desc limit 1) as before_tick,
              (select s.tick from sample s
                where s.match_id = c.match_id and s.player = c.player
                  and s.tick >= c.tick + ${String(NUKE_AFTER_TICKS)}
                order by s.tick asc limit 1) as after_tick
         from command c
        where c.kind = ${String(CommandKind.LaunchNuke)} and c.accepted = 1
     )
     select count(*) as strikes,
            avg(foe.units_alive - foe_after.units_alive) as foe_units,
            avg(mine.units_alive - mine_after.units_alive) as own_units,
            avg(mine.structures - mine_after.structures) as own_structures,
            sum(case when mine.general_alive = 1 and mine_after.general_alive = 0
                     then 1 else 0 end) as own_generals
       from strike k
       join sample mine on mine.match_id = k.match_id and mine.player = k.player
                       and mine.tick = k.before_tick
       join sample mine_after on mine_after.match_id = k.match_id and mine_after.player = k.player
                             and mine_after.tick = k.after_tick
       join sample foe on foe.match_id = k.match_id and foe.player <> k.player
                      and foe.tick = k.before_tick
       join sample foe_after on foe_after.match_id = k.match_id and foe_after.player <> k.player
                            and foe_after.tick = k.after_tick`,
  )[0];

  const strikes = nukes === undefined ? 0 : num(nukes, 'strikes');

  out.push('');
  if (strikes === 0) {
    out.push('  ядерных ударов в пачке не было');
  } else {
    out.push(`  последствия ядерного удара (принятых ударов ${String(strikes)}, на удар):`);
    out.push(`    чужих юнитов          ${num(nukes ?? {}, 'foe_units').toFixed(2)}`);
    out.push(`    своих юнитов          ${num(nukes ?? {}, 'own_units').toFixed(2)}`);
    out.push(`    своих построек        ${num(nukes ?? {}, 'own_structures').toFixed(2)}`);
    out.push(
      `    своих генералов       ${String(num(nukes ?? {}, 'own_generals'))} ` +
        `на ${String(strikes)} ударов`,
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
