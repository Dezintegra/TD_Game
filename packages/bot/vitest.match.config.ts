import { defineConfig } from 'vitest/config';

/**
 * Матчевый набор пакета — компьютер играет по протоколу.
 *
 * `participant.match.test.ts` берёт настоящего ведущего из `@td/netplay`
 * и разговаривает с ним настоящими закодированными кадрами: подставлен
 * только провод между ними. Всё остальное — как в бою, включая билет,
 * задержку ввода и назначение тиков, а значит и цену прогона.
 */
export default defineConfig({
  test: {
    name: 'bot:match',
    environment: 'node',
    include: ['src/**/*.match.test.ts'],
  },
});
