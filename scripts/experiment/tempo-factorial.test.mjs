import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const io = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  sqliteLoaded: vi.fn(),
  DatabaseSync: vi.fn(),
  prepare: vi.fn(),
  close: vi.fn(),
}));

// Подмены ставятся до импорта: возврат дефекта не должен запустить настоящие матчи.
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

const entry = fileURLToPath(new URL('./tempo-factorial.mjs', import.meta.url));
const root = dirname(dirname(dirname(entry)));
const arenaMain = join(root, 'apps', 'arena', 'dist', 'main.js');
const originalArgv = process.argv;
let output;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = [process.execPath, 'consumer.mjs'];
  output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  io.existsSync.mockReturnValue(true);
  io.DatabaseSync.mockImplementation(() => ({ prepare: io.prepare, close: io.close }));
  io.prepare.mockImplementation((sql) => ({
    all: () =>
      sql.includes('from match')
        ? [
            { winner: 1, ticks: 300, end_reason: 'base' },
            { winner: null, ticks: 600, end_reason: 'timeout' },
            { winner: 0, ticks: 100, end_reason: 'base' },
            { winner: 0, ticks: 200, end_reason: 'base' },
          ]
        : [{ units: 2.26, towers: 3.14, walls: 4.56, energy: 10.6, income: 1.26, upgrades: 7 }],
  }));
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

const load = () => import('./tempo-factorial.mjs');
const cellDir = (id) => join(root, '.matchlog', 'experiment', id);
const metrics = {
  wallSeconds: 0,
  matches: 4,
  medianTicks: 300,
  minTicks: 100,
  maxTicks: 600,
  meanTicks: 300,
  timeoutShare: 0.25,
  winShare0: 0.5,
  winShare1: 0.25,
  avgUnits: 2.3,
  avgTowers: 3.1,
  avgWalls: 4.6,
  avgEnergy: 11,
  avgIncome: 1.3,
  maxUpgrades: 7,
};
const defaults = { seed: 9000, matches: 5, profiles: 'baseline-2026-08,baseline-2026-08' };

function expectArenaCall(n, id, args) {
  expect(io.execFileSync).toHaveBeenNthCalledWith(
    n,
    process.execPath,
    ['--no-warnings', arenaMain, ...args],
    { stdio: 'inherit', env: { ...process.env, ARENA_DIR: cellDir(id) } },
  );
}

describe('безопасный импорт', () => {
  it.each([[process.execPath, 'consumer.mjs', '--factors', '{invalid'], [process.execPath]])(
    'не исполняет CLI при argv %j',
    async (...argv) => {
      process.argv = argv;
      const module = await load();
      expect(Object.keys(module).sort()).toEqual(['FACTORS', 'FLAG_OF', 'cells', 'shardOf']);
      for (const mock of Object.values(io)) expect(mock).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
    },
  );
});

describe('матрица', () => {
  it('сохраняет уровни и порядок полного перебора', async () => {
    const { FACTORS, cells } = await load();
    expect(FACTORS).toEqual({
      income: [1, 1.5, 2],
      speed: [0.75, 1, 1.25],
      towerHp: [1, 1.5, 2],
      radius: [0.75, 1, 1.25],
      map: [0.5, 1, 1.5],
    });
    const all = cells();
    expect(all).toHaveLength(243);
    expect(all[0]).toEqual({
      id: 'c000',
      income: 1,
      speed: 0.75,
      towerHp: 1,
      radius: 0.75,
      map: 0.5,
    });
    expect(all[1]).toEqual({
      id: 'c001',
      income: 1,
      speed: 0.75,
      towerHp: 1,
      radius: 0.75,
      map: 1,
    });
    expect(all[3]).toEqual({ id: 'c003', income: 1, speed: 0.75, towerHp: 1, radius: 1, map: 0.5 });
    expect(all[81]).toEqual({
      id: 'c081',
      income: 1.5,
      speed: 0.75,
      towerHp: 1,
      radius: 0.75,
      map: 0.5,
    });
    expect(all[242]).toEqual({
      id: 'c242',
      income: 2,
      speed: 1.25,
      towerHp: 2,
      radius: 1.25,
      map: 1.5,
    });
  });

  it('разворачивает заданные факторы и отвергает неизвестные', async () => {
    const { cells } = await load();
    expect(cells({ baseHp: [1, 2, 4] })).toEqual([
      { id: 'c000', baseHp: 1 },
      { id: 'c001', baseHp: 2 },
      { id: 'c002', baseHp: 4 },
    ]);
    expect(cells({ speed: [1, 2], income: [3, 4] })).toEqual([
      { id: 'c000', speed: 1, income: 3 },
      { id: 'c001', speed: 1, income: 4 },
      { id: 'c002', speed: 2, income: 3 },
      { id: 'c003', speed: 2, income: 4 },
    ]);
    expect(() => cells({ unknown: [1] })).toThrow('неизвестная величина «unknown»');
  });

  it('раздаёт доли без перестановки или мутации', async () => {
    const { shardOf } = await load();
    const list = Object.freeze(['c000', 'c001', 'c002', 'c003', 'c004']);
    expect(shardOf(list, 1, 2)).toEqual(['c001', 'c003']);
    expect(list).toEqual(['c000', 'c001', 'c002', 'c003', 'c004']);
  });
});

describe('прямой запуск с подменённой ареной', () => {
  it('узнаёт относительный путь и сохраняет приоритет only и параметры', async () => {
    process.argv = [
      process.execPath,
      relative(process.cwd(), entry),
      '--factors',
      '{"baseHp":[1,2,4]}',
      '--only',
      'c002',
      '--shard',
      '1',
      '--of',
      '2',
      '--seed',
      '42',
      '--matches',
      '7',
      '--jobs',
      '3',
      '--profiles',
      'left,right',
      '--out',
      'custom result.json',
    ];
    await load();
    expect(io.execFileSync).toHaveBeenCalledTimes(2);
    expectArenaCall(1, 'c002', [
      'run',
      '--matches',
      '7',
      '--seed',
      '42',
      '--profiles',
      'left,right',
      '--jobs',
      '3',
      '--base-hp',
      '4',
    ]);
    expectArenaCall(2, 'c002', ['ingest']);
    expect(io.DatabaseSync).toHaveBeenCalledWith(join(cellDir('c002'), 'arena.sqlite'), {
      readOnly: true,
    });
    expect(io.close).toHaveBeenCalledTimes(1);
    expect(io.writeFileSync).toHaveBeenCalledTimes(1);
    expect(io.writeFileSync).toHaveBeenCalledWith(
      'custom result.json',
      JSON.stringify(
        {
          seed: 42,
          matches: 7,
          profiles: 'left,right',
          results: [{ id: 'c002', baseHp: 4, ...metrics }],
        },
        null,
        2,
      ),
      'utf8',
    );
    expect(io.mkdirSync).toHaveBeenCalledTimes(1);
    expect(io.mkdirSync).toHaveBeenCalledWith(cellDir('c002'), { recursive: true });
    expect(io.rmSync.mock.calls).toEqual([
      [cellDir('c002'), { recursive: true, force: true }],
      [cellDir('c002'), { recursive: true, force: true }],
    ]);
    expect(output.mock.calls.at(-1)[0]).toContain(
      'ячеек 1, не сосчиталось 0; итог в custom result.json',
    );
  });

  it('узнаёт абсолютный путь, выбирает долю и накапливает JSON с defaults', async () => {
    process.argv = [
      process.execPath,
      entry,
      '--factors',
      '{"baseHp":[1,2,3,4,5]}',
      '--shard',
      '1',
      '--of',
      '2',
    ];
    await load();
    expect(io.execFileSync).toHaveBeenCalledTimes(4);
    expectArenaCall(1, 'c001', [
      'run',
      '--matches',
      '5',
      '--seed',
      '9000',
      '--profiles',
      defaults.profiles,
      '--jobs',
      '2',
      '--base-hp',
      '2',
    ]);
    expectArenaCall(2, 'c001', ['ingest']);
    expectArenaCall(3, 'c003', [
      'run',
      '--matches',
      '5',
      '--seed',
      '9000',
      '--profiles',
      defaults.profiles,
      '--jobs',
      '2',
      '--base-hp',
      '4',
    ]);
    expectArenaCall(4, 'c003', ['ingest']);
    const first = { id: 'c001', baseHp: 2, ...metrics };
    expect(io.writeFileSync.mock.calls).toEqual([
      [
        'experiment-shard-1.json',
        JSON.stringify({ ...defaults, results: [first] }, null, 2),
        'utf8',
      ],
      [
        'experiment-shard-1.json',
        JSON.stringify(
          { ...defaults, results: [first, { id: 'c003', baseHp: 4, ...metrics }] },
          null,
          2,
        ),
        'utf8',
      ],
    ]);
  });

  it('записывает отказ ячейки, очищает её и продолжает следующую', async () => {
    process.argv = [process.execPath, entry, '--factors', '{"baseHp":[1,2]}'];
    io.execFileSync.mockImplementationOnce(() => {
      throw new Error('synthetic failure');
    });
    await load();
    expect(io.execFileSync).toHaveBeenCalledTimes(3);
    expectArenaCall(2, 'c001', [
      'run',
      '--matches',
      '5',
      '--seed',
      '9000',
      '--profiles',
      defaults.profiles,
      '--jobs',
      '2',
      '--base-hp',
      '2',
    ]);
    expectArenaCall(3, 'c001', ['ingest']);
    const failed = { id: 'c000', baseHp: 1, wallSeconds: 0, error: 'synthetic failure' };
    expect(io.writeFileSync.mock.calls).toEqual([
      [
        'experiment-shard-0.json',
        JSON.stringify({ ...defaults, results: [failed] }, null, 2),
        'utf8',
      ],
      [
        'experiment-shard-0.json',
        JSON.stringify(
          { ...defaults, results: [failed, { id: 'c001', baseHp: 2, ...metrics }] },
          null,
          2,
        ),
        'utf8',
      ],
    ]);
    expect(io.rmSync.mock.calls).toEqual([
      [cellDir('c000'), { recursive: true, force: true }],
      [cellDir('c000'), { recursive: true, force: true }],
      [cellDir('c001'), { recursive: true, force: true }],
      [cellDir('c001'), { recursive: true, force: true }],
    ]);
    expect(output.mock.calls.at(-1)[0]).toContain('ячеек 2, не сосчиталось 1');
  });
});
