import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

function fail(reason) {
  throw new Error(`project-skill-writes: ${reason}`);
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => new Set(values).size === values.length;

/** Нормализация не должна превращать опасный ввод в разрешённый путь. */
export function skillRelativePath(value) {
  if (
    typeof value !== 'string' ||
    !/^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/.test(value)
  )
    fail('требуется точный относительный .agents/skills/<имя>/SKILL.md');
  return value;
}

export function pathWithin(base, target, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value) => {
    const normalized = api.resolve(value);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const rel = api.relative(normalize(base), normalize(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

function samePath(a, b) {
  return (
    !pathWithin(a, b) &&
    !pathWithin(b, a) &&
    (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  );
}

function ordinary(file, directory = false) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))
    fail(`ссылка или неподдерживаемый тип: ${file}`);
  if (!directory && stat.nlink !== 1) fail(`многоссылочный файл: ${file}`);
  // lstat распознаёт symlink/junction, но не все прочие Windows reparse tags.
  if (process.platform === 'win32') {
    const attributes = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -Force -LiteralPath '${file.replaceAll("'", "''")}' -ErrorAction Stop).Attributes.value__`,
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (!/^[0-9]+$/.test(attributes) || (Number(attributes) & 1024) !== 0)
      fail(`reparse point или неизвестные атрибуты: ${file}`);
  }
  if (!samePath(path.resolve(file), realpathSync(file))) fail(`перенаправленный путь: ${file}`);
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function validateTree(root, cwd, assignment) {
  ordinary(root, true);
  ordinary(cwd, true);
  if (samePath(root, cwd)) fail('основное дерево не является назначенным связанным деревом');
  if (!assignment.path || !samePath(path.resolve(root, assignment.path), cwd))
    fail('cwd не совпадает с назначением');
  if (assignment.branch && assignment.branch !== `worktree-${assignment.taskId}`)
    fail('ветка назначения не принадлежит задаче');
  ordinary(path.join(cwd, '.git'));
  const common = realpathSync(path.join(root, '.git'));
  const gitdir = git(cwd, 'rev-parse', '--absolute-git-dir');
  if (!pathWithin(common, gitdir)) fail('gitdir вне общей .git');
  ordinary(gitdir, true);
  if (
    !samePath(
      realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
      common,
    )
  )
    fail('чужой Git-репозиторий');
  if (!samePath(realpathSync(git(cwd, 'rev-parse', '--show-toplevel')), cwd))
    fail('cwd не является корнем дерева');
  if (git(cwd, 'symbolic-ref', '--short', 'HEAD') !== `worktree-${assignment.taskId}`)
    fail('ветка не принадлежит задаче');
  const registered = git(root, 'worktree', 'list', '--porcelain', '-z').split('\0');
  if (
    !registered.some(
      (line) => line.startsWith('worktree ') && samePath(path.resolve(line.slice(9)), cwd),
    )
  )
    fail('дерево отсутствует в реестре Git');
}

/** Источник — поставленный home; cwd и текст карточки не задают перечень прав. */
export function resolveProjectSkillWrites({
  home,
  root,
  cwd,
  assignment,
  platform = process.platform,
}) {
  const source = path.resolve(home, 'config/project-skill-writes.json');
  const raw = readFileSync(source, 'utf8');
  const digest = createHash('sha256').update(raw).digest('hex');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    fail('невалидный JSON перечня');
  }
  if (!object(manifest) || manifest.version !== 1 || !Array.isArray(manifest.entries))
    fail('неподдерживаемая схема перечня');
  const ids = [];
  for (const entry of manifest.entries) {
    if (
      !object(entry) ||
      typeof entry.taskId !== 'string' ||
      !/^[0-9]{4}-[a-z0-9-]+$/.test(entry.taskId) ||
      typeof entry.change !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.change) ||
      !Array.isArray(entry.stages) ||
      !entry.stages.length ||
      !unique(entry.stages) ||
      entry.stages.some((stage) => !['implement', 'revise'].includes(stage)) ||
      !Array.isArray(entry.files) ||
      !entry.files.length ||
      !unique(entry.files)
    )
      fail('повреждённая запись перечня');
    entry.files.forEach(skillRelativePath);
    ids.push(entry.taskId);
  }
  if (!unique(ids)) fail('повтор taskId в перечне');
  const empty = { files: [], digest, source };
  const entry = manifest.entries.find(
    (candidate) =>
      candidate.taskId === assignment.taskId || candidate.taskId === assignment.task?.id,
  );
  if (!entry || !entry.stages.includes(assignment.stage)) return empty;
  if (
    assignment.taskId !== entry.taskId ||
    assignment.task?.id !== assignment.taskId ||
    assignment.task?.links?.change !== entry.change
  )
    fail('task/change не совпадают с доверенным назначением');
  if (platform !== 'win32') fail('точечные права подтверждаются только Windows-маршрутом');
  root = path.resolve(root);
  cwd = path.resolve(cwd);
  validateTree(root, cwd, assignment);
  const files = entry.files.map((relative) => {
    const components = relative.split('/');
    let current = cwd;
    for (const [i, component] of components.entries()) {
      current = path.join(current, component);
      ordinary(current, i !== components.length - 1);
    }
    if (!pathWithin(cwd, current)) fail('файл вне назначенного дерева');
    return current;
  });
  return { files, digest, source };
}
