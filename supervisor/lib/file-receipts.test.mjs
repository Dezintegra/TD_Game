import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createIo } from './io.mjs';
import { resolveConfig } from '../config/defaults.mjs';

const directories = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
it('temporarily supports receipt replay in the legacy file adapter', () => {
  const base = join(import.meta.dirname, '../../.matchlog');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'file-receipt-'));
  directories.push(root);
  const { config } = resolveConfig({});
  const open = () => {
    const io = createIo({ root, config, now: '2026-09-06T00:00:00Z', run: () => ({ code: 1 }) });
    io.commitAndPush = () => ({ ok: true, outcome: 'pushed' });
    return io;
  };
  const io = open();
  const expected = { id: '0001-task', status: 'implement', spentUsd: 4, history: [] };
  io.writeTask(expected);
  const task = { ...expected, status: 'pr', spentUsd: 7 };
  const entry = { at: io.now, from: 'implement', to: 'pr', what: 'finished' };
  const operation = { key: 'launch-save', expected };
  expect(io.saveTask(task, entry, 'save', [], operation).ok).toBe(true);
  const journal = io.readJournal(task.id);
  const reopened = open();
  expect(reopened.saveTask(task, entry, 'save', [], operation).ok).toBe(true);
  expect(reopened.readJournal(task.id)).toBe(journal);
  expect(reopened.readTask(task.id)).toMatchObject({ status: 'pr', spentUsd: 7 });
  expect(
    reopened.saveTask(task, entry, 'save', [], { key: 'other-launch', expected }),
  ).toMatchObject({ outcome: 'conflict' });
});
