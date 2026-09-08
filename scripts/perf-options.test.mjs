import { describe, expect, it } from 'vitest';
import { parsePerfOptions, resolvePerfPorts } from './perf-options.mjs';

const resolve = (args = [], env = {}) => resolvePerfPorts(parsePerfOptions(args).ports, env);

describe('порты замера', () => {
  it('сохраняет умолчания и числовое преобразование окружения', () => {
    expect(resolve()).toMatchObject({ clientPort: 5173, serverPort: 3001, metricsPort: 3002 });
    expect(
      resolve([], { CLIENT_PORT: ' 5200 ', PORT: '3e3', COMPUTER_METRICS_PORT: '4000' }),
    ).toMatchObject({ clientPort: 5200, serverPort: 3000, metricsPort: 4000 });
  });
  it.each([
    ['--client-port', '5199', '--port=3055'],
    ['--client-port=5199', '--port', '3055'],
  ])('принимает формы ключей %j', (...args) => {
    const env = { CLIENT_PORT: 'bad', PORT: 'bad', VITE_API_URL: 'old' };
    const result = resolve(args, env);
    expect(result).toMatchObject({ clientPort: 5199, serverPort: 3055, metricsPort: 3056 });
    expect(result.env).toMatchObject({ PORT: '3055', VITE_API_URL: 'http://127.0.0.1:3055' });
    expect(env.VITE_API_URL).toBe('old');
  });
  it('переопределяет порты независимо', () => {
    expect(resolve(['--port=3055'], { CLIENT_PORT: '5200' }).clientPort).toBe(5200);
    expect(resolve(['--client-port=5200'], { PORT: '3055' }).serverPort).toBe(3055);
    expect(resolve(['--port=65535'], { COMPUTER_METRICS_PORT: '1' }).metricsPort).toBe(1);
    expect(resolve(['--client-port=1']).clientPort).toBe(1);
  });
  it.each(['0', '65536', '-1', '1.5', '3e3', '3055abc', '', ' 3055 ', '+3055'])(
    'отвергает явное значение %j',
    (value) => {
      for (const key of ['--port', '--client-port']) {
        expect(() => parsePerfOptions([key, value])).toThrow(key);
        expect(() => parsePerfOptions([`${key}=${value}`])).toThrow(key);
      }
    },
  );
  it.each(['--port', '--client-port'])('отвергает отсутствие и повтор %s', (key) => {
    expect(() => parsePerfOptions([key])).toThrow(key);
    expect(() => parsePerfOptions([key, '--force'])).toThrow(key);
    expect(() => parsePerfOptions([key, '3055', `${key}=3055`])).toThrow('повтор');
  });
  it.each([
    { PORT: '65535' },
    { PORT: 'bad' },
    { CLIENT_PORT: '0' },
    { COMPUTER_METRICS_PORT: '1.5' },
    { CLIENT_PORT: '3001' },
    { CLIENT_PORT: '3002' },
    { COMPUTER_METRICS_PORT: '3001' },
  ])('отвергает конфигурацию %j', (env) => expect(() => resolve([], env)).toThrow());
  it('сохраняет хвост и границу Playwright', () => {
    expect(
      parsePerfOptions([
        '--',
        '--port=3055',
        '--grep',
        'camera',
        '--project=chromium',
        '--force',
        '--',
        '--port',
        '1234',
        '--history',
      ]),
    ).toMatchObject({
      ports: { serverPort: 3055 },
      force: true,
      history: false,
      passthrough: ['--grep', 'camera', '--project=chromium', '--', '--port', '1234', '--history'],
    });
  });
});
