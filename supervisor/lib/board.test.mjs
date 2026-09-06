import { describe, expect, it } from 'vitest';
import { escapeHtml, hoursIn, needsAttention, renderBoard } from './board.mjs';

/**
 * Проверки доски.
 *
 * Доска — единственное, что владелец продукта видит по своей воле, поэтому
 * проверяется то, что для него важно: задача попадает в ту колонку, где её
 * будут искать; ждущее ответа выделено; заголовок, написанный человеком,
 * не ломает страницу.
 */

const NOW = '2026-08-26T12:00:00+03:00';

const task = (over = {}) => ({
  id: '0001-one',
  type: 'feature',
  title: 'Образец задачи',
  status: 'new',
  priority: 50,
  createdAt: '2026-08-26T10:00:00+03:00',
  statusChangedAt: '2026-08-26T11:00:00+03:00',
  links: { change: null, pr: null, run: null, related: [] },
  ...over,
});

const board = (tasks) => renderBoard(tasks, { now: NOW });

describe('раскладка по колонкам', () => {
  it.each([
    ['new', 'Очередь'],
    ['design', 'В работе'],
    ['implement', 'В работе'],
    ['benchmark', 'Прогон'],
    ['pr', 'Проверки'],
    ['review', 'Ревью'],
    ['deploy', 'Выкладка'],
    ['awaiting-po', 'Ждут вас'],
    ['failed', 'Остановлены'],
    ['closed', 'Закрыты'],
  ])('состояние %s попадает в колонку «%s»', (status, column) => {
    const html = board([task({ status })]);
    const at = html.indexOf(column);
    const card = html.indexOf('0001-one');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(at);
  });

  it('пустая колонка так и говорит', () => {
    expect(board([])).toContain('пусто');
  });

  it('внутри колонки раньше идёт то, что раньше возьмут в работу', () => {
    const html = board([
      task({ id: '0002-later', priority: 90 }),
      task({ id: '0003-sooner', priority: 10 }),
    ]);
    expect(html.indexOf('0003-sooner')).toBeLessThan(html.indexOf('0002-later'));
  });
});

describe('внимание владельца продукта', () => {
  it('свежий вопрос тревоги не поднимает', () => {
    const fresh = task({ status: 'awaiting-po', statusChangedAt: '2026-08-26T11:00:00+03:00' });
    expect(needsAttention(fresh, NOW)).toBe(false);
    expect(board([fresh])).not.toContain('дольше суток');
  });

  it('вопрос старше суток выделен и назван вверху', () => {
    const stale = task({ status: 'awaiting-po', statusChangedAt: '2026-08-24T11:00:00+03:00' });
    expect(needsAttention(stale, NOW)).toBe(true);
    const html = board([stale]);
    expect(html).toContain('дольше суток');
    expect(html).toContain('card attention');
  });
});

describe('время в состоянии', () => {
  it('считается от последней смены состояния', () => {
    expect(Math.round(hoursIn(task(), NOW))).toBe(1);
  });

  it('битая отметка не роняет доску', () => {
    expect(hoursIn(task({ statusChangedAt: 'вчера', createdAt: 'позавчера' }), NOW)).toBe(0);
  });
});

describe('стойкость', () => {
  it('заголовок с угловыми скобками не ломает страницу', () => {
    const html = board([task({ title: '<script>беда</script>' })]);
    expect(html).not.toContain('<script>беда');
    expect(html).toContain('&lt;script&gt;');
  });

  it('экранирование не трогает обычный текст', () => {
    expect(escapeHtml('Тесла и стена')).toBe('Тесла и стена');
  });

  it('доска рисуется в обеих темах', () => {
    const html = board([task()]);
    expect(html).toContain('prefers-color-scheme: dark');
  });
});
