import { defineConfig } from 'vitest/config';

/**
 * Ядро симуляции обязано вести себя одинаково в браузере и на сервере,
 * поэтому один и тот же набор тестов прогоняется в двух окружениях.
 * Расхождение результатов означает, что в ядро просочилась платформенная
 * зависимость — ровно то, что мы хотим поймать до продакшна.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'sim:node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'sim:browser-like',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
        },
      },
    ],
  },
});
