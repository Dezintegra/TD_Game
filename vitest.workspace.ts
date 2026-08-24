import { defineWorkspace } from 'vitest/config';

/**
 * Прогон всего репозитория одним процессом Vitest.
 *
 * Это больше НЕ точка входа `pnpm test`: с разделения наборов той
 * заведует Turborepo (`turbo run test`), и только он умеет не считать
 * заново то, что не менялось. Файл остаётся для разовых запусков
 * вручную — например, когда нужно прогнать один тест по имени сразу
 * по всем пакетам: `pnpm exec vitest run -t "<имя>"`.
 *
 * Набор здесь быстрый: каждый пакет приходит со своим
 * `vitest.config.ts`, а тот исключает `*.match.test.ts`. Матчевые
 * прогоняются командой `pnpm test:match`.
 *
 * Двойного описания `packages/sim` здесь больше нет. Прогон ядра
 * в двух окружениях переехал в команды самого пакета
 * (`vitest run && vitest run --environment jsdom`): под Turborepo
 * каждый пакет запускается отдельным процессом, и прежняя помеха —
 * отсутствие вложенных workspace у Vitest 2 — перестала мешать.
 * Заодно изоморфность стала проверяться и при запуске пакета
 * в отдельности, а не только из корня.
 */
export default defineWorkspace([
  'packages/shared',
  'packages/protocol',
  'packages/ui',
  'packages/sim',
  'packages/ai',
  'packages/netplay',
  'packages/bot',
  'apps/server',
  'apps/client',
  'apps/arena',
]);
