import { defineConfig } from 'vitest/config';

/**
 * Одно окружение — node. В отличие от ядра симуляции, изоморфность
 * противника проверять двумя прогонами незачем: платформенных
 * зависимостей у него нет и быть не может, а поймает их линт.
 */
export default defineConfig({
  test: {
    name: 'ai',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
