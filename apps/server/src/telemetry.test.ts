import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COUNT_BOUNDS,
  COUNT_BUDGET,
  JUMP_BOUNDS_CELLS,
  MS_PER_TICK,
  createHistogram,
} from '@td/shared';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './main.js';
import type { ReadingsSink } from './readings.js';

/**
 * Отчёт о плавности приходит из недоверенного источника: его шлёт
 * браузер игрока. Проверяется здесь не арифметика слияния — она
 * проверена в `metrics.test.ts`, — а поведение точки приёма:
 * что принимается, что отвергается и что при этом считается.
 *
 * Отдельного внимания стоит набор про показ. Он необязательный, и это
 * не послабление: открытая вкладка живёт дольше выкладки, и отчёт
 * от прежнего бандла обязан приниматься, иначе счётчик отвергнутых
 * покраснеет от нашей же выкладки.
 *
 * Каждый отчёт предъявляет билет: матч и сторону сервер берёт из него,
 * а не из тела. Билет у каждой проверки свой, и это не осторожность
 * впрок — снимки накопительные, и в общие ряды вливается разность
 * с прошлым снимком того же билета. Один билет на все проверки означал
 * бы, что вторая из них вливает ноль.
 */

let app: FastifyInstance;
let readings: ReadingsSink;
let issued = 0;

beforeAll(async () => {
  const built = await buildServer({ record: false, readings: false });
  app = built.app;
  readings = built.readings;
});

/** Свежий билет живого матча — такой, какой выдал бы сервер. */
const freshTicket = (): string => {
  issued += 1;
  const ticket = `ticket-${String(issued)}`;
  readings.matchStarted(`m${String(issued)}`, new Map([[ticket, 0]]));

  return ticket;
};

afterAll(async () => {
  await app.close();
});

/** Правдоподобный набор корзин — тот же, что копит клиент. */
const snapshotOf = (values: readonly number[]): unknown => {
  const histogram = createHistogram();
  for (const value of values) histogram.add(value);

  return histogram.snapshot();
};

/** Скачки: границы в клетках. */
const jumpsOf = (values: readonly number[]): unknown => {
  const histogram = createHistogram({ bounds: JUMP_BOUNDS_CELLS, budget: COUNT_BUDGET });
  for (const value of values) histogram.add(value);

  return histogram.snapshot();
};

/** То же для счётных величин: границы в штуках, а не в миллисекундах. */
const countsOf = (values: readonly number[]): unknown => {
  const histogram = createHistogram({ bounds: COUNT_BOUNDS, budget: COUNT_BUDGET });
  for (const value of values) histogram.add(value);

  return histogram.snapshot();
};

const rowValue = async (name: string): Promise<number> => {
  const response = await app.inject({ method: 'GET', url: '/metrics' });
  const line = response.body.split('\n').find((each) => each.startsWith(`${name} `));
  if (line === undefined) throw new Error(`ряда ${name} нет в отдаче`);

  return Number(line.slice(name.length + 1));
};

const report = (body: object, ticket = freshTicket()): Promise<{ statusCode: number }> =>
  app.inject({ method: 'POST', url: '/api/telemetry', payload: { ticket, ...body } });

describe('отчёт о плавности', () => {
  it('принимает набор про показ и отдаёт его отдельным рядом', async () => {
    const before = await rowValue('td_client_display_gap_ms_count{source="client"}');

    const response = await report({
      frame: snapshotOf([16, 17]),
      netGap: snapshotOf([33, 120]),
      displayGap: snapshotOf([33, 34, 33]),
    });

    expect(response.statusCode).toBe(204);
    expect(await rowValue('td_client_display_gap_ms_count{source="client"}')).toBe(before + 3);
  });

  it('принимает отчёт без набора про показ', async () => {
    const accepted = await rowValue('td_client_reports_total');
    const display = await rowValue('td_client_display_gap_ms_count{source="client"}');

    const response = await report({
      frame: snapshotOf([16]),
      netGap: snapshotOf([33]),
    });

    expect(response.statusCode).toBe(204);
    expect(await rowValue('td_client_reports_total')).toBe(accepted + 1);
    // Отчёт принят, но выдумывать за него нечего: ряд показа не вырос.
    expect(await rowValue('td_client_display_gap_ms_count{source="client"}')).toBe(display);
  });

  it('отвергает отчёт с порченым набором про показ целиком', async () => {
    const rejected = await rowValue('td_client_reports_rejected_total');

    const response = await report({
      frame: snapshotOf([16]),
      netGap: snapshotOf([33]),
      displayGap: { buckets: 'не корзины', count: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(await rowValue('td_client_reports_rejected_total')).toBe(rejected + 1);
  });

  it('превышение бюджета в наборе показа доезжает точным числом', async () => {
    // Именно ради этого числа всё и затевалось: сколько раз мир на
    // экране простоял дольше тика. Округли его до корзины — и разница
    // между «ровно» и «рывками» перестала бы читаться.
    const before = await rowValue('td_client_display_gap_ms_over_budget{source="client"}');

    await report({
      frame: snapshotOf([16]),
      netGap: snapshotOf([33]),
      displayGap: snapshotOf([MS_PER_TICK * 3, MS_PER_TICK * 4, 1]),
    });

    expect(await rowValue('td_client_display_gap_ms_over_budget{source="client"}')).toBe(
      before + 2,
    );
  });
  it('принимает набор сдвигов и считает каждый ненулевой превышением', async () => {
    // Ноль здесь — норма, а не отсутствие данных: команда исполнена там,
    // где её ждали. Превышением считается любой сдвиг, потому что один
    // сдвинутый такт — это уже показанное игроку «не то».
    const before = await rowValue('td_client_command_shift_ticks_count{source="client"}');
    const overBefore = await rowValue('td_client_command_shift_ticks_over_budget{source="client"}');

    const response = await report({
      frame: snapshotOf([16]),
      netGap: snapshotOf([33]),
      shift: countsOf([0, 0, 1, 3]),
    });

    expect(response.statusCode).toBe(204);
    expect(await rowValue('td_client_command_shift_ticks_count{source="client"}')).toBe(before + 4);
    expect(await rowValue('td_client_command_shift_ticks_over_budget{source="client"}')).toBe(
      overBefore + 2,
    );
  });

  it('отчёт без набора сдвигов принимается', async () => {
    // Открытая вкладка живёт дольше выкладки: отчёт от прежнего бандла
    // обязан приниматься, иначе счётчик отвергнутых покраснеет от нашей
    // же выкладки.
    const accepted = await rowValue('td_client_reports_total');

    const response = await report({ frame: snapshotOf([16]), netGap: snapshotOf([33]) });

    expect(response.statusCode).toBe(204);
    expect(await rowValue('td_client_reports_total')).toBe(accepted + 1);
  });

  it('порченый набор сдвигов отвергает отчёт целиком', async () => {
    const rejected = await rowValue('td_client_reports_rejected_total');

    const response = await report({
      frame: snapshotOf([16]),
      netGap: snapshotOf([33]),
      shift: { buckets: [{ bound: 0, count: 1 }], count: 'много' },
    });

    expect(response.statusCode).toBe(400);
    expect(await rowValue('td_client_reports_rejected_total')).toBe(rejected + 1);
  });
  it('скачки и очередь при них доезжают своими рядами', async () => {
    // Две величины, которые имеют смысл только вместе: насколько
    // дёрнулось и сколько своих команд висело в этот момент.
    const jumps = await rowValue('td_client_general_jump_cells_count{source="client"}');
    const queue = await rowValue('td_client_pending_on_jump_count{source="client"}');

    const response = await report({
      frame: snapshotOf([16]),
      netGap: snapshotOf([33]),
      jump: jumpsOf([0.4, 1.2, 2.5]),
      pendingOnJump: countsOf([1, 2, 4]),
    });

    expect(response.statusCode).toBe(204);
    expect(await rowValue('td_client_general_jump_cells_count{source="client"}')).toBe(jumps + 3);
    expect(await rowValue('td_client_pending_on_jump_count{source="client"}')).toBe(queue + 3);
    // Самый большой скачок — точное число, а не оценка по корзинам:
    // именно на него и смотрят.
    expect(
      await rowValue('td_client_general_jump_cells_max{source="client"}'),
    ).toBeGreaterThanOrEqual(2.5);
  });

  it('порченый набор скачков отвергает отчёт целиком', async () => {
    const rejected = await rowValue('td_client_reports_rejected_total');

    const response = await report({
      frame: snapshotOf([16]),
      netGap: snapshotOf([33]),
      jump: { buckets: [{ bound: 0.25, count: -1 }], count: 1, sum: -5 },
    });

    expect(response.statusCode).toBe(400);
    expect(await rowValue('td_client_reports_rejected_total')).toBe(rejected + 1);
  });
});

describe('опознание отчёта', () => {
  it('без билета отчёт отвергается', async () => {
    // Точка приёма смотрит в интернет. Прими она отчёт без билета —
    // и завести файл несуществующего матча мог бы кто угодно.
    const rejected = await rowValue('td_client_reports_rejected_total');

    const response = await app.inject({
      method: 'POST',
      url: '/api/telemetry',
      payload: { frame: snapshotOf([16]), netGap: snapshotOf([33]) },
    });

    expect(response.statusCode).toBe(400);
    expect(await rowValue('td_client_reports_rejected_total')).toBe(rejected + 1);
  });

  it('с выдуманным билетом отчёт отвергается', async () => {
    const response = await report({ frame: snapshotOf([16]) }, 'такого-билета-нет');

    expect(response.statusCode).toBe(400);
  });

  it('матч и сторона из тела запроса не берутся', async () => {
    // Назвавшись чужим матчем, дописать в его файл нельзя: сторона
    // и матч приходят из билета, а тело на этот счёт не спрашивают.
    const response = await report({
      matchId: 'чужой-матч',
      side: 1,
      frame: snapshotOf([16]),
    });

    expect(response.statusCode).toBe(204);
  });

  it('пустой отчёт отвергается', async () => {
    // Отчёт без единого ряда не несёт ничего, и принимать его значило
    // бы считать доставленным то, чего не было.
    const response = await report({});

    expect(response.statusCode).toBe(400);
  });

  it('повторный накопительный снимок не удваивает ряды', async () => {
    // Главное свойство всей затеи: клиент шлёт копилку целиком каждые
    // пять секунд, и сколько бы раз он её ни прислал, наблюдений
    // в общих рядах столько же, сколько он их сделал.
    const ticket = freshTicket();
    const before = await rowValue('td_client_general_jump_cells_count{source="client"}');

    await report({ jump: jumpsOf([0.4, 1.2]) }, ticket);
    await report({ jump: jumpsOf([0.4, 1.2]) }, ticket);
    await report({ jump: jumpsOf([0.4, 1.2]) }, ticket);

    expect(await rowValue('td_client_general_jump_cells_count{source="client"}')).toBe(before + 2);
  });

  it('приращение доезжает следующим снимком', async () => {
    const ticket = freshTicket();
    const before = await rowValue('td_client_general_jump_cells_count{source="client"}');

    await report({ jump: jumpsOf([0.4, 1.2]) }, ticket);
    await report({ jump: jumpsOf([0.4, 1.2, 2.5]) }, ticket);

    expect(await rowValue('td_client_general_jump_cells_count{source="client"}')).toBe(before + 3);
  });

  it('после конца матча последний снимок ещё принимается', async () => {
    // Он же и самый нужный: в нём итог всей партии. Уходит он по исходу
    // матча, то есть заведомо позже, чем сиденье снято реестром.
    const ticket = freshTicket();
    readings.matchFinished(`m${String(issued)}`);

    const response = await report({ frame: snapshotOf([16]) }, ticket);

    expect(response.statusCode).toBe(204);
  });
});
