import { dirname, resolve } from 'node:path';
import { branchFor } from './reconcile.mjs';

/** Влитый PR не разрешает удалять появившиеся позже коммиты и несохранённые файлы. */
export function inspectCleanup({ task, entry, root, config, run, exists }) {
  const no = (why) => ({ ok: false, why });
  if (
    entry.taskId !== task.id ||
    entry.branch !== branchFor(task.id) ||
    dirname(resolve(root, entry.path)) !== resolve(root, config.worktreeDir) ||
    resolve(root, entry.path) === resolve(root)
  )
    return no('принадлежность пути или ветки не подтверждена');
  try {
    if (exists(resolve(root, entry.path, '.git'))) {
      const dirty = run([
        '-C',
        resolve(root, entry.path),
        'status',
        '--porcelain',
        '--untracked-files=all',
      ]);
      if (dirty.code !== 0 || dirty.stdout.trim())
        return no('дерево содержит несохранённые файлы или его состояние неизвестно');
    }
    const local = run(['for-each-ref', '--format=%(objectname)', `refs/heads/${entry.branch}`]);
    if (local.code !== 0) return no('локальная ветка не проверена');
    const localHead = local.stdout.trim() || null;
    const remote = run(['ls-remote', '--heads', config.remote, `refs/heads/${entry.branch}`]);
    if (remote.code !== 0) return no('удалённая ветка не проверена');
    const rows = remote.stdout.trim().split('\n').filter(Boolean);
    if (rows.length > 1) return no('удалённая ветка неоднозначна');
    const remoteHead = rows.length ? rows[0].split(/\s+/)[0] : null;
    if ([localHead, remoteHead].some((head) => head !== null && !/^[a-f0-9]{40}$/i.test(head)))
      return no('хеш ветки не разобран');
    if (task.links?.pr) {
      const answer = run(
        [
          'pr',
          'view',
          String(task.links.pr),
          '--json',
          'number,state,mergedAt,baseRefName,headRefOid',
        ],
        'gh',
        root,
        { timeout: 10000 },
      );
      if (answer.code !== 0) return no('голова влитого PR не проверена');
      const pr = JSON.parse(answer.stdout);
      if (
        pr.number !== task.links.pr ||
        pr.state !== 'MERGED' ||
        !pr.mergedAt ||
        pr.baseRefName !== config.mainBranch ||
        !/^[a-f0-9]{40}$/i.test(pr.headRefOid ?? '')
      )
        return no('нет доказательства головы влитого PR');
      if ([localHead, remoteHead].some((head) => head !== null && head !== pr.headRefOid))
        return no('после вливания в ветке есть другая работа');
    } else if (remoteHead && remoteHead !== localHead)
      return no('удалённая ветка содержит не проверенную локально работу');
    return { ok: true };
  } catch {
    return no('проверка сохранности ресурсов не завершилась');
  }
}
