import { readFileSync, truncateSync } from 'node:fs';

/** Пустой замок свободен; файл сохраняется вместе с точечными Windows ACL. */
export function releasePerfLock(path, pid = process.pid) {
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'));
    if (held.pid === pid) truncateSync(path, 0);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}
