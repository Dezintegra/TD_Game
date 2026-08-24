import { defineConfig } from 'vitest/config';

/**
 * Матчевый набор пакета — тесты, которым нужна партия целиком.
 *
 * Здесь живёт почти вся стоимость прогона по репозиторию: шесть файлов
 * этого пакета занимали 1388 секунд из 2016 (замер 24.08.2026).
 * Запускается по явной просьбе, `pnpm test:match`, и в CI.
 */
export default defineConfig({
  test: {
    name: 'ai:match',
    environment: 'node',
    include: ['src/**/*.match.test.ts'],
  },
});
