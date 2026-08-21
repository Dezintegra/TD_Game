import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandKind, MS_PER_TICK, asPlayerId, asTickNumber } from '@td/shared';
import type { MatchSide, ThinRecord } from '@td/shared';
import { createMatchRegistry } from './matches.js';
import { createMatchRecorder } from './recording.js';
import type { ConnectionId, GameTransport } from './transport.js';

/**
 * Здесь проверяется стык записи и ведения матча, а не правила игры:
 * что запись заводится на матч, видит команды обеих сторон и закрывается
 * его концом. Сам матч проверен в `@td/netplay`, а запись — в соседнем
 * файле; повторять их незачем.
 */

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'td-matches-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AT = new Date('2026-08-21T14:30:05');
const HUMAN: MatchSide = { who: 'human' };
const COMPUTER: MatchSide = { who: 'computer', profile: 'baseline-2026-08', seed: 777 };

/** Транспорт, который никуда не ходит: матч ведут не сокеты. */
const silentTransport = (): GameTransport => ({
  send: () => undefined,
  broadcast: () => undefined,
  close: () => undefined,
  connectionCount: 0,
});

const connection = (value: number): ConnectionId => ({ value });

interface Table {
  readonly registry: ReturnType<typeof createMatchRegistry>;
  runMs(ms: number): void;
}

const table = (recorder?: ReturnType<typeof createMatchRecorder>): Table => {
  let clock = 0;

  const registry = createMatchRegistry({
    transport: silentTransport,
    now: () => clock,
    recorder,
  });

  return {
    registry,
    runMs(ms) {
      let left = ms;
      while (left > 0) {
        const slice = Math.min(MS_PER_TICK / 2, left);
        clock += slice;
        left -= slice;
        // Реестр опрашивает матчи по таймеру, а в проверке таймера нет:
        // ход времени и продвижение матчей делаются руками.
        registry.find('m1')?.advance();
      }
    },
  };
};

const start = (registry: Table['registry'], sides: readonly MatchSide[]): void => {
  registry.start({
    matchId: 'm1',
    seed: 4242,
    tickets: new Map([
      ['t0', 0],
      ['t1', 1],
    ]),
    sides,
  });

  registry.admit(connection(1), 't0');
  registry.admit(connection(2), 't1');
};

const readRecords = (path: string): ThinRecord[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ThinRecord);

describe('запись в реестре матчей', () => {
  it('без писателя не создаёт ни одного файла', () => {
    const bench = table();
    start(bench.registry, [HUMAN, COMPUTER]);
    bench.runMs(500);

    bench.registry.close();

    expect(readdirSync(dir)).toEqual([]);
  });

  it('пишет команды обеих сторон и закрывает запись концом матча', async () => {
    const bench = table(createMatchRecorder({ dir, now: () => AT }));
    start(bench.registry, [HUMAN, COMPUTER]);
    bench.runMs(400);

    const host = bench.registry.find('m1');
    if (host === undefined) throw new Error('матч не заведён');

    // По команде от каждой стороны: запись обязана видеть обе, а не только
    // человеческую — ровно этого и не хватало прежней записи из браузера.
    host.submit(asPlayerId(0), {
      kind: CommandKind.MoveGeneral,
      tick: asTickNumber(host.world.tick + 2),
      direction: 1,
    });
    host.submit(asPlayerId(1), {
      kind: CommandKind.SetStance,
      tick: asTickNumber(host.world.tick + 2),
      stance: 1,
    });
    // С запасом: контрольная сумма снимается раз в игровую секунду,
    // и матч должен успеть прожить хотя бы одну.
    bench.runMs(1500);

    // Сдача — конец матча: запись закрывается там же, где реестр замечает
    // фазу `finished`.
    bench.registry.forfeit('t0');

    // Файл дописывается асинхронно; дождаться его можно, закрыв реестр
    // и уступив цикл событий.
    await new Promise((done) => setTimeout(done, 50));

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);

    const records = readRecords(join(dir, files[0] ?? ''));
    const header = records[0];

    expect(header).toMatchObject({ t: 'thin', matchId: 'm1', worldSeed: 4242 });
    expect((header as { sides: readonly MatchSide[] }).sides).toEqual([HUMAN, COMPUTER]);

    const commands = records.filter((record) => record.t === 'cmd');
    expect(commands.map((command) => command.player).sort()).toEqual([0, 1]);
    expect(commands.map((command) => command.kind)).toContain(CommandKind.SetStance);

    expect(records.filter((record) => record.t === 'sum').length).toBeGreaterThan(0);
    expect(records.at(-1)).toMatchObject({ t: 'over', winner: 1 });
  });

  it('дописывает хвост недоигранного матча при остановке сервера', async () => {
    const bench = table(createMatchRecorder({ dir, now: () => AT }));
    start(bench.registry, [HUMAN, HUMAN]);
    bench.runMs(1200);

    bench.registry.close();
    await new Promise((done) => setTimeout(done, 50));

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);

    const records = readRecords(join(dir, files[0] ?? ''));
    // Исхода нет — его и не было. Суммы есть: матч шёл.
    expect(records.some((record) => record.t === 'over')).toBe(false);
    expect(records.filter((record) => record.t === 'sum').length).toBeGreaterThan(0);
  });
});
