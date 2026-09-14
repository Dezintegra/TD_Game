import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as tick } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { deliveryFixture } from './testing/report-delivery-fixture.mjs';
import { receiptOf } from './report-receipts.mjs';
import { createSupervisor } from './supervisor.mjs';
import { classifyToolControls } from './stage-tool-health.mjs';
import { execute } from './execute.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { incidentFromReport } from './pipeline-incidents.mjs';

const { config } = resolveConfig({ commands: { verify: 'x', deploy: 'x', perf: 'x' } });
const context = {
  provider: 'claude',
  cwd: 'assigned',
  environmentId: 'env',
  permissionsId: 'permissions',
};
function proof(kind, stage) {
  const controls = [
    'shell',
    'child',
    'git',
    'github',
    'remote',
    'push',
    ...(stage === 'deploy' ? ['ssh'] : []),
  ].map((id) => ({
    id,
    invocationId: `probe-${id}`,
    argv: ['control', id],
    marker: 'ready',
  }));
  const facts =
    kind === 'absent'
      ? []
      : controls.map((control, sequence) => ({
          checkId: control.id,
          invocationId: control.invocationId,
          argv: control.argv,
          context,
          eventId: `event-${sequence}`,
          sequence,
          startedAt: 1,
          finishedAt: 2,
          kind: 'exit',
          completed: true,
          exitCode: 0,
          output: 'ready',
          ...((kind === 'broken' && ['shell', 'child'].includes(control.id)) ||
          (kind === 'ssh' && control.id === 'ssh')
            ? { kind: 'spawn-error', created: false, errorCode: 'EPERM' }
            : {}),
        }));
  return classifyToolControls({ context, controls, facts });
}

function setup(kind = 'broken', options = {}) {
  const f = deliveryFixture({
    stage: options.stage ?? 'implement',
    outcome: 'failed',
    taskOverrides: { reportReceipts: [receiptOf('continuation:old')] },
  });
  f.open().store.acknowledge(f.entry.reportId);
  const children = [],
    diagnostics = [];
  let stages = {},
    paused = false,
    recovered = false;
  function open() {
    const opened = f.open();
    const supervisor = createSupervisor({
      config,
      root: f.root,
      home: fileURLToPath(new URL('..', import.meta.url)),
      machine: 'test',
      now: () => f.now,
      nowMs: () => Date.parse(f.now),
      stages,
      saveStages: (value) => {
        stages = globalThis.structuredClone(value);
      },
      reportStore: opened.store,
      captureToolContext: () => context,
      inspectToolWork: () => ({
        state: 'known',
        head: 'a'.repeat(40),
        branch: 'assigned',
        upstream: 'origin/assigned',
        tail: ['b'.repeat(40)],
        dirty: [' M remaining.txt'],
      }),
      diagnoseTools: async () => {
        const result = proof(recovered ? 'healthy' : kind, f.task.status);
        diagnostics.push(result);
        return result;
      },
      pauseTools: () => {
        paused = true;
      },
      isToolPaused: () => paused,
      mayLaunch: () => ({ allowed: !paused }),
      probe: () => ({ known: true, alive: true, image: 'claude.exe' }),
      killTree: vi.fn(),
      spawn: () => {
        const child = new EventEmitter();
        child.pid = 900 + children.length;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.end = (text) => {
          child.prompt = text;
        };
        children.push(child);
        return child;
      },
    });
    return {
      ...opened,
      supervisor,
      io: {
        ...opened.io,
        machine: 'test',
        registryEntry: () => null,
        spawnStage: (assignment) => supervisor.spawnStage(assignment),
        mayLaunch: () => supervisor.mayLaunch(),
        inspectRetryLaunch: (entry) => supervisor.inspectRetryLaunch(entry),
      },
    };
  }
  async function finish(first) {
    const started = first.supervisor.spawnStage({
      taskId: f.task.id,
      stage: f.task.status,
      task: f.task,
      launchId: 'old',
      charge: { launchId: 'old', key: 'continuation:old', state: 'confirmed' },
      ...(f.task.status === 'deploy'
        ? {
            batch: [f.task, f.member],
            path: 'snapshot',
            branch: null,
            deploymentRevision: 'a'.repeat(40),
            deployment: {
              path: 'snapshot',
              revision: 'a'.repeat(40),
              host: 'test-host',
              directory: 'td',
            },
          }
        : {}),
    });
    expect(started).toMatchObject({ ok: true });
    const child = children[0];
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'fetch and merge succeeded; later command failed' }],
        },
      }) + '\n',
    );
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: options.noReport ? '' : JSON.stringify(f.report),
        total_cost_usd: 1,
        permission_denials: [],
      }) + '\n',
    );
    child.emit('close', 0);
    await tick(0);
    await tick(0);
  }
  return {
    ...f,
    open,
    finish,
    children,
    diagnostics,
    recover: () => {
      paused = false;
      recovered = true;
    },
  };
}

describe('stage tool recovery through durable runtime and recipient', () => {
  it.each([false, true])(
    'SSH outage holds the original batch and avoids republication, absent report %s',
    async (noReport) => {
      const f = setup('ssh', { stage: 'deploy', noReport });
      try {
        const first = f.open();
        await f.finish(first);
        expect(first.store.entries()[0].batch).toEqual([f.task.id, f.member.id]);
        f.recover();
        first.supervisor.sweep();
        await tick(0);
        await tick(0);
        const entry = first.store.entries()[0];
        const action = {
          kind: 'settle-tool-report',
          taskId: f.task.id,
          stage: 'deploy',
          reportId: entry.reportId,
        };
        expect((await execute([action], first.io))[0].result).toBe('done');
        const ready = f.open(),
          retry = { ...action, kind: 'retry-tool-stage', batch: entry.batch };
        expect((await execute([retry], ready.io))[0].result).toBe('skipped');
        expect(f.children).toHaveLength(1);
        for (const id of entry.batch) expect(ready.io.readTask(id).status).toBe('deploy');
        ready.io.inspectToolDeployment = () => ({
          state: 'known',
          published: true,
          revision: entry.assignment.deploymentRevision,
        });
        expect((await execute([retry], ready.io))[0].result).toBe('done');
        expect(f.children).toHaveLength(2);
        expect(f.children[1].prompt).toContain('Не запускай deploy повторно');
        expect(f.children[1].prompt).toContain(f.member.id);
        for (const id of entry.batch) expect(f.open().io.readTask(id).status).toBe('deploy');
      } finally {
        f.cleanup();
      }
    },
  );
  it('healthy recovery does not bypass a scoped incident at execute', async () => {
    const f = setup();
    try {
      const first = f.open();
      await f.finish(first);
      f.recover();
      first.supervisor.sweep();
      await tick(0);
      await tick(0);
      const entry = first.store.entries()[0];
      const action = {
        kind: 'settle-tool-report',
        taskId: f.task.id,
        stage: f.task.status,
        reportId: entry.reportId,
      };
      expect((await execute([action], first.io))[0].result).toBe('done');
      const ready = f.open();
      const source = {
        ...f.task,
        id: '0009-incident',
        status: 'failed',
        returnTo: 'implement',
        recovery: { causedBy: 'pipeline', fixedBy: ['0010-fix'] },
      };
      source.pipelineIncident = incidentFromReport(
        source,
        {
          stage: 'postmortem',
          outcome: 'done',
          causedBy: 'pipeline',
          pipelineIncident: {
            evidence: 'independently confirmed',
            affectedStages: ['implement'],
            check: { stage: 'implement', expectation: 'original control succeeds' },
          },
        },
        ['0010-fix'],
        f.now,
      ).incident;
      const readTask = ready.io.readTask;
      const result = await execute([{ ...action, kind: 'retry-tool-stage' }], {
        ...ready.io,
        allTaskIds: () => [f.task.id, source.id],
        readTask: (id) => (id === source.id ? source : readTask(id)),
      });
      expect(result[0].result).toBe('skipped');
      expect(result[0].why).toContain('инцидент');
      expect(f.children).toHaveLength(1);
      expect(ready.store.entries()[0].disposition).toBe('retry-ready');
    } finally {
      f.cleanup();
    }
  });
  it.each(['after-put', 'after-comment', 'claim', 'handoff'])(
    'survives %s without duplicate refund or replacement',
    async (point) => {
      const f = setup();
      try {
        const first = f.open();
        await f.finish(first);
        expect(first.supervisor.busy()).toBe(0);
        expect(f.diagnostics[0].checks.filter((check) => check.status === 'failed')).toHaveLength(
          2,
        );
        const stopped = f.open();
        expect(stopped.store.entries()[0]).toMatchObject({
          disposition: 'infrastructure-held',
          git: { tail: ['b'.repeat(40)] },
        });
        stopped.supervisor.sweep();
        await tick(0);
        expect(f.diagnostics).toHaveLength(1);
        f.recover();
        stopped.supervisor.sweep();
        await tick(0);
        await tick(0);
        const entry = stopped.store.entries()[0];
        expect(entry.retry.recovery.verdict).toBe('healthy');
        const settle = {
          kind: 'settle-tool-report',
          taskId: f.task.id,
          stage: f.task.status,
          reportId: entry.reportId,
        };
        if (point === 'after-put') stopped.recipient.fail('PUT', 'cards/', 'after');
        if (point === 'after-comment') stopped.recipient.fail('POST', '/actions/comments', 'after');
        const result = await execute([settle], stopped.io);
        expect(result[0].result).toBe(point.startsWith('after-') ? 'failed' : 'done');
        let ready = f.open();
        if (point.startsWith('after-'))
          expect((await execute([settle], ready.io))[0].result).toBe('done');
        const retry = { ...settle, kind: 'retry-tool-stage' };
        if (point === 'claim') {
          const originalSpawn = ready.io.spawnStage;
          ready.io.spawnStage = () => {
            throw new Error('interrupted before calling spawn');
          };
          expect((await execute([retry], ready.io))[0].result).toBe('failed');
          ready = f.open();
          expect((await execute([retry], ready.io))[0].result).toBe('skipped');
          expect(ready.store.entries()[0].disposition).toBe('retry-ready');
          expect(originalSpawn).toBeTypeOf('function');
        }
        if (point === 'handoff')
          ready.store.archive = () => {
            throw new Error('archive unavailable');
          };
        const launched = await execute([retry], ready.io);
        expect(launched[0].result, JSON.stringify(launched)).toBe(
          point === 'handoff' ? 'failed' : 'done',
        );
        expect(f.children).toHaveLength(2);
        expect(f.children[1].prompt).toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
        expect(f.children[1].prompt).toContain('не повторяй подтверждённые действия');
        if (point === 'handoff') {
          const final = f.open();
          expect((await execute([retry], final.io))[0].result).toBe('done');
        }
        const final = f.open();
        expect(final.store.entries()).toEqual([]);
        expect(final.recipient.store.readTask(f.task.id)).toMatchObject({
          status: 'implement',
          attempts: { continuations: 1 },
          spentUsd: 5,
        });
        expect(final.recipient.state()).toMatchObject({ puts: 1, posts: 1 });
        expect(f.children).toHaveLength(2);
      } finally {
        f.cleanup();
      }
    },
  );
  it.each(['healthy', 'absent'])(
    'ordinary failed stays ordinary with %s controls',
    async (kind) => {
      const f = setup(kind);
      try {
        const first = f.open();
        await f.finish(first);
        const kept = f.open().store.entries()[0];
        expect(kept.disposition).toBe('ordinary');
        expect(kept.report.outcome).toBe('failed');
        expect(kept.retry).toBeNull();
        expect(f.open().recipient.store.readTask(f.task.id).attempts.continuations).toBe(2);
      } finally {
        f.cleanup();
      }
    },
  );
  it('writes publication evidence only after compose and proxy restart', () => {
    const source = readFileSync(new URL('../../scripts/deploy.mjs', import.meta.url), 'utf8');
    expect(source.indexOf('deploymentMarkerCommand(fullRevision)')).toBeGreaterThan(
      source.indexOf('docker compose restart web'),
    );
  });
});
