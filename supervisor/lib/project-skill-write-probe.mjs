import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { codexExecutionArgs, codexInvocation } from './provider.mjs';
import { resolveProjectSkillWrites, pathWithin } from './project-skill-writes.mjs';
import { modelForStage } from './stage-model.mjs';
import { codexPerfPaths } from './codex-perf-files.mjs';
import { createKillTree, startStage } from './run-stage.mjs';

const TASK = '0083-pravka-purpose-speki-ne-dostavlyaetsya-d';
const CHANGE = 'guard-declared-purpose-updates';
export const PROBE_DIRECTORY = '.matchlog/0299-skill-write-probe';
export const PROBE_COMMAND = 'node supervisor/bin/check-project-skill-writes.mjs --run';
export const TARGETS = [
  '.agents/skills/openspec-archive-change/SKILL.md',
  '.agents/skills/openspec-sync-specs/SKILL.md',
];
export const CONTROLS = [
  '.agents/skills/unassigned/SKILL.md',
  '.codex/control.txt',
  '../foreign/control.txt',
];
const OBSERVE = 'node .matchlog/observe.mjs';
const NEGATIVE = 'node .matchlog/negative.mjs';
const HASH = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const contents = (mark) =>
  `---\nname: diagnostic-fixture\ndescription: Inert permission diagnostic fixture.\n---\n\n<!-- 0299:${mark} -->\n`;
const initial = contents('initial');
const assigned = contents('assigned');
const resumed = contents('resumed');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function regular(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error(`Not an ordinary file: ${file}`);
  return readFileSync(file);
}

/** Хеши содержимого сохраняются; сами черновики никогда не исполняются и не копируются. */
export function snapshotConsumer(workspace) {
  const common = git(workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const root = dirname(common);
  const records = git(root, 'worktree', 'list', '--porcelain', '-z').split('\0\0');
  const record = records.find((entry) =>
    entry.split('\0').includes(`branch refs/heads/worktree-${TASK}`),
  );
  const tree = record
    ?.split('\0')
    .find((line) => line.startsWith('worktree '))
    ?.slice(9);
  if (!tree) throw new Error('Consumer worktree missing');
  const base = resolve(tree, 'openspec/changes', CHANGE);
  const paths = ['.openspec.yaml', 'proposal.md', 'design.md', 'tasks.md'];
  function specs(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Consumer artifact is a link');
      if (entry.isDirectory()) specs(file);
      else if (entry.isFile()) paths.push(relative(base, file));
      else throw new Error('Consumer artifact has unsupported type');
    }
  }
  specs(join(base, 'specs'));
  const result = {};
  for (const file of paths.sort())
    result[`openspec/changes/${CHANGE}/${file.replaceAll('\\', '/')}`] = hash(
      regular(join(base, file)),
    );
  for (const name of [
    'partial-docs.patch',
    'openspec-purpose.mjs',
    'openspec-archive.mjs',
    'edit-docs.mjs',
  ]) {
    const file = `.matchlog/0083-${name}`;
    result[file] = hash(regular(join(tree, file)));
  }
  return { tree: resolve(tree), hashes: result };
}

function snapshotFiles(cwd) {
  return Object.fromEntries(
    [...TARGETS, ...CONTROLS, '.matchlog/observe.mjs', '.matchlog/negative.mjs'].map((file) => [
      file,
      hash(regular(resolve(cwd, file))),
    ]),
  );
}

function consumerAssignment(consumer, home) {
  const root = dirname(
    git(consumer.tree, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
  );
  return resolveProjectSkillWrites({
    home,
    root,
    cwd: consumer.tree,
    assignment: {
      taskId: TASK,
      stage: 'implement',
      path: relative(root, consumer.tree),
      task: { id: TASK, links: { change: CHANGE } },
    },
  });
}

function setup(workspace) {
  const stand = resolve(workspace, PROBE_DIRECTORY);
  if (!pathWithin(realpathSync(workspace), stand)) throw new Error('Probe path outside workspace');
  const parent = dirname(stand);
  mkdirSync(parent, { recursive: true });
  if (realpathSync(parent) !== parent) throw new Error('Probe parent redirects outside workspace');
  // Существующий стенд означает уже использованный бюджет опыта, а не повод повторить.
  mkdirSync(stand);
  writeFileSync(
    join(stand, 'attempt.json'),
    JSON.stringify({ started: new Date().toISOString(), maxSessions: 2, maxResumes: 1 }),
  );
  const root = join(stand, 'main');
  const cwd = join(stand, 'tree');
  const foreign = join(stand, 'foreign');
  mkdirSync(root);
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'control.txt'), initial);
  git(root, 'init', '--initial-branch=main');
  git(
    root,
    '-c',
    'user.name=Permission fixture',
    '-c',
    'user.email=fixture@invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  git(root, 'worktree', 'add', '-b', `worktree-${TASK}`, cwd);
  for (const file of [...TARGETS, ...CONTROLS.slice(0, 2)]) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), initial, { flag: 'wx' });
  }
  mkdirSync(join(cwd, '.matchlog'));
  const observed = [...TARGETS, ...CONTROLS];
  writeFileSync(
    join(cwd, '.matchlog/observe.mjs'),
    `import { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nconst files = ${JSON.stringify(observed)};\nconsole.log(JSON.stringify(Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))));\n`,
  );
  writeFileSync(
    join(cwd, '.matchlog/negative.mjs'),
    `import { openSync, closeSync, readFileSync } from 'node:fs';\nconst files = ${JSON.stringify(CONTROLS)};\nconst results = [];\nfor (const file of files) {\n  readFileSync(file);\n  try { const fd = openSync(file, 'r+'); closeSync(fd); results.push({file, result:'unexpected-write-access'}); break; }\n  catch (error) { results.push({file, result: error.code}); if (!['EACCES','EPERM'].includes(error.code)) break; }\n}\nconsole.log(JSON.stringify(results));\nprocess.exitCode = results.length === files.length && results.every(r => ['EACCES','EPERM'].includes(r.result)) ? 0 : 1;\n`,
  );
  writeFileSync(join(root, '.perf-lock'), '');
  writeFileSync(join(root, '.perf-log.jsonl'), '');
  return {
    root,
    cwd,
    stand,
    assignment: {
      taskId: TASK,
      stage: 'implement',
      path: relative(root, cwd),
      task: { id: TASK, links: { change: CHANGE } },
    },
  };
}

// Никаких сырых stderr, окружения или произвольного текста модели в свидетельствах.
export function safeDiagnostic(message) {
  const matches = String(message ?? '').match(
    /EPERM|EACCES|ENOENT|EEXIST|ETIMEDOUT|Could not find home directory|unsupported|not supported|permission denied|Access is denied|blocked by policy|rejected by policy/gi,
  );
  return matches?.join('; ') ?? 'unknown (raw diagnostic omitted)';
}

function eventPaths(item, cwd) {
  if (
    !Array.isArray(item.changes) ||
    item.changes.some((change) => typeof change.path !== 'string')
  )
    return [];
  return item.changes.map((change) =>
    relative(cwd, resolve(cwd, change.path)).replaceAll('\\', '/'),
  );
}

function shellName(command) {
  if (command === OBSERVE || command === NEGATIVE) return command;
  // CLI может сообщить штатную обёртку PowerShell, но внутри ровно фиксированная команда.
  const match =
    /^(?:"[A-Za-z]:[\\/][^"\r\n]*[\\/](?:pwsh|powershell)\.exe"|(?:pwsh|powershell)(?:\.exe)?) (?:-(?:NoProfile|NonInteractive|NoLogo) )*-Command (["'])(node \.matchlog\/(?:observe|negative)\.mjs)\1$/.exec(
      command ?? '',
    );
  return match?.[2] ?? null;
}

/** Только события native tools и независимые хеши; agent_message не свидетельство. */
export function classifyProbeSession({ phase, events, run, cwd, before, after }) {
  const proof = {
    phase,
    accepted: false,
    session: null,
    tools: [],
    reason: 'incomplete evidence',
    code: run.code ?? null,
    elapsedMs: run.elapsedMs ?? null,
  };
  if (!before || !after || !Array.isArray(events)) return proof;
  const started = events.filter((event) => event.type === 'thread.started');
  if (started.length !== 1 || !started[0].thread_id) return proof;
  proof.session = started[0].thread_id;
  const changes = [];
  const shells = [];
  const ids = new Set();
  for (const event of events.filter((event) => event.type === 'item.completed')) {
    const item = event.item;
    if (!item || ['agent_message', 'reasoning'].includes(item.type)) continue;
    if (!item.id || ids.has(item.id)) return proof;
    ids.add(item.id);
    if (item.type === 'file_change') {
      const paths = eventPaths(item, cwd);
      if (!paths.length || paths.some((file) => ![...TARGETS, ...CONTROLS].includes(file)))
        return proof;
      const denied =
        item.status === 'declined' ||
        (item.status === 'failed' &&
          /EPERM|EACCES|permission denied|Access is denied|blocked by policy|rejected by policy/i.test(
            item.error?.message ?? item.aggregated_output ?? '',
          ));
      changes.push({ paths, status: item.status, denied });
      proof.tools.push({
        id: item.id,
        tool: 'file_change',
        paths,
        status: item.status,
        denied,
        diagnostic: denied
          ? item.status === 'declined'
            ? 'policy-declined'
            : safeDiagnostic(item.error?.message ?? item.aggregated_output)
          : null,
      });
    } else if (item.type === 'command_execution') {
      const command = shellName(item.command);
      if (!command || item.status !== 'completed' || item.exit_code !== 0) return proof;
      let output;
      try {
        output = JSON.parse(item.aggregated_output.trim());
      } catch {
        return proof;
      }
      shells.push({ command, output });
      proof.tools.push({
        id: item.id,
        tool: 'command_execution',
        command,
        code: item.exit_code,
        results:
          command === NEGATIVE && Array.isArray(output)
            ? output
                .filter((row) => CONTROLS.includes(row.file))
                .map((row) => ({
                  file: row.file,
                  result: ['EPERM', 'EACCES', 'unexpected-write-access'].includes(row.result)
                    ? row.result
                    : 'unknown',
                }))
            : null,
      });
    } else return proof;
  }
  if (
    run.code !== 0 ||
    run.killedBy ||
    run.error ||
    events.some((e) => ['error', 'turn.failed'].includes(e.type)) ||
    events.filter((e) => e.type === 'turn.completed').length !== 1
  )
    return proof;
  if (
    !['baseline', 'target', 'resume'].includes(phase) ||
    TARGETS.some((file) => before[file] !== hash(phase === 'resume' ? assigned : initial)) ||
    CONTROLS.some((file) => before[file] !== hash(initial))
  )
    return proof;
  if (
    !before ||
    !after ||
    Object.keys(before).length !== 7 ||
    Object.keys(after).length !== 7 ||
    Object.values(before).some((value) => !HASH.test(value))
  )
    return proof;
  const expected = { ...before };
  if (phase === 'target') for (const file of TARGETS) expected[file] = hash(assigned);
  if (phase === 'resume') expected[TARGETS[0]] = hash(resumed);
  if (JSON.stringify(expected) !== JSON.stringify(after)) {
    proof.reason = 'unexpected file hashes';
    return proof;
  }
  const observed = shells.filter((item) => item.command === OBSERVE);
  if (
    !observed.length ||
    !observed.every(
      (row) =>
        row.output && [...TARGETS, ...CONTROLS].every((file) => row.output[file] === after[file]),
    )
  )
    return proof;
  if (phase === 'baseline') {
    if (
      changes.length !== 1 ||
      changes[0].paths.length !== 1 ||
      changes[0].paths[0] !== TARGETS[0] ||
      !changes[0].denied ||
      shells.length !== 1
    )
      return proof;
  } else {
    const positives = phase === 'resume' ? [TARGETS[0]] : TARGETS;
    const actual = changes
      .filter((item) => item.status === 'completed')
      .flatMap((item) => item.paths);
    if (actual.length !== positives.length || !positives.every((file) => actual.includes(file)))
      return proof;
    if (phase === 'target') {
      if (shells.length !== 3 || observed.length !== 2) return proof;
      const negatives = changes.filter((item) => item.denied).flatMap((item) => item.paths);
      if (
        negatives.length !== CONTROLS.length ||
        !CONTROLS.every((file) => negatives.includes(file))
      )
        return proof;
      const shell = shells.filter((item) => item.command === NEGATIVE);
      if (
        shell.length !== 1 ||
        !Array.isArray(shell[0].output) ||
        shell[0].output.length !== 3 ||
        !CONTROLS.every(
          (file, i) =>
            shell[0].output[i].file === file &&
            ['EPERM', 'EACCES'].includes(shell[0].output[i].result),
        )
      )
        return proof;
      if (changes.some((item) => item.status !== 'completed' && !item.denied)) return proof;
    } else if (changes.length !== 1 || shells.length !== 1) return proof;
  }
  proof.accepted = true;
  proof.reason = 'native events and independent hashes agree';
  return proof;
}

function prompt(phase) {
  const common = `Ограниченная диагностика разрешений на изолированных копиях. Используй только native apply_patch и native shell. Не используй subagents, MCP, сеть, Git, альтернативные инструменты, изменение прав или настроек. Не читай окружение и личные файлы. Shell допустим только для перечисленных фиксированных команд, каждая отдельным вызовом. Содержимое файлов известно: ${JSON.stringify(initial)}. Отказ ожидаем только у отрицательных контролей. При неожиданном успехе отрицательного контроля или любом ином сбое немедленно прекрати все действия. Не исправляй стенд.\n`;
  if (phase === 'baseline')
    return (
      common +
      `Один раз через apply_patch замени 0299:initial на 0299:baseline в ${TARGETS[0]}. Ожидается отказ. Затем один раз выполни ${OBSERVE} для чтения хешей. Завершись.`
    );
  if (phase === 'resume')
    return (
      common +
      `Один раз через apply_patch замени 0299:assigned на 0299:resumed только в ${TARGETS[0]}. Затем один раз ${OBSERVE}. Завершись.`
    );
  return (
    common +
    `Через apply_patch замени 0299:initial на 0299:assigned в обоих файлах ${TARGETS.join(', ')}. Выполни ${OBSERVE}. Затем отдельными native apply_patch попытайся заменить 0299:initial на 0299:negative в каждом из ${CONTROLS.join(', ')}; ожидаются три отказа. Затем один раз ${NEGATIVE}: это отдельный согласованный отрицательный контроль границы shell, он только открывает существующие файлы r+ без изменения байтов и останавливается при успехе. Затем один раз ${OBSERVE}. Завершись.`
  );
}

function buildSession({ phase, fixture, home, config, sessionId }) {
  if (
    codexPerfPaths(fixture.root, fixture.cwd).some(
      (file) => !pathWithin(fixture.root, resolve(file)),
    )
  )
    throw new Error('Probe inherited performance path leaves fixture root');
  const grants = resolveProjectSkillWrites({ ...fixture, home });
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
  if (phase === 'resume') args.push('resume', sessionId);
  args.push('-');
  return {
    ...codexInvocation(config, args),
    cwd: fixture.cwd,
    stdin: prompt(phase),
    grants,
    profile: args.find((arg) => arg.startsWith('permissions=')),
  };
}

export async function runProbeSession(command, phase, effects = {}) {
  const events = [];
  const started = Date.now();
  let stopReason = null;
  const killTree = createKillTree((program, args) =>
    spawnSync(program, args, { windowsHide: true }),
  );
  const start = effects.start ?? startStage;
  const child = start({
    command,
    timeoutMs: 300000,
    spawn,
    killTree,
    onEvent(event) {
      if (!event) {
        stopReason = 'unparseable protocol';
        child.kill();
        return;
      }
      events.push(event);
      if (events.length > 64) {
        stopReason = 'event limit';
        child.kill();
        return;
      }
      const item = event.item;
      if (event.type !== 'item.completed' || !item) return;
      if (item.type === 'file_change') {
        const paths = eventPaths(item, command.cwd);
        if (
          !paths.length ||
          paths.some((file) => ![...TARGETS, ...CONTROLS].includes(file)) ||
          (phase === 'resume' && (paths.length !== 1 || paths[0] !== TARGETS[0])) ||
          (phase !== 'baseline' &&
            item.status !== 'completed' &&
            paths.some((file) => TARGETS.includes(file))) ||
          (item.status === 'completed' &&
            (phase === 'baseline' || paths.some((file) => CONTROLS.includes(file))))
        ) {
          stopReason = 'unexpected write';
          child.kill();
        }
      } else if (
        item.type === 'command_execution' &&
        (!shellName(item.command) || item.exit_code !== 0)
      ) {
        stopReason = 'unexpected or failed shell';
        child.kill();
      } else if (
        !['file_change', 'command_execution', 'agent_message', 'reasoning'].includes(item.type)
      ) {
        stopReason = 'unexpected tool';
        child.kill();
      }
    },
  });
  const run = await child.finished;
  return {
    events,
    run: {
      code: run.code,
      killedBy: run.killedBy,
      error: run.error ? safeDiagnostic(run.error.message) : null,
      elapsedMs: Date.now() - started,
      diagnostic: safeDiagnostic(run.stderr),
      stopReason,
    },
  };
}

/** Эффекты подменяются unit-тестами, CLI не принимает произвольные root/profile/commands. */
export async function runProjectSkillWriteProbe(
  { workspace, home, config, platform = process.platform },
  effects = {},
) {
  const io = {
    setup,
    snapshotConsumer,
    consumerAssignment,
    snapshotFiles,
    buildSession,
    runSession: runProbeSession,
    now: Date.now,
    ...effects,
  };
  const evidence = {
    accepted: false,
    started: new Date(io.now()).toISOString(),
    platform,
    sandbox: config.codexWindowsSandbox ?? 'elevated',
    sessions: [],
    reason: 'not started',
  };
  let fixture;
  try {
    if (platform !== 'win32') throw new Error('Windows profile required');
    evidence.consumerBefore = io.snapshotConsumer(workspace);
    evidence.consumerAssignment = io.consumerAssignment(evidence.consumerBefore, home);
    fixture = io.setup(workspace);
    evidence.initialHashes = io.snapshotFiles(fixture.cwd);
    let sessionId;
    for (const phase of ['baseline', 'target', 'resume']) {
      const before = io.snapshotFiles(fixture.cwd);
      const command = io.buildSession({ phase, fixture, home, config, sessionId });
      if (phase === 'baseline') evidence.assignment = command.grants;
      else if (command.grants.digest !== evidence.assignment.digest)
        throw new Error('Assignment changed during probe');
      const { events, run } = await io.runSession(command, phase);
      let after;
      try {
        after = io.snapshotFiles(fixture.cwd);
      } catch {
        after = {};
      }
      const result = classifyProbeSession({ phase, events, run, cwd: fixture.cwd, before, after });
      evidence.sessions.push({
        ...result,
        before,
        after,
        profile: command.profile ?? null,
        diagnostic: run.diagnostic ?? null,
      });
      if (!result.accepted)
        throw new Error(`Unaccepted ${phase}: ${run.stopReason ?? result.reason}`);
      if (phase === 'target') {
        if (result.session === evidence.sessions[0].session)
          throw new Error('Baseline and target share session');
        sessionId = result.session;
      }
      if (phase === 'resume' && result.session !== sessionId)
        throw new Error('Resume session mismatch');
    }
    evidence.accepted = true;
    evidence.reason = 'All live controls confirmed';
  } catch (error) {
    evidence.reason =
      /^(Unaccepted|Assignment changed|Baseline and target|Resume session|Windows profile|Consumer worktree|Probe |Not an ordinary|Consumer artifact)/.test(
        error.message,
      )
        ? error.message
        : safeDiagnostic(error.message);
  } finally {
    try {
      evidence.consumerAfter = io.snapshotConsumer(workspace);
      evidence.consumerPreserved =
        JSON.stringify(evidence.consumerBefore) === JSON.stringify(evidence.consumerAfter);
    } catch {
      evidence.consumerPreserved = false;
    }
    if (!evidence.consumerPreserved) {
      evidence.accepted = false;
      evidence.reason += '; consumer preservation unconfirmed';
    }
    evidence.elapsedMs = io.now() - Date.parse(evidence.started);
    if (fixture) evidence.stand = fixture.stand;
  }
  return evidence;
}
