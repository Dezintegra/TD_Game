import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Быстрый набор арены.
 *
 * Оба нынешних файла арены матчевые, так что быстрый набор здесь
 * пока пуст — и это нормально: конфигурация нужна, чтобы новый
 * быстрый тест не пришлось заводить вместе с оснасткой.
 *
 * `passWithNoTests` включён именно поэтому. На пустом наборе Vitest
 * по умолчанию завершается с ошибкой, и `pnpm test` по всему
 * репозиторию краснел бы на арене, ничего при этом не сломав.
 * Флаг стоит ТОЛЬКО здесь: в остальных пакетах пустой набор означал бы
 * ошибку в `include`, и падение там — полезное.
 *
 * `defaultExclude` дописан руками: свой `exclude` ЗАМЕНЯЕТ список
 * по умолчанию, а не дополняет его.
 */
export default defineConfig({
  test: {
    name: 'arena',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...defaultExclude, 'src/**/*.match.test.ts'],
    passWithNoTests: true,
  },
});
