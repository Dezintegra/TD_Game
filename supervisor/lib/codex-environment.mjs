import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';

/** У sandbox свой пользователь: системное хранилище gh владельца ему недоступно. */
export function codexChildEnvironment({
  env = process.env,
  getToken = () =>
    execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
} = {}) {
  let token;
  try {
    token = String(env.GH_TOKEN || env.GITHUB_TOKEN || getToken()).trim();
  } catch {
    throw new Error(
      'Нет авторизации GitHub для Codex: выполните gh auth login под владельцем конвейера.',
    );
  }
  if (!token) throw new Error('Пустая авторизация GitHub для Codex.');
  // Токен передаётся только окружением: не включать этот объект в журналы и config.
  const childEnv = {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key)),
    ),
    GH_TOKEN: token,
  };

  return childEnv;
}

/** Секреты остаются в окружении; Git не запускает MSYS credential helper. */
export function codexGitEnvironment(env, root, cwd) {
  if (!env) return undefined;
  if (!env.GH_TOKEN) throw new Error('Нет GitHub-авторизации для Git в Codex.');
  const result = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)|GIT_TRACE.*|GIT_CURL_VERBOSE)$/i.test(
          key,
        ),
    ),
  );
  const entries = [
    ['safe.directory', ''],
    ['safe.directory', resolve(root).replaceAll('\\', '/')],
    ['safe.directory', resolve(cwd).replaceAll('\\', '/')],
    ['credential.https://github.com.helper', ''],
    ['http.https://github.com/.extraheader', ''],
    [
      'http.https://github.com/.extraheader',
      'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + env.GH_TOKEN).toString('base64'),
    ],
  ];
  result.GIT_CONFIG_COUNT = String(entries.length);
  result.GIT_TERMINAL_PROMPT = '0';
  entries.forEach(([key, value], i) => {
    result['GIT_CONFIG_KEY_' + i] = key;
    result['GIT_CONFIG_VALUE_' + i] = value;
  });
  return result;
}
