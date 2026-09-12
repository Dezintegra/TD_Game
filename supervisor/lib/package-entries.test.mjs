import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Всякое объявленное имя запуска ведёт через пускатель.
 *
 * Требование одно на два объявления нарочно. Почини мы только `bin`, оно
 * выполнялось бы буквой и обходилось бы тремя строками ниже того же файла:
 * `pnpm start` из каталога инструмента остался бы второй точкой входа —
 * без остановки, без фона, без отсечения двойного запуска.
 *
 * Прочие сценарии описания пакета (`cycle`, `board`, `board-setup`, `test`)
 * зовут другие программы инструмента, пускателя не касаются и под сторожа
 * не подпадают — иначе следующая правка «причесала» бы их заодно.
 */

const toolDir = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(toolDir, 'package.json'), 'utf8'));

/** Решающая часть: к ней объявленные имена вести не вправе. */
const CORE = 'bin/supervise.mjs';

/** Сценарии описания пакета, поднимающие супервизор. */
const LAUNCHING = ['start', 'shadow'];

describe('объявленная программа инструмента', () => {
  it('указывает на пускатель', () => {
    expect(manifest.bin['pipeline-supervisor']).toBe('bin/launch.mjs');
  });

  it('и этот файл существует', () => {
    // Объявление, указывающее в пустоту, — хуже неверного: глобальная
    // установка молча заводит имя, которое не запускается вовсе.
    expect(existsSync(join(toolDir, manifest.bin['pipeline-supervisor']))).toBe(true);
  });
});

describe('сценарии запуска в описании пакета', () => {
  for (const name of LAUNCHING) {
    it(`«${name}» не зовёт решающую часть напрямую`, () => {
      expect(manifest.scripts[name]).not.toContain(CORE);
    });

    it(`«${name}» зовёт пускатель`, () => {
      expect(manifest.scripts[name]).toContain('bin/launch.mjs');
    });
  }

  it('тень просит у пускателя его слово --shadow', () => {
    // `--dry-run` пускатель понимает лишь по совместительству, и держаться
    // за него значило бы держаться за случайность.
    expect(manifest.scripts.shadow).toContain('--shadow');
  });

  it('сценарии других программ инструмента не тронуты', () => {
    expect(manifest.scripts.cycle).toBe('node bin/cycle.mjs');
    expect(manifest.scripts.board).toBe('node bin/board.mjs');
    expect(manifest.scripts['board-setup']).toBe('node bin/board-setup.mjs');
  });
});
