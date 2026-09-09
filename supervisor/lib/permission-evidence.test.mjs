import { describe, expect, it } from 'vitest';
import { classifyPermissionEvidence } from './permission-evidence.mjs';

function fixture() {
  const contexts = {
    baseline: { session: 'first', tool: 'PowerShell', digest: 'original' },
    additive: { session: 'second', tool: 'PowerShell', digest: 'with-canary' },
  };
  const event = (run, toolUseId, kind, command) => ({
    ...contexts[run],
    toolUseId,
    kind,
    command,
    native: true,
    complete: true,
    exitCode: 0,
  });
  return {
    contexts,
    loading: Object.fromEntries(
      Object.entries(contexts).map(([run, context]) => [
        run,
        {
          ...context,
          provenance: 'launch-metadata',
          status: 'confirmed',
        },
      ]),
    ),
    nativeToolAvailable: true,
    complete: true,
    comparison: { onlyAdditiveDeny: true, otherSourcesUnchanged: true },
    independent: {
      baseline: event('baseline', 'read-1', 'program-result', 'read-prefix'),
      denied: event('additive', 'read-2', 'policy-denied', 'read-prefix'),
      companion: event('additive', 'read-3', 'program-result', 'read-inside'),
    },
    positive: event('baseline', 'lease', 'program-result', 'lease'),
    negative: event('baseline', 'force', 'policy-denied', 'force'),
  };
}

describe('permission evidence (synthetic normalized events, not a live probe)', () => {
  it('accepts an independently confirmed pair without mutating it', () => {
    const input = fixture();
    const before = globalThis.structuredClone(input);
    expect(classifyPermissionEvidence(input)).toMatchObject({
      settings: 'applied',
      target: 'enforced',
      verified: true,
    });
    expect(input).toEqual(before);
  });

  const cases = [
    [
      'both controls pass',
      (e) => {
        e.negative.kind = 'program-result';
      },
      'applied',
      'not-enforced',
    ],
    [
      'Git itself fails',
      (e) => {
        e.negative.kind = 'program-result';
        e.negative.exitCode = 128;
      },
      'applied',
      'not-enforced',
    ],
    [
      'known missing source',
      (e) => {
        e.loading.baseline.status = 'not-applied';
      },
      'not-applied',
      'unknown',
    ],
    [
      'unknown source',
      (e) => {
        e.loading.baseline.status = 'unknown';
      },
      'unknown',
      'unknown',
    ],
    [
      'file alone',
      (e) => {
        e.loading.baseline.provenance = 'file';
      },
      'unknown',
      'unknown',
    ],
    [
      'no native tool',
      (e) => {
        e.nativeToolAvailable = false;
      },
      'unknown',
      'unknown',
    ],
    [
      'timeout',
      (e) => {
        e.complete = false;
      },
      'unknown',
      'unknown',
    ],
    [
      'model narration',
      (e) => {
        e.independent.denied.native = false;
      },
      'unknown',
      'unknown',
    ],
    [
      'missing independent proof',
      (e) => {
        delete e.independent;
      },
      'unknown',
      'unknown',
    ],
    [
      'canary passes',
      (e) => {
        e.independent.denied.kind = 'program-result';
      },
      'unknown',
      'unknown',
    ],
    [
      'no companion',
      (e) => {
        delete e.independent.companion;
      },
      'unknown',
      'unknown',
    ],
    [
      'companion Git failure',
      (e) => {
        e.independent.companion.exitCode = 128;
      },
      'unknown',
      'unknown',
    ],
    [
      'changed sources',
      (e) => {
        e.comparison.otherSourcesUnchanged = false;
      },
      'unknown',
      'unknown',
    ],
    [
      'arbitrary minimal canary',
      (e) => {
        e.comparison.onlyAdditiveDeny = false;
      },
      'unknown',
      'unknown',
    ],
    [
      'same session',
      (e) => {
        e.contexts.additive.session = 'first';
      },
      'unknown',
      'unknown',
    ],
    [
      'positive denied',
      (e) => {
        e.positive.kind = 'policy-denied';
      },
      'applied',
      'unknown',
    ],
    [
      'positive missing',
      (e) => {
        delete e.positive;
      },
      'applied',
      'unknown',
    ],
    [
      'negative missing',
      (e) => {
        delete e.negative;
      },
      'applied',
      'unknown',
    ],
    [
      'negative narration',
      (e) => {
        e.negative.native = false;
      },
      'applied',
      'unknown',
    ],
    [
      'duplicate target event',
      (e) => {
        e.negative.toolUseId = e.positive.toolUseId;
      },
      'applied',
      'unknown',
    ],
  ];
  for (const key of ['session', 'tool', 'digest']) {
    cases.push([
      `independent ${key} mismatch`,
      (e) => {
        e.independent.denied[key] = 'other';
      },
      'unknown',
      'unknown',
    ]);
    cases.push([
      `target ${key} mismatch`,
      (e) => {
        e.negative[key] = 'other';
      },
      'applied',
      'unknown',
    ]);
    cases.push([
      `loading ${key} mismatch`,
      (e) => {
        e.loading.baseline[key] = 'other';
      },
      'unknown',
      'unknown',
    ]);
  }
  it.each(cases)('%s cannot verify the target', (_name, mutate, settings, target) => {
    const input = fixture();
    expect(classifyPermissionEvidence(input).verified).toBe(true);
    mutate(input);
    expect(classifyPermissionEvidence(input)).toMatchObject({ settings, target, verified: false });
  });
  it('does not treat an empty record as success', () => {
    expect(classifyPermissionEvidence()).toMatchObject({
      settings: 'unknown',
      target: 'unknown',
      verified: false,
    });
  });
});
