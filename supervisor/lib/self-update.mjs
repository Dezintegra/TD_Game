/**
 * Самообновление супервизора: заметить свой новый код и перезапуститься.
 *
 * Супервизор живёт днями, а его код вливается pull request'ами по нескольку
 * раз в сутки. Пока обновлял человек — `git pull` в основном дереве
 * и перезапуск руками, — 02.09.2026 это делалось четыре раза, и каждый раз
 * процесс работал на вчерашнем коде, пока о нём не вспоминали.
 *
 * Здесь только решение: чистый счёт от ответов git и занятости супервизора
 * к одному из исходов. Ни порождения процесса, ни замка, ни файлов — их
 * делает супервизор, а исходы проверяются подставным git за миллисекунды.
 *
 * Мерка «код изменился» — хеш дерева каталога инструмента в `HEAD`,
 * запомненный при запуске. Ловится всё, что меняет код на диске, и не
 * ловится незакоммиченная правка: человек работает, перезапуск ему ни к чему.
 */

/** Исходы решения. */
export const VERDICT = {
  off: 'самообновление выключено',
  current: 'код актуален',
  blocked: 'обновление отложено с причиной',
  wait: 'новый код на диске, ждём тишины',
  restart: 'пора перезапускаться',
  unknown: 'git не ответил, сверять нечем',
};

/**
 * Решить, что делать с собственным кодом.
 *
 * @param {object} params
 * @param {object} params.git         набор команд git
 * @param {string|null} params.ownDir каталог инструмента от корня, с прямыми
 *                                    косыми; `null` — лежит вне репозитория
 * @param {string} params.mainBranch  главная ветка
 * @param {string|null} params.loadedTree хеш дерева инструмента при запуске
 * @param {boolean} [params.enabled]  не выключено ли настройкой
 * @param {boolean} [params.dryRun]   тень: мира не трогаем
 * @param {number} [params.running]   живых этапов сейчас
 * @param {number} [params.pending]   отчётов, ожидающих переноса
 * @returns {{ verdict: string, notes: string[] }}
 */
export function judgeSelfUpdate({
  git,
  ownDir,
  mainBranch,
  loadedTree,
  enabled = true,
  dryRun = false,
  running = 0,
  pending = 0,
}) {
  const notes = [];
  const off = (why) => ({ verdict: 'off', notes: why ? [`самообновление выключено: ${why}`] : [] });
  const unknown = (why) => ({ verdict: 'unknown', notes: [`самообновление: ${why}`] });
  const blocked = (why) => ({ verdict: 'blocked', notes: [`самообновление отложено: ${why}`] });

  if (!enabled) return off('настройкой');
  // Тень мира не трогает, а подтягивание кода — правка дерева.
  if (dryRun) return off('в тени код не подтягиваем');
  if (!ownDir) return off('каталог инструмента лежит вне репозитория');
  if (!loadedTree) return unknown('дерево каталога инструмента при запуске не прочиталось');

  let current = git.treeOf(ownDir);
  if (current === null) return unknown(`git не отдал дерево ${ownDir}`);

  if (current === loadedTree) {
    const ahead = git.aheadOn([ownDir], mainBranch);
    if (ahead === null) return unknown('не удалось посчитать отставание по каталогу инструмента');
    if (ahead === 0) return { verdict: 'current', notes };

    const moved = `удалённая ветка ушла вперёд по ${ownDir} на ${ahead} коммит(ов)`;

    // Ускоряющий перевод лёг бы на ту ветку, куда человек переключил дерево
    // руками. Подтягивание главной ветки в начале оборота этого не проверяет,
    // и здесь проверка стоит вместо него, а не вдобавок.
    const branch = git.currentBranch();
    if (branch !== mainBranch) {
      return blocked(
        `${moved}, но основное дерево стоит на «${branch ?? '?'}», а не на «${mainBranch}»`,
      );
    }

    const dirty = git.dirtyPaths();
    if (dirty === null || dirty.length > 0) {
      return blocked(
        `${moved}, но в дереве посторонние изменения: ${(dirty ?? ['не прочитались']).join(', ')}`,
      );
    }

    const pulled = git.fastForward(mainBranch);
    if (!pulled.ok) return blocked(`${moved}, а подтянуться не удалось: ${pulled.why}`);
    notes.push(`самообновление: подтянулись, ${moved}`);

    current = git.treeOf(ownDir);
    if (current === null || current === loadedTree) {
      notes.push('самообновление: код супервизора при этом не изменился');
      return { verdict: 'current', notes };
    }
  }

  // Тихий момент: нет этапов, которые перезапуск снял бы на полуслове,
  // и нет отчётов в памяти, которые он потерял бы.
  if (running > 0 || pending > 0) {
    notes.push(
      'самообновление: новый код супервизора уже в дереве, жду тишины ' +
        `(идёт этапов ${running}, отчётов ждёт переноса ${pending})`,
    );
    return { verdict: 'wait', notes };
  }

  notes.push('самообновление: код супервизора изменился, перезапускаюсь');
  return { verdict: 'restart', notes };
}
