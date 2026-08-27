import { readFileSync } from 'node:fs';

/**
 * Проверка записи бэклога по схеме.
 *
 * Проверяющий читает саму `manage/schema.json` и толкует её, а не повторяет
 * состав полей у себя. Иначе правд стало бы две: схема подсказывала бы
 * редактору одно, а конвейер требовал другое, и разошлись бы они молча —
 * в тот день, когда кто-нибудь поправит только одну из них.
 *
 * Толкуется намеренно узкое подмножество JSON Schema — ровно то, что
 * встречается в нашей схеме. Полновесный проверяющий потребовал бы
 * зависимости, зависимость — правки файла блокировки, а правка файла
 * блокировки — установки на каждой машине. Цена несоразмерна предмету.
 *
 * Возвращается перечень бед на русском с указанием поля, а не первое
 * попавшееся исключение: задачу заводит человек, и ему нужно увидеть все
 * промахи разом, а не по одному за прогон.
 */

/** Отметка времени с обязательным смещением часового пояса. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;

/** Загрузить схему с диска. Отдельной функцией — чтобы тесты брали свою. */
export function loadSchema(schemaPath) {
  return JSON.parse(readFileSync(schemaPath, 'utf8'));
}

/** Имя типа так, как его понимает JSON Schema. */
function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Подходит ли значение под объявленный тип (или один из перечисленных). */
function matchesType(value, declared) {
  const wanted = Array.isArray(declared) ? declared : [declared];
  const actual = typeName(value);
  return wanted.some((type) => {
    if (type === 'integer') return actual === 'number' && Number.isInteger(value);
    if (type === 'number') return actual === 'number';
    return type === actual;
  });
}

/** Человеческое имя места: пустой путь — это сама запись. */
function place(path) {
  return path === '' ? 'запись' : `поле «${path}»`;
}

/**
 * Условная часть схемы: `if` проверяется молча, и когда он сошёлся,
 * применяется `then`. Несошедшийся `if` бедой не является — это ветвление,
 * а не требование.
 */
function conditionHolds(value, condition) {
  if (typeName(value) !== 'object') return false;
  for (const key of condition.required ?? []) {
    if (!(key in value)) return false;
  }
  for (const [key, sub] of Object.entries(condition.properties ?? {})) {
    if (!(key in value)) return false;
    if ('const' in sub && value[key] !== sub.const) return false;
    if (sub.enum && !sub.enum.includes(value[key])) return false;
  }
  return true;
}

/**
 * Проверить значение по схеме. Возвращает перечень бед; пустой перечень
 * означает годную запись.
 */
export function validate(value, schema, path = '') {
  const problems = [];

  if (schema.type && !matchesType(value, schema.type)) {
    const wanted = Array.isArray(schema.type) ? schema.type.join(' или ') : schema.type;
    problems.push(`${place(path)}: ожидался тип ${wanted}, получен ${typeName(value)}`);
    return problems; // дальше проверять нечего: тип не тот, остальное наврёт
  }

  if ('const' in schema && value !== schema.const) {
    problems.push(`${place(path)}: ожидалось значение ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(
      `${place(path)}: значение ${JSON.stringify(value)} не из списка (${schema.enum
        .map((item) => JSON.stringify(item))
        .join(', ')})`,
    );
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      problems.push(
        `${place(path)}: значение «${value}» не подходит под образец ${schema.pattern}`,
      );
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${place(path)}: короче ${schema.minLength} символов`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`${place(path)}: длиннее ${schema.maxLength} символов`);
    }
    if (schema.format === 'date-time' && !DATE_TIME.test(value)) {
      problems.push(
        `${place(path)}: «${value}» не отметка времени со смещением часового пояса ` +
          `(ждём вида 2026-08-26T15:00:00+03:00)`,
      );
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${place(path)}: меньше ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${place(path)}: больше ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      problems.push(...validate(item, schema.items, `${path}[${index}]`));
    });
  }

  if (typeName(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        problems.push(`${place(path)}: не хватает обязательного поля «${key}»`);
      }
    }

    const known = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in known)) {
          problems.push(`${place(path)}: лишнее поле «${key}»`);
        }
      }
    }

    for (const [key, sub] of Object.entries(known)) {
      if (key in value) {
        problems.push(...validate(value[key], sub, path === '' ? key : `${path}.${key}`));
      }
    }
  }

  for (const branch of schema.allOf ?? []) {
    if (branch.if && branch.then) {
      if (conditionHolds(value, branch.if)) {
        problems.push(...validate(value, branch.then, path));
      }
      continue;
    }
    problems.push(...validate(value, branch, path));
  }

  return problems;
}

/**
 * Проверить задачу и вернуть беды. Отдельной обёрткой ради имени: в местах
 * вызова читается «проверить задачу», а не «проверить значение по схеме».
 */
export function validateTask(task, schema) {
  return validate(task, schema, '');
}
