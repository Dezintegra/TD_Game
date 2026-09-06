#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

// На Windows npm кладёт codex.cmd в PATH. Запускаем его JS-точку входа
// через Node: аргументы остаются массивом, shell и его интерполяции нет.
const [command = 'codex', ...args] = process.argv.slice(2);
const dirs =
  isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [dirname(resolve(command))]
    : (process.env.PATH ?? '').split(delimiter);
let program = command;
let forwarded = args;
if (process.platform === 'win32' && !command.endsWith('.exe')) {
  const isCodexName = ['codex', 'codex.cmd', 'codex.ps1'].includes(basename(command));
  const found = isCodexName
    ? dirs
        .map((dir) => {
          const executable = join(dir, 'codex.exe');
          const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
          return existsSync(executable) ? { executable } : existsSync(script) ? { script } : null;
        })
        .find(Boolean)
    : null;
  const { script, executable } = found ?? {};
  if (command.endsWith('.js') || command.endsWith('.mjs')) {
    program = process.execPath;
    forwarded = [resolve(command), ...args];
  } else if (executable) {
    program = executable;
  } else if (script) {
    program = process.execPath;
    forwarded = [script, ...args];
  } else {
    console.error(
      `Не найден исполняемый Codex: ${command}. Укажите codexCommand до codex.exe или bin/codex.js.`,
    );
    process.exit(1);
  }
}
const child = spawn(program, forwarded, { stdio: 'inherit', windowsHide: true });
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
