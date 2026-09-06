import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Дескрипторы своих детей позволяют обойтись без системного перечисления taskkill. */
export async function startPerfServices(
  specs,
  { launch = spawn, ready = httpReady, timeoutMs = 60_000 } = {},
) {
  const children = [];
  const stopOwn = () => {
    for (const { child } of children)
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
  };
  process.once('exit', stopOwn);
  const stop = async () => {
    stopOwn();
    await Promise.race([
      Promise.all(children.map(({ closed }) => closed)),
      sleep(5000, undefined, { ref: false }).then(() => {
        throw new Error('не завершились собственные службы замера');
      }),
    ]);
    process.removeListener('exit', stopOwn);
  };
  try {
    for (const spec of specs) {
      const child = launch(process.execPath, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: 'inherit',
        windowsHide: true,
      });
      let failure;
      const closed = new Promise((resolve) => {
        child.once('error', (error) => {
          failure = error;
          resolve();
        });
        child.once('exit', () => {
          failure ??= new Error(`служба ${spec.name} завершилась до готовности`);
          resolve();
        });
      });
      children.push({ child, closed });
      const deadline = Date.now() + timeoutMs;
      while (!(await ready(spec.url))) {
        if (failure) throw failure;
        if (Date.now() >= deadline) throw new Error(`служба ${spec.name} не готова: ${spec.url}`);
        await sleep(100);
      }
      if (failure) throw failure;
    }
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function httpReady(url) {
  try {
    const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(1000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export function perfServiceSpecs(root, env = process.env) {
  const server = `http://127.0.0.1:${env.PORT ?? 3001}`;
  const metricsPort = String(env.COMPUTER_METRICS_PORT ?? Number(env.PORT ?? 3001) + 1);
  const secret = env.COMPUTER_SECRET ?? 'e2e-секрет';
  const clientRoot = join(root, 'apps/client');
  const require = createRequire(join(clientRoot, 'package.json'));
  const vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  return [
    {
      name: 'server',
      args: ['dist/main.js'],
      cwd: join(root, 'apps/server'),
      url: `${server}/health`,
      env: { ...env, COMPUTER_SECRET: secret },
    },
    {
      name: 'computer',
      args: ['dist/main.js'],
      cwd: join(root, 'apps/computer'),
      url: `http://127.0.0.1:${metricsPort}/metrics`,
      env: {
        ...env,
        COMPUTER_SECRET: secret,
        COMPUTER_METRICS_PORT: metricsPort,
        COMPUTER_API_URL: server,
        COMPUTER_WS_URL: server.replace('http:', 'ws:') + '/game',
      },
    },
    {
      name: 'client',
      args: [vite],
      cwd: clientRoot,
      url: `http://127.0.0.1:${env.CLIENT_PORT ?? 5173}`,
      env: {
        ...env,
        VITE_API_URL: server,
        VITE_WS_URL: server.replace('http:', 'ws:') + '/game',
        VITE_E2E_CHEAP_TEXTURES: '0',
      },
    },
  ];
}
