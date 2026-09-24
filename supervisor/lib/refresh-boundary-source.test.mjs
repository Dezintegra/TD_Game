import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  decodeBoundaryJournal,
  encodeBoundaryFrame,
  MAX_BOUNDARY_FRAME,
} from './refresh-boundary-source.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const options = { expectedWriterIds: ['root'], collectionId: 'collection', launchId: 'launch' };
const identity = {
  hostId: 'host',
  pid: 42,
  creationTime: '134345678901234567',
  helperInstanceId: 'helper',
};
const base = {
  schemaVersion: 'refresh-boundary/v1',
  writerId: 'root',
  seq: '1',
  kind: 'handshake',
  collectionId: 'collection',
  launchId: 'launch',
  qpcTicks: '18446744073709551615',
  qpcFrequency: '10000000',
  utc: '2026-09-24T00:00:00.000Z',
  body: { origin: 'synthetic', buildId: 'a'.repeat(64), process: identity, parentWriterId: null },
};
function journal(records = [base]) {
  const frames = records.map(encodeBoundaryFrame);
  const content = Buffer.concat(frames);
  return Buffer.concat([
    ...frames,
    encodeBoundaryFrame({
      ...base,
      writerId: records[0].writerId,
      seq: String(records.length + 1),
      kind: 'seal',
      body: {
        count: String(records.length),
        finalSeq: String(records.length),
        sha256: sha(content),
        dropped: '0',
        status: 'complete',
      },
    }),
  ]);
}
function raw(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload, Buffer.from(sha(payload), 'hex')]);
}
const codes = (result) => result.reasons.map((reason) => reason.code);

describe('refresh boundary transport', () => {
  it('retains 64-bit strings and accepts a sealed synthetic transport without admitting live evidence', () => {
    const result = decodeBoundaryJournal(journal(), options);
    expect(result.integrity).toBe(true);
    expect(result.completeness).toBe(true);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0].body.process.creationTime).toBe('134345678901234567');
    expect(result.frames[0].qpcTicks).toBe('18446744073709551615');
    expect(result.sourceAvailable).toBe(false);
    expect(result.causalSufficiency).toBe(false);
    expect(result.allowNextInvocation).toBe(false);
  });
  it('never reads unknown getters in the encoder', () => {
    const value = globalThis.structuredClone(base);
    Object.defineProperty(value, 'argv', {
      enumerable: true,
      get() {
        throw new Error('SECRET_CANARY');
      },
    });
    value.body.payload = 'SECRET_CANARY';
    expect(encodeBoundaryFrame(value).includes('SECRET_CANARY')).toBe(false);
    expect(encodeBoundaryFrame(value)).toEqual(encodeBoundaryFrame(base));
  });
  it('rejects inbound unknown fields without copying their values or names into the result', () => {
    const result = decodeBoundaryJournal(raw({ ...base, SECRET_CANARY: 'SECRET_CANARY' }), options);
    expect(codes(result)).toContain('unknown-field');
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
  });
  it.each([
    ['unknown-version', { ...base, schemaVersion: 'future' }, 'unknown-version'],
    ['unknown-kind', { ...base, kind: 'future' }, 'unknown-kind'],
    [
      'numeric FILETIME',
      {
        ...base,
        body: { ...base.body, process: { ...identity, creationTime: 134345678901234560 } },
      },
      'invalid-string',
    ],
    ['u64 overflow', { ...base, qpcTicks: '18446744073709551616' }, 'invalid-uint64'],
    ['zero frequency', { ...base, qpcFrequency: '0' }, 'zero-counter'],
    ['invalid UTC', { ...base, utc: '2026-02-31T00:00:00.000Z' }, 'invalid-utc'],
    ['missing field', { ...base, body: {} }, 'missing-field'],
    ['wrong launch', { ...base, launchId: 'other' }, 'collection-mismatch'],
    ['unknown writer', { ...base, writerId: 'other' }, 'unregistered-writer'],
    ['missing first sequence', { ...base, seq: '2' }, 'missing-handshake'],
  ])('rejects %s', (_label, record, code) => {
    const result = decodeBoundaryJournal(raw(record), options);
    expect(result.integrity).toBe(false);
    expect(codes(result)).toContain(code);
    expect(result.frames).toHaveLength(0);
  });
  it('detects corruption and preserves only the preceding valid prefix', () => {
    const good = encodeBoundaryFrame(base);
    const bad = Buffer.from(journal().subarray(good.length));
    bad[bad.length - 1] ^= 1;
    const result = decodeBoundaryJournal(Buffer.concat([good, bad]), options);
    expect(result.consumedBytes).toBe(good.length);
    expect(result.frames).toHaveLength(1);
    expect(codes(result)).toContain('checksum-mismatch');
  });
  it.each([1, 3, 10, 31])('detects a truncated terminal frame (%i bytes lost)', (lost) => {
    const bytes = journal();
    const result = decodeBoundaryJournal(bytes.subarray(0, bytes.length - lost), options);
    expect(result.completeness).toBe(false);
    expect(codes(result)).toContain('truncated-frame');
    expect(result.frames).toHaveLength(1);
  });
  it('detects missing last record and a completely missing registered child', () => {
    const result = decodeBoundaryJournal(encodeBoundaryFrame(base), {
      ...options,
      expectedWriterIds: ['root', 'child'],
    });
    expect(codes(result)).toEqual(['missing-seal', 'missing-writer']);
  });
  it('rejects an oversized length before reading or allocating its body', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_BOUNDARY_FRAME);
    expect(codes(decodeBoundaryJournal(header, options))).toContain('frame-limit');
  });
  it('rejects duplicate keys instead of accepting the last version silently', () => {
    const payload = Buffer.from(
      JSON.stringify(base).replace('"schemaVersion":', '"schemaVersion":"future","schemaVersion":'),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    const result = decodeBoundaryJournal(
      Buffer.concat([header, payload, Buffer.from(sha(payload), 'hex')]),
      options,
    );
    expect(codes(result)).toContain('noncanonical-json');
    expect(result.frames).toHaveLength(0);
  });
  it('rejects missing middle sequence and duplicate sequence', () => {
    const next = {
      ...base,
      seq: '3',
      kind: 'attempt-begin',
      body: { callId: 'call', attemptId: 'attempt' },
    };
    for (const seq of ['1', '3']) {
      const result = decodeBoundaryJournal(
        Buffer.concat([encodeBoundaryFrame(base), encodeBoundaryFrame({ ...next, seq })]),
        options,
      );
      expect(codes(result)).toContain('sequence-gap');
    }
  });
  it('does not admit a forged seal even when the frame checksum is valid', () => {
    const bytes = journal();
    const first = encodeBoundaryFrame(base).length;
    const result = decodeBoundaryJournal(bytes, options);
    const forged = {
      ...result.frames[1],
      body: { ...result.frames[1].body, sha256: 'b'.repeat(64) },
    };
    expect(
      codes(
        decodeBoundaryJournal(
          Buffer.concat([bytes.subarray(0, first), encodeBoundaryFrame(forged)]),
          options,
        ),
      ),
    ).toContain('seal-mismatch');
  });
  it('keeps loss sticky even with a complete seal and zero reported drops', () => {
    const loss = {
      ...base,
      seq: '2',
      kind: 'loss',
      body: { reason: 'write-failed', api: 'WriteFile', code: 5 },
    };
    const result = decodeBoundaryJournal(journal([base, loss]), options);
    expect(result.integrity).toBe(true);
    expect(result.completeness).toBe(false);
    expect(codes(result)).toContain('reported-loss');
  });
  it('rejects late records after sealing rather than repairing a verdict', () => {
    const late = {
      ...base,
      seq: '3',
      kind: 'attempt-begin',
      body: { callId: 'call', attemptId: 'attempt' },
    };
    expect(
      codes(decodeBoundaryJournal(Buffer.concat([journal(), encodeBoundaryFrame(late)]), options)),
    ).toContain('after-seal');
  });
  it('supports independently sequenced writers with separate seals', () => {
    const child = {
      ...base,
      writerId: 'child',
      body: {
        ...base.body,
        parentWriterId: 'root',
        process: { ...identity, pid: 43, helperInstanceId: 'child' },
      },
    };
    const result = decodeBoundaryJournal(Buffer.concat([journal(), journal([child])]), {
      ...options,
      expectedWriterIds: ['root', 'child'],
    });
    expect(result.completeness).toBe(true);
    expect(result.sourceAvailable).toBe(false);
  });
  it.each([undefined, [], 42, ['root', 'root']])(
    'refuses invalid independent writer registration (%j)',
    (expectedWriterIds) => {
      const result = decodeBoundaryJournal(journal(), { ...options, expectedWriterIds });
      expect(codes(result)).toContain('invalid-registration');
      expect(result.integrity).toBe(false);
    },
  );
});
