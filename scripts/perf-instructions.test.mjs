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

const deploySource = readFileSync(
  new URL('../supervisor/skills/deploy.md', import.meta.url),
  'utf8',
);

function checkDeployCommands(source) {
  const step = source.match(/^8\. [\s\S]*?(?=^9\. )/m)?.[0];
  expect(step, 'шаг замера присутствует').toBeDefined();
  const blocks = [...step.matchAll(/^[ \t]*```powershell\r?\n([\s\S]*?)^[ \t]*```/gm)].map(
    ([, body]) => body.trim(),
  );
  expect(blocks).toHaveLength(3);
  const options = blocks.map((command) => {
    expect(command).not.toMatch(/(?:\$env:)?\b(?:CLIENT_PORT|PORT|VITE_API_URL|VITE_WS_URL)\s*=/i);
    expect(command).toMatch(/^pnpm e2e:perf(?:[ \t]+[^\r\n]+)?$/);
    expect(command).not.toMatch(/[;&|`]/);
    return parsePerfOptions(command.split(/\s+/).slice(2));
  });
  expect(options).toEqual([
    {
      ports: { clientPort: 5199, serverPort: 3055 },
      checkOnly: true,
      history: false,
      force: false,
      passthrough: [],
    },
    {
      ports: { clientPort: 5199, serverPort: 3055 },
      checkOnly: false,
      history: false,
      force: false,
      passthrough: [],
    },
    { ports: {}, checkOnly: false, history: true, force: false, passthrough: [] },
  ]);
  return blocks;
}

it('выкладка проверяет и использует явные порты отдельными командами', () => {
  checkDeployCommands(deploySource);
});

// Порчим текст в памяти: проверки инструкции не должны запускать сам замер.
function replaceCommand(command, replacement) {
  // Полная строка отличает запуск от проверки с тем же префиксом.
  const lines = deploySource.split('\n');
  expect(lines.filter((line) => line.trim() === command)).toHaveLength(1);
  return lines
    .map((line) => (line.trim() === command ? line.replace(command, replacement) : line))
    .join('\n');
}

for (const index of [0, 1]) {
  for (const flag of ['--client-port 5199', '--port 3055']) {
    it(`выкладка обнаруживает потерю ${flag} в вызове ${index}`, () => {
      const command = checkDeployCommands(deploySource)[index];
      const broken = replaceCommand(command, command.replace(flag, ''));
      expect(() => checkDeployCommands(broken)).toThrow();
    });
  }
  for (const port of ['5199', '3055']) {
    it(`выкладка обнаруживает замену ${port} только в вызове ${index}`, () => {
      const command = checkDeployCommands(deploySource)[index];
      const broken = replaceCommand(command, command.replace(port, String(Number(port) + 10)));
      expect(() => checkDeployCommands(broken)).toThrow();
    });
  }
}

for (const name of ['CLIENT_PORT', 'PORT', 'VITE_API_URL', 'VITE_WS_URL']) {
  it(`выкладка отвергает отдельное присваивание ${name}`, () => {
    const command = checkDeployCommands(deploySource)[0];
    const broken = replaceCommand(command, `$env:${name} = '3055'\n   ${command}`);
    expect(() => checkDeployCommands(broken)).toThrow();
  });
}

it.each(['; pnpm e2e:perf', ' && pnpm e2e:perf', ' | pnpm e2e:perf', '`\n --force'])(
  'выкладка отвергает склейку или перенос: %s',
  (suffix) => {
    const command = checkDeployCommands(deploySource)[0];
    const broken = replaceCommand(command, command + suffix);
    expect(() => checkDeployCommands(broken)).toThrow();
  },
);

it('упоминания perf вне PowerShell-блоков не становятся командами', () => {
  const extra =
    '\nПример в прозе: pnpm e2e:perf. Вставка: `pnpm e2e:perf`.\n' +
    '```json\n{"command":"pnpm e2e:perf"}\n```\n';
  expect(checkDeployCommands(deploySource.replace(/^9\. /m, extra + '9. '))).toEqual(
    checkDeployCommands(deploySource),
  );
});
