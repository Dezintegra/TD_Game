import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STAGE_COMMANDS, uncoveredForStage } from './permissions.mjs';
import {
  NEEDS_SESSION,
  NEEDS_WORKTREE,
  ROUTES,
  STATES,
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
    expect(canTransition(task({ type: 'run', status: 'interpret' }), 'closed').ok).toBe(true);
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
  uncoveredForStage(permissions, 'review', STAGE_COMMANDS);

/**
 * Этапы, чьи команды закрыты ОСОЗНАННО, — с причиной и с тем, чем закрытие
 * снимается.
 *
 * Реестр нужен потому, что сторож без него покраснел бы сразу и навсегда:
 * выкладка с `ssh` закрыта решением о том, что боевой сервер — дело человека
 * (`$pnpmNote` в `stage-settings.json`). А красный набор не влить — и вместе
 * со сторожем пропала бы первая половина изменения, та самая, которая
 * прекращает сжигать по две сессии на задачу.
 *
 * Замолчать беду реестром нельзя: он краснеет в обе стороны. Развилка
 * владельца продукта — открыть команды или вывести `deploy` из автомата —
 * от записи не решается, а становится видимой и снимается одной строкой.
 */
const DELIBERATELY_CLOSED = {
  deploy:
    'боевой сервер — решение человека ($pnpmNote в stage-settings.json). ' +
    'Снимается задачей 0117: разрешить конвейеру команды выкладки',
};

/**
 * Что в скилле этапа считать гейтируемым: программы, чей запуск решают правила
 * разрешений. Объявляется по этапу, а не общим списком, потому что «стерегомое»
 * зависит от того, чем этап занят.
 *
 * У `review` таких программ не объявлено, и это нарочно: его перечень —
 * осознанно короткая выборка из скилла (`gh pr checks` шага 2 в неё не входит),
 * а весь путь ревью покрыт одним приставочным правилом `gh pr:*`, при котором
 * выборка и полный перечень неразличимы. Перекраивать выборку здесь нельзя
 * и по второй причине: её заводит незаархивированное `undraft-before-merge`,
 * это его предмет.
 */
const GATED_PROGRAMS = {
  deploy: ['ssh', 'node scripts/deploy.mjs'],
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

/**
 * Однострочная формула следа из скилла — абзац после «След объявлен поимённо».
 *
 * Она живёт десятью копиями, по одной на скилл, и сверяется целым абзацем,
 * а не отдельным словом: слово `pull request` встречается в скиллах и вне
 * формулы, и поиск по всему тексту зеленел бы на разъехавшейся копии.
 */
const traceFormula = (text) => text.match(/След объявлен поимённо:[\s\S]*?(?=\n\n)/)?.[0] ?? null;

describe('этапы и скиллы', () => {
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

  it('открытие закрытого этапа требует снять запись о нём', () => {
    // Проба на порчу первого рода — на выдуманной настройке, а не правкой
    // `stage-settings.json`: открывать команды выкладки здесь нельзя, это
    // решение владельца продукта (задача 0117).
    const opened = {
      allow: [
        'Bash(ssh:*)',
        'PowerShell(ssh:*)',
        'Bash(node scripts/deploy.mjs:*)',
        'PowerShell(node scripts/deploy.mjs:*)',
      ],
      deny: [],
    };
    expect(uncoveredForStage(opened, 'deploy')).toEqual([]);
    expect('deploy' in DELIBERATELY_CLOSED).toBe(true);
  });

  it('правило на одну приставку выкладки из двух этап не открывает', () => {
    // Проба ровно на ту щель, из-за которой перечень пересматривался. Правило
    // открывает приставку с `-o ConnectTimeout=15` — то есть шаги 4 и 5, —
    // а сверка имён переменных окружения (шаг 7) зовёт `ssh` без него.
    // Сторож обязан назвать её поимённо и оставить запись о закрытом `deploy`
    // в силе: этап всё ещё умрёт, только шагом позже.
    const halfOpen = {
      allow: [
        'Bash(ssh -o BatchMode=yes -o ConnectTimeout=15 dezintegra:*)',
        'PowerShell(ssh -o BatchMode=yes -o ConnectTimeout=15 dezintegra:*)',
        'Bash(node scripts/deploy.mjs:*)',
        'PowerShell(node scripts/deploy.mjs:*)',
      ],
      deny: [],
    };
    const uncovered = uncoveredForStage(halfOpen, 'deploy');
    const step7 = 'ssh -o BatchMode=yes dezintegra "grep -o \'^[A-Z_]*\' ~/td/.env"';
    // По строке на оболочку, и обе названы: разницу в чтении оболочек надо
    // видеть, а не проглядеть.
    expect(uncovered).toEqual([`Bash: ${step7}`, `PowerShell: ${step7}`]);
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

  it('все десять копий формулы следа называют pull request у имплементации', () => {
    // След имплементации — коммит ЛИБО впервые открытый pull request:
    // задача, вся правка которой внесена проработкой, законна, а открыть
    // черновой PR ей всё равно обязательно. Копия, отставшая от этого,
    // велит сессии отчитаться `failed` там, где приёмка приняла бы `done`,
    // — то есть выбрасывает правильно сделанную работу.
    const dir = fileURLToPath(new URL('../skills/', import.meta.url));
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      const formula = traceFormula(readFileSync(`${dir}${stage}.md`, 'utf8'));
      if (!formula) {
        guilty.push(`${stage}.md: формулы следа нет вовсе`);
      } else if (!formula.includes('pull request')) {
        guilty.push(`${stage}.md: pull request не назван`);
      }
    }
    expect(guilty).toEqual([]);
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

  it('проработка и аудит называют законную ошибку валидатора дословно', () => {
    // Красный валидатор на бездельтовом изменении законен, и оба этапа
    // обязаны узнавать этот случай по тексту ошибки, а не по пересказу.
    // Проработка, не узнав его, полезет чинить красноту требованием
    // ради проверки; аудит, не узнав, вернёт задачу замечанием — и оба
    // сожгут заход на беду, которой нет.
    //
    // Сверяется дословная строка, а не «есть слово delta»: пересказ вроде
    // «валидатор ругается на отсутствие дельт» сессия примет за описание
    // ЛЮБОЙ ошибки про дельты и спишет на этот случай поломанную разметку.
    const guilty = ['design', 'audit'].filter(
      (stage) => !skillText(stage).includes('Change must have at least one delta'),
    );
    expect(guilty).toEqual([]);
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
    expect(NEEDS_WORKTREE).toContain('implement');
  });
});
