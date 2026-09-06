import { describe, expect, it } from 'vitest';
import { pendingDependencies, pendingCompletion } from './dependencies.mjs';
import { scan } from './scan.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { metaOf, parseCard, joinDescription } from './card.mjs';
import { createTrelloBacklog } from './backlog-trello.mjs';

const { config } = resolveConfig({ commands: { verify: 'x', deploy: 'x', perf: 'x' } });
const parent = { id: '0127-parent', status: 'closed', splitInto: ['0243-launch', '0244-tools'] };
const launch = { id: '0243-launch', status: 'closed' };
const tools = { id: '0244-tools', status: 'closed' };
const consumer = { id: '0041-field', type: 'feature', status: 'new', dependsOn: [parent.id] };
const fallen = {
  id: consumer.id,
  type: 'feature',
  status: 'failed',
  returnTo: 'revise',
  recovery: { causedBy: 'pipeline', fixedBy: [parent.id], returns: 0 },
};
const decision = (task, predecessors, extra = {}) =>
  scan({ config, tasks: [task, ...predecessors], ...extra });
const released = (result) =>
  result.actions.some(
    (item) =>
      item.taskId === consumer.id &&
      ['start-stage', 'continue-stage', 'return-task'].includes(item.kind),
  );

describe('ожидание частей закрытого предшественника', () => {
  it('поддерживает существующие полные ID с обрезанным конечным дефисом', () => {
    const oldParent = { ...parent, id: '0127-parent-', splitInto: ['0244-tools-'] };
    const oldChild = { ...tools, id: '0244-tools-' };
    expect(
      pendingDependencies({ ...consumer, dependsOn: [oldParent.id] }, [oldParent, oldChild]),
    ).toEqual([]);
    const recovery = { ...fallen, recovery: { ...fallen.recovery, fixedBy: [oldParent.id] } };
    expect(released(decision(recovery, [oldParent, oldChild]))).toBe(true);
  });

  it.each([consumer, fallen])('пересчитывает ожидание на каждом снимке для $status', (task) => {
    const original = JSON.parse(JSON.stringify(task));
    expect(released(decision(task, [{ ...parent, status: 'decompose' }]))).toBe(false);
    const waiting = decision(task, [parent, launch, { ...tools, status: 'design' }]);
    expect(released(waiting)).toBe(false);
    expect(waiting.notes.join()).toContain('0127-parent → 0244-tools (design)');
    expect(released(decision(task, [parent, launch, tools]))).toBe(true);
    expect(released(decision(task, [parent, launch, { ...tools, status: 'new' }]))).toBe(false);
    expect(task).toEqual(original);
  });

  it('подхватывает повторное разделение, не считая related зависимостью', () => {
    const nested = { ...tools, splitInto: ['0250-leaf'] };
    const graph = [{ ...parent, links: { related: ['0099-note'] } }, launch, nested];
    expect(pendingDependencies(consumer, graph)).toEqual([
      '0127-parent → 0244-tools → 0250-leaf (нет подтверждения закрытия)',
    ]);
    graph.push({ id: '0250-leaf', status: 'closed' }, { id: '0099-note', status: 'new' });
    expect(pendingDependencies(consumer, graph)).toEqual([]);
  });

  it.each([
    [[], 'нет подтверждения закрытия'],
    [[tools, tools], 'неоднозначный идентификатор'],
    [[{ ...tools, valid: false }], 'не разобрана'],
  ])('недоказанная часть не снимает ожидание: %j', (parts, why) => {
    const result = pendingCompletion(parent.id, [parent, launch, ...parts]);
    expect(result.join()).toContain(`0127-parent → 0244-tools (${why})`);
  });

  it.each([null, [], {}, '0244-tools', [tools.id, tools.id], ['bad'], [parent.id]])(
    'не превращает неверные части %j в успех',
    (splitInto) => {
      const record = { ...parent, splitInto };
      expect(pendingDependencies(consumer, [record, launch, tools])).not.toEqual([]);
      expect(released(decision(fallen, [record, launch, tools]))).toBe(false);
    },
  );

  it('различает цикл и общего потомка двух частей', () => {
    const shared = { id: '0250-shared', status: 'closed' };
    const graph = [
      parent,
      { ...launch, splitInto: [shared.id] },
      { ...tools, splitInto: [shared.id] },
      shared,
    ];
    expect(pendingDependencies(consumer, graph)).toEqual([]);
    shared.splitInto = [parent.id];
    expect(pendingDependencies(consumer, graph).join()).toContain('цикл');
    expect(pendingCompletion(parent.id, graph).join()).toContain('цикл');
  });

  it('удерживает цикл между ожиданием и декомпозицией', () => {
    expect(
      pendingDependencies(consumer, [
        parent,
        launch,
        { ...tools, dependsOn: [consumer.id] },
      ]).join(),
    ).toContain('цикл');
  });

  it('не переполняет стек на глубокой цепочке частей', () => {
    const graph = Array.from({ length: 1500 }, (_, i) => ({
      id: `${String(i).padStart(4, '0')}-part`,
      status: 'closed',
      ...(i < 1499 ? { splitInto: [`${String(i + 1).padStart(4, '0')}-part`] } : {}),
    }));
    expect(pendingCompletion(graph[0].id, graph)).toEqual([]);
  });

  it('закрытый архивный родитель не скрывает незавершённого потомка', () => {
    const extra = { records: [{ ...parent, valid: true }] };
    expect(pendingDependencies(consumer, [launch], [parent.id], extra).join()).toContain(tools.id);
    expect(pendingDependencies(consumer, [launch, tools], [parent.id], extra)).toEqual([]);
    expect(
      released(
        decision(fallen, [launch], {
          dependencyRecords: extra.records,
          closedDependencyIds: [parent.id],
        }),
      ),
    ).toBe(false);
    expect(
      released(
        decision(fallen, [launch, tools], {
          dependencyRecords: extra.records,
          closedDependencyIds: [parent.id],
        }),
      ),
    ).toBe(true);
  });

  it('архивный ID не перекрывает негодную или неоднозначную запись', () => {
    expect(
      pendingDependencies(consumer, [], [parent.id], { invalid: [{ id: parent.id }] }),
    ).not.toEqual([]);
    expect(
      pendingDependencies(consumer, [parent, launch, tools], [parent.id], {
        records: [parent],
      }).join(),
    ).toContain('неоднозначный');
  });

  it('сохраняет требование вливания PR вместе с завершением частей', () => {
    const task = {
      ...consumer,
      dependencyResults: [{ taskId: parent.id, kind: 'merged-pr', pr: 110 }],
    };
    const graph = [{ ...parent, links: { pr: 110 } }, launch, tools];
    const extra = {
      mainBranch: 'main',
      evidence: {
        110: {
          number: 110,
          state: 'MERGED',
          mergedAt: '2026-09-06T00:00:00Z',
          baseRefName: 'main',
        },
      },
    };
    expect(pendingDependencies(task, graph).join()).toContain('PR #110');
    expect(pendingDependencies(task, graph, [], extra)).toEqual([]);
    graph[2] = { ...tools, status: 'design' };
    expect(pendingDependencies(task, graph, [], extra).join()).toContain(tools.id);
  });

  it('ожидание частей не расходует попытки и не блокирует готовую задачу прогоном', () => {
    const waiting = { ...consumer, type: 'run', attempts: { continuations: 100 } };
    const ready = { id: '0009-ready', type: 'feature', status: 'new' };
    const result = decision(waiting, [parent, launch, ready]);
    expect(result.actions.filter((item) => item.taskId === consumer.id)).toEqual([]);
    expect(result.actions).toContainEqual({
      kind: 'start-stage',
      taskId: ready.id,
      stage: 'decompose',
    });
  });

  it('не прерывает живой этап после изменения зависимостей', () => {
    const running = { ...consumer, status: 'revise' };
    const result = decision(running, [parent, launch], {
      running: [{ taskId: running.id, stage: 'revise' }],
    });
    expect(result.actions.filter((item) => item.taskId === consumer.id)).toEqual([]);
  });
});

describe('части в метаданных Trello', () => {
  const lists = Object.entries(config.trello.lists).map(([state, name]) => ({
    id: state,
    name,
    closed: false,
  }));
  const ctx = {
    stateByList: new Map([['closed', 'closed']]),
    labelKeyById: new Map([['feature', 'feature']]),
  };
  const card = (task) => ({
    id: '65000000abcdef',
    name: 'Родитель',
    idList: 'closed',
    idLabels: ['feature'],
    pos: 1,
    desc: joinDescription('Описание', metaOf(task)),
  });
  it.each([parent.splitInto, null, [], ['bad']])(
    'сохраняет в том числе неверные части %j, чтобы не скрыть ошибку',
    (splitInto) => {
      const first = parseCard(card({ ...parent, splitInto }), ctx).task;
      const second = parseCard(card(first), ctx).task;
      expect(second.splitInto).toEqual(splitInto);
      const plain = { ...parent };
      delete plain.splitInto;
      expect(parseCard(card(plain), ctx).task).not.toHaveProperty('splitInto');
    },
  );

  it('проводит архивную карточку со списком частей до проверки ожидания', () => {
    const store = createTrelloBacklog({
      trello: {},
      config,
      snapshot: {
        lists,
        labels: [{ id: 'feature', name: config.trello.labels.feature.name }],
        comments: [],
        cards: [{ ...card(parent), closed: true }],
      },
    });
    const records = store.dependencyRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      splitInto: parent.splitInto,
      status: 'closed',
      valid: true,
    });
    expect(
      pendingDependencies(consumer, [launch], store.closedDependencyIds(), { records }).join(),
    ).toContain(tools.id);
  });
});
