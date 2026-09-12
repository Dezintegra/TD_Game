import { spawnSync } from 'node:child_process';

function check(program, args, marker) {
  const child = spawnSync(program, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0 || child.stdout.trim() !== marker) {
    throw new Error(`child process failed: exit ${child.status}`);
  }
}

try {
  check(process.execPath, ['-e', 'process.stdout.write("td-node-child")'], 'td-node-child');
  if (process.platform === 'win32') {
    check(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'echo td-shell-child'],
      'td-shell-child',
    );
  }
  process.stdout.write('td-codex-processes-ready');
} catch (error) {
  process.stderr.write(`Node child process check failed: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
}
