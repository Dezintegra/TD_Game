import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSchema, validateTask } from './validate-task.mjs';
import { nextId, planAmendments, planRequests, taskFromRequest, translit } from './requests.mjs';

/**
 * Проверки заявок на новые задачи.
 *
 * Главная проверка здесь одна: задача, собранная из заявки, обязана проходить
 * настоящую схему бэклога. Заявка приходит из отчёта сессии — по сути
 * из недоверенного места, — и запись, не прошедшую схему, конвейер потом
 * молча пропустит, а человек будет гадать, почему заведённая задача не идёт.
 */

const NOW = '2026-08-27T12:00:00+03:00';
const schema = loadSchema(fileURLToPath(new URL('../../manage/schema.json', import.meta.url)));

const request = (over = {}) => ({
  type: 'feature',
  title: 'Починить цену Теслы',
  description: 'Цена мешает ремонту, профиль перестаёт чинить постройки.',
  ...over,
});

describe('идентификатор', () => {
  it('первый номер начинается с единицы', () => {
    expect(nextId([], 'Проба')).toMatch(/^0001-/);
  });

  it('номер берётся на единицу больше занятого', () => {
    expect(nextId(['0001-one', '0007-seven', '0003-three'], 'Проба')).toMatch(/^0008-/);
  });

  it('закрытые номера не переиспользуются', () => {
    // Иначе имя ветки однажды совпадёт с именем давно убранной.
    expect(nextId(['0042-closed'], 'Новая')).toMatch(/^0043-/);
  });

  it('кириллица в заголовке становится латиницей', () => {
    expect(translit('Тесла')).toBe('tesla');
    expect(nextId([], 'Починить цену')).toBe('0001-pochinit-cenu');
  });

  it('заголовок без пригодных букв не оставляет пустого имени', () => {
    expect(nextId([], '!!! ???')).toBe('0001-zadacha');
  });
});

describe('задача из заявки', () => {
  it('собранная задача проходит настоящую схему бэклога', () => {
    const { task } = taskFromRequest(request(), {
      id: '0005-tesla',
      now: NOW,
      sourceId: '0001-one',
    });
    expect(validateTask(task, schema)).toEqual([]);
  });

  it('прогон собирается со всеми обязательными полями и проходит схему', () => {
    const { task } = taskFromRequest(
      request({
        type: 'run',
        title: 'Прогон арены',
        run: { kind: 'arena', expectation: 'Доли побед остаются в вилке 45–55.' },
      }),
      { id: '0006-arena', now: NOW, sourceId: '0001-one' },
    );
    expect(validateTask(task, schema)).toEqual([]);
    expect(task.run.kind).toBe('arena');
  });

  it('связь с породившей задачей проставляется', () => {
    const { task } = taskFromRequest(request(), {
      id: '0005-tesla',
      now: NOW,
      sourceId: '0001-one',
    });
    expect(task.links.related).toEqual(['0001-one']);
  });

  it('заявка агента ждёт человека в кандидатах, а не идёт в очередь', () => {
    // Прежде задача заводилась сразу в `new`: агент заводил себе работу
    // сам, а владелец продукта узнавал об этом, когда она уже шла
    // по маршруту.
    const { task } = taskFromRequest(request(), { id: '0005-tesla', now: NOW });
    expect(task).toMatchObject({ status: 'candidate', owner: null, history: [] });
  });

  it('прогон шлюз минует и заводится сразу в работу', () => {
    // Прогон — обязательство по правилу вливания, а не гипотеза агента.
    // Задержись он в кандидатах и не попадись на глаза — правка баланса
    // уедет в главную ветку без заказанного замера.
    const { task } = taskFromRequest(
      request({ type: 'run', run: { kind: 'arena', expectation: 'доли побед около равных' } }),
      { id: '0006-run', now: NOW },
    );
    expect(task.status).toBe('new');
  });

  it('связь с породившей проставляется и у кандидата', () => {
    const { task } = taskFromRequest(request(), {
      id: '0005-tesla',
      now: NOW,
      sourceId: '0001-one',
    });
    expect(task).toMatchObject({ status: 'candidate', links: { related: ['0001-one'] } });
  });
});

describe('блокирующая причина', () => {
  const blocking = request({ blocking: true });

  it('заявка разбора ошибки минует шлюз и встаёт в очередь', () => {
    // Решение принимает не разбор, а сам факт: конвейер не может вести
    // следующие задачи. Пока человек смотрит на доску, та же причина роняет
    // всё, что конвейер успевает взять, — и кандидат тут не шлюз, а пробка.
    const { planned } = planRequests([blocking], {
      existingIds: [],
      now: NOW,
      sourceId: '0001-one',
      sourceStage: 'postmortem',
    });
    expect(planned[0]).toMatchObject({ status: 'new' });
  });

  it('та же метка с прочих этапов не слушается', () => {
    // Иначе шлюз кандидатов размылся бы до необязательного: любой этап
    // объявил бы своё пожелание блокирующим и завёл себе работу сам.
    for (const stage of ['triage', 'design', 'review', null]) {
      const { planned } = planRequests([blocking], {
        existingIds: [],
        now: NOW,
        sourceId: '0001-one',
        sourceStage: stage,
      });
      expect(planned[0].status, `этап ${stage}`).toBe('candidate');
    }
  });

  it('признак едет дальше самой задачей и проходит схему', () => {
    // Хранилище ставит блокирующую задачу первой в очереди и узнаёт её
    // по этому полю. Пока признак терялся здесь, задача миновала
    // кандидатов, но вставала в конец «Заведено» и ждала всю очередь.
    const { planned } = planRequests([blocking], {
      existingIds: [],
      now: NOW,
      sourceId: '0001-one',
      sourceStage: 'postmortem',
    });
    expect(planned[0].blocking).toBe(true);
    expect(validateTask(planned[0], schema)).toEqual([]);
  });

  it('у прочих задач поля нет вовсе, а не false', () => {
    // Отсутствие и есть «обычная»: записи без поля состав не меняют,
    // и ни одна проверка, сверяющая задачу целиком, не должна узнать
    // о признаке против воли.
    const cases = [
      { requests: [request()], sourceStage: 'postmortem' },
      { requests: [blocking], sourceStage: 'triage' },
      {
        requests: [request({ type: 'run', run: { kind: 'arena', expectation: 'равные доли' } })],
        sourceStage: 'postmortem',
      },
    ];
    for (const { requests, sourceStage } of cases) {
      const { planned } = planRequests(requests, { existingIds: [], now: NOW, sourceStage });
      expect(planned[0], sourceStage).not.toHaveProperty('blocking');
    }
  });

  it('разбор без метки заводит кандидата, как и все', () => {
    const { planned } = planRequests([request()], {
      existingIds: [],
      now: NOW,
      sourceId: '0001-one',
      sourceStage: 'postmortem',
    });
    expect(planned[0].status).toBe('candidate');
  });

  it('метка проходит только точным признаком, а не всем правдоподобным', () => {
    // `blocking: "да"` и `blocking: 1` — это не решение, а описка. Заводить
    // по ним работу мимо человека нельзя.
    for (const value of ['да', 1, 'true', {}]) {
      const { planned } = planRequests([request({ blocking: value })], {
        existingIds: [],
        now: NOW,
        sourceStage: 'postmortem',
      });
      expect(planned[0].status, JSON.stringify(value)).toBe('candidate');
    }
  });
});

describe('причина в конвейере', () => {
  const pipeline = request({ area: 'pipeline' });
  const plan = (requests, sourceStage) =>
    planRequests(requests, { existingIds: [], now: NOW, sourceId: '0001-one', sourceStage });

  it('заявка с любого этапа встаёт в очередь первой и проходит схему', () => {
    // 02.09.2026 починки разрешений pnpm и сгорающих продолжений простояли
    // в кандидатах часами: разборы честно не назвали их блокирующими,
    // а прочим этапам метить было нечем. Зона причины — другой вопрос,
    // чем срочность, и право на него есть у всех.
    for (const stage of ['implement', 'review', 'triage', 'postmortem', null]) {
      const { planned } = plan([pipeline], stage);
      expect(planned[0], `этап ${stage}`).toMatchObject({
        status: 'new',
        blocking: true,
        area: 'pipeline',
      });
      expect(validateTask(planned[0], schema), `этап ${stage}`).toEqual([]);
    }
  });

  it('прогон с причиной в конвейере тоже встаёт первым', () => {
    const { planned } = plan(
      [
        request({
          type: 'run',
          area: 'pipeline',
          run: { kind: 'bench-tick', expectation: 'стоимость тика не выросла' },
        }),
      ],
      'interpret',
    );
    expect(planned[0]).toMatchObject({ status: 'new', blocking: true, area: 'pipeline' });
  });

  it('признак проходит только точным словом', () => {
    // Заявка приходит из отчёта сессии — недоверенного по сути места, —
    // и правдоподобное значение не должно тихо менять маршрут.
    for (const value of [true, 'Pipeline', 'конвейер', 1, ['pipeline']]) {
      const { planned } = plan([request({ area: value })], 'implement');
      expect(planned[0].status, JSON.stringify(value)).toBe('candidate');
      expect(planned[0], JSON.stringify(value)).not.toHaveProperty('area');
    }
  });

  it('у обычной заявки поля area нет вовсе', () => {
    const { planned } = plan([request()], 'implement');
    expect(planned[0]).not.toHaveProperty('area');
  });
});

describe('дополнение существующей задачи', () => {
  const known = new Map([
    ['0002-two', { id: '0002-two', status: 'candidate' }],
    ['0003-three', { id: '0003-three', status: 'implement' }],
    ['0004-four', { id: '0004-four', status: 'closed' }],
    ['0005-five', { id: '0005-five', status: 'failed' }],
  ]);

  const plan = (amendments) => planAmendments(amendments, { known, sourceId: '0001-one' });

  it('фактура к незакрытой задаче принимается', () => {
    const { planned, rejected } = plan([{ taskId: '0002-two', facts: 'упала ещё и 0007' }]);
    expect(rejected).toEqual([]);
    expect(planned).toEqual([{ taskId: '0002-two', facts: 'упала ещё и 0007' }]);
  });

  it('задача в работе дополнения принимает: причина ещё жива', () => {
    expect(plan([{ taskId: '0003-three', facts: 'ещё случай' }]).planned).toHaveLength(1);
  });

  it('закрытая и остановленная задача дополнений не принимают', () => {
    // Та же причина после закрытия — это регрессия, а не «ещё один случай»,
    // и хоронить её в законченной истории нельзя.
    for (const id of ['0004-four', '0005-five']) {
      const { planned, rejected } = plan([{ taskId: id, facts: 'ещё случай' }]);
      expect(planned, id).toEqual([]);
      expect(rejected[0].problems.join()).toContain('дополнений не принимает');
    }
  });

  it('несуществующая задача, пустая фактура и сама себя — отказ с причиной', () => {
    const cases = [
      [{ taskId: '0099-none', facts: 'что-то' }, 'нет в бэклоге'],
      [{ taskId: '0002-two', facts: '   ' }, 'пусто'],
      [{ taskId: '0001-one', facts: 'что-то' }, 'саму себя'],
      [{ facts: 'что-то' }, 'не названа задача'],
    ];
    for (const [amendment, why] of cases) {
      const { planned, rejected } = plan([amendment]);
      expect(planned, JSON.stringify(amendment)).toEqual([]);
      expect(rejected[0].problems.join()).toContain(why);
    }
  });

  it('негодное дополнение не отменяет годных', () => {
    const { planned, rejected } = plan([
      { taskId: '0099-none', facts: 'мимо' },
      { taskId: '0002-two', facts: 'по делу' },
    ]);
    expect(planned).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('пустой перечень — законный итог', () => {
    expect(plan([]).planned).toEqual([]);
    expect(plan(undefined).planned).toEqual([]);
  });
});

describe('негодные заявки', () => {
  it('без заголовка — отказ с причиной', () => {
    const { task, problems } = taskFromRequest(request({ title: '' }), { id: '0005-x', now: NOW });
    expect(task).toBeNull();
    expect(problems.join()).toContain('заголовка');
  });

  it('без описания — отказ', () => {
    const { problems } = taskFromRequest(request({ description: '  ' }), {
      id: '0005-x',
      now: NOW,
    });
    expect(problems.join()).toContain('описания');
  });

  it('неизвестный тип — отказ', () => {
    const { problems } = taskFromRequest(request({ type: 'улучшение' }), {
      id: '0005-x',
      now: NOW,
    });
    expect(problems.join()).toContain('неизвестный тип');
  });

  it('прогон без ожидаемого результата — отказ', () => {
    const { problems } = taskFromRequest(request({ type: 'run', run: { kind: 'arena' } }), {
      id: '0005-x',
      now: NOW,
    });
    expect(problems.join()).toContain('ожидаемого результата');
  });

  it('дикий приоритет приводится к разумному', () => {
    const { task } = taskFromRequest(request({ priority: 99999 }), { id: '0005-x', now: NOW });
    expect(task.priority).toBe(999);
  });
});

describe('разбор пачки заявок', () => {
  it('идентификаторы не повторяются', () => {
    const { planned } = planRequests(
      [request({ title: 'Раз' }), request({ title: 'Два' }), request({ title: 'Три' })],
      { existingIds: ['0001-one'], now: NOW, sourceId: '0001-one' },
    );
    expect(planned.map((task) => task.id)).toEqual(['0002-raz', '0003-dva', '0004-tri']);
  });

  it('негодная не отменяет годных', () => {
    const { planned, rejected } = planRequests([request(), request({ type: 'ерунда' })], {
      existingIds: [],
      now: NOW,
    });
    expect(planned).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('пустой перечень заявок ничего не порождает', () => {
    expect(planRequests(undefined, { existingIds: [], now: NOW })).toEqual({
      planned: [],
      rejected: [],
    });
  });
});
