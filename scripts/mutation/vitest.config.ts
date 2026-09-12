import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('../../', import.meta.url));
const descriptor = JSON.parse(process.env.TD_MUTATION_DESCRIPTOR || '{}');
const requireVitest = createRequire(createRequire(import.meta.url).resolve('vitest/package.json'));

export default defineConfig({
  resolve: {
    alias: {
      '@td/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@td/sim': resolve(root, 'packages/sim/src/index.ts'),
      '@vitest/runner': requireVitest.resolve('@vitest/runner'),
    },
  },
  test: {
    root: resolve(root, 'packages/sim'),
    include: [resolve(root, descriptor.pair?.testFile || '__missing__').replaceAll('\\', '/')],
    environment: 'node',
    pool: 'threads',
    minWorkers: 1,
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    retry: 0,
    sequence: { hooks: 'stack' },
    testTimeout: descriptor.testTimeoutMs || 590000,
    hookTimeout: 10000,
    setupFiles: [resolve(root, 'scripts/mutation/setup.ts')],
    reporters: [resolve(root, 'scripts/mutation/reporter.ts')],
  },
});
