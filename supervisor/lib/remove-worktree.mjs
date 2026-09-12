import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const present = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/** Git может снять регистрацию, оставив занятый каталог на Windows. */
export function removeWorktree({ root, path, run, worktreeDir = '.claude/worktrees' }) {
  try {
    const target = resolve(root, path);
    const parent = resolve(root, worktreeDir);
    const inside = relative(resolve(root), parent);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      return { ok: false, why: 'каталог деревьев вне проекта' };
    if (dirname(target) !== parent) return { ok: false, why: 'путь вне каталога деревьев' };
    const checkPath = () => {
      // После ручной уборки может отсутствовать и родитель. Но существующие
      // родители и сама цель не должны перенаправлять удаление наружу.
      if (present(parent) && realpathSync(parent) !== resolve(realpathSync(root), inside))
        throw new Error('каталог деревьев перенаправлен ссылкой');
      if (present(target)?.isSymbolicLink()) throw new Error('путь дерева является ссылкой');
    };
    checkPath();

    const result = run(['worktree', 'remove', target, '--force']);
    // Git может вернуть Directory not empty, уже сняв регистрацию. Решает
    // свежий список, а не текст ошибки; исчезновение папки тоже его не заменяет.
    const inventory = run(['worktree', 'list', '--porcelain', '-z']);
    if (inventory.code !== 0) return { ok: false, why: 'не удалось проверить регистрацию дерева' };
    const paths = inventory.stdout.split('\0').filter((field) => field.startsWith('worktree '));
    if (paths.length === 0 || !inventory.stdout.endsWith('\0'))
      return { ok: false, why: 'список деревьев Git пуст или повреждён' };
    if (paths.some((field) => resolve(field.slice(9)) === target))
      return { ok: false, why: result.stderr?.trim() || 'дерево ещё зарегистрировано в Git' };
    // Git успел изменить файловую систему — проверяем границы заново,
    // непосредственно перед рекурсивным удалением всего остатка.
    checkPath();
    if (!present(target)) return { ok: true };
    rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    return present(target) ? { ok: false, why: 'каталог дерева остался' } : { ok: true };
  } catch (error) {
    return { ok: false, why: error.message };
  }
}
