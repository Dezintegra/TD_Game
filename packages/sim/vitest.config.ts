import { defineConfig } from 'vitest/config';

/**
 * Конфигурация для запуска тестов только этого пакета
 * (`pnpm --filter @td/sim test`) — одно окружение, для быстрой обратной связи.
 *
 * Прогон в двух окружениях, node и браузерном, описан в корневом
 * `vitest.workspace.ts` и выполняется командой `pnpm test`. Именно он
 * проверяет изоморфность ядра и запускается в CI.
 */
export default defineConfig({
  test: {
    name: 'sim',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
