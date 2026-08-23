import { describe, expect, it } from 'vitest';
import { createMetrics } from './metrics.js';

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

  it('мгновенная величина читается в момент опроса, а не при заведении', () => {
    const metrics = createMetrics();
    let running = 0;
    metrics.gauge('td_matches_running', 'Матчей', () => running);

    expect(metrics.render()).toContain('td_matches_running 0');
    running = 3;
    expect(metrics.render()).toContain('td_matches_running 3');
  });
});
