import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSchema, validateTask } from './validate-task.mjs';

/**
 * Проверки годности записи бэклога.
 *
 * Схема берётся настоящая, из `manage/schema.json`: проверять
 * самодельную копию значило бы проверять копию, а не то, чем пользуется
 * редактор и конвейер.
 */

const repoRoot = new URL('../../', import.meta.url);
const schema = loadSchema(fileURLToPath(new URL('manage/schema.json', repoRoot)));

/** Прочитать образец задачи из `manage/examples/`. */
const example = (name) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`manage/examples/${name}.json`, repoRoot)), 'utf8'),
  );

/** Годная задача-доработка, от которой отталкиваются проверки поломок. */
const feature = () => example('feature');

describe('образцы задач', () => {
  it.each(['feature', 'run', 'note'])('образец %s годен', (name) => {
    expect(validateTask(example(name), schema)).toEqual([]);
  });
});

describe('поля возврата из ошибки', () => {
  it('запись с вердиктом разбора и зоной причины годна', () => {
    // По вердикту конвейер возвращает задачу из ошибки сам, по зоне —
    // заводит заявку мимо кандидатов. Схема, не знающая этих полей,
    // отвергла бы такую запись у файлового хранилища молча.
    const task = {
      ...feature(),
      area: 'pipeline',
      recovery: { causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 1 },
    };
    expect(validateTask(task, schema)).toEqual([]);
  });

  it('вердикт из двух слов, а не из любого', () => {
    const task = { ...feature(), recovery: { causedBy: 'кто-то', fixedBy: [], returns: 0 } };
    expect(validateTask(task, schema)).toHaveLength(1);
  });
});

describe('обязательные поля', () => {
  it('пропущенное поле названо по имени', () => {
    const task = feature();
    delete task.priority;
    expect(validateTask(task, schema)).toEqual([
      'запись: не хватает обязательного поля «priority»',
    ]);
  });

  it('лишнее поле названо по имени', () => {
    const task = { ...feature(), похоже: 'на опечатку' };
    expect(validateTask(task, schema)).toEqual(['запись: лишнее поле «похоже»']);
  });

  it('перечисляются все беды разом, а не первая', () => {
    const task = feature();
    delete task.priority;
    delete task.owner;
    expect(validateTask(task, schema)).toHaveLength(2);
  });
});

describe('значения полей', () => {
  it('идентификатор обязан быть вида число-имя', () => {
    const task = { ...feature(), id: 'Просто Имя' };
    expect(validateTask(task, schema).join()).toContain('не подходит под образец');
  });

  it('незнакомое состояние отвергается', () => {
    const task = { ...feature(), status: 'почти-готово' };
    expect(validateTask(task, schema).join()).toContain('не из списка');
  });

  it('отметка времени без часового пояса отвергается', () => {
    const task = { ...feature(), createdAt: '2026-08-26T12:00:00' };
    expect(validateTask(task, schema).join()).toContain('смещением часового пояса');
  });

  it('отрицательный приоритет отвергается', () => {
    const task = { ...feature(), priority: -1 };
    expect(validateTask(task, schema).join()).toContain('меньше 0');
  });

  it('дробный приоритет отвергается', () => {
    const task = { ...feature(), priority: 1.5 };
    expect(validateTask(task, schema).join()).toContain('ожидался тип integer');
  });
});

describe('условные требования', () => {
  it('прогон без ожидаемого результата отвергается', () => {
    const task = example('run');
    delete task.run.expectation;
    expect(validateTask(task, schema)).toEqual([
      'поле «run»: не хватает обязательного поля «expectation»',
    ]);
  });

  it('прогон без раздела run отвергается', () => {
    const task = example('run');
    delete task.run;
    expect(validateTask(task, schema)).toEqual(['запись: не хватает обязательного поля «run»']);
  });

  it('доработке раздел run не нужен', () => {
    expect(validateTask(feature(), schema)).toEqual([]);
  });

  it('ожидание ответа требует и вопроса, и состояния возврата', () => {
    const task = { ...feature(), status: 'awaiting-po' };
    const problems = validateTask(task, schema);
    expect(problems.join()).toContain('«question»');
    expect(problems).toHaveLength(1); // returnTo уже есть, пусть и пустое
  });

  it('ожидание ответа с вопросом и возвратом годно', () => {
    const task = {
      ...feature(),
      status: 'awaiting-po',
      returnTo: 'design',
      question: { askedAt: '2026-08-26T15:00:00+03:00', summary: 'Какой из двух вариантов?' },
    };
    expect(validateTask(task, schema)).toEqual([]);
  });
});

describe('вложенные записи', () => {
  it('беда внутри истории указывает на место', () => {
    const task = feature();
    task.history = [{ at: '2026-08-26T12:00:00+03:00', from: 'new', to: 'design' }, { from: 'a' }];
    const problems = validateTask(task, schema).join();
    expect(problems).toContain('history[1]');
    expect(problems).toContain('«at»');
  });

  it('беда внутри ссылок указывает на место', () => {
    const task = feature();
    task.links.pr = 'сорок два';
    expect(validateTask(task, schema).join()).toContain('поле «links.pr»');
  });
});
