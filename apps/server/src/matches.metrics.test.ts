import { describe, expect, it } from 'vitest';
import { MS_PER_TICK, createMetrics } from '@td/shared';
import type { MatchSide, Metrics } from '@td/shared';
import { createMatchRegistry } from './matches.js';
import type { ConnectionId, GameTransport } from './transport.js';

/**
 * Проверяется стык ведущего и приборов: величина, посчитанная в матче,
 * доезжает до точки отдачи под своим именем.
 *
 * Сами приборы проверены в `metrics.test.ts`, а сам замер — в
 * `@td/netplay`. Здесь проверяется провод между ними, и проверяется он
 * потому, что рвётся молча: ряд, не подключённый к матчу, выглядит
 * снаружи ровно как ряд, которому нечего показать.
 *
 * Матч тут короткий — несколько тиков, — поэтому файл живёт в быстром
 * наборе, а не среди матчевых.
 */

const HUMAN: MatchSide = { who: 'human' };

/** Транспорт, который никуда не ходит: матч ведут не сокеты. */
const silentTransport = (): GameTransport => ({
  send: () => undefined,
  broadcast: () => undefined,
  close: () => undefined,
  connectionCount: 0,
});

const connection = (value: number): ConnectionId => ({ value });

interface Table {
  readonly metrics: Metrics;
  readonly registry: ReturnType<typeof createMatchRegistry>;
  runMs(ms: number): void;
}

const table = (): Table => {
  let clock = 0;
  const metrics = createMetrics();
  const registry = createMatchRegistry({
    transport: silentTransport,
    now: () => clock,
    metrics,
  });

  registry.start({
    matchId: 'm1',
    seed: 4242,
    tickets: new Map([
      ['t0', 0],
      ['t1', 1],
    ]),
    sides: [HUMAN, HUMAN],
  });
  registry.admit(connection(1), 't0');
  registry.admit(connection(2), 't1');

  return {
    metrics,
    registry,
    runMs(ms) {
      let left = ms;
      while (left > 0) {
        // Шажки мельче тика: при шаге ровно в тик ведущий считает
        // по нескольку тиков за проход, и промежутки между отправками
        // выродились бы в нули.
        const slice = Math.min(1, left);
        clock += slice;
        left -= slice;
        // Реестр опрашивает матчи по таймеру, а в проверке таймера нет.
        registry.find('m1')?.advance();
      }
    },
  };
};

/** Значение ряда из прометеевского текста. */
const rowValue = (text: string, name: string): number => {
  const line = text.split('\n').find((each) => each.startsWith(`${name} `));
  if (line === undefined) throw new Error(`ряда ${name} нет в отдаче`);

  return Number(line.slice(name.length + 1));
};

describe('приборы реестра матчей', () => {
  it('промежуток между отправками кадра доезжает до отдачи', () => {
    const bench = table();
    bench.runMs(MS_PER_TICK * 5);

    const host = bench.registry.find('m1');
    if (host === undefined) throw new Error('матч не заведён');

    const text = bench.metrics.render();

    // Промежутков на один меньше, чем отправленных кадров: первая
    // отправка промежутка не даёт.
    expect(rowValue(text, 'td_frame_send_gap_ms_count')).toBe(host.world.tick - 1);
    // И это именно длительность тика, а не что попало: ряд, подключённый
    // не туда, дал бы счётчик, но не величину. Допуск в миллисекунду —
    // шаг часов проверки: тик в неё не укладывается нацело, поэтому
    // промежутки выходят то 33, то 34.
    expect(rowValue(text, 'td_frame_send_gap_ms_max')).toBeLessThanOrEqual(MS_PER_TICK + 1);
    expect(rowValue(text, 'td_frame_send_gap_ms_sum')).toBeGreaterThan(MS_PER_TICK * 3);

    bench.registry.close();
  });

  it('время обхода отдаётся без разметки', () => {
    // Сама величина проверена у ведущего; здесь проверяется ровно одно —
    // что наружу она уходит без меток. Разметка номером стороны
    // выглядела бы уместно и была бы враньём: сторона нумеруется внутри
    // матча, и «сторона 0» — разные люди в разных матчах.
    const bench = table();
    bench.runMs(MS_PER_TICK * 2);

    const rows = bench.metrics
      .render()
      .split('\n')
      .filter((line) => line.startsWith('td_player_rtt_ms'));

    expect(rows.length).toBeGreaterThan(0);
    // Границу корзины (`le`) разметкой не считаем: она часть самой
    // гистограммы, а не сведение о том, чей это обход.
    const labels = rows
      .flatMap((line) => /\{(.*)\}/.exec(line)?.[1]?.split(',') ?? [])
      .map((pair) => pair.split('=')[0]);

    expect([...new Set(labels)]).toEqual(['le']);

    bench.registry.close();
  });
});
