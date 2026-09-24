import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { repoRoot, sourceAliases } from './source-aliases.mjs';
import { validateSelection } from './source-runner.mjs';

const selection = validateSelection(
  JSON.parse(process.env.TD_SOURCE_SELECTION || 'null'),
  repoRoot,
);

export default defineConfig({
  resolve: { alias: sourceAliases() },
  test: {
    root: resolve(repoRoot, 'scripts/testing'),
    include: selection.files.map((file: string) => resolve(repoRoot, file).replaceAll('\\', '/')),
    environment: selection.environment,
    pool: 'threads',
    minWorkers: 1,
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    retry: 0,
    testTimeout: 590000,
    hookTimeout: 10000,
    passWithNoTests: false,
  },
});
