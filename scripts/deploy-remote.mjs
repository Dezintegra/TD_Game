#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { deploySshHost, deploySshOptions } from './deploy-ssh.mjs';

const args = process.argv.slice(2);
try {
  const host = deploySshHost(args[0] === '--host' ? args.splice(0, 2)[1] : undefined);
  if (args[0] === '--') args.shift();
  if (args.length !== 1 || !args[0]) throw new Error('Ожидается одна удалённая команда');
  const result = spawnSync('ssh', [...deploySshOptions(), '--', host, args[0]], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
