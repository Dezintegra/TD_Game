import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { runLaunch, parseLaunchArgs, spawnSupervisor } from '../launch.mjs';

const [mode, suppliedRoot, id = 'first'] = process.argv.slice(2);
const base = realpathSync(
  fileURLToPath(new URL('../../../.matchlog/watch-supervisor-tests/', import.meta.url)),
);
const root = realpathSync(resolve(suppliedRoot));
if (
  dirname(root) !== base ||
  !basename(root).startsWith('case-') ||
  !['first', 'second'].includes(id)
) {
  throw new Error('Fixture root or writer identity is not owned by this test');
}
if (readFileSync(join(root, 'owner'), 'utf8') !== '0126-watch-lifetime')
  throw new Error('Missing fixture owner');

if (mode === 'writer') {
  // Никакой доски и настоящего замка: только изолированный корень пробы.
  writeFileSync(join(root, '.pipeline/supervisor.lock'), JSON.stringify({ pid: process.pid }));
  writeFileSync(join(root, `${id}.identity.json`), JSON.stringify({ pid: process.pid, root, id }));
  let previous = '';
  const deadline = Date.now() + 30_000;
  console.log(`${id}:out:ready`);
  console.error(`${id}:err:ready`);
  while (Date.now() < deadline && !existsSync(join(root, `stop-${id}`))) {
    const command = existsSync(join(root, 'command'))
      ? readFileSync(join(root, 'command'), 'utf8')
      : '';
    if (command && command !== previous) {
      console.log(`${id}:out:${command}`);
      console.error(`${id}:err:${command}`);
      previous = command;
    }
    await sleep(50);
  }
  writeFileSync(join(root, `${id}.finished`), 'done');
} else if (mode === 'launch' || mode === 'watch') {
  const controller = new globalThis.AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Ограничен и зависший наблюдатель: ошибка теста не оставляет вечный процесс.
  const timeout = new globalThis.AbortController();
  const lifetime = sleep(30_000, undefined, { signal: timeout.signal }).then(stop, () => {});
  try {
    process.exitCode = await runLaunch(
      {
        options: parseLaunchArgs(mode === 'watch' ? ['--watch'] : []),
        root,
        explicitRoot: root,
        entry: fileURLToPath(import.meta.url),
        signal: controller.signal,
      },
      {
        spawn: async (params) => {
          const child = await spawnSupervisor({
            ...params,
            argv: [fileURLToPath(import.meta.url), 'writer', root, id],
          });
          writeFileSync(join(root, 'spawn.json'), JSON.stringify({ pid: child.pid, root, id }));
          return child;
        },
      },
    );
  } finally {
    timeout.abort();
    await lifetime;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
} else {
  throw new Error('Unknown fixture mode');
}
