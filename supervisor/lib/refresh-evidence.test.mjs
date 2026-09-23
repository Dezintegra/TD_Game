import { afterEach, describe, expect, it } from 'vitest';
const { structuredClone } = globalThis;
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  REFRESH_CONSUMER,
  REFRESH_TASK,
  checkRefreshEvidence,
  evidenceHash,
  readRefreshEvidence,
  reserveRefreshEvidence,
} from './refresh-evidence.mjs';

const roots = [];
const at = '2026-09-23T19:00:00.000Z';
const hash = evidenceHash('fixed');
function fixture(mutate = () => {}, manifestChange = {}) {
  const parent = resolve('.matchlog/refresh-evidence-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-'));
  roots.push(root);
  const manifest = {
    taskId: REFRESH_TASK,
    consumerTaskId: REFRESH_CONSUMER,
    collectionId: 'capture',
    capturedAt: at,
    host: 'host',
    root,
    home: root,
    cwd: root,
    branch: 'branch',
    revision: 'a'.repeat(40),
    sourceHashes: [{ path: join(root, 'module.mjs'), sha256: hash }],
    configurationHash: hash,
    environmentId: hash,
    permissionsId: hash,
    provider: 'codex',
    executable: { path: join(root, 'codex.exe'), sha256: hash, version: 'test' },
    requestedProfile: 'workspace-write',
    plan: { sessions: 2, commands: 4, timeoutMs: 600000 },
    origin: 'live-host',
    ...manifestChange,
  };
  const store = reserveRefreshEvidence(root, manifest);
  const source = store.primary('source', { kind: 'observation', at });
  const ref = {
    ...source,
    capturedAt: at,
    sourcePath: join(root, 'source.log'),
    firstLine: 1,
    lastLine: 1,
    fromUtc: at,
    toUtc: at,
  };
  const observed = (value) => ({
    status: 'known',
    at,
    source: 'host-native',
    references: [ref],
    value,
  });
  const events = [];
  for (let launch = 0; launch < 2; launch++) {
    const launchId = `launch-${launch}`,
      sessionId = `session-${launch}`;
    const common = { launchId, sessionId, at, references: [ref] };
    events.push({ ...common, kind: 'prelaunch' });
    events.push({
      ...common,
      kind: 'identity',
      process: observed({
        pid: 100 + launch,
        creationTime: at,
        image: 'codex.exe',
        sha256: hash,
        version: 'test',
      }),
      profile: observed({ name: 'workspace-write', permissionsId: hash }),
    });
    events.push({ ...common, kind: 'session' });
    for (let commandIndex = 0; commandIndex < 4; commandIndex++) {
      const invocationId = `${launch}-${commandIndex}`;
      const refresh = {
        ...common,
        kind: 'refresh',
        invocationId,
        refreshId: `refresh-${invocationId}`,
        helper: observed({
          pid: 200 + launch,
          creationTime: at,
          image: 'helper.exe',
          sha256: hash,
          version: 'test',
        }),
        target: observed({
          path: root,
          realpath: root,
          fileId: 'file-1',
          reparse: false,
          owner: 'owner',
          dacl: ['allow'],
          inheritance: true,
          descriptorHash: hash,
        }),
        token: observed({
          pid: 200 + launch,
          creationTime: at,
          kind: 'effective-refresh',
          fingerprint: hash,
          user: 'user',
          groups: [],
          restricted: [],
          integrity: 'medium',
          elevation: false,
        }),
        access: observed({
          tokenFingerprint: hash,
          descriptorHash: hash,
          mask: 'WRITE_DAC',
          granted: true,
          method: 'AccessCheck',
          limitations: 'none',
        }),
      };
      events.push({ ...refresh, phase: 'begin' }, { ...structuredClone(refresh), phase: 'end' });
      events.push({
        ...common,
        kind: 'command',
        invocationId,
        commandIndex,
        created: true,
        exitCode: 0,
      });
    }
  }
  mutate(events);
  for (const event of events) store.append(event);
  store.seal();
  return { root, manifest, store, ref, events };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('refresh evidence storage and acceptance', () => {
  it('separates intact complete observations from an unsupported causal claim', () => {
    const { store } = fixture();
    expect(checkRefreshEvidence(store.manifestPath)).toMatchObject({
      integrity: true,
      completeness: true,
      causalSufficiency: false,
    });
    expect(() => store.append({ kind: 'command' })).toThrow('sealed');
  });
  it.each([
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
    'executable',
    'requestedProfile',
    'plan',
    'capturedAt',
    'provider',
    'origin',
  ])('rejects absent manifest %s', (key) => {
    const { store } = fixture(() => {}, { [key]: undefined });
    expect(checkRefreshEvidence(store.manifestPath).completeness).toBe(false);
  });
  for (const [field, keys] of Object.entries({
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
  })) {
    it.each(keys)(`requires ${field}.%s`, (key) => {
      const { store } = fixture((events) => {
        delete events.find((e) => e.kind === 'refresh')[field].value[key];
      });
      expect(checkRefreshEvidence(store.manifestPath).completeness).toBe(false);
    });
  }
  it.each(['unknown', 'denied', 'unavailable'])('does not count %s as an observation', (status) => {
    const { store } = fixture((events) => {
      events.find((e) => e.kind === 'refresh').token.status = status;
    });
    expect(checkRefreshEvidence(store.manifestPath).completeness).toBe(false);
  });
  it('detects PID reuse and mixed sessions', () => {
    for (const mutate of [
      (events) => {
        events.find((e) => e.phase === 'end').helper.value.creationTime =
          '2026-09-23T19:01:00.000Z';
      },
      (events) => {
        events.find((e) => e.kind === 'command').sessionId = 'other';
      },
    ]) {
      const { store } = fixture(mutate);
      expect(checkRefreshEvidence(store.manifestPath).integrity).toBe(false);
    }
  });
  it('rejects late prelaunch, missing refresh and reordered commands', () => {
    for (const mutate of [
      (events) => events.push(events.shift()),
      (events) =>
        events.splice(
          events.findIndex((e) => e.kind === 'refresh'),
          1,
        ),
      (events) => {
        events.find((e) => e.kind === 'command').commandIndex = 3;
      },
    ]) {
      const { store } = fixture(mutate);
      expect(checkRefreshEvidence(store.manifestPath).completeness).toBe(false);
    }
  });
  it('rejects changed primary bytes and paths outside the collection', () => {
    const { store, ref } = fixture();
    writeFileSync(ref.path, 'changed');
    expect(checkRefreshEvidence(store.manifestPath).integrity).toBe(false);
    const other = fixture((events) => {
      events.find((e) => e.kind === 'command').references = [
        { ...ref, path: resolve('CLAUDE.md') },
      ];
    });
    expect(checkRefreshEvidence(other.store.manifestPath).integrity).toBe(false);
  });
  it('recovers a valid prefix after interruption without replay or overwrite', () => {
    const { store, root, manifest } = fixture();
    const eventsPath = join(store.directory, 'events.jsonl');
    const first = readFileSync(eventsPath, 'utf8').split('\n').slice(0, 6).join('\n') + '\n';
    writeFileSync(eventsPath, first + '{"partial":');
    expect(readRefreshEvidence(store.manifestPath).records).toHaveLength(6);
    expect(checkRefreshEvidence(store.manifestPath)).toMatchObject({
      integrity: false,
      completeness: false,
    });
    expect(() => reserveRefreshEvidence(root, manifest)).toThrow();
  });
  it('propagates prelaunch storage failure and strips unapproved secret fields', () => {
    const { root, manifest, store } = fixture(() => {}, {
      env: { TOKEN: 'SECRET-CANARY' },
      executable: { path: '/bin/codex', sha256: hash, version: 'test', secret: 'SECRET-CANARY' },
    });
    expect(readFileSync(store.manifestPath, 'utf8')).not.toContain('SECRET-CANARY');
    expect(() =>
      reserveRefreshEvidence(
        root,
        { ...manifest, collectionId: 'failed' },
        {
          write: () => {
            throw new Error('disk-full');
          },
        },
      ),
    ).toThrow('disk-full');
  });
  it('rejects legacy and fixture origins, even with successful commands', () => {
    for (const origin of ['fixture', 'legacy', undefined]) {
      const { store } = fixture(() => {}, { origin });
      expect(checkRefreshEvidence(store.manifestPath).completeness).toBe(false);
    }
  });
  it('detects tampering and append after seal', () => {
    const { store } = fixture();
    appendFileSync(join(store.directory, 'events.jsonl'), '{}\n');
    expect(checkRefreshEvidence(store.manifestPath).integrity).toBe(false);
  });
  it('requires a referenced comparison and discriminating predictions for causal handoff', () => {
    const { store, ref } = fixture();
    const seal = JSON.parse(readFileSync(join(store.directory, 'seal.json')));
    const supplement = {
      schemaVersion: 1,
      manifestHash: seal.manifestHash,
      eventsHash: seal.eventsHash,
      reviewedAt: at,
      reviewer: 'host-reviewer',
      verdict: 'experiment-supported',
      hypotheses: ['directory-rights', 'refresh-token', 'helper-version', 'lifecycle'].map(
        (name) => ({ name, finding: 'observed', references: [ref] }),
      ),
      control: {
        launchIds: ['launch-0', 'launch-1'],
        invariants: Object.fromEntries(
          ['target', 'descriptor', 'helper', 'token', 'profile'].map((k) => [k, 'unchanged']),
        ),
        references: Object.fromEntries(
          ['target', 'descriptor', 'helper', 'token', 'profile'].map((k) => [k, [ref]]),
        ),
      },
      experiment: {
        variable: 'initial/later',
        invariants: 'same descriptor token helper',
        method: 'observe refresh',
        decisionRule: 'compare first with later',
        rejectionConditions: 'identity drift',
        budgetMs: 600000,
        predictions: [
          { hypothesis: 'directory-rights', outcome: 'both fail' },
          { hypothesis: 'lifecycle', outcome: 'later fails' },
        ],
        references: [ref],
      },
    };
    const path = join(store.directory, 'supplement.json');
    writeFileSync(path, JSON.stringify(supplement));
    expect(checkRefreshEvidence(store.manifestPath).causalSufficiency).toBe(true);
    supplement.experiment.predictions[1].outcome = 'both fail';
    writeFileSync(path, JSON.stringify(supplement));
    expect(checkRefreshEvidence(store.manifestPath).causalSufficiency).toBe(false);
  });
});
