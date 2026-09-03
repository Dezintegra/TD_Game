import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
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
 * Где лежит схема записи бэклога.
 *
 * Своя схема проекта, если он её назвал, — от корня репозитория. Иначе
 * схема инструмента — от каталога инструмента. Никакого поиска в двух
 * местах по очереди: выбор делает наличие поля в настройке, а не наличие
 * файла на диске.
 *
 * Проверено пробой 01.09.2026: до этого путь всегда считался от корня,
 * и скопированный в чужой репозиторий инструмент падал на первом обороте
 * с голым `ENOENT` по `manage/schema.json`.
 */
export function schemaPath(root, config, home = root) {
  if (config.paths?.schema) return join(root, config.paths.schema);
  return isAbsolute(config.taskSchema) ? config.taskSchema : resolve(home, config.taskSchema);
}

/**
 * Прочитать задачи бэклога и разложить их на годные и негодные.
 *
 * Файл, чьё имя не совпадает с полем `id`, считается негодным: имя файла —
 * это имя ветки и рабочего дерева, и расхождение увело бы работу не туда.
 */
export function readTasks(root, config, home = root) {
  const dir = join(root, config.paths.tasks);
  const schema = loadSchema(schemaPath(root, config, home));

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
 * Прочитать, какие сессии этапов супервизор помнит.
 *
 * По идентификатору на пару «задача и этап». Помнить их нужно ради одного:
 * прерванный этап возобновляется той же сессией, а не начинается заново
 * с пересказом сделанного. Переживает перезапуск супервизора — иначе
 * упавший супервизор стирал бы память обо всех идущих этапах разом.
 *
 * Чтения отчётов с диска здесь больше нет вовсе: отчёт приходит выводом
 * процесса, и обходить за ним рабочие деревья не надо.
 */
export function readStages(root, config) {
  const path = join(root, config.paths.local, 'stages.json');
  if (!existsSync(path)) return {};
  const { value } = readJson(path);
  return value && typeof value === 'object' ? value : {};
}

/**
 * Прочитать правила разрешений, которые достанутся этапу ключом `--settings`.
 *
 * Путь считается **от каталога инструмента**: настройка разрешений — часть
 * самого инструмента, как и правила этапов (см. границу «своё — проектное»
 * в README). Абсолютный путь берётся как есть.
 *
 * Файла нет, файл не разобрался, поля `permissions` в нём нет — возвращается
 * `null`, и сканер по такому ответу не держит ни одной задачи. Обратное
 * решение — «не знаем, значит держим» — остановило бы конвейер целиком
 * из-за опечатки в пути; отсутствие файла к тому же уже названо осмотром
 * окружения при запуске.
 */
export function readPermissions(home, config) {
  if (!config.stageSettings) return null;
  const path = isAbsolute(config.stageSettings)
    ? config.stageSettings
    : resolve(home, config.stageSettings);
  if (!existsSync(path)) return null;

  const { value } = readJson(path);
  const permissions = value?.permissions;
  if (!permissions || typeof permissions !== 'object') return null;

  // Списки приводятся к массивам здесь, а не у читателя: сканер — чистый счёт,
  // и разбирать полуразобранную настройку не его дело.
  return {
    allow: Array.isArray(permissions.allow) ? permissions.allow : [],
    deny: Array.isArray(permissions.deny) ? permissions.deny : [],
  };
}

/** Взведён ли рубильник человека. Снимается только руками. */
export const isPaused = (root, config) => existsSync(join(root, config.paths.local, 'pause'));

/**
 * Взведена ли пауза сервера модели.
 *
 * Файл свой, а не поле в общем: такой файл пришлось бы читать и разбирать,
 * а его порча превратила бы обе паузы в неизвестность. Два файла — два
 * независимых признака, каждый читается существованием, и снятие одного
 * физически не может задеть другой.
 */
export const isApiPaused = (root, config) =>
  existsSync(join(root, config.paths.local, 'pause.api'));

/**
 * Состояние паузы сервера: когда взведена, сколько проб сделано, когда была
 * последняя.
 *
 * Испорченный или пустой файл даёт пустое состояние, а не исключение: пауза
 * при этом остаётся взведённой (её признак — само существование файла),
 * и первая же проба под ней сделается сразу. Терять из-за нечитаемой отметки
 * возможность узнать, что сервер ответил, было бы худшим из исходов.
 */
export function readApiPause(root, config) {
  const path = join(root, config.paths.local, 'pause.api');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      armedAt: parsed.armedAt ?? null,
      attempt: Number.isFinite(parsed.attempt) ? parsed.attempt : 0,
      lastProbeAt: Number.isFinite(parsed.lastProbeAt) ? parsed.lastProbeAt : null,
      status: parsed.status ?? null,
    };
  } catch {
    return { armedAt: null, attempt: 0, lastProbeAt: null, status: null };
  }
}

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
