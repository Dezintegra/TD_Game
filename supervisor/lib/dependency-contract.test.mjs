import { describe, expect, it, vi } from 'vitest';

// Постоянный путь Trello не должен оживать за счёт удаляемого файлового хранилища.
vi.mock('./backlog.mjs', () => {
  throw new Error('legacy file store unavailable');
});
vi.mock('./validate-task.mjs', () => {
  throw new Error('legacy schema unavailable');
});

import { parseCard, metaOf, joinDescription } from './card.mjs';
import { sortCards } from './validate-card.mjs';
import { taskFromRequest } from './requests.mjs';
import { dependencyFormatProblem, pendingDependencies } from './dependencies.mjs';
import { scan } from './scan.mjs';
import { resolveConfig } from '../config/defaults.mjs';

const result = { taskId: '0002-base', kind: 'merged-pr', pr: 168 };
const dependent = (dependencyResults = [result]) => ({
  id: '0001-next',
  type: 'feature',
  status: 'new',
  title: 'Next',
  description: 'Wait',
  dependsOn: ['0002-base'],
  dependencyResults,
});
const base = { id: '0002-base', status: 'closed', links: { pr: 168 } };
const ctx = {
  stateByList: new Map([['new', 'new']]),
  labelKeyById: new Map([['feature', 'feature']]),
};
const parse = (task) =>
  parseCard(
    {
      id: '65000000abcdef',
      name: task.title,
      idList: 'new',
      idLabels: ['feature'],
      pos: 1,
      desc: joinDescription(task.description, metaOf(task)),
    },
    ctx,
  );
const { config } = resolveConfig({ commands: { verify: 'x', deploy: 'x', perf: 'x' } });
const invalidResults = [
  null,
  {},
  'merged-pr',
  [null],
  [168],
  [{}],
  [{ ...result, kind: 'closed' }],
  ...[0, -1, 1.5, '168', null].map((pr) => [{ ...result, pr }]),
  [{ ...result, extra: true }],
  [{ ...result, taskId: '0003-absent' }],
  [{ ...result, taskId: 'short' }],
  [result, result],
];

describe('постоянный контракт результата без файлового хранилища', () => {
  it('сохраняет результат заявки через чтение и повторную запись карточки', () => {
    const made = taskFromRequest(dependent(), { id: '0001-next', now: '2026-09-06T00:00:00Z' });
    expect(made.problems).toEqual([]);
    const parsed = parse(made.task);
    expect(sortCards([parsed]).invalid).toEqual([]);
    expect(metaOf(parsed.task).dependencyResults).toEqual([result]);
    expect(parse(parsed.task).task.dependencyResults).toEqual([result]);
    expect(pendingDependencies(parsed.task, [base]).join()).toContain('PR #168');
    expect(scan({ config, tasks: [parsed.task, base] }).actions).toEqual([]);
  });
  it.each(invalidResults.map((value) => [value]))(
    'удерживает неверное объявление %j и отвергает заявку',
    (value) => {
      const task = dependent(value);
      expect(dependencyFormatProblem(task)).toContain('dependencyResults');
      expect(taskFromRequest(task, { id: task.id }).task).toBeNull();
      const parsed = parse(task);
      expect(sortCards([parsed]).invalid).toEqual([]);
      expect(metaOf(parsed.task).dependencyResults).toEqual(value);
      expect(scan({ config, tasks: [parsed.task, base] }).actions).toEqual([]);
    },
  );
  it('не принимает результат без dependsOn и сохраняет отсутствие поля', () => {
    expect(dependencyFormatProblem({ dependencyResults: [result] })).toContain('dependencyResults');
    const task = dependent();
    delete task.dependencyResults;
    expect(metaOf(parse(task).task)).not.toHaveProperty('dependencyResults');
    expect(pendingDependencies(task, [base])).toEqual([]);
    expect(pendingDependencies(dependent([]), [base])).toEqual([]);
  });
  it('не принимает флаг успеха без полей доказательства', () => {
    expect(
      pendingDependencies(dependent(), [base], [], { evidence: { 168: true }, mainBranch: 'main' }),
    ).not.toEqual([]);
  });
});
