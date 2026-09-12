import { createHash } from 'node:crypto';

/** Короткая квитанция экономит место в ограниченном описании карточки. */
export const receiptOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 32);
export const hasReceipt = (task, key) => (task?.reportReceipts ?? []).includes(receiptOf(key));
export function withReceipt(task, key, previous = task) {
  return {
    ...task,
    reportReceipts: [...new Set([...(previous?.reportReceipts ?? []), receiptOf(key)])],
  };
}
export const partReceipt = (key, index) => `\n<!-- report:${receiptOf(key)}:${index} -->`;

/** История промпта ограничена; сверка доставки требует всех частей. */
export async function readReceiptComments(trello, cardId) {
  const comments = [];
  let before;
  const seen = new Set();
  while (true) {
    const page = await trello.get(`cards/${cardId}/actions`, {
      filter: 'commentCard',
      limit: 1000,
      ...(before ? { before } : {}),
    });
    if (!page.ok) return page;
    if (!Array.isArray(page.data))
      return { ok: false, kind: 'failed', why: 'invalid comment receipt response' };
    comments.push(...page.data.map((item) => item.data?.text ?? item.text ?? ''));
    if (page.data.length < 1000) return { ok: true, comments };
    const cursor = page.data.at(-1)?.id;
    if (!cursor || seen.has(cursor))
      return { ok: false, kind: 'failed', why: 'comment pagination did not advance' };
    seen.add(cursor);
    before = cursor;
  }
}
