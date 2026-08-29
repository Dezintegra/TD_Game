import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadSchema, validateTask } from './validate-task.mjs';

/**
 * Сбор картины мира для сканера.
 *
 * Здесь и только здесь конвейер трогает диск. Сканер остаётся чистым счётом,
 * а всё, что может не прочитаться, не разобраться или оказаться чужим,
 * разбирается тут — до того, как решение принято.
 *
 * Правило разбора одно: беда в одной записи не отменяет остальных. Задача
 * с испорченным JSON или не прошедшая схему откладывается с внятной
 * причиной, а конвейер продолжает работать с прочими. Иначе одна опечатка,
 * сделанная в полночь, останавливала бы всю очередь до утра.
 */

/**
 * Прочитать JSON, вернув `{ value, problem }` вместо исключения.
 *
 * Метка порядка байтов в начале файла срезается. Её ставят редакторы
 * и оболочки Windows — та же `Set-Content -Encoding utf8` пишет её всегда, —
 * а разбор JSON на ней спотыкается с невнятной жалобой на «неожиданный
 * символ». Задачу заводит человек, и отвергать его работу из-за невидимого
 * знака в начале файла нельзя.
 */
/**
 * Метка порядка байтов, записанная кодом, а не самим символом: в исходнике
 * она невидима, и линт справедливо считает её случайным пробелом.
 */
const BOM = String.fromCharCode(0xfeff);

function readJson(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const text = raw.startsWith(BOM) ? raw.slice(1) : raw;
    return { value: JSON.parse(text), problem: null };
  } catch (error) {
    return { value: null, problem: error.message };
  }
}

/** Перечислить файлы каталога с нужным расширением; нет каталога — пусто. */
function listFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .map((name) => join(dir, name));
}

/**
 * Прочитать задачи бэклога и разложить их на годные и негодные.
 *
 * Файл, чьё имя не совпадает с полем `id`, считается негодным: имя файла —
 * это имя ветки и рабочего дерева, и расхождение увело бы работу не туда.
 */
export function readTasks(root, config) {
  const dir = join(root, config.paths.tasks);
  const schema = loadSchema(join(root, config.paths.schema));

  const tasks = [];
  const invalid = [];

  for (const path of listFiles(dir, '.json')) {
    const name = basename(path, '.json');
    const { value, problem } = readJson(path);

    if (problem) {
      invalid.push({ id: name, problems: [`файл не разобрался: ${problem}`] });
      continue;
    }

    const problems = validateTask(value, schema);
    if (value.id !== name) {
      problems.push(`имя файла «${name}» не совпадает с полем id «${value.id}»`);
    }

    if (problems.length) invalid.push({ id: name, problems });
    else tasks.push(value);
  }

  return { tasks, invalid };
}

/** Прочитать местный реестр рабочих деревьев; нет файла — пустой реестр. */
export function readRegistry(root, config) {
  const path = join(root, config.paths.local, 'registry.json');
  if (!existsSync(path)) return { entries: [] };
  const { value, problem } = readJson(path);
  if (problem || !Array.isArray(value?.entries)) return { entries: [] };
  return value;
}

/**
 * Прочитать отчёты сессий, ожидающие переноса в бэклог.
 *
 * Смотрим не только в основное дерево, но и в каждое рабочее из реестра.
 * Причина не в удобстве: сессия с деревом ФИЗИЧЕСКИ не может положить
 * отчёт в основное. Запись за пределы своего каталога либо спрашивает
 * подтверждения, либо отвергается сразу — проверено опытом 29.08.2026,
 * сессия в дереве получила «edit the worktree copy of this file instead
 * of the shared-checkout path».
 *
 * Пока отчёт требовался в основном дереве, весь маршрут с деревьями —
 * проработка, аудит, имплементация, доработка, ревью, выкладка — упирался
 * в это на последнем шаге, уже сделав работу. Работали только этапы
 * без дерева: прогон и разбор, они и живут в основном.
 *
 * Отчёт без обязательных полей пропускается с причиной: применить его
 * вслепую значило бы двинуть задачу неизвестно куда.
 */
export function readReports(root, config, registry = { entries: [] }) {
  const dirs = [
    join(root, config.paths.local, 'reports'),
    // Порядок важен: основное дерево первым. Отчёт, оказавшийся в обоих
    // местах, — это остаток прежнего порядка, и верить надо тому, который
    // оркестратор уже видел.
    ...(registry.entries ?? []).map((entry) =>
      join(root, entry.path, config.paths.local, 'reports'),
    ),
  ];

  const reports = [];
  const problems = [];
  const seen = new Set();

  for (const path of dirs.flatMap((dir) => listFiles(dir, '.json'))) {
    const { value, problem } = readJson(path);
    if (problem) {
      problems.push(`отчёт ${path} не разобрался: ${problem}`);
      continue;
    }
    if (!value.taskId || !value.stage || !value.outcome) {
      problems.push(`отчёт ${path} неполон: нужны taskId, stage и outcome`);
      continue;
    }

    // Один отчёт на пару «задача и этап». Двойник означает остаток
    // прежнего порядка — берём первый найденный и говорим о втором вслух,
    // потому что молча выбранный из двух однажды окажется не тем.
    const id = `${value.taskId} ${value.stage}`;
    if (seen.has(id)) {
      problems.push(`отчёт ${path} — двойник уже найденного по ${id}, пропущен`);
      continue;
    }
    seen.add(id);

    reports.push({ ...value, path });
  }

  return { reports, problems };
}

/** Прочитать занятость слотов исполнителей. */
export function readSlots(root, config, slotNames) {
  const dir = join(root, config.paths.local, 'slots');
  const occupancy = {};
  for (const name of slotNames) {
    const path = join(dir, `${name}.json`);
    if (!existsSync(path)) continue;
    const { value } = readJson(path);
    if (value) occupancy[name] = value;
  }
  return occupancy;
}

/**
 * Прочитать снимок сессий, положенный оркестратором.
 *
 * Сам сценарий сессий не видит: он обычная программа на Node, а список
 * сессий отдаёт только сессия. Поэтому оркестратор перед прогоном
 * складывает снимок в файл, а счётная часть работает с ним как с обычными
 * входными данными — и остаётся проверяемой без всякой среды.
 *
 * Снимка нет — значит, о живости сессий ничего не известно. Это НЕ повод
 * считать их мёртвыми: продолжатель, порождённый по недоразумению, посадит
 * на одно дерево две сессии.
 */
export function readSessions(root, config) {
  const path = join(root, config.paths.local, 'sessions.json');
  if (!existsSync(path)) return { sessions: [], known: false };
  const { value } = readJson(path);
  if (!Array.isArray(value?.sessions)) return { sessions: [], known: false };
  return { sessions: value.sessions, known: true };
}

/** Взведён ли рубильник паузы. */
export const isPaused = (root, config) => existsSync(join(root, config.paths.local, 'pause'));

/**
 * Разобрать файл вопросов и понять, на какие из них уже ответили.
 *
 * Ответом считается непустая строка после пометки `**Ответ:**` внутри
 * раздела задачи. Пустая пометка — это ещё не ответ, а место для него.
 */
export function readAnswers(root, config) {
  const path = join(root, config.paths.questions);
  if (!existsSync(path)) return {};

  const text = readFileSync(path, 'utf8');
  const answers = {};

  // Разделы вида `### <идентификатор задачи>` до следующего такого же.
  const sections = text.split(/^### /m).slice(1);
  for (const section of sections) {
    const id = section.slice(0, section.indexOf('\n')).trim();
    const marker = section.indexOf('**Ответ:**');
    if (marker === -1) continue;
    const answer = section.slice(marker + '**Ответ:**'.length).trim();
    if (answer.length > 0) answers[id] = answer;
  }

  return answers;
}
