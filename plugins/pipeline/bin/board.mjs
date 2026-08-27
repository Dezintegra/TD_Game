#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTasks } from '../lib/read-state.mjs';
import { renderBoard } from '../lib/board.mjs';
import { resolveConfig } from '../config/defaults.mjs';

/**
 * Перерисовать доску по бэклогу.
 *
 * Отдельным сценарием, а не частью цикла: доску полезно посмотреть в любой
 * момент, а не только когда конвейеру нашлась работа.
 */

const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

function findRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const root = resolve(rootArg ?? findRoot());
const configPath = fileURLToPath(new URL('../pipeline.config.json', import.meta.url));
const project = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const { config } = resolveConfig(project);

const { tasks, invalid } = readTasks(root, config);
const html = renderBoard(tasks, { now: new Date().toISOString() });
const out = join(root, 'manage', 'board.html');
writeFileSync(out, `${html}\n`);

console.log(`Доска собрана: ${out}`);
console.log(`Задач: ${tasks.length}${invalid.length ? `, негодных: ${invalid.length}` : ''}`);
