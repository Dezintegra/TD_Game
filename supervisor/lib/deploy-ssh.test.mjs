import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deploySshHost, deploySshOptions } from '../../scripts/deploy-ssh.mjs';

describe('конфигурация SSH конвейера', () => {
  it('сохраняет OpenSSH defaults без настройки и запрещает интерактивные запросы', () => {
    expect(deploySshOptions({})).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'StrictHostKeyChecking=yes',
    ]);
  });
  it('передаёт путь с пробелами и shell-символами одним аргументом', () => {
    const path = resolve('pipeline config $(echo nope)');
    expect(deploySshOptions({ TD_DEPLOY_SSH_CONFIG: path }).slice(0, 2)).toEqual(['-F', path]);
  });
  it.each(['', 'relative/config'])('отклоняет неверный путь %s', (path) => {
    expect(() => deploySshOptions({ TD_DEPLOY_SSH_CONFIG: path })).toThrow('абсолютный путь');
  });
  it.each(['-F', 'host; whoami', 'host\ntrue'])('отклоняет неверный host %s', (host) => {
    expect(() => deploySshHost(host)).toThrow('SSH');
  });
  it('возвращает ненулевой статус при отсутствующем явном config без сетевого подключения', () => {
    const script = fileURLToPath(new URL('../../scripts/deploy-remote.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [script, '--host', 'invalid.example', '--', 'true'],
      {
        env: { ...process.env, TD_DEPLOY_SSH_CONFIG: resolve('nonexistent-ssh-config') },
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/config/i);
  });
});
