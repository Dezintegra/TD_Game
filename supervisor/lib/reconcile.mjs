import { NEEDS_WORKTREE } from '../config/transitions.mjs';

/**
 * Сверка реестра с действительностью.
 *
 * Взятие задачи в работу — это несколько шагов подряд: захват, дерево, ветка,
 * запись в реестр, назначение в слот. Оборваться оно может на любом, и без
 * сверки обрывки накапливаются: дерево без записи через неделю не отличить
 * от брошенной работы, а запись без дерева заставляет конвейер ждать сессию,
 * которой нет.
 *
 * Поэтому каждый цикл начинается с вопроса «что из записанного правда».
 * Ответ считается здесь, а исправляет его оркестратор — сверка сама ничего
 * не трогает.
 */

/** Что делать с найденным расхождением. */
export const REPAIRS = [
  'finish-claim', // задача наша и в работе, а дерева нет — завести
  'adopt-worktree', // дерево есть, записи нет — восстановить запись
  'drop-entry', // запись есть, дерева нет — снять запись
  'report-orphan', // дерево похоже на наше, но ни к чему не относится — назвать человеку
];

/**
 * Ветка конвейера отличается от ручной строгим видом имени.
 *
 * Приставки `worktree-` мало: её носят и деревья, заведённые человеком
 * вручную, — так устроен штатный способ их заводить. Отличает конвейерные
 * деревья вид идентификатора задачи: четыре цифры, дефис, имя строчными.
 *
 * Разница не косметическая. Первый же настоящий прогон предложил убрать
 * три чужих дерева, из них одно — то, в котором конвейер и писался.
 */
// Дефис на конце допустим намеренно: идентификатор задачи режется на сорока
// знаках, и слово может оборваться на нём — так у 0088 (…-zamera-pnpm-).
// Шаблон без этого допуска считал такое дерево чужим, выкидывал запись
// из реестра каждый оборот и заново пытался завести дерево на существующий
// каталог; задача при этом молча не получала сессии. Замечено 02.09.2026.
const PIPELINE_BRANCH = /^worktree-[0-9]{4}-[a-z0-9]+(-[a-z0-9]*)*$/;

/**
 * Разобрать вывод `git worktree list --porcelain`.
 *
 * Формат построчный: `worktree <путь>`, затем `branch refs/heads/<имя>`.
 * Первым идёт основное дерево — его в расчёт не берём никогда.
 */
export function parseWorktrees(text = '') {
  const trees = [];
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('worktree ')) {
      if (current) trees.push(current);
      current = { path: line.slice('worktree '.length), branch: null };
      continue;
    }
    if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) trees.push(current);

  // Первое дерево — основное, то самое, где лежит .git. Оно всегда на главной
  // ветке и конвейеру не принадлежит.
  return trees.slice(1);
}

/** Имя ветки и дерева выводятся из идентификатора задачи, а не хранятся. */
export const branchFor = (taskId) => `worktree-${taskId}`;

/**
 * Посчитать, что чинить.
 *
 * @param {object} params
 * @param {object} params.registry  местный реестр
 * @param {object[]} params.worktrees деревья, найденные на диске
 * @param {object[]} params.tasks    задачи бэклога
 * @param {string} params.machine    имя этой рабочей станции
 * @returns {{ repairs: object[], notes: string[] }}
 */
export function reconcile({ registry, worktrees, tasks, machine }) {
  const repairs = [];
  const notes = [];

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const entries = registry.entries ?? [];
  const ours = worktrees.filter((tree) => PIPELINE_BRANCH.test(tree.branch ?? ''));

  const taskIdOf = (tree) => tree.branch.slice('worktree-'.length);

  // 1. Деревья без записи в реестре.
  //
  // Удалять их сверка не предлагает никогда. Дерево — это чья-то работа,
  // и уборка допустима только после подтверждённого вливания; всё прочее
  // называется человеку и ждёт его решения.
  for (const tree of ours) {
    const taskId = taskIdOf(tree);
    if (entries.some((entry) => entry.taskId === taskId)) continue;

    const task = byId.get(taskId);
    if (!task) {
      repairs.push({ kind: 'report-orphan', taskId, path: tree.path, why: 'задачи нет в бэклоге' });
      continue;
    }
    if (task.owner && task.owner !== machine) {
      // Задачу заняла другая машина: доводить чужой захват до конца нельзя,
      // иначе две станции возьмутся за одно.
      repairs.push({
        kind: 'report-orphan',
        taskId,
        path: tree.path,
        why: `задача занята машиной ${task.owner}`,
      });
      continue;
    }
    if (!NEEDS_WORKTREE.includes(task.status)) {
      repairs.push({
        kind: 'report-orphan',
        taskId,
        path: tree.path,
        why: `задача в состоянии «${task.status}», дерево ей не нужно`,
      });
      continue;
    }
    repairs.push({ kind: 'adopt-worktree', taskId, path: tree.path, branch: tree.branch });
  }

  // 2. Записи без деревьев.
  for (const entry of entries) {
    if (ours.some((tree) => taskIdOf(tree) === entry.taskId)) continue;
    repairs.push({ kind: 'drop-entry', taskId: entry.taskId, why: 'дерева нет на диске' });
  }

  // 3. Задачи, захваченные нами, но без дерева и без записи: захват прошёл,
  //    а дерево завести не успели.
  for (const task of tasks) {
    if (task.owner !== machine) continue;
    if (!NEEDS_WORKTREE.includes(task.status)) continue;
    const hasTree = ours.some((tree) => taskIdOf(tree) === task.id);
    const hasEntry = entries.some((entry) => entry.taskId === task.id);
    if (hasTree || hasEntry) continue;
    repairs.push({ kind: 'finish-claim', taskId: task.id, branch: branchFor(task.id) });
    notes.push(`задача ${task.id} захвачена, но дерева нет — доводим взятие до конца`);
  }

  return { repairs, notes };
}
