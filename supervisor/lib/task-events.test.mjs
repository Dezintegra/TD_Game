import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openTaskEvents, taskEventSummaries } from './task-events.mjs';

const roots = [];
const taskId = '0011-post-match-statistics';
const stage = 'audit';
const launchId = '7e154608-4ff5-4a32-9ed1-6e295945a8d7';
function directory() {
  const root = fs.mkdtempSync(join(tmpdir(), 'td-task-events-'));
  roots.push(root);
  return join(root, 'events');
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('keeps earlier launch actions after reopening, without requiring a finish event', () => {
  const root = directory();
  const first = openTaskEvents(root);
  const event = (at, kind, id = launchId) => ({ at, stage, launchId: id, kind });
  expect(first.append(taskId, event('2026-09-24T12:00:00Z', 'launch-start')).ok).toBe(true);
  expect(first.append(taskId, event('2026-09-24T12:00:01Z', 'action-start')).ok).toBe(true);
  const second = openTaskEvents(root);
  expect(
    second.append(
      taskId,
      event('2026-09-24T12:05:00Z', 'launch-start', 'f86645ce-82cc-4cea-b307-27d4549bb695'),
    ).ok,
  ).toBe(true);
  const rows = fs
    .readFileSync(join(root, `${taskId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  expect(rows.map((row) => row.kind)).toEqual(['launch-start', 'action-start', 'launch-start']);
  expect(rows.map((row) => row.launchId)).toEqual([
    launchId,
    launchId,
    'f86645ce-82cc-4cea-b307-27d4549bb695',
  ]);
});

it('records bounded Codex command failures but omits full output and unrelated prose', () => {
  const hugeOutput = `CreateProcess failed ${'private-output '.repeat(100)}`;
  const event = {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      id: 'action-1',
      command: `git status ${'long-argument '.repeat(100)}`,
      exit_code: 1,
      aggregated_output: hugeOutput,
    },
  };
  const summaries = taskEventSummaries('codex', event);
  expect(summaries.map((row) => row.kind)).toEqual(['action-finish', 'error']);
  expect(summaries[1].detail).toContain('CreateProcess failed');
  expect(summaries[1].detail.length).toBeLessThanOrEqual(300);
  expect(summaries[0].action.length).toBeLessThanOrEqual(180);
  expect(JSON.stringify(summaries)).not.toContain(hugeOutput);
  expect(
    taskEventSummaries('codex', {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'private assistant prose' },
    }),
  ).toEqual([]);
});

it('captures Claude tool use and error without storing a successful tool result', () => {
  const use = taskEventSummaries('claude', {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'private assistant prose' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'CLAUDE.md' } },
      ],
    },
  });
  const failure = taskEventSummaries('claude', {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          is_error: true,
          content: 'CreateProcess failed',
        },
      ],
    },
  });
  const success = taskEventSummaries('claude', {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'private result' }],
    },
  });
  expect(use).toEqual([
    { kind: 'action-start', tool: 'Read', actionId: 'tool-1', action: 'CLAUDE.md' },
  ]);
  expect(failure.map((row) => row.kind)).toEqual(['action-finish', 'error']);
  expect(success).toEqual([{ kind: 'action-finish', actionId: 'tool-2', status: 'completed' }]);
  expect(JSON.stringify([...use, ...failure, ...success])).not.toContain('private');
});

it('rejects unsafe task IDs and reports storage failures', () => {
  const root = directory();
  const entry = { at: '2026-09-24T12:00:00Z', stage, kind: 'spawn-failed', detail: 'ENOENT' };
  expect(openTaskEvents(root).append('../outside', entry)).toMatchObject({ ok: false });
  const failing = openTaskEvents(root, {
    disk: {
      ...fs,
      openSync: () => {
        throw new Error('disk full');
      },
    },
  });
  expect(failing.append(taskId, entry)).toMatchObject({ ok: false, error: 'disk full' });
  expect(fs.existsSync(join(root, `${taskId}.jsonl`))).toBe(false);
});
