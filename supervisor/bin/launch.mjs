#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
// Именованным ввозом, а не глобальным именем: перечень известных линту
// глобальных имён у служебных сценариев узкий, и `setTimeout` в него не входит.
import { setTimeout as later } from 'node:timers';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKillTree } from '../lib/run-stage.mjs';
import { decideLaunch } from '../lib/worktree-guard.mjs';

/**
 * Запуск супервизора.
 *
 * Вся работа пускателя живёт здесь, а не в `.cmd` и `.sh`: те остаются
 * обёртками в три строки на латинице. Причина в кодировках, и она не мелочь.
 *
 * Батник с кириллицей cmd читает в кодовой странице 866, а метка порядка
 * байтов в нём ломает первую же строку — `chcp` перестаёт быть командой.
 * У `.ps1` ловушка ровно противоположная: без метки PowerShell 5.1 читает
 * файл как ANSI и спотыкается на «незакрытой строке» посреди верного
 * скрипта. Держать одну и ту же логику в двух файлах с несовместимыми
 * требованиями к кодировке — значит однажды починить один и сломать другой.
 *
 * Node читает свои файлы как UTF-8 всегда и везде. Поэтому русский текст
 * весь тут, а обёртки не содержат ни одной буквы кириллицы и потому
 * не могут испортиться вовсе.
 */

const toolDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

/** Ключи без значения и ключи со значением. Всё прочее — опечатка. */
const FLAGS = ['shadow', 'dry-run', 'detached', 'quiet', 'stop', 'help'];
const VALUES = ['root', 'config'];

const has = (name) => args.includes(`--${name}`);
const valueOf = (name) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

function usage() {
  console.log('Запуск супервизора конвейера.');
  console.log('');
  console.log('  (без доводов)     запустить и смотреть');
  console.log('  --shadow          тень: считать и печатать, мира не трогать');
  console.log('  --detached        в фон, вывод в .pipeline/supervisor.out.log');
  console.log('  --stop            снять вместе с поддеревом процессов');
  console.log('  --quiet           молчать в консоль; журналы пишутся по-прежнему');
  console.log('  --root=<путь>     корень проекта, если он не находится сам');
  console.log('  --config=<путь>   настройка не из каталога инструмента');
}

/**
 * Незнакомый довод — это отказ, а не «запускай как обычно».
 *
 * Написано по следам происшествия 02.09.2026: проба с бессмысленным доводом
 * `--` молча подняла БОЕВОЙ супервизор, потому что «не `--stop`» означало
 * «запускай». Пускатель ведёт долгоживущий процесс, который сам берёт задачи
 * и правит репозиторий, — цена его случайного запуска несоизмерима с ценой
 * лишней проверки.
 */
const unknown = args.filter((arg) => {
  const name = arg.startsWith('--') ? arg.slice(2).split('=')[0] : null;
  if (!name) return true;
  return arg.includes('=') ? !VALUES.includes(name) : !FLAGS.includes(name);
});

if (unknown.length > 0) {
  console.error(`Непонятный довод: ${unknown.join(', ')}`);
  console.error('Ничего не запущено — незнакомый ключ не повод поднимать конвейер.');
  console.error('');
  usage();
  process.exit(1);
}

if (has('help')) {
  usage();
  process.exit(0);
}

/** Корень проекта: вверх от каталога инструмента до каталога с `.git`. */
function findRoot() {
  let dir = toolDir;
  for (let depth = 0; depth < 10; depth += 1) {
    // Проверяется наличие, а не тип: у рабочего дерева `.git` — это файл
    // со ссылкой, и проверка на каталог отвергла бы всякий воркри.
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const explicitRoot = valueOf('root') ?? process.env.PIPELINE_ROOT ?? null;
const root = resolve(explicitRoot ?? findRoot() ?? process.cwd());

if (!existsSync(root)) {
  console.error(`Не найден корень проекта: ${root}`);
  console.error('Назовите его прямо: --root=C:\\путь\\к\\проекту');
  process.exit(1);
}

/**
 * Содержимое файла `.git` найденного корня, либо `null`.
 *
 * `null` значит «спрашивать нечего»: у основного дерева `.git` — каталог,
 * а нечитаемый `.git` не повод отказывать в запуске.
 */
function gitLink(dir) {
  const path = join(dir, '.git');
  try {
    return statSync(path).isDirectory() ? null : readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// Решение целиком принимает модуль, здесь остаются печать и код возврата.
// Стоит сразу за поиском корня и до всего остального: и `--stop` из чужого
// дерева одинаково бессмыслен — он смотрел бы не в тот замок и отвечал бы
// «супервизор не работает», пока настоящий работает.
const decision = decideLaunch({ root, gitFile: gitLink(root), explicitRoot });
if (!decision.launch) {
  console.error(decision.message);
  process.exit(1);
}

const entry = join(toolDir, 'bin', 'supervise.mjs');
if (!existsSync(entry)) {
  console.error(`Не найден сам супервизор: ${entry}`);
  console.error('Пускатель обязан лежать в каталоге инструмента, рядом с ним.');
  process.exit(1);
}

const localDir = join(root, '.pipeline');
const lockPath = join(localDir, 'supervisor.lock');

/**
 * Номер процесса живого супервизора, если он есть.
 *
 * Замок переживает жёсткое убийство, и это не беда: в нём лежит номер
 * процесса, и мёртвый номер означает брошенный замок, а не работающего
 * соседа. Поэтому спрашиваем систему, а не наличие файла.
 */
function liveSupervisor() {
  if (!existsSync(lockPath)) return null;
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  if (!lock.pid) return null;
  try {
    process.kill(lock.pid, 0);
    return lock.pid;
  } catch (error) {
    // Отказ по правам значит, что процесс есть, но чужой, — то есть жив.
    return error.code === 'EPERM' ? lock.pid : null;
  }
}

const killTree = createKillTree((program, list) => {
  try {
    execFileSync(program, list, { stdio: 'ignore', windowsHide: true });
    return { code: 0 };
  } catch (error) {
    return { code: error.status ?? 1 };
  }
});

if (has('stop')) {
  const live = liveSupervisor();
  if (!live) {
    console.log('Супервизор не работает.');
    if (existsSync(lockPath)) {
      rmSync(lockPath);
      console.log('Брошенный замок убран.');
    }
    process.exit(0);
  }

  // Снимается ПОДДЕРЕВО, а не один процесс: этап порождает git, pnpm, gh
  // и браузер, и осиротевший потомок удерживает каталог рабочего дерева
  // не хуже зависшей сессии — уборка потом падает на «каталог занят».
  console.log(`Снимаю супервизор (процесс ${live}) вместе с поддеревом...`);
  killTree(live);

  later(() => {
    if (liveSupervisor()) {
      console.error(`Процесс ${live} не снялся.`);
      process.exit(1);
    }
    if (existsSync(lockPath)) rmSync(lockPath);
    console.log('Снят.');
    console.log('');
    console.log('Если этап шёл, он снят на полуслове. Задача не потеряна:');
    console.log('следующий запуск выдаст ей продолжение той же сессией.');
    console.log('');
    console.log('Останавливать лучше через Ctrl+C в окне супервизора: сигнал он');
    console.log('ловит и даёт идущему этапу доработать, прежде чем снять.');
  }, 500);
} else {
  start();
}

function start() {
  const live = liveSupervisor();
  if (live) {
    console.log(`СУПЕРВИЗОР УЖЕ РАБОТАЕТ: процесс ${live}.`);
    console.log('Двойного запуска не будет — замок отсёк бы второй экземпляр и сам.');
    console.log('Снять: start --stop');
    process.exit(0);
  }

  const forwarded = [entry];
  // `--shadow` — своё имя того же, что супервизор знает как `--dry-run`.
  // Пускателю нужно слово, понятное человеку у двойного щелчка.
  if (has('shadow') || has('dry-run')) forwarded.push('--dry-run');
  if (has('quiet')) forwarded.push('--quiet');
  if (valueOf('config')) forwarded.push(`--config=${valueOf('config')}`);
  // Корень передаётся доводом, а не оставляется на угадывание: пускатель
  // его уже нашёл, и пусть обе стороны говорят об одном каталоге.
  forwarded.push(root);

  if (!has('detached')) {
    // Прямо здесь, выводом на экран. Останавливается Ctrl+C — и это лучший
    // способ остановки: супервизор ловит сигнал, даёт идущему этапу
    // доработать и лишь затем снимает его поддеревом.
    const child = spawn(process.execPath, forwarded, { cwd: root, stdio: 'inherit' });
    child.on('close', (code) => process.exit(code ?? 0));
    return;
  }

  mkdirSync(localDir, { recursive: true });
  const outPath = join(localDir, 'supervisor.out.log');
  const errPath = join(localDir, 'supervisor.err.log');
  const out = openSync(outPath, 'a');
  const err = openSync(errPath, 'a');

  // `detached` плюс `unref` — иначе супервизор умрёт вместе с окном,
  // из которого его запустили, а весь смысл фонового режима в обратном.
  const child = spawn(process.execPath, forwarded, {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();

  console.log(`Супервизор запущен в фоне, процесс ${child.pid}.`);
  console.log(`Вывод: ${outPath}`);
  console.log('');
  console.log('Смотреть за ним:');
  console.log(`  Get-Content '${outPath}' -Wait -Tail 40 -Encoding UTF8   (PowerShell)`);
  console.log(`  tail -f '${outPath}'                                      (sh)`);
  console.log('Снять:');
  console.log('  start --stop');
}
