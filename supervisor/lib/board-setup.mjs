import { STATES } from '../config/transitions.mjs';

/**
 * Приведение доски к нужному виду: что именно на ней надо завести.
 *
 * Здесь только счёт — чистая функция от того, что на доске уже есть,
 * к перечню действий. Сети нет, а значит проверять поведение можно
 * на выдуманной доске, включая случаи, которые вживую пришлось бы
 * подстраивать руками: половина колонок заведена, метка лежит в архиве,
 * имя занято чужой колонкой.
 *
 * Второй прогон подряд обязан не делать ничего. Это не удобство,
 * а безопасность: скрипт настройки зовут в том числе с испугу — «а всё ли
 * на месте?» — и такой зов не должен заводить вторую колонку «Проработка»
 * рядом с первой.
 */

/**
 * Шаг между позициями колонок.
 *
 * Trello хранит положение дробным числом и вставку между соседями делает
 * усреднением. Шаг с запасом оставляет место для будущих вставок, чтобы
 * не пришлось перенумеровывать всё разом.
 */
const LIST_STEP = 65536;

/**
 * Что сделать с доской, чтобы она стала пригодна для бэклога.
 *
 * @param {object} params
 * @param {object} params.config    настройка конвейера
 * @param {Array}  params.lists     колонки доски, включая закрытые
 * @param {Array}  params.labels    метки доски
 * @returns {{actions: Array, notes: string[]}}
 */
export function planBoard({ config, lists, labels }) {
  const wanted = config.trello.lists;
  const actions = [];
  const notes = [];

  // Имя колонки — единственное, чем она узнаётся: идентификаторы Trello
  // выдаёт сам, и запомнить их негде, кроме как на самой доске.
  const byName = new Map(lists.map((list) => [list.name, list]));

  STATES.forEach((state, index) => {
    const name = wanted[state];
    const existing = byName.get(name);

    if (!existing) {
      actions.push({ kind: 'create-list', state, name, pos: (index + 1) * LIST_STEP });
      return;
    }

    if (existing.closed) {
      // Закрытая колонка — это не отсутствующая: заведи рядом вторую с тем же
      // именем, и обе станут неразличимы для человека.
      actions.push({ kind: 'reopen-list', id: existing.id, state, name });
    }
  });

  /**
   * Метки Trello заводятся с доской: шесть цветных и безымянных. Их
   * переименование дешевле создания новых — иначе безымянная шестёрка
   * останется на доске мусором и будет мешаться в выпадающем списке.
   */
  const byLabelName = new Map(labels.filter((label) => label.name).map((l) => [l.name, l]));
  const spare = labels.filter((label) => !label.name);

  for (const [key, wantedLabel] of Object.entries(config.trello.labels)) {
    const existing = byLabelName.get(wantedLabel.name);
    if (existing) {
      if (existing.color !== wantedLabel.color) {
        actions.push({
          kind: 'recolor-label',
          id: existing.id,
          key,
          name: wantedLabel.name,
          color: wantedLabel.color,
        });
      }
      continue;
    }

    const reusable = spare.findIndex((label) => label.color === wantedLabel.color);
    if (reusable !== -1) {
      const [label] = spare.splice(reusable, 1);
      actions.push({
        kind: 'name-label',
        id: label.id,
        key,
        name: wantedLabel.name,
        color: wantedLabel.color,
      });
      continue;
    }

    actions.push({ kind: 'create-label', key, name: wantedLabel.name, color: wantedLabel.color });
  }

  if (spare.length > 0) {
    notes.push(
      `на доске осталось безымянных меток: ${spare.length}. ` +
        'Конвейер их не трогает — вдруг ими помечают что-то своё',
    );
  }

  return { actions, notes };
}

/** Понятное человеку описание действия — для вывода скрипта. */
export function describeAction(action) {
  switch (action.kind) {
    case 'create-list':
      return `завести колонку «${action.name}» (${action.state})`;
    case 'reopen-list':
      return `вернуть из архива колонку «${action.name}» (${action.state})`;
    case 'create-label':
      return `завести метку «${action.name}» цвета ${action.color}`;
    case 'name-label':
      return `назвать безымянную метку цвета ${action.color} — «${action.name}»`;
    case 'recolor-label':
      return `перекрасить метку «${action.name}» в ${action.color}`;
    default:
      return `неизвестное действие ${action.kind}`;
  }
}
