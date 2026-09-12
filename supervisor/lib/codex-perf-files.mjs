import { closeSync, lstatSync, openSync } from 'node:fs';
import { resolve } from 'node:path';

export function codexPerfPaths(root, cwd = root, env = process.env) {
  return [
    resolve(root, '.perf-lock'),
    resolve(cwd, env.PERF_LOG ?? resolve(root, '.perf-log.jsonl')),
  ];
}

/** Windows выдаёт ACL существующему файлу: родитель main остаётся только для чтения. */
export function prepareCodexPerfFiles(root, cwd = root, env = process.env) {
  for (const path of new Set(codexPerfPaths(root, cwd, env))) {
    try {
      closeSync(openSync(path, 'wx'));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // Не следуем ссылке и не обнуляем чужой активный замок или историю.
    if (!lstatSync(path).isFile())
      throw new Error(`Файл замеров должен быть обычным файлом: ${path}`);
  }
}
