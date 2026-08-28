import { describe, expect, it } from 'vitest';
import { checkCard, unparsedLabelChange } from './validate-card.mjs';

/**
 * Проверки карточки.
 *
 * Тут проверяется не столько строгость, сколько мягкость: карточку заводит
 * человек с телефона, и требовать от него больше необходимого нельзя.
 * Всё, что конвейер может проставить сам, он проставляет сам — и тесты
 * следят, чтобы этого не забыли.
 */

const parsed = (over = {}) => ({
  task: {
    title: 'Проба пера',
    status: 'new',
    type: 'feature',
    ...(over.task ?? {}),
  },
  card: {
    metaBroken: false,
    types: ['feature'],
    runKinds: [],
    flags: [],
    ...(over.card ?? {}),
  },
});

describe('годная карточка', () => {
  it('претензий не вызывает', () => {
    expect(checkCard(parsed())).toEqual([]);
  });

  it('не требует идентификатора: его назначит конвейер', () => {
    expect(checkCard(parsed({ task: { id: null } }))).toEqual([]);
  });

  it('прогон с видом и ожиданием тоже годен', () => {
    const ok = parsed({
      task: { type: 'run', run: { kind: 'arena', expectation: 'Станет ровнее.' } },
      card: { types: ['run'], runKinds: ['arena'] },
    });
    expect(checkCard(ok)).toEqual([]);
  });
});

describe('тип задачи', () => {
  it('без метки типа карточка не берётся', () => {
    const problems = checkCard(parsed({ task: { type: null }, card: { types: [] } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('feature, run, note');
  });

  it('две метки типа — тоже беда: маршрут от типа зависит однозначно', () => {
    const problems = checkCard(parsed({ card: { types: ['feature', 'note'] } }));
    expect(problems[0]).toContain('feature, note');
    expect(problems[0]).toContain('оставьте одну');
  });
});

describe('прогон', () => {
  const run = (over = {}) =>
    parsed({
      task: { type: 'run', run: { kind: 'arena', expectation: 'Станет ровнее.' }, ...over.task },
      card: { types: ['run'], runKinds: ['arena'], ...over.card },
    });

  it('без ожидаемого результата не берётся', () => {
    const problems = checkCard(run({ task: { run: { kind: 'arena', expectation: null } } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Ожидаемый результат');
  });

  it('без вида прогона не берётся', () => {
    const problems = checkCard(run({ card: { runKinds: [] } }));
    expect(problems[0]).toContain('arena, perf, bench-tick');
  });

  it('называет обе беды разом, а не по одной за цикл', () => {
    const problems = checkCard(
      run({ card: { runKinds: [] }, task: { run: { kind: null, expectation: null } } }),
    );
    expect(problems).toHaveLength(2);
  });

  it('к доработке требований прогона не предъявляет', () => {
    expect(checkCard(parsed({ task: { type: 'feature' } }))).toEqual([]);
  });
});

describe('порча служебного блока', () => {
  it('называется и объясняется, как чинить', () => {
    const problems = checkCard(parsed({ card: { metaBroken: true } }));
    expect(problems[0]).toContain('удалить блок целиком');
  });
});

describe('чужая колонка', () => {
  it('карточка вне известных колонок не берётся', () => {
    const problems = checkCard(parsed({ task: { status: null } }));
    expect(problems[0]).toContain('не отвечает ни одному состоянию');
  });
});

describe('метка «не разобрано»', () => {
  it('вешается на карточку с претензиями', () => {
    expect(unparsedLabelChange(['беда'], [])).toBe('add');
  });

  it('на уже помеченной остаётся, а не вешается вторично', () => {
    expect(unparsedLabelChange(['беда'], ['unparsed'])).toBe('keep');
  });

  it('снимается сама, как только карточку исправили', () => {
    expect(unparsedLabelChange([], ['unparsed'])).toBe('remove');
  });

  it('на годной непомеченной карточке не появляется', () => {
    expect(unparsedLabelChange([], [])).toBe('keep');
  });
});
