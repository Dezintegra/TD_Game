import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
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
  if (process.platform === 'win32') {
    const key = Object.keys(childEnv).find((key) => key.toUpperCase() === 'PATH');
    const dirs = String(childEnv[key] ?? '').split(delimiter);
    const gitDir = dirs.find((dir) => existsSync(join(dir, 'git.exe')));
    const shellDir = gitDir ? resolve(gitDir, '..', 'bin') : null;
    // Git credential helper запускается через sh, которого нет в стандартном PATH Windows.
    if (key && shellDir && existsSync(join(shellDir, 'sh.exe')))
      childEnv[key] = shellDir + delimiter + childEnv[key];
  }
  return childEnv;
}
