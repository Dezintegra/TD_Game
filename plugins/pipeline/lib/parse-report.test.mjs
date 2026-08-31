import { describe, expect, it } from 'vitest';
import { parseReport } from './parse-report.mjs';

/**
 * Проверки разбора отчёта.
 *
 * Терпимость здесь не поблажка, а расчёт. Строгий разбор объявил бы
 * неудавшимся этап, добавивший к отчёту строку пояснения, — а он её добавит.
 * Цена ошибки несимметрична: лишняя строка вокруг отчёта не стоит ничего,
 * а потерянный отчёт стоит целого этапа работы.
 */

const report = {
  taskId: '0042-fix',
  stage: 'implement',
  outcome: 'done',
  summary: 'сделано',
};

describe('чистый ответ', () => {
  it('разбирается', () => {
    expect(parseReport(JSON.stringify(report)).report).toEqual(report);
  });
});

describe('приписки вокруг', () => {
  it('текст до отчёта не мешает', () => {
    const text = `Готово, вот отчёт:\n${JSON.stringify(report)}`;
    expect(parseReport(text).report.taskId).toBe('0042-fix');
  });

  it('текст после отчёта не мешает', () => {
    const text = `${JSON.stringify(report)}\n\nЕсли нужно что-то ещё — скажите.`;
    expect(parseReport(text).report.outcome).toBe('done');
  });

  it('ограда из трёх кавычек не мешает', () => {
    const text = `Отчёт:\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
    expect(parseReport(text).report.stage).toBe('implement');
  });
});

describe('несколько объектов в ответе', () => {
  it('берётся последний годный: этап мог показать образец по пути', () => {
    const sample = JSON.stringify({ type: 'run', title: 'образец заявки' });
    const text = `Заявку оформлю так: ${sample}\n\nОтчёт:\n${JSON.stringify(report)}`;
    expect(parseReport(text).report.taskId).toBe('0042-fix');
  });

  it('вложенные объекты отдельными кандидатами не считаются', () => {
    const full = { ...report, links: { pr: 137, change: 'fix' } };
    expect(parseReport(JSON.stringify(full)).report.links.pr).toBe(137);
  });
});

describe('скобка внутри строки', () => {
  it('не обрывает объект на середине', () => {
    const tricky = { ...report, summary: 'ветка названа по образцу {id}-{имя}' };
    expect(parseReport(JSON.stringify(tricky)).report.summary).toContain('{id}');
  });

  it('экранированная кавычка тоже не обрывает', () => {
    const tricky = { ...report, summary: 'сессия ответила "готово" и вышла' };
    expect(parseReport(JSON.stringify(tricky)).report.summary).toContain('готово');
  });
});

describe('отчёта нет', () => {
  it('текст без JSON — отказ с причиной, а не молчание', () => {
    const { report: none, why } = parseReport('Я всё сделал, но отчёт составить забыл.');
    expect(none).toBe(null);
    expect(why).toContain('нет ни одного объекта');
  });

  it('JSON без обязательных полей — тоже отказ, и причина другая', () => {
    const { report: none, why } = parseReport(JSON.stringify({ summary: 'что-то' }));
    expect(none).toBe(null);
    expect(why).toContain('обязательных полей');
  });

  it('пустой ответ — отказ', () => {
    expect(parseReport('').report).toBe(null);
  });

  it('незакрытая скобка не роняет разбор', () => {
    expect(parseReport('{"taskId": "0042-fix", "stage": "implement"').report).toBe(null);
  });
});
