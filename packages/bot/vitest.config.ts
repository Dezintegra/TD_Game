import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Быстрый набор пакета.
 *
 * Конфигурация заведена вместе с разделением наборов. Раньше пакет
 * жил на умолчаниях Vitest через корневой workspace — этого хватало,
 * пока набор был один.
 *
 * `defaultExclude` дописан руками: свой `exclude` ЗАМЕНЯЕТ список
 * по умолчанию, а не дополняет его.
 */
export default defineConfig({
  test: {
    name: 'bot',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...defaultExclude, 'src/**/*.match.test.ts'],
  },
});
