import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emptyScheduling, recordLaunch, recordRecovery, schedulingProblem } from './scheduling.mjs';

const pathOf = (root, config) => join(root, config.paths.local, 'scheduling.json');

/** Нечитаемый журнал не превращается в новый игровой ход молча. */
export function readScheduling(root, config) {
  try {
    const value = JSON.parse(readFileSync(pathOf(root, config), 'utf8').replace(/^\uFEFF/, ''));
    const error = schedulingProblem(value);
    return error ? { error } : value;
  } catch (error) {
    return error.code === 'ENOENT'
      ? emptyScheduling()
      : { error: `scheduling.json: ${error.message}` };
  }
}

export function createSchedulingStore(root, config) {
  let fault = null;
  function update(transform) {
    if (fault) throw new Error(fault);
    try {
      const current = readScheduling(root, config);
      if (current.error) throw new Error(current.error);
      const next = transform(current);
      if (next === current) return current;
      const path = pathOf(root, config);
      mkdirSync(dirname(path), { recursive: true });
      // Единственный писатель — владелец замка супервизора. Переименование
      // не оставляет читающему циклу половину JSON после обрыва записи.
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n');
      renameSync(temporary, path);
      return next;
    } catch (error) {
      fault = `учёт выбора остановлен: ${error.message}`;
      throw new Error(fault);
    }
  }
  return {
    read: () => (fault ? { error: fault } : readScheduling(root, config)),
    launched: (task, at) => update((state) => recordLaunch(state, task, at)),
    recovered: (id) => update((state) => recordRecovery(state, id)),
  };
}
