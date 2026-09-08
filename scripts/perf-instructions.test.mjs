import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parsePerfOptions } from './perf-options.mjs';

it('проверка готовности и замер в инструкции используют одну пару ключей', () => {
  const source = readFileSync(
    new URL('../supervisor/skills/benchmark.md', import.meta.url),
    'utf8',
  );
  const commands = [...source.matchAll(/pnpm e2e:perf[^`\r\n]*/g)]
    .map(([command]) => command.trim())
    .filter((command) => !command.includes('--history'));
  expect(commands).toHaveLength(2);
  const options = commands.map((command) => parsePerfOptions(command.split(/\s+/).slice(2)));
  expect(options.map(({ checkOnly }) => checkOnly)).toEqual([true, false]);
  expect(options[0].ports).toEqual(options[1].ports);
  expect(Object.keys(options[0].ports).sort()).toEqual(['clientPort', 'serverPort']);
  expect(options[0].passthrough).toEqual([]);
  expect(options[1].passthrough).toEqual([]);
  expect(source).not.toMatch(/CLIENT_PORT=|PORT=/);
  expect(source).toContain('```powershell\n' + '      ' + commands[1]);
});
