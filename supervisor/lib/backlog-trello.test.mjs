import { describe, expect, it } from 'vitest';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription } from './card.mjs';
import { checkCard } from './validate-card.mjs';
import { resolveConfig } from '../config/defaults.mjs';

/**
 * Проверки бэклога на доске.
 *
 * Сети нет: клиент подставной, снимок доски выдуман. Проверяется то же,
 * что и у файлового хранилища, плюс своё — переезд карточки в колонку
 * нового состояния и неприкосновенность человеческого текста в описании.
 */

const { config } = resolveConfig({ trello: { board: 'b' } });
const marker = config.trello.marker;

/** Подставной клиент Trello: помнит запросы, отвечает заданным. */
function fakeTrello(replies = {}) {
  const calls = [];
  const answer = (path) =>
    replies[path] ?? replies.default ?? { ok: true, data: path.endsWith('/actions') ? [] : {} };
  return {
    calls,
    get: (path, query) => (calls.push({ method: 'GET', path, query }), answer(path)),
    post: (path, body) => (calls.push({ method: 'POST', path, body }), answer(path)),
    put: (path, body) => (calls.push({ method: 'PUT', path, body }), answer(path)),
    delete: (path) => (calls.push({ method: 'DELETE', path }), answer(path)),
  };
}

/** Снимок доски: колонки и метки с именами из настройки. */
function snapshot(over = {}) {
  const lists = Object.entries(config.trello.lists).map(([state, name]) => ({
    id: `list-${state}`,
    name,
    closed: false,
  }));
  const labels = Object.entries(config.trello.labels).map(([key, label]) => ({
    id: `label-${key}`,
    name: label.name,
    color: label.color,
  }));
  return { lists, labels, cards: [], comments: [], ...over };
}

const meta = (over = {}) => ({
  id: '0031-proba',
  owner: null,
  returnTo: null,
  statusChangedAt: '2026-08-27T10:00:00.000Z',
  links: { change: null, pr: null, run: null, related: [] },
  attempts: { continuations: 0, cycleFailures: 0 },
  ...over,
});

const card = (over = {}) => ({
  id: 'card-1',
  name: '0031-proba · Проба пера',
  desc: joinDescription('Что нужно сделать.', meta(over.meta)),
  idList: 'list-new',
  idLabels: ['label-feature'],
  pos: 65536,
  closed: false,
  ...over,
});

const backlog = (over = {}, trello = fakeTrello(), machine = null) =>
  createTrelloBacklog({ trello, config, snapshot: snapshot(over), machine });

describe('публикация причины до закрытия', () => {
  const reason = 'Предмет снят: проверка уже исправлена. Проверено: PR 166 влит.';
  function world({ partFailure = 0, moveFailure = false, limit = 16384 } = {}) {
    const calls = [],
      actions = [];
    let list = 'list-cleanup',
      posts = 0,
      brokenPart = partFailure,
      brokenMove = moveFailure;
    const trello = {
      async get() {
        return { ok: true, data: [...actions].reverse() };
      },
      async post(path, body) {
        calls.push('comment');
        posts++;
        if (posts === brokenPart) return { ok: false, kind: 'offline', why: 'сеть' };
        actions.push({ id: `comment-${posts}`, data: { text: body.text } });
        return { ok: true, data: { id: `card-${posts}` } };
      },
      async put(path, body) {
        calls.push('move');
        if (brokenMove) return { ok: false, kind: 'offline', why: 'сеть' };
        list = body.idList;
        return { ok: true, data: {} };
      },
    };
    const store = createTrelloBacklog({
      trello,
      config: { ...config, trello: { ...config.trello, maxTextLength: limit } },
      snapshot: snapshot({ cards: [card({ idList: list })] }),
    });
    const task = { ...store.readTask('0031-proba'), status: 'closed', closureReason: reason };
    const entry = {
      from: 'cleanup',
      to: 'closed',
      closureReason: reason,
      what: 'Убрано: дерева нет.',
      source: 'supervisor',
    };
    return {
      store,
      task,
      entry,
      calls,
      actions,
      list: () => list,
      restore: () => {
        brokenPart = 0;
        brokenMove = false;
      },
    };
  }

  it('отказывает без причины до любых записей', async () => {
    const w = world();
    delete w.entry.closureReason;
    expect((await w.store.saveTask(w.task, w.entry)).ok).toBe(false);
    expect(w.calls).toEqual([]);
  });

  it.each([1, 2, 'move', null])(
    'итог completed доставляется до переноса при сбое %s',
    async (failure) => {
      const w = world({
        partFailure: typeof failure === 'number' ? failure : 0,
        moveFailure: failure === 'move',
        limit: 250,
      });
      w.task.status = 'completed';
      w.task.completionSummary =
        'Исправлен двойной расчёт. Единая формула проверена регрессионным тестом. '.repeat(12);
      w.entry.to = 'completed';
      delete w.entry.closureReason;
      const first = await w.store.saveTask(w.task, w.entry);
      expect(first.ok).toBe(failure === null);
      if (failure !== null) {
        expect(w.list()).toBe('list-cleanup');
        w.restore();
        expect((await w.store.saveTask(w.task, w.entry)).ok).toBe(true);
      }
      expect(w.list()).toBe('list-completed');
      expect(w.calls[0]).toBe('comment');
      expect(w.actions.map((a) => a.data.text).join('\n')).toContain('Итог задачи');
      expect(new Set(w.actions.map((a) => a.data.text)).size).toBe(w.actions.length);
    },
  );

  it('публикует причину до перемещения', async () => {
    const w = world();
    expect((await w.store.saveTask(w.task, w.entry)).ok).toBe(true);
    expect(w.calls).toEqual(['comment', 'move']);
    expect(w.actions[0].data.text).toContain('**Причина закрытия**');
    expect(w.actions[0].data.text).toContain(reason);
  });

  it.each([1, 2])(
    'отказ части %s сохраняет колонку, повтор дописывает только отсутствующие части',
    async (partFailure) => {
      const w = world({ partFailure, limit: 180 });
      w.entry.what = 'Детали уборки. '.repeat(50);
      expect((await w.store.saveTask(w.task, w.entry)).ok).toBe(false);
      expect(w.list()).toBe('list-cleanup');
      expect(w.calls).not.toContain('move');
      w.restore();
      expect((await w.store.saveTask(w.task, w.entry)).ok).toBe(true);
      expect(w.list()).toBe('list-closed');
      expect(new Set(w.actions.map((a) => a.data.text)).size).toBe(w.actions.length);
    },
  );

  it('отказ перемещения не дублирует комментарий при повторе', async () => {
    const w = world({ moveFailure: true });
    expect((await w.store.saveTask(w.task, w.entry)).ok).toBe(false);
    w.restore();
    expect((await w.store.saveTask(w.task, w.entry)).ok).toBe(true);
    expect(w.actions).toHaveLength(1);
    expect(w.calls).toEqual(['comment', 'move', 'move']);
  });

  it('ссылки строятся по ответу Trello на создание, включая новые карточки', async () => {
    const w = world();
    const created = { ...w.task, id: '0032-next', status: 'new' };
    await w.store.createTask(created);
    expect(w.store.taskLink(created.id)).toBe('[0032-next](https://trello.com/c/card-1)');
    expect(w.store.readTask(created.id).closureReason).toBe(reason);
    expect(w.store.allTaskIds()).toContain(created.id);
  });
});

describe('чтение задач', () => {
  it('лимит читается только из истории и не записывается отчётом в metadata', async () => {
    const trello = fakeTrello();
    const store = backlog(
      {
        cards: [card({ meta: { userTokenLimit: { value: 999 } } })],
        userTokenLimits: { 'card-1': { value: 35, actionId: 'human' } },
      },
      trello,
    );
    const task = store.readTask('0031-proba');
    expect(task.userTokenLimit.value).toBe(35);
    await store.saveTask({ ...task, userTokenLimit: { value: 999 } }, { from: 'new', to: 'new' });
    expect(trello.calls.find((x) => x.method === 'PUT').body.desc).not.toContain('userTokenLimit');
    expect(store.readTask('0031-proba').userTokenLimit.value).toBe(35);
    expect(
      backlog({ cards: [card({ meta: { userTokenLimit: { value: 999 } } })] }).readTask(
        '0031-proba',
      ).userTokenLimit,
    ).toBeUndefined();
  });
  it('сохраняет архивный результат и негодные совпадения идентификатора', () => {
    const store = backlog({
      cards: [
        card({ id: 'active', idList: 'list-closed', meta: { links: { pr: 168 } } }),
        card({ id: 'archived', closed: true, idList: 'list-closed', meta: { links: { pr: 168 } } }),
        card({ id: 'not-done', closed: true, idList: 'list-new' }),
        card({ id: 'bad-active', idLabels: [] }),
        card({ id: 'bad-archive', closed: true, idList: 'list-closed', idLabels: [] }),
        card({ id: 'broken', closed: true, desc: '<!-- pipeline {broken -->' }),
      ],
    });
    const records = store.dependencyRecords();
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({
      id: '0031-proba',
      status: 'closed',
      links: { pr: 168 },
      valid: true,
    });
    expect(records[1]).toMatchObject({ status: 'new', valid: true });
    expect(records.slice(2).every((item) => item.id === '0031-proba' && item.valid === false)).toBe(
      true,
    );
    expect(store.parsedCards()).toHaveLength(2);
  });

  it('карточка читается как задача', () => {
    const store = backlog({ cards: [card()] });
    expect(store.readTask('0031-proba')).toMatchObject({
      id: '0031-proba',
      type: 'feature',
      status: 'new',
      title: 'Проба пера',
    });
  });

  it('архивные карточки в работу не берутся', () => {
    const store = backlog({ cards: [card({ closed: true })] });
    expect(store.readTask('0031-proba')).toBeNull();
  });

  it('но их номера считаются занятыми: архив — это не удаление', () => {
    const store = backlog({ cards: [card({ closed: true })] });
    expect(store.allTaskIds()).toEqual(['0031-proba']);
  });
});

describe('сохранение задачи', () => {
  const task = (over = {}) => ({
    id: '0031-proba',
    type: 'feature',
    title: 'Проба пера',
    status: 'design',
    owner: 'станция-1',
    returnTo: null,
    statusChangedAt: '2026-08-27T11:00:00.000Z',
    links: { change: null, pr: null, run: null, related: [] },
    attempts: { continuations: 0, cycleFailures: 0 },
    ...over,
  });

  const entry = { at: '2026-08-27T11:00:00.000Z', from: 'new', to: 'design', what: 'Взята.' };

  it.each([
    ['feature', 'cleanup'],
    ['run', 'interpret'],
    ['note', 'triage'],
  ])('новая выполненная задача %s оказывается сверху одним запросом', async (type, from) => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card({ idList: `list-${from}` })] }, trello);
    const result = await store.saveTask(task({ type, status: 'completed' }), {
      ...entry,
      from,
      to: 'completed',
    });

    expect(result.ok).toBe(true);
    const puts = trello.calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({ idList: 'list-completed', pos: 'top' });
    expect(trello.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  });

  it.each(['completed', 'cleanup'])(
    'выполненная карточка сохраняет место при повторе с from=%s и blocking',
    async (from) => {
      const trello = fakeTrello();
      const store = backlog({ cards: [card({ idList: 'list-completed' })] }, trello);
      await store.saveTask(task({ status: 'completed', blocking: true }), {
        ...entry,
        from,
        to: 'completed',
      });
      expect(trello.calls.find((call) => call.method === 'PUT').body).not.toHaveProperty('pos');
    },
  );

  it('сбой комментария откладывает само завершение и позицию карточки', async () => {
    const order = ['old-card'];
    let failComment = true;
    const trello = {
      async get() {
        return { ok: true, data: [] };
      },
      async put(path, body) {
        const id = path.split('/')[1];
        if (body.pos === 'top') {
          const previous = order.indexOf(id);
          if (previous !== -1) order.splice(previous, 1);
          order.unshift(id);
        }
        return { ok: true, data: {} };
      },
      async post() {
        return failComment ? { ok: false, kind: 'offline' } : { ok: true, data: {} };
      },
    };
    const store = backlog(
      {
        cards: [
          card({ idList: 'list-cleanup' }),
          card({ id: 'card-2', idList: 'list-cleanup', meta: { id: '0032-next' } }),
        ],
      },
      trello,
    );
    const completedEntry = { ...entry, from: 'cleanup', to: 'completed' };
    const first = task({ status: 'completed' });
    expect((await store.saveTask(first, completedEntry)).ok).toBe(false);
    failComment = false;
    await store.saveTask(task({ id: '0032-next', status: 'completed' }), completedEntry);
    expect((await store.saveTask(first, completedEntry)).ok).toBe(true);
    expect(order).toEqual(['card-1', 'card-2', 'old-card']);
  });

  it('неудачное перемещение оставляет запрос верхней позиции для повтора', async () => {
    const replies = { 'cards/card-1': { ok: false, kind: 'offline' } };
    const trello = fakeTrello(replies);
    const store = backlog({ cards: [card({ idList: 'list-cleanup' })] }, trello);
    const completedEntry = { ...entry, from: 'cleanup', to: 'completed' };
    expect((await store.saveTask(task({ status: 'completed' }), completedEntry)).ok).toBe(false);
    replies['cards/card-1'] = { ok: true, data: {} };
    expect((await store.saveTask(task({ status: 'completed' }), completedEntry)).ok).toBe(true);
    expect(
      trello.calls.filter((call) => call.method === 'PUT').map((call) => call.body.pos),
    ).toEqual(['top', 'top']);
  });

  it.each([false, true])(
    'сохраняет правило позиции рабочей очереди при blocking=%s',
    async (blocking) => {
      const trello = fakeTrello();
      const store = backlog({ cards: [card()] }, trello);
      await store.saveTask(task({ blocking }), entry);
      expect(trello.calls.find((call) => call.method === 'PUT').body.pos).toBe(
        blocking ? 'top' : undefined,
      );
    },
  );

  it('переезд в колонку и правка отметок делаются одним запросом', async () => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card()] }, trello);
    await store.saveTask(task(), entry);

    const puts = trello.calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body.idList).toBe('list-design');
    expect(puts[0].body.desc).toContain('"owner":"станция-1"');
  });

  it('человеческий текст описания не переписывается', async () => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card()] }, trello);
    await store.saveTask(task(), entry);

    const put = trello.calls.find((call) => call.method === 'PUT');
    expect(put.body.desc.startsWith('Что нужно сделать.')).toBe(true);
  });

  it('служебный префикс в названии не растёт с каждым переходом', async () => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card()] }, trello);
    await store.saveTask(task(), entry);

    const put = trello.calls.find((call) => call.method === 'PUT');
    expect(put.body.name).toBe('0031-proba · Проба пера');
  });

  it('запись журнала уходит комментарием с пометкой конвейера', async () => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card()] }, trello);
    await store.saveTask(task(), entry);

    const posted = trello.calls.find((call) => call.path.includes('actions/comments'));
    expect(posted.body.text.startsWith(marker)).toBe(true);
    expect(posted.body.text).toContain('new → design');
    expect(posted.body.text).toContain('Взята.');
  });

  it('запись сессии помечается агентской, а распоряжение конвейера — своё', async () => {
    // Автор комментария у обоих один: запросы к Trello делает супервизор.
    // Различает их только тег, и без него доска читалась бы как один
    // сплошной голос.
    const trello = fakeTrello();
    const store = backlog({ cards: [card()] }, trello);

    await store.saveTask(task(), { ...entry, source: 'agent' });
    await store.saveTask(task(), entry);

    const [fromAgent, fromSupervisor] = trello.calls
      .filter((call) => call.path.includes('actions/comments'))
      .map((call) => call.body.text);
    expect(fromAgent.startsWith(`${marker} [agent] `)).toBe(true);
    expect(fromSupervisor.startsWith(`${marker} [supervisor] `)).toBe(true);
  });

  it('отсутствие колонки — беда, названная вслух, а не молчаливый успех', async () => {
    const board = snapshot({ cards: [card()] });
    board.lists = board.lists.filter((list) => list.name !== config.trello.lists.design);
    const store = createTrelloBacklog({ trello: fakeTrello(), config, snapshot: board });

    const result = await store.saveTask(task(), entry);
    expect(result.ok).toBe(false);
    expect(result.why).toContain('design');
  });

  it('обрыв связи назван обрывом: цикл его переживёт', async () => {
    const trello = fakeTrello({ default: { ok: false, kind: 'offline', why: 'ECONNRESET' } });
    const store = backlog({ cards: [card()] }, trello);

    const result = await store.saveTask(task(), entry);
    expect(result).toMatchObject({ ok: false, outcome: 'offline' });
  });
});

describe('заведение задачи', () => {
  const born = (over = {}) => ({
    id: '0032-new',
    type: 'run',
    title: 'Померить',
    description: 'Текст.',
    status: 'new',
    run: { kind: 'arena', params: {}, expectation: 'Доли побед остаются в вилке 45–55.' },
    links: { change: null, pr: null, run: null, related: [] },
    attempts: { continuations: 0, cycleFailures: 0 },
    ...over,
  });

  const posted = async (task) => {
    const trello = fakeTrello();
    await backlog({}, trello).createTask(task);
    return trello.calls.find((call) => call.path === 'cards').body;
  };

  it('карточка встаёт в конец очереди с меткой типа', async () => {
    const body = await posted(born());
    expect(body).toMatchObject({ idList: 'list-new', pos: 'bottom' });
    expect(body.name).toBe('0032-new · Померить');
  });

  it('блокирующая задача встаёт в начало очереди', async () => {
    // Причина мешает вести другие задачи, и всякая задача, взятая раньше
    // неё, упадёт на ней же. В конце очереди она ждала бы всю очередь:
    // 0080 так простояла восемь часов, и четыре взятые перед ней упали.
    const body = await posted(born({ type: 'feature', run: undefined, blocking: true }));
    expect(body).toMatchObject({ idList: 'list-new', pos: 'top' });
    expect(body.idLabels).toEqual(['label-feature']);
  });

  it('признак не пишется в служебный блок карточки', async () => {
    // После заведения истина о порядке — положение карточки; записанное
    // рядом «blocking» соврало бы после первого перетаскивания.
    const body = await posted(born({ type: 'feature', run: undefined, blocking: true }));
    expect(body.desc).not.toMatch(/blocking/);
  });

  it('прогон несёт и метку вида, и ожидаемый результат разделом описания', async () => {
    // Обе величины конвейер читает не из служебного блока: вид прогона —
    // из метки, ожидание — из раздела человеческого текста. Пока запись
    // о них не знала, всякая заявка на прогон рождала карточку, которую
    // тут же отвергала собственная проверка.
    const body = await posted(born());
    expect(body.idLabels).toEqual(['label-run', 'label-arena']);
    expect(body.desc).toContain('## Ожидаемый результат');
    expect(body.desc).toContain('в вилке 45–55');
  });

  it('заведённая карточка проходит собственную проверку', async () => {
    // Главный сторож этой пары: что записали, то и прочитали. Он ловит
    // расхождение чтения и записи в принципе, а не отдельные его случаи.
    const task = born();
    const body = await posted(task);

    const store = backlog({
      cards: [
        {
          id: 'card-new',
          name: body.name,
          desc: body.desc,
          idList: 'list-new',
          idLabels: body.idLabels,
          pos: 65536,
          closed: false,
        },
      ],
    });
    const [item] = store.parsedCards();

    expect(checkCard(item)).toEqual([]);
    expect(item.task.run).toMatchObject({ kind: 'arena', expectation: task.run.expectation });
  });

  it('доработка обходится меткой типа: вида прогона у неё нет', async () => {
    const body = await posted(born({ type: 'feature', run: undefined }));
    expect(body.idLabels).toEqual(['label-feature']);
    expect(body.desc).not.toContain('Ожидаемый результат');
  });
});

describe('карантин негодной карточки', () => {
  const problems = ['нет метки вида прогона — поставьте одну из: arena, perf, bench-tick'];

  const quarantine = async (over = {}, returnTo = 'new') => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card(over)] }, trello);
    const result = await store.quarantineCard('0031-proba', { problems, returnTo });
    return { trello, result };
  };

  it('карточка переезжает в «Ошибку» вместе с состоянием возврата', async () => {
    // Одним запросом, и это существенно: разъедься переезд и запись
    // возврата — карточка заперлась бы в ошибке навсегда.
    const { trello } = await quarantine();

    const puts = trello.calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].body.idList).toBe('list-failed');
    expect(puts[0].body.desc).toContain('"returnTo":"new"');
  });

  it('человеческий текст описания не переписывается', async () => {
    const { trello } = await quarantine();
    const put = trello.calls.find((call) => call.method === 'PUT');
    expect(put.body.desc.startsWith('Что нужно сделать.')).toBe(true);
  });

  it('вешается метка «не разобрано»', async () => {
    const { trello } = await quarantine();
    const labelled = trello.calls.find((call) => call.path.includes('idLabels'));
    expect(labelled.body.value).toBe('label-unparsed');
  });

  it('на уже помеченную карточку метка вторично не вешается', async () => {
    const { trello } = await quarantine({ idLabels: ['label-feature', 'label-unparsed'] });
    expect(trello.calls.some((call) => call.path.includes('idLabels'))).toBe(false);
  });

  it('претензии переносятся в комментарий дословно', async () => {
    // Они написаны для человека и уже содержат указание, что исправить.
    // Пересказ своими словами потерял бы именно эту часть.
    const { trello } = await quarantine({}, 'design');
    const posted = trello.calls.find((call) => call.path.includes('actions/comments'));

    expect(posted.body.text).toContain(problems[0]);
    // И куда возвращать — колонкой, а не служебным именем состояния.
    expect(posted.body.text).toContain('«Проработка»');
  });

  it('отсутствие колонки ошибки названо вслух', async () => {
    const board = snapshot({ cards: [card()] });
    board.lists = board.lists.filter((list) => list.name !== config.trello.lists.failed);
    const store = createTrelloBacklog({ trello: fakeTrello(), config, snapshot: board });

    const result = await store.quarantineCard('0031-proba', { problems, returnTo: 'new' });
    expect(result).toMatchObject({ ok: false, outcome: 'failed' });
  });

  it('обрыв связи назван обрывом', async () => {
    const trello = fakeTrello({ default: { ok: false, kind: 'offline', why: 'ECONNRESET' } });
    const store = backlog({ cards: [card()] }, trello);

    const result = await store.quarantineCard('0031-proba', { problems, returnTo: 'new' });
    expect(result).toMatchObject({ ok: false, outcome: 'offline' });
  });
});

describe('снятие метки с исправленной карточки', () => {
  it('метка снимается, а комментарии не трогаются', async () => {
    const trello = fakeTrello();
    const store = backlog(
      { cards: [card({ idLabels: ['label-feature', 'label-unparsed'] })] },
      trello,
    );

    await store.clearCard('0031-proba');

    const deleted = trello.calls.find((call) => call.method === 'DELETE');
    expect(deleted.path).toContain('idLabels/label-unparsed');
    expect(trello.calls.some((call) => call.path.includes('actions/comments'))).toBe(false);
  });

  it('непомеченную карточку не трогает вовсе', async () => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card()] }, trello);

    const result = await store.clearCard('0031-proba');
    expect(result.ok).toBe(true);
    expect(trello.calls).toEqual([]);
  });
});

describe('журнал', () => {
  it('склеивается из своих комментариев, чужие не подмешиваются', () => {
    const store = backlog({
      cards: [card()],
      comments: [
        { id: 'c1', cardId: 'card-1', date: '2026-08-27T10:01:00.000Z', text: `${marker} первая` },
        { id: 'c2', cardId: 'card-1', date: '2026-08-27T10:02:00.000Z', text: 'реплика человека' },
        { id: 'c3', cardId: 'card-1', date: '2026-08-27T10:03:00.000Z', text: `${marker} вторая` },
      ],
    });
    expect(store.readJournal('0031-proba')).toBe('первая\nвторая');
  });
});

describe('ответ владельца продукта', () => {
  it.each(['analyzing', 'waiting', 'verifying'])(
    'не теряет ответ после начала проверки вопроса: %s',
    (phase) => {
      const store = backlog({
        cards: [
          card({
            idList: 'list-postmortem',
            meta: {
              statusChangedAt: '2026-08-27T14:00:00.000Z',
              returnTo: 'implement',
              delayAnalysis: {
                originStatus: 'awaiting-po',
                originSince: '2026-08-27T12:00:00.000Z',
                phase,
              },
            },
          }),
        ],
        comments: [
          { id: 'c1', cardId: 'card-1', date: '2026-08-27T11:00:00.000Z', text: 'Старый ответ' },
          { id: 'c2', cardId: 'card-1', date: '2026-08-27T13:00:00.000Z', text: 'Новое решение' },
        ],
      });
      expect(store.readAnswer('0031-proba')).toBe('Новое решение');
    },
  );
  it('находится после перехода в ожидание', () => {
    const store = backlog({
      cards: [
        card({
          idList: 'list-awaiting-po',
          meta: { statusChangedAt: '2026-08-27T12:00:00.000Z', returnTo: 'design' },
        }),
      ],
      comments: [
        { id: 'c1', cardId: 'card-1', date: '2026-08-27T11:00:00.000Z', text: 'давнее замечание' },
        { id: 'c2', cardId: 'card-1', date: '2026-08-27T12:05:00.000Z', text: `${marker} вопрос` },
        { id: 'c3', cardId: 'card-1', date: '2026-08-27T13:00:00.000Z', text: 'Берите второй.' },
      ],
    });
    expect(store.readAnswer('0031-proba')).toBe('Берите второй.');
  });

  it('до вопроса ответа нет, сколько бы ни было разговоров', () => {
    const store = backlog({
      cards: [
        card({ idList: 'list-awaiting-po', meta: { statusChangedAt: '2026-08-27T12:00:00.000Z' } }),
      ],
      comments: [
        { id: 'c1', cardId: 'card-1', date: '2026-08-27T11:00:00.000Z', text: 'давнее замечание' },
      ],
    });
    expect(store.readAnswer('0031-proba')).toBeNull();
  });

  it('карта ответов собирается по всем ждущим карточкам разом', () => {
    const store = backlog({
      cards: [
        card({
          idList: 'list-awaiting-po',
          meta: { statusChangedAt: '2026-08-27T12:00:00.000Z', returnTo: 'design' },
        }),
        card({
          id: 'card-2',
          name: '0032-vtoraya · Вторая проба',
          desc: joinDescription(
            'Что нужно сделать.',
            meta({
              id: '0032-vtoraya',
              statusChangedAt: '2026-08-27T12:00:00.000Z',
              returnTo: 'implement',
            }),
          ),
          idList: 'list-awaiting-po',
        }),
      ],
      comments: [
        { id: 'c1', cardId: 'card-1', date: '2026-08-27T13:00:00.000Z', text: 'Берите второй.' },
        {
          id: 'c2',
          cardId: 'card-2',
          date: '2026-08-27T13:30:00.000Z',
          text: 'Оставить как есть.',
        },
      ],
    });
    expect(store.ownerAnswers()).toEqual({
      '0031-proba': 'Берите второй.',
      '0032-vtoraya': 'Оставить как есть.',
    });
  });

  it('карта не берёт комментарии под карточками, которые ответа не ждут', () => {
    const store = backlog({
      cards: [
        card({ idList: 'list-implement', meta: { statusChangedAt: '2026-08-27T12:00:00.000Z' } }),
      ],
      comments: [
        { id: 'c1', cardId: 'card-1', date: '2026-08-27T13:00:00.000Z', text: 'заметка на полях' },
      ],
    });
    expect(store.ownerAnswers()).toEqual({});
  });
});

describe('захват задачи назначением исполнителя', () => {
  const task = { id: '0031-proba', title: 'Проба пера' };

  /** Клиент, отвечающий на вопрос «кто я» и на назначение. */
  const withMe = (assign) =>
    fakeTrello({
      'members/me': { ok: true, data: { id: 'me-1' } },
      'cards/card-1/idMembers': assign,
    });

  it('назначает исполнителя карточке', async () => {
    const trello = withMe({ ok: true, data: [] });
    const store = backlog({ cards: [card()] }, trello);

    expect(await store.acquire(task)).toMatchObject({ ok: true, outcome: 'ours' });
    const posted = trello.calls.find((c) => c.path === 'cards/card-1/idMembers');
    expect(posted.method).toBe('POST');
    expect(posted.body.value).toBe('me-1');
  });

  it('повторное назначение — это «задачу заняли», а не поломка', async () => {
    // Ровно то свойство, ради которого захват и переехал на назначение:
    // Trello отвергает повторное назначение того же участника, и значит
    // операция годится как «сравни-и-запиши». Проверено на живой доске.
    const trello = withMe({
      ok: false,
      kind: 'refused',
      status: 400,
      why: 'member is already on the card',
    });
    const store = backlog({ cards: [card()] }, trello);

    expect(await store.acquire(task)).toMatchObject({ ok: false, outcome: 'taken' });
  });

  it('своё же назначение не мешает довести взятие до конца', async () => {
    // Участник доски один на все станции, поэтому «уже назначено» само
    // по себе не говорит, кто держит задачу. Говорит отметка владельца:
    // наше имя означает оборванный собственный захват. Пока разницы
    // не было, задача 0016 висела с 28.08.2026 неберущейся — и своим
    // состоянием занимала единственное место исполнителя, останавливая
    // весь бэклог.
    const trello = withMe({
      ok: false,
      kind: 'refused',
      status: 400,
      why: 'member is already on the card',
    });
    const store = backlog({ cards: [card({ meta: { owner: 'станция-1' } })] }, trello, 'станция-1');

    expect(await store.acquire(task)).toMatchObject({ ok: true, outcome: 'ours' });
  });

  it('чужой захват остаётся чужим, и хозяин называется', async () => {
    const trello = withMe({
      ok: false,
      kind: 'refused',
      status: 400,
      why: 'member is already on the card',
    });
    const store = backlog({ cards: [card({ meta: { owner: 'станция-2' } })] }, trello, 'станция-1');

    const result = await store.acquire(task);
    expect(result).toMatchObject({ ok: false, outcome: 'taken' });
    expect(result.why).toContain('станция-2');
  });

  it('без имени станции разбирать нечего: занято значит занято', async () => {
    // Читающий сценарий имени машины не передаёт, и молча считать чужой
    // захват своим ему нельзя.
    const trello = withMe({
      ok: false,
      kind: 'refused',
      status: 400,
      why: 'member is already on the card',
    });
    const store = backlog({ cards: [card({ meta: { owner: 'станция-1' } })] }, trello);

    expect(await store.acquire(task)).toMatchObject({ ok: false, outcome: 'taken' });
  });

  it('прочий отказ занятостью не выдаётся', async () => {
    const trello = withMe({ ok: false, kind: 'refused', status: 401, why: 'invalid token' });
    const store = backlog({ cards: [card()] }, trello);

    const result = await store.acquire(task);
    expect(result.outcome).toBe('refused');
  });

  it('обрыв связи остаётся обрывом: цикл его переживёт', async () => {
    const trello = withMe({ ok: false, kind: 'offline', why: 'ECONNRESET' });
    const store = backlog({ cards: [card()] }, trello);

    expect(await store.acquire(task)).toMatchObject({ ok: false, outcome: 'offline' });
  });

  it('участник спрашивается один раз на все захваты', async () => {
    const trello = withMe({ ok: true, data: [] });
    const store = backlog({ cards: [card()] }, trello);

    await store.acquire(task);
    await store.acquire(task);
    expect(trello.calls.filter((c) => c.path === 'members/me')).toHaveLength(1);
  });

  it('отпускание снимает назначение', async () => {
    const trello = withMe({ ok: true, data: [] });
    const store = backlog({ cards: [card()] }, trello);

    expect(await store.release(task)).toMatchObject({ ok: true });
    const dropped = trello.calls.find((c) => c.method === 'DELETE');
    expect(dropped.path).toBe('cards/card-1/idMembers/me-1');
  });

  it('отпускание несуществующей карточки бедой не считается', async () => {
    const store = backlog({}, withMe({ ok: true, data: [] }));
    expect(await store.release({ id: 'нет-такой' })).toMatchObject({ ok: true });
  });
});

describe('карточки, заведённые человеком', () => {
  /** Карточка без служебного блока: заголовок, метка — и всё. */
  const orphan = (over = {}) => ({
    id: 'card-new',
    name: 'Починить свист ядерного удара',
    desc: 'Свистит не вовремя.',
    idList: 'list-new',
    idLabels: ['label-feature'],
    pos: 100,
    closed: false,
    ...over,
  });

  it('получают номер и префикс в названии', async () => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card(), orphan()] }, trello);

    const { adopted } = await store.adoptOrphans();
    expect(adopted).toEqual(['0032-pochinit-svist-yadernogo-udara']);

    const put = trello.calls.find((call) => call.method === 'PUT');
    expect(put.body.name).toBe(
      '0032-pochinit-svist-yadernogo-udara · Починить свист ядерного удара',
    );
    expect(put.body.desc).toContain('"id":"0032-pochinit-svist-yadernogo-udara"');
  });

  it('заголовок остаётся человеческим текстом описания', async () => {
    const trello = fakeTrello();
    const store = backlog({ cards: [orphan()] }, trello);
    await store.adoptOrphans();

    const put = trello.calls.find((call) => call.method === 'PUT');
    expect(put.body.desc.startsWith('Свистит не вовремя.')).toBe(true);
  });

  it('становятся видны тем же циклом, не дожидаясь следующего чтения', async () => {
    const store = backlog({ cards: [orphan()] }, fakeTrello());
    const { adopted } = await store.adoptOrphans();
    expect(store.readTask(adopted[0])).toMatchObject({ type: 'feature', status: 'new' });
  });

  it('две карточки разом получают разные номера', async () => {
    const store = backlog(
      { cards: [orphan(), orphan({ id: 'card-two', name: 'Вторая задача' })] },
      fakeTrello(),
    );
    const { adopted } = await store.adoptOrphans();
    expect(adopted).toEqual(['0001-pochinit-svist-yadernogo-udara', '0002-vtoraya-zadacha']);
  });

  it('неудача с одной карточкой не отменяет остальных', async () => {
    const trello = fakeTrello({
      'cards/card-new': { ok: false, kind: 'refused', why: 'нет прав' },
    });
    const store = backlog(
      { cards: [orphan(), orphan({ id: 'card-two', name: 'Вторая задача' })] },
      trello,
    );

    const { adopted, problems } = await store.adoptOrphans();
    // Номер достаётся второй карточке, а не пропадает: неудавшаяся запись
    // ничего не заняла, и расходовать на неё номер незачем.
    expect(adopted).toEqual(['0001-vtoraya-zadacha']);
    expect(problems[0]).toContain('Починить свист');
  });

  it('номера архивных карточек считаются занятыми', async () => {
    const store = backlog({ cards: [card({ closed: true }), orphan()] }, fakeTrello());
    const { adopted } = await store.adoptOrphans();
    expect(adopted[0].startsWith('0032-')).toBe(true);
  });
});

describe('снятие захвата', () => {
  it('стирает владельца, не двигая карточку', async () => {
    const trello = fakeTrello();
    const store = backlog({ cards: [card({ meta: { owner: 'станция-1' } })] }, trello);
    await store.releaseTask({ ...meta(), owner: null, id: '0031-proba' });

    const put = trello.calls.find((call) => call.method === 'PUT');
    expect(put.body.desc).toContain('"owner":null');
    expect(put.body.idList).toBeUndefined();
  });
});

describe('архивные предшественники', () => {
  it('подтверждает только проверенные архивные карточки в closed', () => {
    const store = backlog({
      cards: [
        card({ closed: true, idList: 'list-completed' }),
        card({ id: 'card-2', closed: true, meta: { id: '0032-failed' }, idList: 'list-failed' }),
        card({
          id: 'card-3',
          closed: true,
          meta: { id: '0033-broken' },
          idList: 'list-closed',
          idLabels: [],
        }),
      ],
    });
    expect(store.closedDependencyIds()).toEqual(['0031-proba']);
    expect(store.parsedCards()).toEqual([]);
  });
});
