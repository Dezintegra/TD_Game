/**
 * Канбан-доска по бэклогу.
 *
 * Страница только на чтение: управление задачами остаётся правкой файлов.
 * Смысл доски в том, чтобы владелец продукта видел картину, не открывая
 * два десятка JSON-файлов, — и первым делом видел то, что ждёт лично его.
 *
 * Делается страницей в репозитории, а не публикацией: публикация артефакта
 * из автономной сессии не подтверждена пробой, а доска нужна работающей
 * с первого дня. Публикация добавится сверху, когда подтвердится.
 */

/** Колонки доски. Состояния сгруппированы по тому, чего задача ждёт. */
export const COLUMNS = [
  { title: 'Очередь', states: ['new'] },
  { title: 'В работе', states: ['triage', 'design', 'audit', 'implement', 'revise'] },
  { title: 'Прогон', states: ['benchmark'] },
  { title: 'Проверки', states: ['pr'] },
  { title: 'Ревью', states: ['review'] },
  { title: 'Выкладка', states: ['deploy', 'cleanup'] },
  { title: 'Ждут вас', states: ['awaiting-po'] },
  { title: 'Остановлены', states: ['failed'] },
  { title: 'Закрыты', states: ['closed'] },
];

/** Сколько часов ожидания ответа считать поводом для внимания. */
const ATTENTION_HOURS = 24;

/** Сколько закрытых задач показывать: доска — это картина работы, а не архив. */
const CLOSED_SHOWN = 10;

/** Экранирование: заголовок задачи пишет человек, и в нём бывает что угодно. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Сколько часов задача в нынешнем состоянии. */
export function hoursIn(task, now) {
  const since = Date.parse(task.statusChangedAt ?? task.createdAt);
  if (Number.isNaN(since)) return 0;
  return Math.max(0, (Date.parse(now) - since) / 3600000);
}

/** Человеческая длительность: часы до суток, дальше сутки. */
function humanAge(hours) {
  if (hours < 1) return 'меньше часа';
  if (hours < 24) return `${Math.floor(hours)} ч`;
  return `${Math.floor(hours / 24)} сут`;
}

/** Ждёт ли задача внимания владельца продукта дольше положенного. */
export const needsAttention = (task, now) =>
  task.status === 'awaiting-po' && hoursIn(task, now) >= ATTENTION_HOURS;

/** Карточка одной задачи. */
function card(task, now) {
  const age = humanAge(hoursIn(task, now));
  const links = [];
  if (task.links?.change) links.push(`изменение: ${escapeHtml(task.links.change)}`);
  if (task.links?.pr) links.push(`PR #${escapeHtml(task.links.pr)}`);
  if (task.links?.run) links.push(`прогон ${escapeHtml(task.links.run)}`);

  return [
    `<article class="card${needsAttention(task, now) ? ' attention' : ''}">`,
    `<div class="id">${escapeHtml(task.id)}</div>`,
    `<div class="title">${escapeHtml(task.title)}</div>`,
    `<div class="meta"><span class="type type-${escapeHtml(task.type)}">${escapeHtml(task.type)}</span>`,
    `<span class="prio">приоритет ${escapeHtml(task.priority)}</span>`,
    `<span class="age">${escapeHtml(age)}</span></div>`,
    links.length ? `<div class="links">${links.join(' · ')}</div>` : '',
    '</article>',
  ].join('');
}

/**
 * Собрать страницу.
 *
 * Порядок внутри колонки тот же, в каком задачи берутся в работу: сперва
 * приоритет, потом давность. Так видно не только что лежит, но и что пойдёт
 * следующим.
 */
export function renderBoard(tasks, { now }) {
  const byPriority = (a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : Date.parse(a.createdAt) - Date.parse(b.createdAt);

  const columns = COLUMNS.map((column) => {
    let items = tasks.filter((task) => column.states.includes(task.status)).sort(byPriority);
    if (column.title === 'Закрыты') {
      items = items
        .slice()
        .sort((a, b) => Date.parse(b.statusChangedAt) - Date.parse(a.statusChangedAt))
        .slice(0, CLOSED_SHOWN);
    }
    return { ...column, items };
  });

  const waiting = tasks.filter((task) => needsAttention(task, now));

  return [
    '<title>Конвейер: доска задач</title>',
    STYLE,
    '<h1>Конвейер: доска задач</h1>',
    `<p class="stamp">Собрано ${escapeHtml(now)}. Только на чтение: задачи правятся файлами в <code>backlog/tasks/</code>.</p>`,
    waiting.length
      ? `<p class="alarm">Вашего ответа ждут дольше суток: ${waiting
          .map((task) => escapeHtml(task.id))
          .join(', ')}</p>`
      : '',
    '<div class="board">',
    ...columns.map((column) =>
      [
        '<section class="column">',
        `<h2>${escapeHtml(column.title)} <span class="count">${column.items.length}</span></h2>`,
        column.items.map((task) => card(task, now)).join('') || '<p class="empty">пусто</p>',
        '</section>',
      ].join(''),
    ),
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Оформление.
 *
 * Цвета заданы для обеих тем: доску открывают и в светлом окне, и в тёмном,
 * а невидимый текст — худший вид отчёта.
 */
const STYLE = `<style>
:root {
  --fon: #f6f7f8; --karta: #ffffff; --tekst: #1a1c1e;
  --tusklo: #6b7280; --ramka: #e2e5e9; --akcent: #00a01a; --trevoga: #b91c1c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fon: #16181c; --karta: #212429; --tekst: #e8eaed;
    --tusklo: #9aa0a6; --ramka: #2f333a; --akcent: #00ff29; --trevoga: #f87171;
  }
}
body { margin: 0; padding: 24px; background: var(--fon); color: var(--tekst);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
.stamp { color: var(--tusklo); margin: 0 0 16px; }
.alarm { color: var(--trevoga); font-weight: 600; margin: 0 0 16px; }
.board { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
.column { flex: 0 0 240px; background: var(--karta); border: 1px solid var(--ramka);
  border-radius: 10px; padding: 10px; }
.column h2 { font-size: 13px; margin: 0 0 8px; display: flex; justify-content: space-between; }
.count { color: var(--tusklo); font-weight: 400; }
.empty { color: var(--tusklo); font-size: 12px; margin: 4px 0; }
.card { border: 1px solid var(--ramka); border-radius: 8px; padding: 8px; margin-bottom: 8px; }
.card.attention { border-color: var(--trevoga); box-shadow: 0 0 0 1px var(--trevoga); }
.id { font-family: ui-monospace, monospace; font-size: 11px; color: var(--tusklo); }
.title { margin: 2px 0 6px; }
.meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--tusklo); }
.type { color: var(--akcent); }
.links { margin-top: 6px; font-size: 11px; color: var(--tusklo); }
</style>`;
