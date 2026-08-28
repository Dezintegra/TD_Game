import { describe, expect, it } from 'vitest';
import {
  NEEDS_WORKTREE,
  ROUTES,
  STATES,
  canTransition,
  isExclusive,
  isResource,
  isWaiting,
  stateClass,
} from './transitions.mjs';

/**
 * Проверки автомата состояний.
 *
 * Здесь ловится ровно то, что дороже всего заметить в живом конвейере:
 * переход, которого не должно быть, и цена состояния, посчитанная неверно.
 * Первое пустило бы задачу мимо проверки, второе заняло бы машину замером
 * посреди чужой работы.
 */

const task = (over = {}) => ({
  id: '0001-example',
  type: 'feature',
  status: 'new',
  returnTo: null,
  ...over,
});

describe('маршруты', () => {
  it('доработка идёт полным путём', () => {
    const path = [
      ['new', 'design'],
      ['design', 'audit'],
      ['audit', 'implement'],
      ['implement', 'pr'],
      ['pr', 'review'],
      ['review', 'deploy'],
      ['deploy', 'cleanup'],
      ['cleanup', 'closed'],
    ];
    for (const [from, to] of path) {
      expect(canTransition(task({ status: from }), to).ok, `${from} → ${to}`).toBe(true);
    }
  });

  it('кандидат одобряется переходом в очередь', () => {
    // Переход объявлен, хотя выполняет его человек мышью. Не объяви его —
    // карточка, перетащенная в «Заведено», вернулась бы обратно: конвейер
    // возвращает всё, чего нет в таблице. Шлюз не просто не работал бы,
    // а отменял бы одобрение.
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'new').ok).toBe(true);
    expect(canTransition(task({ type: 'note', status: 'candidate' }), 'new').ok).toBe(true);
  });

  it('кандидата нельзя протащить мимо очереди', () => {
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'design').ok).toBe(false);
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'implement').ok).toBe(
      false,
    );
  });

  it('прогон кандидатом не бывает', () => {
    expect(canTransition(task({ type: 'run', status: 'candidate' }), 'new').ok).toBe(false);
  });

  it('прогон не заходит в проработку', () => {
    expect(canTransition(task({ type: 'run', status: 'new' }), 'design').ok).toBe(false);
    expect(canTransition(task({ type: 'run', status: 'new' }), 'benchmark').ok).toBe(true);
  });

  it('замер отдаёт прогон толкованию, а закрыть его сам не вправе', () => {
    const measured = task({ type: 'run', status: 'benchmark' });
    expect(canTransition(measured, 'interpret').ok).toBe(true);
    expect(canTransition(measured, 'closed').ok).toBe(false);
  });

  it('толкование закрывает прогон', () => {
    expect(canTransition(task({ type: 'run', status: 'interpret' }), 'closed').ok).toBe(true);
  });

  it('доработка толкования не знает: её замер ведёт к проверкам', () => {
    // Толкование объявлено только на маршруте прогона. У доработки замер —
    // одна из проверок перед ревью, и читает её ревьюер.
    const measured = task({ type: 'feature', status: 'benchmark' });
    expect(canTransition(measured, 'interpret').ok).toBe(false);
    expect(canTransition(measured, 'pr').ok).toBe(true);
  });

  it('замечание разбирается и закрывается', () => {
    expect(canTransition(task({ type: 'note', status: 'new' }), 'triage').ok).toBe(true);
    expect(canTransition(task({ type: 'note', status: 'triage' }), 'closed').ok).toBe(true);
  });

  it('через ступень перепрыгнуть нельзя', () => {
    const verdict = canTransition(task({ status: 'design' }), 'pr');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('«audit»');
  });

  it('аудит с замечаниями возвращает в проработку', () => {
    expect(canTransition(task({ status: 'audit' }), 'design').ok).toBe(true);
  });

  it('доработка ведёт в ожидание проверок, а не сразу в ревью', () => {
    expect(canTransition(task({ status: 'revise' }), 'pr').ok).toBe(true);
    expect(canTransition(task({ status: 'revise' }), 'review').ok).toBe(false);
  });

  it('несуществующее состояние отвергается', () => {
    expect(canTransition(task(), 'почти-готово').ok).toBe(false);
  });
});

describe('сквозные состояния', () => {
  it('ошибка достижима из любого рабочего состояния', () => {
    for (const status of ['design', 'implement', 'benchmark', 'review', 'deploy']) {
      expect(canTransition(task({ status }), 'failed').ok, status).toBe(true);
    }
  });

  it('ожидание ответа достижимо из любого рабочего состояния', () => {
    for (const status of ['triage', 'design', 'implement']) {
      expect(canTransition(task({ status }), 'awaiting-po').ok, status).toBe(true);
    }
  });

  it('возврат из ожидания ведёт в сохранённое состояние', () => {
    const waiting = task({ status: 'awaiting-po', returnTo: 'design' });
    expect(canTransition(waiting, 'design').ok).toBe(true);
    expect(canTransition(waiting, 'implement').ok).toBe(false);
  });

  it('из ошибки конвейер сам не поднимает, кроме сохранённого состояния', () => {
    const failed = task({ status: 'failed', returnTo: 'implement' });
    expect(canTransition(failed, 'implement').ok).toBe(true);
    expect(canTransition(failed, 'review').ok).toBe(false);
  });

  it('закрытая задача не оживает', () => {
    expect(canTransition(task({ status: 'closed' }), 'design').ok).toBe(false);
  });
});

describe('цена состояния', () => {
  it('проработка и имплементация занимают квоту', () => {
    expect(isResource(task({ status: 'design' }))).toBe(true);
    expect(isResource(task({ status: 'implement' }))).toBe(true);
  });

  it('ожидание проверок квоту не занимает', () => {
    expect(isWaiting(task({ status: 'pr' }))).toBe(true);
    expect(isResource(task({ status: 'pr' }))).toBe(false);
  });

  it('ревью считается отдельной квотой', () => {
    expect(stateClass(task({ status: 'review' }))).toBe('review');
    expect(isResource(task({ status: 'review' }))).toBe(false);
  });

  it('арена считается на чужом железе и машину не занимает', () => {
    const arena = task({ type: 'run', status: 'benchmark', run: { kind: 'arena' } });
    expect(isWaiting(arena)).toBe(true);
    expect(isExclusive(arena)).toBe(false);
  });

  it('замер кадров требует тишины на машине', () => {
    const perf = task({ type: 'run', status: 'benchmark', run: { kind: 'perf' } });
    expect(isExclusive(perf)).toBe(true);
  });

  it('выкладка требует тишины на машине', () => {
    expect(isExclusive(task({ status: 'deploy' }))).toBe(true);
  });
});

describe('связность таблицы', () => {
  it('у каждого состояния объявлена цена', () => {
    const priced = STATES.filter((status) => stateClass({ status, run: { kind: 'arena' } }));
    expect(priced).toHaveLength(STATES.length);
  });

  it('все состояния маршрутов существуют', () => {
    for (const [type, route] of Object.entries(ROUTES)) {
      for (const [from, targets] of Object.entries(route)) {
        expect(STATES, `${type}: ${from}`).toContain(from);
        for (const to of targets) expect(STATES, `${type}: ${from} → ${to}`).toContain(to);
      }
    }
  });

  it('дерево нужно только тем состояниям, что правят код', () => {
    expect(NEEDS_WORKTREE).not.toContain('benchmark');
    expect(NEEDS_WORKTREE).not.toContain('triage');
    expect(NEEDS_WORKTREE).toContain('implement');
  });
});
