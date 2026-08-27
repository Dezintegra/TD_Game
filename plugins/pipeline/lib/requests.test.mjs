import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSchema, validateTask } from './validate-task.mjs';
import { nextId, planRequests, taskFromRequest, translit } from './requests.mjs';

/**
 * Проверки заявок на новые задачи.
 *
 * Главная проверка здесь одна: задача, собранная из заявки, обязана проходить
 * настоящую схему бэклога. Заявка приходит из отчёта сессии — по сути
 * из недоверенного места, — и запись, не прошедшую схему, конвейер потом
 * молча пропустит, а человек будет гадать, почему заведённая задача не идёт.
 */

const NOW = '2026-08-27T12:00:00+03:00';
const schema = loadSchema(fileURLToPath(new URL('../../../backlog/schema.json', import.meta.url)));

const request = (over = {}) => ({
  type: 'feature',
  title: 'Починить цену Теслы',
  description: 'Цена мешает ремонту, профиль перестаёт чинить постройки.',
  ...over,
});

describe('идентификатор', () => {
  it('первый номер начинается с единицы', () => {
    expect(nextId([], 'Проба')).toMatch(/^0001-/);
  });

  it('номер берётся на единицу больше занятого', () => {
    expect(nextId(['0001-one', '0007-seven', '0003-three'], 'Проба')).toMatch(/^0008-/);
  });

  it('закрытые номера не переиспользуются', () => {
    // Иначе имя ветки однажды совпадёт с именем давно убранной.
    expect(nextId(['0042-closed'], 'Новая')).toMatch(/^0043-/);
  });

  it('кириллица в заголовке становится латиницей', () => {
    expect(translit('Тесла')).toBe('tesla');
    expect(nextId([], 'Починить цену')).toBe('0001-pochinit-cenu');
  });

  it('заголовок без пригодных букв не оставляет пустого имени', () => {
    expect(nextId([], '!!! ???')).toBe('0001-zadacha');
  });
});

describe('задача из заявки', () => {
  it('собранная задача проходит настоящую схему бэклога', () => {
    const { task } = taskFromRequest(request(), {
      id: '0005-tesla',
      now: NOW,
      sourceId: '0001-one',
    });
    expect(validateTask(task, schema)).toEqual([]);
  });

  it('прогон собирается со всеми обязательными полями и проходит схему', () => {
    const { task } = taskFromRequest(
      request({
        type: 'run',
        title: 'Прогон арены',
        run: { kind: 'arena', expectation: 'Доли побед остаются в вилке 45–55.' },
      }),
      { id: '0006-arena', now: NOW, sourceId: '0001-one' },
    );
    expect(validateTask(task, schema)).toEqual([]);
    expect(task.run.kind).toBe('arena');
  });

  it('связь с породившей задачей проставляется', () => {
    const { task } = taskFromRequest(request(), {
      id: '0005-tesla',
      now: NOW,
      sourceId: '0001-one',
    });
    expect(task.links.related).toEqual(['0001-one']);
  });

  it('новая задача начинается в очереди и ничьей', () => {
    const { task } = taskFromRequest(request(), { id: '0005-tesla', now: NOW });
    expect(task).toMatchObject({ status: 'new', owner: null, history: [] });
  });
});

describe('негодные заявки', () => {
  it('без заголовка — отказ с причиной', () => {
    const { task, problems } = taskFromRequest(request({ title: '' }), { id: '0005-x', now: NOW });
    expect(task).toBeNull();
    expect(problems.join()).toContain('заголовка');
  });

  it('без описания — отказ', () => {
    const { problems } = taskFromRequest(request({ description: '  ' }), {
      id: '0005-x',
      now: NOW,
    });
    expect(problems.join()).toContain('описания');
  });

  it('неизвестный тип — отказ', () => {
    const { problems } = taskFromRequest(request({ type: 'улучшение' }), {
      id: '0005-x',
      now: NOW,
    });
    expect(problems.join()).toContain('неизвестный тип');
  });

  it('прогон без ожидаемого результата — отказ', () => {
    const { problems } = taskFromRequest(request({ type: 'run', run: { kind: 'arena' } }), {
      id: '0005-x',
      now: NOW,
    });
    expect(problems.join()).toContain('ожидаемого результата');
  });

  it('дикий приоритет приводится к разумному', () => {
    const { task } = taskFromRequest(request({ priority: 99999 }), { id: '0005-x', now: NOW });
    expect(task.priority).toBe(999);
  });
});

describe('разбор пачки заявок', () => {
  it('идентификаторы не повторяются', () => {
    const { planned } = planRequests(
      [request({ title: 'Раз' }), request({ title: 'Два' }), request({ title: 'Три' })],
      { existingIds: ['0001-one'], now: NOW, sourceId: '0001-one' },
    );
    expect(planned.map((task) => task.id)).toEqual(['0002-raz', '0003-dva', '0004-tri']);
  });

  it('негодная не отменяет годных', () => {
    const { planned, rejected } = planRequests([request(), request({ type: 'ерунда' })], {
      existingIds: [],
      now: NOW,
    });
    expect(planned).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('пустой перечень заявок ничего не порождает', () => {
    expect(planRequests(undefined, { existingIds: [], now: NOW })).toEqual({
      planned: [],
      rejected: [],
    });
  });
});
