import { dirname, join, resolve } from 'node:path';
import { release } from 'node:os';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { codexInvocation } from './provider.mjs';
import { codexChildEnvironment, codexGitEnvironment } from './codex-environment.mjs';
import { createKillTree, startStage } from './run-stage.mjs';
import { modelForStage } from './stage-model.mjs';
import {
  CONSUMER_TASK,
  CONSUMER_CHANGE,
  HOST_EVIDENCE,
  hostIO,
  hostError,
  ordinaryPath,
  registeredTrees,
  validateLinkedTree,
  createHostFixture,
  verifyHostFixture,
  sha256,
  samePath,
  TARGETS,
} from './project-skill-host-fixture.mjs';

export const HOST_TASK = '0302-podgotovit-razreshennyy-windows-marshrut';
export const PR_SOURCE = '07b7085ff932d4ccd4d17d7ec6567092bff03645';
const PREVIOUS_TASK = '0299-obespechit-razreshennuyu-pravku-proektny';

/** Код причины не содержит stderr, SID, личных настроек или окружения. */
export function classifyHostError(error) {
  const message = `${error?.message ?? ''} ${error?.stderr ?? ''}`;
  if (/detected dubious ownership/i.test(message)) return 'ownership';
  if (/blocked by policy|rejected by policy/i.test(message)) return 'policy';
  if (/sandbox.*(?:setup|start|failed)|(?:setup|start).*sandbox/i.test(message))
    return 'sandbox-start';
  if (error?.hostCode) return error.hostCode;
  if (error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') return 'timeout';
  return ['EACCES', 'EPERM', 'ENOENT', 'EEXIST'].includes(error?.code) ? error.code : 'unknown';
}

function locate(root, taskId, io) {
  const records = registeredTrees(io.git(root, 'worktree', 'list', '--porcelain', '-z'));
  const matches = records.filter((row) => row.branch === `refs/heads/worktree-${taskId}`);
  if (matches.length !== 1 || !matches[0].tree) throw hostError('consumer-registration');
  return resolve(matches[0].tree);
}

export function identifyHostConsumer(workspace, io) {
  ordinaryPath(workspace, true, io);
  const common = io.git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const root = dirname(common);
  if (!samePath(common, join(root, '.git'))) throw hostError('host-common-mismatch');
  validateLinkedTree(root, workspace, HOST_TASK, io);
  const tree = locate(root, CONSUMER_TASK, io);
  const identity = validateLinkedTree(root, tree, CONSUMER_TASK, io);
  return { tree, identity };
}

export function snapshotHostConsumer(consumer, io) {
  const base = join(consumer.tree, 'openspec/changes', CONSUMER_CHANGE);
  const files = ['.openspec.yaml', 'proposal.md', 'design.md', 'tasks.md'];
  function walk(relative) {
    ordinaryPath(join(base, relative), true, io);
    for (const entry of io.fs.readdirSync(join(base, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw hostError('consumer-link');
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
      else throw hostError('consumer-type');
    }
  }
  walk('specs');
  if (files.length <= 4) throw hostError('consumer-specs-missing');
  const names = files.map((file) => `openspec/changes/${CONSUMER_CHANGE}/${file}`);
  for (const name of [
    'partial-docs.patch',
    'openspec-purpose.mjs',
    'openspec-archive.mjs',
    'edit-docs.mjs',
  ])
    names.push(`.matchlog/0083-${name}`);
  return Object.fromEntries(
    names.sort().map((name) => {
      ordinaryPath(join(consumer.tree, name), false, io);
      return [name, sha256(io.fs.readFileSync(join(consumer.tree, name)))];
    }),
  );
}

function previousEvidence(root, io) {
  try {
    const tree = locate(root, PREVIOUS_TASK, io);
    validateLinkedTree(root, tree, PREVIOUS_TASK, io);
    const file = ordinaryPath(join(tree, '.matchlog/0299-skill-write-evidence.json'), false, io);
    return { status: 'available', path: file, hash: sha256(io.fs.readFileSync(file)) };
  } catch (error) {
    return { status: 'unknown', reason: classifyHostError(error) };
  }
}

function reserveEvidence(workspace, io) {
  const parent = join(workspace, '.matchlog');
  ordinaryPath(workspace, true, io);
  try {
    io.fs.mkdirSync(parent);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  ordinaryPath(parent, true, io);
  const file = join(workspace, HOST_EVIDENCE);
  const fd = io.fs.openSync(file, 'wx');
  io.fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, status: 'incomplete' }));
  return {
    finish(evidence) {
      // Дескриптор принадлежит этому запуску; повтор не открывает и не обнуляет старый файл.
      const bytes = JSON.stringify(evidence, null, 2) + '\n';
      io.fs.writeSync(fd, bytes, 0, 'utf8');
      io.fs.ftruncateSync(fd, Buffer.byteLength(bytes));
      io.fs.fsyncSync(fd);
    },
    close() {
      io.fs.closeSync(fd);
    },
  };
}

/** Настоящий prepare вызывается только владельцем между исполняющими сессиями. */
export async function prepareProjectSkillHost({ workspace, home, config = {} }, effects = {}) {
  workspace = resolve(workspace);
  const io = hostIO(effects);
  const started = io.now();
  const evidence = {
    schemaVersion: 1,
    startedAt: new Date(started).toISOString(),
    status: 'incomplete',
    role: 'diagnostic-host',
    workspace,
    sourcePr: { pr: 232, sha: PR_SOURCE },
    hostReady: false,
    cliStart: false,
    permissionAcceptance: 'not-run',
    sessions: [],
    phase: 'reserve',
    error: null,
    versions: { node: process.version, windows: release() },
  };
  let reservation;
  let consumer;
  const identify = io.identify ?? identifyHostConsumer;
  const snapshot = io.snapshot ?? snapshotHostConsumer;
  const previous = io.previous ?? previousEvidence;
  try {
    if (io.platform !== 'win32') throw hostError('windows-required');
    if (!samePath(home, join(workspace, 'supervisor'))) throw hostError('home-mismatch');
    reservation = (io.reserve ?? reserveEvidence)(workspace, io);
    evidence.phase = 'identity';
    consumer = identify(workspace, io);
    evidence.identity = consumer.identity;
    evidence.sourceSha = io.git(workspace, 'rev-parse', 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(evidence.sourceSha)) throw hostError('source-sha');
    evidence.sources = (io.sources ?? hostSourceSnapshot)(workspace, io);
    evidence.configDigest = sha256(JSON.stringify(config));
    evidence.consumerBefore = snapshot(consumer, io);
    evidence.previousBefore = previous(consumer.identity.root, io);
    if (evidence.previousBefore.status !== 'available')
      throw hostError('previous-evidence-unavailable');
    evidence.phase = 'fixture';
    const fixture = (io.createFixture ?? createHostFixture)(workspace, io);
    evidence.fixture = fixture;
    evidence.fixtureHashes = (io.verifyFixture ?? verifyHostFixture)(workspace, fixture, io);
    evidence.hostReady = true;
    evidence.phase = 'cli-start';
    evidence.versions.git = io.exec('git', ['--version']);
    io.cliBudgetMs = Math.max(1, Math.min(10000, 600000 - (io.now() - started)));
    evidence.versions.codex = await (io.cliVersion ?? hostCliVersion)(config, io, workspace);
    io.checkTime();
    evidence.cliStart = true;
    evidence.phase = 'complete';
    evidence.status = 'ready';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = {
      kind: classifyHostError(error),
      code: Number.isInteger(error.status) ? error.status : null,
    };
  } finally {
    if (consumer) {
      try {
        evidence.consumerAfter = snapshot(consumer, io);
        evidence.previousAfter = previous(consumer.identity.root, io);
        evidence.consumerPreserved =
          JSON.stringify(evidence.consumerBefore) === JSON.stringify(evidence.consumerAfter);
        evidence.previousPreserved =
          evidence.previousAfter.status === 'available' &&
          JSON.stringify(evidence.previousBefore) === JSON.stringify(evidence.previousAfter);
      } catch {
        evidence.consumerPreserved = false;
        evidence.previousPreserved = false;
      }
      if (!evidence.consumerPreserved || !evidence.previousPreserved) {
        evidence.status = 'failed';
        evidence.hostReady = false;
        evidence.error ??= { kind: 'preservation-unconfirmed', code: null };
      }
    }
    evidence.finishedAt = new Date(io.now()).toISOString();
    evidence.elapsedMs = io.now() - started;
    if (reservation) {
      try {
        reservation.finish(evidence);
      } finally {
        reservation.close();
      }
    }
  }
  return evidence;
}

// Полный список исполняемых модулей этой поставки; личные настройки не читаются.
export const HOST_SOURCES = [
  'supervisor/lib/windows-diagnostic-host.mjs',
  'supervisor/lib/project-skill-host-fixture.mjs',
  'supervisor/lib/codex-environment.mjs',
  'supervisor/lib/provider.mjs',
  'supervisor/lib/run-stage.mjs',
  'supervisor/lib/codex-perf-files.mjs',
  'supervisor/lib/token-budget.mjs',
  'supervisor/lib/stage-model.mjs',
  'supervisor/bin/prepare-project-skill-host.mjs',
  'supervisor/bin/codex-runner.mjs',
  'supervisor/pipeline.config.json',
  'supervisor/config/stage-settings.json',
];

export function hostSourceSnapshot(workspace, io) {
  if (io.git(workspace, 'status', '--porcelain', '--untracked-files=all', '--', ...HOST_SOURCES))
    throw hostError('dirty-host-source');
  const head = io.git(workspace, 'rev-parse', 'HEAD');
  if (head !== io.git(workspace, 'rev-parse', '@{u}')) throw hostError('unpushed-host-source');
  return Object.fromEntries(
    HOST_SOURCES.map((file) => {
      ordinaryPath(join(workspace, file), false, io);
      return [file, sha256(io.fs.readFileSync(join(workspace, file)))];
    }),
  );
}

export async function hostCliVersion(config, io, workspace) {
  io.checkTime();
  const run = await (io.start ?? startStage)({
    command: { ...codexInvocation(config, ['--version']), cwd: workspace, stdin: '' },
    timeoutMs: io.cliBudgetMs ?? 10000,
    spawn,
    killTree: createKillTree((program, args) => spawnSync(program, args, { windowsHide: true })),
  }).finished;
  if (run.code !== 0 || run.error || run.killedBy)
    throw Object.assign(new Error('CLI start failed'), {
      hostCode: run.killedBy ? 'timeout' : classifyHostError(run.error ?? { stderr: run.stderr }),
      status: run.code,
    });
  const version = /^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+.][a-zA-Z0-9.-]+)?$/.exec(
    run.stdout.trim(),
  );
  if (!version) throw hostError('cli-version-unknown');
  io.checkTime();
  return version[0];
}

/** callbacks поступают из закреплённого кода опыта, никогда из CLI или RPC модели. */
export function projectSkillHostEffects(
  {
    workspace,
    home,
    config,
    evidence,
    evidenceHash,
    checkerStartedAt,
    resolveProjectSkillWrites,
    codexExecutionArgs,
    invocation,
    runProbeSession,
    env = process.env,
  },
  effects = {},
) {
  let io = hostIO(effects);
  const fixture = evidence.fixture;
  const verify = io.verifyFixture ?? verifyHostFixture;
  const sourceSnapshot = io.sources ?? hostSourceSnapshot;
  let phaseIndex = 0;
  let started = false;
  let assignment;
  let targetSession;
  const configDigest = sha256(JSON.stringify(config));
  function guard() {
    if (
      evidence.schemaVersion !== 1 ||
      evidence.status !== 'ready' ||
      !evidence.hostReady ||
      !evidence.cliStart ||
      evidence.permissionAcceptance !== 'not-run' ||
      !Array.isArray(evidence.sessions) ||
      evidence.sessions.length ||
      !evidence.consumerPreserved ||
      !evidence.previousPreserved ||
      !samePath(evidence.workspace, workspace) ||
      evidence.sourcePr?.sha !== PR_SOURCE ||
      !Number.isFinite(Date.parse(checkerStartedAt)) ||
      !(Date.parse(evidence.finishedAt) < Date.parse(checkerStartedAt))
    )
      throw hostError('host-evidence-invalid');
    const file = ordinaryPath(join(workspace, HOST_EVIDENCE), false, io);
    const bytes = io.fs.readFileSync(file);
    if (sha256(bytes) !== evidenceHash || !isDeepStrictEqual(JSON.parse(String(bytes)), evidence))
      throw hostError('host-evidence-changed');
    if (
      configDigest !== evidence.configDigest ||
      sha256(JSON.stringify(config)) !== configDigest ||
      !isDeepStrictEqual(sourceSnapshot(workspace, io), evidence.sources)
    )
      throw hostError('host-source-changed');
  }
  function resolveAssignment() {
    const current = resolveProjectSkillWrites({ ...fixture, home });
    if (
      !isDeepStrictEqual(
        current.files,
        TARGETS.map((file) => resolve(fixture.cwd, file)),
      )
    )
      throw hostError('grant-set-mismatch');
    if (assignment && !isDeepStrictEqual(current, assignment))
      throw hostError('assignment-changed');
    assignment ??= JSON.parse(JSON.stringify(current));
    return current;
  }
  return {
    setup(requestedWorkspace) {
      if (started || !samePath(requestedWorkspace, workspace))
        throw hostError('probe-already-started');
      guard();
      verify(workspace, fixture, io);
      resolveAssignment();
      // Готовый стенд допускает ровно один прежний опыт: новый adapter не обнуляет лимит.
      io.fs.writeFileSync(
        join(fixture.stand, 'probe-started.json'),
        JSON.stringify({ maxSessions: 2, maxResumes: 1 }),
        { flag: 'wx' },
      );
      started = true;
      return fixture;
    },
    async runSession(command, phase) {
      if (!started || phase !== ['baseline', 'target', 'resume'][phaseIndex])
        throw hostError('phase-budget');
      io = hostIO(effects);
      guard();
      verify(workspace, fixture, io, phase);
      const grants = resolveAssignment();
      const args = [
        'exec',
        '--ignore-user-config',
        '--json',
        ...codexExecutionArgs(
          config,
          fixture.root,
          fixture.cwd,
          'win32',
          phase === 'baseline' ? [] : grants.files,
        ),
        '-c',
        'project_doc_max_bytes=0',
      ];
      const model = modelForStage(config, 'codex', 'implement');
      if (model) args.push('--model', model);
      if (phase === 'resume') args.push('resume', targetSession);
      args.push('-');
      const expected = invocation(config, args);
      const gitdir = io.git(fixture.cwd, 'rev-parse', '--absolute-git-dir');
      const files = [
        ...new Set([
          resolve(fixture.root, '.git'),
          resolve(gitdir),
          resolve(fixture.root, '.perf-lock'),
          resolve(fixture.root, '.perf-log.jsonl'),
          ...(phase === 'baseline' ? [] : grants.files),
        ]),
      ];
      const profile =
        'permissions={td-pipeline={extends=":workspace",filesystem={' +
        files.map((file) => JSON.stringify(file.replaceAll('\\', '/')) + '="write"').join(',') +
        '},network={enabled=true}}}';
      if (
        command.profile !== profile ||
        !args.includes('approval_policy="never"') ||
        !args.includes('default_permissions="td-pipeline"') ||
        !args.includes(
          `windows.sandbox=${JSON.stringify(config.codexWindowsSandbox ?? 'elevated')}`,
        )
      )
        throw hostError('exact-profile-mismatch');
      if (
        command.cwd !== fixture.cwd ||
        command.program !== expected.program ||
        !isDeepStrictEqual(command.args, expected.args) ||
        !isDeepStrictEqual(command.grants, grants) ||
        command.profile !== args.find((arg) => arg.startsWith('permissions='))
      )
        throw hostError('profile-mismatch');
      if (
        (await (io.cliVersion ?? hostCliVersion)(config, io, workspace)) !== evidence.versions.codex
      )
        throw hostError('cli-version-changed');
      const cleanEnv = Object.fromEntries(
        Object.entries(env).filter(
          ([key]) =>
            !/^GIT_(?:CONFIG.*|TRACE.*|CURL_VERBOSE|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)$/i.test(
              key,
            ),
        ),
      );
      const childEnv = codexGitEnvironment(
        codexChildEnvironment({ env: cleanEnv, ...(io.getToken ? { getToken: io.getToken } : {}) }),
        fixture.root,
        fixture.cwd,
      );
      const result = await runProbeSession({ ...command, env: childEnv }, phase);
      phaseIndex++;
      if (phase === 'target')
        targetSession = result.events?.find((event) => event.type === 'thread.started')?.thread_id;
      try {
        guard();
        resolveAssignment();
        verify(workspace, fixture, io, phase, true);
      } catch (error) {
        // События исходного опыта остаются у его классификатора даже при порче контроля.
        result.run = { ...result.run, code: 1, stopReason: classifyHostError(error) };
        phaseIndex = 3;
      }
      return result;
    },
  };
}
