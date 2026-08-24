import { defineConfig } from 'vitest/config';

/**
 * Матчевый набор пакета — сходимость трёх миров.
 *
 * `convergence.match.test.ts` проигрывает матч целиком: ведущий
 * и два участника считают мир независимо, а проверяется, что все три
 * сходятся тик в тик по контрольной сумме. Это главное свойство всей
 * затеи с синхронизацией входов, и дешевле его не проверить.
 */
export default defineConfig({
  test: {
    name: 'netplay:match',
    environment: 'node',
    include: ['src/**/*.match.test.ts'],
  },
});
