import { resolve } from 'node:path';
import { branchFor } from './reconcile.mjs';

/** Восстановление использует сохранённую принадлежность, а не угадывает путь. */
export function recoverOwnership(record, { task, root, machine }) {
  if (
    !task ||
    !record ||
    record.machine !== machine ||
    resolve(record.root ?? '.') !== resolve(root) ||
    (task.owner && task.owner !== machine)
  )
    return null;
  const entry = record.entry;
  if (
    !entry ||
    entry.taskId !== task.id ||
    entry.branch !== branchFor(task.id) ||
    typeof entry.path !== 'string' ||
    !entry.path.trim() ||
    resolve(root, entry.path) === resolve(root)
  )
    return null;
  return { ...entry };
}
