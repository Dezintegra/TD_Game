import { spawnSync } from 'node:child_process';

/** Замер запускает собранные службы без watch; клиентскую сборку готовит Vite. */
export function preparePerfPackages(cwd, run = spawnSync) {
  const result = run(
    'pnpm',
    [
      '--filter',
      './packages/**',
      '--filter',
      '@td/server',
      '--filter',
      '@td/computer',
      '--workspace-concurrency=1',
      '-r',
      'build',
    ],
    {
      cwd,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`сборка пакетов завершилась с кодом ${result.status}`);
}
