import { spawnSync } from 'node:child_process';

/** Свежему дереву нужны dist библиотек для dev-серверов; полный build игры не нужен. */
export function preparePerfPackages(cwd, run = spawnSync) {
  const result = run(
    'pnpm',
    ['--filter', './packages/**', '--workspace-concurrency=1', '-r', 'build'],
    {
      cwd,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`сборка пакетов завершилась с кодом ${result.status}`);
}
