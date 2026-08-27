#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { resolveConfig } from '../config/defaults.mjs';

/**
 * Собрать снимок сессий для оркестратора.
 *
 * Зовётся так:
 *
 *   node plugins/pipeline/bin/snapshot.mjs <файл с ответом средства> [корень]
 *
 * Ответ средства оркестратор кладёт в файл сам — записью, на которую
 * разрешение уже выписано. Дальше дело этого сценария: разобрать, отобрать
 * нужные поля и положить `.pipeline/sessions.json`.
 *
 * Зачем отдельным сценарием, а не строкой в `node -e`: строка кода
 * в аргументе — это выполнение произвольного кода, и разрешить его заранее
 * можно только целиком. А снимок собирается каждый цикл, почти триста раз
 * в сутки, и каждый раз спрашивал бы подтверждения — в автономной сессии
 * это не задержка, а запертая насмерть задача планировщика.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Корень репозитория: вверх от каталога плагина, до `.git`. */
function findRoot() {
  let dir = here;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const [rawArg, rootArg] = process.argv.slice(2);

if (!rawArg) {
  console.error('НЕ СОБРАН');
  console.error('Нужен путь к файлу с ответом средства перечисления сессий.');
  process.exit(2);
}

const root = resolve(rootArg ?? findRoot());
const configPath = join(here, '..', 'pipeline.config.json');
const project = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const { config } = resolveConfig(project);

let raw;
try {
  // Метка порядка байтов срезается явным кодом, а не самим знаком: буквальный
  // невидимый знак в исходнике линтер справедливо не любит.
  raw = JSON.parse(readFileSync(resolve(rawArg), 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  console.error('НЕ СОБРАН');
  console.error(`ответ средства не читается: ${error.message}`);
  process.exit(1);
}

const { snapshot, problem } = buildSnapshot(raw);

if (!snapshot) {
  // Не пишем ничего. Прошлый снимок при этом остаётся на месте и постареет
  // сам: сканер смотрит на `lastActivityAt` каждой сессии, а не на возраст
  // файла. Записать сюда пустоту было бы хуже — это значит «о живости
  // исполнителей ничего не известно», и продолжателей не назначат вовсе.
  console.error('НЕ СОБРАН');
  console.error(problem);
  process.exit(1);
}

const dir = join(root, config.paths.local);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'sessions.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

const running = snapshot.sessions.filter((session) => session.isRunning).length;
console.log('СНИМОК СОБРАН');
console.log(`сессий: ${snapshot.sessions.length}, из них идущих: ${running}`);
