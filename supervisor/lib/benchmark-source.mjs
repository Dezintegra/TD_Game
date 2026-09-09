import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isLocalRun, runSourceProblem } from './run-source.mjs';
import { prepareDeploySnapshot } from './deploy-snapshot.mjs';
import { prepareCodexPerfFiles } from './codex-perf-files.mjs';
import { providerOf } from './provider.mjs';
import { benchmarkRunProblem } from './run-params.mjs';

/** Общая композиция запуска: ошибки источника должны предшествовать подготовке ACL. */
export function createAssignmentPreparer(root, config, ops = {}) {
  return (assignment, previous) => {
    if (assignment.stage === 'benchmark') {
      const problem = benchmarkRunProblem(assignment.task?.run);
      if (problem) throw new Error(`${assignment.taskId ?? assignment.task?.id}: ${problem}`);
    }
    const prepared = prepareBenchmarkSource(
      root,
      (ops.prepareDeploySnapshot ?? prepareDeploySnapshot)(root, config, assignment, previous),
      ops,
    );
    if (providerOf(config) === 'codex')
      (ops.prepareCodexPerfFiles ?? prepareCodexPerfFiles)(
        root,
        prepared.path ? resolve(root, prepared.path) : root,
      );
    return prepared;
  };
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** -z сохраняет пробелы и не зависит от Git core.quotePath. */
function worktrees(text) {
  const entries = [];
  let entry;
  for (const field of text.split('\0')) {
    if (field.startsWith('worktree ')) {
      entry = { path: field.slice(9), branch: null };
      entries.push(entry);
    } else if (entry && field.startsWith('branch ')) entry.branch = field.slice(7);
  }
  return entries;
}

/** Назначение каталога не передаёт владение чужим деревом задаче-прогону. */
export function prepareBenchmarkSource(root, assignment, ops = {}) {
  const run = assignment.task?.run;
  if (assignment.stage !== 'benchmark' || !isLocalRun(run)) return assignment;
  const problem = runSourceProblem(run);
  if (problem) throw new Error(problem);
  const source = run.params.source;
  const readGit = ops.git ?? git;
  const canonical = ops.realpath ?? realpathSync;
  try {
    const entries = worktrees(readGit(root, 'worktree', 'list', '--porcelain', '-z'));
    let matches;
    if (source.branch) {
      matches = entries.filter((entry) => entry.branch === `refs/heads/${source.branch}`);
    } else {
      const requested = canonical(resolve(root, source.worktree));
      matches = entries.filter((entry) => {
        // Чужая устаревшая запись не отменяет доступный явно выбранный источник.
        try {
          return canonical(entry.path) === requested;
        } catch {
          return false;
        }
      });
    }
    if (matches.length !== 1)
      throw new Error(
        `ожидалось одно доступное зарегистрированное дерево, найдено ${matches.length}`,
      );
    const path = canonical(matches[0].path);
    if (canonical(readGit(path, 'rev-parse', '--show-toplevel')) !== path)
      throw new Error('путь не является корнем рабочего дерева');
    const common = (cwd) =>
      canonical(readGit(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    if (common(path) !== common(root)) throw new Error('дерево принадлежит другому репозиторию');
    const ref = readGit(path, 'rev-parse', '--symbolic-full-name', 'HEAD');
    const branch =
      ref === 'HEAD' ? null : ref.startsWith('refs/heads/') ? ref.slice(11) : undefined;
    if (
      branch === undefined ||
      (source.branch && source.branch !== branch) ||
      matches[0].branch !== (branch === null ? null : `refs/heads/${branch}`)
    )
      throw new Error('ветка дерева изменилась или не соответствует источнику');
    const head = readGit(path, 'rev-parse', '--verify', 'HEAD');
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('неверный HEAD дерева');
    return { ...assignment, path, benchmarkSource: { source: { ...source }, path, branch, head } };
  } catch (error) {
    throw new Error(`run.params.source ${JSON.stringify(source)}: ${error.message}`, {
      cause: error,
    });
  }
}
