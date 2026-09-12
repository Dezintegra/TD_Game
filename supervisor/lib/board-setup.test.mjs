import { describe, expect, it } from 'vitest';
import { planBoard } from './board-setup.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { STATES } from '../config/transitions.mjs';

/**
 * Проверки настройки доски.
 *
 * Главное здесь — второй прогон. Скрипт настройки зовут в том числе
 * с испугу, «а всё ли на месте», и такой зов не должен заводить вторую
 * колонку «Проработка» рядом с первой: две одноимённые колонки для
 * человека неразличимы, а конвейер начнёт складывать задачи в ту, что
 * попалась первой.
 */

const { config } = resolveConfig({ trello: { board: 'b' } });

/** Доска, настроенная полностью: все колонки и все метки на месте. */
const settled = () => ({
  lists: STATES.map((state, index) => ({
    id: `list-${index}`,
    name: config.trello.lists[state],
    closed: false,
  })),
  labels: Object.entries(config.trello.labels).map(([key, label]) => ({
    id: `label-${key}`,
    name: label.name,
    color: label.color,
  })),
});

/** Доска сразу после создания: колонок нет, шесть безымянных цветных меток. */
const fresh = () => ({
  lists: [],
  labels: ['blue', 'green', 'orange', 'purple', 'red', 'yellow'].map((color) => ({
    id: `stock-${color}`,
    name: '',
    color,
  })),
});

describe('пустая доска', () => {
  it('получает колонку на каждое состояние', () => {
    const { actions } = planBoard({ config, ...fresh() });
    const created = actions.filter((a) => a.kind === 'create-list');
    expect(created).toHaveLength(STATES.length);
    expect(created.map((a) => a.state)).toEqual(STATES);
  });

  it('раскладывает колонки по порядку маршрута, а не как придётся', () => {
    const { actions } = planBoard({ config, ...fresh() });
    const positions = actions.filter((a) => a.kind === 'create-list').map((a) => a.pos);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('переиспользует безымянные метки, а не плодит рядом свои', () => {
    const { actions } = planBoard({ config, ...fresh() });
    const named = actions.filter((a) => a.kind === 'name-label');
    // Шесть готовых цветов Trello совпадают с шестью нашими метками.
    expect(named).toHaveLength(6);
    expect(actions.filter((a) => a.kind === 'create-label')).toHaveLength(
      Object.keys(config.trello.labels).length - 6,
    );
  });
});

describe('настроенная доска', () => {
  it('второй прогон не делает ничего', () => {
    const { actions } = planBoard({ config, ...settled() });
    expect(actions).toEqual([]);
  });

  it('недостающую колонку заводит, а остальные не трогает', () => {
    const board = settled();
    board.lists = board.lists.filter((list) => list.name !== config.trello.lists.audit);

    const { actions } = planBoard({ config, ...board });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'create-list', state: 'audit' });
  });

  it('положение колонок, переставленных человеком, не выравнивает', () => {
    const board = settled();
    board.lists.reverse();
    expect(planBoard({ config, ...board }).actions).toEqual([]);
  });
});

describe('доска с архивом', () => {
  it('колонку из архива возвращает, а не заводит вторую с тем же именем', () => {
    const board = settled();
    board.lists.find((list) => list.name === config.trello.lists.deploy).closed = true;

    const { actions } = planBoard({ config, ...board });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'reopen-list', state: 'deploy' });
  });
});

describe('метки', () => {
  it('перекрашивает метку, у которой имя верное, а цвет чужой', () => {
    const board = settled();
    board.labels.find((label) => label.name === 'run').color = 'pink';

    const { actions } = planBoard({ config, ...board });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'recolor-label', name: 'run', color: 'blue' }),
    ]);
  });

  it('чужие безымянные метки не трогает, но называет их вслух', () => {
    const board = settled();
    board.labels.push({ id: 'foreign', name: '', color: 'black' });

    const { actions, notes } = planBoard({ config, ...board });
    expect(actions).toEqual([]);
    expect(notes.join(' ')).toContain('безымянных меток: 1');
  });
});
