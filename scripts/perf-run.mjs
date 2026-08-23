#!/usr/bin/env node
/**
 * Запуск замеров частоты кадров.
 *
 *   pnpm e2e:perf                   замерить
 *   pnpm e2e:perf -- --check-only   только сказать, свободна ли машина
 *   pnpm e2e:perf -- --force        мерить, не глядя на занятость
 *
 * Зачем обёртка. Замер частоты кадров говорит о загрузке машины не меньше,
 * чем о коде: 22.08.2026 при пяти рабочих потоках выходило 45–51 кадра
 * при пороге 55, а те же тесты в одиночку проходили. Над репозиторием
 * одновременно работают несколько сессий в разных рабочих деревьях, каждая
 * со своими серверами и браузерами, — то есть «занята» здесь состояние
 * обычное, а не исключительное.
 *
 * Поэтому перед замером проверяются две вещи: не ведёт ли замер кто-то
 * ещё (общий на все деревья файл-замок) и не занята ли машина вообще
 * (доля занятости процессора). Красный замер на занятой машине хуже
 * отсутствия замера: ему верят и идут искать несуществующую просадку.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// ── Ключи ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check-only');
const force = argv.includes('--force');
const passthrough = argv.filter((it) => it !== '--check-only' && it !== '--force');

// Доля занятости процессора, выше которой замер бессмыслен. Порог мягкий
// намеренно: он ловит «рядом идёт сборка или чужой прогон», а не «система
// чем-то дышит». Точное значение подобрано замером на этой машине.
const BUSY_LIMIT = 0.35;

// Через сколько замок считается брошенным. Замер идёт около полуминуты,
// так что четверть часа — это уже наверняка забытый файл после падения.
const LOCK_STALE_MS = 15 * 60 * 1000;

// Управляющий символ собран из кода, а не записан в исходник байтом:
// байт теряется при копировании и его любят портить редакторы.
const ESC = String.fromCharCode(27);

const step = (text) => console.log(`\n${ESC}[36m▸${ESC}[0m ${text}`);
const note = (text) => console.log(`  ${text}`);
const die = (text) => {
  console.error(`\n${ESC}[31m✗${ESC}[0m ${text}\n`);
  process.exit(1);
};

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// ── Где живёт замок ──────────────────────────────────────────────────
//
// Замок обязан быть ОДИН на все рабочие деревья: процессор у них общий,
// и два замера одновременно испортят оба. `--git-common-dir` и в основном
// дереве, и в дополнительном указывает на один и тот же каталог `.git`
// основного дерева — его родитель и есть общий корень.
const repoRoot = git('rev-parse', '--show-toplevel');
const mainTree = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
const lockPath = join(mainTree, '.perf-lock');

/** Жив ли процесс. EPERM означает «есть, но чужой», то есть жив. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Кто сейчас меряет, или null. Битый замок считается отсутствующим. */
const currentHolder = () => {
  if (!existsSync(lockPath)) return null;

  let held;
  try {
    held = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }

  const age = Date.now() - Date.parse(held.started);
  if (!Number.isFinite(age) || age > LOCK_STALE_MS) return null;
  if (!alive(held.pid)) return null;

  return { ...held, age };
};

/** Доля занятости процессора за окно в ms, от 0 до 1. */
const busyShare = async (ms) => {
  const snapshot = () => {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus()) {
      const t = cpu.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  };

  const before = snapshot();
  await sleep(ms);
  const after = snapshot();

  const total = after.total - before.total;
  if (total <= 0) return 0;
  return 1 - (after.idle - before.idle) / total;
};

// ── Проверка обстановки ──────────────────────────────────────────────
step('Смотрю, свободна ли машина');

const holder = currentHolder();
if (holder) {
  const minutes = Math.round(holder.age / 60000);
  die(
    [
      'замер уже идёт в другом рабочем дереве:',
      `    дерево:  ${holder.worktree}`,
      `    процесс: ${holder.pid}, начат ${minutes} мин. назад`,
      '',
      '  Два замера одновременно испортят оба. Дождитесь окончания',
      `  или, если тот прогон точно умер, удалите ${lockPath}`,
    ].join('\n'),
  );
}

const busy = await busyShare(1500);
note(`занятость процессора: ${Math.round(busy * 100)}% (порог ${Math.round(BUSY_LIMIT * 100)}%)`);

if (busy > BUSY_LIMIT && !force) {
  die(
    [
      'машина занята — замерять сейчас бессмысленно.',
      '',
      '  Цифра, снятая на загруженной машине, говорит о загрузке,',
      '  а не о коде: при пяти параллельных потоках здесь выходило',
      '  45–51 кадра при пороге 55, тогда как в одиночку — проходило.',
      '',
      '  Дождитесь тишины, или, если занятость к делу не относится,',
      '  повторите с ключом --force.',
    ].join('\n'),
  );
}

if (checkOnly) {
  console.log(`\n${ESC}[32m✓${ESC}[0m машина свободна, замерять можно\n`);
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
if (force && busy > BUSY_LIMIT) {
  note(`${ESC}[33mвнимание:${ESC}[0m машина занята, к цифре относитесь как к оценке`);
}

const run = spawnSync(
  'pnpm',
  ['exec', 'playwright', 'test', '--config', 'playwright.perf.config.ts', ...passthrough],
  { stdio: 'inherit', shell: true, cwd: repoRoot },
);

process.exit(run.status ?? 1);
