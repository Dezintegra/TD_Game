import { createHistogram } from './histogram.js';
import { describe, expect, it } from 'vitest';
import { createMetrics, mergeReport } from './metrics.js';

/**
 * Приборы отдают показания в интернет.
 *
 * Точка отдачи по природе своей доступна тому, кто дотянулся до порта,
 * а игровой сервер стоит не за забором. Поэтому здесь проверяется
 * не только то, что вывод разбираем, но и то, чего в нём нет.
 */
describe('отдача показаний', () => {
  it('корзины накопительные, как того требует формат', () => {
    const metrics = createMetrics();
    const hist = metrics.histogram('td_probe_ms', 'Проба');
    hist.add(0.5);
    hist.add(0.5);
    hist.add(3);

    const text = metrics.render();
    const bucketOf = (le: string): number => {
      const match = new RegExp(`td_probe_ms_bucket\\{le="${le}"\\} (\\d+)`).exec(text);
      return match === null ? -1 : Number(match[1]);
    };

    // Два наблюдения по полмиллисекунды лежат и в корзине «не больше
    // одной», и во всех следующих: накопление и есть смысл формата.
    expect(bucketOf('1')).toBe(2);
    expect(bucketOf('4')).toBe(3);
    expect(bucketOf('\\+Inf')).toBe(3);
    expect(text).toContain('td_probe_ms_count 3');
  });

  it('максимум и превышения отдаются точными числами', () => {
    const metrics = createMetrics();
    const hist = metrics.histogram('td_probe_ms', 'Проба');
    hist.add(1);
    hist.add(197.4);

    const text = metrics.render();

    // Не верхняя граница корзины: хвост и есть то, ради чего всё
    // затевалось, и оценкой шириной в корзину он не описывается.
    expect(text).toContain('td_probe_ms_max 197.400');
    expect(text).toContain('td_probe_ms_over_budget 1');
  });

  it('один и тот же прибор не раздваивается от порядка разметки', () => {
    const metrics = createMetrics();
    const first = metrics.histogram('td_probe_ms', 'Проба', { profile: 'swarm', side: '0' });
    const second = metrics.histogram('td_probe_ms', 'Проба', { side: '0', profile: 'swarm' });

    expect(second).toBe(first);
  });

  it('заголовок повторяется один раз на имя, а не на каждый ряд', () => {
    // Требование формата: повторный HELP делает вывод неразбираемым.
    const metrics = createMetrics();
    metrics.histogram('td_probe_ms', 'Проба', { profile: 'swarm' }).add(1);
    metrics.histogram('td_probe_ms', 'Проба', { profile: 'bulwark' }).add(1);

    const text = metrics.render();

    expect(text.match(/# HELP td_probe_ms /g)).toHaveLength(1);
    expect(text.match(/# TYPE td_probe_ms /g)).toHaveLength(1);
    expect(text).toContain('profile="swarm"');
    expect(text).toContain('profile="bulwark"');
  });

  it('кавычки в разметке не ломают вывод', () => {
    const metrics = createMetrics();
    metrics.histogram('td_probe_ms', 'Проба', { profile: 'а"б\\в' }).add(1);

    expect(metrics.render()).toContain('profile="а\\"б\\\\в"');
  });

  it('счётчики и мгновенные величины отдаются', () => {
    const metrics = createMetrics();
    metrics.counter('td_probe_total', 'Счёт').add();
    metrics.counter('td_probe_total', 'Счёт').add(4);
    metrics.gauge('td_probe_now', 'Мгновенное', () => 7);

    const text = metrics.render();

    expect(text).toContain('td_probe_total 5');
    expect(text).toContain('td_probe_now 7');
  });

  it('отчёт игрока вливается корзинами', () => {
    const here = createHistogram();
    const fromBrowser = createHistogram();
    fromBrowser.add(1);
    fromBrowser.add(100);

    expect(mergeReport(here, JSON.parse(JSON.stringify(fromBrowser.snapshot())))).toBe(true);

    const snap = here.snapshot();
    expect(snap.count).toBe(2);
    expect(snap.max).toBe(100);
  });

  it('чепуха из браузера отвергается целиком', () => {
    // Тело запроса приходит от игрока. Прислать он может что угодно,
    // и каждая из этих попыток однажды случится.
    const here = createHistogram();
    here.add(5);

    const good = JSON.parse(JSON.stringify(createHistogram().snapshot())) as unknown;

    expect(mergeReport(here, undefined)).toBe(false);
    expect(mergeReport(here, null)).toBe(false);
    expect(mergeReport(here, 'не снимок')).toBe(false);
    expect(mergeReport(here, {})).toBe(false);
    expect(mergeReport(here, { ...(good as object), buckets: 'не массив' })).toBe(false);
    expect(mergeReport(here, { ...(good as object), count: '10' })).toBe(false);
    expect(mergeReport(here, { ...(good as object), buckets: [{ bound: 1 }] })).toBe(false);

    // Ни одна попытка не оставила следа в настоящей выборке.
    expect(here.snapshot().count).toBe(1);
  });

  it('невозможно большой отчёт не принимается', () => {
    // Матч в двадцать минут при ста двадцати кадрах в секунду даёт
    // сто сорок четыре тысячи кадров. Миллион — заведомо выдумка,
    // и принять её значило бы дать одному запросу перевесить все
    // настоящие.
    const here = createHistogram();
    const huge = createHistogram();
    huge.add(1);

    expect(
      mergeReport(here, { ...JSON.parse(JSON.stringify(huge.snapshot())), count: 5_000_000 }),
    ).toBe(false);
    expect(here.snapshot().count).toBe(0);
  });

  it('мгновенная величина читается в момент опроса, а не при заведении', () => {
    const metrics = createMetrics();
    let running = 0;
    metrics.gauge('td_matches_running', 'Матчей', () => running);

    expect(metrics.render()).toContain('td_matches_running 0');
    running = 3;
    expect(metrics.render()).toContain('td_matches_running 3');
  });
});
