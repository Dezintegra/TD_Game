import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ROUTING_CONTRACT } from './routing-contract.mjs';
import { planAmendments } from './requests.mjs';
describe('единые правила самостоятельной сверки', () => {
  it('убирает конфликтующие указания failed/premature и размножения кандидатов', () => {
    const implement = readFileSync(new URL('../skills/implement.md', import.meta.url), 'utf8');
    const postmortem = readFileSync(new URL('../skills/postmortem.md', import.meta.url), 'utf8');
    expect(implement).not.toContain(
      'До введения поддержки `premature` сохраняй действующий `failed`',
    );
    expect(postmortem).not.toContain('Лишний кандидат стоит одного взгляда');
    expect(ROUTING_CONTRACT).toContain('consolidations');
    expect(ROUTING_CONTRACT).toContain('Медиана парных разностей не равна');
    expect(ROUTING_CONTRACT).toContain('area: pipeline: она идёт');
  });
  it('принимает фактуру к остановленной задаче без создания дубля', () => {
    const stopped = { id: '0001-stopped', status: 'failed' };
    const p = planAmendments(
      [{ taskId: stopped.id, facts: 'Та же причина подтверждена вторым логом' }],
      { known: new Map([[stopped.id, stopped]]), sourceId: '0002-source' },
    );
    expect(p.rejected).toEqual([]);
    expect(p.planned).toHaveLength(1);
    expect(stopped.status).toBe('failed');
  });
});
