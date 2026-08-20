import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'arena',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
