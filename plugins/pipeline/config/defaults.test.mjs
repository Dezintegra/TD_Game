import { describe, expect, it } from 'vitest';
import { DEFAULTS, resolveConfig } from './defaults.mjs';
import { STATES } from './transitions.mjs';

/**
 * Проверки слияния настройки.
 *
 * Ловится здесь ровно одна беда, но дорогая: проект называет в своей
 * настройке один лишь идентификатор доски, а слияние верхним уровнем
 * стирает ему все четырнадцать колонок разом. Обнаружилось бы это отказом
 * посреди работы — «нет колонки для состояния design», — и разбирать
 * пришлось бы в живом конвейере.
 */

describe('колонки доски', () => {
  it('объявлены для каждого состояния', () => {
    for (const state of STATES) {
      expect(DEFAULTS.trello.lists[state], `нет колонки для «${state}»`).toBeTruthy();
    }
  });

  it('не повторяются: две колонки с одним именем неразличимы', () => {
    const names = Object.values(DEFAULTS.trello.lists);
    expect(new Set(names).size).toBe(names.length);
  });

  it('переживают настройку проекта, назвавшую одну лишь доску', () => {
    const { config } = resolveConfig({ trello: { board: 'abc123' } });
    expect(config.trello.board).toBe('abc123');
    expect(Object.keys(config.trello.lists)).toHaveLength(STATES.length);
    expect(config.trello.lists.design).toBe('Проработка');
  });

  it('переименовываются по одной, не теряя остальных', () => {
    const { config } = resolveConfig({ trello: { lists: { new: 'Входящие' } } });
    expect(config.trello.lists.new).toBe('Входящие');
    expect(config.trello.lists.closed).toBe('Закрыто');
  });
});

describe('метки доски', () => {
  it('покрывают все три типа задач и все три вида прогона', () => {
    for (const label of ['feature', 'run', 'note', 'arena', 'perf', 'bench-tick']) {
      expect(DEFAULTS.trello.labels[label], `нет метки «${label}»`).toBeTruthy();
    }
  });

  it('различаются цветом: две одноцветные метки на карточке неразличимы взглядом', () => {
    const colors = Object.values(DEFAULTS.trello.labels).map((label) => label.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe('доска в умолчаниях', () => {
  it('не названа: угаданная доска молча наполнится чужая', () => {
    expect(DEFAULTS.trello.board).toBeUndefined();
  });
});
