import { describe, expect, it } from 'vitest';
import { classifyToolControls } from './stage-tool-health.mjs';

const context = {
  provider: 'codex',
  cwd: 'workspace',
  environmentId: 'env',
  permissionsId: 'policy',
};
const controls = [
  { id: 'child', invocationId: 'probe-1', argv: ['node', 'probe.mjs'], marker: 'ready' },
];
const fact = (patch = {}) => ({
  checkId: 'child',
  invocationId: 'probe-1',
  argv: controls[0].argv,
  context,
  eventId: 'event-1',
  sequence: 0,
  startedAt: 1,
  finishedAt: 2,
  kind: 'exit',
  completed: true,
  exitCode: 0,
  output: 'ready',
  ...patch,
});
const verdict = (facts, selected = controls) =>
  classifyToolControls({ context, controls: selected, facts }).verdict;

describe('independent tool evidence', () => {
  it('requires successful controls, not an agent claim or prior fetch/merge', () => {
    expect(verdict([fact()])).toBe('healthy');
    expect(verdict([])).toBe('inconclusive');
    expect(
      verdict([
        { command: 'git fetch', exitCode: 0 },
        { output: 'EPERM SSH broken', permission_denials: [] },
      ]),
    ).toBe('inconclusive');
    expect(verdict([fact({ exitCode: 1, output: 'any prose' })])).toBe('confirmed');
  });
  it('confirms two pre-creation control failures and subsequent recovery', () => {
    for (const errorCode of ['EPERM', 'UNKNOWN']) {
      expect(verdict([fact({ kind: 'spawn-error', created: false, errorCode })])).toBe('confirmed');
    }
    expect(verdict([fact()])).toBe('healthy');
  });
  it.each([
    { context: { ...context, cwd: 'other' } },
    { context: { ...context, permissionsId: 'unrestricted' } },
    { context: null },
    { invocationId: 'task-command' },
    { argv: ['npm', 'test'] },
    { eventId: null },
    { sequence: -1 },
    { completed: false },
    { output: 'wrong marker' },
    { kind: 'spawn-error', created: false },
    { kind: 'spawn-error', created: true, errorCode: 'EPERM' },
  ])('does not certify malformed or unrelated evidence: %j', (patch) => {
    expect(verdict([fact(patch)])).toBe('inconclusive');
  });
  it('does not accept duplicate, contradictory events', () => {
    expect(verdict([fact(), fact({ exitCode: 1 })])).toBe('inconclusive');
  });
  it('does not treat a ref rejection as transport failure', () => {
    expect(verdict([fact({ exitCode: 1 })], [{ ...controls[0], capability: 'push' }])).toBe(
      'inconclusive',
    );
  });
  it('ignores SSH facts when SSH is not a required control', () => {
    expect(verdict([fact(), fact({ checkId: 'ssh', exitCode: 1 })])).toBe('healthy');
  });
});
