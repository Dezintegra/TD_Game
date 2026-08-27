import { describe, expect, it } from 'vitest';
import { summariseChecks } from './io.mjs';

/**
 * Проверки сведения состояния проверок CI к одному ответу.
 *
 * Проверяется именно эта часть переходника: всё остальное в нём — склейка
 * путей и запись файлов, где ошибаться негде, а вот «зелено ли» решает,
 * начнётся ли ревью и вольётся ли pull request.
 */

const check = (name, status, conclusion) => ({ name, status, conclusion });

const rollup = (...checks) => JSON.stringify({ statusCheckRollup: checks });

describe('состояние проверок', () => {
  it('все зелёные — успех', () => {
    const state = summariseChecks(
      rollup(check('типы', 'COMPLETED', 'SUCCESS'), check('сборка', 'COMPLETED', 'SUCCESS')),
    );
    expect(state).toEqual({ state: 'success' });
  });

  it('хоть одна не завершилась — ждём', () => {
    const state = summariseChecks(
      rollup(check('типы', 'COMPLETED', 'SUCCESS'), check('матчевые тесты', 'IN_PROGRESS', null)),
    );
    expect(state.state).toBe('pending');
    expect(state.why).toContain('матчевые тесты');
  });

  it('упавшая называется по имени', () => {
    const state = summariseChecks(
      rollup(
        check('типы', 'COMPLETED', 'SUCCESS'),
        check('сквозные проверки', 'COMPLETED', 'FAILURE'),
      ),
    );
    expect(state.state).toBe('failure');
    expect(state.failed).toBe('сквозные проверки');
  });

  it('отменённая считается неуспехом, а не успехом', () => {
    const state = summariseChecks(rollup(check('сборка', 'COMPLETED', 'CANCELLED')));
    expect(state.state).toBe('failure');
  });

  it('проверок ещё нет — ждём, а не радуемся', () => {
    // Пустой перечень легко принять за «всё зелено»: ошибка, из-за которой
    // ревью началось бы на непроверенном коде.
    expect(summariseChecks(rollup()).state).toBe('pending');
  });

  it('неразобравшийся ответ не выдаётся за успех', () => {
    expect(summariseChecks('не json').state).toBe('pending');
  });

  it('пустой ответ не выдаётся за успех', () => {
    expect(summariseChecks('').state).toBe('pending');
  });
});
