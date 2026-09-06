import { expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { codexChildEnvironment } from './codex-environment.mjs';
it('передаёт только GitHub-токен, не наследует секреты доски и не меняет исходную среду', () => {
  const env = { PATH: 'tools', TRELLO_TOKEN: 'board-secret', OPENAI_API_KEY: 'api-secret' };
  expect(codexChildEnvironment({ env, getToken: () => ' github-test-token\n' })).toEqual({
    PATH: 'tools',
    GH_TOKEN: 'github-test-token',
  });
  expect(env.TRELLO_TOKEN).toBe('board-secret');
});
it('приоритет у явно заданного токена; ошибка чтения не раскрывает stdout/stderr', () => {
  expect(
    codexChildEnvironment({
      env: { GH_TOKEN: 'explicit' },
      getToken: () => {
        throw new Error('unused');
      },
    }).GH_TOKEN,
  ).toBe('explicit');
  expect(() =>
    codexChildEnvironment({
      env: {},
      getToken: () => {
        throw new Error('sensitive detail');
      },
    }),
  ).toThrow('Нет авторизации GitHub');
});

it('задаёт независимую Git-авторизацию без shell и удаляет старые пары окружения', async () => {
  const { codexGitEnvironment } = await import('./codex-environment.mjs');
  const { resolve } = await import('node:path');
  const original = {
    GH_TOKEN: 'test-only',
    GIT_CONFIG_COUNT: '99',
    GIT_CONFIG_KEY_98: 'foreign',
    GIT_CONFIG_VALUE_98: 'foreign-secret',
    GIT_CONFIG_PARAMETERS: 'foreign',
  };
  const first = codexGitEnvironment(original, '/main', '/first');
  const second = codexGitEnvironment(original, '/main', '/second');
  const entries = Array.from({ length: Number(first.GIT_CONFIG_COUNT) }, (_, i) => [
    first['GIT_CONFIG_KEY_' + i],
    first['GIT_CONFIG_VALUE_' + i],
  ]);
  expect(entries.slice(0, 3)).toEqual([
    ['safe.directory', ''],
    ['safe.directory', resolve('/main').replaceAll('\\', '/')],
    ['safe.directory', resolve('/first').replaceAll('\\', '/')],
  ]);
  expect(entries[3]).toEqual(['credential.https://github.com.helper', '']);
  expect(entries[4]).toEqual(['http.https://github.com/.extraheader', '']);
  expect(entries[5][0]).toBe('http.https://github.com/.extraheader');
  expect(Buffer.from(entries[5][1].split(' ').at(-1), 'base64').toString()).toBe(
    'x-access-token:test-only',
  );
  expect(first.GIT_TERMINAL_PROMPT).toBe('0');
  expect(first.GIT_CONFIG_KEY_98).toBeUndefined();
  expect(first.GIT_CONFIG_VALUE_98).toBeUndefined();
  expect(first.GIT_CONFIG_PARAMETERS).toBeUndefined();
  expect(second.GIT_CONFIG_VALUE_2).not.toBe(first.GIT_CONFIG_VALUE_2);
  expect(original.GIT_CONFIG_COUNT).toBe('99');
  expect(original.GIT_CONFIG_VALUE_98).toBe('foreign-secret');
  expect(() => codexGitEnvironment({}, '/main', '/first')).toThrow('GitHub');
});

it('не наследует трассировку Git при передаче HTTP-секрета', async () => {
  const { codexGitEnvironment } = await import('./codex-environment.mjs');
  const env = codexGitEnvironment(
    { GH_TOKEN: 'test', GIT_TRACE: '1', GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1' },
    '/root',
    '/root',
  );
  expect(env.GIT_TRACE).toBeUndefined();
  expect(env.GIT_TRACE_CURL).toBeUndefined();
  expect(env.GIT_CURL_VERBOSE).toBeUndefined();
});
