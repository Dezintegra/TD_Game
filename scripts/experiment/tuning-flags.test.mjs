import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  sqliteLoaded: vi.fn(),
  DatabaseSync: vi.fn(),
}));

// Даже при регрессии импорта тест не должен запустить матч или тронуть его базу.
vi.mock('node:child_process', () => ({ execFileSync: io.execFileSync }));
vi.mock('node:fs', () => ({
  existsSync: io.existsSync,
  mkdirSync: io.mkdirSync,
  rmSync: io.rmSync,
  writeFileSync: io.writeFileSync,
}));
vi.mock('node:sqlite', () => {
  io.sqliteLoaded();
  return { DatabaseSync: io.DatabaseSync };
});

const originalArgv = process.argv;
let stdout;
let stderr;
let rules;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = [process.execPath, 'consumer.mjs'];
  stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  rules?.resetRuleTuning();
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

async function load() {
  // Исходники сохраняют независимость от старого dist и неполных таблиц CLI.
  rules = await import('../../packages/shared/src/rules.ts');
  rules.resetRuleTuning();
  const { TUNING_FLAGS } = await import('../../apps/arena/src/tuning-flags.ts');
  const factorial = await import('./tempo-factorial.mjs');
  const fields = Object.keys(rules.ruleTuning());
  expect(fields.length).toBeGreaterThan(0);
  return { fields, TUNING_FLAGS, ...factorial };
}

function differences(table, expected, actual) {
  const want = new Set(expected);
  const have = new Set(actual);
  return [
    ...[...want]
      .filter((key) => !have.has(key))
      .sort()
      .map((key) => `${table}: missing ${key}`),
    ...[...have]
      .filter((key) => !want.has(key))
      .sort()
      .map((key) => `${table}: extra ${key}`),
  ];
}

function coverage(fields, tuningFlags, flagOf) {
  return [
    ...differences('TUNING_FLAGS', fields, Object.values(tuningFlags)),
    ...differences(
      'FLAG_OF',
      Object.keys(tuningFlags).map((key) => `--${key}`),
      Object.values(flagOf),
    ),
  ];
}

describe('полнота таблиц настройки правил', () => {
  it('покрывает независимый состав правил обеими рабочими таблицами', async () => {
    const { fields, TUNING_FLAGS, FLAG_OF } = await load();
    expect(coverage(fields, TUNING_FLAGS, FLAG_OF)).toEqual([]);
  });

  it('разворачивает каждый доступный фактор без запуска арены', async () => {
    const { FLAG_OF, cells } = await load();
    for (const factor of Object.keys(FLAG_OF)) {
      expect(cells({ [factor]: [1, 2] })).toEqual([
        { id: 'c000', [factor]: 1 },
        { id: 'c001', [factor]: 2 },
      ]);
    }
  });

  it.each([
    ['towerHealth', 'tower-hp', 'towerHp'],
    ['baseHealth', 'base-hp', 'baseHp'],
    ['unitRadius', 'radius', 'radius'],
  ])('сохраняет цепочку %s — %s — %s', async (field, flag, factor) => {
    const { TUNING_FLAGS, FLAG_OF } = await load();
    expect(TUNING_FLAGS[flag]).toBe(field);
    expect(FLAG_OF[factor]).toBe(`--${flag}`);
  });

  it('называет потерю записи арены и оставшийся лишний ключ фактора', async () => {
    const { fields, TUNING_FLAGS, FLAG_OF } = await load();
    const copy = { ...TUNING_FLAGS };
    delete copy.income;
    expect(coverage(fields, copy, FLAG_OF)).toEqual([
      'TUNING_FLAGS: missing income',
      'FLAG_OF: extra --income',
    ]);
  });

  it('называет потерю записи факторного инструмента', async () => {
    const { fields, TUNING_FLAGS, FLAG_OF } = await load();
    const copy = { ...FLAG_OF };
    delete copy.income;
    expect(coverage(fields, TUNING_FLAGS, copy)).toEqual(['FLAG_OF: missing --income']);
  });

  it('ловит новое поле, забытое обеими таблицами', async () => {
    const { fields, TUNING_FLAGS, FLAG_OF } = await load();
    expect(coverage([...fields, 'futureMultiplier'], TUNING_FLAGS, FLAG_OF)).toEqual([
      'TUNING_FLAGS: missing futureMultiplier',
    ]);
  });

  it('ловит ошибочный CLI-ключ при прежнем числе записей', async () => {
    const { fields, TUNING_FLAGS, FLAG_OF } = await load();
    expect(coverage(fields, TUNING_FLAGS, { ...FLAG_OF, income: '--unknown' })).toEqual([
      'FLAG_OF: missing --income',
      'FLAG_OF: extra --unknown',
    ]);
  });

  it('ловит неизвестное поле при прежнем числе записей', async () => {
    const { fields, TUNING_FLAGS, FLAG_OF } = await load();
    expect(coverage(fields, { ...TUNING_FLAGS, income: 'unknown' }, FLAG_OF)).toEqual([
      'TUNING_FLAGS: missing income',
      'TUNING_FLAGS: extra unknown',
    ]);
  });
});

describe('безопасный импорт таблиц', () => {
  it.each([[process.execPath, 'consumer.mjs', '--factors', '{invalid'], [process.execPath]])(
    'не исполняет CLI при argv %j',
    async (...argv) => {
      process.argv = argv;
      const { fields, TUNING_FLAGS, FLAG_OF, FACTORS, cells, shardOf } = await load();
      expect(coverage(fields, TUNING_FLAGS, FLAG_OF)).toEqual([]);
      expect(FACTORS).toBeDefined();
      expect(cells).toBeTypeOf('function');
      expect(shardOf).toBeTypeOf('function');
      for (const mock of Object.values(io)) expect(mock).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    },
  );
});
