import {
  joinDescription,
  labelKeysOf,
  metaOf,
  nameWithId,
  parseCard,
  splitDescription,
  titleOf,
  withExpectation,
} from './card.mjs';
import { findAnswer, joinJournalParts, splitJournalEntry } from './comments.mjs';
import { journalBody } from './journal.mjs';
import { nextId } from './requests.mjs';

/**
 * Бэклог, живущий карточками доски Trello.
 *
 * Вторая реализация того же интерфейса, что и файловое хранилище. Счётная
 * часть конвейера — сканер, таблица переходов, раскладка слотов — о выборе
 * хранилища не знает вовсе и знать не должна.
 *
 * Картина мира читается ОДИН раз за цикл и передаётся сюда снимком. Читать
 * доску заново на каждую задачу значило бы тратить десятки обращений
 * за цикл там, где хватает четырёх, и вдобавок работать с меняющимися под
 * руками данными.
 *
 * Записи же идут по одной и сразу: карточка переезжает в колонку нового
 * состояния тем же запросом, которым обновляются машинные отметки. Это
 * единственная запись, которая обязана быть неделимой, и Trello её такой
 * и делает — проверено пробой.
 */

/**
 * Собрать хранилище поверх снимка доски.
 *
 * Идентификатор доски здесь не нужен: карточки, колонки и метки уже
 * прочитаны, а правки адресуются по идентификатору карточки. Доску знает
 * тот, кто снимок делал.
 */
export function createTrelloBacklog({ trello, config, snapshot, marker, machine = null }) {
  const { lists, labels, cards, comments } = snapshot;
  const trelloConfig = config.trello;
  const mark = marker ?? trelloConfig.marker;

  // Колонки и метки узнаются по именам: идентификаторы Trello выдаёт сам,
  // и запомнить их негде, кроме как на самой доске.
  const listIdByState = new Map();
  const stateByList = new Map();
  for (const [state, name] of Object.entries(trelloConfig.lists)) {
    const list = lists.find((item) => item.name === name && !item.closed);
    if (!list) continue;
    listIdByState.set(state, list.id);
    stateByList.set(list.id, state);
  }

  const labelIdByKey = new Map();
  const labelKeyById = new Map();
  for (const [key, label] of Object.entries(trelloConfig.labels)) {
    const found = labels.find((item) => item.name === label.name);
    if (!found) continue;
    labelIdByKey.set(key, found.id);
    labelKeyById.set(found.id, key);
  }

  // Карточки разбираются разом: задача нужна и сканеру, и исполнению,
  // а разбор её — чистый счёт, повторять который незачем.
  const parsed = cards
    .filter((card) => !card.closed)
    .map((card) => parseCard(card, { stateByList, labelKeyById }));

  const byId = new Map(parsed.filter((item) => item.task.id).map((item) => [item.task.id, item]));

  const commentsByCard = new Map();
  for (const comment of comments) {
    const list = commentsByCard.get(comment.cardId) ?? [];
    list.push(comment);
    commentsByCard.set(comment.cardId, list);
  }

  /** Карточка задачи вместе с разобранным человеческим текстом. */
  const cardOf = (id) => byId.get(id)?.card ?? null;

  /**
   * Чьё имя стоит в служебной отметке владельца.
   *
   * Читается из снимка, снятого в начале оборота, — то есть из состояния
   * ДО любой нашей правки. Именно этим он и ценен: после захвата отметка
   * уже наша, и отличить свой прошлый заход от чужого будет нечем.
   */
  const ownerOf = (id) => byId.get(id)?.task?.owner ?? null;

  /**
   * Опубликовать запись журнала комментариями.
   *
   * Запись, не влезающая в предел Trello, разбивается на пронумерованные
   * части — усечение запрещено: обрезанный лог падения бесполезен ровно
   * в том случае, ради которого его и писали.
   *
   * `source` говорит, чей это текст. Запросы к Trello все до одного делает
   * супервизор, поэтому по автору комментария различить нельзя ничего,
   * а разница между «так решила сессия» и «так распорядился конвейер»
   * читающему доску нужна постоянно.
   */
  async function comment(cardId, text, source) {
    const parts = splitJournalEntry(text, {
      marker: mark,
      source,
      limit: trelloConfig.maxTextLength,
    });
    for (const part of parts) {
      const posted = await trello.post(`cards/${cardId}/actions/comments`, { text: part });
      if (!posted.ok) return posted;
    }
    return { ok: true };
  }

  /** Отказ хранилища в том же виде, в каком его ждёт исполнение решений. */
  const failure = (result) => ({
    ok: false,
    outcome: result.kind === 'offline' ? 'offline' : (result.kind ?? 'failed'),
    why: result.why,
  });

  /**
   * Кем назначаться. Читается один раз и запоминается: участник доски
   * за время цикла не меняется, а лишний запрос стоит четверти секунды.
   */
  let meId = null;
  async function whoAmI() {
    if (meId) return { ok: true, id: meId };
    const me = await trello.get('members/me', { fields: 'id' });
    if (!me.ok) return failure(me);
    meId = me.data.id;
    return { ok: true, id: meId };
  }

  return {
    // Всё, что ниже, повторяет поверхность файлового хранилища. Разница
    // только в том, что записи возвращают обещание: доска отвечает по сети.

    readTask: (id) => byId.get(id)?.task ?? null,

    /**
     * Все занятые идентификаторы.
     *
     * Считая занятыми и архивные карточки: архив — это не удаление, и номер
     * закрытой задачи переиспользовать нельзя, иначе имя ветки однажды
     * совпадёт с именем давно убранной.
     */
    allTaskIds: () =>
      cards
        .map((card) => splitDescription(card.desc ?? '').meta?.id)
        .filter(Boolean)
        .filter((id, index, all) => all.indexOf(id) === index),

    readJournal(id) {
      const card = cardOf(id);
      if (!card) return '';
      const own = (commentsByCard.get(card.id) ?? [])
        .filter((item) => String(item.text ?? '').startsWith(mark))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
        .map((item) => item.text);
      return joinJournalParts(own, { marker: mark });
    },

    async appendJournal(id, text, source) {
      const card = cardOf(id);
      if (!card) return { ok: false, outcome: 'failed', why: `карточки задачи ${id} нет` };
      const posted = await comment(card.id, text, source);
      return posted.ok ? { ok: true, outcome: 'saved' } : failure(posted);
    },

    /**
     * Сохранить задачу: переезд карточки и запись журнала.
     *
     * Колонка и машинные отметки меняются ОДНИМ запросом, и это существенно:
     * состояние задачи хранится колонкой, а состояние возврата и владелец —
     * отметками, и разъехаться им нельзя. Trello такую правку делает
     * неделимой, проверено пробой.
     *
     * Комментарий с записью журнала идёт вторым и отдельным обращением.
     * Обрыв между ними оставит задачу переехавшей без записи в журнале —
     * неприятно, но не опасно: состояние верно, а пропавшую запись видно
     * по дыре в истории карточки.
     */
    async saveTask(task, entry) {
      const card = cardOf(task.id);
      if (!card) {
        return { ok: false, outcome: 'failed', why: `карточки задачи ${task.id} нет` };
      }

      const idList = listIdByState.get(task.status);
      if (!idList) {
        return { ok: false, outcome: 'failed', why: `на доске нет колонки для «${task.status}»` };
      }

      const moved = await trello.put(`cards/${card.id}`, {
        idList,
        // Название пересобирается из очищенного: иначе служебный префикс
        // припишется поверх прежнего и будет расти с каждым переходом.
        name: nameWithId(task.id, titleOf(card.name) || task.title),
        desc: joinDescription(card.human, metaOf(task)),
      });
      if (!moved.ok) return failure(moved);

      // Источник берётся из самой записи: переход состояния бывает и делом
      // сессии — тогда в записи её отчёт, — и распоряжением супервизора.
      const written = await comment(
        card.id,
        `**${entry.from} → ${entry.to}**\n\n${journalBody(entry)}`,
        entry.source,
      );
      if (!written.ok) return failure(written);

      return { ok: true, outcome: 'saved' };
    },

    /**
     * Дописать фактуру в журнал задачи, не трогая её саму.
     *
     * У доски журнал — это комментарии карточки, поэтому дополнение
     * и выглядит ровно так, как надо человеку: новая запись под задачей,
     * видная без единого лишнего щелчка. Карточка при этом никуда не едет
     * и описания не теряет.
     *
     * `message` здесь не нужен вовсе — доске нечего коммитить, — но стоит
     * на своём месте: сигнатура общая с файловым хранилищем, и менять
     * порядок доводов ради одного из них значило бы заставить исполнение
     * помнить, с каким из них оно работает.
     */
    async amendTask(taskId, text, message, source) {
      const card = cardOf(taskId);
      if (!card) return { ok: false, outcome: 'failed', why: `карточки задачи ${taskId} нет` };
      const posted = await comment(card.id, text, source);
      return posted.ok ? { ok: true, outcome: 'saved' } : failure(posted);
    },

    /**
     * Завести новую карточку: колонка по состоянию, метки по задаче.
     *
     * Меток две, а не одна: тип задачи и вид прогона. Второй прежде
     * не ставился вовсе, и заявка на прогон рождала карточку, которую
     * тут же отвергала собственная проверка — вида прогона нет. Туда же
     * терялось и ожидание: оно живёт разделом описания, а не полем.
     *
     * Карточка обязана рождаться годной. Заведённая негодной, она
     * не берётся в работу никогда и при этом даже не падает в ошибку —
     * значит и разбора не получит, и заметить её можно только глазами
     * в журнале цикла.
     */
    async createTask(task) {
      const idList = listIdByState.get(task.status);
      if (!idList) {
        return { ok: false, outcome: 'failed', why: `на доске нет колонки для «${task.status}»` };
      }

      const created = await trello.post('cards', {
        idList,
        name: nameWithId(task.id, task.title),
        desc: joinDescription(withExpectation(task.description ?? '', task), metaOf(task)),
        idLabels: labelKeysOf(task)
          .map((key) => labelIdByKey.get(key))
          .filter(Boolean),
        // Приоритет — это положение карточки, и новичку в начало лезть
        // не за что. Исключение одно: блокирующая причина мешает вести
        // ДРУГИЕ задачи, и всякая задача, взятая раньше неё, упадёт на ней
        // же. Встав в конец, она ждала бы всю очередь — 0080 так простояла
        // восемь часов, и четыре взятые перед ней задачи упали.
        //
        // В служебный блок признак не пишется: после заведения истина
        // о порядке — положение карточки, и перетащить её ниже — законный
        // ход владельца продукта.
        pos: task.blocking ? 'top' : 'bottom',
      });
      if (!created.ok) return failure(created);

      return { ok: true, outcome: 'saved' };
    },

    /**
     * Унести негодную карточку в карантин.
     *
     * Три записи, и порядок их таков, что обрыв между ними не создаёт
     * неразрешимого состояния: переехавшая без метки получит метку
     * следующим циклом, помеченная без комментария — комментарий.
     *
     * Состояние возврата записывается ВМЕСТЕ с переездом, одним запросом.
     * Разъедься они — карточка заперлась бы в ошибке навсегда: из неё
     * задача выходит только в сохранённое состояние, и возврат
     * исправленной карточки отменялся бы как недопустимый переход.
     *
     * Карточка без разобранного служебного блока — обычное дело здесь:
     * порча блока сама по себе повод для карантина. Тогда блок пишется
     * заново из того немногого, что известно, и это лучше, чем ничего:
     * без него возврат снова стал бы невозможен.
     */
    async quarantineCard(id, { problems, returnTo }) {
      const item = byId.get(id);
      if (!item) return { ok: false, outcome: 'failed', why: `карточки задачи ${id} нет` };

      const idList = listIdByState.get('failed');
      if (!idList) {
        return { ok: false, outcome: 'failed', why: 'на доске нет колонки для «failed»' };
      }

      const moved = await trello.put(`cards/${item.card.id}`, {
        idList,
        desc: joinDescription(item.card.human, metaOf({ ...item.task, returnTo })),
      });
      if (!moved.ok) return failure(moved);

      const labelId = labelIdByKey.get('unparsed');
      if (labelId && !item.card.flags.includes('unparsed')) {
        const marked = await trello.post(`cards/${item.card.id}/idLabels`, { value: labelId });
        if (!marked.ok) return failure(marked);
      }

      // Претензии переносятся дословно: они написаны для человека и уже
      // содержат указание, что исправить. Пересказывать их своими словами
      // значило бы терять именно ту часть, ради которой они писались.
      const written = await comment(
        item.card.id,
        [
          '**Карточка не прошла проверку и убрана в «Ошибку».**',
          '',
          ...problems.map((problem) => `- ${problem}`),
          '',
          `Исправьте перечисленное и верните карточку в «${trelloConfig.lists[returnTo] ?? returnTo}» — ` +
            'метка снимется сама.',
        ].join('\n'),
      );
      if (!written.ok) return failure(written);

      return { ok: true, outcome: 'saved' };
    },

    /**
     * Снять с исправленной карточки метку «не разобрано».
     *
     * Комментарий с прежними претензиями не трогается: он часть истории
     * карточки, и по нему видно, чем она болела. Снимается только краснота,
     * которую иначе не уберёт никто — человек, исправивший карточку,
     * о метке уже не думает.
     */
    async clearCard(id) {
      const item = byId.get(id);
      if (!item) return { ok: false, outcome: 'failed', why: `карточки задачи ${id} нет` };

      const labelId = labelIdByKey.get('unparsed');
      if (!labelId || !item.card.flags.includes('unparsed')) {
        return { ok: true, outcome: 'saved' };
      }

      const cleared = await trello.delete(`cards/${item.card.id}/idLabels/${labelId}`);
      return cleared.ok ? { ok: true, outcome: 'saved' } : failure(cleared);
    },

    /**
     * Захватить задачу назначением исполнителя в карточке.
     *
     * Это операция «сравни-и-запиши», и в этом весь смысл. Проверено
     * пробой: `POST /cards/{id}/idMembers` при повторном назначении того же
     * участника отвечает `400 member is already on the card`. Значит первая
     * станция получает успех, вторая — внятный отказ, и обе не могут
     * считать задачу своей.
     *
     * Обычная правка карточки такого свойства НЕ даёт: `PUT` с полем
     * `idMembers` молча перезаписывает и отвечает успехом обеим — проверено
     * там же.
     *
     * Захват при этом виден человеку прямо на доске, без заглядывания
     * в служебные отметки, — ради этого доска и заводилась.
     *
     * Чего назначение НЕ даёт: различить рабочие станции. Участник доски
     * один на все машины, потому что токен один. Имя станции пишется
     * в служебный блок следующим действием, и обрыв между ними оставит
     * карточку занятой неизвестно кем; разбирает это сверка — хозяином
     * считается та станция, у которой есть рабочее дерево задачи.
     */
    async acquire(task) {
      const card = cardOf(task.id);
      if (!card) return { ok: false, outcome: 'failed', why: `карточки задачи ${task.id} нет` };

      const me = await whoAmI();
      if (!me.ok) return me;

      const taken = await trello.post(`cards/${card.id}/idMembers`, { value: me.id });
      if (taken.ok) return { ok: true, outcome: 'ours' };

      // Единственный отказ, который бедой не является: задачу уже заняли.
      //
      // Но «заняли» — это две разные вещи, и различить их обязательно.
      // Участник доски один на все станции, поэтому само назначение
      // не говорит, кто держит задачу; говорит служебная отметка владельца,
      // прочитанная ДО этой попытки. Наше имя в ней означает собственный
      // недоведённый захват: этап оборвался, назначение осталось, — и брать
      // такую задачу заново законно, это ровно то, ради чего конвейер её
      // и захватывал.
      //
      // Пока разницы не было, задача 0016 висела с 28.08.2026: взять её
      // конвейер не мог, а её состояние занимало единственное место
      // исполнителя, и весь бэклог стоял за ней с 31.08.2026.
      if (/already on the card/i.test(taken.why ?? '')) {
        const holder = ownerOf(task.id);
        if (machine && holder === machine) return { ok: true, outcome: 'ours' };
        return {
          ok: false,
          outcome: 'taken',
          why: holder
            ? `задача уже назначена исполнителю (${holder})`
            : 'задача уже назначена исполнителю',
        };
      }
      return failure(taken);
    },

    /**
     * Отпустить захват: снять назначение.
     *
     * Зовётся при уборке за закрытой задачей и при откате незавершённого
     * взятия в работу. Отсутствие назначения бедой не считается: цель
     * достигнута.
     */
    async release(task) {
      const card = cardOf(task.id);
      if (!card) return { ok: true, outcome: 'released' };

      const me = await whoAmI();
      if (!me.ok) return me;

      const freed = await trello.delete(`cards/${card.id}/idMembers/${me.id}`);
      return freed.ok ? { ok: true, outcome: 'released' } : failure(freed);
    },

    /**
     * Снять свой захват.
     *
     * Зовётся, когда взятие в работу сорвалось: помеченной собой чужую
     * задачу оставлять нельзя. Карточка при этом остаётся на месте —
     * двигать её обратно нечего, состояние ещё не менялось.
     */
    async releaseTask(task) {
      const card = cardOf(task.id);
      if (!card) return { ok: false, outcome: 'failed' };
      const cleared = await trello.put(`cards/${card.id}`, {
        desc: joinDescription(card.human, metaOf({ ...task, owner: null })),
      });
      return cleared.ok ? { ok: true, outcome: 'saved' } : failure(cleared);
    },

    /**
     * Задать вопрос владельцу продукта — комментарием к карточке.
     *
     * Возвращает `null`: увозить коммитом нечего. У файлового бэклога этот
     * метод отдаёт путь файла вопросов, чтобы тот уехал тем же коммитом,
     * что и задача; доске такая связка не нужна — вопрос ложится прямо
     * на карточку, и разъехаться им негде.
     *
     * Отдельного файла вопросов больше нет намеренно: вопрос живёт там же,
     * где задача, и владелец продукта отвечает оттуда же, откуда читает.
     */
    async askOwner(task, report) {
      const card = cardOf(task.id);
      if (!card) return null;

      const lines = ['**Вопрос владельцу продукта**', '', report.summary ?? ''];
      const options = report.decisions ?? [];
      if (options.length > 0) {
        lines.push('', '**Варианты:**', '');
        for (const option of options) lines.push(`- ${option}`);
      } else {
        // Вопрос без вариантов задавать не велено, но и молчать о нём
        // нельзя: пусть владелец продукта видит, что выбирать ему
        // предлагают из пустоты, и спросит с конвейера.
        lines.push('', '_Сессия не назвала вариантов — это её недоработка._');
      }
      lines.push('', 'Чтобы ответить, напишите комментарий к этой карточке.');

      // Вопрос помечается агентским: сформулировала его сессия, супервизор
      // лишь донёс. Владельцу продукта это говорит, с кого спрашивать,
      // если спрашивают невнятно.
      await comment(card.id, lines.join('\n'), 'agent');
      return null;
    },

    /**
     * Отметить полученный ответ.
     *
     * Записывать сам ответ никуда не надо: он уже лежит комментарием
     * владельца продукта. Конвейер лишь подтверждает, что услышал, — иначе
     * по карточке нельзя отличить отвеченный вопрос от незамеченного.
     */
    async recordAnswer(task, action, report) {
      const card = cardOf(task.id);
      const answer = report?.decisions?.[0];
      if (!card || !answer) return null;

      // Ответ собрала спрашивающая сессия, она же его и пересказала, —
      // значит запись агентская, как и сам вопрос.
      await comment(card.id, `**Ответ принят**\n\n${answer}`, 'agent');
      return null;
    },

    /** Ответ владельца продукта — первый комментарий без пометки после вопроса. */
    readAnswer(id) {
      const item = byId.get(id);
      if (!item) return null;
      const found = findAnswer(commentsByCard.get(item.card.id) ?? [], {
        marker: mark,
        since: item.task.statusChangedAt,
      });
      return found?.text ?? null;
    },

    /** Разобранные карточки — для сканера и для проверки при чтении. */
    parsedCards: () => parsed,

    /**
     * Дать номера карточкам, заведённым человеком.
     *
     * Владелец продукта заводит карточку одним заголовком — в этом весь
     * смысл переезда, — а идентификатор нужен конвейеру: он служит именем
     * ветки, дерева и захвата. Значит выдать его должен конвейер, и первым
     * же циклом, пока задача ещё никуда не двинулась.
     *
     * Номер берётся на единицу больше самого большого занятого, включая
     * архивные карточки. Возвращает перечень принятых задач и беды, если
     * какие-то принять не удалось: одна неудача не отменяет остальных.
     */
    async adoptOrphans() {
      const orphans = parsed.filter((item) => !item.task.id);
      if (orphans.length === 0) return { adopted: [], problems: [] };

      const taken = cards.map((card) => splitDescription(card.desc ?? '').meta?.id).filter(Boolean);
      const adopted = [];
      const problems = [];

      for (const item of orphans) {
        const id = nextId([...taken, ...adopted], item.task.title);
        const task = { ...item.task, id };

        const written = await trello.put(`cards/${item.card.id}`, {
          name: nameWithId(id, item.task.title),
          desc: joinDescription(item.card.human, metaOf(task)),
        });
        if (!written.ok) {
          problems.push(`карточке «${item.task.title}» не выдан номер: ${written.why}`);
          continue;
        }

        // Снимок правится в памяти вместе с доской: этим же циклом задачу
        // уже можно брать в работу, не дожидаясь следующего чтения.
        item.task.id = id;
        item.card.name = nameWithId(id, item.task.title);
        byId.set(id, item);
        adopted.push(id);
      }

      return { adopted, problems };
    },

    /** Идентификатор колонки по состоянию: нужен возврату карточек. */
    listIdOf: (state) => listIdByState.get(state) ?? null,

    /** Идентификатор метки по назначению: нужен пометке «не разобрано». */
    labelIdOf: (key) => labelIdByKey.get(key) ?? null,
  };
}
