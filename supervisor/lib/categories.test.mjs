import { expect, it } from 'vitest';
import { categoriesProblem } from './categories.mjs';
import { parseCard, metaOf, joinDescription, labelKeysOf } from './card.mjs';
import { taskFromRequest } from './requests.mjs';

it('категории живут метками, протокол ожидания переживает запись описания', () => {
  const task = {
    id: '0001-test',
    type: 'feature',
    categories: ['ux', 'balance'],
    creationKey: 'parent:0:balance',
    reanalysis: true,
    analysisGeneration: 1,
    blockedContext: { reasons: ['нужен расчёт'], priority: 20 },
    dependsOn: ['0002-balance'],
  };
  const keys = labelKeysOf(task);
  const parsed = parseCard(
    {
      id: '65000000aabbccdd',
      name: 'Проверка',
      idList: 'new',
      idLabels: keys,
      desc: joinDescription('Человек', metaOf(task)),
    },
    { stateByList: new Map([['new', 'new']]), labelKeyById: new Map(keys.map((k) => [k, k])) },
  );
  expect(parsed.task).toMatchObject(task);
  expect(metaOf(task)).not.toHaveProperty('categories');
});

it('старая карточка без категории допустима, неизвестные категории отвергаются', () => {
  expect(categoriesProblem(undefined)).toBeNull();
  expect(categoriesProblem(['ux', 'ux'])).toBeTruthy();
  expect(categoriesProblem(['unknown'])).toBeTruthy();
  const result = taskFromRequest(
    { type: 'feature', title: 'UX', description: 'Описание', categories: ['ux'] },
    { id: '0001-test', now: '2026-09-07T12:00:00Z' },
  );
  expect(result.task.categories).toEqual(['ux']);
});
