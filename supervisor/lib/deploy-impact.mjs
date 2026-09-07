// Неизвестный путь требует обычной выкладки. Метка задачи не является доказательством.
const serviceDirectories = ['supervisor/', 'manage/', 'docs/', 'openspec/', '.agents/', '.claude/'];
export function servicePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '..' || part === '.' || part === '') &&
    (serviceDirectories.some((dir) => path.startsWith(dir)) || /^[^/]+\.md$/i.test(path))
  );
}

export function classifyDeployment(pr, files, number, mainBranch) {
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
    if (
      !servicePath(file.filename) ||
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
    return classifyDeployment(pr, pages.flat(), number, mainBranch);
  } catch {
    return { needed: true, reason: 'не удалось доказать служебный diff' };
  }
}
