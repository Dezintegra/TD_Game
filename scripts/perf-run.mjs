#!/usr/bin/env node
/**
 * Замер частоты кадров.
 *
 *   pnpm e2e:perf                   замерить
 *   pnpm e2e:perf -- --check-only   только сказать, свободна ли машина
 *   pnpm e2e:perf -- --force        мерить, не глядя на занятость
 *   pnpm e2e:perf -- --history      показать прошлые замеры
 *
 * Зачем обёртка. Замер частоты кадров говорит о загрузке машины не меньше,
 * чем о коде: 22.08.2026 при пяти рабочих потоках выходило 45–51 кадра
 * при пороге 55, а те же тесты в одиночку проходили. Над репозиторием
 * одновременно работают несколько сессий в разных рабочих деревьях, каждая
 * со своими серверами и браузерами, — то есть «занята» здесь состояние
 * обычное, а не исключительное.
 *
 * Поэтому перед замером проверяется обстановка, а после замера числа
 * попадают в общий журнал: одинокая цифра говорит куда меньше, чем та же
 * цифра рядом с прошлой и с пометкой, при какой загрузке она снята.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import {
  BUSY_LIMIT,
  die,
  lockPath,
  note,
  ok,
  printHistory,
  recordEntry,
  repoRoot,
  requireQuietMachine,
  step,
  warn,
} from './perf-common.mjs';

// ── Ключи ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const own = new Set(['--check-only', '--force', '--history']);
const checkOnly = argv.includes('--check-only');
const force = argv.includes('--force');
const passthrough = argv.filter((it) => !own.has(it));

if (argv.includes('--history')) {
  printHistory();
  process.exit(0);
}

// Сырой вывод замера — свой у каждого дерева: это промежуточный файл
// одного прогона, и делить его не с кем.
const measurementsPath = join(repoRoot, 'test-results', 'perf-measurements.jsonl');

// ── Проверка обстановки ──────────────────────────────────────────────
step('Смотрю, свободна ли машина');
const busy = await requireQuietMachine({ force });

/**
 * Свободен ли порт.
 *
 * Спрашивается не у списка соединений, а у самой системы: пробуем занять
 * порт и смотрим, пустят ли. Так ответ не зависит ни от прав на чужие
 * процессы, ни от того, каким инструментом их перечислять.
 */
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });

/**
 * Порты замера обязаны быть свободны, и это не придирка к аккуратности.
 *
 * Замер поднимает свои клиент и сервер и никогда не цепляется к чужим
 * (`playwright.perf.config.ts`). Занятый порт означает, что рядом живёт
 * чужой сервер — из другого дерева или просто забытый с утра, — и без
 * этой проверки Playwright упал бы на невнятном «порт занят» посреди
 * прогона.
 *
 * Ключ `--force` сюда НЕ распространяется, и разница принципиальна.
 * Занятая машина портит цифру: она становится хуже, но остаётся про этот
 * код. Чужой сервер подменяет предмет: цифра выходит правдоподобная,
 * только относится к другому дереву. Первое можно осознанно перетерпеть,
 * второе — нельзя ни при каких обстоятельствах.
 */
step('Смотрю, свободны ли порты');
const clientPort = Number(process.env['CLIENT_PORT'] ?? 5173);
const serverPort = Number(process.env['PORT'] ?? 3001);
const taken = [];
if (!(await portFree(clientPort))) taken.push(`клиентский ${clientPort} (CLIENT_PORT)`);
if (!(await portFree(serverPort))) taken.push(`серверный ${serverPort} (PORT)`);

if (taken.length > 0) {
  die(
    [
      `порты замера заняты: ${taken.join(', ')}`,
      '',
      '  Замер поднимает свои клиент и сервер и к чужим не цепляется:',
      '  подхваченный сервер отдал бы цифру про чужое дерево, и узнать',
      '  об этом было бы неоткуда. 24.08.2026 так и вышло — сравнение',
      '  «до и после» дважды измерило одну и ту же сборку.',
      '',
      '  Погасите чужой сервер либо возьмите свои порты:',
      '      CLIENT_PORT=5199 PORT=3055 pnpm e2e:perf',
    ].join('\n'),
  );
}
note(`порты свободны: клиентский ${clientPort}, серверный ${serverPort}`);

if (checkOnly) {
  ok('машина свободна и порты свободны, замерять можно');
  process.exit(0);
}

// ── Замок и прогон ───────────────────────────────────────────────────
writeFileSync(
  lockPath,
  JSON.stringify({ pid: process.pid, started: new Date().toISOString(), worktree: repoRoot }),
);

// Замок снимается при любом исходе, включая Ctrl+C: брошенный файл
// заблокировал бы соседние деревья на четверть часа впустую.
const release = () => {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Уже удалён — значит цель достигнута.
  }
};
process.on('exit', release);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    release();
    process.exit(130);
  });
}

step('Замеряю частоту кадров');
if (force && busy > BUSY_LIMIT) warn('машина занята, к цифре относитесь как к оценке');

// Файл замеров чистится перед прогоном: иначе к свежим числам примешались бы
// прошлые, а отличить их было бы нечем.
mkdirSync(dirname(measurementsPath), { recursive: true });
rmSync(measurementsPath, { force: true });

const run = spawnSync(
  'pnpm',
  ['exec', 'playwright', 'test', '--config', 'playwright.perf.config.ts', ...passthrough],
  {
    stdio: 'inherit',
    shell: true,
    cwd: repoRoot,
    env: { ...process.env, PERF_OUT: measurementsPath },
  },
);

// ── Журнал ───────────────────────────────────────────────────────────
//
// Обстановка складывается по сценам, а не сливается в одну. Сцены —
// это разные окна разного матча: у «камеры в движении» свой ход мира
// и свои длинные кадры, у «войск на поле» — свои. Одно усреднённое
// число спрятало бы ровно тот случай, ради которого всё затевалось:
// одна сцена измерена на догоне, вторая на ровном ходу.
const measurements = {};
const context = {};
if (existsSync(measurementsPath)) {
  for (const line of readFileSync(measurementsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line);
      measurements[entry.name] = entry.value;
      if (entry.context !== undefined && entry.context !== null) {
        context[entry.name] = entry.context;
      }
    } catch {
      // Одна битая строка — не повод потерять остальные.
    }
  }
}

if (Object.keys(measurements).length === 0) {
  die('замер не дал ни одного числа — прогон, похоже, не дошёл до самих проверок');
}

recordEntry({
  kind: 'кадры',
  measurements,
  context,
  busy,
  passed: run.status === 0,
  unit: ' к/с',
});

process.exit(run.status ?? 1);
