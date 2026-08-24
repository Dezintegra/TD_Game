import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandKind, asPlayerId, asTickNumber } from '@td/shared';
import type { Command, MatchSide, ThinRecord } from '@td/shared';
import { createMatchRecorder, runStamp, safeName } from './recording.js';

/**
 * Записи ложатся во временный каталог, а не в `.matchlog`: проверка
 * не должна подмешивать выдуманные матчи к настоящим, которые потом
 * попадут в общую сводку.
 */
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'td-matchlog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AT = new Date('2026-08-21T14:30:05');

const HUMAN: MatchSide = { who: 'human' };
const COMPUTER: MatchSide = { who: 'computer', profile: 'baseline-2026-08', seed: 777 };

const move = (tick: number, player: number, direction: number): Command => ({
  kind: CommandKind.MoveGeneral,
  player: asPlayerId(player),
  tick: asTickNumber(tick),
  direction,
});

const readRecords = (path: string): ThinRecord[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ThinRecord);

describe('имя файла записи', () => {
  it('оставляет только безопасные знаки', () => {
    expect(safeName('m12')).toBe('m12');
    expect(safeName('C:\\windows\\system32')).toBe('Cwindowssystem32');
    // Кириллица тоже не проходит: набор разрешённых знаков закрытый,
    // и «безопасно выглядящее» в него не попадает наравне с опасным.
    expect(safeName('m1-матч')).toBe('m1-');
  });

  it('не отдаёт пустое имя', () => {
    expect(safeName('..')).toBe('match');
    expect(safeName('')).toBe('match');
    expect(safeName('../../побег')).toBe('match');
  });

  it('отметка запуска читается и сортируется по времени', () => {
    expect(runStamp(AT)).toBe('20260821-143005');
    expect(runStamp(new Date('2026-01-02T03:04:05'))).toBe('20260102-030405');
  });
});

describe('запись матча', () => {
  it('не выпускает файл за пределы своего каталога', async () => {
    const recorder = createMatchRecorder({ dir, now: () => AT });
    const recording = recorder.open({
      matchId: '../../../побег',
      seed: 1,
      sides: [HUMAN, HUMAN],
    });

    await recording.close(null);

    // Имя составлено записью, а не идентификатором: переход по каталогам
    // из него выпал целиком, файл остался внутри.
    expect(readdirSync(dir)).toEqual(['20260821-143005-match.jsonl']);
  });

  it('разводит по разным файлам матчи с одинаковым seed', async () => {
    const recorder = createMatchRecorder({ dir, now: () => AT });

    const first = recorder.open({ matchId: 'm1', seed: 4242, sides: [HUMAN, COMPUTER] });
    const second = recorder.open({ matchId: 'm2', seed: 4242, sides: [HUMAN, HUMAN] });

    first.frame(10, [move(10, 0, 1)]);
    second.frame(10, [move(10, 1, 2)]);

    await first.close(null);
    await second.close(null);

    expect(first.path).not.toBe(second.path);
    expect(readdirSync(dir)).toHaveLength(2);

    const firstCommands = readRecords(first.path).filter((record) => record.t === 'cmd');
    expect(firstCommands).toHaveLength(1);
    expect(firstCommands[0]).toMatchObject({ player: 0, arg0: 1 });
  });

  it('не дописывает в чужой файл при совпавшем имени', async () => {
    // Отметка запуска одна и та же, идентификатор матча тот же: так
    // выглядел бы перезапуск сервера в ту же секунду. Дописать второй
    // матч в хвост первому было бы хуже, чем упасть, — поэтому запись
    // берёт соседнее имя.
    const first = createMatchRecorder({ dir, now: () => AT }).open({
      matchId: 'm1',
      seed: 1,
      sides: [HUMAN, HUMAN],
    });
    const second = createMatchRecorder({ dir, now: () => AT }).open({
      matchId: 'm1',
      seed: 1,
      sides: [HUMAN, HUMAN],
    });

    await first.close(null);
    await second.close(null);

    expect(first.path).not.toBe(second.path);
    expect(readdirSync(dir).sort()).toEqual([
      '20260821-143005-m1-1.jsonl',
      '20260821-143005-m1.jsonl',
    ]);
  });

  it('время отсчитывается от первого тика, а не от создания записи', async () => {
    // Запись заводится, когда матч заведён, а тикать он начинает,
    // только когда подключились оба участника. Между этими мгновениями
    // лежит ожидание — иногда десятки секунд, — и, считай мы от
    // создания, первая же отметка объявила бы матч отставшим на всё
    // это время, а темп в записи стал бы неотличим от вранья.
    let ms = AT.getTime();
    const recorder = createMatchRecorder({ dir, now: () => new Date(ms) });
    const recording = recorder.open({ matchId: 'm9', seed: 1, sides: [HUMAN, COMPUTER] });

    // Двадцать секунд ждали соперника — они в темп войти не должны.
    ms += 20_000;
    recording.frame(0, []);

    // Дальше матч идёт секунда в секунду.
    ms += 1000;
    recording.checksum(30, 1);
    ms += 1000;
    recording.checksum(60, 2);

    await recording.close(null);

    expect(
      readRecords(recording.path)
        .filter((record) => record.t === 'sum')
        .map((record) => (record.t === 'sum' ? record.atMs : undefined)),
    ).toStrictEqual([1000, 2000]);
  });

  it('пишет состав сторон, команды обеих сторон, суммы и исход', async () => {
    const recorder = createMatchRecorder({ dir, now: () => AT });
    const recording = recorder.open({ matchId: 'm7', seed: 4242, sides: [HUMAN, COMPUTER] });

    recording.frame(0, []);
    recording.frame(5, [move(5, 0, 1), move(5, 1, 3)]);
    recording.checksum(30, 12345);
    await recording.close({ tick: 40, winner: 1, reason: 'base-destroyed' });

    const records = readRecords(recording.path);
    const header = records[0];

    expect(header).toEqual({
      t: 'thin',
      matchId: 'm7',
      worldSeed: 4242,
      sides: [HUMAN, COMPUTER],
      gitSha: expect.any(String),
      gitDirty: expect.any(Boolean),
      startedAt: AT.toISOString(),
    });

    // Пустой кадр в запись не идёт: тик, на котором ничего не произошло,
    // выводится из соседних, а таких тиков в матче подавляющее большинство.
    expect(records.filter((record) => record.t === 'cmd')).toEqual([
      { t: 'cmd', tick: 5, player: 0, kind: CommandKind.MoveGeneral, arg0: 1, arg1: 0 },
      { t: 'cmd', tick: 5, player: 1, kind: CommandKind.MoveGeneral, arg0: 3, arg1: 0 },
    ]);
    // Отметка времени идёт рядом с суммой. Часы здесь стоят на месте,
    // поэтому от первого тика до суммы прошло ноль.
    expect(records.filter((record) => record.t === 'sum')).toEqual([
      { t: 'sum', tick: 30, value: 12345, atMs: 0 },
    ]);
    expect(records.at(-1)).toEqual({
      t: 'over',
      tick: 40,
      winner: 1,
      reason: 'base-destroyed',
    });
  });

  it('состояния мира в записи нет', async () => {
    const recorder = createMatchRecorder({ dir, now: () => AT });
    const recording = recorder.open({ matchId: 'm8', seed: 1, sides: [HUMAN, HUMAN] });

    recording.frame(1, [move(1, 0, 1)]);
    await recording.close(null);

    // Запись содержит входы, а не состояние: четыре вида записей и ничего
    // сверх них.
    const kinds = new Set(readRecords(recording.path).map((record) => record.t));
    for (const kind of kinds) expect(['thin', 'cmd', 'sum', 'over']).toContain(kind);
  });

  it('после закрытия не пишет ничего', async () => {
    const recorder = createMatchRecorder({ dir, now: () => AT });
    const recording = recorder.open({ matchId: 'm9', seed: 1, sides: [HUMAN, HUMAN] });

    await recording.close(null);
    recording.frame(99, [move(99, 0, 1)]);
    recording.checksum(99, 1);
    await recording.close({ tick: 99, winner: 0, reason: 'поздно' });

    expect(readRecords(recording.path).filter((record) => record.t !== 'thin')).toEqual([]);
  });
});
