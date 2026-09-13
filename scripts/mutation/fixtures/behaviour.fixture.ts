import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ruleTuning, resetRuleTuning } from '@td/shared';

describe('fixture', () => {
  it('assertion', () => {
    expect(ruleTuning().baseHealth).toBe(1);
  });
  it('survives', () => {
    expect(ruleTuning().baseHealth).toBeGreaterThan(0);
  });
  it('red control', () => {
    expect(1).toBe(2);
  });
  it.skip('skip', () => {
    expect(1).toBe(2);
  });
  it.todo('todo');
  it('reset', () => {
    resetRuleTuning();
  });
  it('timeout', () => new Promise(() => {}));
  it('crash', () => {
    process.exit(3);
  });
  describe('before hook', () => {
    beforeEach(() => {
      if (ruleTuning().baseHealth !== 1) expect(1).toBe(2);
    });
    it('assertion', () => {
      expect(ruleTuning().baseHealth).toBe(1);
    });
  });
  describe('after hook', () => {
    afterEach(() => {
      if (ruleTuning().baseHealth !== 1) expect(1).toBe(2);
    });
    it('assertion', () => {
      expect(ruleTuning().baseHealth).toBe(1);
    });
  });
});
