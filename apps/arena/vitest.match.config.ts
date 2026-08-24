import { defineConfig } from 'vitest/config';

/**
 * Матчевый набор арены — прогон, лог, сборка базы, сводка.
 *
 * Оба файла ведут настоящие матчи: `arena` — минуту игры, `replay` —
 * двадцать пять секунд с повтором. Матч внутри файла прогоняется один
 * на все тесты: он детерминирован, тесты его не меняют, и делить один
 * результат безопасно.
 */
export default defineConfig({
  test: {
    name: 'arena:match',
    environment: 'node',
    include: ['src/**/*.match.test.ts'],
  },
});
