import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ui',
    environment: 'jsdom',
    // И `.tsx`, и `.ts`: в пакете есть не только компоненты, но и токены,
    // а их проверка разметки не рисует и в `.tsx` попадать не должна.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Testing Library вешает автоматическую очистку DOM на глобальный
    // afterEach. Без globals: true этого хука нет, и разметка предыдущего
    // теста остаётся в документе — запросы начинают находить по два элемента.
    globals: true,
  },
  esbuild: {
    jsx: 'automatic',
  },
});
