import { describe, expect, it } from 'vitest';
import { DEFAULTS, missingForStage, resolveConfig } from './defaults.mjs';
import { NEEDS_SESSION, STATES } from './transitions.mjs';

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

describe('сроки этапов', () => {
  it('назван у каждого этапа с сессией', () => {
    // Общий срок есть, и без него этап не повис бы. Но сорок пять минут
    // по умолчанию — это грубая мерка: короткому этапу она разрешает висеть
    // втрое дольше нужного, а длинный обрывает на середине.
    const unnamed = NEEDS_SESSION.filter((stage) => !DEFAULTS.stageTimeoutMinutes[stage]);
    expect(unnamed).toEqual([]);
  });
});

describe('чего требует этап', () => {
  it('разбору ошибки не требуется ничего', () => {
    // Требуй он настройку — и разбор оказался бы невозможен ровно там, где
    // нужен больше всего: при падении из-за нехватки этой самой настройки.
    const { config } = resolveConfig({});
    expect(missingForStage(config, 'postmortem', { status: 'postmortem' })).toEqual([]);
  });
});

describe('доска в умолчаниях', () => {
  it('не названа: угаданная доска молча наполнится чужая', () => {
    expect(DEFAULTS.trello.board).toBeUndefined();
  });
});
