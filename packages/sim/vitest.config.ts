import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Быстрый набор ядра.
 *
 * Ядро обязано вести себя одинаково в браузере и на сервере, поэтому
 * один и тот же набор прогоняется в двух окружениях. Второе окружение
 * задаётся не здесь, а флагом в команде пакета:
 * `vitest run && vitest run --environment jsdom`. Флаг перекрывает
 * значение отсюда, и отдельный файл ради этого не нужен.
 *
 * Раньше оба прогона описывались в корневом `vitest.workspace.ts` —
 * вложенных workspace у Vitest нет, а `test.projects` появился только
 * в третьей версии. Под Turborepo эта помеха исчезла: каждый пакет
 * запускается сам по себе, и вложенности не возникает. Побочная
 * выгода — `pnpm --filter @td/sim test` теперь тоже проверяет оба
 * окружения, а не одно из двух молча.
 *
 * `defaultExclude` дописан руками: свой `exclude` ЗАМЕНЯЕТ список
 * по умолчанию, а не дополняет его.
 */
export default defineConfig({
  test: {
    name: 'sim',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...defaultExclude, 'src/**/*.match.test.ts'],
  },
});
