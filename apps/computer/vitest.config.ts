import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Быстрый набор службы дежурных.
 *
 * Матчевых тестов здесь нет и быть не должно: приложение содержит только
 * точку входа, а матч ведёт `@td/bot` — там он и проверяется.
 *
 * `defaultExclude` дописан руками: свой `exclude` ЗАМЕНЯЕТ список
 * по умолчанию, а не дополняет его.
 */
export default defineConfig({
  test: {
    name: 'computer',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...defaultExclude, 'src/**/*.match.test.ts'],
  },
});
