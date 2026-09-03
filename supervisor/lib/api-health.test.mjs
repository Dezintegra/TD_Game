import { describe, expect, it } from 'vitest';
import { judgeProbe, nextDelaySeconds, shouldProbe } from './api-health.mjs';

const SCHEDULE = [60, 120, 240, 480, 900];

describe('расписание проб', () => {
  it('задержки идут по порядку', () => {
    expect(nextDelaySeconds(0, SCHEDULE)).toBe(60);
    expect(nextDelaySeconds(1, SCHEDULE)).toBe(120);
    expect(nextDelaySeconds(3, SCHEDULE)).toBe(480);
  });

  it('последняя задержка повторяется без предела', () => {
    // Предела попыток нет намеренно: исчерпав его, автомат должен был бы
    // что-то сделать, а разбудить человека нечем. Возврат к началу дал бы
    // частые пробы там, где сервер лежит часами.
    expect(nextDelaySeconds(4, SCHEDULE)).toBe(900);
    expect(nextDelaySeconds(40, SCHEDULE)).toBe(900);
  });

  it('пустое расписание не роняет счёт', () => {
    expect(nextDelaySeconds(0, [])).toBe(60);
    expect(nextDelaySeconds(7, undefined)).toBe(60);
  });
});

describe('пора ли пробовать', () => {
  it('без отказов не пробуем вовсе', () => {
    const verdict = shouldProbe({ apiErrors: 0, threshold: 1, schedule: SCHEDULE });
    expect(verdict.probe).toBe(false);
  });

  it('порог достигнут — пробуем, ещё не взводя паузу', () => {
    const verdict = shouldProbe({ apiErrors: 1, threshold: 1, schedule: SCHEDULE });
    expect(verdict.probe).toBe(true);
    expect(verdict.why).toContain('1');
  });

  it('порог выше числа отказов — не пробуем', () => {
    expect(shouldProbe({ apiErrors: 1, threshold: 3, schedule: SCHEDULE }).probe).toBe(false);
  });

  it('под свежей паузой пробуем сразу: отметки прошлой пробы ещё нет', () => {
    const verdict = shouldProbe({ armed: true, lastProbeAt: null, schedule: SCHEDULE });
    expect(verdict.probe).toBe(true);
  });

  it('под паузой до срока не пробуем и говорим, сколько ждать', () => {
    const verdict = shouldProbe({
      armed: true,
      now: 30_000,
      lastProbeAt: 0,
      attempt: 0,
      schedule: SCHEDULE,
    });
    expect(verdict.probe).toBe(false);
    expect(verdict.waitSeconds).toBe(30);
  });

  it('срок наступил — пробуем', () => {
    const verdict = shouldProbe({
      armed: true,
      now: 61_000,
      lastProbeAt: 0,
      attempt: 0,
      schedule: SCHEDULE,
    });
    expect(verdict.probe).toBe(true);
  });

  it('задержка растёт с каждой пробой: срок второй наступает позже', () => {
    const second = shouldProbe({
      armed: true,
      now: 61_000,
      lastProbeAt: 0,
      attempt: 1,
      schedule: SCHEDULE,
    });
    expect(second.probe).toBe(false);
    expect(second.waitSeconds).toBe(59);
  });
});

describe('что делать с паузой', () => {
  it('сервер не отвечает, паузы нет — взвести', () => {
    const verdict = judgeProbe({ armed: false, ok: false, status: 529 });
    expect(verdict.verdict).toBe('arm');
    expect(verdict.why).toContain('529');
  });

  it('сервер отвечает, паузы нет — не взводить вовсе', () => {
    // Самый ценный случай: одиночный отказ обходится в долю цента вместо
    // целого промежутка между оборотами.
    expect(judgeProbe({ armed: false, ok: true }).verdict).toBe('idle');
  });

  it('сервер ответил под паузой — снять', () => {
    expect(judgeProbe({ armed: true, ok: true }).verdict).toBe('lift');
  });

  it('сервер молчит под паузой — держать', () => {
    const verdict = judgeProbe({ armed: true, ok: false, status: 529 });
    expect(verdict.verdict).toBe('hold');
    expect(verdict.why).toContain('529');
  });

  it('состояние неизвестно — причина всё равно называется', () => {
    expect(judgeProbe({ armed: true, ok: false }).why).toContain('без состояния');
  });
});
