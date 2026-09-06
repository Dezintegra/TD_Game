import { isAbsolute, join, resolve } from 'node:path';
import { providerOf, codexInvocation } from './provider.mjs';
import { schemaPath } from './read-state.mjs';

/**
 * Что супервизор нашёл вокруг себя.
 *
 * Проверяется один раз, при запуске, и ничего не чинит — только называет.
 * Смысл в том, чтобы нехватка была видна в момент запуска, а не выяснялась
 * отказом на третьем часу работы. На чужой машине это половина всех бед:
 * нет `gh`, не тот путь к правилам, пустой токен доски, — и каждая из них
 * иначе проявляется отдалённым и невнятным симптомом.
 *
 * Запуск внешних программ приходит доводом. Не ради чистоты: иначе проверку
 * пришлось бы проверять настоящими запусками, а их четыре, и каждый
 * не бесплатен.
 */

/** Ниже этой версии нет `process.loadEnvFile`, а на нём стоит чтение `.env`. */
const NEEDED_NODE = [20, 12];

/**
 * Осмотреться.
 *
 * @param {object} params
 * @param {string} params.home     каталог инструмента
 * @param {string} params.root     корень проекта
 * @param {object} params.config   настройка после слияния с умолчаниями
 * @param {Function} params.run    запуск программы: `(программа, доводы) => { code, stdout }`
 * @param {Function} params.exists есть ли файл или каталог по пути
 * @param {string} [params.nodeVersion]
 * @param {object} [params.env]    переменные окружения
 * @param {string[]} [params.envFiles] найденные файлы `.env`
 * @returns {{ rows: Array, problems: string[], fatal: string|null }}
 */
export function checkEnvironment({
  home,
  root,
  config,
  run,
  exists,
  nodeVersion = process.versions.node,
  env = process.env,
  envFiles = [],
}) {
  const rows = [];
  const problems = [];
  let fatal = null;
  const provider = providerOf(config);
  rows.push(['исполнитель', provider]);
  if (
    provider === 'codex' &&
    config.codexMaxTaskTokens != null &&
    (!Number.isSafeInteger(config.codexMaxTaskTokens) || config.codexMaxTaskTokens <= 0)
  ) {
    fatal = 'Codex: codexMaxTaskTokens должен быть положительным целым числом или null.';
  }
  if (provider === 'codex') {
    rows.push([
      'разрешения Codex',
      process.platform === 'win32'
        ? `td-pipeline, Windows ${config.codexWindowsSandbox ?? 'elevated'}, сеть, never`
        : 'workspace-write, сеть, never',
    ]);
    if (!['elevated', 'unelevated'].includes(config.codexWindowsSandbox ?? 'elevated'))
      fatal = 'codexWindowsSandbox: требуется elevated или unelevated';
  }

  const own = (path) => (isAbsolute(path) ? path : resolve(home, path));

  // Среда исполнения.
  const node = tooOld(nodeVersion, NEEDED_NODE)
    ? `v${nodeVersion} — СТАРА, нужна ${NEEDED_NODE.join('.')} и новее`
    : `v${nodeVersion}`;
  rows.push(['node', node]);
  if (tooOld(nodeVersion, NEEDED_NODE)) {
    problems.push(
      `среда исполнения устарела: нужна Node ${NEEDED_NODE.join('.')} и новее — ` +
        'на ней появилось чтение `.env`, без которого доступ к доске взять неоткуда',
    );
  }

  // Внешние программы. Порядок по важности: без первой не работает ничего.
  const programs = [
    [
      provider === 'codex' ? (config.codexCommand ?? 'codex') : config.claudeCommand,
      'этапы порождаются им; без него конвейер не сделает ни шага',
    ],
    ['git', 'ветки, деревья и коммиты — всё через него'],
    ['gh', 'опрос проверок CI и вливание pull request; без него маршрут встанет на проверках'],
  ];
  for (const [program, why] of programs) {
    const query =
      provider === 'codex' && program === (config.codexCommand ?? 'codex')
        ? codexInvocation(config, ['--version'])
        : null;
    const found = query
      ? version(() => run(query.program, query.args), program)
      : version(run, program);
    rows.push([program, found ?? 'НЕ НАЙДЕНА']);
    if (!found) problems.push(`программа «${program}» не найдена: ${why}`);
  }

  // Свои файлы инструмента.
  const skills = own(config.skillsDir);
  rows.push(['правила этапов', exists(skills) ? skills : `${skills} — НЕТ`]);
  if (!exists(skills)) {
    fatal =
      `каталог правил этапов не найден: ${skills}. Без него всякий порождённый ` +
      'этап пойдёт работать без своих правил — а это хуже, чем не работать вовсе, ' +
      'потому что заметить такое нечем: приложение ключ на несуществующий файл ' +
      'не отвергает';
  }

  if (provider === 'claude' && config.stageSettings) {
    const settings = own(config.stageSettings);
    rows.push(['разрешения этапа', exists(settings) ? settings : `${settings} — НЕТ`]);
    if (!exists(settings)) {
      problems.push(
        `настройка разрешений не найдена: ${settings}. Этапу не достанется никакой ` +
          'другой, и каждое действие вне рабочего каталога обернётся отказом',
      );
    }
  }

  // Схема записи нужна только файловому бэклогу: карточки доски проверяются
  // иначе. Требовать её у проекта на доске значило бы жаловаться на файл,
  // который никогда не будет прочитан.
  if (config.backlog !== 'trello') {
    const schema = schemaPath(root, config, home);
    rows.push(['схема записи', exists(schema) ? schema : `${schema} — НЕТ`]);
    if (!exists(schema)) {
      fatal =
        `схема записи бэклога не найдена: ${schema}. Файловый бэклог без неё ` +
        'не читается вовсе — прежде это выяснялось падением на первом обороте';
    }
  }

  // Проектное хозяйство.
  rows.push(['хозяйство', join(root, config.paths.local)]);

  // Переменные окружения.
  rows.push(['файлы .env', envFiles.length > 0 ? envFiles.join(', ') : 'не найдены']);

  if (config.backlog === 'trello') {
    for (const name of ['TRELLO_KEY', 'TRELLO_TOKEN']) {
      const given = Boolean(env[name]);
      rows.push([name, given ? `задан (${mask(env[name])})` : 'НЕ ЗАДАН']);
      if (!given) {
        problems.push(
          `${name} не задан: бэклог живёт на доске, и без доступа к ней цикл ` +
            'остановится на первом же обороте. Смотрите supervisor/.env.example',
        );
      }
    }
    if (!config.trello?.board) {
      problems.push('идентификатор доски не назван в настройке: `trello.board`');
    }
  }

  return { rows, problems, fatal };
}

/** Версия программы одной строкой. `null`, если её нет вовсе. */
function version(run, program) {
  if (!program) return null;
  const answer = run(program, ['--version']);
  if (!answer || answer.code !== 0) return null;
  const line = String(answer.stdout ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line || 'есть';
}

/** Старше ли версия требуемой. Сравниваются только старшие два числа. */
function tooOld(given, [major, minor]) {
  const [haveMajor = 0, haveMinor = 0] = String(given ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  if (haveMajor !== major) return haveMajor < major;
  return haveMinor < minor;
}

/**
 * Показать, что значение задано, не показав его самого.
 *
 * Вывод супервизора уезжает в журнал сторожа, а оттуда — в чужие руки
 * при первом же разборе беды. Токен доски там появляться не должен, но
 * и «задан» без единого знака не отличает верное значение от опечатки.
 */
function mask(value) {
  const text = String(value ?? '');
  if (text.length <= 8) return '…';
  return `${text.slice(0, 4)}…${text.slice(-2)}, знаков ${text.length}`;
}
