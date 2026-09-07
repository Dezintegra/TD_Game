import { describe, expect, it } from 'vitest';
import { canTransition, isResource, NEEDS_SESSION, TERMINAL } from '../config/transitions.mjs';
import { applyReport } from './apply-report.mjs';
import { mayCleanup } from './cleanup.mjs';
import { pendingDependencies } from './dependencies.mjs';

describe('выполнение постановки отдельно от закрытия', () => {
  it('выполненная задача терминальна и не занимает сессию', () => {
    const task = { type: 'feature', status: 'completed' };
    expect(TERMINAL).toContain('completed');
    expect(NEEDS_SESSION).not.toContain('completed');
    expect(isResource(task)).toBe(false);
    for (const to of ['design', 'decompose', 'closed', 'failed']) {
      expect(canTransition(task, to).ok).toBe(false);
    }
  });

  it.each([
    ['interpret', 'run', [], 'completed'],
    ['triage', 'note', [], 'completed'],
    ['triage', 'note', [{ type: 'feature' }], 'closed'],
  ])('%s: заявки не подменяют выполнение исходной постановки', (stage, type, requests, status) => {
    expect(
      applyReport(
        { type, status: stage },
        {
          stage,
          outcome: 'done',
          requests,
          summary: 'Вопрос разобран, работа передана заявкам при их наличии.',
        },
      ).status,
    ).toBe(status);
  });

  it.each(['unknown', 'open', 'closed', undefined])(
    'отсутствие дерева не подтверждает PR в состоянии %s',
    (state) => {
      expect(mayCleanup({ task: { links: { pr: 7 } }, entry: null, pr: { state } }).verdict).toBe(
        state === 'unknown' ? 'wait' : 'fail',
      );
    },
  );

  it('закрытие без выполнения не разрешает запуск зависимости', () => {
    const task = { id: '0002-next', dependsOn: ['0001-base'] };
    expect(pendingDependencies(task, [{ id: '0001-base', status: 'closed' }])).not.toEqual([]);
    expect(pendingDependencies(task, [{ id: '0001-base', status: 'completed' }])).toEqual([]);
  });
});

it.each(['Проверено по постановке и актуальному решению', ''])(
  'снятие предмета заметки требует доказательства: %s',
  (evidence) => {
    const result = applyReport(
      { type: 'note', status: 'triage' },
      { stage: 'triage', outcome: 'moot', evidence, summary: 'Требуемое правило уже действует.' },
    );
    expect(result.status).toBe(evidence ? 'closed' : 'postmortem');
  },
);
