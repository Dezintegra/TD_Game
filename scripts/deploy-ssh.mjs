import { isAbsolute } from 'node:path';

/** Аргументы передаются напрямую OpenSSH, без сборки shell-команды. */
export function deploySshOptions(env = process.env) {
  const path = env.TD_DEPLOY_SSH_CONFIG;
  if (path !== undefined && (!path || !isAbsolute(path)))
    throw new Error('TD_DEPLOY_SSH_CONFIG: требуется абсолютный путь к SSH config');
  return [
    ...(path === undefined ? [] : ['-F', path]),
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'StrictHostKeyChecking=yes',
  ];
}

export function deploySshHost(host = process.env.TD_DEPLOY_HOST ?? 'dezintegra') {
  if (!/^[a-zA-Z0-9_[\]][a-zA-Z0-9_.@:[\]-]*$/.test(host))
    throw new Error('TD_DEPLOY_HOST: требуется SSH-псевдоним или адрес');
  return host;
}
