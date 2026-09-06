import { describe, expect, it } from 'vitest';
import {
  createdAtOf,
  expectationOf,
  joinDescription,
  metaOf,
  labelKeysOf,
  nameWithId,
  parseCard,
  splitDescription,
  titleOf,
} from './card.mjs';

/**
 * Проверки разбора карточки.
 *
 * Дороже всего здесь стоит потеря машинных отметок: не разобрался блок —
 * и владелец задачи стал пустым, а значит задачу возьмёт вторая машина.
 * Поэтому испорченный блок отличается от отсутствующего, и оба случая
 * проверяются отдельно.
 */

const stateByList = new Map([
  ['list-new', 'new'],
  ['list-design', 'design'],
]);

const labelKeyById = new Map([
  ['l-feature', 'feature'],
  ['l-run', 'run'],
  ['l-note', 'note'],
  ['l-arena', 'arena'],
  ['l-unparsed', 'unparsed'],
  ['l-decomposed', 'decomposed'],
]);

const ctx = { stateByList, labelKeyById };

/** Идентификатор карточки Trello: первые восемь знаков — время создания. */
const idAt = (iso, tail = 'aabbccddeeff00112233') =>
  Math.floor(Date.parse(iso) / 1000)
    .toString(16)
    .padStart(8, '0') + tail;

const card = (over = {}) => ({
  id: idAt('2026-08-20T10:00:00Z'),
  name: '0031-proba · Проба пера',
  desc: 'Что нужно сделать.',
  idList: 'list-new',
  idLabels: ['l-feature'],
  pos: 65536,
  ...over,
});

describe('машинный блок', () => {
  it('вырезается из описания, не задевая человеческого текста', () => {
    const desc = joinDescription('Текст человека.', { id: '0031-x', owner: null });
    const { human, meta } = splitDescription(desc);
    expect(human).toBe('Текст человека.');
    expect(meta).toEqual({ id: '0031-x', owner: null });
  });

  it('переживает кавычки и угловые скобки внутри значений', () => {
    const meta = { id: '0031-x', note: 'кавычка " и <тег>' };
    expect(splitDescription(joinDescription('Текст.', meta)).meta).toEqual(meta);
  });

  it('его отсутствие — обычное дело: карточку только что завёл человек', () => {
    const { human, meta, broken } = splitDescription('Просто описание.');
    expect(human).toBe('Просто описание.');
    expect(meta).toBeNull();
    expect(broken).toBeUndefined();
  });

  it('испорченный блок не притворяется пустым', () => {
    const { meta, broken } = splitDescription('Текст.\n\n<!-- pipeline\n{это не json\n-->');
    expect(meta).toBeNull();
    expect(broken).toBe(true);
  });

  it('не уносит с собой человеческий текст, дописанный ниже блока', () => {
    const desc = `Сверху.\n\n<!-- pipeline\n{"id":"0031-x"}\n-->\n\nСнизу дописали.`;
    const { human, meta } = splitDescription(desc);
    expect(human).toContain('Сверху.');
    expect(human).toContain('Снизу дописали.');
    expect(meta.id).toBe('0031-x');
  });
});

describe('отметка заведения', () => {
  it('читается из идентификатора карточки, а не хранится отдельно', () => {
    expect(createdAtOf(idAt('2026-08-20T10:00:00Z'))).toBe('2026-08-20T10:00:00.000Z');
  });

  it('у негодного идентификатора её нет, а не «начало эпохи»', () => {
    expect(createdAtOf('нечто')).toBeNull();
  });
});

describe('название карточки', () => {
  it('очищается от служебного префикса', () => {
    expect(titleOf('0031-proba · Проба пера')).toBe('Проба пера');
    expect(titleOf('0031-proba — Проба пера')).toBe('Проба пера');
  });

  it('без префикса остаётся собой', () => {
    expect(titleOf('Починить свист ядерного удара')).toBe('Починить свист ядерного удара');
  });

  it('не режет заголовок, начинающийся с числа не того вида', () => {
    expect(titleOf('2026 год: что успеть')).toBe('2026 год: что успеть');
  });

  it('собирается обратно с префиксом', () => {
    expect(nameWithId('0031-proba', 'Проба пера')).toBe('0031-proba · Проба пера');
    expect(nameWithId(null, 'Ещё без номера')).toBe('Ещё без номера');
  });
});

describe('ожидаемый результат прогона', () => {
  it('читается из раздела описания', () => {
    const human =
      'Померить арену.\n\n## Ожидаемый результат\n\nОсадный профиль перестанет\nвыигрывать всухую.';
    expect(expectationOf(human)).toBe('Осадный профиль перестанет\nвыигрывать всухую.');
  });

  it('обрывается на следующем заголовке, не съедая соседний раздел', () => {
    const human = '## Ожидаемый результат\n\nЦифра вырастет.\n\n## Как мерить\n\nАреной.';
    expect(expectationOf(human)).toBe('Цифра вырастет.');
  });

  it('пустой раздел — это отсутствие ожидания, а не пустая строка', () => {
    expect(expectationOf('## Ожидаемый результат\n\n')).toBeNull();
  });

  it('без раздела его нет', () => {
    expect(expectationOf('Просто описание.')).toBeNull();
  });
});

describe('разбор карточки', () => {
  it('даёт задачу той же формы, что и прежняя запись бэклога', () => {
    const desc = joinDescription('Что нужно сделать.', {
      id: '0031-proba',
      owner: 'станция-1',
      returnTo: null,
      statusChangedAt: '2026-08-21T09:00:00.000Z',
      links: { change: 'proba', pr: 65, run: null, related: [] },
      attempts: { continuations: 1, cycleFailures: 0 },
    });
    const { task } = parseCard(card({ desc, idList: 'list-design' }), ctx);

    expect(task).toMatchObject({
      id: '0031-proba',
      type: 'feature',
      title: 'Проба пера',
      description: 'Что нужно сделать.',
      status: 'design',
      owner: 'станция-1',
      statusChangedAt: '2026-08-21T09:00:00.000Z',
    });
    expect(task.links.pr).toBe(65);
    expect(task.attempts.continuations).toBe(1);
  });

  it('приоритетом служит положение карточки в колонке', () => {
    const { task } = parseCard(card({ pos: 128 }), ctx);
    expect(task.priority).toBe(128);
  });

  it('состояние берётся из колонки, а не из описания', () => {
    const desc = joinDescription('Текст.', { id: '0031-x', status: 'deploy' });
    const { task } = parseCard(card({ desc, idList: 'list-design' }), ctx);
    expect(task.status).toBe('design');
  });

  it('карточка в незнакомой колонке не получает состояния наугад', () => {
    const { task } = parseCard(card({ idList: 'чужая-колонка' }), ctx);
    expect(task.status).toBeNull();
  });

  it('у карточки без блока нет идентификатора — его назначит конвейер', () => {
    const { task } = parseCard(card({ desc: 'Только что завели.', name: 'Починить свист' }), ctx);
    expect(task.id).toBeNull();
    expect(task.title).toBe('Починить свист');
  });

  it('прогон получает вид и ожидание, а доработка — нет', () => {
    const human = 'Померить.\n\n## Ожидаемый результат\n\nСтанет ровнее.';
    const run = parseCard(card({ desc: human, idLabels: ['l-run', 'l-arena'] }), ctx);
    expect(run.task.run).toEqual({ kind: 'arena', expectation: 'Станет ровнее.' });

    const feature = parseCard(card(), ctx);
    expect(feature.task.run).toBeUndefined();
  });

  it('две метки типа не выбираются молча за человека', () => {
    const { card: seen } = parseCard(card({ idLabels: ['l-feature', 'l-note'] }), ctx);
    expect(seen.types).toEqual(['feature', 'note']);
  });

  it('служебные метки отделены от смысловых', () => {
    const { card: seen } = parseCard(card({ idLabels: ['l-feature', 'l-unparsed'] }), ctx);
    expect(seen.types).toEqual(['feature']);
    expect(seen.flags).toEqual(['unparsed']);
  });

  it('метка дробления читается в признак задачи', () => {
    const { task } = parseCard(card({ idLabels: ['l-feature', 'l-decomposed'] }), ctx);
    expect(task.decomposed).toBe(true);
  });

  it('без метки признак ложен, а не отсутствует', () => {
    // Отсутствие поля означало бы «неизвестно», и маршрут из очереди пришлось
    // бы угадывать. Здесь известно: анализа не было.
    const { task } = parseCard(card({ idLabels: ['l-feature'] }), ctx);
    expect(task.decomposed).toBe(false);
  });

  it('признак задачи отдаёт метку обратно на карточку', () => {
    // Без этого метка не уехала бы на заведённую дроблением карточку,
    // и она пошла бы на анализ, который для неё только что провели.
    expect(labelKeysOf({ type: 'feature', decomposed: true })).toEqual(['feature', 'decomposed']);
    expect(labelKeysOf({ type: 'feature', decomposed: false })).toEqual(['feature']);
  });
});

describe('сборка отметок', () => {
  it('история переходов в блок не попадает: она живёт комментариями', () => {
    const meta = metaOf({
      id: '0031-x',
      owner: null,
      statusChangedAt: '2026-08-21T09:00:00.000Z',
      history: [{ at: '2026-08-21T09:00:00.000Z', from: 'new', to: 'design' }],
    });
    expect(meta).not.toHaveProperty('history');
  });

  it('разбор и сборка сходятся: отметки переживают дорогу туда и обратно', () => {
    const task = {
      id: '0031-x',
      owner: 'станция-2',
      returnTo: 'design',
      statusChangedAt: '2026-08-21T09:00:00.000Z',
      links: { change: 'proba', pr: 7, run: null, related: ['0030-y'] },
      attempts: { continuations: 2, cycleFailures: 1 },
    };
    const desc = joinDescription('Текст.', metaOf(task));
    const { task: back } = parseCard(card({ desc }), ctx);

    expect(back.owner).toBe('станция-2');
    expect(back.returnTo).toBe('design');
    expect(back.links.related).toEqual(['0030-y']);
    expect(back.attempts).toEqual({ continuations: 2, cycleFailures: 1 });
  });

  it('счёт несостоявшихся запусков переживает дорогу туда и обратно', () => {
    // Без этого счётчик обнулялся бы каждым чтением карточки, и предел
    // не сработал бы никогда: бэклог живёт на доске, а не в файлах.
    const task = {
      id: '0067-x',
      owner: null,
      statusChangedAt: '2026-09-02T09:00:00.000Z',
      attempts: { continuations: 0, cycleFailures: 0, spawnFailures: 2 },
    };
    const desc = joinDescription('Текст.', metaOf(task));
    const { task: back } = parseCard(card({ desc }), ctx);

    expect(back.attempts.spawnFailures).toBe(2);
  });

  it('вердикт разбора и счёт возвратов переживают дорогу туда и обратно', () => {
    // По вердикту конвейер возвращает задачу из ошибки, по счёту —
    // останавливается после второго возврата. Потеряйся любое из них
    // при чтении карточки — задача либо не вернётся, либо вернётся
    // без предела.
    const task = {
      id: '0041-x',
      owner: null,
      statusChangedAt: '2026-09-02T09:00:00.000Z',
      attempts: { continuations: 0, cycleFailures: 0 },
      recovery: { causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 1 },
    };
    const desc = joinDescription('Текст.', metaOf(task));
    const { task: back } = parseCard(card({ desc }), ctx);

    expect(back.recovery).toEqual({ causedBy: 'pipeline', fixedBy: ['0091-fix'], returns: 1 });
  });

  it('у неразобранной задачи вердикта нет вовсе', () => {
    // Отсутствие — честный ответ «не судили», а не пустой вердикт: записи
    // без поля состав не меняют, и ни одна проверка целиком не узнает
    // о нём против воли.
    const task = { id: '0031-x', owner: null, statusChangedAt: '2026-08-21T09:00:00.000Z' };
    expect(metaOf(task)).not.toHaveProperty('recovery');
    const { task: back } = parseCard(card({ desc: joinDescription('', metaOf(task)) }), ctx);
    expect(back).not.toHaveProperty('recovery');
  });

  it('вердикт из блока прежней раскладки приводится к полному виду', () => {
    // Блок пишет та версия, что стояла на момент записи; читает — та,
    // что стоит теперь. Неполный или испорченный вердикт не должен ронять
    // разбор карточки: он приводится к тому, что из него можно понять.
    const desc = joinDescription('', {
      id: '0041-x',
      recovery: { causedBy: 'кто-то', returns: '2' },
    });
    const { task: back } = parseCard(card({ desc }), ctx);
    expect(back.recovery).toEqual({ causedBy: null, fixedBy: [], returns: 0 });
  });
});
