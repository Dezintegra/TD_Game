import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NEEDS_SESSION } from './transitions.mjs';

/**
 * Сторож единственной оболочки.
 *
 * У этапа одна оболочка — PowerShell, и держится это двумя половинами:
 * правилами разрешений (`stage-settings.json`) и словами скиллов. Половины
 * обязаны ехать вместе. Разъехавшись, они дают ровно ту беду, ради которой
 * всё затеяно: 03.09.2026 скилл показывал `pnpm install` и `git push`
 * блоками `bash`, сессия честно взяла Git Bash и получила код 127
 * и `cannot spawn sh` — оба провала молча, обычным ненулевым кодом.
 *
 * Файл отдельный, а не дописан в `transitions.test.mjs`, нарочно: тот сейчас
 * переписывается изменением `hold-uncovered-stages`, и общий файл дал бы
 * конфликт при вливании. Мерка покрытия команд здесь не дублируется — её
 * по-прежнему считает тот, кто это уже умеет.
 */

const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));
const skillText = (stage) => readFileSync(`${SKILLS}${stage}.md`, 'utf8');

/** Разметки, которыми командный блок посылает сессию в Bash. */
const BASH_LANGS = ['bash', 'sh', 'shell', 'zsh'];

/** Разметки, чьё содержимое сессия набирает в оболочке как есть. */
const COMMAND_LANGS = [...BASH_LANGS, 'powershell', 'pwsh', 'ps1'];

/**
 * Три формы тела, каждая из которых в PowerShell тиха.
 *
 * Перевод блока из `bash` в `powershell` командой его не делает: тело,
 * написанное по-башевски, PowerShell либо не разберёт, либо поймёт иначе,
 * и провал снова выйдет молчаливым — ошибкой разбора вместо кода 127,
 * на том же самом месте.
 *
 * Первая форма ловится ГОЛОЙ, а не всякой. Литералом хеш-таблицы `@{`
 * становится, лишь когда стоит в командной строке неокавыченным; внутри
 * кавычек это для PowerShell обычные два знака, и довод уезжает в программу
 * дословно. Проверено пробой 03.09.2026 обеими формами кавычек — обе
 * разобрались и напечатали пустой хвост. Запрет на `@{` без различения
 * покрасил бы `'@{u}..HEAD'`, то есть само предписанное скиллами лечение.
 */
const BODY_FORMS = [
  { name: 'голый @{', hit: (line) => /(^|[^'"])@\{/.test(line) },
  { name: 'перенос обратной косой', hit: (line) => /\\[ \t]*$/.test(line) },
  { name: 'приставка ИМЯ=значение', hit: (line) => /^[ \t]*[A-Za-z_][A-Za-z0-9_]*=/.test(line) },
];

/**
 * Оговорка об оболочке, разобранная на приметы.
 *
 * Примет три, по числу утверждений, которых требует дельта: оболочка одна;
 * отказ означает не запрет действия, а не ту оболочку; примеры общих памяток
 * проекта правилу не перечат. Второе стоит дороже прочих и потому сторожится
 * отдельной строкой: сессия, получившая отказ на `git commit` без объяснения,
 * заключит, что коммитить ей запрещено, и уйдёт в `failed`, потеряв работу
 * целиком.
 */
const SHELL_NOTE_MARKS = [
  '## Оболочка команд',
  'не запрет действия, а не ту оболочку',
  'памяток проекта, размеченные `bash`, этому правилу',
];

/**
 * Тела правил, снятых у Bash 03.09.2026, — снимок круга команд на день снятия.
 *
 * Перечень записан потому, что иначе потерю пары нечем поймать: снятое
 * правило исчезает из файла бесследно, и сторожу неоткуда узнать, чья пара
 * пропала. Это не движущаяся цель — законное сужение круга потребует стереть
 * отсюда строку, то есть станет видно дифом и потребует довода. Ровно та
 * громкость, ради которой заведено всё изменение.
 *
 * Исключение объявлено одно и поимённо: `git switch:*` пары не получает —
 * переключение веток скиллы этапов запрещают словами, а разрешение осталось
 * наследством от времён, когда запрета ещё не было.
 */
const COVERED_COMMANDS = [
  'node supervisor/bin/cycle.mjs:*',
  'node supervisor/bin/board.mjs:*',
  'node supervisor/bin/snapshot.mjs:*',
  'node supervisor/bin/launch.mjs --help',
  'node supervisor/bin/board-setup.mjs',
  'node .matchlog/*',
  'git -C:*',
  'git --no-pager:*',
  'git status:*',
  'git log:*',
  'git diff:*',
  'git add:*',
  'git commit:*',
  'git push:*',
  'git fetch:*',
  'git rev-list:*',
  'git rev-parse:*',
  'git worktree:*',
  'git branch:*',
  'gh pr:*',
  'gh run:*',
  'gh workflow:*',
  'gh api:*',
  'npx eslint:*',
  'npx prettier:*',
  'npx vitest:*',
  'npx vite:*',
  'npx playwright:*',
  'npx tsc:*',
  'openspec:*',
  'pnpm install:*',
  'pnpm build:*',
  'pnpm e2e:perf:*',
  'pnpm bench:tick:*',
  'pnpm run',
  'pnpm test:pipeline:*',
  'node scripts/perf-run.mjs:*',
];

/** Единственное снятое правило, которому пара не заводится. */
const UNPAIRED_COMMAND = 'git switch:*';

const settings = () =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./stage-settings.json', import.meta.url)), 'utf8'),
  );

/** Правила `Bash(...)`, вернувшиеся в список разрешений. */
const bashAllowRules = (permissions) =>
  permissions.allow.filter((rule) => rule.startsWith('Bash('));

/** Команды из перечня, у которых не стало правила `PowerShell(...)`. */
const lostPairs = (permissions) =>
  COVERED_COMMANDS.filter((body) => !permissions.allow.includes(`PowerShell(${body})`));

/**
 * Запреты, стоящие лишь в одной оболочке.
 *
 * Запреты остаются в обеих формах, хотя разрешений на Bash больше нет:
 * запрет впрок ничего не стоит и переживает возврат разрешения. Сняв его
 * вместе с разрешением, возврат Bash-правил сделали бы тихо опасным.
 *
 * Из сверки выведены правила, начинающиеся с оператора вызова `& ` — полный
 * путь к `gh.exe` в кавычках. Форма эта у PowerShell своя, у Bash её нет
 * вовсе, и требовать ей пару значило бы требовать бессмыслицы.
 */
const denyGapsBetweenShells = (permissions) => {
  const bodies = { Bash: new Set(), PowerShell: new Set() };
  for (const rule of permissions.deny) {
    const wrapped = /^(Bash|PowerShell)\((.*)\)$/.exec(rule);
    if (wrapped && !wrapped[2].startsWith('& ')) bodies[wrapped[1]].add(wrapped[2]);
  }
  const gaps = [];
  for (const body of bodies.PowerShell) if (!bodies.Bash.has(body)) gaps.push(`Bash(${body})`);
  for (const body of bodies.Bash)
    if (!bodies.PowerShell.has(body)) gaps.push(`PowerShell(${body})`);
  return gaps;
};

/**
 * Разбор скилла на блоки кода.
 *
 * Ограждения считаются попарно, как их считает разметка: первое открывает
 * блок, следующее закрывает. Отступ у ограждения свой — блоки скиллов лежат
 * внутри пунктов перечня, и привязываться к началу строки нельзя.
 */
const codeBlocks = (text) => {
  const blocks = [];
  let open = null;
  text.split('\n').forEach((line, index) => {
    const fence = /^[ \t]*```(\S*)[ \t]*$/.exec(line);
    if (!fence) {
      if (open) open.lines.push({ number: index + 1, text: line });
      return;
    }
    if (open) {
      blocks.push(open);
      open = null;
    } else {
      open = { lang: fence[1].toLowerCase(), lines: [] };
    }
  });
  return blocks;
};

/** Разметки `bash` и её родня — по одной записи на блок. */
const bashMarkedBlocks = (text) =>
  codeBlocks(text)
    .filter((block) => BASH_LANGS.includes(block.lang))
    .map((block) => block.lang);

/** Башевские формы тела внутри командных блоков — с номером строки и именем формы. */
const bashBodyForms = (text) => {
  const guilty = [];
  for (const block of codeBlocks(text)) {
    if (!COMMAND_LANGS.includes(block.lang)) continue;
    for (const line of block.lines) {
      for (const form of BODY_FORMS) {
        if (form.hit(line.text)) guilty.push(`строка ${line.number}: ${form.name}`);
      }
    }
  }
  return guilty;
};

/**
 * Приметы оговорки, которых в скилле не нашлось.
 *
 * Текст перед сверкой склеивается в одну строку: проза скиллов переносится
 * по ширине, и любая примета длиннее нескольких слов рано или поздно окажется
 * разорванной посередине. Сторож, привязанный к месту переноса, покраснел бы
 * от переформатировки, ничего не значащей по существу, — и его починили бы
 * укорачиванием приметы до бессмысленной.
 */
const missingNoteMarks = (text) => {
  const flat = text.replace(/\s+/g, ' ');
  return SHELL_NOTE_MARKS.filter((mark) => !flat.includes(mark));
};

describe('единственная оболочка: скиллы', () => {
  it('ни один скилл не показывает команду блоком bash', () => {
    // Разметка блока — единственное, по чему сессия выбирает оболочку,
    // и выбирает она её буквально. Пока правила открывали обе оболочки,
    // такая попытка проходила гейт и падала уже внутри команды: в перечень
    // отказанных действий она не попадала вовсе, а сессия толковала чужой
    // код возврата как беду своей работы.
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      for (const lang of bashMarkedBlocks(skillText(stage))) guilty.push(`${stage}.md: ${lang}`);
    }
    expect(guilty).toEqual([]);
  });

  it('наведённый блок bash делает сторожа красным', () => {
    // Проба на порчу, прогоняемая набором, а не руками: сторож, который
    // не краснеет на сломанном скилле, — украшение.
    const spoiled = ['текст', '', '   ```bash', '   pnpm install', '   ```', ''].join('\n');
    expect(bashMarkedBlocks(spoiled)).toEqual(['bash']);
  });

  it('блок json сторожа не тревожит', () => {
    // Образец отчёта есть в каждом скилле, и командой он не является.
    // Сторож, красящий его, лечится единственным способом — выкидыванием
    // образца, то есть порчей скилла ради успокоения теста.
    const report = ['```json', '{ "outcome": "done" }', '```'].join('\n');
    expect(bashMarkedBlocks(report)).toEqual([]);
    expect(bashBodyForms(report)).toEqual([]);
  });

  it('ни один скилл не показывает башевскую форму тела', () => {
    // Смены разметки мало. Голый `@{` PowerShell читает как литерал
    // хеш-таблицы и падает до вызова `git` — а это проверка неотправленного
    // хвоста, то есть проверка следа этапа. Обратная косая строку
    // не переносит, продолжение уедет отдельным доводом. Приставки
    // `ИМЯ=значение` у PowerShell нет вовсе: строка будет понята как имя
    // команды. Все три провала молчаливы ровно так же, как код 127.
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      for (const form of bashBodyForms(skillText(stage))) guilty.push(`${stage}.md, ${form}`);
    }
    expect(guilty).toEqual([]);
  });

  it('наведённый голый @{ делает сторожа красным', () => {
    const spoiled = ['```powershell', 'git log --oneline @{u}..HEAD', '```'].join('\n');
    expect(bashBodyForms(spoiled)).toEqual(['строка 2: голый @{']);
  });

  it('ревизия в кавычках сторожа не тревожит', () => {
    // Обратная проба, и она здесь обязательна наравне с пробой на порчу.
    // Без неё сторожа однажды напишут глухим запретом на `@{` — и обнаружат
    // это, лишь когда он покрасит четыре скилла разом, включая предписанное
    // ими же лечение.
    const cured = [
      '```powershell',
      "git -C <дерево> log --oneline '@{u}..HEAD'",
      'git -C <дерево> log --oneline "@{u}..HEAD"',
      '```',
    ].join('\n');
    expect(bashBodyForms(cured)).toEqual([]);
  });

  it('наведённая хвостовая обратная косая делает сторожа красным', () => {
    const spoiled = [
      '```powershell',
      'gh workflow run arena.yml \\',
      '  -f matches=60',
      '```',
    ].join('\n');
    expect(bashBodyForms(spoiled)).toEqual(['строка 2: перенос обратной косой']);
  });

  it('наведённая приставка переменных окружения делает сторожа красным', () => {
    const spoiled = ['```powershell', 'PORT=1 pnpm build', '```'].join('\n');
    expect(bashBodyForms(spoiled)).toEqual(['строка 2: приставка ИМЯ=значение']);
  });

  it('установка переменной средствами PowerShell сторожа не тревожит', () => {
    // `$env:PORT = '3055'` — не приставка, а самостоятельная команда, и она
    // законна. Сторож, красящий её, гнал бы скиллы к форме, которой у этой
    // оболочки нет.
    const legal = ['```powershell', "$env:PORT = '3055'", '```'].join('\n');
    expect(bashBodyForms(legal)).toEqual([]);
  });

  it('оговорка об оболочке стоит в каждом скилле', () => {
    // Правил мало без слов: сессия, получившая отказ и не понявшая почему,
    // завершится с исходом `failed` и потеряет работу целиком. То есть
    // неполное лечение обошлось бы дороже самой беды.
    const guilty = [];
    for (const stage of NEEDS_SESSION) {
      for (const mark of missingNoteMarks(skillText(stage))) guilty.push(`${stage}.md: ${mark}`);
    }
    expect(guilty).toEqual([]);
  });

  it('скилл без оговорки делает сторожа красным', () => {
    expect(missingNoteMarks('скилл без единого слова об оболочке')).toEqual(SHELL_NOTE_MARKS);
  });

  it('скилл, потерявший объяснение отказа, делает сторожа красным', () => {
    // Проба порознь: потеря именно второго утверждения опаснее прочих
    // и потому обязана ловиться отдельно от потери всей оговорки.
    const halved = [
      '## Оболочка команд',
      '',
      'Команды этапа зовут из PowerShell.',
      '',
      'Примеры общих памяток проекта, размеченные `bash`, этому правилу не перечат.',
    ].join('\n');
    expect(missingNoteMarks(halved)).toEqual(['не запрет действия, а не ту оболочку']);
  });
});

describe('единственная оболочка: правила разрешений', () => {
  it('в списке разрешений нет ни одного правила Bash', () => {
    // Пока команда открыта в обеих оболочках, попытка позвать её не в той
    // проходит гейт и падает ВНУТРИ команды — кодом 127 либо жалобой
    // на отсутствие вспомогательной программы. Такой провал не попадает
    // в перечень отказанных действий вовсе, и сессия толкует его как беду
    // своей работы. Отказ разрешений, в отличие от него, называет причину
    // сам и записывается в журнал цикла.
    expect(bashAllowRules(settings().permissions)).toEqual([]);
  });

  it('вернувшееся правило Bash делает сторожа красным', () => {
    // Проба на порчу: возврат стоит одной строки, а заметят его не раньше,
    // чем очередная имплементация потеряет след этапа.
    const returned = { allow: ['PowerShell(pnpm install:*)', 'Bash(pnpm install:*)'], deny: [] };
    expect(bashAllowRules(returned)).toEqual(['Bash(pnpm install:*)']);
  });

  it('правило Bash в запретах сторожа не тревожит', () => {
    // Сторож судит только разрешения. Запреты живут в обеих оболочках
    // нарочно, и покрасить их значило бы потребовать снятия того, что стоит
    // впрок и ничего не стоит.
    const denyOnly = { allow: ['PowerShell(git push:*)'], deny: ['Bash(git push --force:*)'] };
    expect(bashAllowRules(denyOnly)).toEqual([]);
  });

  it('у каждой снятой команды осталась пара PowerShell', () => {
    // Снятие правил MUST NOT сужать круг доступных этапу команд. Проверяется
    // это перечнем, а не сверкой файла с самим собой: снятое правило исчезает
    // бесследно, и без записанного снимка потерю пары нечем поймать.
    expect(lostPairs(settings().permissions)).toEqual([]);
  });

  it('исключение объявлено явно и в перечень не входит', () => {
    // `git switch:*` — единственное из тридцати восьми снятых правил без
    // пары. Проба сторожит не столько сам факт, сколько его объявленность:
    // молчаливое исключение через полгода не отличить от забытой команды.
    expect(COVERED_COMMANDS).not.toContain(UNPAIRED_COMMAND);
    expect(settings().permissions.allow).not.toContain(`PowerShell(${UNPAIRED_COMMAND})`);
  });

  it('пропавшая пара делает сторожа красным и называет команду', () => {
    const withoutPush = {
      allow: settings().permissions.allow.filter((rule) => rule !== 'PowerShell(git push:*)'),
      deny: [],
    };
    expect(lostPairs(withoutPush)).toEqual(['git push:*']);
  });

  it('запреты сохранены в обеих оболочках', () => {
    expect(denyGapsBetweenShells(settings().permissions)).toEqual([]);
  });

  it('запрет, оставленный в одной оболочке, делает сторожа красным', () => {
    const halfDenied = { allow: [], deny: ['PowerShell(git push --force:*)'] };
    expect(denyGapsBetweenShells(halfDenied)).toEqual(['Bash(git push --force:*)']);
  });

  it('запрет с оператором вызова пары не требует', () => {
    // Полный путь к `gh.exe` через `& "..."` — форма PowerShell, и у Bash её
    // нет вовсе. Сторож, требующий ей пару, требовал бы бессмыслицы.
    const callOperator = {
      allow: [],
      deny: ['PowerShell(& "C:\\Program Files\\GitHub CLI\\gh.exe" repo delete:*)'],
    };
    expect(denyGapsBetweenShells(callOperator)).toEqual([]);
  });
});
