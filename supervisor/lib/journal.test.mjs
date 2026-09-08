import { expect, it } from 'vitest';
import { journalBody } from './journal.mjs';

it('повторное сохранение выполненной задачи не публикует итог заново', () => {
  const text = journalBody({
    from: 'completed',
    to: 'completed',
    completionSummary: 'Итог реализации',
    what: 'Добавлена ссылка',
  });
  expect(text).not.toContain('Итог задачи');
  expect(text).toContain('Добавлена ссылка');
});

it('старая задача получает честное пояснение и известные ссылки', () => {
  const text = journalBody({
    from: 'cleanup',
    to: 'completed',
    what: 'Удалено дерево',
    links: { pr: 'https://github.com/example/repo/pull/1' },
  });
  expect(text).toContain('Подробный итог не сохранён');
  expect(text).toContain('https://github.com/example/repo/pull/1');
  expect(text).not.toContain('Удалено дерево');
});
