import { createIo } from './io.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { CI_PR_FIELDS } from './ci-confirmation.mjs';

export const REVIEW_CI_CODES = { success: 0, failure: 1, pending: 2, conflict: 3 };

export function parseReviewCiArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--pr', '--head'].includes(key) || key in values || !args[i + 1])
      throw new Error('ожидаются ровно --pr <номер> --head <полный SHA>');
    values[key] = args[i + 1];
  }
  const pr = Number(values['--pr']);
  if (!/^[1-9][0-9]*$/.test(values['--pr']) || !Number.isSafeInteger(pr))
    throw new Error('PR должен быть положительным безопасным целым');
  if (!/^[a-fA-F0-9]{40}$/.test(values['--head']))
    throw new Error('head должен быть полным 40-значным SHA');
  return { pr, head: values['--head'].toLowerCase() };
}

/** Guard связывает общий результат с рассматриваемым кодом; успех CI считает только io. */
export function reviewCi({ pr, head, run }) {
  let observedHead = null;
  let url = null;
  let conflict = false;
  let invalid = null;
  let calls = 0;
  let usedConfirmation = false;
  const runs = new Map();
  const observe = (args, program) => {
    const isPr =
      JSON.stringify(args) === JSON.stringify(['pr', 'view', String(pr), '--json', CI_PR_FIELDS]);
    const isApi = args.length === 2 && args[0] === 'api' && args[1].startsWith('repos/');
    if (program !== 'gh' || (!isPr && !isApi)) throw new Error('неразрешённая команда чтения');
    if (calls >= 31) throw new Error('исчерпан бюджет запросов');
    calls += 1;
    usedConfirmation ||= isApi;
    const result = run(args, 'gh', undefined, { timeout: 15000 });
    if (result?.code !== 0) throw new Error('ответ GitHub недоступен или истёк тайм-аут');
    let data;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      throw new Error('ответ GitHub не разобрался');
    }
    if (isPr) {
      observedHead = typeof data?.headRefOid === 'string' ? data.headRefOid : null;
      url = typeof data?.url === 'string' ? data.url : null;
      conflict ||= data?.mergeable === 'CONFLICTING';
      let validUrl = false;
      try {
        const parsed = new URL(url);
        validUrl =
          parsed.origin === 'https://github.com' &&
          !parsed.search &&
          !parsed.hash &&
          !parsed.username &&
          !parsed.password &&
          new RegExp(`^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/${pr}$`).test(parsed.pathname);
      } catch {
        /* Непригодная идентичность никогда не разрешает success. */
      }
      if (!validUrl || data?.number !== pr || data?.state !== 'OPEN' || observedHead !== head)
        invalid = 'не совпали идентичность открытого PR или ожидаемый SHA';
      if (invalid && !conflict) throw new Error(invalid);
    } else if (data && Number.isSafeInteger(data.id) && Number.isSafeInteger(data.run_attempt)) {
      runs.set(data.id, { id: data.id, attempt: data.run_attempt, head: data.head_sha });
    }
    return result;
  };
  let summary;
  try {
    summary = createIo({ root: '.', config: resolveConfig({}).config, run: observe }).readExternal(
      { links: { pr } },
      'ci',
    );
  } catch (error) {
    summary = { state: 'pending', why: error.message };
  }
  if (conflict) summary = { state: 'conflict', why: 'GitHub сообщает конфликт с main' };
  else if (invalid) summary = { state: 'pending', why: invalid };
  const confirmed = summary.state === 'success' && usedConfirmation;
  return {
    ...summary,
    pr,
    url,
    expectedHead: head,
    observedHead,
    why:
      summary.why ??
      summary.failed ??
      (summary.state === 'success' ? 'CI подтверждён' : summary.state),
    mode: confirmed ? 'confirmed' : 'ordinary',
    runs: confirmed ? [...runs.values()] : [],
  };
}

/** Один JSON даже при неверных доводах; транспорт до их проверки не вызывается. */
export function runReviewCiCli(args, run, write) {
  let input;
  try {
    input = parseReviewCiArgs(args);
  } catch (error) {
    write(
      `${JSON.stringify({
        state: 'pending',
        pr: null,
        url: null,
        expectedHead: null,
        observedHead: null,
        why: error.message,
        mode: 'ordinary',
        runs: [],
      })}\n`,
    );
    return 64;
  }
  const result = reviewCi({ ...input, run });
  write(`${JSON.stringify(result)}\n`);
  return REVIEW_CI_CODES[result.state];
}
