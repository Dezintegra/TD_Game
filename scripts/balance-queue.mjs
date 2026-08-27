import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Очередь проверок баланса, собранная из бэклога.
 *
 * Отдельного файла очереди больше нет. Очередью служит сам бэклог, а прогон
 * баланса — обычная задача типа `run` с видом `arena`. Причина простая: два
 * списка ожидающей работы неизбежно расходятся. Запись в очереди живёт своей
 * жизнью, задача — своей, и однажды становится непонятно, какому из них
 * верить; а разошедшись, они ещё и дерутся за один файл в параллельных
 * pull request.
 *
 * Вынесено отдельным модулем ради проверяемости: сам прогонщик тянет за собой
 * собранные пакеты игры и в тесте не запускается, а сборка очереди — обычный
 * счёт по файлам, и проверять её надо.
 */

/** Метка порядка байтов: её ставят редакторы Windows, и JSON на ней спотыкается. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Состояния, в которых задача мериться не должна.
 *
 * Закрытая уже отвечена, остановленная ждёт разбора человеком. Гнать по ним
 * матчи значит тратить час чужого железа на вопрос, который никто не задавал.
 */
const SKIP = ['closed', 'failed'];

/**
 * Собрать очередь.
 *
 * @param {string} root корень репозитория
 * @param {(message: string) => void} [warn] куда жаловаться на негодные файлы
 * @returns {object[]} записи в том же виде, в каком их ждёт прогонщик
 */
export function queueFromBacklog(root, warn = () => {}) {
  const dir = join(root, 'manage', 'tasks');
  if (!existsSync(dir)) return [];

  const queue = [];

  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;

    let task;
    try {
      const raw = readFileSync(join(dir, name), 'utf8');
      task = JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw);
    } catch (error) {
      // Одна испорченная задача не отменяет остальных: иначе опечатка,
      // сделанная в полночь, останавливала бы ночной прогон целиком.
      warn(`задача ${name} не разбирается и пропущена: ${error.message}`);
      continue;
    }

    if (task?.type !== 'run' || task?.run?.kind !== 'arena') continue;
    if (SKIP.includes(task.status)) continue;

    queue.push({
      id: task.id,
      task: task.run.params?.change ?? task.id,
      why: task.description,
      profiles: task.run.params?.profiles,
      matches: task.run.params?.matches,
      seed: task.run.params?.seed,
      expect: task.run.expectation,
    });
  }

  return queue;
}
