import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildArenaArgs, parseTuningArgs, runArenaWorkflow } from './arena-workflow.mjs';

const env = { MATCHES: '24', SEED: '5000', PROFILES: 'baseline,siege', SECONDS_LIMIT: '1200' };
const baseArgs = [
  'run',
  '--matches',
  '24',
  '--seed',
  '5000',
  '--profiles',
  'baseline,siege',
  '--seconds',
  '1200',
];

function launch(tuning, result = { status: 0, signal: null }) {
  const spawn = vi.fn(() => result);
  const error = vi.fn();
  const status = runArenaWorkflow({ ...env, TUNING_ARGS: tuning }, spawn, error);
  return { spawn, error, status };
}

describe('доставка множителей в процесс арены', () => {
  it.each(['0.5', '1'])('доставляет ограниченную дальность %s', (value) => {
    expect(launch(`--assault-range ${value}`).status).toBe(0);
  });
  it.each(['0.8', '2', '0', 'NaN', 'Infinity', '$(whoami)'])(
    'отвергает дальность %s до spawn',
    (value) => {
      const result = launch(`--assault-range ${value}`);
      expect(result.status).toBe(1);
      expect(result.spawn).not.toHaveBeenCalled();
    },
  );
  it('доставляет подмножество отдельно от tuning', () => {
    expect(buildArenaArgs({ ...env, TRACE_ASSAULT_SEEDS: '5000,5002' })).toEqual([
      ...baseArgs,
      '--trace-assault-seeds',
      '5000,5002',
    ]);
    expect(buildArenaArgs({ ...env, TRACE_ASSAULT_SEEDS: '  ' })).toEqual(baseArgs);
  });
  it.each(['5000,5000', '4999', '5024', '5000.5', '5000;echo', '5000,'])(
    'отвергает trace %s до spawn',
    (value) => {
      const spawn = vi.fn();
      expect(runArenaWorkflow({ ...env, TRACE_ASSAULT_SEEDS: value }, spawn, vi.fn())).toBe(1);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, '', ' \t\r\n '])('сохраняет прежний argv при пустом вводе %j', (input) => {
    const { spawn, status, error } = launch(input);
    expect(status).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['apps/arena/dist/main.js', ...baseArgs], {
      shell: false,
      stdio: 'inherit',
    });
  });

  it('сохраняет отсутствие необязательных полей', () => {
    expect(buildArenaArgs({ MATCHES: '60', SEED: '1', PROFILES: '', SECONDS_LIMIT: '' })).toEqual([
      'run',
      '--matches',
      '60',
      '--seed',
      '1',
    ]);
  });

  it('передаёт старые поля едиными аргументами без shell', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const profiles = 'baseline; echo bad $(whoami) *';
    runArenaWorkflow({ MATCHES: '60', SEED: '1', PROFILES: profiles }, spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['apps/arena/dist/main.js', 'run', '--matches', '60', '--seed', '1', '--profiles', profiles],
      { shell: false, stdio: 'inherit' },
    );
  });

  it.each(['--income', '--speed', '--tower-hp', '--base-hp', '--radius', '--map'])(
    'доставляет %s с нейтральным, дробным и экспоненциальным множителем',
    (flag) => {
      for (const value of ['1', '0.8', '1e-1']) {
        const { spawn, status } = launch(`${flag} ${value}`);
        expect(status).toBe(0);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledWith(
          process.execPath,
          ['apps/arena/dist/main.js', ...baseArgs, flag, value],
          { shell: false, stdio: 'inherit' },
        );
      }
    },
  );

  it('сохраняет несколько пар и их порядок вместе с прежними полями', () => {
    const { spawn } = launch(' \t--base-hp 0.8\n--income 1.2\r\n');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['apps/arena/dist/main.js', ...baseArgs, '--base-hp', '0.8', '--income', '1.2'],
      { shell: false, stdio: 'inherit' },
    );
  });

  it.each(['.8', '+0.8', '1.', '01.0', '1E+2', '1e-2'])('сохраняет запись числа %s', (value) => {
    expect(parseTuningArgs(`--base-hp ${value}`)).toEqual(['--base-hp', value]);
  });

  it('пара сравнений отличается только множителем базы', () => {
    const first = launch('--base-hp 1').spawn.mock.calls[0];
    const second = launch('--base-hp 0.8').spawn.mock.calls[0];
    expect(first[1].at(-1)).toBe('1');
    expect(second[1].at(-1)).toBe('0.8');
    second[1][second[1].length - 1] = '1';
    expect(second).toEqual(first);
  });
});

describe('ошибки ввода не запускают процесс', () => {
  it.each([
    ['--base-hpp 0.8', 'неизвестный ключ'],
    ['--base-hp', 'отсутствует значение'],
    ['--base-hp --income 1', 'отсутствует значение'],
    ['--base-hp 1 --base-hp 0.8', 'повтор ключа'],
    ['--base-hp 1 extra', 'неизвестный ключ'],
    ['--base-hp=0.8', 'неизвестный ключ'],
    ['--matches 1000', 'неизвестный ключ'],
    ['--jobs 1', 'неизвестный ключ'],
    ['--profiles siege', 'неизвестный ключ'],
    ['--seed 1', 'неизвестный ключ'],
    ['--seconds 1', 'неизвестный ключ'],
    ['--out elsewhere', 'неизвестный ключ'],
    ['run', 'неизвестный ключ'],
  ])('отвергает %s с диагностикой', (input, diagnostic) => {
    const { spawn, status, error } = launch(input);
    expect(status).not.toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
  });

  it.each([
    '0',
    '-1',
    '-0',
    'NaN',
    'Infinity',
    '1e999',
    '1e-999',
    'text',
    '0x10',
    '0b10',
    '1,2',
    '1_000',
    '1e',
    '.',
    '+',
    '1;echo bad',
    '$(whoami)',
    '`whoami`',
    '>file',
    '*',
    '"0.8"',
    "'0.8'",
    '0.8\\',
  ])('отвергает число или shell-содержимое %s до spawn', (value) => {
    const { spawn, status, error } = launch(`--base-hp ${value}`);
    expect(status).not.toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--base-hp'));
  });

  it.each(['; echo bad', '$(whoami)', '`whoami`', '> file', '*'])(
    'проверяет весь ввод до запуска: %s после правильной пары',
    (suffix) => {
      const { spawn, status } = launch(`--base-hp 1 ${suffix}`);
      expect(status).not.toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});

describe('исход адаптера', () => {
  it.each([0, 2, 42])('сохраняет код арены %s', (status) => {
    expect(launch('', { status, signal: null }).status).toBe(status);
  });
  it.each([
    [{ error: new Error('spawn ENOENT'), status: null }, 'ENOENT'],
    [{ status: null, signal: 'SIGTERM' }, 'SIGTERM'],
    [{ status: null, signal: null }, 'без кода'],
  ])('отмечает ошибку или сигнал %j', (result, diagnostic) => {
    const { status, error } = launch('', result);
    expect(status).not.toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
  });
  it('обрабатывает исключение запуска', () => {
    const error = vi.fn();
    expect(
      runArenaWorkflow(
        env,
        () => {
          throw new Error('spawn failed');
        },
        error,
      ),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('spawn failed'));
  });
  it('импорт не запускает арену', async () => {
    const spawn = vi.fn(() => {
      throw new Error('импорт не должен запускать процесс');
    });
    vi.doMock('node:child_process', () => ({ spawnSync: spawn }));
    try {
      vi.resetModules();
      await import('./arena-workflow.mjs');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:child_process');
    }
  });
});

it('workflow объявляет вход и передаёт его только через env постоянному адаптеру', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/arena.yml', import.meta.url),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const input = workflow.match(/^ {6}tuning_args:\n((?: {8}.*\n)+)/m)?.[1];
  expect(input).toContain('        type: string\n');
  expect(input).toContain('        required: false\n');
  expect(input).toContain("        default: ''\n");
  const step = workflow.split('      - name: Прогнать матчи\n')[1]?.split('\n      - name:')[0];
  expect(step).toContain('          TUNING_ARGS: ${{ inputs.tuning_args }}\n');
  expect(step).toContain('        run: node scripts/arena-workflow.mjs\n');
  for (const [name, field] of [
    ['MATCHES', 'matches'],
    ['PROFILES', 'profiles'],
    ['SEED', 'seed'],
    ['SECONDS_LIMIT', 'seconds'],
  ]) {
    expect(step).toContain(`          ${name}: ` + '${{ inputs.' + field + ' }}');
  }
  expect(workflow.match(/\$\{\{\s*inputs\.tuning_args\s*\}\}/g)).toHaveLength(1);
});
