import { defineConfig, devices } from '@playwright/test';

/**
 * E2E проверяет сквозную вертикаль целиком: клиент, протокол, сервер.
 * Playwright сам поднимает оба процесса перед прогоном и гасит после.
 */

// Порты читаются из среды теми же именами, которые понимают сами
// приложения: клиент — CLIENT_PORT (apps/client/vite.config.ts),
// сервер — PORT (apps/server/src/config.ts). Благодаря этому прогон
// e2e можно вести из нескольких рабочих деревьев сразу, не деля
// одну пару портов на всех.
const CLIENT_PORT = Number(process.env['CLIENT_PORT'] ?? 5173);
const SERVER_PORT = Number(process.env['PORT'] ?? 3001);

const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Замеры частоты кадров сюда не входят. Им нужна тихая машина и живая
  // видеокарта, а обычный прогон идёт и на занятой машине, и на runner'ах
  // GitHub, где видеокарты нет вовсе. Их набор — `playwright.perf.config.ts`,
  // запуск — `pnpm e2e:perf`.
  testIgnore: ['**/*.perf.spec.ts'],
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: CLIENT_URL,
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
      url: `${SERVER_URL}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @td/client dev',
      url: CLIENT_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      // Адрес сервера доезжает до клиента только через VITE_*-переменные,
      // их читают apps/client/src/game/bootstrap.ts и session/lobby-client.ts.
      // Без этой передачи клиент на нестандартном порту сервера стучался бы
      // в зашитый по умолчанию 3001, то есть в чужое рабочее дерево, —
      // и прогон проверял бы чужой код.
      //
      // Явно заданное снаружи значение уважается: так прогон можно нацелить
      // на уже поднятый сервер.
      env: {
        VITE_API_URL: process.env['VITE_API_URL'] ?? SERVER_URL,
        VITE_WS_URL: process.env['VITE_WS_URL'] ?? `ws://127.0.0.1:${SERVER_PORT}/game`,
      },
    },
  ],
});
