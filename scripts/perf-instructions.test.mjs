import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { parsePerfOptions } from './perf-options.mjs';

// Контракт намеренно узкий: прямое inline-предписание и строки PowerShell.
// Аргументы проверяются позже, иначе потеря ключа могла бы скрыть сам вызов.
function benchmarkCommands(source) {
  const steps = [];
  let step;
  let fence;
  let offset = 0;
  for (const raw of source.match(/[^\n]*(?:\n|$)/g) ?? []) {
    const line = raw.replace(/\r?\n$/, '');
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        fence = undefined;
      } else if (step && fence.language === 'powershell') {
        const call = line.match(/^[ \t]*(pnpm e2e:perf\b.*)$/);
        if (call)
          step.commands.push({
            command: call[1],
            start: offset + line.indexOf(call[1]),
            kind: 'powershell',
          });
      }
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length, language: marker[2].trim() };
    } else {
      if (/^[0-9]+\. /.test(line)) {
        if (step) step.end = offset;
        step = { title: line, start: offset, end: source.length, commands: [] };
        steps.push(step);
      }
      const call = line.match(/^[ \t]+[0-9]+\. Спроси машину: `(pnpm e2e:perf\b[^`]*)`/);
      if (step && call)
        step.commands.push({
          command: call[1],
          start: offset + line.indexOf(call[1]),
          kind: 'inline',
        });
    }
    offset += raw.length;
  }
  expect(fence, 'парные ограждения').toBeUndefined();
  const perf = steps.filter(({ title }) => title.includes('(`kind: perf`)'));
  expect(perf, 'единственный пункт замера perf').toHaveLength(1);
  return perf[0];
}

function checkBenchmarkCommands(source) {
  const { commands } = benchmarkCommands(source);
  expect(commands, 'подготовка и замер').toHaveLength(2);
  const options = commands.map(({ command }, index) => {
    expect(command).not.toMatch(/[;&|`$]/);
    const parsed = parsePerfOptions(command.split(/\s+/).slice(2));
    expect(Object.keys(parsed.ports).sort()).toEqual(['clientPort', 'serverPort']);
    expect(parsed.passthrough).toEqual([]);
    expect(parsed.history).toBe(false);
    expect(parsed.force).toBe(false);
    expect(parsed.checkOnly).toBe(index === 0);
    return parsed;
  });
  expect(options[0].ports).toEqual(options[1].ports);
  expect(commands[1].kind).toBe('powershell');
  expect(source).not.toMatch(/CLIENT_PORT=|PORT=/);
  return commands.map(({ command }) => command);
}

const benchmarkSource = readFileSync(
  new URL('../supervisor/skills/benchmark.md', import.meta.url),
  'utf8',
);
const fixtureBytes = readFileSync(
  new URL('./fixtures/benchmark-pr-219-1898e4f.txt', import.meta.url),
);
const historicalSource = fixtureBytes.toString('utf8');
const provenance = JSON.parse(
  readFileSync(new URL('./fixtures/benchmark-pr-219-1898e4f.source.json', import.meta.url), 'utf8'),
);

it('исторический снимок совпадает с исходным Git blob PR 219', () => {
  expect(provenance).toEqual({
    repository: 'https://github.com/Dezintegra/TD_Game',
    pr: 219,
    commit: '1898e4fe4d2243d8c9685fd394005292ebe1ab39',
    path: 'supervisor/skills/benchmark.md',
    blobOid: 'a5cc79ee2d1e3e605d48c30a387b0e5ac4924d92',
  });
  expect(
    createHash('sha1').update(`blob ${fixtureBytes.length}\0`).update(fixtureBytes).digest('hex'),
  ).toBe(provenance.blobOid);
});

it('прежняя глобальная выборка ошибочно находила три запуска в PR 219', () => {
  const oldCommands = [...historicalSource.matchAll(/pnpm e2e:perf[^`\r\n]*/g)]
    .map(([command]) => command.trim())
    .filter((command) => !command.includes('--history'));
  expect(oldCommands).toHaveLength(3);
  expect(checkBenchmarkCommands(historicalSource)).toHaveLength(2);
});

const preparation = 'pnpm e2e:perf -- --client-port 5199 --port 3055 --check-only';
const measurement = 'pnpm e2e:perf -- --client-port 5199 --port 3055';
const explanations = [
  `Пояснение: ${preparation}.\nПояснение: ${measurement}.`,
  `Пояснение: \`${preparation}\`.\nПояснение: \`${measurement}\`.`,
  ...['text', 'json', ''].map(
    (language) =>
      `\`\`\`\`${language}\n   1. Спроси машину: \`${preparation}\`\n\`\`\`powershell\n${measurement}\n\`\`\`\n\`\`\`\``,
  ),
];

function insertExplanation(source, extra, inside = true) {
  const position = inside ? benchmarkCommands(source).end : source.length;
  return source.slice(0, position) + '\n' + extra + '\n\n' + source.slice(position);
}

function mutateBenchmark(source, index, transform) {
  const { command, start } = benchmarkCommands(source).commands[index];
  expect(source.slice(start, start + command.length)).toBe(command);
  const replacement = transform(command);
  expect(replacement, 'мутация действительно меняет вызов').not.toBe(command);
  return source.slice(0, start) + replacement + source.slice(start + command.length);
}

for (const [name, source] of [
  ['живая инструкция', benchmarkSource],
  ['PR 219', historicalSource],
]) {
  it(`${name}: подготовка и замер используют одну пару ключей`, () => {
    expect(checkBenchmarkCommands(source)).toEqual([preparation, measurement]);
  });
  for (const newline of ['\n', '\r\n']) {
    it(`${name}: перевод строк ${JSON.stringify(newline)} не меняет результат`, () => {
      checkBenchmarkCommands(source.replace(/\r?\n/g, newline));
    });
  }
  for (const [index, extra] of explanations.entries()) {
    for (const inside of [true, false]) {
      it(`${name}: пояснение ${index}, внутри perf: ${inside}`, () => {
        expect(checkBenchmarkCommands(insertExplanation(source, extra, inside))).toEqual([
          preparation,
          measurement,
        ]);
      });
    }
  }
  const withExplanations = insertExplanation(source, explanations.join('\n'));
  for (const index of [0, 1]) {
    const mutations = [
      ['удаление', () => ''],
      [
        'дублирование',
        (command) =>
          index === 0
            ? `${command}\`\n   1. Спроси машину: \`${command}`
            : `${command}\n      ${command}`,
      ],
      ...['--client-port 5199', '--port 3055'].map((flag) => [
        `потеря ${flag}`,
        (command) => command.replace(flag, ''),
      ]),
      ...['5199', '3055'].map((port) => [
        `рассогласование ${port}`,
        (command) => command.replace(port, String(Number(port) + 10)),
      ]),
      [
        'неверный check-only',
        (command) =>
          index === 0 ? command.replace(' --check-only', '') : command + ' --check-only',
      ],
      ...[
        ' --history',
        ' --force',
        ' --unknown',
        '; pnpm e2e:perf',
        ' | pnpm e2e:perf',
        ' && pnpm e2e:perf',
      ].map((suffix) => [suffix, (command) => command + suffix]),
    ];
    for (const [mutation, transform] of mutations) {
      it(`${name}: вызов ${index}, ${mutation}`, () => {
        const broken = mutateBenchmark(withExplanations, index, transform);
        for (const extra of explanations) expect(broken).toContain(extra);
        expect(() => checkBenchmarkCommands(broken)).toThrow();
      });
    }
  }
  it(`${name}: оба вызова без портов не образуют допустимую пару`, () => {
    let broken = withExplanations;
    for (const index of [0, 1])
      broken = mutateBenchmark(broken, index, (command) =>
        command.replace(' --client-port 5199 --port 3055', ''),
      );
    expect(() => checkBenchmarkCommands(broken)).toThrow();
  });
  it(`${name}: согласованная замена портов допустима`, () => {
    let changed = source;
    for (const index of [0, 1])
      changed = mutateBenchmark(changed, index, (command) =>
        command.replace('5199', '5209').replace('3055', '3065'),
      );
    expect(checkBenchmarkCommands(changed)).toEqual(
      [preparation, measurement].map((command) =>
        command.replace('5199', '5209').replace('3055', '3065'),
      ),
    );
  });
  it(`${name}: дублирование отдельного powershell-блока обнаруживается`, () => {
    const broken = insertExplanation(source, `   \`\`\`powershell\n   ${measurement}\n   \`\`\``);
    expect(() => checkBenchmarkCommands(broken)).toThrow();
  });
  it(`${name}: номера шагов и отступы блока не зашиты в стороже`, () => {
    const changed = source.replace(/^([0-9]+)\. /gm, '99. ').replace(/^ {6}/gm, '        ');
    expect(changed).not.toBe(source);
    checkBenchmarkCommands(changed);
  });
  it(`${name}: отсутствие и неоднозначность perf-раздела обнаруживаются`, () => {
    const { start, end } = benchmarkCommands(source);
    const section = source.slice(start, end);
    expect(() => checkBenchmarkCommands(source.slice(0, start) + source.slice(end))).toThrow();
    expect(() => checkBenchmarkCommands(source + '\n' + section)).toThrow();
  });
  it(`${name}: непарное ограждение обнаруживается`, () => {
    expect(() => checkBenchmarkCommands(source + '\n```text\n')).toThrow();
  });
}

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
