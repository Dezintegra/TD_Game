import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['mutation/run.acceptance.mjs'],
    testTimeout: 600000,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
