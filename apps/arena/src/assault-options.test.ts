import { describe, expect, it, vi } from 'vitest';
import { parseAssaultOptions, assaultWorkerArgs, assaultMatchOptions } from './assault-options.js';

describe('параметры диагностического опыта', () => {
  it.each(['0.5', '1'])('доставляет %s в каждую половину пачки', (range) => {
    const options = parseAssaultOptions(
      new Map([
        ['assault-range', range],
        ['trace-assault-seeds', '1,3'],
      ]),
      [1, 2, 3, 4],
    );
    const spawn = vi.fn();
    for (const batch of [
      [1, 2],
      [3, 4],
    ]) {
      const args = assaultWorkerArgs(options, batch);
      spawn(args);
      const flags = new Map<string, string>();
      for (let i = 0; i < args.length; i += 2) flags.set(args[i]!.slice(2), args[i + 1]!);
      const child = parseAssaultOptions(flags, batch);
      for (const seed of batch)
        expect(assaultMatchOptions(child, seed)).toEqual(assaultMatchOptions(options, seed));
    }
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[0]).toEqual([
      '--assault-range',
      range,
      '--trace-assault-seeds',
      '1',
    ]);
  });
  it.each(['1,1', '0', '4', '1.5', '1,', '1;echo', '-1', 'Infinity'])(
    'отвергает seed %s до spawn',
    (raw) => {
      expect(() =>
        parseAssaultOptions(new Map([['trace-assault-seeds', raw]]), [1, 2, 3]),
      ).toThrow();
    },
  );
  it.each(['0.8', '0', '2', 'NaN', 'Infinity', 'true', '0x1', '0b1', ' 1'])(
    'отвергает дальность %s',
    (raw) => {
      expect(() => parseAssaultOptions(new Map([['assault-range', raw]]), [1])).toThrow();
    },
  );
  it('пустое умолчание не включает трассу и не добавляет флаги', () => {
    expect(assaultWorkerArgs(parseAssaultOptions(new Map(), [1]), [1])).toEqual([]);
  });
});
