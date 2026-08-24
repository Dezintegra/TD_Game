import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Быстрый набор сервера: комнаты, маршруты, настройки.
 *
 * Матчевые файлы исключены — `matches` и `recording` ведут настоящий
 * матч и пишут запись во временный каталог. Их прогоняет
 * `vitest.match.config.ts`.
 *
 * `defaultExclude` дописан руками: свой `exclude` ЗАМЕНЯЕТ список
 * по умолчанию, а не дополняет его.
 */
export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...defaultExclude, 'src/**/*.match.test.ts'],
  },
});
