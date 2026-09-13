#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKillTree } from '../lib/run-stage.mjs';
import { parseLaunchArgs, launchUsage, runLaunch } from '../lib/launch.mjs';
import { decideLaunch } from '../lib/worktree-guard.mjs';

/**
 * Запуск супервизора.
 *
 * Вся работа пускателя живёт в Node, а не в `.cmd` и `.sh`: те остаются
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

let options;
try {
  options = parseLaunchArgs(args);
} catch (error) {
  console.error(error.message);
  console.log(launchUsage());
  process.exit(1);
}
if (options.help) {
  console.log(launchUsage());
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

const explicitRoot = options.root ?? process.env.PIPELINE_ROOT ?? null;
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

// Сторож остаётся у входа CLI; модуль также защищён при прямом вызове.
const gitFile = gitLink(root);
const decision = decideLaunch({ root, gitFile, explicitRoot });
if (!decision.launch) {
  console.error(decision.message);
  process.exit(1);
}

const killTree = createKillTree((program, list) => {
  try {
    execFileSync(program, list, { stdio: 'ignore', windowsHide: true });
    return { code: 0 };
  } catch (error) {
    return { code: error.status ?? 1 };
  }
});

const controller = new globalThis.AbortController();
const stopWatching = () => controller.abort();
const watching = ['watch', 'start-watch'].includes(options.mode);
if (watching) {
  process.on('SIGINT', stopWatching);
  process.on('SIGTERM', stopWatching);
}
try {
  process.exitCode = await runLaunch(
    {
      options,
      root,
      entry: join(toolDir, 'bin', 'supervise.mjs'),
      gitFile,
      explicitRoot,
      signal: controller.signal,
    },
    { killTree },
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (watching) {
    process.off('SIGINT', stopWatching);
    process.off('SIGTERM', stopWatching);
  }
}
