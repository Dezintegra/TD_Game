import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OUTCOMES } from '../lib/apply-report.mjs';
import { TRACE } from '../lib/denials.mjs';
import { STAGE_COMMANDS, uncoveredForStage } from './permissions.mjs';
import {
  NEEDS_SESSION,
  NEEDS_WORKTREE,
  ROUTES,
  STATES,
  STATE_CLASS,
  canTransition,
  isExclusive,
  isResource,
  isWaiting,
  stateClass,
} from './transitions.mjs';

/**
 * Проверки автомата состояний.
 *
 * Здесь ловится ровно то, что дороже всего заметить в живом конвейере:
 * переход, которого не должно быть, и цена состояния, посчитанная неверно.
 * Первое пустило бы задачу мимо проверки, второе заняло бы машину замером
 * посреди чужой работы.
 */

const task = (over = {}) => ({
  id: '0001-example',
  type: 'feature',
  status: 'new',
  returnTo: null,
  ...over,
});

describe('маршруты', () => {
  it('доработка идёт полным путём', () => {
    const path = [
      ['new', 'design'],
      ['design', 'audit'],
      ['audit', 'implement'],
      ['implement', 'pr'],
      ['pr', 'review'],
      ['review', 'deploy'],
      ['deploy', 'cleanup'],
      ['cleanup', 'closed'],
    ];
    for (const [from, to] of path) {
      expect(canTransition(task({ status: from }), to).ok, `${from} → ${to}`).toBe(true);
    }
  });

  it('кандидат одобряется переходом в очередь', () => {
    // Переход объявлен, хотя выполняет его человек мышью. Не объяви его —
    // карточка, перетащенная в «Заведено», вернулась бы обратно: конвейер
    // возвращает всё, чего нет в таблице. Шлюз не просто не работал бы,
    // а отменял бы одобрение.
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'new').ok).toBe(true);
    expect(canTransition(task({ type: 'note', status: 'candidate' }), 'new').ok).toBe(true);
  });

  it('кандидата нельзя протащить мимо очереди', () => {
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'design').ok).toBe(false);
    expect(canTransition(task({ type: 'feature', status: 'candidate' }), 'implement').ok).toBe(
      false,
    );
  });

  it('прогон кандидатом не бывает', () => {
    expect(canTransition(task({ type: 'run', status: 'candidate' }), 'new').ok).toBe(false);
  });

  it('прогон не заходит в проработку', () => {
    expect(canTransition(task({ type: 'run', status: 'new' }), 'design').ok).toBe(false);
    expect(canTransition(task({ type: 'run', status: 'new' }), 'benchmark').ok).toBe(true);
  });

  it('замер отдаёт прогон толкованию, а закрыть его сам не вправе', () => {
    const measured = task({ type: 'run', status: 'benchmark' });
    expect(canTransition(measured, 'interpret').ok).toBe(true);
    expect(canTransition(measured, 'closed').ok).toBe(false);
  });

  it('толкование закрывает прогон', () => {
    expect(canTransition(task({ type: 'run', status: 'interpret' }), 'completed').ok).toBe(true);
  });

  it('доработка толкования не знает: её замер ведёт к проверкам', () => {
    // Толкование объявлено только на маршруте прогона. У доработки замер —
    // одна из проверок перед ревью, и читает её ревьюер.
    const measured = task({ type: 'feature', status: 'benchmark' });
    expect(canTransition(measured, 'interpret').ok).toBe(false);
    expect(canTransition(measured, 'pr').ok).toBe(true);
  });

  it('замечание разбирается и закрывается', () => {
    expect(canTransition(task({ type: 'note', status: 'new' }), 'triage').ok).toBe(true);
    expect(canTransition(task({ type: 'note', status: 'triage' }), 'closed').ok).toBe(true);
  });

  it('через ступень перепрыгнуть нельзя', () => {
    const verdict = canTransition(task({ status: 'design' }), 'pr');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('«audit»');
  });

  it('аудит с замечаниями возвращает в проработку', () => {
    expect(canTransition(task({ status: 'audit' }), 'design').ok).toBe(true);
  });

  it('доработка ведёт в ожидание проверок, а не сразу в ревью', () => {
    expect(canTransition(task({ status: 'revise' }), 'pr').ok).toBe(true);
    expect(canTransition(task({ status: 'revise' }), 'review').ok).toBe(false);
  });

  it('проработка доработки ведёт и в уборку: предмет задачи снят', () => {
    // Второй конец проработки. Задача, чей предмет снят до начала работы,
    // проектировать нечего, и вести её дальше по маршруту не за чем.
    // Идёт она именно в уборку, а не в «Закрыто»: дерево заведено ей
    // до первой сессии, а удаляет конвейер только из `cleanup`.
    expect(canTransition(task({ status: 'design' }), 'cleanup').ok).toBe(true);
    expect(canTransition(task({ status: 'design' }), 'audit').ok).toBe(true);
  });

  it('прогон и замечание в уборку из проработки не ходят', () => {
    // У обоих типов проработки нет вовсе, и ход обязан упереться в таблицу,
    // а не обойти её. У замечания первая сессия — разбор, закрывающий задачу
    // штатно; у прогона — замер, которому вердикт выносить запрещено.
    expect(canTransition(task({ type: 'run', status: 'design' }), 'cleanup').ok).toBe(false);
    expect(canTransition(task({ type: 'note', status: 'design' }), 'cleanup').ok).toBe(false);
  });

  it('несуществующее состояние отвергается', () => {
    expect(canTransition(task(), 'почти-готово').ok).toBe(false);
  });
});

describe('сквозные состояния', () => {
  it('ошибка достижима из любого рабочего состояния', () => {
    for (const status of ['design', 'implement', 'benchmark', 'review', 'deploy']) {
      expect(canTransition(task({ status }), 'failed').ok, status).toBe(true);
    }
  });

  it('ожидание ответа достижимо из любого рабочего состояния', () => {
    for (const status of ['triage', 'design', 'implement']) {
      expect(canTransition(task({ status }), 'awaiting-po').ok, status).toBe(true);
    }
  });

  it('возврат из ожидания ведёт в сохранённое состояние', () => {
    const waiting = task({ status: 'awaiting-po', returnTo: 'design' });
    expect(canTransition(waiting, 'design').ok).toBe(true);
    expect(canTransition(waiting, 'implement').ok).toBe(false);
  });

  it('из ошибки конвейер сам не поднимает, кроме сохранённого состояния', () => {
    const failed = task({ status: 'failed', returnTo: 'implement' });
    expect(canTransition(failed, 'implement').ok).toBe(true);
    expect(canTransition(failed, 'review').ok).toBe(false);
  });

  it('разбор ошибки достижим из любого рабочего состояния', () => {
    for (const status of ['triage', 'design', 'implement', 'benchmark', 'review', 'cleanup']) {
      expect(canTransition(task({ status }), 'postmortem').ok, status).toBe(true);
    }
  });

  it('из разбора ошибки выход только в ошибку', () => {
    // Вход в разбор открыт отовсюду, а выход держится тем, что `postmortem`
    // не объявлен ни в одном маршруте: разрешённым остаётся лишь сквозной
    // переход в `failed`. Поднимает задачу человек, и делает это из ошибки.
    const analysed = task({ status: 'postmortem', returnTo: 'implement' });
    expect(canTransition(analysed, 'failed').ok).toBe(true);
    expect(canTransition(analysed, 'implement').ok).toBe(false);
    expect(canTransition(analysed, 'closed').ok).toBe(false);
  });

  it('разбор разбора не назначается', () => {
    expect(canTransition(task({ status: 'postmortem' }), 'postmortem').ok).toBe(false);
  });

  it('закрытая задача не оживает', () => {
    expect(canTransition(task({ status: 'closed' }), 'design').ok).toBe(false);
  });

  it('из ошибки задачу закрывают, и это объявлено всем трём типам', () => {
    // Ход человека, а не конвейера: задача, потерявшая предмет уже после
    // остановки, прежде оставалась в «Ошибке» навсегда — единственный выход
    // оттуда вёл в упавший этап, то есть в новое падение.
    for (const type of ['feature', 'run', 'note']) {
      expect(canTransition(task({ type, status: 'failed' }), 'closed').ok, type).toBe(true);
    }
  });

  it('закрытие из ошибки не открывает дороги обратно в работу', () => {
    // Объявлен ровно один выход. Возврат в сохранённое состояние остался
    // прежним ходом человека, а любое другое рабочее состояние из «Ошибки»
    // по-прежнему недостижимо.
    const failed = task({ status: 'failed', returnTo: 'implement' });
    expect(canTransition(failed, 'design').ok).toBe(false);
    expect(canTransition(failed, 'cleanup').ok).toBe(false);
    expect(canTransition(failed, 'implement').ok).toBe(true);
  });

  it('закрытая задача не закрывается второй раз и никуда не идёт', () => {
    // Обратная сторона нового маршрута: `failed: ['closed']` объявлен
    // у всех трёх типов, а `closed` остаётся концом пути.
    for (const type of ['feature', 'run', 'note']) {
      const closed = task({ type, status: 'closed', returnTo: 'implement' });
      expect(canTransition(closed, 'closed').ok, type).toBe(false);
      expect(canTransition(closed, 'cleanup').ok, type).toBe(false);
      expect(canTransition(closed, 'implement').ok, type).toBe(false);
    }
  });
});

describe('цена состояния', () => {
  it('проработка и имплементация занимают квоту', () => {
    expect(isResource(task({ status: 'design' }))).toBe(true);
    expect(isResource(task({ status: 'implement' }))).toBe(true);
  });

  it('ожидание проверок квоту не занимает', () => {
    expect(isWaiting(task({ status: 'pr' }))).toBe(true);
    expect(isResource(task({ status: 'pr' }))).toBe(false);
  });

  it('ревью считается отдельной квотой', () => {
    expect(stateClass(task({ status: 'review' }))).toBe('review');
    expect(isResource(task({ status: 'review' }))).toBe(false);
  });

  it('арена считается на чужом железе и машину не занимает', () => {
    const arena = task({ type: 'run', status: 'benchmark', run: { kind: 'arena' } });
    expect(isWaiting(arena)).toBe(true);
    expect(isExclusive(arena)).toBe(false);
  });

  it('замер кадров требует тишины на машине', () => {
    const perf = task({ type: 'run', status: 'benchmark', run: { kind: 'perf' } });
    expect(isExclusive(perf)).toBe(true);
  });

  it('выкладка требует тишины на машине', () => {
    expect(isExclusive(task({ status: 'deploy' }))).toBe(true);
  });
});

/**
 * Непокрытые команды вливания. Мерка и сам перечень переехали в код
 * инструмента (`config/permissions.mjs`): её читает и сканер, а вторая копия
 * разошлась бы с первой молча. Здесь остаётся короткое имя, чтобы пробы
 * на порчу ниже читались прежним образом.
 */
const uncoveredMergeCommands = (permissions) =>
  uncoveredForStage(permissions, 'review', {
    review: STAGE_COMMANDS.review.filter((command) => command.startsWith('gh pr ')),
  });

/**
 * Этапы, чьи команды закрыты ОСОЗНАННО, — с причиной и с тем, чем закрытие
 * снимается.
 *
 * Реестр заведён, когда выкладка с `ssh` была закрыта решением о том, что
 * боевой сервер — дело человека, а сторож без записи покраснел бы сразу
 * и навсегда. 04.09.2026 владелец продукта открыл команды выкладки
 * (задача 0117, пакетная выкладка), и реестр опустел — но остаётся: он
 * краснеет в обе стороны, и следующее осознанное закрытие любого этапа
 * записывается сюда одной строкой, а не выключением сторожа.
 */
const DELIBERATELY_CLOSED = {};

/**
 * Что в скилле этапа считать гейтируемым: программы, чей запуск решают правила
 * разрешений. Объявляется по этапу, а не общим списком, потому что «стерегомое»
 * зависит от того, чем этап занят.
 *
 * У `review` таких программ не объявлено, и это нарочно: его перечень —
 * осознанно короткая выборка допуска CI и вливания. Общий вход review-ci
 * требует отдельного разрешения и сторожится в review-ci-contract.test.mjs;
 * остальные команды скилла не становятся частью выборки автоматически.
 */
const GATED_PROGRAMS = {
  deploy: ['ssh', 'node scripts/deploy-remote.mjs', 'node scripts/deploy.mjs', 'pnpm e2e:perf'],
};

/**
 * Начало команды, по которому её ищут в скилле: доводы отброшены.
 *
 * Доводом здесь считается место-заполнитель (`<хеш>`) и голое число (`1`
 * вместо номера pull request) — ровно то, чем объявленная команда отличается
 * от строки скилла. Всё прочее — `-o BatchMode=yes`, имя хоста, тело в
 * кавычках — часть команды и сверяется дословно: приставки у выкладки две,
 * и обрезать их до `ssh` значило бы потерять ту самую разницу, ради которой
 * перечень и полон.
 */
const skillPrefix = (command) => {
  const words = command.split(' ');
  const argument = words.findIndex((word) => word.startsWith('<') || /^\d+$/.test(word));
  return (argument === -1 ? words : words.slice(0, argument)).join(' ');
};

const skillText = (stage) =>
  readFileSync(fileURLToPath(new URL(`../skills/${stage}.md`, import.meta.url)), 'utf8');

// Проверяем исходный текст: форматтер принимает перенос, который сам ломает отступ.
// Разбор ограничен абзацами прозы, чтобы незамкнутая кавычка не захватила соседний пример.
const multilineCodeSpans = (text) => {
  const found = [];
  let paragraph = [];
  let startLine = 0;
  let fence = null;
  let frontmatter = false;
  const flush = () => {
    const prose = paragraph.join('\n');
    const runs = [...prose.matchAll(/`+/g)];
    for (let i = 0; i < runs.length; i++) {
      const opening = runs[i];
      const slashes = prose.slice(0, opening.index).match(/\\+$/)?.[0].length ?? 0;
      if (slashes % 2) continue;
      const closing = runs.findIndex((run, j) => j > i && run[0] === opening[0]);
      if (closing < 0) continue;
      if (prose.slice(opening.index, runs[closing].index).includes('\n')) {
        found.push(startLine + prose.slice(0, opening.index).split('\n').length - 1);
      }
      i = closing;
    }
    paragraph = [];
  };
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (index === 0 && line === '---') {
      frontmatter = true;
      continue;
    }
    if (frontmatter) {
      if (/^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const marker = line.match(/^\s*(?:[-+*]\s+|[0-9]+[.)]\s+)?(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      flush();
      fence = marker[1];
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (!paragraph.length) startLine = index + 1;
    paragraph.push(line);
  }
  flush();
  return found;
};

const codeSpanRule = (text) =>
  text.match(
    /^- \*\*Вставку кода на другую строку не переносить\.\*\*[^\n]*(?:\n[ \t]+[^\n]+)*/m,
  )?.[0] ?? '';

const missingCodeSpanRule = (text) => {
  const rule = codeSpanRule(text).replace(/\s+/g, ' ');
  return [
    'обратными кавычками',
    'потерю отступа',
    'форматировании',
    'одной физической строке',
    'ограждённый блок',
    'с сохранением вложенности',
  ].filter((mark) => !rule.includes(mark));
};

describe('однострочные вставки кода в скиллах', () => {
  const files = readdirSync(new URL('../skills/', import.meta.url)).filter((name) =>
    name.endsWith('.md'),
  );

  it('все Markdown-файлы каталога соблюдают правило и объясняют его', () => {
    expect(files.length).toBeGreaterThan(0);
    const guilty = files.flatMap((file) => {
      const text = readFileSync(new URL(`../skills/${file}`, import.meta.url), 'utf8');
      return [
        ...multilineCodeSpans(text).map((line) => `${file}:${line}: перенос вставки кода`),
        ...missingCodeSpanRule(text).map((mark) => `${file}: отсутствует правило: ${mark}`),
      ];
    });
    expect(guilty).toEqual([]);
  });

  const broken = [
    '`& "C:\\Program\nFiles\\GitHub CLI\\gh.exe" pr checks 12`',
    '`Get-ChildItem … |\nRemove-Item …`',
    '`## ADDED\n     Requirements`',
    '`произвольная\n  команда`',
    '``внутри ` кавычка\nи продолжение``',
  ];
  for (const [index, sample] of broken.entries()) {
    for (const eol of ['\n', '\r\n']) {
      it(`называет строку образца ${index + 1} при ${JSON.stringify(eol)}`, () => {
        const text = `Введение\n\n- Пример ${sample}\n\nКонец`.replaceAll('\n', eol);
        expect(multilineCodeSpans(text)).toEqual([3]);
        expect(multilineCodeSpans(text.replaceAll(eol, ' '))).toEqual([]);
      });
    }
  }

  it('собирает все нарушения, включая таблицу и разные разделители', () => {
    expect(multilineCodeSpans('- `a\nb` и ``c\nd``\n\n| `e\nf` |')).toEqual([1, 2, 5]);
  });

  it('принимает самостоятельные, длинные, экранированные и незамкнутые вставки', () => {
    const samples = [
      '`первая`\n`вторая`',
      '`' + 'длинная команда '.repeat(30) + '`',
      '\\`буквальная\nкавычка',
      '`не замкнуто\n\n`соседняя вставка`',
      '``одна ` внутри``',
      '---\nname: "`a\nb`"\n---\n`обычная`',
    ];
    for (const sample of samples) expect(multilineCodeSpans(sample), sample).toEqual([]);
    expect(multilineCodeSpans('\\\\`a\nb`')).toEqual([1]);
  });

  it('пропускает ограждения обоих видов, включая вложенные и более длинные', () => {
    for (const marker of ['```', '~~~']) {
      const other = marker[0] === '`' ? '~~~' : '```';
      const text = [
        '- Пункт',
        '',
        `  ${marker}text`,
        '  `a',
        other,
        '  b`',
        marker.slice(1),
        `  ${marker}${marker[0]}`,
        '',
        '`после`',
      ].join('\n');
      expect(multilineCodeSpans(text)).toEqual([]);
      expect(multilineCodeSpans(text + '\n\n`a\nb`')).toEqual([12]);
    }
  });

  it('ловит порчу вставки и удаление правила в копии живого скилла', () => {
    const text = skillText('implement');
    const actual = '`tasks.md`';
    // Выбираем существующую вставку, чтобы контроль не превратился в дописывание образца.
    const at = text.indexOf(actual);
    expect(at).toBeGreaterThanOrEqual(0);
    const damaged =
      text.slice(0, at) + actual.slice(0, -1) + '\n`' + text.slice(at + actual.length);
    expect(multilineCodeSpans(text)).toEqual([]);
    expect(multilineCodeSpans(damaged)).toEqual([text.slice(0, at).split('\n').length]);
    expect(missingCodeSpanRule(text)).toEqual([]);
    const rule = codeSpanRule(text);
    expect(rule).not.toBe('');
    expect(missingCodeSpanRule(text.replace(rule, ''))).toContain('потерю отступа');
  });
});

/**
 * Семья формулировок ложного довода «составную команду не покрывает никакое
 * правило разрешений». Применяется к тексту, нормализованному по пробелам.
 *
 * Флага `g` здесь нет намеренно: с ним `test` таскает за собой `lastIndex`
 * и на втором вызове с той же строкой отвечает иначе, чем на первом.
 */
const FALSE_GROUND =
  /(?:составн[а-яё]*|конвейер[а-яё]*)[^.]{0,200}?не\s+(?:покрыва[а-яё]+|покрыт[а-яё]*|разреша[а-яё]+|разрешить)\s+(?:заранее\s+)?никак[а-яё]+\s+правил[а-яё]+/i;

/**
 * Однострочная формула следа из скилла — абзац после «След объявлен поимённо».
 *
 * Все копии берутся из NEEDS_SESSION и сверяются целым абзацем,
 * а не отдельным словом: слово `pull request` встречается в скиллах и вне
 * формулы, и поиск по всему тексту зеленел бы на разъехавшейся копии.
 */
const traceFormula = (text) =>
  text.replace(/\r\n/g, '\n').match(/След\s+объявлен\s+поимённо:[\s\S]*?(?=\n\s*\n|$)/)?.[0] ??
  null;

// Это перевод имён, а не второй перечень коммитящих этапов: типы и состав
// определяет TRACE. Неизвестное имя ищется буквально и потому не пропускается.
const traceStageNames = {
  design: /проработк[а-яё]*/i,
  revise: /доработк[а-яё]*/i,
  implement: /имплементаци[а-яё]*/i,
};

function traceFormulaProblems(text, traces = TRACE) {
  const raw = traceFormula(text);
  if (!raw) return ['формулы следа нет вовсе'];
  const formula = raw.replace(/\s+/g, ' ').toLowerCase();
  const clauses = [...formula.matchAll(/([^:;.!?]+?)\s+[—–-]\s+([^;.!?]+)/g)];
  const branch = formula.match(/для обеих половин[^.!?]+/)?.[0] ?? '';
  const problems = [];
  for (const [stage, kind] of Object.entries(traces)) {
    if (kind !== 'commit' && kind !== 'commit-or-pr') continue;
    const namesStage = (part) =>
      traceStageNames[stage]?.test(part) ?? part.split(/[\s,]+/).includes(stage);
    const clause = clauses.find(([, names]) => namesStage(names))?.[2] ?? '';
    const checkCondition = (ok, why) => {
      if (!ok) problems.push(`${stage}: ${why}`);
    };
    checkCondition(/свой коммит/.test(clause), 'собственный коммит не назван');
    checkCondition(/не раньше начала этапа/.test(clause), 'свежесть коммита не названа');
    checkCondition(
      namesStage(branch) &&
        /ветка задачи обязана быть у удалённого репозитория/.test(branch) &&
        /не иметь неотправленных коммитов/.test(branch),
      'удалённая ветка без хвоста не обязательна для обеих половин',
    );
    if (kind === 'commit-or-pr') {
      checkCondition(
        /либо впервые открытый pull request/.test(clause),
        'альтернатива первого PR не названа',
      );
    } else {
      checkCondition(!/pull request/.test(clause), 'PR не заменяет коммит этого этапа');
    }
  }
  if (!/до начала этапа[^;.!?]*коммитную половину не закрывают/.test(formula)) {
    problems.push('прежние коммиты не исключены');
  }
  if (!/ранее известный задаче pull request новым следом не считается/.test(formula)) {
    problems.push('ранее известный PR не исключён');
  }
  return problems;
}

// Перечень сессий — вход проверки: новая копия без формулы должна дать
// ошибку с именем файла, а не исчезнуть при предварительной фильтрации.
const skillTraceProblems = (stages, readSkill, traces = TRACE) =>
  stages.flatMap((stage) =>
    traceFormulaProblems(readSkill(stage), traces).map((why) => `${stage}.md: ${why}`),
  );

describe('сторож свежести формулы следа', () => {
  // Самостоятельный образец не читает скилл: порча живого файла не должна
  // одновременно менять и проверяемый текст, и ожидаемую норму.
  const correct = [
    'След объявлен поимённо:',
    'проработке и доработке — свой коммит, сделанный не раньше начала этапа;',
    'имплементации — свой коммит, сделанный не раньше начала этапа, ЛИБО впервые открытый pull request.',
    'Для обеих половин следа имплементации, как и для проработки и доработки,',
    'ветка задачи обязана быть у удалённого репозитория и не иметь неотправленных коммитов.',
    'Коммиты, лежавшие в ветке до начала этапа, коммитную половину не закрывают;',
    'ранее известный задаче pull request новым следом не считается.',
  ].join('\n');
  const staleImplement = (text) =>
    text.replace(
      'имплементации — свой коммит, сделанный не раньше начала этапа',
      'имплементации — свой коммит',
    );

  it.each([
    correct,
    correct.replaceAll(' ', '\n   ').replaceAll('\n', '\r\n'),
    correct.replaceAll(',', '').replaceAll('—', '–'),
  ])('принимает корректный текст, переносы и пунктуацию: %#', (text) => {
    expect(traceFormulaProblems(text)).toEqual([]);
  });

  it.each([
    ['свежесть только implement', staleImplement(correct), 'implement: свежесть'],
    [
      'первый PR',
      correct.replace('ЛИБО впервые открытый pull request', ''),
      'implement: альтернатива',
    ],
    [
      'новизна PR',
      correct.replace('ЛИБО впервые открытый', 'ЛИБО открытый'),
      'implement: альтернатива',
    ],
    [
      'альтернатива вместо обязательного PR',
      correct.replace('ЛИБО впервые', 'И впервые'),
      'implement: альтернатива',
    ],
    [
      'удалённая ветка',
      correct.replace('быть у удалённого репозитория', 'существовать'),
      'implement: удалённая ветка',
    ],
    [
      'хвост',
      correct.replace('не иметь неотправленных коммитов', 'иметь коммиты'),
      'implement: удалённая ветка',
    ],
    [
      'обе половины',
      correct.replace('Для обеих половин', 'Для коммитной половины'),
      'implement: удалённая ветка',
    ],
    [
      'свежесть design/revise',
      correct.replace('не раньше начала этапа', 'сегодня'),
      'design: свежесть',
    ],
    ['свой коммит', correct.replaceAll('свой коммит', 'коммит'), 'implement: собственный'],
    [
      'старые коммиты',
      correct.replace('коммитную половину не закрывают', 'коммитную половину закрывают'),
      'прежние коммиты',
    ],
    [
      'известный PR',
      correct.replace('новым следом не считается', 'новым следом считается'),
      'ранее известный PR',
    ],
    [
      'PR у design/revise',
      correct.replace('начала этапа;', 'начала этапа ЛИБО впервые открытый pull request;'),
      'design: PR не заменяет',
    ],
  ])('обнаруживает потерю условия: %s', (_name, text, problem) => {
    expect(traceFormulaProblems(text)).toEqual(
      expect.arrayContaining([expect.stringContaining(problem)]),
    );
  });

  it('свежесть за пределами формулы не закрывает пропуск внутри', () => {
    const text = `${staleImplement(correct)}\n\nимплементации — свой коммит, сделанный не раньше начала этапа`;
    expect(traceFormulaProblems(text)).toContain('implement: свежесть коммита не названа');
  });

  it.each(['commit', 'commit-or-pr'])('новый тип %s требует правил для нового этапа', (kind) => {
    const problems = traceFormulaProblems(correct, { ...TRACE, future: kind });
    expect(problems).toContain('future: свежесть коммита не названа');
    if (kind === 'commit-or-pr') {
      expect(problems).toContain('future: альтернатива первого PR не названа');
    }
  });

  it('полный обход называет порчу только decompose.md', () => {
    const texts = Object.fromEntries(NEEDS_SESSION.map((stage) => [stage, correct]));
    expect(skillTraceProblems(NEEDS_SESSION, (stage) => texts[stage])).toEqual([]);
    expect(NEEDS_SESSION).toContain('decompose');
    texts.decompose = staleImplement(correct);
    expect(skillTraceProblems(NEEDS_SESSION, (stage) => texts[stage])).toEqual([
      'decompose.md: implement: свежесть коммита не названа',
    ]);
  });

  it.each(['без формулы', staleImplement(correct)])(
    'новый скилл не выпадает из обхода: %#',
    (text) => {
      const stages = [...NEEDS_SESSION, 'future'];
      const problems = skillTraceProblems(stages, (stage) => (stage === 'future' ? text : correct));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^future\.md:/);
    },
  );
});

describe('этапы и скиллы', () => {
  it('всякому ресурсному состоянию положена сессия', () => {
    // Состояние, объявленное ресурсным, но забытое в NEEDS_SESSION, тратит
    // место в квоте и НЕ получает сессии никогда: сканер выдаёт её только
    // по этому перечню. Задача встаёт в колонке навсегда и молча — ни отказа,
    // ни записи в журнал, ни строки в консоли.
    //
    // Щель найдена пробой при заведении этапа декомпозиции: снятие состояния
    // из перечня не покраснило ни одного теста.
    const resource = STATES.filter((state) => STATE_CLASS[state] === 'resource');
    const forgotten = resource.filter((state) => !NEEDS_SESSION.includes(state));
    expect(forgotten).toEqual([]);
  });

  it('у каждого этапа с сессией есть скилл', () => {
    // Сессия-исполнитель читает указания своего этапа из
    // `skills/<этап>.md` и без них не знает, что делать. Расхождение
    // скиллов с кодом — самая частая беда этого конвейера: этап,
    // объявленный в таблице, но не описанный, обнаружится только тогда,
    // когда задача до него дойдёт, — то есть в проде и молча.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const missing = NEEDS_SESSION.filter((stage) => !existsSync(`${dir}${stage}.md`));
    expect(missing).toEqual([]);
  });

  it('ни один скилл не посылает исполнителя за слотом или отчётом на диск', () => {
    // Слоты и каталог отчётов удалены вместе с прежним устройством: работа
    // приходит промптом, отчёт возвращается сообщением. Забытое упоминание
    // страшнее мёртвой ссылки — сессия честно пойдёт искать файл, не найдёт
    // и решит, что назначения нет. Такое уже было с выпиской задачи после
    // переезда бэклога на доску: файл остался на месте, но устарел, и сессия
    // читала позавчерашнюю картину молча.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      const text = readFileSync(`${dir}${stage}.md`, 'utf8');
      for (const banned of ['.pipeline/slots', '.pipeline/reports', 'set_session_title']) {
        if (text.includes(banned)) guilty.push(`${stage}.md: ${banned}`);
      }
    }
    expect(guilty).toEqual([]);
  });

  it('ни один скилл не показывает коммит многострочной строкой', () => {
    // Переводы строк внутри команды разбор разрешений видит как несколько
    // команд: приставке `git commit` отвечает только первая, остальные —
    // строки самого сообщения — отказываются. Коммит при этом не ложится,
    // а без коммита у коммитящего этапа нет следа — и отчёт не применяется.
    //
    // Пример в скилле здесь опаснее умолчания: 31.08.2026 задача 0011
    // дважды сделала работу и дважды лишилась отчёта, набирая тело коммита
    // через `@'` … `'@` — форму, которую предписывают общие указания
    // по PowerShell. Скилл этапа обязан её перебить.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      const text = readFileSync(`${dir}${stage}.md`, 'utf8');
      if (/git\s[^\n]*commit[^\n]*-m\s+@'/.test(text)) guilty.push(`${stage}.md`);
    }
    expect(guilty).toEqual([]);
  });

  it('правила разрешений не пишутся в форме, которая молча не работает', () => {
    // Хвост правила — `путь/*`, а не `путь/:*`. Форма с двоеточием внутри
    // пути не совпадает ни с чем, и правило просто не срабатывает: задача
    // 0016 получила четыре отказа подряд при стоявшем `Bash(node .matchlog/:*)`
    // и прошла без единого, едва форму заменили. Двоеточие остаётся верным
    // там, где отделяет команду от любых аргументов (`gh pr:*`).
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    const rules = [...settings.permissions.allow, ...settings.permissions.deny];
    expect(rules.filter((rule) => /\/:\*\)/.test(rule))).toEqual([]);
  });

  it('служебный каталог конвейера открыт чтением, и не мнимой формой', () => {
    // Этап живёт в своём дереве, а реестр деревьев — в `.pipeline` основного,
    // то есть вне его рабочего каталога. Список `allow` этой границы не двигает:
    // проба 01.09.2026 показала, что с `Read(.pipeline/**)` отказ повторяется
    // слово в слово, а с `additionalDirectories` его нет вовсе. Цена вопроса
    // измерена — четыре этапа аудита подряд встали на одном и том же файле.
    //
    // Путей два, и оба нужны: относительный считается от рабочего каталога,
    // а он у этапов разный — корень у безместных, дерево тремя уровнями ниже
    // у прочих.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    expect(settings.permissions.additionalDirectories).toContain('.pipeline');
    expect(settings.permissions.additionalDirectories).toContain('../../../.pipeline');

    const rules = [...settings.permissions.allow, ...settings.permissions.deny];
    expect(rules.filter((rule) => /^Read\(\.pipeline/.test(rule))).toEqual([]);
  });

  it('удаление файлов правилами не выписывается: оно всё равно не пройдёт', () => {
    // Проверено 31.08.2026 тремя пробами: с шаблоном, без перекрывающего
    // запрета и с точным совпадением команды — отказ во всех трёх. Правило
    // на удаление создаёт вид надёжности, а запрет вида `.matchlog/*` вдобавок
    // перекрывает собственные разрешения и отнимает у этапа отчёт.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    const rules = [...settings.permissions.allow, ...settings.permissions.deny];
    expect(rules.filter((rule) => /Remove-Item|rm -rf/.test(rule))).toEqual([]);
  });

  it('перечень сценариев открыт точной формой, а не с любым доводом', () => {
    // Разница между `pnpm run` и `pnpm run:*` — один символ, а последствие
    // разное. Без доводов команда печатает перечень сценариев и не исполняет
    // ничего; хвост `:*` означает «с любыми доводами», а довод здесь — имя
    // сценария. Широкая форма открыла бы разом `pnpm run verify`,
    // `pnpm run test:match`, `pnpm run balance:run` и `pnpm run deploy` —
    // то, что правила 6 и 8 проекта закрыли осознанно.
    //
    // Сторож нужен потому, что расширение стоит одного символа, а заметят
    // его не раньше, чем этап что-нибудь выложит на боевой сервер.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    const rules = [...settings.permissions.allow, ...settings.permissions.deny];

    expect(rules.filter((rule) => /\(pnpm run[\s:]/.test(rule))).toEqual([]);
    for (const shell of ['Bash', 'PowerShell']) {
      expect(settings.permissions.allow).toContain(`${shell}(pnpm run)`);
    }
  });

  it('подъём и снятие конвейера закрыты в обеих оболочках', () => {
    // Запрет живёт не ради сегодняшнего дня — сегодня ни одно разрешение
    // с этими формами не совпадает. Он ради того дня, когда правило расширят
    // до `node supervisor/bin/*`, как просит заголовок задачи 0130.
    //
    // Опаснее подъёма здесь `--stop`: пускатель снимает поддерево процессов,
    // а этап — потомок супервизора, то есть снимает себя на полуслове.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    const forms = ['supervise.mjs', 'launch.mjs --stop', 'launch.mjs --shadow'];
    const missing = [];
    for (const form of forms) {
      for (const shell of ['Bash', 'PowerShell']) {
        const rule = `${shell}(node supervisor/bin/${form}:*)`;
        if (!settings.permissions.deny.includes(rule)) missing.push(rule);
      }
    }
    expect(missing).toEqual([]);
  });

  it('команды вливания покрыты правилами в обеих оболочках', () => {
    // Ревью доводит изменение до `main` тремя командами, и отказ на любой
    // из них случается там, где человека рядом нет. 03.09.2026 задача 0130
    // встала на `gh pr merge`, отбитом черновым статусом; лечение потребовало
    // `gh pr ready`, которую скилл не называл, а правила покрывали попутно —
    // широким `gh pr:*`.
    //
    // Попутное покрытие теряется молча: сузив `gh pr:*` до перечня подкоманд,
    // автор правки не узнает, что вывел `gh pr ready` из-под разрешений.
    // Узнает об этом ревью — отказом посреди вливания.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    expect(uncoveredMergeCommands(settings.permissions)).toEqual([]);
  });

  it('сужение широкого правила выводит команду из-под разрешений заметно', () => {
    // Проба на порчу, прогоняемая набором, а не руками: сторож, который
    // не краснеет на сломанной настройке, — украшение. Правило сужено до
    // `gh pr merge:*`, и `gh pr ready` обязана числиться непокрытой.
    const narrowed = {
      allow: ['Bash(gh pr merge:*)', 'PowerShell(gh pr merge:*)'],
      deny: [],
    };
    expect(uncoveredMergeCommands(narrowed)).toContain('Bash: gh pr ready 1');
    expect(uncoveredMergeCommands(narrowed)).toContain('PowerShell: gh pr ready 1');
  });

  it('запрет, совпавший с приставкой разрешения, считается непокрытием', () => {
    // Разрешение при перекрывающем запрете не работает, а выглядит рабочим.
    // Так `.matchlog/*` перекрывал уборку собственного подкаталога и отнимал
    // у этапа прогона отчёт.
    const shadowed = {
      allow: ['Bash(gh pr:*)', 'PowerShell(gh pr:*)'],
      deny: ['Bash(gh pr ready:*)'],
    };
    expect(uncoveredMergeCommands(shadowed)).toEqual(['Bash: gh pr ready 1']);
  });

  it('сужение до точных правил без хвоста выводит из-под разрешений все три команды', () => {
    // Третья проба на порчу — и единственная, задевающая точную форму: обе
    // соседние сужают правило хвостом `:*`, то есть остаются приставочными.
    //
    // Правила без хвоста среда толкует точным совпадением команды, а у всех
    // трёх команд вливания есть доводы — номер pull request и ключи. Значит
    // такая настройка отказывает каждой из них, и сторож обязан назвать все
    // шесть: три команды на две оболочки. Ровно этой настройки сторож
    // и не ловил, пока хвост отбрасывался безусловно.
    const exactly = {
      allow: [
        'Bash(gh pr view)',
        'Bash(gh pr ready)',
        'Bash(gh pr merge)',
        'PowerShell(gh pr view)',
        'PowerShell(gh pr ready)',
        'PowerShell(gh pr merge)',
      ],
      deny: [],
    };
    // Длина, а не вхождение одной строки: список из пяти означал бы, что одна
    // оболочка прочтена иначе, — а такую разницу надо видеть, а не проглядеть.
    expect(uncoveredMergeCommands(exactly)).toHaveLength(6);
  });

  it('запрет точной формы, дословно равный команде, гасит её разрешение', () => {
    // Три пробы выше задевают точную форму только в `allow`, а мерка объявлена
    // общей для обоих списков. Пока запреты ничем не проверены, утверждение
    // «запреты меряются той же меркой, а не строже» держится на честном слове.
    //
    // Здесь тело запрета совпадает с командой вливания дословно: среда её
    // отобьёт, значит и сторож обязан назвать её непокрытой, невзирая
    // на широкое разрешение рядом.
    const deniedExactly = {
      allow: ['Bash(gh pr:*)', 'PowerShell(gh pr:*)'],
      deny: ['Bash(gh pr ready 1)'],
    };
    // Одна строка, а не две: правило `Bash(...)` о правах в PowerShell
    // не говорит ничего, и та же команда под другой оболочкой остаётся покрытой.
    expect(uncoveredMergeCommands(deniedExactly)).toEqual(['Bash: gh pr ready 1']);
  });

  it('команды каждого этапа покрыты правилами либо этап числится закрытым', () => {
    // Сторож стоит по обе стороны от одной развилки. Слева — регресс: правило
    // сузили, покрытие потерялось, и заметить это можно было бы только отказом
    // посреди работы. Справа — устаревшая запись: команды открыли, а сканер
    // по-прежнему держит задачи этапа, и починка голодает позади них.
    //
    // Реестр не способ замолчать беду: запись обязана называть причину
    // закрытия и то, чем оно снимается. Сегодня закрытых этапов ровно один.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );

    const lost = [];
    const stale = [];
    for (const stage of Object.keys(STAGE_COMMANDS)) {
      const uncovered = uncoveredForStage(settings.permissions, stage);
      if (uncovered.length > 0 && !(stage in DELIBERATELY_CLOSED)) lost.push(...uncovered);
      if (uncovered.length === 0 && stage in DELIBERATELY_CLOSED) stale.push(stage);
    }

    expect(lost).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('шаблон разрешений открывает выкладку целиком, и закрытой она не числится', () => {
    // Команды выкладки открыты решением владельца продукта 04.09.2026
    // (задача 0117): конвейер выкладывает сам, пакетом. Запись о закрытом
    // этапе при этом снята — оставь её, и сторож «закрытый этап действительно
    // не покрыт» покраснел бы, назвав запись устаревшей.
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
    );
    expect(uncoveredForStage(settings.permissions, 'deploy')).toEqual([]);
    expect('deploy' in DELIBERATELY_CLOSED).toBe(false);
  });

  it('выдуманная настройка с открытыми командами выкладки не держит ничего', () => {
    // Проба на выдуманной настройке, а не на шаблоне: сторож покрытия
    // считает по правилам, а не по имени файла.
    const opened = {
      allow: [
        'Bash(node scripts/deploy-remote.mjs:*)',
        'PowerShell(node scripts/deploy-remote.mjs:*)',
        'Bash(node scripts/deploy.mjs:*)',
        'PowerShell(node scripts/deploy.mjs:*)',
        'Bash(node scripts/ensure-deploy-host.mjs:*)',
        'PowerShell(node scripts/ensure-deploy-host.mjs:*)',
        'Bash(pnpm e2e:perf:*)',
        'PowerShell(pnpm e2e:perf:*)',
      ],
      deny: [],
    };
    expect(uncoveredForStage(opened, 'deploy')).toEqual([]);
  });

  it('частичные разрешения удалённых проверок не открывают весь этап', () => {
    const checks = STAGE_COMMANDS.deploy.slice(0, 3);
    const halfOpen = {
      allow: [
        ...checks.flatMap((command) => [`Bash(${command})`, `PowerShell(${command})`]),
        'Bash(node scripts/deploy.mjs:*)',
        'PowerShell(node scripts/deploy.mjs:*)',
        'Bash(node scripts/ensure-deploy-host.mjs:*)',
        'PowerShell(node scripts/ensure-deploy-host.mjs:*)',
        'Bash(pnpm e2e:perf:*)',
        'PowerShell(pnpm e2e:perf:*)',
      ],
      deny: [],
    };
    const step7 = STAGE_COMMANDS.deploy[3];
    expect(uncoveredForStage(halfOpen, 'deploy')).toEqual([
      `Bash: ${step7}`,
      `PowerShell: ${step7}`,
    ]);
  });

  it('каждая объявленная команда этапа встречается в его скилле', () => {
    // Прямая сверка. Без неё скилл поменяет команду, сторож продолжит сверять
    // прежнюю строку и зеленеть на настройке, которой в действительности
    // не соответствует ничего, — то есть станет украшением.
    const stray = [];
    for (const [stage, commands] of Object.entries(STAGE_COMMANDS)) {
      const text = skillText(stage);
      for (const command of commands) {
        if (!text.includes(skillPrefix(command))) stray.push(`${stage}.md: ${command}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it('каждая гейтируемая строка скилла объявлена в перечне команд этапа', () => {
    // Обратная сверка, и она ловит сегодняшнюю беду: скилл прирастёт шестой
    // `ssh`-строкой с новой приставкой, перечень останется впятером, сторож
    // промолчит — а этап умрёт посреди выкладки молчаливым отказом.
    //
    // Стерегомой считается строка скилла, НАЧИНАЮЩАЯСЯ с объявленной
    // программы: так в счёт идут вызовы из блоков кода, а упоминания в прозе
    // («`ssh` вызывай только с `-o BatchMode=yes`») — нет.
    const unclaimed = [];
    for (const [stage, programs] of Object.entries(GATED_PROGRAMS)) {
      const prefixes = STAGE_COMMANDS[stage].map(skillPrefix);
      const called = new RegExp(
        `^\\s*(${programs.map((name) => name.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\s|$)`,
      );
      for (const line of skillText(stage).split('\n')) {
        const call = line.trim();
        if (!called.test(call)) continue;
        if (!prefixes.some((prefix) => call.startsWith(prefix))) {
          unclaimed.push(`${stage}.md: ${call}`);
        }
      }
    }
    expect(unclaimed).toEqual([]);
  });

  it('запрет точной формы, короче команды, её разрешения не гасит', () => {
    // Единственная проба, краснеющая на возврате приставочной мерки для
    // запретов: тело `gh pr merge` лишь начинает `gh pr merge 1 --merge`,
    // и прежний безусловный разбор счёл бы команду запрещённой.
    //
    // Ложная тревога здесь дороже молчания. Сторож, объявивший непокрытой
    // команду, которую среда пропускает, лечится единственным доступным
    // способом — ослаблением настройки ради успокоения теста.
    const denyShorter = {
      allow: ['Bash(gh pr:*)', 'PowerShell(gh pr:*)'],
      deny: ['Bash(gh pr merge)'],
    };
    expect(uncoveredMergeCommands(denyShorter)).toEqual([]);
  });

  it('этапы, подающие заявки, знают признак причины в конвейере', () => {
    // Заявка с `area: "pipeline"` минует кандидатов с любого этапа. Скилл,
    // не знающий признака, заведёт починку конвейера кандидатом — и она
    // будет ждать человека, пока та же причина роняет следующие задачи;
    // 02.09.2026 так простояли четыре починки.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const requesting = [
      'design',
      'audit',
      'implement',
      'revise',
      'review',
      'interpret',
      'triage',
      'postmortem',
    ];
    const silent = requesting.filter(
      (stage) => !readFileSync(`${dir}${stage}.md`, 'utf8').includes('`area: "pipeline"`'),
    );
    expect(silent).toEqual([]);
  });

  it('разбор и анализ знают правило дробления одной меркой', () => {
    // Мерка обязана быть одна на оба этапа и проверяемая, а не «на глаз»:
    // «большой задачу» две сессии подряд назовут по-разному. Расхождение
    // здесь дорого — 04.09.2026 задача 0216 расползлась с проработки
    // на имплементацию и после шести кругов и $76,01 не влила ни строки.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const splitting = ['triage', 'decompose'];
    const silent = splitting.filter((stage) => {
      const text = readFileSync(`${dir}${stage}.md`, 'utf8');
      return !text.includes('вливать порознь') && !text.includes('влить отдельным pull request');
    });
    expect(silent).toEqual([]);

    // Анализ обязан назвать и ход: заявки плюс исход `split`. Правило
    // без хода — пожелание, а не правило.
    const decompose = readFileSync(`${dir}decompose.md`, 'utf8');
    expect(decompose).toContain('`split`');
    expect(decompose).toContain('не меньше двух');
  });

  it('анализ знает случай упора в потолок и не решает его сам', () => {
    // Повторный анализ, признавший работу неделимой, обязан звать владельца:
    // поднять потолок или остановить — это про цену работы против её
    // ценности, и из кода такое не выводится. Скилл, не знающий этого случая,
    // отправит задачу в проработку по второму кругу за те же деньги.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const text = readFileSync(`${dir}decompose.md`, 'utf8');
    expect(text).toContain('потолок');
    expect(text).toContain('`question`');
  });

  it('скилл разбора требует вердикт о причине и объясняет fixedBy', () => {
    // По `causedBy` супервизор решает, возвращать ли задачу из ошибки сам.
    // Отчёт без него применяется как «причина в задаче» — то есть разбор,
    // не знающий поля, вернул бы конвейер к подъёму задач человеком молча.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const text = readFileSync(`${dir}postmortem.md`, 'utf8');
    expect(text).toContain('`causedBy`');
    expect(text).toContain('`fixedBy`');
    expect(text).toContain('"causedBy": "pipeline"');
    expect(text).toContain('"causedBy": "task"');
  });

  it('скилл прогона называет разрешённое ожидание и не показывает циклов', () => {
    // Ждать чужой прогон этапу надо всегда, а разрешённая форма ровно одна —
    // `gh run watch <id> --exit-status`. Не назови её скилл — сессия придумает
    // своё: за вечер 31.08.2026 придумались цикл на `while`, цикл на `for`
    // с `seq` и фоновая задача с чтением файла вывода. Все три получили отказ,
    // и все три оставили этап без ответа о прогоне — то есть без его номера,
    // а номер и есть след замера. Отчёт без следа не применяется, и замер
    // по пять долларов и четыре минуты чужого железа пропадает целиком.
    //
    // Пример опаснее умолчания: показанный в скилле цикл сессия перепишет
    // буквально. Поэтому запрет здесь сформулирован без образцов кода,
    // а сторож ловит именно образцы.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const text = readFileSync(`${dir}benchmark.md`, 'utf8');
    expect(text).toContain('gh run watch <id> --exit-status');
    expect(text.match(/while \(|for i in/g) ?? []).toEqual([]);
  });

  it('этапы, которые коммитят, называют повторный -m прямо', () => {
    // Запрет без замены не работает: тело коммита требуется правилами
    // проекта, и, лишившись одного способа, сессия придумает свой.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const silent = ['design', 'implement', 'revise'].filter((stage) => {
      const text = readFileSync(`${dir}${stage}.md`, 'utf8');
      return !text.includes('повторными `-m`');
    });
    expect(silent).toEqual([]);
  });

  it('все копии формулы согласованы с типами следа и свежестью из TRACE', () => {
    expect(skillTraceProblems(NEEDS_SESSION, skillText)).toEqual([]);
  });

  it('скилл проработки называет каждый исход отчёта и обязательное доказательство', () => {
    // Исход, которого скилл не называет, для сессии не существует: она читает
    // свой файл, а не код супервизора. Задача с доказанно снятым предметом
    // при таком умолчании пойдёт прежним путём — либо в изменение ни о чём,
    // либо в ложную «Ошибку», — то есть ровно туда, откуда её этот ход
    // и выводит.
    //
    // Перечень берётся из кода, а не переписывается сюда списком: вторая
    // копия разошлась бы с первой молча, и сторож зеленел бы на скилле,
    // не знающем нового исхода.
    //
    // Слово `evidence` сверяется отдельно от исходов: без него `moot`
    // остаётся объявленным, но неисполнимым — отчёт без доказательства
    // не применяется вовсе, и заход пропадает целиком.
    const text = skillText('design');
    const missing = [...OUTCOMES, 'evidence'].filter((mark) => !text.includes(`\`${mark}\``));
    expect(missing.map((mark) => `design.md: ${mark}`)).toEqual([]);
  });

  it('скилл проработки называет случай, когда дельты не будет', () => {
    // Задача, не меняющая ни одного требования, законна, и валидатор такое
    // изменение отвергает — а сессия, не знающая об этом случае, лечит
    // красноту единственным доступным ей способом: пишет требование ради
    // прохождения проверки. Оно уезжает в `openspec/specs/` навсегда, где
    // читается как норма, которой никто не заказывал. Так задача 0165
    // получила требование на сорок три строки о примечании в файле настроек
    // при постановке, прямо говорившей «дельту заводить не нужно».
    //
    // Сторож требует именно заголовок раздела: он же и есть то, что аудит
    // ищет в предложении, — а признак без места, куда его писать, сессия
    // исполнить не сможет.
    expect(skillText('design')).toContain('## Почему дельты нет');
  });

  it('ни один скилл не гоняет валидатор по всем изменениям разом', () => {
    // `openspec validate --changes` проверяет все тридцать восемь открытых
    // изменений сразу. Чинить чужие поломки этапу запрещено, значит польза
    // от такого прогона одна — назвать их в отчёте; а цена появилась вместе
    // с законно бездельтовым изменением: одно такое делает общий прогон
    // красным у ВСЕХ сессий, и красноту эту никто из них снять не вправе.
    // Дальше сессия либо встаёт, либо привыкает не смотреть на валидатор —
    // и оба исхода хуже, чем непойманная чужая поломка, которую поймает
    // аудит того самого изменения.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const guilty = NEEDS_SESSION.filter((stage) =>
      readFileSync(`${dir}${stage}.md`, 'utf8').includes('openspec validate --changes'),
    );
    expect(guilty).toEqual([]);
  });

  // Проверяем саму норму между границами, а не случайную цитату в примере.
  // Это сторож инструкций, не парсер CLI: смысловые случаи разобраны
  // отдельно в verification.md изменения recognize-deltaless-diagnostics.
  const deltalessStart = '**Исключение для отсутствия дельт.**';
  const deltalessEnd = '**Конец исключения.**';
  const deltalessClauses = [
    'ровно одна ошибка.',
    'сообщение ошибки должно начинаться с `Change must have at least one delta. No deltas found.`.',
    'Дословного совпадения всего сообщения или всего вывода не требуй.',
    'Продолжение `Ensure your change…`, подсказка `Tip: run…`, заголовок результата и раздел `Next steps` с рекомендациями допустимы как штатные пояснения CLI и сами по себе дополнительными ошибками не являются.',
    'Другая или дополнительная ошибка исключением не покрывается, в том числе после `Next steps`: просматривай вывод до конца.',
    'Цитата только в подсказке вместо начала сообщения ошибки не подходит.',
    'каталог `specs/` отсутствует (даже пустой каталог исключает этот случай)',
    'в `proposal.md` есть раздел `## Почему дельты нет`',
    'обоснование проверено по существу по списку задач, основным требованиям и открытым дельтам: ни одно требование не меняет прочтения.',
    'Отсутствующий или пустой раздел, непроверенное либо опровергнутое обоснование не допускают исключения.',
    'Проработка обосновывает отсутствие дельты, аудит независимо сверяет обоснование; одного заголовка недостаточно.',
  ];
  const normalizeRule = (text) => text.replace(/\s+/g, ' ').trim();
  function deltalessProblems(text) {
    const normalized = normalizeRule(text);
    const start = normalized.indexOf(deltalessStart);
    const end = normalized.indexOf(deltalessEnd, start);
    if (start < 0 || end < 0) return ['границы исключения'];
    const rule = normalized.slice(start, end);
    const missing = deltalessClauses.filter((clause) => !rule.includes(clause));
    if (/любая другая строка вывода/i.test(rule)) missing.push('запрет штатных пояснений');
    return missing;
  }

  describe.each(['design', 'audit'])('диагностика без дельт: %s', (stage) => {
    it('сохраняет все условия исключения в самом правиле', () => {
      expect(deltalessProblems(skillText(stage))).toEqual([]);
    });

    it.each(deltalessClauses)('обнаруживает удаление условия: %s', (clause) => {
      const original = normalizeRule(skillText(stage));
      expect(deltalessProblems(original)).toEqual([]);
      const mutant = original.replace(clause, '');
      expect(mutant).not.toBe(original);
      // Копия исходной нормы за границей исключения не должна спасать мутацию.
      expect(deltalessProblems(mutant + '\n' + original)).toContain(clause);
    });

    it('обнаруживает возврат запрета любой дополнительной строки', () => {
      const original = skillText(stage);
      expect(deltalessProblems(original)).toEqual([]);
      const mutant = original.replace(
        deltalessEnd,
        'Любая другая строка вывода бедой быть не перестаёт. ' + deltalessEnd,
      );
      expect(deltalessProblems(mutant)).toContain('запрет штатных пояснений');
    });

    it.each([deltalessStart, deltalessEnd])('обнаруживает потерю границы %s', (mark) => {
      expect(deltalessProblems(skillText(stage).replace(mark, ''))).toEqual(['границы исключения']);
    });
  });

  it('этапы, освежающие базу, подтягивают свежую главную ветку', () => {
    // Дерево задачи заводится при захвате и больше не обновляется, поэтому
    // проверка пересечений идёт на базе тех суток. Каталога чужого изменения,
    // влитого позже, в дереве нет вовсе, и пропуск выглядит как чистая
    // проверка: 04.09.2026 задача 0190 пришла на аудит с деревом на пять
    // коммитов позади и не увидела write-covered-commands-in-tasks.
    //
    // У пишущих код этапов цена та же, но платится позже: код пишется
    // не в ту базу, в которую поедет, и расхождение всплывает конфликтом
    // у ревью — когда правка уже написана и проверена.
    //
    // Заголовок нарочно не называет этапов поимённо: перечень живёт
    // в массиве ниже, и заголовок, повторяющий его своими словами,
    // разъезжается с ним при первом же расширении, а vitest печатает
    // именно заголовок.
    //
    // Мерка — строка целиком, вместе с ключом `-C`. Обрезать её до слова
    // `merge` нельзя: в скилле проработки оно уже стоит шагом 10, разбором
    // голой формы, и сторож по одному слову зеленел бы при полностью
    // пропавшем правиле.
    //
    // Выкладки в перечне нет по существу, а не по недосмотру. Её освежение
    // служит другой цели: дерево обязано СОВПАДАТЬ с ревизией, которая уедет
    // ключом `--ref`, потому что замер поднимает клиент и сервер из дерева,
    // а файлы сборки дописываются в архив тоже из дерева. Свежесть базы там
    // не цель, а средство, и стоит освежение своим порядком и своей формой.
    // Стережёт его собственная проверка — «выкладка приводит дерево
    // к выкладываемой ревизии» в этом же файле.
    //
    // Дописать `deploy` сюда пятым охраной НЕ станет, и это главное, ради
    // чего абзац написан. Запасная форма шага 6 `deploy.md` записана дословно
    // той же строкой, какую мерит этот сторож, поэтому дописывание зеленеет
    // немедленно — без единой правки скилла — и стережёт одну треть шага:
    // основная перемотка и проверка `diff --stat` остаются открытыми.
    const guilty = ['design', 'audit', 'implement', 'revise'].filter(
      (stage) => !skillText(stage).includes('git -C <дерево> merge origin/main'),
    );
    expect(guilty.map((stage) => `${stage}.md: git -C <дерево> merge origin/main`)).toEqual([]);
  });

  describe('подготовка implement по открытому PR', () => {
    // Проверяется инструкция, которую читает исполнитель, а не отдельная модель
    // решений. Области разделены: слова из соседнего шага не спасают потерю нормы.
    const heading = '**Подготовка по открытому PR.**';
    const parts = (text) => {
      const step =
        text.match(
          /^[0-9]+\. \*\*Подтяни в дерево свежую главную ветку[^\n]*\n[\s\S]*?(?=^[0-9]+\. |^## |$(?![\s\S]))/m,
        )?.[0] ?? '';
      const at = step.indexOf(heading);
      return at < 0 ? [step, ''] : [step.slice(0, at), step.slice(at)];
    };
    const clauses = [
      [0, 'область обновления', 'Исходов у обязательного слияния `origin/main` три'],
      [
        0,
        'разрешение конфликта main',
        'Разреши конфликт, сохранив действующее поведение `main` и результат задачи',
      ],
      [
        0,
        'основа main',
        'В спорных случаях используй код `main` как основу и адаптируй реализацию задачи к нему',
      ],
      [
        0,
        'проверка интеграции',
        'После разрешения проверь также автоматически объединённые участки',
      ],
      [
        0,
        'доказательная остановка',
        'Количество конфликтов, сложность интеграции и первая неудачная попытка не являются основанием для `failed`',
      ],
      [
        1,
        'выбор по плану',
        'согласованные `design.md` и `tasks.md`: способ подготовки выбирается по плану',
      ],
      [
        1,
        'порядок интеграции',
        'Порядок вливания PR сам по себе не требует слияния соседней ветки и не становится предусловием запуска',
      ],
      [1, 'явные предусловия', 'Явные предусловия запуска из назначения и карточки сохраняются'],
      [1, 'источник', 'используй указанные источник и ревизию'],
      [
        1,
        'состав и повторная проверка',
        'собственную правку в согласованном составе и повторную проверку после интеграции',
      ],
      [1, 'без пробного слияния', 'пробовать слияние всей ветки перед ним не требуется'],
      [1, 'отмена дополнительного слияния', 'git -C <дерево> merge --abort'],
      [1, 'результат отмены', 'Проверь код возврата отмены'],
      [1, 'статус дерева', 'git -C <дерево> status --porcelain'],
      [
        1,
        'восстановление',
        'отсутствие незавершённого слияния и сохранность предшествовавших правок',
      ],
      [1, 'ошибка отмены', 'Ошибка отмены или невосстановленное дерево — `failed`'],
      [1, 'без сброса', 'не сбрасывай дерево ради продолжения'],
      [
        1,
        'доступность',
        'После успешной отмены проверь доступность указанной планом отправленной версии и файла',
      ],
      [
        1,
        'условное продолжение',
        'Если способ доступен и явного запрета запуска нет — продолжай по плану',
      ],
      [
        1,
        'конфликт не достаточен',
        'Сам конфликт дополнительного слияния не является причиной `failed`',
      ],
      [
        1,
        'обязательное по плану слияние',
        'Если план требует именно слияния без альтернативы, выборочное копирование его не заменяет',
      ],
      [
        1,
        'отчёт',
        'В отчёте назови отменённую операцию, конфликтующие пути и результат проверки способа',
      ],
      [
        1,
        'неизвестные конфликты',
        'Неизвестные конфликты вслепую не разрешай ни при каком слиянии',
      ],
      [
        1,
        'сохранность правок и плана',
        'не затирай свои или чужие правки и не заменяй согласованный план самостоятельно',
      ],
      [1, 'приоритет', 'Отсутствие файла в main не доказывает отсутствие доступной подготовки.'],
      [1, 'ошибка не доказательство', 'ошибка чтения не доказывает отсутствия предмета.'],
      [
        1,
        'ожидание зависимости',
        'Если предмет ещё должна принести другая задача и доступной подготовки нет,',
      ],
      [
        1,
        'маршрут blocked',
        'сохрани и отправь свою работу, затем верни blocked по общему контракту:',
      ],
      [
        1,
        'доказательство ожидания',
        'taskId либо requestKey, reason, result и, если требуется, dependencyResult.',
      ],
      [1, 'свой PR', 'Это действует и при собственном PR: начатая работа сохраняется.'],
      [
        1,
        'единый механизм',
        'premature не вводится; старый план 0216 подлежит согласованию с blocked.',
      ],
      [
        1,
        'без повторного захвата',
        'Не возвращай свободную задачу в очередь до результата предусловия',
      ],
    ];
    const problems = (text) => {
      const sections = parts(text).map((part) => part.replace(/\s+/g, ' '));
      return clauses
        .filter(([section, , phrase]) => !sections[section].includes(phrase))
        .map(([, name]) => `supervisor/skills/implement.md: ${name}`);
    };
    const replaceClause = (text, section, before, after) => {
      const block = parts(text)[section];
      const pattern = new RegExp(
        before
          .split(' ')
          .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('\\s+'),
      );
      expect(block).toMatch(pattern);
      // Сохраняем границы шага: падение должно указывать только испорченную норму.
      return text.replace(block, block.replace(pattern, after));
    };

    it('сохраняет все условия в реальном шаге подготовки', () => {
      expect(problems(skillText('implement'))).toEqual([]);
    });

    it.each(clauses)('ловит удаление условия %i: %s', (section, name, phrase) => {
      const original = skillText('implement');
      const sections = parts(original);
      const mutant = replaceClause(original, section, phrase, '');
      expect(problems(mutant + '\n' + sections[section])).toEqual([
        `supervisor/skills/implement.md: ${name}`,
      ]);
    });

    it.each(['удаление', 'перенос за шаг'])('ловит %s блока', (mode) => {
      const original = skillText('implement');
      const block = parts(original)[1];
      expect(block).toContain(heading);
      const mutant = original.replace(block, '') + (mode === 'перенос за шаг' ? block : '');
      expect(problems(mutant)).toContain('supervisor/skills/implement.md: выбор по плану');
    });

    it.each([
      [
        'Если способ доступен и явного запрета запуска нет — продолжай по плану',
        'После любого конфликта верни failed',
        'условное продолжение',
      ],
      [
        'Отсутствие файла в main не доказывает отсутствие доступной подготовки.',
        'Любой файл вне main означает отсутствие предмета',
        'приоритет',
      ],
      [
        'сохрани и отправь свою работу, затем верни blocked по общему контракту:',
        'Верни failed вместо ожидания',
        'маршрут blocked',
      ],
      [
        'Это действует и при собственном PR: начатая работа сохраняется.',
        'При собственном PR закрывай задачу',
        'свой PR',
      ],
    ])('ловит подмену: %s', (before, after, name) => {
      const original = skillText('implement');
      expect(problems(replaceClause(original, 1, before, after))).toEqual([
        `supervisor/skills/implement.md: ${name}`,
      ]);
    });
  });

  it('выкладка проверяет закреплённый снимок без слияния исторической ветки', () => {
    const text = skillText('deploy');
    const marks = [
      'git -C <дерево> rev-parse HEAD',
      'git -C <дерево> diff --stat <deploymentRevision> HEAD',
      'замер меряет дерево, а не ревизию',
      'файлы сборки всегда берутся из дерева',
      'pnpm install --frozen-lockfile',
    ];
    expect(marks.filter((mark) => !text.includes(mark))).toEqual([]);
    expect(text).not.toContain('git -C <дерево> merge origin/main');
    expect(text).not.toContain('git -C <дерево> merge --ff-only origin/main');
  });

  // Команды считаются только внутри исполняемых блоков шага подготовки:
  // упоминание статуса в запретах не защищает от грязи после установки.
  function deployCleanlinessErrors(text) {
    const steps = [...text.matchAll(/^\d+\. \*\*[^\n]+[\s\S]*?(?=^\d+\. \*\*|^## |$(?![\s\S]))/gm)];
    const preparation = steps.find((step) => step[0].includes('**Проверь совпадение дерева'));
    const measurement = steps.find((step) => step[0].includes('**Замерь кадры'));
    if (!preparation || !measurement || preparation.index >= measurement.index)
      return ['deploy.md: подготовка должна предшествовать замеру'];
    const body = preparation[0];
    const commands = [...body.matchAll(/```powershell\s*\n([\s\S]*?)```/g)]
      .flatMap((block) => block[1].split('\n'))
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter((line) => /^(git .* status --porcelain|pnpm install)/.test(line));
    const errors = [];
    if (
      JSON.stringify(commands) !==
      JSON.stringify([
        'git -C <дерево> status --porcelain',
        'pnpm install --frozen-lockfile',
        'git -C <дерево> status --porcelain',
      ])
    )
      errors.push(
        'deploy.md: нужен порядок исходный статус → установка → повторный статус до замера',
      );
    const prose = body.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ');
    for (const condition of [
      'Ошибка установки',
      'Непустой вывод статуса',
      'Ошибка проверки статуса',
    ]) {
      const start = prose.indexOf(condition);
      const sentence = start < 0 ? '' : prose.slice(start).split('.')[0];
      if (
        !sentence.includes('`failed`') ||
        !sentence.includes('до замера и выкладки') ||
        (condition !== 'Непустой вывод статуса' && !sentence.includes('ненулевой код возврата'))
      )
        errors.push(`deploy.md: отсутствует условие остановки: ${condition}`);
    }
    if (!prose.includes('Не исправляй снимок, не меняй закреплённый хеш и не чисти файлы'))
      errors.push('deploy.md: отсутствует запрет исправления снимка');
    return errors;
  }

  it('выкладка повторяет статус после установки до замера', () => {
    expect(deployCleanlinessErrors(skillText('deploy'))).toEqual([]);
  });

  it('сторож порядка обнаруживает удаление и перенос повторного статуса', () => {
    const text = skillText('deploy');
    const block = '   ```powershell\n   git -C <дерево> status --porcelain\n   ```';
    expect(text).toContain(block);
    const removed = text.replace(block, '');
    const beforeInstall = removed.replace(
      '   ```powershell\n   pnpm install',
      `${block}\n\n   \`\`\`powershell\n   pnpm install`,
    );
    const afterMeasurement = removed.replace(
      '8. **Замерь кадры один раз.**',
      `8. **Замерь кадры один раз.**\n\n${block}`,
    );
    for (const damaged of [removed, beforeInstall, afterMeasurement]) {
      expect(deployCleanlinessErrors(damaged)).toContain(
        'deploy.md: нужен порядок исходный статус → установка → повторный статус до замера',
      );
    }
  });

  it.each(['Ошибка установки', 'Непустой вывод статуса', 'Ошибка проверки статуса'])(
    'сторож обнаруживает удалённое условие: %s',
    (condition) => {
      const text = skillText('deploy');
      const damaged = text
        .split('\n')
        .filter((line) => !line.includes(condition))
        .join('\n');
      expect(deployCleanlinessErrors(damaged)).toContain(
        `deploy.md: отсутствует условие остановки: ${condition}`,
      );
    },
  );

  it('этапы с собственным коммитом в следе называют цену коммита слияния', () => {
    // Отчёт `done` без следа приёмка отменяет, а следом проработке,
    // имплементации и доработке объявлен коммит в ветке. Коммит слияния —
    // тоже коммит: этап, не сделавший ничего сверх освежения базы, предъявил
    // бы его и прошёл приёмку, ничего не сделав. По одному лишь наличию
    // коммита это не проверяется, поэтому мерка называется словами — там,
    // где сессия читает про освежение.
    //
    // Мерка — подстрока, которую нельзя выполнить случайно: пересказ вроде
    // «слияние следом не считай» её не даст, а дословная фраза стоит ровно
    // в том абзаце, ради которого заведена.
    //
    // Перечень закрыт тремя этапами по существу, а не по недосмотру, —
    // и дописывать в него четвёртого «для единообразия» не надо:
    //
    // - `audit` базу освежает, но следом ему объявлена ветка без хвоста,
    //   а не коммит. Отчёт `done` проходит там приёмку и вовсе без единого
    //   коммита, значит коммит слияния дыры не открывает;
    // - `deploy` освежает базу своим порядком и своей формой, но следа ему
    //   не положено вовсе — предъявлять коммит слияния как след некуда.
    const guilty = ['design', 'implement', 'revise'].filter(
      (stage) => !skillText(stage).includes('Коммит слияния следом этапа не считается'),
    );
    expect(guilty.map((stage) => `${stage}.md: Коммит слияния следом этапа не считается`)).toEqual(
      [],
    );
  });

  it('ревью главную ветку в дерево не подтягивает', () => {
    // Обратный сторож нужен наравне с прямым, и по совсем другой причине.
    // Пропажа прямого правила видна хотя бы конфликтом у ревью; пропажа
    // запрета не проявляется ничем: подтянувшее ревью выглядит работающим
    // до того дня, когда влитый им непроверенный коммит уронит главную
    // ветку.
    //
    // Вердикт ревью стоит на зелени, снятой у вершины ветки. Слияние делает
    // новую вершину, которую не проверял никто, и вливание пошло бы на ней —
    // снялся бы первый из трёх предохранителей, в обмен на которые конвейеру
    // отдано право вливать без человека.
    //
    // Мерка — та же строка слияния, что и у прямого сторожа, но с обратным
    // знаком. Расчёт `merge-tree` шага 4 под неё не попадает: там другая
    // подкоманда, и дерева она не трогает вовсе — ровно поэтому ревью
    // и получает свежесть главной ею, а не слиянием.
    const text = skillText('review');
    expect(text.includes('git -C <дерево> merge origin/main'), 'review.md: строка слияния').toBe(
      false,
    );
    // Запрет обязан стоять словами, а не держаться на отсутствии строки:
    // молчание правил исполнитель вправе прочесть как разрешение, а правка
    // «за компанию» — привести ревью к виду четырёх освежающих этапов.
    expect(
      text.includes('Подтягивать главную ветку в дерево'),
      'review.md: запрет не назван словами',
    ).toBe(true);
  });

  it('ответ о поведении openspec archive назван с версией и датой пробы', () => {
    // Утверждение о поведении СТОРОННЕГО инструмента живёт ровно до его
    // обновления, и без версии читатель не знает, к чему ответ относится:
    // «команда срабатывает» верно для 1.6.0 и неизвестно для 2.0.0.
    // Сторож проверяет поэтому не текст ответа, а обязанность называть
    // рядом с ним версию и дату — сам ответ волен меняться с каждой пробой.
    //
    // Заодно ловится возврат прежней оговорки «проба не ставилась»:
    // она правдива только до пробы, а после неё превращается в ложь,
    // которую читатель обнаружит в тот единственный миг, когда архивация
    // ему нужна. Поставить пробу заново дешевле, чем убрать эту ложь.
    //
    // Окно — две тысячи знаков после первого упоминания ключа: ответ обязан
    // стоять рядом с ним, а не в другом конце файла, где его никто не свяжет
    // с командой. Размер выбран так, чтобы окно кончалось раньше ближайшей
    // посторонней даты в обоих файлах (в скилле она в полутора тысячах
    // знаков дальше, в памятке — вдвое дальше): иначе сторож зеленел бы
    // на чужой дате, приняв её за дату пробы.
    const near = (text) => {
      const at = text.indexOf('--skip-specs');
      return at < 0 ? null : text.slice(at, at + 2000);
    };
    // Памятка проекта лежит вне каталога инструмента и читается прямо,
    // без проверки на существование. Проверка эта была бы вредна: не найдя
    // файла, сторож молча ужался бы до одного источника и остался зелёным —
    // ровно тем декоративным тестом, против которого заведена задача 0021.
    // Пусть уж падает чтением: ответ обязан стоять в обоих местах,
    // и расхождение двух записей хуже отсутствия одной.
    const claudeMd = fileURLToPath(new URL('../../CLAUDE.md', import.meta.url));
    const sources = [
      ['скилл проработки', skillText('design')],
      ['памятка проекта', readFileSync(claudeMd, 'utf8')],
    ];

    // Версию от даты отличает соседство с именем инструмента, а не форма
    // числа. Шаблону «цифры через точки» удовлетворяет и сама дата пробы
    // «03.09.2026», поэтому сторож, спрашивающий одну лишь форму, зеленел бы
    // на тексте, из которого версию убрали, а дату оставили, — то есть ровно
    // в том случае, ради которого заведён. Проверено порчей 04.09.2026:
    // с «1.6.0», убранным из скилла, падает именно эта проверка, а соседняя
    // проверка даты остаётся зелёной.
    const version = /OpenSpec\s+\d+\.\d+\.\d+/;

    for (const [name, text] of sources) {
      const window = near(text);
      expect(window, `${name}: ключ --skip-specs не упомянут вовсе`).not.toBeNull();
      expect(window, `${name}: рядом с --skip-specs нет версии OpenSpec`).toMatch(version);
      expect(window, `${name}: рядом с --skip-specs нет даты пробы`).toMatch(/\d{2}\.\d{2}\.\d{4}/);
      expect(window, `${name}: вернулась оговорка о непоставленной пробе`).not.toContain(
        'не ставилась',
      );
    }
  });

  it('сторож формулы падает на прежней её редакции', () => {
    // Сторож, который зеленеет на чём угодно, — не сторож. Прежняя формула
    // объявляла след имплементации одним лишь коммитом; проверяем, что она
    // не прошла бы.
    const previous = [
      'След объявлен поимённо:',
      'проработке, имплементации и доработке — коммит в ветке без хвоста;',
      'аудиту и ревью — ветка без хвоста; замеру — новый номер прогона;',
      '',
      'Поля:',
    ].join('\n');
    expect(traceFormula(previous)).not.toBeNull();
    expect(traceFormula(previous)).not.toContain('pull request');
    expect(traceFormulaProblems(previous)).toContain(
      'implement: альтернатива первого PR не названа',
    );
  });

  it('скилл проработки называет форму команд, годную для списка задач', () => {
    // Команда, выписанная в `tasks.md` голой, достаётся этапу, которому
    // голая приставка недоступна: `git merge` не покрыт ни одним правилом,
    // а склеивать `cd` с командой исполнителю запрещено. Отказ прилетает
    // не человеку, а сессии — и та идёт дальше, считая шаг сделанным.
    // Живой случай был один: шаг 2 изменения point-the-form-note-at-a-live-rule.
    //
    // Сверяются две подстроки, и обе взяты из самого пункта: форма, которую
    // сессия перепишет буквально, и оговорка о том, где живёт перечень
    // покрытого, — без неё правило вырождается в «пиши как-нибудь иначе».
    // Путь `supervisor/config/stage-settings.json` для сверки НЕ годится:
    // он стоит в этом же файле по другому поводу — в пункте про заявку
    // с `area: "pipeline"`, — и сторож зеленел бы, даже если весь новый
    // пункт из скилла убрать.
    const text = skillText('design');
    const missing = ['git -C <дерево>', 'Перечень покрытого живёт'].filter(
      (mark) => !text.includes(mark),
    );
    expect(missing.map((mark) => `design.md: ${mark}`)).toEqual([]);
  });

  it('каждый скилл называет строку кода в доводе и её замену', () => {
    // Строку кода в доводе режет разбор разрешений сам по себе, без единого
    // из четырёх знаков, которые правила перечисляли прежде: проба 04.09.2026
    // отказала даже `node -e "1"`. Сессия читала перечень, своего случая
    // в нём не находила и уверенно набирала команду, которая не выполнялась;
    // на ревью задачи 0173 так пропало пять попыток подряд, после чего
    // выражение разобрали в уме — ровно то, ради ухода от чего правила
    // и требуют пробы.
    //
    // Правило живёт десятью копиями, и разъехаться им ничего не мешает:
    // правка одного файла остальные девять не задевает. Названного в одном
    // скилле правила для прочих не существует вовсе — этап читает свой файл,
    // а не соседний.
    //
    // Мерка по существу, а не по фразе целиком: дословная сверка запретила бы
    // редактировать абзац, не переписав тест, — и однажды тест перепишут
    // не глядя. Подстроки три, по одной на каждую половину правила: признак
    // строки кода, второй предохранитель и покрытая форма замены.
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      const text = skillText(stage);
      for (const mark of [
        'node --eval',
        'два разделителя пути подряд',
        'node .matchlog/<имя>.mjs',
      ]) {
        if (!text.includes(mark)) guilty.push(`${stage}.md: ${mark}`);
      }
    }
    expect(guilty).toEqual([]);
  });

  it('ложного довода о составной команде не осталось ни в одном скилле', () => {
    // Довод «составную команду не покрывает никакое правило разрешений»
    // опровергается одной командой: конвейер
    // `git status --porcelain | Select-Object -First 1` проходит. Правило,
    // опирающееся на опровержимый довод, теряет силу вместе с ним — а само
    // правило «одна команда — один вызов» верно и нужно.
    //
    // Ищется СЕМЬЯ формулировок, а не подстрока. Дословная мерка
    // «не покрывает никакое правило» находила девять мест из двадцати
    // и создавала впечатление полноты: у одного и того же довода восемь
    // записей, и расхождение в одно слово («не покрывает ЗАРАНЕЕ никакое
    // правило» в benchmark.md) делает поиск слепым ровно там, где ложь
    // и осталась бы.
    //
    // Текст нормализуется по пробелам: без этого перенос строки посреди
    // фразы прячет её от любого выражения. Основы слов кончаются классом
    // кириллицы, а не `\w`: в JavaScript `\w` — это `[A-Za-z0-9_]`,
    // и `покрыва\w+` не ловит по-русски ничего вовсе.
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      const text = skillText(stage).replace(/\s+/g, ' ');
      const found = text.match(FALSE_GROUND);
      if (found) guilty.push(`${stage}.md: ${found[0]}`);
    }
    expect(guilty).toEqual([]);
  });

  it('мерка ложного довода ловит все свои контрольные образцы', () => {
    // Проверка на ОТСУТСТВИЕ сходится и при сломанной мерке: пустой ответ
    // у неё тот же, что у мерки исправной, и отличить одно от другого
    // по цвету сторожа нельзя. Первая редакция этого изменения именно так
    // и вышла — выражение с `\w` не ловило по-русски ничего, и сторож при нём
    // был бы зелёным навсегда, при живом доводе во всех десяти файлах.
    //
    // Образцов восемь, по одному на каждую живую формулировку, снятую
    // прогоном 04.09.2026. Считаются они по совпадению целиком, а не
    // по хвосту: при счёте по хвосту образцы 3 и 6 слились бы в один,
    // и формулировка benchmark.md осталась бы без своего образца.
    const samples = [
      'составную не разрешить заранее никаким правилом',
      'составную команду не покрывает никакое правило',
      'составную не покрывает заранее никакое правило',
      'составную не разрешает заранее никакое правило',
      'конвейер из `Get-ChildItem` не покрыт никаким правилом',
      'составным, а составную команду не покрывает заранее никакое правило',
      'составную заранее не разрешает никакое правило',
      'составную не разрешает никакое правило',
    ];
    // Щадимые — новые доводы, которыми ложный заменён, и верное утверждение
    // benchmark.md о конкретном правиле `gh run:*`. Поймай мерка хоть один
    // из них, правка этого же изменения её бы и покрасила.
    const spared = [
      'у составной команды их несколько, и хватает одного непокрытого',
      'а разбор требует, чтобы открыто было каждое действие строки: `Get-ChildItem` не открыт ни одним правилом даже сам по себе',
      'подстановка исполняет вложенную команду, разбор считает её отдельным действием и требует, чтобы открыто было и оно',
      '`Get-ChildItem` не открыт ни одним правилом разрешений — ни сам по себе, ни первым звеном цепочки',
      'цикл составной, приставок у него несколько, и `gh run:*` его не покрывает',
    ];
    expect(samples.filter((sample) => !FALSE_GROUND.test(sample))).toEqual([]);
    expect(spared.filter((sample) => FALSE_GROUND.test(sample))).toEqual([]);
  });

  it('скилл проработки запрещает шаг ожидания зелёного CI', () => {
    // Пункт «дождаться зелёного CI» неисполним по устройству, и потому его
    // не заводят вовсе. Караулить проверки исполнителю запрещено (шаг 9
    // implement.md), а отметить пункт честно нельзя: отметка — новый коммит,
    // перезапускающий те самые проверки, чью зелень она фиксирует. Открытый
    // же пункт делает исход `done` («все пункты tasks.md сделаны»)
    // недостижимым по букве, и изменение доходит до вливания с недоделкой,
    // которой на деле нет.
    //
    // Подстроки две, и вторая не для красоты: правило, ужатое до голого
    // запрета без причины, переписывают обратно первым же, кто сочтёт его
    // перестраховкой. Обе взяты из самого пункта и в файле больше нигде
    // не встречаются.
    const text = skillText('design');
    const missing = ['шага ожидания зелёного CI', 'опрашивает проверки сам'].filter(
      (mark) => !text.includes(mark),
    );
    expect(missing.map((mark) => `design.md: ${mark}`)).toEqual([]);
  });

  it('скилл ревью прощает открытый пункт ожидания CI', () => {
    // Запрет в скилле проработки задним числом не действует, а пункт стоит
    // в десяти уже написанных списках задач, и часть их лежит в состояниях
    // `pr` и `deploy` прямо сейчас. Без оговорки ревьюер отличал бы недоделку
    // от неисполнимого пункта собственным нигде не записанным рассуждением.
    //
    // Проверка отдельная от сторожа скилла проработки нарочно: по красному
    // прогону должно быть видно, чьё именно правило вычистили.
    const text = skillText('review');
    expect(text.includes('недоделкой не считается'), 'review.md: недоделкой не считается').toBe(
      true,
    );
  });
});

describe('согласованность ожидания 0216 с подготовкой 0254', () => {
  const title = '### Requirement: Исполнитель сохраняет ожидание предмета через blocked';
  const change = 'return-premature-tasks-to-the-queue';
  const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  const has = (p) => existsSync(new URL('../../' + p, import.meta.url));
  const source = () => {
    const paths = [
      'openspec/specs/dev-pipeline-worker/spec.md',
      'openspec/changes/' + change + '/specs/dev-pipeline-worker/spec.md',
    ];
    const archive = 'openspec/changes/archive';
    paths.push(
      ...readdirSync(new URL('../../' + archive, import.meta.url))
        .filter((n) => n.endsWith('-' + change))
        .map((n) => archive + '/' + n + '/specs/dev-pipeline-worker/spec.md'),
    );
    const path = paths.find((p) => has(p) && read(p).includes(title));
    if (!path) throw new Error('Не найден действующий контракт ожидания 0216');
    return read(path);
  };
  const section = (text, scenario) => {
    const heading = scenario ? '#### Scenario: ' + scenario : title;
    const start = text.indexOf(heading);
    if (start < 0) return '';
    const rest = text.slice(start + heading.length);
    const end = rest.search(/\n#{3,4} /);
    return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
  };
  const clauses = [
    ['', 'При безопасном дереве, обновлённой main и соблюдении явных предусловий'],
    [
      '',
      'доступная подготовка по согласованному плану SHALL исключать вывод об отсутствии предмета только по отсутствию файла в main',
    ],
    [
      '',
      'После конфликта необязательного слияния SHALL выполняться отмена и проверка восстановления дерева',
    ],
    ['', 'Конфликт обновления origin/main'],
    ['', 'Существующие change и PR сохраняются и ожидание не запрещают'],
    ['', 'Отдельный premature вводиться MUST NOT'],
    ['Имплементации нечего править', 'подтянув свежую главную ветку'],
    ['Имплементации нечего править', 'доступной подготовки по плану нет'],
    ['Имплементации нечего править', 'с исходом blocked'],
    ['Имплементации нечего править', 'ожидание и доказательство в reason/result'],
    ['Имплементации нечего править', 'taskId и ожидаемый результат'],
    ['Имплементации нечего править', 'кода не пишет, собственный PR не открывает'],
    ['Предмет лежит в чужой невлитой ветке', 'не создавая пустого изменения OpenSpec'],
    ['Предмета нет, но pull request уже открыт', 'доступной подготовки по плану нет'],
    [
      'Предмета нет, но pull request уже открыт',
      'возвращает blocked с причиной и ожидаемым результатом',
    ],
    [
      'Предмета нет, но pull request уже открыт',
      'без автоматического возврата в очередь и удаления начатой работы',
    ],
    ...[
      'Доступная подготовка без собственного PR',
      'Доступная подготовка с собственным PR',
    ].flatMap((scenario) =>
      [
        'файл только в отправленной версии открытого соседнего PR',
        'подготовка по плану доступна',
        'дерево безопасно',
        'main обновлена',
        'явные предусловия соблюдены',
        'SHALL продолжить подготовку по плану',
      ].map((phrase) => [scenario, phrase]),
    ),
    ['Доступная подготовка без собственного PR', 'собственного PR нет'],
    ['Доступная подготовка без собственного PR', 'без обязательной попытки слияния всей ветки'],
    ['Доступная подготовка с собственным PR', 'собственный PR уже открыт'],
    ['Доступная подготовка с собственным PR', 'собственный PR доступную работу не запрещает'],
    ['Неподдерживаемый исход из старого плана', 'неподдерживаемый premature отправлять MUST NOT'],
    [
      'Техническая ошибка проверки подготовки',
      'ошибка доступа к существующей ревизии, инструмента, отмены слияния',
    ],
    [
      'Техническая ошибка проверки подготовки',
      'конфликт требуемого планом слияния без альтернативы',
    ],
    ['Техническая ошибка проверки подготовки', 'технический failed независимо от собственного PR'],
    [
      'Техническая ошибка проверки подготовки',
      'ошибка чтения доказательством отсутствия предмета быть MUST NOT',
    ],
    ['Заведённый план ожидает новую предпосылку', 'ожидание идёт через blocked'],
    ['Предмет приехал к ожидающей задаче', 'до этого повторная рабочая сессия не запускается'],
    ['Подозрение вместо проверки', 'зависимость выдумывать MUST NOT'],
    [
      'Предмет снят, а не отсутствует',
      'существующие ограничения этого исхода не переносятся на blocked',
    ],
  ];
  const problems = (text) =>
    clauses.filter(([scenario, phrase]) => !section(text, scenario).includes(phrase));
  it('проверяет действующее требование и все ветви подготовки и ожидания', () =>
    expect(problems(source())).toEqual([]));
  it.each(clauses)('обнаруживает потерю условия %s: %s', (scenario, phrase) => {
    const original = source();
    const heading = scenario ? '#### Scenario: ' + scenario : title;
    const start = original.indexOf(heading);
    const prefix = original.slice(0, start);
    const rest = original.slice(start).replace(phrase, 'УТРАЧЕНО');
    const damaged = prefix + rest + '\n### Requirement: Посторонний текст\n' + phrase;
    expect(problems(damaged)).toContainEqual([scenario, phrase]);
    for (const [other, value] of clauses)
      if (other !== scenario) expect(section(damaged, other)).toContain(value);
  });
});

describe('связность таблицы', () => {
  it('у каждого состояния объявлена цена', () => {
    const priced = STATES.filter((status) => stateClass({ status, run: { kind: 'arena' } }));
    expect(priced).toHaveLength(STATES.length);
  });

  it('все состояния маршрутов существуют', () => {
    for (const [type, route] of Object.entries(ROUTES)) {
      for (const [from, targets] of Object.entries(route)) {
        expect(STATES, `${type}: ${from}`).toContain(from);
        for (const to of targets) expect(STATES, `${type}: ${from} → ${to}`).toContain(to);
      }
    }
  });

  it('дерево нужно только тем состояниям, что правят код', () => {
    expect(NEEDS_WORKTREE).not.toContain('benchmark');
    expect(NEEDS_WORKTREE).not.toContain('triage');
    // Разбор читает журнал, лог и правила конвейера — писать ему некуда
    // и незачем. Дерево упавшей задачи он тоже не трогает: оно сохранено
    // для человека.
    expect(NEEDS_WORKTREE).not.toContain('postmortem');
    // Уборка сносит дерево снаружи — из основного дерева, по пути из записи
    // реестра, — и собственного дерева ей не нужно. Сессии ей не выдают вовсе.
    expect(NEEDS_WORKTREE).not.toContain('cleanup');
    expect(NEEDS_WORKTREE).toContain('implement');
  });
});
