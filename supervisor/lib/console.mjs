/**
 * Рассказ супервизора о своей работе.
 *
 * Чистое форматирование: ничего не решает, никуда не ходит и пишет через
 * переданный наружу `write`. Поэтому весь вывод проверяется без единой
 * настоящей строки в терминале — а проверять здесь есть что, потому что
 * ошибка формата видна только глазами и только тогда, когда смотреть уже
 * поздно.
 *
 * Зачем вообще: этап идёт до полутора часов, и прежде всё это время
 * в консоли было пусто. Отличить «работает» от «повис» можно было лишь
 * диспетчером задач. Журнал цикла при этом никуда не делся — консоль
 * не заменяет его, а дополняет: журнал читают потом и целиком, консоль
 * смотрят сейчас и мельком.
 */

/** Теги строк. Тег несёт и уровень: окрашиваются только два последних. */
export const TAG = {
  start: 'ЗАПУСК',
  cycle: 'ЦИКЛ',
  board: 'ДОСКА',
  task: 'ЗАДАЧА',
  stage: 'ЭТАП',
  pulse: 'ПУЛЬС',
  warn: 'ОТКАЗ',
  error: 'ОШИБКА',
};

// Знак переключения собирается кодом, а не ставится в строку живьём:
// в исходнике он невидим, и правка рядом стёрла бы его незаметно и для
// глаза, и для обзора кода — а строки после этого поехали бы цветом.
const ESC = String.fromCharCode(27);
const sgr = (code) => `${ESC}[${code}m`;

const COLOUR = {
  [TAG.start]: sgr(36),
  [TAG.cycle]: sgr(2),
  [TAG.board]: sgr(2),
  [TAG.task]: sgr(32),
  [TAG.stage]: '',
  [TAG.pulse]: sgr(2),
  [TAG.warn]: sgr(33),
  [TAG.error]: sgr(31),
};

const RESET = sgr(0);

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** Ширина поля тега: по самому длинному из них плюс отбивка. */
const TAG_WIDTH = 6;

/**
 * Завести рассказчика.
 *
 * @param {object} params
 * @param {Function} [params.write]  куда писать; по умолчанию в стандартный вывод
 * @param {Function} [params.now]    часы; приходят доводом ради проверок
 * @param {boolean}  [params.colour] выводить ли цвет
 * @param {boolean}  [params.quiet]  молчать вовсе
 */
export function createConsole({
  write = (text) => process.stdout.write(text),
  now = () => new Date(),
  colour = false,
  quiet = false,
} = {}) {
  // Дата печатается полосой при смене суток, а не в каждой строке.
  // Супервизор живёт днями, и повторять дату восемьсот раз за сутки —
  // тратить ширину терминала на то, что меняется раз в сутки.
  let day = null;

  const paint = (tag, text) => (colour && COLOUR[tag] ? `${COLOUR[tag]}${text}${RESET}` : text);

  function dayBanner() {
    const at = now();
    const today = at.toDateString();
    if (today === day) return;
    day = today;
    const title = `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
    write(`\n${paint(TAG.cycle, `──────── ${title} ────────`)}\n`);
  }

  return {
    /** Печатается ли что-нибудь вообще. Спрашивают, чтобы не считать зря. */
    enabled: !quiet,

    /** Строка с отметкой времени и тегом. */
    line(tag, text) {
      if (quiet) return;
      for (const one of [text].flat().filter((item) => item != null && `${item}` !== '')) {
        dayBanner();
        const stamp = clock(now());
        write(`${paint(TAG.cycle, stamp)} ${paint(tag, tag.padEnd(TAG_WIDTH))} ${one}\n`);
      }
    },

    /**
     * Блок «имя — значение» с заголовком. Им печатается запуск.
     *
     * Отдельно от строк потому, что читается иначе: строки просматривают
     * сверху вниз по мере поступления, а блок читают целиком и один раз.
     */
    block(title, rows) {
      if (quiet) return;
      dayBanner();
      const named = rows.filter(Boolean);
      const width = Math.max(0, ...named.map(([name]) => `${name}`.length));
      write(`\n${paint(TAG.start, title)}\n`);
      for (const [name, value] of named) {
        write(`  ${`${name}`.padEnd(width)}  ${value}\n`);
      }
      write('\n');
    },
  };
}

/** Часы без даты: `14:03:07`. */
export function clock(at) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * Длительность по-человечески.
 *
 * Не «3725 с» и не «1:02:05»: то и другое приходится пересчитывать в уме,
 * а строку пульса читают мельком.
 */
export function humanDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const rest = total % 60;
    return rest ? `${minutes} мин ${rest} с` : `${minutes} мин`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

/** Урезать до предела, пометив урез. Пустое остаётся пустым. */
export function clip(text, limit) {
  const line = oneLine(text);
  if (line.length <= limit) return line;
  return `${line.slice(0, Math.max(0, limit - 1))}…`;
}

/** Свернуть в одну строку: переводы и отступы съедают ширину зря. */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Урезать путь, сохранив хвост.
 *
 * Начало пути одинаково у всех файлов задачи, а различает их хвост, —
 * поэтому режется голова, а не хвост.
 */
export function clipPath(path, limit = 56) {
  const line = oneLine(path).replace(/\\/g, '/');
  if (line.length <= limit) return line;
  return `…${line.slice(line.length - limit + 1)}`;
}

/**
 * Выжимка доводов средства.
 *
 * Печатать доводы целиком нельзя: содержимое правки бывает в сотни строк,
 * и одна такая строка вытеснит из терминала всё остальное. Своя выжимка
 * у каждого известного средства, а у незнакомого — первое строковое поле:
 * лучше грубо, чем ничего, потому что средства заводятся и переименовываются
 * чаще, чем правится этот список.
 */
export function toolDigest(name, input) {
  const args = input ?? {};
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return clipPath(args.file_path ?? args.notebook_path ?? '');
    case 'Bash':
    case 'PowerShell':
      return clip(args.command ?? args.description ?? '', 90);
    case 'Grep':
      return clip(`${args.pattern ?? ''}${args.path ? ` в ${clipPath(args.path, 40)}` : ''}`, 90);
    case 'Glob':
      return clip(args.pattern ?? '', 60);
    case 'Task':
    case 'Agent':
      return clip(args.description ?? args.prompt ?? '', 80);
    case 'TodoWrite':
      return `пунктов ${(args.todos ?? []).length}`;
    case 'WebFetch':
    case 'WebSearch':
      return clip(args.url ?? args.query ?? '', 80);
    default: {
      const first = Object.values(args).find((value) => typeof value === 'string' && value.trim());
      return first ? clip(first, 70) : '';
    }
  }
}

/**
 * Что сказать про событие потока.
 *
 * Возвращает перечень строк — их бывает и ноль, и несколько: один ход
 * ассистента несёт и текст, и вызовы средств разом.
 *
 * Удачные результаты средств не печатаются намеренно: объём они дают
 * изрядный, а пользы никакой. Неудачные — печатаются всегда: это те самые
 * проблемы, ради которых за консолью и следят.
 */
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return [];

  if (event.type === 'system' && event.subtype === 'init') {
    const tools = Array.isArray(event.tools) ? event.tools.length : 0;
    return [`сессия начата: модель ${event.model ?? '—'}, средств ${tools}`];
  }

  if (event.type === 'system' && event.subtype === 'post_turn_summary' && event.needs_action) {
    return [
      `! ${clip(event.status_detail ?? event.status_category ?? 'ход требует внимания', 160)}`,
    ];
  }

  if (event.type === 'assistant') {
    const said = [];
    for (const part of event.message?.content ?? []) {
      if (part.type === 'text' && oneLine(part.text)) said.push(`› ${clip(part.text, 160)}`);
      if (part.type === 'tool_use') {
        said.push(`· ${part.name} ${toolDigest(part.name, part.input)}`.trimEnd());
      }
    }
    return said;
  }

  if (event.type === 'user') {
    return (event.message?.content ?? [])
      .filter((part) => part.type === 'tool_result' && part.is_error)
      .map((part) => `✗ ${clip(textOf(part.content), 200)}`);
  }

  return [];
}

/** Содержимое результата средства бывает и строкой, и перечнем кусков. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
    .join(' ')
    .trim();
}
