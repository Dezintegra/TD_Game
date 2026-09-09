import { writeFileSync } from 'node:fs';
import { beforeEach, afterEach } from 'vitest';
import { getFn, setFn } from '@vitest/runner';
import * as shared from '@td/shared';
import * as rules from '../../packages/shared/src/rules.js';
import * as balance from '../../packages/shared/src/balance.js';

const descriptor = JSON.parse(process.env.TD_MUTATION_DESCRIPTOR!);
const evidence = {
  runId: descriptor.runId,
  phase: descriptor.phase,
  pairKey: descriptor.pairKey,
  bodyEntered: false,
  bodyExited: false,
  assertionFailure: false,
  sharedVerified:
    shared.ruleTuning === rules.ruleTuning && shared.STRUCTURE_STATS === balance.STRUCTURE_STATS,
  tuningVerified: false,
  derivedChanged: false,
  error: '',
  neutralValue: 0,
  appliedValue: 0,
  tuning: {},
};
const save = () => writeFileSync(descriptor.evidencePath, JSON.stringify(evidence));
const probe = () =>
  ({
    baseHealth: shared.STRUCTURE_STATS[shared.StructureKind.Base].health,
    towerHealth: shared.STRUCTURE_STATS[shared.StructureKind.TowerSniper].health,
    income: shared.BASE_INCOME_PER_TICK,
    speed: shared.BASE_SPEED_UNITS_PER_TICK,
    unitRadius: shared.UNIT_SEPARATION_RADIUS[shared.UnitType.Assault],
    map: shared.MAP_WIDTH_CELLS,
  })[descriptor.pair.probe as 'baseHealth'];

if (!shared.ruleTuningIsNeutral()) throw new Error('Initial tuning is not neutral');
evidence.neutralValue = probe();
shared.applyRuleTuning(descriptor.tuning);
evidence.appliedValue = probe();
evidence.derivedChanged = evidence.appliedValue !== evidence.neutralValue;
evidence.tuning = { ...shared.ruleTuning() };
const expected = JSON.stringify(shared.ruleTuning());
function verify() {
  if (
    !evidence.sharedVerified ||
    shared.ruleTuning !== rules.ruleTuning ||
    shared.STRUCTURE_STATS !== balance.STRUCTURE_STATS ||
    JSON.stringify(shared.ruleTuning()) !== expected ||
    probe() !== evidence.appliedValue ||
    (descriptor.phase === 'mutant' && !evidence.derivedChanged)
  ) {
    evidence.error = 'Tuning, shared identity or derived value changed unexpectedly';
    save();
    throw new Error(evidence.error);
  }
}
save();
verify();

beforeEach(({ task }) => {
  verify();
  const fn = getFn(task);
  if (!fn) throw new Error('Test body unavailable');
  // Оборачивается именно тело, после beforeEach и до afterEach тестового файла.
  setFn(task, async () => {
    verify();
    evidence.bodyEntered = true;
    save();
    try {
      await fn();
    } catch (error) {
      evidence.assertionFailure = error instanceof Error && error.name === 'AssertionError';
      throw error;
    } finally {
      evidence.bodyExited = true;
      verify();
      save();
    }
  });
});

afterEach(() => {
  try {
    verify();
    evidence.tuningVerified = true;
  } finally {
    save();
    shared.resetRuleTuning();
  }
});
