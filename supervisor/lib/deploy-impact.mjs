import { isDeepStrictEqual } from 'node:util';
import { Buffer } from 'node:buffer';

// Неизвестный путь требует обычной выкладки. Метка задачи не является доказательством.
const serviceDirectories = [
  'supervisor/',
  'plugins/pipeline/',
  'manage/',
  'docs/',
  'openspec/',
  '.agents/',
  '.claude/',
];
export function servicePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '..' || part === '.' || part === '') &&
    (serviceDirectories.some((dir) => path.startsWith(dir)) ||
      path === 'scripts/supervisor-scripts.test.mjs' ||
      /^[^/]+\.md$/i.test(path))
  );
}

export function supervisorPackageOnly(before, after) {
  const ordinary = (document) => {
    if (
      !document ||
      typeof document !== 'object' ||
      Array.isArray(document) ||
      !document.scripts ||
      typeof document.scripts !== 'object' ||
      Array.isArray(document.scripts)
    )
      throw new Error('invalid package document');
    return {
      ...document,
      scripts: Object.fromEntries(
        Object.entries(document.scripts).filter(
          ([key]) => key !== 'supervisor' && !key.startsWith('supervisor:'),
        ),
      ),
    };
  };
  try {
    return isDeepStrictEqual(ordinary(before), ordinary(after));
  } catch {
    return false;
  }
}

export function classifyDeployment(pr, files, number, mainBranch, packageDocuments) {
  const deploy = (reason) => ({ needed: true, reason });
  if (
    pr?.number !== number ||
    pr.merged !== true ||
    !pr.merged_at ||
    !Number.isFinite(Date.parse(pr.merged_at)) ||
    pr.base?.ref !== mainBranch ||
    !/^[a-f0-9]{40}$/i.test(pr.merge_commit_sha ?? '')
  )
    return deploy('вливание PR в главную ветку не доказано');
  if (
    !Number.isInteger(pr.changed_files) ||
    pr.changed_files < 1 ||
    pr.changed_files > 3000 ||
    !Array.isArray(files) ||
    files.some((file) => !file || typeof file !== 'object') ||
    files.length !== pr.changed_files ||
    new Set(files.map((f) => f.filename)).size !== files.length
  )
    return deploy('полный список изменённых файлов не подтверждён');
  for (const file of files) {
    if (
      !['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'].includes(
        file.status,
      )
    )
      return deploy('неизвестный вид изменения файла');
    const packageOnly =
      file.filename === 'package.json' &&
      file.status === 'modified' &&
      !file.previous_filename &&
      packageDocuments &&
      supervisorPackageOnly(packageDocuments.before, packageDocuments.after);
    if (
      (!servicePath(file.filename) && !packageOnly) ||
      (file.previous_filename != null && !servicePath(file.previous_filename)) ||
      (file.status === 'renamed' && !file.previous_filename)
    )
      return deploy('затронуты игровые, сборочные или неизвестные пути');
  }
  return {
    needed: false,
    reason: `PR #${number} влит; все ${files.length} файлов служебные`,
    mergeCommit: pr.merge_commit_sha,
  };
}

export function readDeploymentImpact({ run, root, number, mainBranch }) {
  if (!Number.isInteger(number) || number < 1) return { needed: true, reason: 'нет номера PR' };
  const read = (args) => {
    const answer = run(args, 'gh', root, { timeout: 10_000 });
    if (answer.code !== 0) throw new Error('GitHub недоступен');
    return JSON.parse(answer.stdout);
  };
  try {
    const endpoint = `repos/{owner}/{repo}/pulls/${number}`;
    const pr = read(['api', endpoint]);
    if (!pr.merged || !Number.isInteger(pr.changed_files) || pr.changed_files > 3000)
      return { needed: true, reason: 'вливание или размер diff не подтверждены' };
    const pages = read(['api', `${endpoint}/files?per_page=100`, '--paginate', '--slurp']);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
      return { needed: true, reason: 'список файлов не разобран' };
    const files = pages.flat();
    let packageDocuments;
    if (files.some((file) => file?.filename === 'package.json')) {
      const document = (sha) => {
        if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('unverified package revision');
        const blob = read(['api', `repos/{owner}/{repo}/contents/package.json?ref=${sha}`]);
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string')
          throw new Error('package content unavailable');
        return JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      };
      packageDocuments = { before: document(pr.base?.sha), after: document(pr.head?.sha) };
    }
    return classifyDeployment(pr, files, number, mainBranch, packageDocuments);
  } catch {
    return { needed: true, reason: 'не удалось доказать служебный diff' };
  }
}
