import { readFileSync } from 'node:fs';
import { URLSearchParams } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { reviewCi, runReviewCiCli, parseReviewCiArgs } from './review-ci.mjs';
import { createCommandRunner } from './command-runner.mjs';
import { summarisePullRequest } from './io.mjs';

// Исходные ответы сохранены в 0297; список runs и повторные чтения моделируются.
const observation = JSON.parse(
  readFileSync(new URL('./testing/ci-pr-219.json', import.meta.url), 'utf8'),
);
function fixture(edit = () => {}, intercept = () => null) {
  const f = JSON.parse(JSON.stringify(observation));
  f.runs = [f.run];
  edit(f);
  const calls = [];
  const run = (args, tool, cwd, options) => {
    calls.push({ args, tool, cwd, options });
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
    return { code: 0, stdout: JSON.stringify(data), stderr: '' };
  };
  return {
    f,
    run,
    calls,
    poll: (head = observation.pr.headRefOid, pr = 219) => reviewCi({ pr, head, run }),
  };
}

describe('отрицательные контроли общего подтверждения через вход review', () => {
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
    const f = fixture(edit);
    expect(f.poll().state).toBe('pending');
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'])(
    'конечный %s даёт failure',
    (conclusion) => {
      for (const target of ['job', 'run']) {
        const f = fixture((data) => {
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
    const first = fixture((f) => {
      f.pr.mergeable = mergeable;
    });
    expect(first.poll().state).toBe(mergeable === 'CONFLICTING' ? 'conflict' : 'pending');
    expect(first.calls).toHaveLength(1);
    const second = fixture(
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
      const f = fixture(
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
    const f = fixture(
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
        const f = fixture(
          () => {},
          (_args, n) => (n === step ? result : null),
        );
        expect(f.poll().state).toBe('pending');
      }
    },
  );

  it.each(['status', 'conclusion', 'completedAt'])('без тройки (%s) нет fallback', (field) => {
    const f = fixture((data) => {
      data.pr.statusCheckRollup[0][field] = null;
    });
    expect(f.poll().state).toBe('pending');
    expect(f.calls).toHaveLength(1);
  });

  it('обычный SUCCESS/SKIPPED и все SKIPPED обходятся одним чтением', () => {
    for (const skipped of [false, true]) {
      const f = fixture((data) => {
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
    const f = fixture((data) => {
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
    const f = fixture(manyJobs, (args, _n, data) => {
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
    const f = fixture(edit);
    expect(f.poll().state).toBe('success');
    expect(
      f.calls.filter(
        (c) => c.args[1].includes('event=pull_request') && c.args[1].includes('page=2'),
      ),
    ).toHaveLength(2);
    const broken = fixture(edit, (args) =>
      args[1]?.includes('event=pull_request') && args[1].includes('page=2') ? { code: 1 } : null,
    );
    expect(broken.poll().state).toBe('pending');
  });

  it.each(['missing', 'duplicate', 'unlinked', 'truncated', 'wrong-id'])(
    'список или метаданные %s сохраняют pending',
    (fault) => {
      const f = fixture(
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
      const f = fixture((data) => {
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
    const f = fixture(
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
    const normal = fixture();
    expect(normal.poll().state).toBe('success');
    normal.f.run.run_attempt += 1;
    expect(normal.poll().state).toBe('pending');
  });
});

describe('CLI review-ci', () => {
  const args = ['--pr', '219', '--head', observation.pr.headRefOid];
  const badArgs = [
    [],
    ['--pr'],
    ['--head', 'a'.repeat(40)],
    ['--pr', '0', '--head', 'a'.repeat(40)],
    ['--pr', '-1', '--head', 'a'.repeat(40)],
    ['--pr', '1.1', '--head', 'a'.repeat(40)],
    ['--pr', '01', '--head', 'a'.repeat(40)],
    ['--pr', '9007199254740992', '--head', 'a'.repeat(40)],
    ['--pr', '219', '--head', 'abc'],
    ['--pr', '219', '--head', 'g'.repeat(40)],
    [...args, '--pr', '219'],
    [...args, '--head', 'b'.repeat(40)],
    [...args, '--report', 'old.json'],
    [...args, '--fixture', 'old.json'],
    [...args, '--endpoint', 'other'],
    [...args, '--program', 'other'],
    [...args, '--watch'],
  ];
  it.each(badArgs.map((a) => [JSON.stringify(a), a]))(
    'отвергает %s до транспорта',
    (_name, argv) => {
      const run = vi.fn();
      const write = vi.fn();
      expect(runReviewCiCli(argv, run, write)).toBe(64);
      expect(run).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(1);
      expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
        state: 'pending',
        pr: null,
        runs: [],
      });
    },
  );
  it('принимает перестановку ключей и uppercase SHA', () => {
    expect(
      parseReviewCiArgs(['--head', observation.pr.headRefOid.toUpperCase(), '--pr', '219']),
    ).toEqual({ pr: 219, head: observation.pr.headRefOid });
  });
  it('настоящий процесс CLI возвращает один JSON и 64 без сети', () => {
    const result = spawnSync(
      process.execPath,
      ['supervisor/bin/review-ci.mjs', '--report', 'old.json'],
      {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      },
    );
    expect(result.status).toBe(64);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'pending', runs: [] });
  });
  it.each([
    ['success', 0],
    ['failure', 1],
    ['pending', 2],
    ['conflict', 3],
  ])('entrypoint + настоящий command-runner: %s, код %s', async (state, code) => {
    const f = fixture((data) => {
      if (state === 'failure') data.run.conclusion = 'failure';
      if (state === 'pending') data.run.run_attempt += 1;
      if (state === 'conflict') data.pr.mergeable = 'CONFLICTING';
    });
    const exec = vi.fn((program, argv, options) => {
      expect(program).toBe('gh');
      expect(options).toMatchObject({
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
        timeout: 15000,
      });
      expect(
        argv[0] === 'api' ? argv.length === 2 : argv.slice(0, 3).join(' ') === 'pr view 219',
      ).toBe(true);
      return f.run(argv, program, options.cwd, { timeout: options.timeout }).stdout;
    });
    const factory = vi.fn((root) => createCommandRunner(root, exec));
    const previousArgs = process.argv;
    const previousExit = process.exitCode;
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.resetModules();
    vi.doMock('./command-runner.mjs', () => ({ createCommandRunner: factory }));
    try {
      process.argv = ['node', 'review-ci.mjs', ...args];
      await import('../bin/review-ci.mjs');
      expect(process.exitCode).toBe(code);
      expect(factory).toHaveBeenCalledWith(process.cwd());
      expect(write).toHaveBeenCalledTimes(1);
      const stdout = write.mock.calls[0][0];
      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({
        state,
        pr: 219,
        expectedHead: observation.pr.headRefOid,
      });
      expect(exec).toHaveBeenCalled();
      expect(f.calls.length).toBeLessThanOrEqual(31);
    } finally {
      process.argv = previousArgs;
      process.exitCode = previousExit;
      write.mockRestore();
      vi.doUnmock('./command-runner.mjs');
    }
  });
});

describe('общий вход review', () => {
  it('не содержит исключения для PR, run, job или SHA исходного снимка', () => {
    const f = fixture((data) => {
      const oldRun = data.run.id;
      const repo = 'Another/Project';
      const head = 'b'.repeat(40);
      data.pr.number = 17;
      data.pr.url = `https://github.com/${repo}/pull/17`;
      data.pr.headRefOid = head;
      data.run.id = 901;
      data.run.head_sha = head;
      data.run.repository.full_name = repo;
      data.run.pull_requests = [
        { number: 17, head: { sha: head }, url: `https://api.github.com/repos/${repo}/pulls/17` },
      ];
      data.pr.statusCheckRollup.forEach((check, i) => {
        const job = data.jobs.jobs.find((j) => j.html_url === check.detailsUrl);
        expect(job.run_id).toBe(oldRun);
        job.id = 4001 + i;
        job.run_id = 901;
        job.head_sha = head;
        check.id = `check-${job.id}`;
        check.detailsUrl = `https://github.com/${repo}/actions/runs/901/job/${job.id}`;
        job.html_url = check.detailsUrl;
      });
    });
    expect(f.poll('b'.repeat(40), 17)).toMatchObject({
      state: 'success',
      pr: 17,
      runs: [{ id: 901, attempt: 1, head: 'b'.repeat(40) }],
    });
  });

  it.each(['ordinary', 'confirmed'])('проверяет идентичность и в пути %s', (mode) => {
    const edits = [
      (f) => {
        f.pr.number = 220;
      },
      (f) => {
        delete f.pr.number;
      },
      (f) => {
        f.pr.url = 'https://github.com/Dezintegra/TD_Game/pull/220';
      },
      (f) => {
        f.pr.url = 'https://example.com/Dezintegra/TD_Game/pull/219';
      },
      (f) => {
        f.pr.url += '?from=old';
      },
      (f) => {
        f.pr.url += '#old';
      },
      (f) => {
        f.pr.url = f.pr.url.replace('https://', 'https://user:pass@');
      },
      (f) => {
        f.pr.url = 'bad URL';
      },
      (f) => {
        delete f.pr.url;
      },
      (f) => {
        f.pr.state = 'CLOSED';
      },
      (f) => {
        f.pr.state = 'MERGED';
      },
      (f) => {
        delete f.pr.state;
      },
      (f) => {
        f.pr.headRefOid = 'b'.repeat(40);
      },
      (f) => {
        delete f.pr.headRefOid;
      },
      (f) => {
        f.pr.mergeable = 'UNKNOWN';
      },
      (f) => {
        delete f.pr.mergeable;
      },
    ];
    for (const edit of edits) {
      const f = fixture((data) => {
        if (mode === 'ordinary')
          data.pr.statusCheckRollup.forEach((c) => {
            c.status = 'COMPLETED';
          });
        edit(data);
      });
      const result = f.poll();
      expect(result.state).toBe('pending');
      expect(result.why).toBeTruthy();
      expect(result.runs).toEqual([]);
    }
  });

  it.each(['url', 'number', 'state'])('повторная сверка идентичности %s', (field) => {
    const f = fixture(
      () => {},
      (args, n, data) => {
        if (args[0] === 'pr' && n > 1) {
          if (field === 'url') data.pr.url = data.pr.url.replace('TD_Game', 'Other');
          if (field === 'number') data.pr.number += 1;
          if (field === 'state') data.pr.state = 'CLOSED';
        }
      },
    );
    expect(f.poll()).toMatchObject({ state: 'pending', runs: [] });
  });

  it.each(['pending', 'failure', 'conflict'])('новый вызов после успеха видит %s', (state) => {
    const f = fixture();
    expect(f.poll().state).toBe('success');
    const before = f.calls.length;
    if (state === 'pending') f.f.run.run_attempt += 1;
    if (state === 'failure') f.f.run.conclusion = 'failure';
    if (state === 'conflict') f.f.pr.mergeable = 'CONFLICTING';
    expect(f.poll()).toMatchObject({ state, runs: [] });
    expect(f.calls.length).toBeGreaterThan(before);
  });

  it.each([1, 2, 3, 4, 5, 6, 7])('тайм-аут и исключение чтения %s не дают success', (step) => {
    for (const throwing of [false, true]) {
      const f = fixture(
        () => {},
        (_args, n) => {
          if (n !== step) return null;
          if (throwing) throw new Error('ETIMEDOUT');
          return { code: 1, stderr: 'ETIMEDOUT' };
        },
      );
      expect(f.poll()).toMatchObject({ state: 'pending', runs: [] });
      expect(f.calls).toHaveLength(step);
      expect(f.calls.every((c) => c.options.timeout === 15000)).toBe(true);
    }
  });

  it('пустой набор не превращается в ordinary success', () => {
    const f = fixture((data) => {
      data.pr.statusCheckRollup = [];
    });
    expect(f.poll()).toMatchObject({ state: 'pending', mode: 'ordinary', runs: [] });
    expect(f.calls).toHaveLength(1);
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT'])('обычный %s возвращает failure', (conclusion) => {
    const f = fixture((data) => {
      data.pr.statusCheckRollup.forEach((c) => {
        c.status = 'COMPLETED';
      });
      data.pr.statusCheckRollup[0].conclusion = conclusion;
    });
    expect(f.poll()).toMatchObject({
      state: 'failure',
      mode: 'ordinary',
      runs: [],
      failed: f.f.pr.statusCheckRollup[0].name,
    });
    expect(f.calls).toHaveLength(1);
  });

  it('подтверждает исходное противоречие, которое чистое сведение оставляет pending', () => {
    const f = fixture();
    expect(summarisePullRequest(JSON.stringify(f.f.pr)).state).toBe('pending');
    expect(f.poll()).toMatchObject({
      state: 'success',
      mode: 'confirmed',
      expectedHead: f.f.pr.headRefOid,
      observedHead: f.f.pr.headRefOid,
      runs: [{ id: f.f.run.id, attempt: 1, head: f.f.pr.headRefOid }],
    });
    expect(f.calls).toHaveLength(7);
    expect(f.calls.every((c) => c.tool === 'gh' && c.options.timeout === 15000)).toBe(true);
  });
  it('не разрешает другой ожидаемый SHA', () => {
    const f = fixture();
    expect(f.poll('a'.repeat(40))).toMatchObject({ state: 'pending', runs: [] });
    expect(f.calls).toHaveLength(1);
  });
  it('конфликт имеет приоритет даже при несовпадении SHA', () => {
    const f = fixture((f) => {
      f.pr.mergeable = 'CONFLICTING';
    });
    expect(f.poll('a'.repeat(40))).toMatchObject({ state: 'conflict', runs: [] });
  });
  it('действительно работающее задание не допускается', () => {
    const f = fixture((f) => {
      f.jobs.jobs[1].status = 'in_progress';
      f.jobs.jobs[1].conclusion = null;
      f.pr.statusCheckRollup[1].status = 'IN_PROGRESS';
      f.pr.statusCheckRollup[1].conclusion = null;
    });
    expect(f.poll()).toMatchObject({ state: 'pending', runs: [] });
  });
});
