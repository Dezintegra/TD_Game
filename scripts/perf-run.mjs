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
import { dirname, join } from 'node:path';
import {
  BUSY_LIMIT,
  die,
  lockPath,
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

if (checkOnly) {
  ok('машина свободна, замерять можно');
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
const measurements = {};
if (existsSync(measurementsPath)) {
  for (const line of readFileSync(measurementsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const { name, value } = JSON.parse(line);
      measurements[name] = value;
    } catch {
      // Одна битая строка — не повод потерять остальные.
    }
  }
}

if (Object.keys(measurements).length === 0) {
  die('замер не дал ни одного числа — прогон, похоже, не дошёл до самих проверок');
}

recordEntry({ kind: 'кадры', measurements, busy, passed: run.status === 0, unit: ' к/с' });

process.exit(run.status ?? 1);
