import { execFileSync } from 'node:child_process';

/** Тайм-аут задаёт вызывающий код: прочие команды сохраняют прежний режим. */
export function createCommandRunner(root, exec = execFileSync) {
  return (args, program = 'git', cwd = root, { timeout } = {}) => {
    try {
      const stdout = exec(program, args, {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        // Фоновые проверки не должны открывать окна и забирать фокус.
        windowsHide: true,
        ...(timeout === undefined ? {} : { timeout }),
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      return {
        code: error.status ?? 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr || error.message || '',
      };
    }
  };
}
