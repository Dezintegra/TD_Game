import { defineConfig } from 'vitest/config';

/**
 * Матчевый набор сервера — ведение матча и его запись.
 *
 * Оба файла ведут настоящий матч и пишут записи во временный каталог,
 * а не в общий `.matchlog`: проверка не должна подмешивать выдуманные
 * матчи к настоящим, которые потом попадут в сводку.
 */
export default defineConfig({
  test: {
    name: 'server:match',
    environment: 'node',
    include: ['src/**/*.match.test.ts'],
  },
});
