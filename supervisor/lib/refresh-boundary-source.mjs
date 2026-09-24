import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import schema from '../instrumentation/codex-refresh/schema.json' with { type: 'json' };

export const REFRESH_BOUNDARY_SCHEMA = 'refresh-boundary/v1';
export const MAX_BOUNDARY_FRAME = 256 * 1024;
export const MAX_BOUNDARY_BYTES = 10 * 1024 * 1024;
export const BOUNDARY_TERMINAL_RESERVE = 64 * 1024;
const MAX_U64 = 18446744073709551615n;
const variants = new Map(schema.oneOf.map((entry) => [entry.properties.kind.const, entry]));
const hash = (value) => createHash('sha256').update(value).digest();
const own = (value, key) => Object.hasOwn(value, key);
const fail = (code) => {
  throw new Error(code);
};

// This deliberately implements only the keywords used by the shipped schema.
// It never includes input values/property names in diagnostics.
function check(value, rule, project = false) {
  if (rule.$ref) return check(value, schema.$defs[rule.$ref.slice(8)], project);
  if (rule.oneOf) {
    const results = [];
    for (const candidate of rule.oneOf) {
      try {
        results.push(check(value, candidate, project));
      } catch {
        /* another variant */
      }
    }
    if (results.length !== 1) fail('invalid-variant');
    return results[0];
  }
  if (own(rule, 'const') && value !== rule.const) fail('invalid-constant');
  if (rule.enum && !rule.enum.includes(value)) fail('invalid-enum');
  if (rule.type === 'null' && value !== null) fail('invalid-null');
  if (rule.type === 'boolean' && typeof value !== 'boolean') fail('invalid-boolean');
  if (
    rule.type === 'integer' &&
    (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)
  )
    fail('invalid-integer');
  if (rule.type === 'string') {
    if (typeof value !== 'string' || (rule.maxLength && value.length > rule.maxLength))
      fail('invalid-string');
    if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)) fail('invalid-string');
    if (rule.format === 'uint64' && BigInt(value) > MAX_U64) fail('invalid-uint64');
    if (
      rule.format === 'utc' &&
      (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value)
    )
      fail('invalid-utc');
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length > rule.maxItems) fail('invalid-array');
    return value.map((entry) => check(entry, rule.items, project));
  }
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-object');
    if (!project && Object.keys(value).some((key) => !own(rule.properties, key)))
      fail('unknown-field');
    const result = {};
    for (const key of rule.required) {
      if (!own(value, key)) fail('missing-field');
      result[key] = check(value[key], rule.properties[key], project);
    }
    return result;
  }
  return value;
}

function admitted(value, project = false) {
  if (value?.schemaVersion !== REFRESH_BOUNDARY_SCHEMA) fail('unknown-version');
  const variant = variants.get(value.kind);
  if (!variant) fail('unknown-kind');
  const clean = check(value, variant, project);
  if (clean.qpcFrequency === '0' || clean.seq === '0') fail('zero-counter');
  return clean;
}

// Test/adapter encoder. Enumerates only schema fields, so unknown getters and
// payload/argv properties are not read or serialized. Not a native writer.
export function encodeBoundaryFrame(value) {
  const clean = admitted(value, true);
  const payload = Buffer.from(JSON.stringify(clean));
  if (payload.length + 36 > MAX_BOUNDARY_FRAME) fail('frame-limit');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length);
  return Buffer.concat([length, payload, hash(payload)]);
}

/** Decode a bounded journal snapshot without file/process/collector side effects.
 * expectedWriterIds comes from the collector's independently registered writers.
 * Transport completeness alone never establishes provenance or token-at-call.
 */
export function decodeBoundaryJournal(bytes, { expectedWriterIds, collectionId, launchId } = {}) {
  const frames = [];
  const reasons = [];
  const writers = new Map();
  let offset = 0;
  let integrity = true;
  const reject = (code) => {
    reasons.push({ code, offset });
    integrity = false;
  };
  if (!Buffer.isBuffer(bytes)) fail('buffer-required');
  try {
    check(collectionId, schema.$defs.id);
    check(launchId, schema.$defs.id);
    if (
      !Array.isArray(expectedWriterIds) ||
      !expectedWriterIds.length ||
      expectedWriterIds.length > 256 ||
      new Set(expectedWriterIds).size !== expectedWriterIds.length
    )
      fail('invalid-writer-registration');
    for (const id of expectedWriterIds) check(id, schema.$defs.id);
  } catch {
    reject('invalid-registration');
  }
  const expected = new Set(Array.isArray(expectedWriterIds) ? expectedWriterIds : []);
  while (integrity && offset < bytes.length) {
    try {
      if (bytes.length - offset < 4) fail('truncated-length');
      const length = bytes.readUInt32LE(offset);
      const frameLength = length + 36;
      if (frameLength > MAX_BOUNDARY_FRAME || length === 0) fail('frame-limit');
      if (offset + frameLength > MAX_BOUNDARY_BYTES) fail('volume-limit');
      if (offset + frameLength > bytes.length) fail('truncated-frame');
      const payload = bytes.subarray(offset + 4, offset + 4 + length);
      if (!hash(payload).equals(bytes.subarray(offset + 4 + length, offset + frameLength)))
        fail('checksum-mismatch');
      let value;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
      } catch {
        fail('invalid-json');
      }
      if (!payload.equals(Buffer.from(JSON.stringify(value)))) fail('noncanonical-json');
      const frame = admitted(value);
      if (frame.collectionId !== collectionId || frame.launchId !== launchId)
        fail('collection-mismatch');
      if (!expected.has(frame.writerId)) fail('unregistered-writer');
      let writer = writers.get(frame.writerId);
      if (!writer) {
        if (frame.kind !== 'handshake' || frame.seq !== '1') fail('missing-handshake');
        writer = { seq: 0n, digest: createHash('sha256'), sealed: false };
        writers.set(frame.writerId, writer);
      } else if (frame.kind === 'handshake') fail('duplicate-handshake');
      if (writer.sealed) fail('after-seal');
      if (BigInt(frame.seq) !== writer.seq + 1n) fail('sequence-gap');
      if (
        !['seal', 'loss'].includes(frame.kind) &&
        offset + frameLength > MAX_BOUNDARY_BYTES - BOUNDARY_TERMINAL_RESERVE
      )
        fail('terminal-reserve');
      if (frame.kind === 'seal') {
        if (
          frame.body.count !== writer.seq.toString() ||
          frame.body.finalSeq !== writer.seq.toString() ||
          frame.body.sha256 !== writer.digest.copy().digest('hex')
        )
          fail('seal-mismatch');
        writer.sealed = true;
        if (frame.body.status !== 'complete' || frame.body.dropped !== '0')
          reasons.push({ code: 'writer-incomplete', offset });
      } else {
        writer.digest.update(bytes.subarray(offset, offset + frameLength));
      }
      if (frame.kind === 'loss') reasons.push({ code: 'reported-loss', offset });
      writer.seq = BigInt(frame.seq);
      frames.push(frame);
      offset += frameLength;
    } catch (error) {
      // Codes originate exclusively in this module, never native exception text.
      const known = new Set([
        'frame-limit',
        'volume-limit',
        'truncated-length',
        'truncated-frame',
        'checksum-mismatch',
        'invalid-json',
        'noncanonical-json',
        'unknown-version',
        'unknown-kind',
        'unknown-field',
        'missing-field',
        'invalid-variant',
        'invalid-constant',
        'invalid-enum',
        'invalid-null',
        'invalid-boolean',
        'invalid-integer',
        'invalid-string',
        'invalid-uint64',
        'invalid-utc',
        'invalid-array',
        'invalid-object',
        'zero-counter',
        'collection-mismatch',
        'unregistered-writer',
        'missing-handshake',
        'duplicate-handshake',
        'after-seal',
        'sequence-gap',
        'terminal-reserve',
        'seal-mismatch',
      ]);
      reject(known.has(error.message) ? error.message : 'invalid-frame');
    }
  }
  for (const id of expected) {
    if (!writers.has(id)) reasons.push({ code: 'missing-writer', offset });
    else if (!writers.get(id).sealed) reasons.push({ code: 'missing-seal', offset });
  }
  return {
    frames,
    consumedBytes: offset,
    integrity,
    completeness: integrity && reasons.length === 0,
    causalSufficiency: false,
    sourceAvailable: false,
    allowNextInvocation: false,
    acceptanceReason: 'causal-and-provenance-validation-pending',
    reasons,
  };
}
