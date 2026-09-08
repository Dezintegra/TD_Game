import { parsePerfOptions } from './perf-options.mjs';

export function deployPerfArgs(argv) {
  // Проверяем только явные ключи: без них deploy наследует прежнее окружение.
  const { ports } = parsePerfOptions(argv);
  const args = ['e2e:perf'];
  if (ports.clientPort !== undefined) args.push('--client-port', String(ports.clientPort));
  if (ports.serverPort !== undefined) args.push('--port', String(ports.serverPort));
  return args;
}
