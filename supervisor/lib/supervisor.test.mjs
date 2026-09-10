import { fileURLToPath } from 'node:url';
import {
  taskTokens,
  taskTokenStatus,
  migrateTokenLedger,
  readTokenLedger,
  writeTokenLedger,
  commitTokenLedger,
} from './token-budget.mjs';
import { readCodexAnswer } from './provider.mjs';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createSupervisor } from './supervisor.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { TAG } from './console.mjs';
import { scan } from './scan.mjs';
import { parseReport } from './parse-report.mjs';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { openStageLogs } from './stage-logs.mjs';
import { openReportStore } from './report-store.mjs';
import { prepareBenchmarkSource } from './benchmark-source.mjs';

/**
 * Проверки хозяйства идущих этапов.
 *
 * Порождение подставное, поэтому проверяется ровно то, ради чего супервизор
 * и написан: квота прямым счётом детей, отчёт из вывода, память об этапе
 * ради возобновления и отметка его начала.
 *
 * Судить отказанные действия супервизор больше не берётся: здесь отчёт ещё
 * не разобран, и след этапа проверить нечем. Его дело — назвать отказы
 * в журнале цикла и увезти их вместе с отчётом.
 */

const { config } = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.claude/worktrees',
});

const NOW = '2026-08-31T12:00:00+03:00';

function harness(over = {}) {
  const children = [];
  const killed = [];
  const logged = [];
  const saved = [];

  const spawn = (program, args, options) => {
    over.onSpawn?.({ program, args, options });
    if (over.spawnThrows) throw new Error(over.spawnThrows);
    const child = new EventEmitter();
    // Номер процесса — признак рождения. Подставной `spawn` умеет и не давать
    // его: так ведёт себя настоящий на несуществующей команде.
    if (!over.stillborn) child.pid = 1000 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (text) => {
      child.prompt = text;
    };
    children.push(child);
    return child;
  };

  const logsAsked = [];
  const probed = [];
  const wrote = [];
  const said = [];

  const supervisor = createSupervisor({
    config: { ...config, ...over.config },
    root: '/repo',
    home: over.home,
    spawn,
    killTree: (pid) => killed.push(pid),
    // Опрос системы подставной: живых процессов проверки не поднимают.
    // По умолчанию отвечает «процесс жив, образ claude.exe» — так выглядит
    // только что порождённый этап.
    probe:
      over.probe === null
        ? null
        : (pid) => {
            probed.push(pid);
            return over.probe ? over.probe(pid) : { known: true, alive: true, image: 'claude.exe' };
          },
    machine: over.machine ?? 'станция-1',
    supervisorPid: over.supervisorPid ?? 777,
    now: over.now ?? (() => NOW),
    nowMs: over.nowMs ?? (() => 1_000_000),
    saveStages: (stages) => {
      over.saveStages?.(stages);
      saved.push(JSON.parse(JSON.stringify(stages)));
    },
    stages: over.stages ?? {},
    reportStore: over.reportStore,
    codexUsage: over.codexUsage ?? {},
    readCodexEvidence: over.readCodexEvidence,
    saveCodexUsage: over.saveCodexUsage,
    onPolicyBlocked: over.onPolicyBlocked,
    getCodexEnvironment: over.getCodexEnvironment,
    prepareAssignment: over.prepareAssignment,
    log: (line) => logged.push(line),
    // Запись лога этапа собирается так же, как журнал цикла, и по той же
    // причине: умолчание в `createSupervisor` — пустая функция, и без этого
    // довода содержимое лога не видно ни одной проверке. Шапку его до сих пор
    // не читал никто, кроме человека, — оттого расхождение в ней и прожило
    // так долго.
    writeStageLog: (taskId, stage, text, launch) => {
      wrote.push({ taskId, stage, text, launch });
      return over.writeStageLog?.(taskId, stage, text, launch);
    },
    readStageLogs: over.readStageLogs,
    // Рассказчик подставной, и метка запоминается отдельно от текста: судить
    // её по знакам в строке значило бы проверять раскраску, а не выбор.
    say: { line: (tag, text) => said.push({ tag, text }) },
    readStageLog: (taskId, stage) => {
      logsAsked.push(`${taskId}:${stage}`);
      return { stage, path: `.pipeline/logs/${taskId}-${stage}.log`, text: 'отказов:   3' };
    },
  });

  /** Довести последний порождённый процесс до конца с таким выводом. */
  const answer = async (envelope, code = 0) => {
    const child = children.at(-1);
    child.stdout.emit('data', JSON.stringify(envelope));
    child.emit('close', code);
    // Дать промису завершения дойти до обработчика.
    await sleep(0);
  };

  return { supervisor, children, killed, logged, saved, answer, logsAsked, probed, wrote, said };
}

/** Строка итога этапа из всего, что рассказчик напечатал. */
const finishedLine = (said) => said.find((line) => line.text.includes('завершён:'));

describe('индивидуальный лимит при запуске', () => {
  it('журнал использует лимит подготовленного назначения, даже при общем null', async () => {
    const h = harness({
      home: fileURLToPath(new URL('..', import.meta.url)),
      config: { provider: 'codex', codexMaxTaskTokens: null },
      prepareAssignment: (a) => ({ ...a, task: { userTokenLimit: { value: 35000000 } } }),
    });
    const launched = h.supervisor.spawnStage(assignment());
    expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true });
    const emit = (event) => h.children[0].stdout.emit('data', JSON.stringify(event) + '\n');
    emit({ type: 'thread.started', thread_id: 'user-budget' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } });
    await h.answer({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    expect(h.logged.join('\n')).toContain('/ 35000000 токенов задачи (лимит владельца');
  });

  it('не запускает процесс с неверной командой владельца', () => {
    const h = harness({
      config: { provider: 'codex' },
      prepareAssignment: (a) => ({ ...a, task: { userTokenLimit: { error: 'Неверный лимит' } } }),
    });
    expect(h.supervisor.spawnStage(assignment())).toMatchObject({
      ok: false,
      why: 'Неверный лимит',
    });
    expect(h.children).toHaveLength(0);
  });
});

describe('сохранённый отчёт при ошибке учёта', () => {
  for (const valid of [true, false]) {
    it.each(['decreased-usage', 'decreased-output', 'invalid-usage', 'history', 'cached'])(
      `JSON ${valid}, учёт %s`,
      async (kind) => {
        const text = valid ? JSON.stringify(report, null, 2) : 'не JSON\nисходный текст';
        const h = harness({
          home: fileURLToPath(new URL('..', import.meta.url)),
          config: { provider: 'codex', codexMaxTaskTokens: 25000000 },
          codexUsage: {
            version: 2,
            tasks: {
              '0001-one': {
                sessions: {
                  thread: {
                    knownTokens: 1100,
                    snapshot: { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 200 },
                    reasons: [],
                  },
                },
                launches: {},
              },
            },
          },
        });
        h.supervisor.spawnStage(assignment({ continuation: true, sessionId: 'thread' }));
        // История стала неполной уже после допуска работающего этапа.
        if (kind === 'history')
          h.supervisor.codexUsage.tasks['0001-one'].sessions.thread.reasons.push('legacy-unknown');
        for (const event of [
          { type: 'thread.started', thread_id: 'thread' },
          { type: 'item.completed', item: { type: 'agent_message', text } },
        ])
          h.children[0].stdout.emit('data', JSON.stringify(event) + '\n');
        await h.answer({
          type: 'turn.completed',
          usage:
            kind === 'invalid-usage'
              ? undefined
              : {
                  input_tokens: kind === 'decreased-usage' ? 500 : kind === 'history' ? 2000 : 1000,
                  output_tokens: kind === 'decreased-output' ? 50 : 100,
                  cached_input_tokens: 0,
                },
        });
        expect(h.wrote).toHaveLength(1);
        expect(h.wrote[0].text).toContain('--- итоговый текст ---\n' + text);
        expect(h.wrote[0].text).not.toContain('сессия ответа не оставила');
        const line = finishedLine(h.said);
        if (kind === 'cached') {
          expect(line.text).toContain('ответ done');
          expect(line.text).not.toContain('неизвест');
          expect(h.supervisor.reports).toHaveLength(valid ? 1 : 0);
          expect(line.tag).toBe(valid ? TAG.stage : TAG.warn);
        } else {
          const reason =
            kind === 'history'
              ? 'legacy-unknown'
              : kind === 'decreased-output'
                ? 'decreased-usage'
                : kind;
          for (const output of [h.wrote[0].text, line.text, h.logged.join('\n')]) {
            expect(output).toContain(reason);
            expect(output).toContain('не применён');
            if (!valid) expect(output).toContain(parseReport(text).why);
          }
          expect(line.text).toContain('ответ failed');
          expect(line.tag).toBe(TAG.warn);
          expect(h.supervisor.reports).toEqual([]);
          for (let cycle = 0; cycle < 2; cycle++) {
            const next = scan({
              config: { ...config, provider: 'codex', codexMaxTaskTokens: 25000000 },
              tasks: [{ ...assignment().task, id: '0001-one', status: 'design' }],
              registry: {
                entries: [{ taskId: '0001-one', branch: 'worktree-0001-one', path: 'tree' }],
              },
              reports: h.supervisor.reports,
              codexUsage: h.supervisor.codexUsage,
            });
            // Отчёт по-прежнему не применён — это проверено выше и не менялось.
            // А вот запуск неполный учёт больше не удерживает: задача идёт
            // дальше, называя неучтённый заход в записи журнала задачи.
            // Прежде здесь стоял 'hold-token-budget', и снять его владельцу
            // продукта было нечем: полноту учёта лимитом не поднимают.
            expect(next.actions.map((action) => action.kind)).toEqual(['continue-stage']);
            expect(next.actions[0].unaccounted).toContain(reason);
          }
        }
      },
    );
  }

  it('отказ записи бюджета сохраняет текст до возврата и запрещает применение', async () => {
    const h = harness({
      home: fileURLToPath(new URL('..', import.meta.url)),
      config: { provider: 'codex', codexMaxTaskTokens: 25000000 },
      saveCodexUsage: (next) => {
        if (
          Object.values(next.tasks['0001-one']?.launches ?? {}).some((launch) => launch.completed)
        )
          throw new Error('disk unavailable');
      },
    });
    h.supervisor.spawnStage(assignment());
    for (const event of [
      { type: 'thread.started', thread_id: 'thread' },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } },
    ])
      h.children[0].stdout.emit('data', JSON.stringify(event) + '\n');
    await h.answer({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 100 } });
    expect(h.wrote[0].text).toContain('--- итоговый текст ---\n' + JSON.stringify(report));
    expect(h.wrote[0].text).toContain('disk unavailable');
    expect(finishedLine(h.said).tag).toBe(TAG.warn);
    expect(h.supervisor.reports).toEqual([]);
    expect(h.supervisor.codexUsage.writeErrors).toEqual(['0001-one']);
  });
});

describe('диагностика границ Codex в finish', () => {
  it.each([
    'invalid',
    'foreign',
    'empty',
    'absent',
    'no-limit',
    'numeric-history',
    'exit',
    'new-turn',
    'turn-failed',
    'error',
  ])('%s сохраняет диагностику и прежний допуск', async (kind) => {
    const text =
      kind === 'invalid'
        ? '{некорректный JSON'
        : kind === 'empty'
          ? ''
          : JSON.stringify({ ...report, stage: kind === 'foreign' ? 'audit' : 'design' }, null, 2);
    const h = harness({
      home: fileURLToPath(new URL('..', import.meta.url)),
      config: { provider: 'codex', codexMaxTaskTokens: kind === 'no-limit' ? null : 25000000 },
      codexUsage: {},
    });
    h.supervisor.spawnStage(assignment());
    if (kind === 'numeric-history')
      h.supervisor.codexUsage.tasks['0001-one'].sessions.old = {
        knownTokens: 500,
        snapshot: null,
        reasons: ['legacy-unknown'],
      };
    const events = [
      { type: 'thread.started', thread_id: 'new' },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          status: 'declined',
          command: 'git status',
          aggregated_output: 'blocked by policy',
        },
      },
    ];
    if (kind !== 'absent')
      events.push({ type: 'item.completed', item: { type: 'agent_message', text } });
    events.push({
      type: 'turn.completed',
      usage:
        kind === 'numeric-history'
          ? { input_tokens: 1000, output_tokens: 100 }
          : { input_tokens: 'bad', output_tokens: 100 },
    });
    if (kind === 'new-turn') events.push({ type: 'turn.started' });
    if (kind === 'turn-failed')
      events.push({ type: 'turn.failed', error: { message: 'protocol failed' } });
    if (kind === 'error') events.push({ type: 'error', message: 'protocol error' });
    const stdout = events.map(JSON.stringify).join('\n') + '\n';
    h.children[0].stdout.emit('data', stdout);
    h.children[0].stderr.emit('data', 'исходный stderr');
    h.children[0].emit('close', kind === 'exit' ? 1 : 0);
    await sleep(0);
    expect(h.wrote).toHaveLength(1);
    const log = h.wrote[0].text;
    const line = finishedLine(h.said);
    expect(log).toContain('--- stdout ---\n' + stdout);
    expect(log).toContain('--- stderr ---\nисходный stderr');
    expect(log).toContain('"tool_name": "shell"');
    const discarded = ['absent', 'exit', 'new-turn', 'turn-failed', 'error'].includes(kind);
    if (discarded) expect(log).not.toContain('--- итоговый текст ---');
    else expect(log).toContain('--- итоговый текст ---\n' + text);
    if (kind === 'no-limit') {
      expect(h.supervisor.reports).toHaveLength(1);
      expect(line.tag).toBe(TAG.stage);
      expect(line.text).not.toContain('не применён');
      expect(line.text).toContain('invalid-usage');
    } else {
      expect(h.supervisor.reports).toEqual([]);
      expect(line.tag).toBe(TAG.warn);
      expect(line.text).toContain('ответ failed');
    }
    if (kind === 'numeric-history') {
      expect(line.text).toContain('расход текущего запуска известен');
      expect(line.text).toContain('legacy-unknown');
      expect(line.text).toContain('не применён');
    }
    if (kind === 'foreign') {
      expect(line.text).toContain('«audit»');
      expect(line.text).toContain('«design»');
      expect(line.text).toContain('не применён');
    }
    if (['invalid', 'empty'].includes(kind)) {
      expect(line.text).toContain(parseReport(text).why);
      expect(line.text).toContain('invalid-usage');
      expect(log).not.toContain('сессия ответа не оставила');
    }
  });
});

it('дочерний Codex учитывает только подключённый durable cumulative snapshot', async () => {
  const h = harness({
    config: { provider: 'codex' },
    home: fileURLToPath(new URL('..', import.meta.url)),
    stages: { '0001-one:design': { sessionId: 'thread', startedAt: NOW } },
    codexUsage: {
      version: 2,
      tasks: {
        '0001-one': {
          sessions: {
            thread: {
              knownTokens: 1585645,
              snapshot: { input_tokens: 1585000, output_tokens: 645 },
              reasons: [],
            },
          },
          launches: {},
        },
      },
    },
    readCodexEvidence: () => ({
      ok: true,
      snapshot: { input_tokens: 2003546, output_tokens: 3788, cached_input_tokens: 1788288 },
    }),
  });
  h.supervisor.spawnStage(assignment({ continuation: true, sessionId: 'thread' }));
  h.children[0].stdout.emit(
    'data',
    JSON.stringify({ type: 'thread.started', thread_id: 'thread' }) + '\n',
  );
  h.children[0].stdout.emit(
    'data',
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(report) },
    }) + '\n',
  );
  await h.answer({ type: 'turn.completed', usage: { input_tokens: 421089, output_tokens: 600 } });
  expect(h.supervisor.codexUsage.tasks['0001-one'].sessions.thread.knownTokens).toBe(2007334);
  expect(taskTokenStatus(h.supervisor.codexUsage, '0001-one').complete).toBe(true);
  expect(h.supervisor.reports[0]).toMatchObject(report);
  expect(h.logged.join('\n')).not.toContain('неизвестен');
});

const assignment = (over = {}) => ({
  taskId: '0001-one',
  stage: 'design',
  branch: 'worktree-0001-one',
  path: '.claude/worktrees/0001-one',
  task: { id: '0001-one', status: 'design', title: 'проба' },
  journal: '',
  board: [],
  ...over,
});

const report = { taskId: '0001-one', stage: 'design', outcome: 'done', summary: 'сделано' };

describe('источник локального benchmark до порождения', () => {
  it.each(['perf', 'bench-tick'])('старая карточка %s без source не порождает процесс', (kind) => {
    const h = harness({ prepareAssignment: (a) => prepareBenchmarkSource('/repo', a) });
    const result = h.supervisor.spawnStage(
      assignment({ stage: 'benchmark', task: { run: { kind, params: { change: 'visual' } } } }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'not-born' });
    expect(result.why).toContain('run.params.source');
    expect(h.children).toHaveLength(0);
  });
  it('ошибка доступа к источнику попадает в штатную диагностику', () => {
    const h = harness({
      prepareAssignment: (a) =>
        prepareBenchmarkSource('/repo', a, {
          git: () => {
            throw new Error('EACCES');
          },
        }),
    });
    const result = h.supervisor.spawnStage(
      assignment({
        stage: 'benchmark',
        task: { run: { kind: 'perf', params: { source: { branch: 'visual' } } } },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'not-born' });
    expect(result.why).toContain('EACCES');
    expect(result.why).toContain('visual');
    expect(h.children).toHaveLength(0);
  });
});

const envelope = (over = {}) => ({
  is_error: false,
  session_id: 'сессия-от-приложения',
  result: JSON.stringify(report),
  ...over,
});

describe('история логов в назначении разбора', () => {
  it('снимок защиты содержит живой запуск, а после завершения — сохранённый отчёт', async () => {
    const parent = resolve('.matchlog');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'log-protection-'));
    try {
      const queue = openReportStore(join(root, 'queue.json'));
      const h = harness({ reportStore: queue });
      h.supervisor.spawnStage(assignment());
      const live = h.supervisor.stageLogProtection();
      expect(live[0]).toMatchObject({ taskId: '0001-one', stage: 'design' });
      expect(live[0].launchId).toBeTruthy();
      await h.answer(envelope());
      const pending = h.supervisor.stageLogProtection();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject(live[0]);
      expect(pending[0].launchId).toBe(h.wrote[0].launch.launchId);
      queue.acknowledge(queue.entries()[0].reportId);
      expect(h.supervisor.stageLogProtection()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('снимок защиты сохраняет неизвестную идентичность сироты и несохранённый отчёт', async () => {
    const orphan = harness({
      stages: {
        '0002-orphan:implement': {
          live: {
            pid: 900,
            image: 'claude.exe',
            machine: 'станция-1',
            startedAt: NOW,
            timeoutMs: 9999999,
          },
        },
      },
    });
    expect(orphan.supervisor.stageLogProtection()).toContainEqual({
      taskId: '0002-orphan',
      stage: 'implement',
      launchId: undefined,
    });
    const h = harness({
      reportStore: {
        entries: () => [],
        accept: () => {
          throw new Error('queue write failed');
        },
      },
    });
    h.supervisor.spawnStage(assignment());
    await h.answer(envelope());
    expect(h.supervisor.stageLogProtection()).toContainEqual(
      expect.objectContaining({
        taskId: '0001-one',
        stage: 'design',
        launchId: h.wrote[0].launch.launchId,
      }),
    );
  });

  it('ошибка чтения очереди защиты не превращается в пустой снимок', () => {
    let fail = false;
    const h = harness({
      reportStore: {
        entries: () => {
          if (fail) throw new Error('queue unreadable');
          return [];
        },
      },
    });
    fail = true;
    expect(() => h.supervisor.stageLogProtection()).toThrow('queue unreadable');
  });
  it('фиксированный review содержит полный второй rejected после применения первого', async () => {
    const parent = resolve('.matchlog');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'review-history-'));
    try {
      const store = openStageLogs(root);
      const queue = openReportStore(join(root, 'queue.json'));
      let tick = 0;
      const h = harness({
        reportStore: queue,
        writeStageLog: store.writeStageLog,
        now: () => new Date(Date.UTC(2026, 7, 1, 0, 0, tick++)).toISOString(),
      });
      for (const summary of ['first finding', 'second finding']) {
        expect(h.supervisor.spawnStage(assignment({ stage: 'review' })).ok).toBe(true);
        const result = JSON.stringify({ ...report, stage: 'review', outcome: 'rejected', summary });
        await h.answer(envelope({ result }));
        expect(readFileSync(join(root, '0001-one-review.log'), 'utf8')).toContain(result);
        queue.acknowledge(queue.entries()[0].reportId);
      }
      const latest = readFileSync(join(root, '0001-one-review.log'), 'utf8');
      expect(latest).toContain('исход отчёта:  rejected');
      expect(latest).not.toContain('first finding');
      expect(store.readStageLogs('0001-one', 'review').entries).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['implement', 'review'])(
    'два захода %s сохраняются и доставляются без дубля копии',
    async (stage) => {
      const parent = resolve('.matchlog');
      mkdirSync(parent, { recursive: true });
      const root = mkdtempSync(join(parent, 'stage-history-integration-'));
      try {
        const store = openStageLogs(root);
        let tick = 0;
        const h = harness({
          writeStageLog: store.writeStageLog,
          readStageLogs: store.readStageLogs,
          now: () => new Date(Date.UTC(2026, 7, 1, 0, 0, tick++)).toISOString(),
        });
        for (const marker of ['FIRST-CAUSE', 'SECOND-FAILURE']) {
          expect(
            h.supervisor.spawnStage(assignment({ stage, sessionId: 'same', continuation: true }))
              .ok,
          ).toBe(true);
          h.children.at(-1).stderr.emit('data', `tail-${marker}`);
          await h.answer(
            envelope({
              result: marker,
              permission_denials: [
                { tool_name: 'Bash', tool_input: { command: 'denied-command' } },
              ],
            }),
            1,
          );
        }
        const alias = join(root, `0001-one-${stage}.log`);
        const entries = store.readStageLogs('0001-one', stage).entries;
        expect(entries).toHaveLength(2);
        expect(readdirSync(root)).toHaveLength(3);
        expect(readFileSync(alias, 'utf8')).toBe(readFileSync(entries[0].historyPath, 'utf8'));
        expect(readFileSync(alias, 'utf8')).toContain('SECOND-FAILURE');
        expect(readFileSync(alias, 'utf8')).not.toContain('FIRST-CAUSE');
        expect(h.wrote[0].launch.launchId).not.toBe(h.wrote[1].launch.launchId);
        expect(h.wrote[0].launch.startedAt).not.toBe(h.wrote[1].launch.startedAt);
        expect(
          h.supervisor.spawnStage(assignment({ stage: 'postmortem', task: { returnTo: stage } }))
            .ok,
        ).toBe(true);
        // Промпт приходит по stdin, как у настоящего процесса.
        const asked = harness({
          readStageLogs: store.readStageLogs,
        });
        expect(
          asked.supervisor.spawnStage(
            assignment({ stage: 'postmortem', task: { returnTo: stage } }),
          ).ok,
        ).toBe(true);
        const prompt = asked.children[0].prompt;
        expect(prompt).toContain(alias);
        expect(prompt).toContain(entries[0].historyPath);
        expect(prompt).toContain(entries[1].path);
        expect(prompt).toContain('FIRST-CAUSE');
        expect(prompt).toContain('SECOND-FAILURE');
        expect(prompt.indexOf('SECOND-FAILURE')).toBeLessThan(prompt.indexOf('FIRST-CAUSE'));
        expect(prompt).toContain('denied-command');
        expect(prompt).toContain('tail-SECOND-FAILURE');
        expect(prompt.split('### Заход ')).toHaveLength(3);
        await asked.answer(envelope({ result: 'end' }), 1);
        await h.answer(envelope({ result: 'end' }), 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { returnTo: 'implement' },
    { delayAnalysis: { phase: 'analyzing', originStatus: 'review' } },
    {
      delayAnalysis: { phase: 'verifying', originStatus: 'blocked' },
      blockedContext: { from: 'revise' },
    },
    {
      delayAnalysis: { phase: 'analyzing', originStatus: 'awaiting-po', originReturnTo: 'design' },
    },
    {},
  ])('сохраняет выбор исходного этапа для %j', async (task) => {
    const expected =
      task.returnTo ??
      task.blockedContext?.from ??
      task.delayAnalysis?.originReturnTo ??
      task.delayAnalysis?.originStatus;
    const calls = [];
    const h = harness({
      readStageLogs: (taskId, stage) => {
        calls.push({ taskId, stage });
        return { stage, entries: [] };
      },
    });
    expect(
      h.supervisor.spawnStage(
        assignment({ stage: 'postmortem', task: { ...task, status: 'postmortem' } }),
      ).ok,
    ).toBe(true);
    expect(calls).toEqual([{ taskId: '0001-one', stage: expected }]);
    await h.answer(envelope({ result: 'end' }), 1);
  });

  it('ошибка диагностической записи не теряет принятый отчёт после перезапуска', async () => {
    const parent = resolve('.matchlog');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'stage-log-report-'));
    try {
      const path = join(root, 'reports.json');
      const h = harness({
        reportStore: openReportStore(path),
        writeStageLog: () => {
          throw new Error('log EACCES');
        },
      });
      h.supervisor.spawnStage(assignment());
      await h.answer(envelope());
      expect(openReportStore(path).entries()[0].report).toMatchObject(report);
      expect(h.supervisor.busy()).toBe(0);
      expect(h.logged.join('\n')).toContain('log EACCES');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('устойчивая очередь завершений', () => {
  it('сопоставляет старый дескриптор по полной тройке времени, станции и этапа', () => {
    const f = deliveryFixture({ stage: 'design' });
    try {
      const h = harness({
        reportStore: f.open().store,
        machine: 'test',
        stages: {
          '0001-task:design': {
            sessionId: 'old',
            live: { pid: 900, startedAt: f.now, machine: 'test' },
          },
        },
      });
      expect(h.supervisor.orphanOutcomes).toEqual([]);
      expect(h.supervisor.busy()).toBe(0);
      expect(() =>
        harness({
          reportStore: f.open().store,
          stages: { '0001-task:design': { sessionId: 'old', live: { pid: 900 } } },
        }),
      ).toThrow('неоднозначный');
    } finally {
      f.cleanup();
    }
  });
  it('сохраняет полный отчёт до снятия live, включая паузу переноса', async () => {
    const f = deliveryFixture({ stage: 'design' });
    try {
      const store = f.open().store;
      store.acknowledge(f.entry.reportId);
      const h = harness({
        reportStore: store,
        saveStages: (stages) => {
          if (stages['0001-one:design'] && !stages['0001-one:design'].live)
            expect(store.entries()).toHaveLength(1);
        },
      });
      h.supervisor.spawnStage(assignment());
      await h.answer(envelope({ total_cost_usd: 3 }));
      expect(h.supervisor.reports).toHaveLength(1);
      expect(f.open().store.entries()[0].report).toMatchObject({ ...report, costUsd: 3 });
      expect(h.supervisor.running()).toEqual([]);
      expect(scan({ config, reports: h.supervisor.reports, paused: true }).actions).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
  it('удерживает результат и блокирует выдачу до повторной записи', async () => {
    const f = deliveryFixture();
    try {
      const store = f.open().store;
      store.acknowledge(f.entry.reportId);
      const accept = store.accept;
      let broken = true;
      store.accept = (...args) => {
        if (broken) throw new Error('disk unavailable');
        return accept(...args);
      };
      const h = harness({ reportStore: store });
      h.supervisor.spawnStage(assignment());
      await h.answer(envelope());
      expect(h.supervisor.reportStorageBlocked).toBe(true);
      expect(h.saved.at(-1)['0001-one:design'].live).toBeTruthy();
      expect(h.supervisor.spawnStage(assignment({ taskId: '0002-other' }))).toMatchObject({
        ok: false,
        reason: 'busy',
      });
      expect(h.logged.join('\n')).toContain('disk unavailable');
      broken = false;
      h.supervisor.sweep();
      expect(h.supervisor.reportStorageBlocked).toBe(false);
      expect(h.saved.at(-1)['0001-one:design'].live).toBeUndefined();
      expect(f.open().store.entries()).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
  it.each(['launch', 'other-launch', null])(
    'восстанавливает сироту по идентичности запуска %s',
    (launchId) => {
      const f = deliveryFixture({ stage: 'design' });
      try {
        const store = f.open().store;
        if (launchId === null) store.acknowledge(f.entry.reportId);
        const h = harness({
          reportStore: store,
          machine: 'test',
          probe: () => ({ known: true, alive: false }),
          stages: {
            '0001-task:design': {
              sessionId: 'session',
              live: { launchId: launchId ?? 'absent', pid: 900, startedAt: f.now, machine: 'test' },
            },
          },
        });
        if (launchId === 'launch') {
          expect(h.supervisor.orphanOutcomes).toEqual([]);
          expect(h.saved.at(-1)['0001-task:design'].live).toBeUndefined();
          expect(store.entries()).toHaveLength(1);
          expect(h.supervisor.busy()).toBe(0);
        } else expect(h.supervisor.orphanOutcomes).toHaveLength(1);
      } finally {
        f.cleanup();
      }
    },
  );
  it('не забывает сессию в памяти, если её удаление с диска не удалось', () => {
    let broken = true;
    const h = harness({
      stages: { '0001-one:design': { sessionId: 'kept' } },
      saveStages: () => {
        if (broken) throw new Error('disk failure');
      },
    });
    expect(() => h.supervisor.forgetSession('0001-one', 'design')).toThrow('disk failure');
    expect(h.supervisor.lastSession('0001-one', 'design')).toBe('kept');
    broken = false;
    expect(h.supervisor.forgetSession('0001-one', 'design')).toBe(true);
  });
});

describe('порождение', () => {
  it('последний допуск запрещает рабочий запуск до раннего анализа и его продолжение после окончательного предела', () => {
    for (const [stage, spent, tokenReanalysis] of [
      ['design', 150, undefined],
      ['decompose', 250, { phase: 'analyzing', originStatus: 'design' }],
    ]) {
      const h = harness({
        config: { provider: 'codex', codexTaskReanalysisTokens: 150, codexMaxTaskTokens: 250 },
        codexUsage: {
          version: 2,
          tasks: {
            '0001-one': {
              sessions: {
                prior: {
                  knownTokens: spent,
                  snapshot: { input_tokens: spent, output_tokens: 0 },
                  reasons: [],
                },
              },
              launches: {},
            },
          },
        },
      });
      expect(
        h.supervisor.spawnStage(
          assignment({
            stage,
            task: { id: '0001-one', type: 'feature', status: stage, tokenReanalysis },
          }),
        ),
      ).toMatchObject({ ok: false, reason: 'busy' });
      expect(h.children).toHaveLength(0);
    }
  });

  it('сохраняет снимок до spawn и передаёт подготовленный путь', () => {
    const deployment = { path: '.pipeline/deploy-checkouts/deploy-test', revision: 'a'.repeat(40) };
    let observed;
    let h;
    h = harness({
      prepareAssignment: (a, previous) => {
        observed = previous;
        return {
          ...a,
          path: deployment.path,
          branch: null,
          deployment,
          deploymentRevision: deployment.revision,
        };
      },
      onSpawn: ({ options }) => {
        expect(h.saved.at(-1)['0001-one:deploy'].deployment).toEqual(deployment);
        expect(options.cwd.replaceAll('\\', '/')).toContain(deployment.path);
      },
    });
    expect(h.supervisor.spawnStage(assignment({ stage: 'deploy' })).ok).toBe(true);
    expect(observed).toBeUndefined();
    expect(h.saved.at(-1)['0001-one:deploy'].deployment).toEqual(deployment);
  });

  it('ошибка подготовки не порождает исполнителя', () => {
    const h = harness({
      prepareAssignment: () => {
        throw new Error('снимок изменён');
      },
    });
    expect(h.supervisor.spawnStage(assignment({ stage: 'deploy' }))).toEqual({
      ok: false,
      reason: 'not-born',
      why: 'снимок изменён',
    });
    expect(h.children).toHaveLength(0);
  });

  it('снимок несостоявшегося запуска переживает перезапуск супервизора', () => {
    const deployment = { path: '.pipeline/deploy-checkouts/deploy-test', revision: 'b'.repeat(40) };
    const first = harness({
      stillborn: true,
      prepareAssignment: (a) => ({ ...a, deployment }),
    });
    expect(first.supervisor.spawnStage(assignment({ stage: 'deploy' })).ok).toBe(false);
    let previous;
    const second = harness({
      stages: first.saved.at(-1),
      prepareAssignment: (a, saved) => {
        previous = saved;
        return { ...a, deployment: saved.deployment };
      },
    });
    expect(second.supervisor.spawnStage(assignment({ stage: 'deploy' })).ok).toBe(true);
    expect(previous.deployment).toEqual(deployment);
  });

  it('этап становится видимым как идущий', () => {
    const { supervisor } = harness();
    expect(supervisor.spawnStage(assignment()).ok).toBe(true);
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'design' }]);
  });

  it('по одной задаче второго этапа не заводят', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    const second = supervisor.spawnStage(assignment({ stage: 'audit' }));
    expect(second.ok).toBe(false);
    expect(second.why).toContain('уже идёт');
  });

  it('разбору берётся лог того этапа, из которого задача упала', () => {
    // Имя лога складывается из задачи и этапа, а этап хранит сама задача —
    // состоянием возврата. Угадывать его по журналу было бы гаданием.
    const { supervisor, logsAsked } = harness();
    supervisor.spawnStage(
      assignment({
        stage: 'postmortem',
        task: { id: '0001-one', status: 'postmortem', returnTo: 'implement', title: 'проба' },
      }),
    );
    expect(logsAsked).toEqual(['0001-one:implement']);
  });

  it('проверка прежнего вопроса читает лог задавшего его этапа', () => {
    const { supervisor, logsAsked } = harness();
    supervisor.spawnStage(
      assignment({
        stage: 'postmortem',
        task: {
          id: '0001-one',
          status: 'postmortem',
          returnTo: 'implement',
          delayAnalysis: {
            originStatus: 'awaiting-po',
            originReturnTo: 'implement',
            phase: 'analyzing',
          },
        },
      }),
    );
    expect(logsAsked).toEqual(['0001-one:implement']);
  });

  it('прочим этапам лог не читается вовсе', () => {
    const { supervisor, logsAsked } = harness();
    supervisor.spawnStage(assignment());
    expect(logsAsked).toEqual([]);
  });

  it('квота — это счёт живых детей, а не число в настройке', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    const other = supervisor.spawnStage(assignment({ taskId: '0002-two' }));
    expect(other.ok).toBe(false);
    expect(supervisor.busy()).toBe(1);
  });

  it('при большей квоте второй этап проходит', () => {
    const { supervisor } = harness({ config: { maxConcurrent: 2 } });
    supervisor.spawnStage(assignment());
    expect(supervisor.spawnStage(assignment({ taskId: '0002-two' })).ok).toBe(true);
  });

  it('идентификатор сессии выдаётся заранее и запоминается', () => {
    // Тогда возобновлять есть что даже после падения супервизора.
    const { supervisor, saved } = harness();
    const { sessionId } = supervisor.spawnStage(assignment());
    expect(sessionId).toBeTruthy();
    expect(saved.at(-1)['0001-one:design'].sessionId).toBe(sessionId);
  });

  it('память о сессии переживает перезапуск', () => {
    const { supervisor } = harness({
      stages: { '0001-one:design': { sessionId: 'прежняя', startedAt: NOW } },
    });
    expect(supervisor.lastSession('0001-one', 'design')).toBe('прежняя');
    expect(supervisor.lastSession('0001-one', 'audit')).toBe(null);
  });

  it('забытая сессия не возобновляется и забвение переживает перезапуск', () => {
    // Задачу вернули на пройденный этап: возобновлённая сессия ответила бы
    // из своей памяти «всё сделано», не читая замечания, ради которого её
    // и позвали. Забвение обязано лечь на диск — иначе перезапуск супервизора
    // воскресит ту же память.
    const { supervisor, saved } = harness({
      stages: {
        '0001-one:design': { sessionId: 'прежняя', startedAt: NOW },
        '0001-one:audit': { sessionId: 'аудиторская', startedAt: NOW },
      },
    });
    expect(supervisor.forgetSession('0001-one', 'design')).toBe(true);
    expect(supervisor.lastSession('0001-one', 'design')).toBe(null);
    expect(saved.at(-1)).not.toHaveProperty('0001-one:design');
    // Чужую сессию забвение не задевает.
    expect(supervisor.lastSession('0001-one', 'audit')).toBe('аудиторская');
    const restarted = harness({ stages: saved.at(-1) }).supervisor;
    expect(restarted.lastSession('0001-one', 'design')).toBeNull();
    expect(restarted.stageStartedAt('0001-one', 'design')).toBeNull();
    expect(restarted.lastSession('0001-one', 'audit')).toBe('аудиторская');
    expect(restarted.stageStartedAt('0001-one', 'audit')).toBe(NOW);
  });

  it('забывать нечего — и говорится об этом прямо', () => {
    const { supervisor, saved } = harness();
    expect(supervisor.forgetSession('0001-one', 'design')).toBe(false);
    expect(saved).toEqual([]);
  });
});

describe('несостоявшийся запуск', () => {
  // Отказ порождения и упавший этап — разные беды, и лечатся они по-разному.
  // Разбирается это полем `reason`, а не текстом сообщения: сравнение русских
  // строк между файлами превратило бы правку формулировки в подмену смысла.

  it('теснота называется занятостью, а не поломкой', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    expect(supervisor.spawnStage(assignment({ taskId: '0002-two' })).reason).toBe('busy');
    expect(supervisor.spawnStage(assignment({ stage: 'audit' })).reason).toBe('busy');
  });

  it('теснота не делает этап идущим', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    supervisor.spawnStage(assignment({ taskId: '0002-two' }));
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'design' }]);
  });

  it('процесс без номера запущенным не считается', () => {
    // Так `spawn` отвечает на несуществующую команду: объект возвращает сразу,
    // а `ENOENT` присылает событием позже. Дожидаться события нельзя.
    const { supervisor } = harness({ stillborn: true });
    const spawned = supervisor.spawnStage(assignment());

    expect(spawned.ok).toBe(false);
    expect(spawned.reason).toBe('not-born');
    expect(supervisor.running()).toEqual([]);
  });

  it('идентификатор незаведённой сессии не запоминается', () => {
    // Иначе следующее продолжение ушло бы возобновлять то, чего не было,
    // и умерло бы за секунды с «No conversation found with session ID».
    const { supervisor, saved } = harness({ stillborn: true });
    supervisor.spawnStage(assignment());

    expect(supervisor.lastSession('0001-one', 'design')).toBe(null);
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(null);
    expect(saved).toEqual([]);
  });

  it('о несостоявшемся запуске не пишут «запущен»', () => {
    const { supervisor, logged } = harness({ stillborn: true });
    supervisor.spawnStage(assignment());
    expect(logged.join()).not.toContain('запущен');
  });

  it('упавшее порождение — тоже не рождение', () => {
    // Так выглядел `spawn ENAMETOOLONG`, отбивший запуск двенадцати задачам
    // за ночь 31.08–01.09.2026.
    const { supervisor } = harness({ spawnThrows: 'spawn ENAMETOOLONG' });
    const spawned = supervisor.spawnStage(assignment());

    expect(spawned.reason).toBe('not-born');
    expect(spawned.why).toContain('ENAMETOOLONG');
    expect(supervisor.running()).toEqual([]);
  });

  it('удавшееся порождение по-прежнему помнит сессию и говорит о запуске', () => {
    const { supervisor, logged } = harness();
    const spawned = supervisor.spawnStage(assignment());

    expect(spawned.ok).toBe(true);
    expect(supervisor.lastSession('0001-one', 'design')).toBe(spawned.sessionId);
    expect(logged.join()).toContain('запущен');
  });
});

describe('отметка начала этапа', () => {
  // Ею отличают свежий коммит от чужого, когда отказ судят по следу.
  const LATER = '2026-08-31T13:00:00+03:00';

  it('первый заход её ставит', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(NOW);
  });

  it('продолжение её не двигает', async () => {
    // Продолжатель приходит к уже сделанным коммитам: сдвинув отметку,
    // он объявил бы их чужими и отправил бы задачу в разбор ни за что.
    let clock = NOW;
    const { supervisor, answer } = harness({ now: () => clock });
    supervisor.spawnStage(assignment());
    clock = LATER;
    await answer(envelope({ result: 'без отчёта' }));

    supervisor.spawnStage(assignment({ continuation: true }));
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(NOW);
  });

  it('отчёт замещает идентификатор сессии, но не отметку', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(supervisor.lastSession('0001-one', 'design')).toBe('сессия-от-приложения');
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(NOW);
  });

  it('забвение стирает и отметку', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    supervisor.forgetSession('0001-one', 'design');
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(null);
  });

  it('файл прежней раскладки читается, а отметка выходит пустой', () => {
    // Так выглядит первый запуск после обновления: супервизор перезапускает
    // сторож, и он приходит к файлу, где значением была голая строка.
    const { supervisor } = harness({ stages: { '0001-one:design': 'прежняя' } });
    expect(supervisor.lastSession('0001-one', 'design')).toBe('прежняя');
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(null);
  });
});

describe('дескриптор живого этапа', () => {
  // Всё изменение затевалось ради него. Пока живость жила единственным
  // экземпляром в памяти, преемник, взявший замок, не видел ни одного этапа,
  // порождённого прежним супервизором: он выдавал живому этапу продолжение
  // и заводил второй процесс на его рабочем дереве (0074, 0030).

  it('после порождения лежит на диске с номером процесса и опознанием', () => {
    const { supervisor, saved, children } = harness();
    supervisor.spawnStage(assignment());

    const live = saved.at(-1)['0001-one:design'].live;
    expect(live).toMatchObject({
      pid: children.at(-1).pid,
      image: 'claude.exe',
      machine: 'станция-1',
      supervisorPid: 777,
    });
    expect(live.startedAt).toBe(NOW);
    expect(live.timeoutMs).toBeGreaterThan(0);
  });

  it('опознание спрашивается у системы номером порождённого процесса', () => {
    // Не выводится из настройки: `claudeCommand` равно «claude», на Windows
    // это обёртка `.cmd`, и образ живого процесса ей не равен — сверка
    // с настройкой давала бы несовпадение всегда.
    const { supervisor, children, probed } = harness();
    supervisor.spawnStage(assignment());
    expect(probed).toEqual([children.at(-1).pid]);
  });

  it('не спросилось — дескриптор всё равно ложится, но без опознания', () => {
    const { supervisor, saved, logged } = harness({
      probe: () => ({ known: false, alive: false, image: null }),
    });
    supervisor.spawnStage(assignment());

    const live = saved.at(-1)['0001-one:design'].live;
    expect(live.pid).toBeTruthy();
    expect(live.image).toBeUndefined();
    expect(logged.join()).toContain('без опознания');
  });

  it('упавший опрос системы порождение не отменяет', () => {
    // Супервизор ведёт все задачи разом: падать на опросе одного процесса
    // он не вправе, а этап уже порождён и работает.
    const { supervisor, saved } = harness({
      probe: () => {
        throw new Error('нет такой команды');
      },
    });
    expect(supervisor.spawnStage(assignment()).ok).toBe(true);
    expect(saved.at(-1)['0001-one:design'].live.image).toBeUndefined();
  });

  it('после завершения этапа дескриптора нет, а память о сессии осталась', async () => {
    const { supervisor, saved, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(saved.at(-1)['0001-one:design'].live).toBeUndefined();
    expect(supervisor.lastSession('0001-one', 'design')).toBe('сессия-от-приложения');
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(NOW);
  });

  it('дескриптор стирается и при исходе без отчёта', async () => {
    // Оставленный, он объявил бы задачу занятой навсегда — и это было бы
    // хуже прежней беды, а не лучше.
    const { supervisor, saved, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'без отчёта', session_id: null }));

    expect(saved.at(-1)['0001-one:design'].live).toBeUndefined();
  });

  it('несостоявшееся порождение дескриптора не оставляет', () => {
    const { supervisor, saved } = harness({ stillborn: true });
    supervisor.spawnStage(assignment());
    expect(saved).toEqual([]);
  });

  it('запись прежней раскладки читается без дескриптора и без ошибки', () => {
    // Так выглядит первый запуск после обновления: значением была голая
    // строка, и отсутствие дескриптора означает «этап не идёт».
    const { supervisor } = harness({ stages: { '0001-one:design': 'прежняя' } });
    expect(supervisor.lastSession('0001-one', 'design')).toBe('прежняя');
    expect(supervisor.running()).toEqual([]);
  });
});

describe('сироты при запуске', () => {
  // Ради этого и затевалось изменение. Прежде преемник, взявший замок, не видел
  // ни одного этапа, порождённого прежним супервизором: сканер спрашивал
  // живость, получал «нет» и следующим же оборотом выдавал живому этапу
  // продолжение, заводя второй процесс на его рабочем дереве.

  /** Состояние на диске с дескриптором живого этапа. */
  const withLive = (over = {}) => ({
    '0001-one:implement': {
      sessionId: 'прежняя',
      startedAt: NOW,
      live: {
        pid: 29704,
        image: 'claude.exe',
        machine: 'станция-1',
        supervisorPid: 111,
        startedAt: NOW,
        startedMs: 900_000,
        timeoutMs: 3_600_000,
        ...over,
      },
    },
  });

  it('живой опознанный сирота числится идущим этапом', () => {
    const { supervisor } = harness({ stages: withLive() });
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'implement' }]);
    expect(supervisor.busy()).toBe(1);
  });

  it('опознание сверяется с записанным, а не с настройкой', () => {
    // Номер занял посторонний процесс: дескриптор протух. Этап не идёт,
    // а сам процесс не наш, и снимать его нельзя.
    const { supervisor, killed } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: true, image: 'chrome.exe' }),
    });
    expect(supervisor.running()).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('исчезнувший процесс освобождает задачу и назван в журнале цикла', () => {
    const { supervisor, logged } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(supervisor.running()).toEqual([]);
    expect(logged.join()).toContain('осиротел');
  });

  it('сирота без опознания в дескрипторе числится идущим', () => {
    // Опросить систему при рождении могло не удаться. Объявить такого
    // исчезнувшим — это ровно выдача продолжения живому этапу.
    const { supervisor } = harness({
      stages: withLive({ image: undefined }),
      probe: () => ({ known: true, alive: true, image: 'claude.exe' }),
    });
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'implement' }]);
  });

  it('неотвечающий опрос системы тоже оставляет этап идущим', () => {
    const { supervisor } = harness({
      stages: withLive(),
      probe: () => ({ known: false, alive: false, image: null }),
    });
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'implement' }]);
  });

  it('дескриптор исчезнувшего остаётся на диске до записи исхода в журнал', () => {
    // Обрыв между «убрал из перечня» и «записал в журнал» обязан оставлять
    // дескриптор на месте: повторная запись стоит одного лишнего
    // комментария, потерянная — необъяснимого провала в журнале задачи.
    const { supervisor, saved } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(saved).toEqual([]);

    expect(supervisor.forgetOrphan('0001-one', 'implement')).toBe(true);
    expect(saved.at(-1)['0001-one:implement'].live).toBeUndefined();
    expect(supervisor.orphanOutcomes).toEqual([]);
  });

  it('дескриптор чужой станции не судится, стирается и назван в журнале', () => {
    const { supervisor, saved, logged, probed } = harness({
      stages: withLive({ machine: 'станция-2' }),
    });
    expect(supervisor.running()).toEqual([]);
    expect(saved.at(-1)['0001-one:implement'].live).toBeUndefined();
    expect(logged.join()).toContain('станция-2');
    // И опрашивать его незачем: номер чужой машины здесь не значит ничего.
    expect(probed).toEqual([]);
  });

  it('память о сессии сироты остаётся: её и будет возобновлять продолжатель', () => {
    const { supervisor } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(supervisor.lastSession('0001-one', 'implement')).toBe('прежняя');
    expect(supervisor.stageStartedAt('0001-one', 'implement')).toBe(NOW);
  });

  it('второго процесса по задаче живого сироты не порождается', () => {
    const { supervisor, children } = harness({ stages: withLive() });
    const spawned = supervisor.spawnStage(assignment({ taskId: '0001-one', stage: 'implement' }));

    expect(spawned.ok).toBe(false);
    expect(spawned.reason).toBe('busy');
    expect(children).toEqual([]);
  });
});

describe('обход сирот по обороту', () => {
  // Сирота живёт минутами и часами, поэтому судить его один раз при запуске
  // мало: он кончится посреди работы супервизора, и место должно
  // освободиться тогда же, а не при следующем перезапуске.

  /** Дескриптор с управляемым возрастом: начат в 900 000, срок — час. */
  const withLive = (over = {}) => ({
    '0001-one:implement': {
      sessionId: 'прежняя',
      startedAt: NOW,
      live: {
        pid: 29704,
        image: 'claude.exe',
        machine: 'станция-1',
        supervisorPid: 111,
        startedAt: NOW,
        startedMs: 900_000,
        timeoutMs: 3_600_000,
        ...over,
      },
    },
  });

  /** Часы: 900 000 — миг рождения, дальше — сколько прошло. */
  const at = (ms) => () => 900_000 + ms;

  it('кончившийся посреди работы уходит из перечня в тот же обход', () => {
    let alive = true;
    const { supervisor } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive, image: 'claude.exe' }),
    });
    expect(supervisor.running()).toHaveLength(1);

    alive = false;
    supervisor.sweep();
    expect(supervisor.running()).toEqual([]);
  });

  it('исход исчезнувшего встаёт в очередь с номером процесса и отметкой начала', () => {
    const { supervisor } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(supervisor.orphanOutcomes).toHaveLength(1);
    expect(supervisor.orphanOutcomes[0]).toMatchObject({
      taskId: '0001-one',
      stage: 'implement',
      pid: 29704,
      startedAt: NOW,
      outcome: 'gone',
    });
  });

  it('переживший срок опознанный снимается поддеревом', () => {
    const { supervisor, killed } = harness({
      stages: withLive(),
      nowMs: at(3_600_001),
    });
    expect(killed).toEqual([29704]);
    expect(supervisor.orphanOutcomes[0].outcome).toBe('killed');
    expect(supervisor.running()).toEqual([]);
    expect(supervisor.reports).toEqual([]);
    expect(supervisor.lastSession('0001-one', 'implement')).toBe('прежняя');
    expect(supervisor.stageStartedAt('0001-one', 'implement')).toBe(NOW);
  });

  it('срок берётся из дескриптора, а не назначается заново', () => {
    // Этапу отпущено то, что ему отпустили при запуске: час у дескриптора
    // и час не прошёл — значит он идёт, чего бы ни стояло в настройке.
    const { supervisor, killed } = harness({
      stages: withLive(),
      nowMs: at(3_599_000),
    });
    expect(killed).toEqual([]);
    expect(supervisor.running()).toHaveLength(1);
  });

  it('протухший дескриптор исход даёт, а процесс не снимает', () => {
    // Номер переиспользован системой: под ним работает кто угодно, и снятие
    // поддеревом унесло бы постороннее дерево процессов рабочей станции.
    const { supervisor, killed } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: true, image: 'chrome.exe' }),
      nowMs: at(3_600_001),
    });
    expect(killed).toEqual([]);
    expect(supervisor.orphanOutcomes[0].outcome).toBe('stale');
  });

  it('неопознанный в пределах срока остаётся идущим и назван один раз', () => {
    const { supervisor, logged } = harness({
      stages: withLive(),
      probe: () => ({ known: false, alive: false, image: null }),
      nowMs: at(60_000),
    });
    supervisor.sweep();
    supervisor.sweep();

    expect(supervisor.running()).toHaveLength(1);
    expect(logged.filter((line) => line.includes('не опознаётся'))).toHaveLength(1);
  });

  it('неопознанный за сроком уходит из перечня, но не снимается', () => {
    const { supervisor, killed } = harness({
      stages: withLive(),
      probe: () => ({ known: false, alive: false, image: null }),
      nowMs: at(3_600_001),
    });
    expect(supervisor.running()).toEqual([]);
    expect(killed).toEqual([]);
    expect(supervisor.orphanOutcomes[0].outcome).toBe('left');
  });

  it('дескриптор без опознания судится тем же правилом', () => {
    // Опрос при рождении мог не удаться. Живой процесс с таким дескриптором
    // неотличим от неопознанного, и снимать его нельзя точно так же.
    const { supervisor, killed } = harness({
      stages: withLive({ image: undefined }),
      nowMs: at(3_600_001),
    });
    expect(killed).toEqual([]);
    expect(supervisor.orphanOutcomes[0].outcome).toBe('left');
  });

  it('исход одного сироты не тянет за собой второго', () => {
    const stages = {
      ...withLive(),
      '0002-two:audit': {
        sessionId: 'вторая',
        startedAt: NOW,
        live: {
          pid: 30000,
          image: 'claude.exe',
          machine: 'станция-1',
          supervisorPid: 111,
          startedAt: NOW,
          startedMs: 900_000,
          timeoutMs: 3_600_000,
        },
      },
    };
    const { supervisor } = harness({
      stages,
      config: { maxConcurrent: 3 },
      probe: (pid) => ({ known: true, alive: pid !== 29704, image: 'claude.exe' }),
    });

    expect(supervisor.running()).toEqual([{ taskId: '0002-two', stage: 'audit' }]);
    expect(supervisor.orphanOutcomes.map((item) => item.taskId)).toEqual(['0001-one']);
  });

  it('забыть можно только записанный исход, и чужой при этом не трогается', () => {
    const { supervisor, saved } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(supervisor.forgetOrphan('0002-two', 'audit')).toBe(false);
    expect(saved).toEqual([]);
  });
});

describe('этап кончился', () => {
  it('отчёт уходит в очередь на перенос', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(supervisor.reports).toHaveLength(1);
    expect(supervisor.reports[0]).toMatchObject({ taskId: '0001-one', outcome: 'done' });
    expect(supervisor.running()).toEqual([]);
  });

  it('место освобождается для следующей задачи', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());
    expect(supervisor.spawnStage(assignment({ taskId: '0002-two' })).ok).toBe(true);
  });

  it('идентификатор из ответа точнее выданного и замещает его', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());
    expect(supervisor.lastSession('0001-one', 'design')).toBe('сессия-от-приложения');
  });

  it('приписка вокруг отчёта его не портит', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: `Готово!\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`` }));
    expect(supervisor.reports).toHaveLength(1);
  });
});

describe('пакет выкладки едет вместе с отчётом', () => {
  // У переноса своего источника нет, а сверять названных в отчёте он обязан
  // с перечнем из назначения, а не с колонкой доски: состав пакета
  // зафиксирован в момент выдачи сессии, и свежая карточка в него не входит.
  const deploying = assignment({
    stage: 'deploy',
    batch: [
      { id: '0001-one', title: 'ведущая', pr: 1 },
      { id: '0002-two', title: 'вторая', pr: 2 },
    ],
  });
  const deployed = JSON.stringify({ ...report, stage: 'deploy' });

  it('перечень возвращается идентификаторами', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(deploying);
    await answer(envelope({ result: deployed }));
    expect(supervisor.reports[0].batch).toEqual(['0001-one', '0002-two']);
  });

  it('перечень из отчёта сессии не берётся: он властен только над своим пакетом', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(deploying);
    await answer(
      envelope({ result: JSON.stringify({ ...report, stage: 'deploy', batch: ['0009-stray'] }) }),
    );
    expect(supervisor.reports[0].batch).toEqual(['0001-one', '0002-two']);
  });

  it('без пакета поля нет', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());
    expect(supervisor.reports[0]).not.toHaveProperty('batch');
  });
});

describe('отказанные действия едут вместе с отчётом', () => {
  // Прежде отчёт при непустом перечне отказов не принимался вовсе. Мерка
  // оказалась слишком грубой: вечер 31.08.2026 дал шесть отброшенных отчётов
  // подряд, и ни один не потерян из-за настоящей беды. Судить отказ по следу
  // этапа здесь нечем — отчёт ещё не разобран, — и потому суд переехал
  // в перенос отчёта, а супервизор остался хозяином процессов.
  const denied = {
    permission_denials: [
      { tool_name: 'PowerShell', tool_input: { command: 'npx --yes openspec' } },
    ],
  };

  it('отчёт кладётся в очередь переноса, а отказы едут в нём', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope(denied));

    expect(supervisor.reports).toHaveLength(1);
    expect(supervisor.reports[0].denials).toEqual(denied.permission_denials);
  });

  it('отказ назван в журнале целиком: это указание, где скилл разошёлся с делом', async () => {
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope(denied));
    expect(logged.join()).toContain('PowerShell');
    expect(logged.join()).toContain('openspec');
  });

  it('без отказов поле остаётся пустым перечнем', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());
    expect(supervisor.reports[0].denials).toEqual([]);
  });

  it('отчёт о чужом этапе не спасают никакие отказы', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ ...denied, result: JSON.stringify({ ...report, stage: 'audit' }) }));
    expect(supervisor.reports).toEqual([]);
  });
});

describe('этап не дошёл до отчёта', () => {
  it('неразобравшийся вывод отчётом не считается и назван вслух', async () => {
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'я всё сделал, а отчёт забыл' }));
    expect(supervisor.reports).toEqual([]);
    expect(logged.join()).toContain('не разобрался');
  });

  it('отчёт о чужом этапе не применяется', async () => {
    // Он посчитан по другой картине мира: применить молча значило бы
    // двинуть задачу неизвестно куда.
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, stage: 'audit' }) }));
    expect(supervisor.reports).toEqual([]);
    expect(logged.join()).toContain('не принят');
  });

  it('ненулевой код возврата отчёта не даёт', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope(), 1);
    expect(supervisor.reports).toEqual([]);
  });

  it('отчёт несёт стоимость этапа: без неё расход задачи не посчитать', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ total_cost_usd: 3.25 }));
    expect(supervisor.reports[0].costUsd).toBe(3.25);
  });

  it('ответ без стоимости даёт ноль, а не роняет перенос', () => {
    // Ответ без неё законен, и ронять из-за этого отчёт нечем оправдать.
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    return answer(envelope()).then(() => {
      expect(supervisor.reports).toHaveLength(1);
      expect(supervisor.reports[0].costUsd).toBe(0);
    });
  });

  it('отказ сервера модели уходит в свою очередь, а не в отчёты', async () => {
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    await answer(
      envelope({
        is_error: true,
        subtype: 'success',
        terminal_reason: 'api_error',
        api_error_status: 529,
        result: 'API Error: 529 Overloaded',
      }),
      1,
    );

    expect(supervisor.reports).toEqual([]);
    expect(supervisor.apiFailures).toHaveLength(1);
    expect(supervisor.apiFailures[0]).toMatchObject({ taskId: '0001-one', stage: 'design' });
    expect(supervisor.apiFailures[0].why).toContain('529');
    expect(logged.join()).toContain('отказе сервера');
  });

  it('забвение снимает отказ сервера с очереди', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ is_error: true, api_error_status: 529 }), 1);

    expect(supervisor.forgetApiFailure('0001-one', 'design')).toBe(true);
    expect(supervisor.apiFailures).toEqual([]);
    // Второй раз забывать нечего, и это не ошибка: обрыв между записью
    // и снятием оставляет очередь на месте, а повтор обязан быть безвредным.
    expect(supervisor.forgetApiFailure('0001-one', 'design')).toBe(false);
  });

  it('место всё равно освобождается: иначе задача встала бы навсегда', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'без отчёта' }));
    expect(supervisor.running()).toEqual([]);
  });
});

describe('лог этапа', () => {
  // Лог этапа читает ровно один этап — разбор, — и читает после падения,
  // когда самого процесса давно нет. Поэтому он обязан лечь на диск при
  // ЛЮБОМ исходе и нести то, чего в отчёте нет по устройству: код возврата,
  // отказанные действия и вывод целиком.

  it('пишется на этап, оставивший отчёт', async () => {
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(wrote).toHaveLength(1);
    expect(wrote[0].taskId).toBe('0001-one');
    expect(wrote[0].stage).toBe('design');
  });

  it('пишется и на этап, отчёта не оставивший', async () => {
    // Как раз тогда он единственное, что осталось от сессии.
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'я всё сделал, а отчёт забыл' }), 1);

    expect(wrote).toHaveLength(1);
  });

  it('несёт код возврата', async () => {
    // Ищем с любым отступом: колонку значений задаёт самое длинное имя поля,
    // и сторож не должен падать от перевыравнивания шапки.
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ is_error: true }), 3);

    expect(wrote[0].text).toMatch(/код:\s+3/);
  });

  it('несёт перечень отказанных действий', async () => {
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(
      envelope({
        permission_denials: [{ tool_name: 'PowerShell', tool_input: { command: 'pnpm install' } }],
      }),
    );

    expect(wrote[0].text).toContain('--- отказанные действия ---');
    expect(wrote[0].text).toContain('PowerShell');
    expect(wrote[0].text).toContain('pnpm install');
    expect(wrote[0].text).toMatch(/отказов:\s+1/);
  });

  it('называет ответ сессии и исход отчёта разными словами', async () => {
    // Ровно та ловушка, ради которой всё затеяно: процесс отработал и вернул
    // разбираемый ответ (`done`), а этап отчитался неудачей.
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, outcome: 'failed' }) }));

    expect(wrote[0].text).toMatch(/ответ сессии:\s+done/);
    expect(wrote[0].text).toMatch(/исход отчёта:\s+failed/);
  });

  it('слова «исход» без уточнения в шапке не остаётся', async () => {
    // Знакомое слово остановит читателя раньше, чем он дойдёт до нужного
    // поля, — потому оно и не сохранено синонимом ни одного из двух.
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(wrote[0].text).not.toMatch(/^исход:/m);
  });

  it('отчёт не разобрался — сказано это и сказана причина', async () => {
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'я всё сделал, а отчёт забыл' }));

    expect(wrote[0].text).toMatch(/исход отчёта:\s+отчёта нет — .*объекта JSON/);
  });

  it('ответа нет вовсе — это отличают от испорченного отчёта', async () => {
    // Снятие по сроку: сессию оборвали на середине работы, и отчёта она
    // не начинала писать. Причина разбора была бы здесь формально верной
    // и увела бы разбор искать испорченный отчёт.
    const { supervisor, children, wrote } = harness({
      config: { stageTimeoutMinutes: { ...config.stageTimeoutMinutes, design: 0.0005 } },
    });
    supervisor.spawnStage(assignment());
    await sleep(60);
    children.at(-1).emit('close', 0);
    await sleep(0);

    expect(wrote[0].text).toMatch(/ответ сессии:\s+timeout/);
    expect(wrote[0].text).toMatch(/исход отчёта:\s+отчёта нет — сессия ответа не оставила/);
  });

  it('отчёт о чужом этапе назван неприменённым', async () => {
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, stage: 'audit' }) }));

    // Целой строкой, а не по слову «audit»: оно есть и в stdout, и сторож
    // по нему зеленел бы вхолостую.
    expect(wrote[0].text).toMatch(
      /исход отчёта:\s+done \(отчёт об этапе «audit», а шёл «design» — не применён\)/,
    );
  });

  it('несёт stdout целиком, а не разобранную его часть', async () => {
    // Разбор берёт из вывода последний годный объект. Всё, что было до него,
    // разбору падения нужнее всего — там и лежит рассказ о том, что пошло
    // не так.
    const { supervisor, children, wrote } = harness();
    supervisor.spawnStage(assignment());
    const child = children.at(-1);
    child.stdout.emit('data', 'приписка до конверта\n');
    child.stdout.emit('data', JSON.stringify(envelope()));
    child.emit('close', 0);
    await sleep(0);

    expect(wrote[0].text).toContain('--- stdout ---');
    expect(wrote[0].text).toContain('приписка до конверта');
  });
});

describe('строка итога этапа на консоли', () => {
  // Консоль смотрят, а логи открывают: та же подмена здесь попадается чаще.
  // Человек, отошедший на час, читает полосу строк и различает их цветом
  // раньше, чем словами.

  it('называет оба значения', async () => {
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, outcome: 'failed' }) }));

    expect(finishedLine(said).text).toContain('ответ done');
    expect(finishedLine(said).text).toContain('исход отчёта failed');
  });

  it('отчитавшийся неудачей получает предупреждающую метку при нулевом коде', async () => {
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, outcome: 'failed' }) }));

    expect(finishedLine(said).tag).toBe(TAG.warn);
  });

  it('спокойная метка причитается только отчитавшемуся done', async () => {
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(finishedLine(said).tag).toBe(TAG.stage);
  });

  it('отчёт о чужом этапе спокойным не считается', async () => {
    // Он не применялся вовсе, каким бы ни был его исход.
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, stage: 'audit' }) }));

    expect(finishedLine(said).tag).toBe(TAG.warn);
  });

  it('отсутствие отчёта спокойным не считается', async () => {
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'я всё сделал, а отчёт забыл' }));

    expect(finishedLine(said).tag).toBe(TAG.warn);
  });
});

describe('разбор исхода не роняет супервизор', () => {
  it('падение на одном отчёте освобождает место, а не останавливает всё', async () => {
    // Супервизор ведёт все задачи разом: упав на разборе одного отчёта,
    // он остановил бы конвейер целиком.
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    // Ответ, на котором разбор споткнётся: `result` не строка и не объект.
    await answer(envelope({ result: { неожиданно: true } }));

    expect(supervisor.running()).toEqual([]);
    expect(logged.join()).not.toBe('');
  });
});

describe('остановка', () => {
  it('снимает всех детей', () => {
    const { supervisor, children, killed } = harness({ config: { maxConcurrent: 2 } });
    supervisor.spawnStage(assignment());
    supervisor.spawnStage(assignment({ taskId: '0002-two' }));

    supervisor.stopAll();

    expect(killed).toEqual(children.map((child) => child.pid));
  });

  it('живого сироту не трогает, и дескриптор его остаётся на диске', () => {
    // Своего ребёнка супервизор снимает И записывает исход. Чужого он снял бы,
    // не сумев записать: очередь исходов в этот миг исполнять уже некому.
    // Вышла бы та же потеря, ради отмены которой всё и затеяно.
    const { supervisor, killed, saved } = harness({
      stages: {
        '0001-one:implement': {
          sessionId: 'прежняя',
          startedAt: NOW,
          live: {
            pid: 29704,
            image: 'claude.exe',
            machine: 'станция-1',
            supervisorPid: 111,
            startedAt: NOW,
            startedMs: 900_000,
            timeoutMs: 3_600_000,
          },
        },
      },
    });

    supervisor.stopAll();

    expect(killed).toEqual([]);
    expect(saved).toEqual([]);
  });
});

describe('сессии разных исполнителей', () => {
  const codexHome = fileURLToPath(new URL('..', import.meta.url));
  it('не возобновляет Claude в Codex и сохраняет thread.started сразу', async () => {
    const h = harness({
      home: codexHome,
      config: { provider: 'codex', maxTaskCostUsd: null },
      stages: { '0001-one:design': { sessionId: 'old-claude', startedAt: NOW } },
    });
    expect(h.supervisor.lastSession('0001-one', 'design')).toBeNull();
    expect(
      h.supervisor.spawnStage(assignment({ continuation: true, sessionId: 'old-claude' })).ok,
    ).toBe(true);
    expect(h.saved.at(-1)['0001-one:design'].sessionId).toBeNull();
    h.children[0].stdout.emit(
      'data',
      JSON.stringify({ type: 'thread.started', thread_id: 'new-codex' }) + '\n',
    );
    expect(h.saved.at(-1)['0001-one:design']).toMatchObject({
      sessionId: 'new-codex',
      provider: 'codex',
    });
    h.children[0].stdout.emit(
      'data',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(report) },
      }) + '\n',
    );
    await h.answer({
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    });
    expect(h.supervisor.reports[0]).toMatchObject(report);
    expect(h.supervisor.lastSession('0001-one', 'design')).toBe('new-codex');
  });
  it('не отдаёт идентификатор Codex исполнителю Claude после перезапуска', () => {
    const h = harness({
      stages: { '0001-one:design': { provider: 'codex', sessionId: 'old-codex' } },
    });
    expect(h.supervisor.lastSession('0001-one', 'design')).toBeNull();
  });
});

it('watch и finish учитывают 1740, а resume использует реестр после забывания этапа', async () => {
  const h = harness({
    home: fileURLToPath(new URL('..', import.meta.url)),
    config: { provider: 'codex' },
  });
  const emit = (event) => h.children.at(-1).stdout.emit('data', JSON.stringify(event) + '\n');
  h.supervisor.spawnStage(assignment());
  const launchId = h.saved.at(-1)['0001-one:design'].live.launchId;
  expect(launchId).toBeTruthy();
  emit({ type: 'thread.started', thread_id: 'thread' });
  emit({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 100 } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1600, output_tokens: 140 } });
  expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(1740);
  h.children.at(-1).emit('close', 0);
  await sleep(0);
  expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(1740);
  expect(h.supervisor.codexUsage.tasks['0001-one'].sessions.thread.reasons).toEqual([]);
  h.supervisor.forgetSession('0001-one', 'design');
  expect(h.supervisor.spawnStage(assignment({ continuation: true, sessionId: 'thread' })).ok).toBe(
    true,
  );
  const resumed = h.saved.at(-1)['0001-one:design'].live.launchId;
  expect(resumed).not.toBe(launchId);
  expect(h.supervisor.codexUsage.tasks['0001-one'].launches[resumed].baseline).toEqual({
    input_tokens: 1600,
    output_tokens: 140,
  });
  emit({ type: 'thread.started', thread_id: 'thread' });
  await h.answer({ type: 'turn.completed', usage: { input_tokens: 2000, output_tokens: 180 } });
  expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(2180);
});

it('не подменяет отсутствующий долговечный baseline памятью этапа', async () => {
  const h = harness({
    home: fileURLToPath(new URL('..', import.meta.url)),
    config: {
      provider: 'codex',
      maxTaskCostUsd: 25,
      codexMaxTaskTokens: 25_000_000,
    },
    stages: {
      '0001-one:design': {
        provider: 'codex',
        sessionId: 'thread',
        usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 },
      },
    },
  });
  expect(h.supervisor.spawnStage(assignment({ continuation: true, sessionId: 'thread' })).ok).toBe(
    true,
  );
  h.children[0].stdout.emit(
    'data',
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(report) },
    }) + '\n',
  );
  await h.answer({
    type: 'turn.completed',
    usage: { input_tokens: 2000, cached_input_tokens: 400, output_tokens: 200 },
  });
  expect(h.supervisor.codexUsage.tasks['0001-one'].sessions.thread.knownTokens).toBe(2200);
  expect(h.supervisor.codexUsage.tasks['0001-one'].sessions.thread.reasons).toContain(
    'missing-baseline',
  );
  expect(h.supervisor.reports).toEqual([]);
  expect(h.saved.at(-1)['0001-one:design'].usage).toBeUndefined();
});

it('расход сохраняется до разбора отчёта и не исчезает при забывании сессии', async () => {
  const snapshots = [];
  const h = harness({
    home: fileURLToPath(new URL('..', import.meta.url)),
    config: { provider: 'codex', codexMaxTaskTokens: null },
    codexUsage: { '0001-one': { previous: 500 } },
    saveCodexUsage: (value) => snapshots.push(JSON.parse(JSON.stringify(value))),
  });
  h.supervisor.spawnStage(assignment());
  h.children[0].stdout.emit(
    'data',
    JSON.stringify({ type: 'thread.started', thread_id: 'new' }) + '\n',
  );
  h.children[0].stdout.emit(
    'data',
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 },
    }) + '\n',
  );
  expect(snapshots.at(-1).tasks['0001-one'].sessions.previous.knownTokens).toBe(500);
  expect(snapshots.at(-1).tasks['0001-one'].sessions.new.knownTokens).toBe(1100);
  await h.answer({ type: 'turn.failed', error: { message: 'failed after usage' } });
  expect(h.supervisor.reports).toEqual([]);
  h.supervisor.forgetSession('0001-one', 'design');
  expect(h.supervisor.codexUsage.tasks['0001-one'].sessions.new.knownTokens).toBe(1100);
  expect(h.supervisor.codexUsage.tasks['0001-one'].sessions.previous.knownTokens).toBe(500);
});

describe('долговечные наблюдения Codex', () => {
  const options = {
    home: fileURLToPath(new URL('..', import.meta.url)),
    config: { provider: 'codex', codexMaxTaskTokens: 25000000 },
  };
  const emit = (h, event) => h.children.at(-1).stdout.emit('data', JSON.stringify(event) + '\n');
  const completed = (input_tokens = 1600, output_tokens = 140) => ({
    type: 'turn.completed',
    usage: { input_tokens, output_tokens },
  });

  it('restart после watch воспроизводит сохранённый stdout с прежним launchId без повторной записи', async () => {
    const root = mkdtempSync(join(tmpdir(), 'td-watch-replay-'));
    const storage = { paths: { local: '.pipeline' } };
    try {
      let writes = 0;
      const save = (next) => {
        writeTokenLedger(root, storage, next);
        writes++;
      };
      const h = harness({ ...options, saveCodexUsage: save });
      h.supervisor.spawnStage(assignment());
      const launchId = h.saved.at(-1)['0001-one:design'].live.launchId;
      const events = [
        { type: 'thread.started', thread_id: 's' },
        completed(1000, 100),
        completed(),
        completed(),
      ];
      for (const event of events) emit(h, event);
      const ledger = readTokenLedger(root, storage);
      const result = { stdout: events.map(JSON.stringify).join('\n'), code: 0 };
      const answer = readCodexAnswer(result, options.config, {
        ledger,
        taskId: '0001-one',
        launchId,
      });
      commitTokenLedger(
        ledger,
        (next) => {
          next.tasks = answer.usageLedger.tasks;
        },
        save,
      );
      const saved = readTokenLedger(root, storage);
      const after = writes;
      const repeat = readCodexAnswer(result, options.config, {
        ledger: saved,
        taskId: '0001-one',
        launchId,
      });
      expect(
        commitTokenLedger(
          saved,
          (next) => {
            next.tasks = repeat.usageLedger.tasks;
          },
          save,
        ),
      ).toBe(false);
      expect(writes).toBe(after);
      expect(taskTokens(saved, '0001-one')).toBe(1740);
      expect(taskTokenStatus(saved, '0001-one').complete).toBe(true);
      expect(Object.keys(saved.tasks['0001-one'].launches[launchId].observations)).toHaveLength(3);
      h.children.at(-1).emit('close', 0);
      await sleep(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('новая сессия суммируется, меньший resume остаётся unknown после restart и забывания', async () => {
    const h = harness(options);
    h.supervisor.spawnStage(assignment());
    emit(h, { type: 'thread.started', thread_id: 's' });
    await h.answer(completed());
    h.supervisor.forgetSession('0001-one', 'design');
    h.supervisor.spawnStage(assignment({ stage: 'implement' }));
    emit(h, { type: 'thread.started', thread_id: 'independent' });
    await h.answer(completed(300, 20));
    expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(2060);
    h.supervisor.spawnStage(assignment({ continuation: true, sessionId: 's' }));
    emit(h, { type: 'thread.started', thread_id: 's' });
    await h.answer(completed(500, 40));
    expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(2060);
    h.supervisor.forgetSession('0001-one', 'design');
    const restarted = harness({ ...options, codexUsage: h.supervisor.codexUsage });
    expect(taskTokens(restarted.supervisor.codexUsage, '0001-one')).toBe(2060);
    expect(taskTokenStatus(restarted.supervisor.codexUsage, '0001-one').reasons).toContain(
      'decreased-usage',
    );
  });

  it.each(['failed-exit', 'invalid-report', 'truncated-turn'])(
    'сохраняет completed перед %s',
    async (ending) => {
      const h = harness(options);
      h.supervisor.spawnStage(assignment());
      emit(h, { type: 'thread.started', thread_id: 's' });
      emit(h, { type: 'item.completed', item: { type: 'agent_message', text: 'не JSON' } });
      emit(h, completed());
      if (ending === 'truncated-turn') emit(h, { type: 'turn.started' });
      h.children.at(-1).emit('close', ending === 'failed-exit' ? 1 : 0);
      await sleep(0);
      expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(1740);
      expect(taskTokenStatus(h.supervisor.codexUsage, '0001-one').complete).toBe(
        ending === 'invalid-report',
      );
      expect(h.supervisor.reports).toEqual([]);
    },
  );

  it.each(['0001-one', '0002-two'])(
    'после сбоя записи до spawn задача %s запускается без перезапуска супервизора',
    async (taskId) => {
      let fail = true;
      let writes = 0;
      let persisted;
      const h = harness({
        ...options,
        saveCodexUsage: (next) => {
          writes += 1;
          if (fail) throw new Error('disk unavailable');
          persisted = JSON.parse(JSON.stringify(next));
        },
        onSpawn: () => {
          expect(persisted.tasks[taskId].launches).toBeDefined();
        },
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(h.supervisor.spawnStage(assignment())).toMatchObject({
          ok: false,
          reason: 'not-born',
          why: 'disk unavailable',
        });
        expect(h.children).toHaveLength(0);
        expect(h.supervisor.busy()).toBe(0);
        expect(h.supervisor.codexUsage.writeErrors).toEqual([]);
        expect(taskTokenStatus(h.supervisor.codexUsage, '0001-one').complete).toBe(true);
      }
      expect(writes).toBe(2);
      fail = false;
      expect(h.supervisor.spawnStage(assignment({ taskId })).ok).toBe(true);
      expect(writes).toBe(3);
      expect(h.children).toHaveLength(1);
      emit(h, { type: 'thread.started', thread_id: 's' });
      await h.answer(completed());
      expect(taskTokens(persisted, taskId)).toBe(1740);
      expect(taskTokenStatus(h.supervisor.codexUsage, taskId).complete).toBe(true);
    },
  );

  it.each([
    ['throw', '0001-one', 'spawn'],
    ['throw', '0002-two', 'sweep'],
    ['no-pid', '0001-one', 'sweep'],
    ['no-pid', '0002-two', 'spawn'],
  ])('повтор отмены %s восстанавливает %s через %s', async (failure, taskId, retry) => {
    let writes = 0;
    let failCancel = true;
    let persisted;
    let cancelledId;
    const over = {
      ...options,
      spawnThrows: failure === 'throw' ? 'spawn failed' : null,
      stillborn: failure === 'no-pid',
      saveCodexUsage: (next) => {
        writes += 1;
        if (writes > 1 && failCancel) throw new Error('disk unavailable');
        persisted = JSON.parse(JSON.stringify(next));
      },
      onSpawn: () => {
        if (cancelledId) expect(persisted.tasks['0001-one'].launches[cancelledId]).toBeUndefined();
      },
    };
    const h = harness(over);
    expect(h.supervisor.spawnStage(assignment()).reason).toBe('not-born');
    cancelledId = Object.keys(persisted.tasks['0001-one'].launches)[0];
    h.children.at(-1)?.emit('close', 1);
    await sleep(0);
    const attempts = h.children.length;
    expect(h.supervisor.codexUsage.writeErrors).toEqual(['0001-one']);
    h.supervisor.sweep();
    expect(h.supervisor.spawnStage(assignment({ taskId })).reason).toBe('busy');
    expect(h.children).toHaveLength(attempts);
    expect(persisted.tasks['0001-one'].launches[cancelledId]).toBeDefined();
    expect(h.supervisor.busy()).toBe(0);
    failCancel = false;
    over.spawnThrows = null;
    over.stillborn = false;
    if (retry === 'sweep') {
      h.supervisor.sweep();
      expect(taskTokenStatus(persisted, '0001-one').complete).toBe(true);
      expect(h.supervisor.codexUsage.writeErrors).toEqual([]);
      const after = writes;
      h.supervisor.sweep();
      expect(writes).toBe(after);
    }
    expect(h.supervisor.spawnStage(assignment({ taskId })).ok).toBe(true);
    expect(persisted.tasks['0001-one'].launches[cancelledId]).toBeUndefined();
    expect(h.supervisor.codexUsage.writeErrors).toEqual([]);
    emit(h, { type: 'thread.started', thread_id: 's' });
    await h.answer(completed());
    expect(taskTokens(persisted, taskId)).toBe(1740);
    expect(taskTokenStatus(persisted, '0001-one').complete).toBe(true);
  });

  it('удачная отмена не снимает ошибку сохранения расхода той же задачи', async () => {
    let fail = false;
    let failCancel = false;
    let cancelledId;
    let persisted;
    const over = {
      ...options,
      saveCodexUsage: (next) => {
        if (fail || (failCancel && !next.tasks['0001-one'].launches[cancelledId]))
          throw new Error('disk unavailable');
        persisted = JSON.parse(JSON.stringify(next));
      },
    };
    const h = harness(over);
    h.supervisor.spawnStage(assignment());
    emit(h, { type: 'thread.started', thread_id: 's' });
    emit(h, completed());
    fail = true;
    h.children.at(-1).emit('close', 0);
    await sleep(0);
    const originalId = Object.keys(persisted.tasks['0001-one'].launches)[0];
    fail = false;
    over.onSpawn = () => {
      cancelledId = Object.keys(persisted.tasks['0001-one'].launches).find(
        (id) => id !== originalId,
      );
      failCancel = true;
      throw new Error('spawn failed');
    };
    expect(h.supervisor.spawnStage(assignment({ stage: 'decompose' })).reason).toBe('not-born');
    expect(persisted.tasks['0001-one'].launches[cancelledId]).toBeDefined();
    failCancel = false;
    h.supervisor.sweep();
    expect(persisted.tasks['0001-one'].launches[cancelledId]).toBeUndefined();
    expect(persisted.tasks['0001-one'].launches[originalId]).toBeDefined();
    expect(taskTokens(persisted, '0001-one')).toBe(1740);
    expect(h.supervisor.codexUsage.writeErrors).toEqual(['0001-one']);
    expect(h.supervisor.spawnStage(assignment()).reason).toBe('busy');
    expect(h.supervisor.spawnStage(assignment({ taskId: '0002-two' })).reason).toBe('busy');
  });

  it.each(['thread.started', 'turn.completed'])(
    'finish повторяет поток после сбоя сохранения %s',
    async (failureAt) => {
      let fail = false;
      let persisted;
      const h = harness({
        ...options,
        saveCodexUsage: (next) => {
          if (fail) throw new Error('disk unavailable');
          persisted = JSON.parse(JSON.stringify(next));
        },
      });
      h.supervisor.spawnStage(assignment());
      if (failureAt === 'thread.started') fail = true;
      emit(h, { type: 'thread.started', thread_id: 's' });
      fail = true;
      emit(h, completed(1000, 100));
      emit(h, completed());
      expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(0);
      expect(taskTokenStatus(h.supervisor.codexUsage, '0001-one').reasons).toContain(
        'storage-error',
      );
      expect(h.supervisor.spawnStage(assignment({ taskId: '0002-two' })).reason).toBe('busy');
      fail = false;
      h.children.at(-1).emit('close', 0);
      await sleep(0);
      expect(taskTokens(persisted, '0001-one')).toBe(1740);
      expect(taskTokenStatus(h.supervisor.codexUsage, '0001-one').complete).toBe(true);
    },
  );

  it('сбой finish оставляет бюджет удержанным, но не отменяет исключение decompose', async () => {
    let fail = false;
    let disk;
    const h = harness({
      ...options,
      saveCodexUsage: (next) => {
        if (fail) throw new Error('write failed');
        disk = JSON.parse(JSON.stringify(next));
      },
    });
    h.supervisor.spawnStage(assignment());
    emit(h, { type: 'thread.started', thread_id: 's' });
    emit(h, completed());
    fail = true;
    h.children.at(-1).emit('close', 0);
    await sleep(0);
    expect(h.supervisor.busy()).toBe(0);
    expect(taskTokens(disk, '0001-one')).toBe(1740);
    expect(taskTokenStatus(disk, '0001-one').reasons).toContain('unfinished-launch');
    expect(h.supervisor.spawnStage(assignment()).reason).toBe('busy');
    expect(h.supervisor.spawnStage(assignment({ stage: 'decompose' })).reason).toBe('not-born');
    expect(h.supervisor.codexUsage.writeErrors).toEqual(['0001-one']);
    fail = false;
    expect(h.supervisor.spawnStage(assignment({ taskId: '0002-two' })).reason).toBe('busy');
    expect(h.supervisor.spawnStage(assignment({ stage: 'decompose' })).ok).toBe(true);
    await h.answer(completed(0, 0));
  });

  it.each([true, false])(
    'сирота с launchId=%s и недоступным stdout сохраняет unknown',
    async (hasLaunchId) => {
      let persisted;
      const h = harness({
        ...options,
        saveCodexUsage: (next) => {
          persisted = JSON.parse(JSON.stringify(next));
        },
      });
      h.supervisor.spawnStage(assignment());
      emit(h, { type: 'thread.started', thread_id: 's' });
      emit(h, completed());
      const stages = JSON.parse(JSON.stringify(h.saved.at(-1)));
      if (!hasLaunchId) delete stages['0001-one:design'].live.launchId;
      const restarted = harness({ ...options, stages, codexUsage: persisted });
      expect(taskTokens(restarted.supervisor.codexUsage, '0001-one')).toBe(1740);
      expect(taskTokenStatus(restarted.supervisor.codexUsage, '0001-one').reasons).toContain(
        hasLaunchId ? 'stdout-unavailable' : 'missing-launch-id',
      );
      restarted.supervisor.forgetSession('0001-one', 'design');
      expect(taskTokenStatus(restarted.supervisor.codexUsage, '0001-one').complete).toBe(false);
      h.children.at(-1).emit('close', 0);
      await sleep(0);
    },
  );

  it.each([{ spawnThrows: 'spawn failed' }, { stillborn: true }])(
    'несостоявшийся spawn не создаёт неизвестный расход: %j',
    async (failure) => {
      const h = harness({ ...options, ...failure });
      expect(h.supervisor.spawnStage(assignment()).ok).toBe(false);
      expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(0);
      expect(taskTokenStatus(h.supervisor.codexUsage, '0001-one').complete).toBe(true);
      h.children.at(-1)?.emit('close', 1);
      await sleep(0);
    },
  );

  it('Claude сохраняет старый ledger при усыновлении Codex-сироты', () => {
    let saved;
    const h = harness({
      config: { provider: 'claude' },
      codexUsage: migrateTokenLedger({
        '0012-design': { saved: 1200 },
        '0236-deploy': { legacy: 800 },
      }),
      stages: {
        '0236-deploy:deploy': {
          provider: 'codex',
          sessionId: 'legacy',
          live: { pid: 99, startedAt: '2026-09-06T10:00:00Z' },
        },
      },
      saveCodexUsage: (next) => {
        saved = globalThis.structuredClone(next);
      },
    });
    expect(taskTokens(h.supervisor.codexUsage, '0012-design')).toBe(1200);
    expect(taskTokens(h.supervisor.codexUsage, '0236-deploy')).toBe(800);
    expect(taskTokens(saved, '0012-design')).toBe(1200);
    expect(taskTokenStatus(saved, '0236-deploy').reasons).toContain('missing-launch-id');
  });
});

it('отказ Codex немедленно запрещает новые этапы и сохраняет сигнал паузы', async () => {
  const paused = [];
  const h = harness({
    home: fileURLToPath(new URL('..', import.meta.url)),
    config: { provider: 'codex' },
    onPolicyBlocked: (why) => paused.push(why),
  });
  const launched = h.supervisor.spawnStage(assignment());
  expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true });
  const denial = {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'declined',
      command: 'git status',
      aggregated_output: 'blocked by policy',
    },
  };
  h.children[0].stdout.emit('data', JSON.stringify(denial) + '\n');
  expect(paused).toHaveLength(1);
  expect(paused[0]).toContain('0001-one:design');
  expect(h.supervisor.spawnStage(assignment({ taskId: '0002-two' })).ok).toBe(false);
  await h.answer({
    type: 'turn.completed',
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
  });
  expect(h.wrote[0].text).toContain('blocked by policy');
  expect(finishedLine(h.said).text).toContain('отказов 1');
});

it('передаёт Git-авторизацию рабочему Codex окружением, а Claude оставляет прежним', async () => {
  for (const provider of ['codex', 'claude']) {
    const calls = [];
    const env = { GH_TOKEN: 'test-token' };
    const h = harness({
      home: fileURLToPath(new URL('..', import.meta.url)),
      config: { provider },
      getCodexEnvironment: () => env,
      onSpawn: (call) => calls.push(call),
    });
    const launched = h.supervisor.spawnStage(assignment());
    expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true });
    const call = calls[0];
    expect(call.args.join()).not.toContain('test-token');
    expect(call.args.join()).not.toContain('AUTHORIZATION');
    if (provider === 'codex') {
      expect(call.options.env.GIT_CONFIG_COUNT).toBe('6');
      expect(call.options.env.GIT_CONFIG_VALUE_2.replaceAll('\\', '/')).toContain(
        '/repo/.claude/worktrees/0001-one',
      );
      expect(call.options.env.GIT_CONFIG_VALUE_5).toMatch(/^AUTHORIZATION: basic /);
    } else expect(call.options.env).toBeUndefined();
    expect(env).toEqual({ GH_TOKEN: 'test-token' });
    await h.answer(envelope());
    expect(
      JSON.stringify(h.wrote) + JSON.stringify(h.logged) + JSON.stringify(h.said),
    ).not.toContain('test-token');
  }
});

describe('автоматическое восстановление удержанного расхода', () => {
  const stopped = () => ({
    version: 2,
    tasks: {
      '0001-one': {
        sessions: {
          s: { knownTokens: 0, snapshot: null, reasons: ['missing-usage', 'stdout-unavailable'] },
        },
        launches: {
          old: {
            sessionId: 's',
            baseline: { input_tokens: 0, output_tokens: 0 },
            observations: {},
            completed: true,
            reasons: ['missing-usage', 'stdout-unavailable'],
          },
        },
      },
    },
  });
  const proof = {
    ok: true,
    source: 'token_usage_record',
    complete: false,
    digest: 'a'.repeat(64),
    turnId: 't',
    snapshot: { input_tokens: 10, output_tokens: 2 },
  };
  const stages = { '0001-one:implement': { provider: 'codex', sessionId: 's', startedAt: NOW } };
  it('при старте сохраняет минимум и следующее успешное завершение не блокируется старым хвостом', async () => {
    let saves = 0;
    const h = harness({
      config: { provider: 'codex' },
      home: fileURLToPath(new URL('..', import.meta.url)),
      codexUsage: stopped(),
      stages,
      readCodexEvidence: (child) =>
        child.recovery ? proof : { ok: true, snapshot: { input_tokens: 3, output_tokens: 1 } },
      saveCodexUsage: () => {
        saves++;
      },
    });
    expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(12);
    expect(h.supervisor.lastSession('0001-one', 'implement')).toBeNull();
    h.supervisor.sweep();
    expect(saves).toBe(1);
    expect(
      h.supervisor.spawnStage(assignment({ sessionId: 's', continuation: true })),
    ).toMatchObject({ ok: true });
    const child = h.children[0];
    child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: 'new' }) + '\n');
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(report) },
      }) + '\n',
    );
    await h.answer({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } });
    expect(h.supervisor.reports).toHaveLength(1);
    expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(16);
    expect(h.logged.join('\n')).toContain('неизвестный хвост');
    expect(h.logged.join('\n')).not.toContain('учёт задачи полный');
  });
  it('после ошибки записи не даёт допуск, затем сохраняет и восстанавливает', () => {
    let fail = true;
    const h = harness({
      config: { provider: 'codex' },
      codexUsage: stopped(),
      stages,
      readCodexEvidence: () => proof,
      saveCodexUsage: () => {
        if (fail) throw Error('disk');
      },
    });
    expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(0);
    expect(taskTokenStatus(h.supervisor.codexUsage, '0001-one').complete).toBe(false);
    fail = false;
    h.supervisor.sweep();
    expect(taskTokenStatus(h.supervisor.codexUsage, '0001-one').acceptedIncomplete).toBe(true);
    expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(12);
  });
  it('не трогает живую или оставленную без опознания сессию даже после перезапуска', () => {
    for (const value of [
      { ...stages['0001-one:implement'], provider: 'claude' },
      { ...stages['0001-one:implement'], usageRecoveryBlocked: true },
      {
        ...stages['0001-one:implement'],
        live: {
          pid: 123,
          machine: 'станция-1',
          startedAt: NOW,
          startedMs: 1000000,
          timeoutMs: 2700000,
          launchId: 'old',
        },
      },
    ]) {
      let reads = 0;
      const h = harness({
        config: { provider: 'codex' },
        codexUsage: stopped(),
        stages: { '0001-one:implement': value },
        readCodexEvidence: () => {
          reads++;
          return proof;
        },
      });
      expect(reads).toBe(0);
      expect(taskTokens(h.supervisor.codexUsage, '0001-one')).toBe(0);
    }
  });
});
