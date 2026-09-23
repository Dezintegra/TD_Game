import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const REFRESH_SCHEMA = 1;
export const REFRESH_TASK = '0370-poluchit-razlichayuschie-svidetelstva-re';
export const REFRESH_CONSUMER = '0366-vosstanovit-zapusk-komand-posle-neudachn';
export const evidenceHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 8192;
const utc = (v) => text(v) && Number.isFinite(Date.parse(v)) && v.endsWith('Z');
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
const id = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);

// Только перечисленные поля доходят до диска. Произвольные argv/env/output запрещены.
const schemas = {
  manifest: [
    'schemaVersion',
    'taskId',
    'consumerTaskId',
    'collectionId',
    'capturedAt',
    'host',
    'root',
    'home',
    'cwd',
    'branch',
    'revision',
    'sourceHashes',
    'configurationHash',
    'environmentId',
    'permissionsId',
    'provider',
    'executable',
    'requestedProfile',
    'plan',
    'origin',
  ],
  process: ['pid', 'creationTime', 'image', 'sha256', 'version', 'parentPid', 'parentCreationTime'],
  target: [
    'path',
    'realpath',
    'fileId',
    'reparse',
    'owner',
    'dacl',
    'inheritance',
    'descriptorHash',
  ],
  token: [
    'pid',
    'creationTime',
    'threadId',
    'kind',
    'user',
    'groups',
    'restricted',
    'integrity',
    'elevation',
    'fingerprint',
  ],
  access: ['tokenFingerprint', 'descriptorHash', 'mask', 'granted', 'method', 'limitations'],
  observation: ['status', 'at', 'source', 'reason', 'references', 'value'],
  event: [
    'kind',
    'launchId',
    'sessionId',
    'invocationId',
    'eventId',
    'commandIndex',
    'at',
    'process',
    'profile',
    'helper',
    'target',
    'token',
    'access',
    'references',
    'created',
    'exitCode',
    'errorCode',
    'outputHash',
    'refreshId',
    'phase',
    'reason',
  ],
  reference: [
    'path',
    'sha256',
    'capturedAt',
    'sourcePath',
    'firstLine',
    'lastLine',
    'fromUtc',
    'toUtc',
  ],
  executable: ['path', 'sha256', 'version'],
  sourceHash: ['path', 'sha256'],
  profile: ['name', 'permissionsId'],
  plan: ['sessions', 'commands', 'timeoutMs'],
};
function pick(value, type) {
  const result = {};
  for (const key of schemas[type]) {
    if (value?.[key] === undefined) continue;
    const v = value[key];
    if (['process', 'helper', 'target', 'token', 'access', 'profile'].includes(key)) {
      result[key] = pick(v, 'observation');
      if (result[key].value) result[key].value = pick(v.value, key === 'helper' ? 'process' : key);
    } else if (key === 'references') result[key] = v.map((ref) => pick(ref, 'reference'));
    else if (key === 'sourceHashes') result[key] = v.map((ref) => pick(ref, 'sourceHash'));
    else if (['executable', 'plan'].includes(key)) result[key] = pick(v, key);
    else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) result[key] = v;
    else if (key === 'value') result[key] = v;
    else if (['groups', 'restricted', 'dacl'].includes(key) && Array.isArray(v))
      result[key] = v.filter((entry) => typeof entry === 'string');
  }
  return result;
}
function durable(path, data, flag = 'wx') {
  const fd = openSync(path, flag);
  try {
    const bytes = Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function inside(base, path) {
  const rel = relative(base, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
function regularInside(base, path) {
  if (!isAbsolute(path) || !inside(base, path)) throw new Error('evidence-path-outside-bundle');
  let cursor = path;
  while (cursor !== base) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('evidence-link');
    cursor = dirname(cursor);
  }
  if (!lstatSync(path).isFile() || !inside(realpathSync(base), realpathSync(path)))
    throw new Error('evidence-not-regular');
}

/** Резервирование завершается до spawn; незавершённая коллекция также не переиспользуется. */
export function reserveRefreshEvidence(parent, input, { write = durable } = {}) {
  if (!id(input.collectionId)) throw new Error('invalid-collection-id');
  const manifest = pick(input, 'manifest');
  manifest.schemaVersion = REFRESH_SCHEMA;
  const directory = resolve(parent, input.collectionId);
  mkdirSync(parent, { recursive: true });
  mkdirSync(directory);
  const manifestPath = join(directory, 'manifest.json');
  write(manifestPath, JSON.stringify(manifest) + '\n');
  const eventsPath = join(directory, 'events.jsonl');
  write(eventsPath, '');
  let sequence = 0;
  let previousHash = evidenceHash(readFileSync(manifestPath));
  let sealed = false;
  return {
    directory,
    manifestPath,
    append(inputEvent) {
      if (sealed) throw new Error('evidence-sealed');
      const event = pick(inputEvent, 'event');
      const record = { sequence: sequence + 1, previousHash, event };
      const hash = evidenceHash(JSON.stringify(record));
      write(eventsPath, JSON.stringify({ ...record, hash }) + '\n', 'a');
      previousHash = hash;
      sequence++;
      return hash;
    },
    seal() {
      if (sealed) throw new Error('evidence-sealed');
      write(
        join(directory, 'seal.json'),
        JSON.stringify({
          schemaVersion: REFRESH_SCHEMA,
          count: sequence,
          lastHash: previousHash,
          manifestHash: evidenceHash(readFileSync(manifestPath)),
          eventsHash: evidenceHash(readFileSync(eventsPath)),
        }) + '\n',
      );
      sealed = true;
    },
    primary(name, bytes) {
      if (sealed || !id(name)) throw new Error('invalid-primary');
      const path = join(directory, `${name}.json`);
      // Принимается только уже очищенное структурное свидетельство, не сырые логи.
      write(path, JSON.stringify(pick(bytes, 'event')) + '\n');
      return { path, sha256: evidenceHash(readFileSync(path)) };
    },
  };
}

/** Чтение никогда не повторяет эксперимент; оборванный суффикс остаётся явной ошибкой. */
export function readRefreshEvidence(manifestPath) {
  const directory = dirname(resolve(manifestPath));
  const errors = [];
  const records = [];
  let manifest = {};
  let seal = null;
  try {
    regularInside(directory, resolve(manifestPath));
    const bytes = readFileSync(manifestPath);
    manifest = JSON.parse(bytes);
    let previousHash = evidenceHash(bytes);
    const eventsPath = join(directory, 'events.jsonl');
    regularInside(directory, eventsPath);
    const raw = readFileSync(eventsPath, 'utf8');
    const lines = raw.split('\n');
    if (lines.pop() !== '') errors.push('truncated-event');
    for (const line of lines) {
      try {
        const { hash, ...record } = JSON.parse(line);
        if (
          hash !== evidenceHash(JSON.stringify(record)) ||
          record.previousHash !== previousHash ||
          record.sequence !== records.length + 1
        )
          throw new Error('event-chain');
        records.push(record);
        previousHash = hash;
      } catch {
        errors.push('event-chain');
        break;
      }
    }
    const sealPath = join(directory, 'seal.json');
    regularInside(directory, sealPath);
    seal = JSON.parse(readFileSync(sealPath));
    if (
      seal.manifestHash !== evidenceHash(bytes) ||
      seal.eventsHash !== evidenceHash(raw) ||
      seal.lastHash !== previousHash ||
      seal.count !== records.length
    )
      errors.push('seal-mismatch');
  } catch (error) {
    errors.push(error.code ?? error.message);
  }
  return { directory, manifest, records, seal, errors };
}

export function checkRefreshEvidence(manifestPath) {
  const bundle = readRefreshEvidence(manifestPath);
  const { manifest: m, records, directory } = bundle;
  const errors = [...bundle.errors];
  const missing = [];
  const references = [];
  const require = (ok, path) => {
    if (!ok) missing.push(path);
    return ok;
  };
  require(m.schemaVersion === REFRESH_SCHEMA, 'schemaVersion');
  require(m.taskId === REFRESH_TASK && m.consumerTaskId === REFRESH_CONSUMER, 'task-identity');
  for (const key of ['collectionId', 'host', 'branch', 'provider', 'requestedProfile'])
    require(text(m[key]), key);
  for (const key of ['root', 'home', 'cwd']) require(text(m[key]) && isAbsolute(m[key]), key);
  require(utc(m.capturedAt), 'capturedAt');
  require(/^[a-f0-9]{40}$/i.test(m.revision ?? ''), 'revision');
  for (const key of ['configurationHash', 'environmentId', 'permissionsId'])
    require(digest(m[key]), key);
  require(m.origin === 'live-host', 'origin');
  require(m.plan?.sessions === 2 &&
    m.plan?.commands === 4 &&
    m.plan?.timeoutMs > 0 &&
    m.plan.timeoutMs <= 600000, 'plan');
  require(Array.isArray(m.sourceHashes) &&
    m.sourceHashes.length > 0 &&
    m.sourceHashes.every((r) => isAbsolute(r.path ?? '') && digest(r.sha256)), 'sourceHashes');
  require(isAbsolute(m.executable?.path ?? '') &&
    digest(m.executable?.sha256) &&
    text(m.executable?.version), 'executable');
  function refs(refs, path) {
    if (!require(Array.isArray(refs) && refs.length > 0, path)) return false;
    for (const ref of refs) {
      try {
        regularInside(directory, ref.path);
        if (
          !digest(ref.sha256) ||
          evidenceHash(readFileSync(ref.path)) !== ref.sha256 ||
          !utc(ref.capturedAt) ||
          !isAbsolute(ref.sourcePath ?? '') ||
          !Number.isInteger(ref.firstLine) ||
          ref.firstLine < 1 ||
          ref.lastLine < ref.firstLine ||
          !utc(ref.fromUtc) ||
          !utc(ref.toUtc) ||
          Date.parse(ref.toUtc) < Date.parse(ref.fromUtc)
        )
          throw new Error('reference-invalid');
        references.push(ref);
      } catch {
        errors.push(path);
        return false;
      }
    }
    return true;
  }
  const observation = (o, path, fields) =>
    require(o?.status === 'known' &&
      utc(o.at) &&
      text(o.source) &&
      fields.every(
        (f) => o.value?.[f] !== undefined && o.value[f] !== null && o.value[f] !== 'unknown',
      ), path) && refs(o.references, `${path}.references`);
  const launches = new Map();
  let lastTime = Date.parse(m.capturedAt);
  for (const { sequence, event: e } of records) {
    const path = `events.${sequence}`;
    if (!utc(e.at) || Date.parse(e.at) < lastTime) errors.push(`${path}.time`);
    lastTime = Date.parse(e.at);
    if (e.kind === 'prelaunch') {
      if (launches.has(e.launchId)) errors.push(`${path}.duplicate-launch`);
      launches.set(e.launchId, {
        prelaunch: sequence,
        sessionId: null,
        commands: [],
        refresh: new Map(),
        process: null,
      });
    }
    const launch = launches.get(e.launchId);
    if (!launch) {
      errors.push(`${path}.prelaunch`);
      continue;
    }
    if (e.kind === 'identity') {
      observation(e.process, `${path}.process`, [
        'pid',
        'creationTime',
        'image',
        'sha256',
        'version',
      ]);
      observation(e.profile, `${path}.profile`, ['name', 'permissionsId']);
      if (launch.commands.length) errors.push(`${path}.late-identity`);
      if (launch.process && JSON.stringify(launch.process) !== JSON.stringify(e.process?.value))
        errors.push(`${path}.process-reuse`);
      launch.process = e.process?.value;
      launch.profile = e.profile?.value;
      require(e.profile?.value?.name === m.requestedProfile &&
        e.profile?.value?.permissionsId === m.permissionsId, `${path}.profile-mismatch`);
    }
    if (e.kind === 'session') {
      if (launch.sessionId && launch.sessionId !== e.sessionId)
        errors.push(`${path}.session-changed`);
      launch.sessionId = e.sessionId;
      refs(e.references, `${path}.references`);
    }
    if (e.kind === 'refresh') {
      if (!text(e.invocationId) || !text(e.refreshId)) errors.push(`${path}.refresh-correlation`);
      for (const [field, fields] of Object.entries({
        helper: ['pid', 'creationTime', 'image', 'sha256', 'version'],
        target: [
          'path',
          'realpath',
          'fileId',
          'reparse',
          'owner',
          'dacl',
          'inheritance',
          'descriptorHash',
        ],
        token: [
          'pid',
          'creationTime',
          'kind',
          'fingerprint',
          'user',
          'groups',
          'restricted',
          'integrity',
          'elevation',
        ],
        access: ['tokenFingerprint', 'descriptorHash', 'mask', 'granted', 'method', 'limitations'],
      }))
        observation(e[field], `${path}.${field}`, fields);
      const h = e.helper?.value,
        t = e.token?.value,
        a = e.access?.value;
      require(t?.pid === h?.pid &&
        t?.creationTime === h?.creationTime &&
        t?.kind === 'effective-refresh' &&
        a?.tokenFingerprint === t?.fingerprint &&
        a?.descriptorHash === e.target?.value?.descriptorHash &&
        a?.mask === 'WRITE_DAC', `${path}.effective-token`);
      const pair = launch.refresh.get(e.invocationId) ?? [];
      pair.push(e);
      launch.refresh.set(e.invocationId, pair);
      refs(e.references, `${path}.references`);
    }
    if (e.kind === 'command') {
      require(launch.process && launch.profile, `${path}.identity-before-command`);
      if (!launch.sessionId || e.sessionId !== launch.sessionId) errors.push(`${path}.session`);
      if (
        e.commandIndex !== launch.commands.length ||
        launch.commands.some((c) => c.invocationId === e.invocationId) ||
        !text(e.invocationId)
      )
        errors.push(`${path}.command-order`);
      require((e.created === false && text(e.errorCode) && e.exitCode === undefined) ||
        (e.created === true && Number.isInteger(e.exitCode)), `${path}.result`);
      refs(e.references, `${path}.references`);
      launch.commands.push(e);
    }
  }
  require(launches.size === 2, 'launch-count');
  for (const [launchId, l] of launches) {
    require(l.commands.length === 4, `${launchId}.commands`);
    for (const c of l.commands) {
      const pair = l.refresh.get(c.invocationId) ?? [];
      require(pair.length === 2 &&
        pair[0].phase === 'begin' &&
        pair[1].phase === 'end' &&
        pair[0].refreshId === pair[1].refreshId, `${launchId}.${c.invocationId}.refresh`);
      if (
        pair.length === 2 &&
        JSON.stringify(pair[0].helper?.value) !== JSON.stringify(pair[1].helper?.value)
      )
        errors.push(`${launchId}.${c.invocationId}.helper-reuse`);
    }
  }
  let causalSufficiency = false;
  let causalReview = 'requires-referenced-host-supplement-and-human-review';
  try {
    const supplementPath = join(directory, 'supplement.json');
    regularInside(directory, supplementPath);
    const s = JSON.parse(readFileSync(supplementPath));
    const bound =
      s.schemaVersion === REFRESH_SCHEMA &&
      s.manifestHash === bundle.seal?.manifestHash &&
      s.eventsHash === bundle.seal?.eventsHash &&
      utc(s.reviewedAt) &&
      text(s.reviewer);
    const hypotheses = ['directory-rights', 'refresh-token', 'helper-version', 'lifecycle'];
    const table =
      Array.isArray(s.hypotheses) &&
      hypotheses.every((name) =>
        s.hypotheses.some(
          (h) =>
            h.name === name &&
            text(h.finding) &&
            refs(h.references, `supplement.${name}.references`),
        ),
      );
    const control = s.control;
    const comparable =
      control &&
      Array.isArray(control.launchIds) &&
      control.launchIds.length === 2 &&
      new Set(control.launchIds).size === 2 &&
      control.launchIds.every((launch) => launches.has(launch)) &&
      ['target', 'descriptor', 'helper', 'token', 'profile'].every(
        (key) =>
          text(control.invariants?.[key]) &&
          refs(control.references?.[key], `supplement.control.${key}`),
      );
    const experiment = s.experiment;
    const experimentSupported =
      s.verdict === 'experiment-supported' &&
      experiment &&
      ['variable', 'invariants', 'method', 'decisionRule', 'rejectionConditions'].every((key) =>
        text(experiment[key]),
      ) &&
      experiment.budgetMs > 0 &&
      experiment.budgetMs <= 600000 &&
      Array.isArray(experiment.predictions) &&
      experiment.predictions.length >= 2 &&
      new Set(experiment.predictions.map((p) => p.outcome)).size >= 2 &&
      experiment.predictions.every((p) => hypotheses.includes(p.hypothesis) && text(p.outcome)) &&
      refs(experiment.references, 'supplement.experiment.references');
    const repairSupported =
      s.verdict === 'repair-supported' &&
      text(s.mechanism) &&
      refs(s.references, 'supplement.repair.references');
    causalSufficiency = !!(
      bound &&
      table &&
      comparable &&
      (experimentSupported || repairSupported)
    );
    causalReview = causalSufficiency
      ? 'structure-and-references-verified-human-conclusion'
      : 'insufficient-supplement';
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push('supplement-invalid');
  }
  const integrity = errors.length === 0;
  return {
    integrity,
    completeness: integrity && missing.length === 0,
    causalSufficiency: integrity && missing.length === 0 && causalSufficiency,
    missing,
    errors,
    references,
    recoveredRecords: records.length,
    causalReview,
  };
}
