import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { perfServiceSpecs, startPerfServices } from '../../scripts/perf-services.mjs';

const children = [];
const launch = (program, args, opts) => {
  const child = spawn(program, args, { ...opts, stdio: 'ignore' });
  children.push(child);
  return child;
};
const spec = (name) => ({
  name,
  cwd: process.cwd(),
  env: process.env,
  args: ['-e', 'setInterval(()=>{},1000)'],
  url: name,
});
afterEach(() => {
  for (const child of children.splice(0))
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
});

it('завершает только запущенные служебные процессы, повторная остановка безопасна', async () => {
  const foreign = launch(process.execPath, spec('foreign').args, {});
  const managed = await startPerfServices([spec('one'), spec('two')], {
    launch,
    ready: async () => true,
  });
  await managed.stop();
  await managed.stop();
  expect(
    children.slice(1).every((child) => child.exitCode !== null || child.signalCode !== null),
  ).toBe(true);
  expect(foreign.exitCode).toBeNull();
  expect(foreign.signalCode).toBeNull();
});

it('не готовая вторая служба останавливает также первую', async () => {
  await expect(
    startPerfServices([spec('ready'), spec('broken')], {
      launch,
      ready: async (url) => url === 'ready',
      timeoutMs: 1,
    }),
  ).rejects.toThrow('не готова');
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
    true,
  );
});

it('ошибка spawn не остаётся необработанной и не подвешивает остановку', async () => {
  await expect(
    startPerfServices([spec('missing')], {
      launch: () => spawn('td-nonexistent-perf-service-123456'),
      ready: async () => false,
    }),
  ).rejects.toThrow();
});

it('все службы используют назначенные порты и тот же секрет, клиент сохраняет прогрев', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const [server, computer, client] = perfServiceSpecs(root, {
    PORT: '3065',
    CLIENT_PORT: '5209',
    COMPUTER_METRICS_PORT: '3067',
    COMPUTER_SECRET: 'test-secret',
  });
  expect(server.url).toBe('http://127.0.0.1:3065/health');
  expect(computer.url).toBe('http://127.0.0.1:3067/metrics');
  expect(computer.env.COMPUTER_SECRET).toBe(server.env.COMPUTER_SECRET);
  expect(computer.env.COMPUTER_WS_URL).toBe('ws://127.0.0.1:3065/game');
  expect(client.url).toBe('http://127.0.0.1:5209');
  expect(client.env.VITE_API_URL).toBe('http://127.0.0.1:3065');
  expect(client.env.VITE_E2E_CHEAP_TEXTURES).toBe('0');
});
