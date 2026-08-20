import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared',
  'packages/protocol',
  'packages/ui',
  'packages/ai',
  'apps/server',
  'apps/client',
  'apps/arena',

  // Ядро симуляции обязано вести себя одинаково в браузере и на сервере,
  // поэтому один и тот же набор тестов прогоняется в двух окружениях.
  // Расхождение результатов означает, что в ядро просочилась платформенная
  // зависимость — ровно то, что мы хотим поймать до продакшна.
  //
  // Оба прогона описаны здесь, а не в конфиге пакета: вложенные workspace
  // Vitest не поддерживает, а ключ `test.projects` появился только
  // в третьей версии.
  {
    test: {
      name: 'sim:node',
      root: './packages/sim',
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'sim:browser',
      root: './packages/sim',
      environment: 'jsdom',
      include: ['src/**/*.test.ts'],
    },
  },
]);
