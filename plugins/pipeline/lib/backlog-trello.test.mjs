import { describe, expect, it } from 'vitest';
import { createTrelloBacklog } from './backlog-trello.mjs';
import { joinDescription } from './card.mjs';
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
  const answer = (path) => replies[path] ?? replies.default ?? { ok: true, data: {} };
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

describe('чтение задач', () => {
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
  it('карточка встаёт в конец очереди с меткой типа', async () => {
    const trello = fakeTrello();
    const store = backlog({}, trello);
    await store.createTask({
      id: '0032-new',
      type: 'run',
      title: 'Померить',
      description: 'Текст.',
      status: 'new',
      links: { change: null, pr: null, run: null, related: [] },
      attempts: { continuations: 0, cycleFailures: 0 },
    });

    const posted = trello.calls.find((call) => call.path === 'cards');
    expect(posted.body).toMatchObject({ idList: 'list-new', pos: 'bottom' });
    expect(posted.body.idLabels).toEqual(['label-run']);
    expect(posted.body.name).toBe('0032-new · Померить');
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
