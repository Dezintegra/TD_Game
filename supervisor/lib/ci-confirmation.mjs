import { isDeepStrictEqual } from 'node:util';

export const CI_PR_FIELDS = 'mergeable,statusCheckRollup,number,url,state,headRefOid';
const validTime = (value) =>
  typeof value === 'string' &&
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) > 0 &&
  new Date(value).toISOString() === value.replace('Z', '.000Z');
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const requireData = (condition, why) => {
  if (!condition) throw new Error(why);
};
const pending = (why) => ({ state: 'pending', why: `подтверждение CI: ${why}` });

export function hasContradictoryCheck(pr) {
  return (
    Array.isArray(pr?.statusCheckRollup) &&
    pr.statusCheckRollup.some(
      (c) =>
        c?.__typename === 'CheckRun' &&
        c.status === 'IN_PROGRESS' &&
        c.conclusion === 'SUCCESS' &&
        validTime(c.completedAt),
    )
  );
}

const checkSnapshot = (checks) =>
  checks
    .map((c) => [
      c.__typename,
      c.id,
      c.detailsUrl,
      c.name,
      c.status,
      c.conclusion,
      c.startedAt,
      c.completedAt,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const runSnapshot = (r) => [
  r.id,
  r.run_attempt,
  r.head_sha,
  r.status,
  r.conclusion,
  r.workflow_id,
  r.created_at,
];

/** Успех задания не заменяет доказательство полного актуального CI. Кеш живёт только в этом вызове. */
export function confirmContradictoryCi({ pr, number, run }) {
  try {
    let calls = 0;
    const read = (args) => {
      requireData(calls < 30, 'исчерпан бюджет запросов');
      calls += 1;
      const result = run(args, 'gh', undefined, { timeout: 15000 });
      requireData(result?.code === 0, 'ответ GitHub недоступен');
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new Error('ответ GitHub не разобрался');
      }
    };
    const api = (path) => read(['api', path]);
    const url = new URL(pr.url);
    const match = url.pathname.match(
      /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/,
    );
    requireData(
      url.origin === 'https://github.com' &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password &&
        match &&
        Number(match[3]) === number &&
        pr.number === number &&
        pr.state === 'OPEN' &&
        /^[a-f0-9]{40}$/.test(pr.headRefOid),
      'не подтверждена идентичность PR',
    );
    const repo = `${match[1]}/${match[2]}`;
    const prefix = `repos/${repo}/actions/runs`;
    const identity = (r) => {
      requireData(
        r &&
          positiveId(r.id) &&
          positiveId(r.run_attempt) &&
          positiveId(r.workflow_id) &&
          validTime(r.created_at) &&
          r.repository?.full_name === repo &&
          r.head_sha === pr.headRefOid &&
          r.event === 'pull_request' &&
          Array.isArray(r.pull_requests) &&
          r.pull_requests.some(
            (p) =>
              p.number === number &&
              p.head?.sha === pr.headRefOid &&
              p.url === `https://api.github.com/repos/${repo}/pulls/${number}`,
          ),
        'не подтверждена принадлежность запуска',
      );
    };
    const pages = (path, key) => {
      const items = [];
      let total;
      for (let page = 1; ; page += 1) {
        const data = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        requireData(
          Number.isSafeInteger(data?.total_count) &&
            data.total_count >= 0 &&
            Array.isArray(data[key]) &&
            data[key].length <= 100,
          'неполная страница',
        );
        if (total === undefined) total = data.total_count;
        requireData(total === data.total_count, 'изменился размер набора');
        items.push(...data[key]);
        requireData(
          items.length <= total &&
            new Set(items.map((x) => x.id)).size === items.length &&
            items.every((x) => positiveId(x.id)),
          'неполный набор или дубликаты',
        );
        if (items.length === total) return items;
        requireData(data[key].length === 100, 'страница усечена');
      }
    };
    const groups = new Map();
    for (const c of pr.statusCheckRollup) {
      requireData(c?.__typename === 'CheckRun', 'неподдержанный тип проверки');
      const details = new URL(c.detailsUrl);
      const ids = details.pathname.match(
        /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/,
      );
      requireData(
        details.origin === url.origin &&
          !details.search &&
          !details.hash &&
          !details.username &&
          !details.password &&
          ids &&
          `${ids[1]}/${ids[2]}` === repo &&
          positiveId(Number(ids[3])) &&
          positiveId(Number(ids[4])),
        'неподтверждённая ссылка задания',
      );
      const id = Number(ids[3]);
      if (!groups.has(id)) groups.set(id, new Map());
      const checks = groups.get(id);
      requireData(!checks.has(Number(ids[4])), 'дубликат проверки');
      checks.set(Number(ids[4]), c);
    }
    const runs = new Map();
    const failed = [];
    let unfinished = false;
    let success = false;
    for (const [id, checks] of groups) {
      const r = api(`${prefix}/${id}`);
      identity(r);
      requireData(r.id === id, 'не совпал идентификатор запуска');
      runs.set(id, r);
      const jobs = pages(`${prefix}/${id}/attempts/${r.run_attempt}/jobs`, 'jobs');
      requireData(
        jobs.length > 0 && jobs.length === checks.size,
        'состав заданий не совпал с проверками',
      );
      if (r.status !== 'completed' || !r.conclusion) unfinished = true;
      else if (r.conclusion !== 'success') failed.push(`workflow ${id}`);
      for (const j of jobs) {
        const c = checks.get(j.id);
        requireData(
          c &&
            j.run_id === id &&
            j.run_attempt === r.run_attempt &&
            j.head_sha === pr.headRefOid &&
            j.name === c.name &&
            j.html_url === c.detailsUrl &&
            j.conclusion?.toUpperCase() === c.conclusion,
          'задание не совпало с проверкой или попыткой',
        );
        const times =
          validTime(j.started_at) &&
          validTime(j.completed_at) &&
          validTime(c.startedAt) &&
          validTime(c.completedAt) &&
          Date.parse(j.started_at) === Date.parse(c.startedAt) &&
          Date.parse(j.completed_at) === Date.parse(c.completedAt) &&
          Date.parse(j.started_at) <= Date.parse(j.completed_at);
        const completed = j.status === 'completed' && c.status === 'COMPLETED';
        const exception =
          ['completed', 'in_progress'].includes(j.status) &&
          ['COMPLETED', 'IN_PROGRESS'].includes(c.status) &&
          j.conclusion === 'success' &&
          r.status === 'completed' &&
          r.conclusion === 'success';
        if (!times || (!completed && !exception) || !j.conclusion) unfinished = true;
        if (completed && times && j.conclusion && !['success', 'skipped'].includes(j.conclusion))
          failed.push(c.name);
        if ((completed || exception) && times && j.conclusion === 'success') success = true;
      }
    }
    const listRuns = () => {
      const all = pages(`${prefix}?head_sha=${pr.headRefOid}&event=pull_request`, 'workflow_runs');
      // У фильтрованного Actions API предел 1000: равенство пределу не доказывает полноту.
      requireData(all.length < 1000, 'достигнут предел выдачи запусков');
      for (const r of all) {
        requireData(
          Array.isArray(r.pull_requests) && r.pull_requests.length > 0,
          'нет связи запусков с PR',
        );
        requireData(
          r.head_sha === pr.headRefOid &&
            r.repository?.full_name === repo &&
            r.event === 'pull_request',
          'несогласованный список запусков',
        );
      }
      const linked = all.filter((r) => r.pull_requests.some((p) => p.number === number));
      linked.forEach(identity);
      for (const r of runs.values()) {
        requireData(
          linked.some((x) => isDeepStrictEqual(runSnapshot(x), runSnapshot(r))),
          'запуск отсутствует в актуальном списке',
        );
      }
      for (const r of linked) {
        const represented = [...runs.values()].filter((x) => x.workflow_id === r.workflow_id);
        requireData(
          represented.length > 0 &&
            represented.every(
              (x) =>
                r.id === x.id ||
                (r.id < x.id && Date.parse(r.created_at) <= Date.parse(x.created_at)),
            ),
          'новый запуск ещё не представлен в проверках',
        );
      }
      return linked.map(runSnapshot).sort((a, b) => a[0] - b[0]);
    };
    const before = listRuns();
    const again = read(['pr', 'view', String(number), '--json', CI_PR_FIELDS]);
    if (again?.mergeable === 'CONFLICTING') return { state: 'conflict' };
    requireData(
      again?.mergeable === 'MERGEABLE' &&
        again.number === pr.number &&
        again.url === pr.url &&
        again.state === pr.state &&
        again.headRefOid === pr.headRefOid &&
        Array.isArray(again.statusCheckRollup) &&
        isDeepStrictEqual(
          checkSnapshot(again.statusCheckRollup),
          checkSnapshot(pr.statusCheckRollup),
        ),
      'PR изменился при повторной сверке',
    );
    for (const [id, r] of runs) {
      const latest = api(`${prefix}/${id}`);
      identity(latest);
      requireData(
        isDeepStrictEqual(runSnapshot(latest), runSnapshot(r)),
        'запуск или попытка изменились',
      );
    }
    requireData(isDeepStrictEqual(before, listRuns()), 'изменился список запусков');
    if (failed.length) return { state: 'failure', failed: failed.join(', ') };
    if (unfinished || !success) return pending('не все задания подтверждены завершёнными');
    return { state: 'success' };
  } catch (error) {
    return pending(error.message);
  }
}
