import { defineConfig, devices } from '@playwright/test';

/**
 * E2E проверяет сквозную вертикаль целиком: клиент, протокол, сервер.
 * Playwright сам поднимает оба процесса перед прогоном и гасит после.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Без этих флагов headless-Chromium рисует через SwiftShader, то есть
          // процессором, и выдаёт около 16 кадров в секунду на любой сцене.
          // Измерять производительность в таком режиме бессмысленно: цифра
          // говорит о среде, а не о коде.
          args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @td/server dev',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @td/client dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
  ],
});
