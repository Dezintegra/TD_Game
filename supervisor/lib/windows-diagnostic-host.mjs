import { dirname, join, resolve } from 'node:path';
import { release } from 'node:os';
import { Buffer } from 'node:buffer';
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
export function prepareProjectSkillHost({ workspace, home, config = {} }, effects = {}) {
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
    if (!io.cliVersion) throw hostError('cli-version-effect-required');
    evidence.versions.codex = io.cliVersion(config, io);
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
