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
    // Проверяем реальные границы до любой команды удаления.
    if (realpathSync(parent) !== resolve(realpathSync(root), inside))
      return { ok: false, why: 'каталог деревьев перенаправлен ссылкой' };
    if (present(target)?.isSymbolicLink())
      return { ok: false, why: 'путь дерева является ссылкой' };

    const result = run(['worktree', 'remove', target, '--force']);
    if (!present(target)) return { ok: true };
    // Нельзя рекурсивно стирать дерево, пока Git сохраняет его регистрацию.
    if (result.code !== 0 && !/not a working tree|is not a valid/i.test(result.stderr))
      return { ok: false, why: result.stderr.trim() };
    const inventory = run(['worktree', 'list', '--porcelain']);
    if (inventory.code !== 0) return { ok: false, why: 'не удалось проверить регистрацию дерева' };
    const registered = inventory.stdout
      .split(/\r?\n/)
      .some((line) => line.startsWith('worktree ') && resolve(line.slice(9)) === target);
    if (registered) return { ok: false, why: 'дерево ещё зарегистрировано в Git' };
    rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    return present(target) ? { ok: false, why: 'каталог дерева остался' } : { ok: true };
  } catch (error) {
    return { ok: false, why: error.message };
  }
}
