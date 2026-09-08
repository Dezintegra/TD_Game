import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { canTransition, stateClass } from '../config/transitions.mjs';
import { joinDescription, metaOf, parseCard, splitDescription } from './card.mjs';
import { applyTransition } from './task-file.mjs';
import { tokenAdmission, tokenHoldProblem } from './token-hold.mjs';

const config = { ...resolveConfig({}).config, provider: 'codex', codexMaxTaskTokens: 100 };
const task = {
  id: '0001-test',
  type: 'feature',
  status: 'implement',
  returnTo: 'audit',
  statusChangedAt: '2026-09-07T00:00:00Z',
  priority: 42,
  attempts: { continuations: 2, rejections: 1 },
  links: { pr: 205 },
};
const hold = {
  originStatus: 'implement',
  resumeStatus: 'implement',
  originPriority: 42,
  originSince: task.statusChangedAt,
  originReturnTo: 'audit',
  ...tokenAdmission(task, 'implement', config, { '0001-test': { session: 100 } }),
};

describe('контекст ожидания бюджета', () => {
  it('переживает запись Trello, отделяя панель от текста владельца', () => {
    const held = { ...task, status: 'token-limit', tokenHold: hold };
    const description = joinDescription(
      'Текст владельца.\n\n## Ожидаемый результат\nЦифры.',
      metaOf(held),
    );
    expect(description).toContain('**Расход:** 100');
    expect(description).toContain('**Лимит:** 100');
    expect(description).toContain('Лимит токенов: <полный бюджет>');
    const parsed = parseCard(
      {
        id: '6a9db98569e45a21ffed1107',
        desc: description,
        name: 'Проба',
        idList: 'budget',
        idLabels: ['feature'],
        pos: 8,
      },
      {
        stateByList: new Map([['budget', 'token-limit']]),
        labelKeyById: new Map([['feature', 'feature']]),
      },
    ).task;
    expect(parsed.tokenHold).toEqual(hold);
    expect(parsed.returnTo).toBe('audit');
    expect(parsed.description).toBe('Текст владельца.\n\n## Ожидаемый результат\nЦифры.');
    expect(parsed.userTokenLimit).toBeUndefined();
    expect(
      joinDescription(parsed.description, metaOf(parsed)).match(/## Лимит токенов/g),
    ).toHaveLength(1);
    delete parsed.tokenHold;
    expect(joinDescription(parsed.description, metaOf(parsed))).not.toContain('token-budget-panel');
    expect(splitDescription(description).human).not.toContain('Расход');
  });

  it('переходы удержания и возврата не сбрасывают счётчики и returnTo', () => {
    const moved = applyTransition(
      { ...task, tokenHold: hold },
      {
        status: 'token-limit',
        now: '2026-09-07T01:00:00Z',
        note: 'Бюджет',
      },
    ).task;
    expect(moved.attempts).toEqual(task.attempts);
    expect(moved.returnTo).toBe('audit');
    expect(stateClass(moved)).toBe('waiting');
    expect(tokenHoldProblem(moved)).toBeNull();
    expect(canTransition(moved, 'design').ok).toBe(false);
    expect(canTransition(moved, 'decompose').ok).toBe(false);
    const resumed = applyTransition(moved, {
      status: 'implement',
      now: '2026-09-07T02:00:00Z',
      note: 'Лимит повышен',
    }).task;
    expect(resumed.attempts).toEqual(task.attempts);
    expect(resumed.returnTo).toBe('audit');
    expect(resumed.links).toEqual(task.links);
    expect(tokenHoldProblem({ status: 'token-limit' })).toContain('Не сохранён');
  });
});

describe('бюджетный допуск', () => {
  it('использует только эффективный предел, различая исчерпание и неполный учёт', () => {
    expect(
      tokenAdmission(task, 'implement', config, { '0001-test': { session: 100 } }).reason,
    ).toBe('exhausted');
    expect(tokenAdmission(task, 'implement', config, { '0001-test': { session: 99 } }).reason).toBe(
      'unknown-usage',
    );
    expect(tokenAdmission(task, 'implement', config, {})).toBeNull();
    expect(
      tokenAdmission({ ...task, tokenHold: { limit: 999 } }, 'implement', config, {
        '0001-test': { session: 100 },
      }).limit,
    ).toBe(100);
    expect(
      tokenAdmission({ ...task, userTokenLimit: { error: 'Неверный лимит' } }, 'implement', config)
        .reason,
    ).toBe('invalid-limit');
    expect(
      tokenAdmission(
        task,
        'implement',
        { ...config, codexMaxTaskTokens: null },
        { '0001-test': { session: 100 } },
      ),
    ).toBeNull();
  });

  it('сохраняет исключения диагностики и провайдера Claude', () => {
    for (const stage of ['decompose', 'postmortem', 'cleanup'])
      expect(tokenAdmission(task, stage, config, { '0001-test': { session: 1000 } })).toBeNull();
    expect(
      tokenAdmission(
        task,
        'implement',
        { ...config, provider: 'claude' },
        { '0001-test': { session: 1000 } },
      ),
    ).toBeNull();
  });
});
