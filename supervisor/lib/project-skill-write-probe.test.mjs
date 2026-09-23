import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyProbeSession,
  runProjectSkillWriteProbe,
  TARGETS,
  CONTROLS,
  PROBE_COMMAND,
  safeDiagnostic,
  runProbeSession,
} from './project-skill-write-probe.mjs';

const cwd = resolve('fixture/tree');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const body = (mark) =>
  `---\nname: diagnostic-fixture\ndescription: Inert permission diagnostic fixture.\n---\n\n<!-- 0299:${mark} -->\n`;
const initial = () =>
  Object.fromEntries(
    [...TARGETS, ...CONTROLS, '.matchlog/observe.mjs', '.matchlog/negative.mjs'].map((file) => [
      file,
      hash(body('initial')),
    ]),
  );
function session(
  phase,
  before = phase === 'resume'
    ? { ...initial(), ...Object.fromEntries(TARGETS.map((file) => [file, hash(body('assigned'))])) }
    : initial(),
) {
  const after = { ...before };
  const events = [
    { type: 'thread.started', thread_id: phase === 'baseline' ? 'baseline' : 'target' },
  ];
  const complete = (item) =>
    events.push({ type: 'item.completed', item: { id: `tool-${events.length}`, ...item } });
  const patch = (file, status) =>
    complete({ type: 'file_change', changes: [{ path: file, kind: 'update' }], status });
  if (phase === 'baseline') patch(TARGETS[0], 'declined');
  else {
    for (const file of phase === 'target' ? TARGETS : [TARGETS[0]]) {
      patch(file, 'completed');
      after[file] = hash(body(phase === 'target' ? 'assigned' : 'resumed'));
    }
    if (phase === 'target') {
      complete({
        type: 'command_execution',
        command: 'node .matchlog/observe.mjs',
        status: 'completed',
        exit_code: 0,
        aggregated_output: JSON.stringify(
          Object.fromEntries([...TARGETS, ...CONTROLS].map((file) => [file, after[file]])),
        ),
      });
      for (const file of CONTROLS) patch(file, 'declined');
      complete({
        type: 'command_execution',
        command: 'node .matchlog/negative.mjs',
        status: 'completed',
        exit_code: 0,
        aggregated_output: JSON.stringify(CONTROLS.map((file) => ({ file, result: 'EPERM' }))),
      });
    }
  }
  complete({
    type: 'command_execution',
    command: 'node .matchlog/observe.mjs',
    status: 'completed',
    exit_code: 0,
    aggregated_output: JSON.stringify(
      Object.fromEntries([...TARGETS, ...CONTROLS].map((file) => [file, after[file]])),
    ),
  });
  events.push({ type: 'turn.completed' });
  return { phase, cwd, before, after, events, run: { code: 0, elapsedMs: 1 } };
}

describe('native evidence', () => {
  it.each(['baseline', 'target', 'resume'])('принимает полную матрицу %s', (phase) => {
    expect(classifyProbeSession(session(phase)).accepted).toBe(true);
  });
  it('сообщение модели не заменяет инструмент', () => {
    const input = session('target');
    input.events = [
      { type: 'thread.started', thread_id: 'fake' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(input.events) },
      },
      { type: 'turn.completed' },
    ];
    expect(classifyProbeSession(input).accepted).toBe(false);
  });
  it.each([
    'patch',
    'shell',
    'event',
    'file',
    'timeout',
    'exit',
    'script',
    'control',
    'duplicate',
    'read',
    'missing-denial',
    'unsafe-shell',
  ])('не принимает %s', (kind) => {
    const input = session('target');
    if (kind === 'patch') input.events[1].item.status = 'declined';
    if (kind === 'shell')
      input.events.find((e) => e.item?.command?.includes('negative')).item.exit_code = 1;
    if (kind === 'event') input.events.pop();
    if (kind === 'file') delete input.after[TARGETS[0]];
    if (kind === 'timeout') input.run.killedBy = 'timeout';
    if (kind === 'exit') input.run.code = 1;
    if (kind === 'script') input.after['.matchlog/observe.mjs'] = hash('forged');
    if (kind === 'control') input.after[CONTROLS[0]] = hash('written');
    if (kind === 'duplicate') input.events.splice(2, 0, input.events[1]);
    if (kind === 'read')
      input.events.find((e) => e.item?.command?.includes('observe')).item.aggregated_output = '{}';
    if (kind === 'missing-denial')
      input.events.find((e) => e.item?.status === 'declined').item.status = 'failed';
    if (kind === 'unsafe-shell')
      input.events.find((e) => e.item?.command).item.command += '; echo fake';
    expect(classifyProbeSession(input).accepted).toBe(false);
  });
  it('отличает OS-denial на известной цели от ошибки отсутствия файла', () => {
    const input = session('baseline');
    input.events[1].item.status = 'failed';
    input.events[1].item.error = { message: 'EPERM' };
    expect(classifyProbeSession(input).accepted).toBe(true);
    input.events[1].item.error.message = 'ENOENT';
    expect(classifyProbeSession(input).accepted).toBe(false);
  });
});

it('штатная PowerShell-обёртка связывается с единственной фиксированной командой', () => {
  const input = session('baseline');
  const item = input.events.find((e) => e.item?.command).item;
  item.command =
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "node .matchlog/observe.mjs"';
  expect(classifyProbeSession(input).accepted).toBe(true);
  item.command = 'echo forged; ' + item.command;
  expect(classifyProbeSession(input).accepted).toBe(false);
});

it('при неожиданной записи native-событие немедленно останавливает подставной процесс', async () => {
  let killed = 0;
  let timeout;
  const result = await runProbeSession({ cwd }, 'target', {
    start(options) {
      timeout = options.timeoutMs;
      return {
        kill: () => killed++,
        finished: Promise.resolve().then(() => {
          options.onEvent({
            type: 'item.completed',
            item: { type: 'file_change', status: 'completed', changes: [{ path: CONTROLS[0] }] },
          });
          return { code: 1, killedBy: 'shutdown', stderr: '' };
        }),
      };
    },
  });
  expect(killed).toBe(1);
  expect(timeout).toBe(300000);
  expect(result.run.stopReason).toBe('unexpected write');
});

function fakeEffects(breakAt = null) {
  let hashes = initial();
  const runs = [];
  let consumerReads = 0;
  const consumer = {
    tree: 'consumer',
    hashes: { 'tasks.md': hash('plan'), '0083-partial-docs.patch': hash('draft') },
  };
  const effects = {
    consumerAssignment: () => ({ files: TARGETS, digest: hash('manifest') }),
    setup() {
      if (breakAt === 'setup')
        throw Object.assign(new Error('EPERM: fixture setup'), { code: 'EPERM' });
      return { cwd, root: resolve('fixture/main'), stand: resolve('fixture'), assignment: {} };
    },
    snapshotConsumer() {
      consumerReads++;
      if (breakAt === 'consumer' && consumerReads > 1) return { ...consumer, hashes: {} };
      if (breakAt === 'missing-consumer') throw new Error('Consumer worktree missing');
      return consumer;
    },
    snapshotFiles() {
      return { ...hashes };
    },
    buildSession({ phase, sessionId }) {
      runs.push({ phase, sessionId });
      return { cwd, grants: { files: TARGETS, digest: hash('manifest'), source: 'trusted/home' } };
    },
    async runSession(command, phase) {
      const result = session(phase, hashes);
      if (phase === breakAt) result.events = [];
      if (breakAt === 'unexpected-control' && phase === 'target') {
        result.after[CONTROLS[0]] = hash('written');
        result.events.find((e) => e.item?.status === 'declined').item.status = 'completed';
      }
      hashes = result.after;
      return result;
    },
    now: () => 100,
  };
  return { effects, runs };
}

describe('ограниченный опыт', () => {
  const input = { workspace: 'own', home: 'trusted', config: {}, platform: 'win32' };
  it('проходит две сессии и ровно один resume, сравнивает сохранность', async () => {
    const { effects, runs } = fakeEffects();
    const result = await runProjectSkillWriteProbe(input, effects);
    expect(result.accepted).toBe(true);
    expect(result.consumerPreserved).toBe(true);
    expect(runs.map((r) => r.phase)).toEqual(['baseline', 'target', 'resume']);
    expect(runs[2].sessionId).toBe('target');
  });
  it.each([
    'baseline',
    'target',
    'resume',
    'setup',
    'consumer',
    'missing-consumer',
    'unexpected-control',
  ])('останавливает %s без подмены результата', async (failure) => {
    const { effects, runs } = fakeEffects(failure);
    const result = await runProjectSkillWriteProbe(input, effects);
    expect(result.accepted).toBe(false);
    if (['target', 'unexpected-control'].includes(failure))
      expect(runs.map((r) => r.phase)).toEqual(['baseline', 'target']);
    if (failure === 'baseline') expect(runs.map((r) => r.phase)).toEqual(['baseline']);
    if (['setup', 'missing-consumer'].includes(failure)) expect(runs).toEqual([]);
    if (failure === 'setup') expect(result.reason).toBe('EPERM');
  });
  it('без подходящего профиля запусков нет', async () => {
    const { effects, runs } = fakeEffects();
    expect(
      (await runProjectSkillWriteProbe({ ...input, platform: 'linux' }, effects)).accepted,
    ).toBe(false);
    expect(runs).toEqual([]);
  });
  it('не публикует произвольные сообщения и секреты', () => {
    expect(safeDiagnostic('TOKEN=very-secret')).not.toContain('very-secret');
    expect(safeDiagnostic('EPERM secret')).toBe('EPERM');
  });
});

it('CLI без --run ничего не запускает, неизвестные параметры отвергает', () => {
  const entry = fileURLToPath(new URL('../bin/check-project-skill-writes.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(PROBE_COMMAND);
  const bad = spawnSync(process.execPath, [entry, '--root=other'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  expect(bad.status).toBe(1);
});

it('допуск стенда точный и не расширяет node supervisor/bin', () => {
  const settings = JSON.parse(
    readFileSync(new URL('../config/stage-settings.json', import.meta.url), 'utf8'),
  );
  const rules = settings.permissions.allow.filter((rule) =>
    rule.includes('check-project-skill-writes'),
  );
  expect(rules).toEqual([`PowerShell(${PROBE_COMMAND})`]);
  expect(settings.permissions.allow).not.toContain('PowerShell(node supervisor/bin/*)');
  expect(settings.permissions.allow).not.toContain(`PowerShell(${PROBE_COMMAND}:*)`);
});
