import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openRecipient, seedRecipient, receiptConfig } from './testing/report-recipient.mjs';
import { readReceiptComments, receiptOf } from './report-receipts.mjs';

const directories = [];
const original = {
  id: '0001-task',
  title: 'Task',
  type: 'feature',
  status: 'implement',
  statusChangedAt: '2026-09-05T00:00:00Z',
  attempts: { continuations: 2 },
  spentUsd: 4,
};
function fixture() {
  const base = join(import.meta.dirname, '../../.matchlog');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'receipt-'));
  directories.push(directory);
  const path = join(directory, 'board.json');
  seedRecipient(path, [original]);
  const recipient = openRecipient(path);
  const expected = recipient.store.readTask(original.id);
  const task = { ...expected, status: 'pr', statusChangedAt: '2026-09-06T00:00:00Z', spentUsd: 7 };
  const entry = {
    at: task.statusChangedAt,
    from: 'implement',
    to: 'pr',
    what: 'Finished',
    source: 'agent',
  };
  return { path, recipient, task, entry, operation: { key: 'launch:save:0', expected } };
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const save = (recipient, fixture) =>
  recipient.store.saveTask(fixture.task, fixture.entry, '', [], fixture.operation);

describe('recipient report receipts', () => {
  it('reconciles a created request including archived cards before another POST', async () => {
    const f = fixture();
    const task = {
      ...original,
      id: '0002-request',
      status: 'new',
      title: 'Request',
      description: 'reason',
    };
    const operation = { key: 'report:create:0' };
    f.recipient.fail('POST', 'cards', 'after');
    expect((await f.recipient.store.createTask(task, '', operation)).ok).toBe(false);
    const created = openRecipient(f.path).state().cards.at(-1);
    await f.recipient.trello.put(`cards/${created.id}`, { closed: true });
    const restarted = openRecipient(f.path);
    expect((await restarted.store.createTask(task, '', operation)).ok).toBe(true);
    expect(restarted.state()).toMatchObject({ posts: 1 });
    expect(restarted.state().cards).toHaveLength(2);
  });
  it('reserves an unused numeric id before the first creating attempt', async () => {
    const f = fixture();
    const task = { ...original, id: '0001-collision', status: 'new' };
    const reserved = await f.recipient.store.reserveReportTask(task, { key: 'create' });
    expect(reserved.ok).toBe(true);
    expect(reserved.task.id.startsWith('0002-')).toBe(true);
    expect(f.recipient.state().posts).toBe(0);
  });
  it('does not repeat an uncertain creating POST when inspection fails', async () => {
    const f = fixture();
    const task = { ...original, id: '0002-request', status: 'new' };
    const operation = { key: 'create' };
    f.recipient.fail('POST', 'cards', 'after');
    await f.recipient.store.createTask(task, '', operation);
    const restarted = openRecipient(f.path);
    restarted.fail('GET', 'boards/');
    expect((await restarted.store.createTask(task, '', operation)).ok).toBe(false);
    expect(restarted.state().posts).toBe(1);
  });
  it('reconciles amendment and question parts after lost responses', async () => {
    const f = fixture();
    const operation = { key: 'amend' };
    f.recipient.fail('POST', '/actions/comments', 'after');
    expect(
      (await f.recipient.store.amendTask(original.id, 'Evidence', '', 'agent', operation)).ok,
    ).toBe(false);
    const restarted = openRecipient(f.path);
    expect(
      (await restarted.store.amendTask(original.id, 'Evidence', '', 'agent', operation)).ok,
    ).toBe(true);
    restarted.fail('POST', '/actions/comments', 'after');
    expect((await restarted.store.askOwner(f.task, { summary: 'Choose' }, { key: 'ask' })).ok).toBe(
      false,
    );
    expect(
      (await openRecipient(f.path).store.askOwner(f.task, { summary: 'Choose' }, { key: 'ask' }))
        .ok,
    ).toBe(true);
    expect(openRecipient(f.path).state().posts).toBe(2);
  });
  it.each(['before', 'after'])('reconciles PUT %s failure across adapter restart', async (when) => {
    const f = fixture();
    f.recipient.fail('PUT', 'cards/', when);
    expect((await save(f.recipient, f)).ok).toBe(false);
    const restarted = openRecipient(f.path);
    expect((await save(restarted, f)).ok).toBe(true);
    expect(restarted.store.readTask(original.id)).toMatchObject({
      status: 'pr',
      spentUsd: 7,
      reportReceipts: [receiptOf(f.operation.key)],
    });
    expect((await save(openRecipient(f.path), f)).ok).toBe(true);
    expect(openRecipient(f.path).state()).toMatchObject({ puts: 1, posts: 1 });
  });
  it.each(['before', 'after'])('delivers missing journal after POST %s failure', async (when) => {
    const f = fixture();
    f.recipient.fail('POST', '/actions/comments', when);
    expect((await save(f.recipient, f)).ok).toBe(false);
    expect((await save(openRecipient(f.path), f)).ok).toBe(true);
    expect(openRecipient(f.path).state()).toMatchObject({ puts: 1, posts: 1 });
  });
  it('does not overwrite a newer visit without its receipt', async () => {
    const f = fixture();
    const card = f.recipient.state().cards[0];
    await f.recipient.trello.put(`cards/${card.id}`, { idList: 'list-audit' });
    expect(await save(f.recipient, f)).toMatchObject({ ok: false, outcome: 'conflict' });
    expect(f.recipient.state().posts).toBe(0);
  });
  it('waits when recipient inspection is unavailable', async () => {
    const f = fixture();
    f.recipient.fail('PUT', 'cards/', 'after');
    await save(f.recipient, f);
    const restarted = openRecipient(f.path);
    restarted.fail('GET', 'cards/');
    expect((await save(restarted, f)).ok).toBe(false);
    expect(restarted.state()).toMatchObject({ puts: 1, posts: 0 });
  });
  it('accounts for part markers within the text limit and retries without duplicates', async () => {
    const f = fixture();
    f.entry.what = 'complete journal '.repeat(3000);
    expect((await save(f.recipient, f)).ok).toBe(true);
    const before = openRecipient(f.path).state();
    expect(before.comments.length).toBeGreaterThan(1);
    expect(
      before.comments.every((item) => item.text.length <= receiptConfig.trello.maxTextLength),
    ).toBe(true);
    expect((await save(openRecipient(f.path), f)).ok).toBe(true);
    expect(openRecipient(f.path).state()).toEqual(before);
  });
  it('refuses an oversized description before PUT', async () => {
    const f = fixture();
    f.task.reportReceipts = Array.from({ length: 1000 }, (_, i) => receiptOf(String(i)));
    // Рост прежних квитанций проверяется на получателе, а не на снимке плана.
    const card = f.recipient.state().cards[0];
    const next = { ...f.operation.expected, reportReceipts: f.task.reportReceipts };
    const { joinDescription, metaOf } = await import('./card.mjs');
    await f.recipient.trello.put(`cards/${card.id}`, { desc: joinDescription('', metaOf(next)) });
    f.operation.expected = next;
    expect(await save(f.recipient, f)).toMatchObject({
      ok: false,
      why: expect.stringContaining('limit'),
    });
    expect(f.recipient.state().puts).toBe(1);
  });
  it('reads beyond the first comment page', async () => {
    const calls = [];
    const result = await readReceiptComments(
      {
        get: (path, query) => {
          calls.push(query);
          return {
            ok: true,
            data: query.before
              ? [{ id: 'last', data: { text: 'old receipt' } }]
              : Array.from({ length: 1000 }, (_, index) => ({
                  id: String(index),
                  data: { text: 'later' },
                })),
          };
        },
      },
      'card',
    );
    expect(result.comments).toHaveLength(1001);
    expect(result.comments.at(-1)).toBe('old receipt');
    expect(calls[1].before).toBe('999');
  });
});
