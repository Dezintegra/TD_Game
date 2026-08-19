import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ui',
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
    // Testing Library вешает автоматическую очистку DOM на глобальный
    // afterEach. Без globals: true этого хука нет, и разметка предыдущего
    // теста остаётся в документе — запросы начинают находить по два элемента.
    globals: true,
  },
  esbuild: {
    jsx: 'automatic',
  },
});
