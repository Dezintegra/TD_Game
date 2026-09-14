import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { NEEDS_WORKTREE } from '../config/transitions.mjs';

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Ownership survives a missing checkout; launchability is a separate fact. */
export function unavailableWorkspaces({
  tasks,
  registry,
  worktrees,
  root,
  directory = isDirectory,
}) {
  return Object.fromEntries(
    tasks
      .filter((task) => NEEDS_WORKTREE.includes(task.status))
      .flatMap((task) => {
        const entry = registry.entries?.find((item) => item.taskId === task.id);
        const available =
          entry?.path &&
          entry.branch === `worktree-${task.id}` &&
          directory(resolve(root, entry.path)) &&
          worktrees.some(
            (tree) =>
              tree.branch === entry.branch &&
              resolve(root, tree.path) === resolve(root, entry.path),
          );
        return available
          ? []
          : [[task.id, 'рабочий каталог отсутствует или не подтверждён реестром Git']];
      }),
  );
}

export function checkWorkspace({ root, entry, run, directory = isDirectory }) {
  if (!entry?.path || !directory(resolve(root, entry.path)))
    return { ok: false, why: 'рабочий каталог отсутствует' };
  const cwd = resolve(root, entry.path);
  const top = run(['-C', cwd, 'rev-parse', '--show-toplevel']);
  const branch = run(['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (
    top.code !== 0 ||
    !top.stdout?.trim() ||
    resolve(top.stdout.trim()) !== cwd ||
    branch.code !== 0 ||
    branch.stdout?.trim() !== entry.branch
  )
    return { ok: false, why: 'путь и ветка рабочего дерева не подтверждены' };
  return { ok: true, path: entry.path };
}
