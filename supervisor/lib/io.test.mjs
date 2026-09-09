import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { URLSearchParams } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createIo, summariseChecks, summarisePullRequest } from './io.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';

it('читает и подтверждает ту же устойчивую очередь по reportId', () => {
  const f = deliveryFixture();
  try {
    const { config } = resolveConfig({});
    const reportStore = f.open().store;
    const io = createIo({ root: f.root, config, reportStore });
    expect(io.readReport(f.task.id, f.report.stage, f.entry.reportId)).toEqual(f.report);
    expect(() => io.removeReport(f.task.id, f.report.stage)).toThrow('reportId');
    io.removeReport(f.task.id, f.report.stage, f.entry.reportId);
    expect(reportStore.entries()).toEqual([]);
    expect(f.open().store.entries()).toEqual([]);
  } finally {
    f.cleanup();
  }
});

/**
 * Проверки сведения состояния проверок CI к одному ответу.
 *
 * Проверяется именно эта часть переходника: всё остальное в нём — склейка
 * путей и запись файлов, где ошибаться негде, а вот «зелено ли» решает,
 * начнётся ли ревью и вольётся ли pull request.
 */

const check = (name, status, conclusion) => ({ name, status, conclusion });

// Только исходные PR/run/jobs фактические; список runs и повторные ответы моделируются.
const ciObservation = JSON.parse(
  readFileSync(new URL('./testing/ci-pr-219.json', import.meta.url), 'utf8'),
);
function confirmationFixture(edit = () => {}, intercept = () => null) {
  const f = JSON.parse(JSON.stringify(ciObservation));
  f.runs = [f.run];
  edit(f);
  const calls = [];
  const run = (args, tool, _cwd, options) => {
    calls.push({ args, tool, options });
    const override = intercept(args, calls.length, f);
    if (override) return override;
    let data;
    if (args[0] === 'pr') data = f.pr;
    else if (args[1].includes('/jobs?')) {
      const id = Number(args[1].split('/runs/')[1].split('/')[0]);
      const jobs = f.jobs.jobs.filter((j) => j.run_id === id);
      const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
      data = { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) };
    } else if (args[1].includes('?head_sha=')) {
      const page = Number(new URLSearchParams(args[1].split('?')[1]).get('page'));
      data = {
        total_count: f.runs.length,
        workflow_runs: f.runs.slice((page - 1) * 100, page * 100),
      };
    } else data = f.runs.find((r) => r.id === Number(args[1].split('/').at(-1)));
    return { code: 0, stdout: JSON.stringify(data) };
  };
  const io = createIo({ root: '.', config: resolveConfig({}).config, run });
  return { f, calls, poll: () => io.readExternal({ links: { pr: 219 } }, 'ci') };
}

describe('подтверждение противоречивого CI через readExternal', () => {
  it('разрешает фактическое противоречие обеих API с четырьмя SKIPPED', () => {
    const f = confirmationFixture();
    expect(summarisePullRequest(JSON.stringify(f.f.pr)).state).toBe('pending');
    expect(f.poll()).toEqual({ state: 'success' });
    expect(f.calls).toHaveLength(7);
    expect(f.calls[2].args[1]).toContain('/attempts/1/jobs?per_page=100&page=1');
    expect(f.calls.filter((c) => c.args[0] === 'pr')).toHaveLength(2);
    expect(f.calls.every((c) => c.tool === 'gh')).toBe(true);
    expect(f.calls.slice(1).every((c) => c.options.timeout === 15000)).toBe(true);
  });

  it.each([
    [
      'workflow работает',
      (f) => {
        f.run.status = 'in_progress';
        f.run.conclusion = null;
      },
    ],
    [
      'задание работает',
      (f) => {
        f.jobs.jobs[1].status = 'in_progress';
        f.jobs.jobs[1].conclusion = null;
        f.pr.statusCheckRollup[1].status = 'IN_PROGRESS';
        f.pr.statusCheckRollup[1].conclusion = null;
      },
    ],
    [
      'нет времени задания',
      (f) => {
        f.jobs.jobs[0].completed_at = null;
      },
    ],
    [
      'время задания не совпало',
      (f) => {
        f.jobs.jobs[0].completed_at = '2026-09-08T20:39:28Z';
      },
    ],
    [
      'нет conclusion',
      (f) => {
        f.jobs.jobs[0].conclusion = null;
      },
    ],
    [
      'SHA запуска',
      (f) => {
        f.run.head_sha = 'a'.repeat(40);
      },
    ],
    [
      'SHA задания',
      (f) => {
        f.jobs.jobs[0].head_sha = 'a'.repeat(40);
      },
    ],
    [
      'repo запуска',
      (f) => {
        f.run.repository.full_name = 'other/repo';
      },
    ],
    [
      'PR запуска',
      (f) => {
        f.run.pull_requests[0].number = 220;
      },
    ],
    [
      'head связи PR',
      (f) => {
        f.run.pull_requests[0].head.sha = 'a'.repeat(40);
      },
    ],
    [
      'ссылка в другой repo',
      (f) => {
        f.pr.statusCheckRollup[0].detailsUrl = f.pr.statusCheckRollup[0].detailsUrl.replace(
          'TD_Game',
          'Other',
        );
      },
    ],
    [
      'другой job ID',
      (f) => {
        f.jobs.jobs[0].id += 1;
      },
    ],
    [
      'другой run ID задания',
      (f) => {
        f.jobs.jobs[0].run_id += 1;
      },
    ],
    [
      'новая попытка',
      (f) => {
        f.run.run_attempt += 1;
      },
    ],
    [
      'другой attempt задания',
      (f) => {
        f.jobs.jobs[0].run_attempt += 1;
      },
    ],
    [
      'потеря задания',
      (f) => {
        f.jobs.jobs.pop();
      },
    ],
    [
      'лишнее задание',
      (f) => {
        f.jobs.jobs.push({ ...f.jobs.jobs[0], id: 99 });
      },
    ],
    [
      'дубликат задания',
      (f) => {
        f.jobs.jobs.push(f.jobs.jobs[0]);
      },
    ],
    [
      'дубликат проверки',
      (f) => {
        f.pr.statusCheckRollup.push(f.pr.statusCheckRollup[0]);
      },
    ],
    [
      'неизвестный тип',
      (f) => {
        f.pr.statusCheckRollup[1].__typename = 'StatusContext';
      },
    ],
    [
      'новый run',
      (f) => {
        f.runs.push({ ...f.run, id: f.run.id + 1, status: 'in_progress', conclusion: null });
      },
    ],
    [
      'новый workflow',
      (f) => {
        f.runs.push({ ...f.run, id: f.run.id + 1, workflow_id: 99 });
      },
    ],
  ])('%s сохраняет pending', (_name, edit) => {
    const f = confirmationFixture(edit);
    expect(f.poll().state).toBe('pending');
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'])(
    'конечный %s даёт failure',
    (conclusion) => {
      for (const target of ['job', 'run']) {
        const f = confirmationFixture((data) => {
          if (target === 'run') data.run.conclusion = conclusion.toLowerCase();
          else {
            data.pr.statusCheckRollup[1].conclusion = conclusion;
            data.jobs.jobs[1].conclusion = conclusion.toLowerCase();
          }
        });
        expect(f.poll().state).toBe('failure');
      }
    },
  );

  it.each(['CONFLICTING', 'UNKNOWN'])('%s имеет приоритет в обоих чтениях', (mergeable) => {
    const first = confirmationFixture((f) => {
      f.pr.mergeable = mergeable;
    });
    expect(first.poll().state).toBe(mergeable === 'CONFLICTING' ? 'conflict' : 'pending');
    expect(first.calls).toHaveLength(1);
    const second = confirmationFixture(
      () => {},
      (args, n, f) => {
        if (args[0] === 'pr' && n > 1) f.pr.mergeable = mergeable;
      },
    );
    expect(second.poll().state).toBe(mergeable === 'CONFLICTING' ? 'conflict' : 'pending');
  });

  it.each(['head', 'checks', 'attempt', 'runs', 'conclusion'])(
    'смена %s во время сверки отменяет успех',
    (field) => {
      const f = confirmationFixture(
        () => {},
        (_args, n, data) => {
          if (n === 5 && field === 'head') data.pr.headRefOid = 'b'.repeat(40);
          if (n === 5 && field === 'checks') data.pr.statusCheckRollup[1].name = 'changed';
          if (n === 6 && field === 'attempt') data.run.run_attempt += 1;
          if (n === 6 && field === 'conclusion') data.run.conclusion = 'failure';
          if (n === 7 && field === 'runs') data.runs.push({ ...data.run, id: data.run.id + 1 });
        },
      );
      expect(f.poll().state).toBe('pending');
    },
  );

  it('перестановка проверок не отменяет доказательство', () => {
    const f = confirmationFixture(
      () => {},
      (_args, n, data) => {
        if (n === 5) data.pr.statusCheckRollup.reverse();
      },
    );
    expect(f.poll().state).toBe('success');
  });

  it.each([1, 2, 3, 4, 5, 6, 7])(
    'ошибка или повреждённый JSON запроса %s не дают успеха',
    (step) => {
      for (const result of [{ code: 1 }, { code: 0, stdout: '{' }, { code: 0, stdout: 'null' }]) {
        const f = confirmationFixture(
          () => {},
          (_args, n) => (n === step ? result : null),
        );
        expect(f.poll().state).toBe('pending');
      }
    },
  );

  it.each(['status', 'conclusion', 'completedAt'])('без тройки (%s) нет fallback', (field) => {
    const f = confirmationFixture((data) => {
      data.pr.statusCheckRollup[0][field] = null;
    });
    expect(f.poll().state).toBe('pending');
    expect(f.calls).toHaveLength(1);
  });

  it('обычный SUCCESS/SKIPPED и все SKIPPED обходятся одним чтением', () => {
    for (const skipped of [false, true]) {
      const f = confirmationFixture((data) => {
        data.pr.statusCheckRollup.forEach((c) => {
          c.status = 'COMPLETED';
          if (skipped) c.conclusion = 'SKIPPED';
        });
      });
      expect(f.poll().state).toBe(skipped ? 'pending' : 'success');
      expect(f.calls).toHaveLength(1);
    }
  });

  function manyJobs(f) {
    for (let i = 0; i < 101; i += 1) {
      const id = 200000000000 + i;
      const c = {
        ...f.pr.statusCheckRollup[1],
        name: `matrix ${i}`,
        detailsUrl: f.pr.statusCheckRollup[1].detailsUrl.replace(/job\/[0-9]+$/, `job/${id}`),
      };
      f.pr.statusCheckRollup.push(c);
      f.jobs.jobs.push({ ...f.jobs.jobs[1], id, name: c.name, html_url: c.detailsUrl });
    }
  }

  it('проверяет несколько страниц jobs и несколько workflows', () => {
    const f = confirmationFixture((data) => {
      manyJobs(data);
      const other = { ...data.run, id: data.run.id + 1, workflow_id: data.run.workflow_id + 1 };
      data.runs.push(other);
      const c = data.pr.statusCheckRollup[1];
      const j = data.jobs.jobs.find((x) => x.html_url === c.detailsUrl);
      c.detailsUrl = c.detailsUrl.replace(String(data.run.id), String(other.id));
      j.html_url = c.detailsUrl;
      j.run_id = other.id;
    });
    expect(f.poll().state).toBe('success');
    expect(f.calls.some((c) => c.args[1].includes('page=2'))).toBe(true);
  });

  it.each(['error', 'truncated', 'duplicate'])('вторая страница %s запрещает успех', (fault) => {
    const f = confirmationFixture(manyJobs, (args, _n, data) => {
      if (args[1]?.includes('/jobs?') && args[1].includes('page=2')) {
        if (fault === 'error') return { code: 1 };
        return {
          code: 0,
          stdout: JSON.stringify({
            total_count: data.jobs.jobs.length,
            jobs: fault === 'duplicate' ? [data.jobs.jobs[0]] : [],
          }),
        };
      }
    });
    expect(f.poll().state).toBe('pending');
  });

  it('получает все страницы списка runs и отклоняет потерю второй', () => {
    const edit = (data) => {
      for (let i = 1; i <= 101; i += 1) data.runs.push({ ...data.run, id: data.run.id - i });
    };
    const f = confirmationFixture(edit);
    expect(f.poll().state).toBe('success');
    expect(
      f.calls.filter(
        (c) => c.args[1].includes('event=pull_request') && c.args[1].includes('page=2'),
      ),
    ).toHaveLength(2);
    const broken = confirmationFixture(edit, (args) =>
      args[1]?.includes('event=pull_request') && args[1].includes('page=2') ? { code: 1 } : null,
    );
    expect(broken.poll().state).toBe('pending');
  });

  it.each(['missing', 'duplicate', 'unlinked', 'truncated', 'wrong-id'])(
    'список или метаданные %s сохраняют pending',
    (fault) => {
      const f = confirmationFixture(
        () => {},
        (args, n, data) => {
          if (n === 2 && fault === 'wrong-id')
            return { code: 0, stdout: JSON.stringify({ ...data.run, id: 42 }) };
          if (!args[1]?.includes('event=pull_request')) return null;
          const runs =
            fault === 'missing'
              ? []
              : fault === 'duplicate'
                ? [data.run, data.run]
                : fault === 'unlinked'
                  ? [data.run, { ...data.run, id: 42, pull_requests: [] }]
                  : [data.run];
          return {
            code: 0,
            stdout: JSON.stringify({
              total_count: fault === 'truncated' ? 2 : runs.length,
              workflow_runs: runs,
            }),
          };
        },
      );
      expect(f.poll().state).toBe('pending');
    },
  );

  it.each(['in_progress', 'failure'])(
    'другой workflow %s не скрывается успехом первого',
    (status) => {
      const f = confirmationFixture((data) => {
        const other = {
          ...data.run,
          id: data.run.id + 1,
          workflow_id: 99,
          status: status === 'failure' ? 'completed' : status,
          conclusion: status === 'failure' ? 'failure' : null,
        };
        data.runs.push(other);
        const c = data.pr.statusCheckRollup[1];
        const j = data.jobs.jobs[1];
        c.detailsUrl = c.detailsUrl.replace(String(data.run.id), String(other.id));
        j.html_url = c.detailsUrl;
        j.run_id = other.id;
        c.status = status === 'failure' ? 'COMPLETED' : 'IN_PROGRESS';
        c.conclusion = other.conclusion?.toUpperCase() ?? '';
        j.status = other.status;
        j.conclusion = other.conclusion ?? '';
      });
      expect(f.poll().state).toBe(status === 'failure' ? 'failure' : 'pending');
    },
  );

  it('ограничивает сбор тридцатью запросами и не кеширует успех', () => {
    const f = confirmationFixture(
      () => {},
      (args, n, data) => {
        if (args[1]?.includes('/jobs?')) {
          return {
            code: 0,
            stdout: JSON.stringify({
              total_count: 10000,
              jobs: Array.from({ length: 100 }, (_, i) => ({
                ...data.jobs.jobs[0],
                id: n * 100 + i,
              })),
            }),
          };
        }
      },
    );
    expect(f.poll().why).toContain('бюджет');
    expect(f.calls).toHaveLength(31);
    const normal = confirmationFixture();
    expect(normal.poll().state).toBe('success');
    normal.f.run.run_attempt += 1;
    expect(normal.poll().state).toBe('pending');
  });
});

const rollup = (...checks) => JSON.stringify({ statusCheckRollup: checks });

describe('состояние проверок', () => {
  it('успешные служебные проверки и пропущенная игра разрешают ревью', () => {
    expect(
      summariseChecks(
        rollup(
          check('затронутые области', 'COMPLETED', 'SUCCESS'),
          check('быстрые тесты', 'COMPLETED', 'SUCCESS'),
          check('матчевые тесты', 'COMPLETED', 'SKIPPED'),
          check('сквозные проверки', 'COMPLETED', 'SKIPPED'),
        ),
      ),
    ).toEqual({ state: 'success' });
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT'])(
    'пропуски не скрывают проблему определения областей: %s',
    (conclusion) => {
      expect(
        summariseChecks(
          rollup(
            check('затронутые области', 'COMPLETED', conclusion),
            check('быстрые тесты', 'COMPLETED', 'SUCCESS'),
            check('матчевые тесты', 'COMPLETED', 'SKIPPED'),
          ),
        ),
      ).toEqual({ state: 'failure', failed: 'затронутые области' });
    },
  );

  it('полностью пропущенный набор не разрешает ревью', () => {
    expect(summariseChecks(rollup(check('матчевые тесты', 'COMPLETED', 'SKIPPED'))).state).toBe(
      'pending',
    );
  });

  it('все зелёные — успех', () => {
    const state = summariseChecks(
      rollup(check('типы', 'COMPLETED', 'SUCCESS'), check('сборка', 'COMPLETED', 'SUCCESS')),
    );
    expect(state).toEqual({ state: 'success' });
  });

  it('хоть одна не завершилась — ждём', () => {
    const state = summariseChecks(
      rollup(check('типы', 'COMPLETED', 'SUCCESS'), check('матчевые тесты', 'IN_PROGRESS', null)),
    );
    expect(state.state).toBe('pending');
    expect(state.why).toContain('матчевые тесты');
  });

  it('упавшая называется по имени', () => {
    const state = summariseChecks(
      rollup(
        check('типы', 'COMPLETED', 'SUCCESS'),
        check('сквозные проверки', 'COMPLETED', 'FAILURE'),
      ),
    );
    expect(state.state).toBe('failure');
    expect(state.failed).toBe('сквозные проверки');
  });

  it('отменённая считается неуспехом, а не успехом', () => {
    const state = summariseChecks(rollup(check('сборка', 'COMPLETED', 'CANCELLED')));
    expect(state.state).toBe('failure');
  });

  it('проверок ещё нет — ждём, а не радуемся', () => {
    // Пустой перечень легко принять за «всё зелено»: ошибка, из-за которой
    // ревью началось бы на непроверенном коде.
    expect(summariseChecks(rollup()).state).toBe('pending');
  });

  it('неразобравшийся ответ не выдаётся за успех', () => {
    expect(summariseChecks('не json').state).toBe('pending');
  });

  it('пустой ответ не выдаётся за успех', () => {
    expect(summariseChecks('').state).toBe('pending');
  });
});

describe('возможность слияния при опросе CI', () => {
  const success = check('типы', 'COMPLETED', 'SUCCESS');
  const pr = (mergeable, ...checks) => JSON.stringify({ mergeable, statusCheckRollup: checks });

  it.each([
    { checks: [] },
    { checks: [check('типы', 'IN_PROGRESS', null)] },
    { checks: [success] },
  ])('конфликт требует доработки независимо от проверок: $checks', ({ checks }) => {
    expect(summarisePullRequest(pr('CONFLICTING', ...checks))).toEqual({ state: 'conflict' });
  });

  it('черновой PR с UNKNOWN в mergeStateStatus всё равно имеет доказанный конфликт', () => {
    expect(
      summarisePullRequest(
        JSON.stringify({
          isDraft: true,
          mergeStateStatus: 'UNKNOWN',
          mergeable: 'CONFLICTING',
          statusCheckRollup: [],
        }),
      ),
    ).toEqual({ state: 'conflict' });
  });

  it('неопределённое слияние не допускает ревью даже при зелёном CI', () => {
    expect(summarisePullRequest(pr('UNKNOWN', success))).toEqual({
      state: 'pending',
      why: 'GitHub ещё не определил возможность слияния pull request',
    });
  });

  it.each(['не json', '', 'null', '{}', rollup(success)])(
    'непрочитанное слияние не объявляется конфликтом или успехом: %s',
    (json) => expect(summarisePullRequest(json).state).toBe('pending'),
  );

  it('повреждённый список проверок сохраняет ожидание', () => {
    expect(
      summarisePullRequest(JSON.stringify({ mergeable: 'MERGEABLE', statusCheckRollup: {} })),
    ).toEqual({ state: 'pending', why: 'ответ GitHub о проверках не разобрался' });
  });

  it.each([
    { checks: [], expected: { state: 'pending', why: 'проверок ещё нет' } },
    { checks: [success], expected: { state: 'success' } },
    {
      checks: [check('типы', 'COMPLETED', 'FAILURE')],
      expected: { state: 'failure', failed: 'типы' },
    },
    {
      checks: [check('типы', 'IN_PROGRESS', null)],
      expected: { state: 'pending', why: 'идут: типы' },
    },
  ])('при MERGEABLE сохраняется результат CI: $expected.state', ({ checks, expected }) => {
    expect(summarisePullRequest(pr('MERGEABLE', ...checks))).toEqual(expected);
  });

  it('живой переходник запрашивает конфликт тем же обращением, что и проверки', () => {
    const asked = [];
    const io = createIo({
      root: '/repo',
      config: resolveConfig({}).config,
      now: 'сейчас',
      run: (args, program) => {
        asked.push({ args, program });
        return { code: 0, stdout: pr('CONFLICTING') };
      },
    });
    expect(io.readExternal({ links: { pr: 141 } }, 'ci')).toEqual({ state: 'conflict' });
    expect(asked).toEqual([
      {
        program: 'gh',
        args: [
          'pr',
          'view',
          '141',
          '--json',
          'mergeable,statusCheckRollup,number,url,state,headRefOid',
        ],
      },
    ]);
  });

  it('ошибка запроса не использует даже похожий на конфликт stdout', () => {
    const io = createIo({
      root: '/repo',
      config: resolveConfig({}).config,
      now: 'сейчас',
      run: () => ({ code: 1, stdout: pr('CONFLICTING') }),
    });
    expect(io.readExternal({ links: { pr: 141 } }, 'ci')).toEqual({
      state: 'pending',
      why: 'состояние проверок недоступно',
    });
  });
});

describe('очередь отчётов', () => {
  // Отчёты лежат в памяти супервизора, а не файлами на диске. Каталог
  // отчётов ушёл вместе со слотами: отчёт приходит выводом того самого
  // процесса, который супервизор и породил. Обходить за ним рабочие
  // деревья больше не надо — искать негде, он один.
  const { config } = resolveConfig({
    commands: { verify: 'x', deploy: 'x', perf: 'x' },
    worktreeDir: '.claude/worktrees',
  });

  const report = { taskId: '0001-one', stage: 'design', outcome: 'done' };
  const io = (reports) => createIo({ root: '/repo', config, now: 'сейчас', reports });

  it('читается по задаче и этапу', () => {
    expect(io([report]).readReport('0001-one', 'design')).toMatchObject({ outcome: 'done' });
  });

  it('отчёт о другом этапе не выдаётся за свой', () => {
    // Отчёт, посчитанный по другой картине мира, двинул бы задачу
    // неизвестно куда.
    expect(io([report]).readReport('0001-one', 'audit')).toBeNull();
  });

  it('принятый отчёт уходит из очереди', () => {
    const queue = [report];
    io(queue).removeReport('0001-one', 'design');
    expect(queue).toEqual([]);
  });

  it('снятие несуществующего отчёта не трогает чужих', () => {
    const queue = [report];
    io(queue).removeReport('0002-two', 'design');
    expect(queue).toHaveLength(1);
  });
});

describe('улики о деле этапа', () => {
  // Их спрашивают, только когда этапу в чём-то отказали: тогда решают,
  // попутный это был отказ или подрывающий. Настоящий git не зовётся ни разу.
  const { config } = resolveConfig({
    commands: { verify: 'x', deploy: 'x', perf: 'x' },
    worktreeDir: '.claude/worktrees',
  });

  const task = (over = {}) => ({ id: '0001-one', links: { run: null, pr: null }, ...over });

  /** Переходник, отвечающий заранее заготовленным, и список спрошенного. */
  function fakeIo(answers = []) {
    const asked = [];
    const queue = [...answers];
    const run = (args) => {
      asked.push(args.join(' '));
      return queue.shift() ?? { code: 0, stdout: '', stderr: '' };
    };
    return { io: createIo({ root: '/repo', config, now: 'сейчас', run }), asked };
  }

  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });

  it('спрашиваются ровно три команды и ровно про свою ветку', () => {
    const { io, asked } = fakeIo([ok('a1b2c3d\n'), ok('0\n'), ok('2026-09-01T12:30:00+03:00\n')]);
    const evidence = io.stageEvidence(task());

    expect(evidence).toEqual({
      branchOnRemote: true,
      unpushed: 0,
      lastCommitAt: '2026-09-01T12:30:00+03:00',
      previousRun: null,
      previousPr: null,
    });
    expect(asked).toEqual([
      'rev-parse --verify --quiet origin/worktree-0001-one',
      'rev-list --count origin/worktree-0001-one..worktree-0001-one',
      'log -1 --format=%cI worktree-0001-one',
    ]);
  });

  it('ветки у origin нет — так и сказано, а не «git промолчал»', () => {
    // `--verify --quiet` на несуществующей ссылке даёт ненулевой код
    // и пустой поток ошибок.
    const { io } = fakeIo([{ code: 1, stdout: '', stderr: '' }]);
    expect(io.stageEvidence(task()).branchOnRemote).toBe(false);
  });

  it('отказ git — это пусто, а не отсутствие ветки', () => {
    // Слив эти случаи, мы заставили бы поломку прибора стоить этапу работы.
    const broken = { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    const { io } = fakeIo([broken, broken, broken]);
    const evidence = io.stageEvidence(task());

    expect(evidence.branchOnRemote).toBe(null);
    expect(evidence.unpushed).toBe(null);
    expect(evidence.lastCommitAt).toBe(null);
  });

  it('прежний номер прогона берётся из самой задачи', () => {
    // «Новый номер» проверяется сравнением, а не наличием.
    const { io } = fakeIo();
    const evidence = io.stageEvidence(task({ links: { run: '33428427058' } }));
    expect(evidence.previousRun).toBe('33428427058');
  });

  it('прежний номер pull request берётся из задачи и лишних команд не стоит', () => {
    // Зеркально номеру прогона: впервые открытый pull request — это тот,
    // которого задача до этапа не знала. Ни одного нового вызова git.
    const { io, asked } = fakeIo();
    const evidence = io.stageEvidence(task({ links: { run: null, pr: 124 } }));

    expect(evidence.previousPr).toBe(124);
    expect(asked).toEqual([
      'rev-parse --verify --quiet origin/worktree-0001-one',
      'rev-list --count origin/worktree-0001-one..worktree-0001-one',
      'log -1 --format=%cI worktree-0001-one',
    ]);
  });

  it('задача без ссылки на pull request даёт null, а не undefined', () => {
    const { io } = fakeIo();
    expect(io.stageEvidence({ id: '0001-one', links: {} }).previousPr).toBe(null);
  });

  it('своя работа в ветке считается от главной ветки и без слияний', () => {
    // Мерка объявлена дословно: оба ключа несут смысл. Считать от удалённого
    // двойника своей ветки нельзя — это вопрос «отправлено ли», а не «есть ли
    // что терять»; считать слияния нельзя — коммит подтянутой главной ветки
    // это обновление базы, а не работа, и с ним уборка заперлась бы у всякой
    // задачи, зашедшей в дерево после расхождения с main.
    const { io, asked } = fakeIo([ok('0\n')]);
    expect(io.ownCommits('worktree-0001-one')).toBe(0);
    expect(asked).toEqual(['rev-list --count --no-merges origin/main..worktree-0001-one']);
  });

  it('отказ git о содержимом ветки — это null, а не ноль', () => {
    // Ноль означает «терять нечего» и разрешает удаление. Слив его
    // с неизвестностью, поломка прибора сносила бы ветки с работой.
    const { io } = fakeIo([{ code: 128, stdout: '', stderr: 'fatal: bad revision' }]);
    expect(io.ownCommits('worktree-0001-one')).toBe(null);
  });

  it('подтверждённое отсутствие обеих веток разрешает дочистку папки', () => {
    const { io, asked } = fakeIo([{ code: 128 }, { code: 1 }, { code: 2 }]);
    expect(io.ownCommits('worktree-0001-one')).toBe(0);
    expect(asked).toEqual([
      'rev-list --count --no-merges origin/main..worktree-0001-one',
      'show-ref --verify --quiet refs/heads/worktree-0001-one',
      'ls-remote --exit-code --heads origin refs/heads/worktree-0001-one',
    ]);
  });

  it.each(['0', '2'])('после удаления локальной ветки проверяет работу на сервере: %s', (count) => {
    const sha = 'a'.repeat(40);
    const { io, asked } = fakeIo([
      { code: 128 },
      { code: 1 },
      ok(`${sha}\trefs/heads/worktree-0001-one\n`),
      ok(count),
    ]);
    expect(io.ownCommits('worktree-0001-one')).toBe(Number(count));
    expect(asked.at(-1)).toBe(`rev-list --count --no-merges origin/main..${sha}`);
  });

  it.each([
    [{ code: 128 }, { code: 128 }],
    [{ code: 128 }, { code: 1 }, { code: 128 }],
    [{ code: 128 }, { code: 1 }, ok('')],
    [{ code: 128 }, { code: 1 }, ok(`${'a'.repeat(40)}\trefs/heads/another\n`)],
    [
      { code: 128 },
      { code: 1 },
      ok(`${'a'.repeat(40)}\trefs/heads/worktree-0001-one\n`),
      { code: 128 },
    ],
  ])('не выдаёт отказ проверки оставшейся ветки за отсутствие работы %#', (...answers) => {
    const { io } = fakeIo(answers);
    expect(io.ownCommits('worktree-0001-one')).toBe(null);
  });
});

describe('коммит конвейера', () => {
  /** Переходник с подставным запускателем: настоящий git не зовётся ни разу. */
  function fakeIo(over = {}) {
    const calls = [];
    const { config } = resolveConfig({
      commands: { verify: 'x', deploy: 'x', perf: 'x' },
      worktreeDir: '.claude/worktrees',
      author: { name: 'Конвейер TD_Game', email: 'pipeline@localhost' },
    });
    const run = (args) => {
      calls.push(args);
      return over.result?.(args) ?? { code: 0, stdout: '', stderr: '' };
    };
    const io = createIo({
      root: '/repo',
      config,
      git: { push: () => ({ ok: true, failure: null }) },
      now: '2026-08-27T12:00:00+03:00',
      machine: 'станция-1',
      run,
      elapsed: () => 0,
    });
    return { io, calls, config };
  }

  const commitCall = (calls) => calls.find((args) => args.includes('commit'));

  it('подписывается именем конвейера, а не хозяина машины', () => {
    // Досылка хвоста отправляет только свои коммиты и узнаёт их по автору.
    // Пока конвейер подписывался хозяином, он объявлял чужим собственный
    // хвост и переставал писать вовсе — до вмешательства человека.
    const { io, calls } = fakeIo();
    io.commitAndPush(['manage/tasks/0001-one.json'], 'chore(backlog): проба');

    const commit = commitCall(calls);
    expect(commit).toContain('user.name=Конвейер TD_Game');
    expect(commit).toContain('user.email=pipeline@localhost');
  });

  it('коммитит только свои пути, а не весь индекс', () => {
    // Без путей `commit` забирает и то, что успела выложить в индекс
    // соседняя сессия: чужая работа уехала бы в главную ветку под нашим
    // сообщением и без окна на замечание.
    const { io, calls } = fakeIo();
    io.commitAndPush(['manage/tasks/0001-one.json', 'manage/journal/0001-one.md'], 'проба');

    const commit = commitCall(calls);
    expect(commit).toContain('--');
    expect(commit).toContain('manage/tasks/0001-one.json');
    expect(commit).toContain('manage/journal/0001-one.md');
  });

  it('дополнение коммитит журнал и только его', () => {
    // Дополняется журнал, а не описание: описание — единственное место,
    // где живёт постановка задачи, и дописывать в него из чужого разбора
    // значит однажды затереть чужую формулировку. Сама задача при этом
    // не сохраняется вовсе — ни состояния, ни очереди дополнение не трогает.
    const { io, calls } = fakeIo();
    // Запись на диск здесь ни при чём: проверяется состав коммита.
    io.appendJournal = () => {};
    io.amendTask('0002-two', 'фактура', 'chore(backlog): 0002-two дополнена');

    const commit = commitCall(calls);
    expect(commit).toContain('manage/journal/0002-two.md');
    expect(commit).not.toContain('manage/tasks/0002-two.json');
  });

  it('своя подпись входит в список своих авторов сама', () => {
    // Разъедься эти два значения — и конвейер объявит чужим собственный
    // хвост. Выводить второе из первого дешевле, чем сторожить согласие.
    const { config } = fakeIo();
    expect(config.ourAuthors).toContain('Конвейер TD_Game');
  });

  it('названные проектом авторы не теряются', () => {
    const { config } = resolveConfig({
      author: { name: 'Конвейер TD_Game' },
      ourAuthors: ['Прежнее имя'],
    });
    expect(config.ourAuthors).toEqual(['Конвейер TD_Game', 'Прежнее имя']);
  });
});

describe('заведение рабочего дерева', () => {
  /**
   * Переходник, у которого известно, какие ветки существуют.
   *
   * Настоящий git не зовётся: проверяется выбор команды, а не работа
   * самого git. Заводить ради этого репозиторий на диске значило бы
   * платить секундами за ответ, который виден в списке доводов.
   */
  function fakeIo(existingRefs = []) {
    const calls = [];
    const { config } = resolveConfig({
      commands: { verify: 'x', deploy: 'x', perf: 'x' },
      worktreeDir: '.claude/worktrees',
    });
    const run = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        return { code: existingRefs.includes(args.at(-1)) ? 0 : 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const io = createIo({ root: '/repo', config, now: 'сейчас', run, elapsed: () => 0 });
    return { io, calls };
  }

  const addCall = (calls) => calls.find((args) => args[0] === 'worktree');

  // Путь склеивает `join`, и на Windows он выходит с обратными косыми.
  // Писать его в проверке буквально значило бы завести тест, зелёный
  // на одной оси и красный на другой.
  const treePath = (taskId) => join('.claude/worktrees', taskId);

  it('новой задаче ветка заводится от удалённой главной', () => {
    const { io, calls } = fakeIo();
    expect(io.addWorktree('0001-one', 'worktree-0001-one').ok).toBe(true);
    expect(addCall(calls)).toEqual([
      'worktree',
      'add',
      treePath('0001-one'),
      '-b',
      'worktree-0001-one',
      'origin/main',
    ]);
  });

  it('уцелевшая местная ветка не ответвляется заново', () => {
    // Дерево сносят, а ветку оставляют — в ней невлитая работа. Пока
    // здесь стояло безусловное `-b`, git отвечал «branch already exists»,
    // и задача 0017 держала слот исполнителя двое суток.
    const { io, calls } = fakeIo(['refs/heads/worktree-0017-noise']);
    expect(io.addWorktree('0017-noise', 'worktree-0017-noise').ok).toBe(true);
    expect(addCall(calls)).toEqual([
      'worktree',
      'add',
      treePath('0017-noise'),
      'worktree-0017-noise',
    ]);
  });

  it('ветка, оставшаяся только на origin, тоже продолжается', () => {
    // Машину переустановили, местных веток нет вовсе. Ответвиться от
    // главной значило бы потерять уже отправленную работу этапа.
    const { io, calls } = fakeIo(['refs/remotes/origin/worktree-0017-noise']);
    expect(io.addWorktree('0017-noise', 'worktree-0017-noise').ok).toBe(true);
    expect(addCall(calls)).not.toContain('-b');
  });

  it('отказ git доходит до вызывающего словами', () => {
    const { io } = fakeIo();
    const failing = createIo({
      root: '/repo',
      config: resolveConfig({ worktreeDir: '.claude/worktrees' }).config,
      now: 'сейчас',
      run: (args) =>
        args[0] === 'rev-parse'
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 128, stdout: '', stderr: 'fatal: каталог занят\n' },
      elapsed: () => 0,
    });
    expect(io.addWorktree('0001-one', 'worktree-0001-one').ok).toBe(true);
    expect(failing.addWorktree('0001-one', 'worktree-0001-one')).toEqual({
      ok: false,
      why: 'fatal: каталог занят',
    });
  });
});
