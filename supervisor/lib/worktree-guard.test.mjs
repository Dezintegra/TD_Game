import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decideLaunch, mainWorktreeOf } from './worktree-guard.mjs';

/**
 * Проверки отказа запускаться из дополнительного рабочего дерева.
 *
 * Цена ошибки здесь несимметрична, и потому проверяются обе стороны.
 * Не отказать там, где надо, — два супервизора от разных корней, каждый
 * со своим замком, и оба берут задачи с одной доски. Отказать там, где
 * не надо, — конвейер не поднимается вовсе, причём с сообщением, уводящим
 * в сторону.
 */

const MAIN = 'C:\\src\\dezintegra\\TD_Game';
const HERE = 'C:\\src\\dezintegra\\TD_Game\\.claude\\worktrees\\0128-proba';

/** Так выглядит файл `.git` рабочего дерева на этой станции. */
const worktreeLink = (main = MAIN, name = '0128-proba') =>
  `gitdir: ${main}/.git/worktrees/${name}\n`;

describe('распознавание дополнительного дерева', () => {
  it('ссылка на .git/worktrees называет основное дерево', () => {
    expect(mainWorktreeOf(worktreeLink())).toBe(MAIN);
  });

  it('обратные косые черты в ссылке разбираются так же', () => {
    expect(mainWorktreeOf('gitdir: C:\\src\\TD_Game\\.git\\worktrees\\proba')).toBe(
      'C:\\src\\TD_Game',
    );
  });

  it('каталог .git — основное дерево, спрашивать нечего', () => {
    expect(mainWorktreeOf(null)).toBe(null);
  });

  it('подмодуль воркри не считается: у него своя ссылка', () => {
    expect(mainWorktreeOf('gitdir: ../.git/modules/vendor\n')).toBe(null);
  });

  it('испорченное содержимое не бросает исключения', () => {
    for (const junk of ['', 'мусор', 'gitdir:', '\u0000\u0001', 'gitdir: \n']) {
      expect(() => mainWorktreeOf(junk)).not.toThrow();
      expect(mainWorktreeOf(junk)).toBe(null);
    }
  });
});

describe('решение о запуске', () => {
  it('в дополнительном дереве — отказ', () => {
    const decision = decideLaunch({ root: HERE, gitFile: worktreeLink() });
    expect(decision.launch).toBe(false);
  });

  it('в отказе назван путь основного дерева', () => {
    const decision = decideLaunch({ root: HERE, gitFile: worktreeLink() });
    expect(decision.message).toContain(MAIN);
  });

  it('и названо, что там набрать', () => {
    const decision = decideLaunch({ root: HERE, gitFile: worktreeLink() });
    // Дословно та самая короткая команда, что заведена в корневом описании
    // пакета: пересказ разошёлся бы с ней молча.
    expect(decision.message).toContain('pnpm supervisor');
  });

  it('и назван способ настоять — явный корень', () => {
    const decision = decideLaunch({ root: HERE, gitFile: worktreeLink() });
    expect(decision.message).toContain(`--root=${MAIN}`);
    expect(decision.message).toContain('PIPELINE_ROOT');
  });

  it('в основном дереве — запускать, и молча', () => {
    const decision = decideLaunch({ root: MAIN, gitFile: null });
    expect(decision.launch).toBe(true);
    expect(decision.message).toBe(null);
  });

  it('явно названный корень снимает отказ и в дополнительном дереве', () => {
    const decision = decideLaunch({
      root: MAIN,
      gitFile: worktreeLink(),
      explicitRoot: MAIN,
    });
    expect(decision.launch).toBe(true);
    expect(decision.message).toBe(null);
  });

  it('корень без файла .git вовсе запуску не мешает', () => {
    expect(decideLaunch({ root: MAIN }).launch).toBe(true);
  });
});

/**
 * Сторож на пускатель.
 *
 * Читает `bin/launch.mjs` КАК ТЕКСТ, и это единственный доступный способ:
 * пускатель — не модуль, а сценарий, который на верхнем уровне разбирает
 * доводы, ищет корень и порождает процесс. Ввоз его в тест означал бы запуск
 * супервизора прямо в прогоне тестов.
 *
 * Чего сторож НЕ ловит, сказано вслух: перестановки вызова. Уедет он ниже
 * запуска — сторож останется зелёным. Держат это место линт, ревью
 * и наблюдение владельца продукта; выдавать сторожа за проверку порядка
 * нельзя.
 */
describe('пускатель зовёт решение', () => {
  const launcher = readFileSync(
    join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'launch.mjs'),
    'utf8',
  );

  it('ввозит модуль решения', () => {
    expect(launcher).toMatch(
      /import\s*\{[^}]*decideLaunch[^}]*\}\s*from\s*'\.\.\/lib\/worktree-guard\.mjs'/,
    );
  });

  it('и зовёт его', () => {
    expect(launcher).toMatch(/decideLaunch\s*\(/);
  });

  it('печатает готовый текст отказа, а не сочиняет свой', () => {
    expect(launcher).toMatch(/\.message/);
  });
});
