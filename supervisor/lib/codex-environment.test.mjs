import { expect, it } from 'vitest';
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
