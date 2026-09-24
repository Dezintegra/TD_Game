import { describe, expect, it, vi } from 'vitest';
import { ensureDeployHost, probeHost, startInstance, waitForHost } from './ensure-deploy-host.mjs';

const ok = { status: 0 };
const fail = { status: 255 };

describe('проба связи', () => {
  it('отвечает да только на нулевом коде и без ошибки запуска', () => {
    expect(probeHost('dezintegra', { run: () => ok })).toBe(true);
    expect(probeHost('dezintegra', { run: () => fail })).toBe(false);
    expect(probeHost('dezintegra', { run: () => ({ error: new Error('нет ssh') }) })).toBe(false);
  });

  it('зовёт ssh с батч-режимом и сроком связи', () => {
    const run = vi.fn(() => ok);
    probeHost('dezintegra', { run });
    expect(run.mock.calls[0][0]).toBe('ssh');
    expect(run.mock.calls[0][1]).toContain('BatchMode=yes');
    expect(run.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });
});

describe('подъём машины', () => {
  it('не даёт облачной утилите читать ввод: спросившая упрётся в конец файла', () => {
    const run = vi.fn(() => ok);
    startInstance('td', { run });
    expect(run.mock.calls[0][0]).toBe('yc');
    expect(run.mock.calls[0][2].stdio[0]).toBe('ignore');
    expect(run.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });

  it('снятие по сроку объясняет протухший токен, а не молчит', () => {
    // 25.08.2026 при протухшем токене утилита молча ждала браузерной
    // авторизации и держала этап до снятия по таймауту. Отказ обязан быть
    // быстрым и с названной причиной.
    const result = startInstance('td', { run: () => ({ error: { code: 'ETIMEDOUT' } }) });
    expect(result.ok).toBe(false);
    expect(result.why).toContain('протухший токен');
  });

  it('ненулевой код передаёт причину из вывода утилиты', () => {
    const result = startInstance('td', {
      run: () => ({ status: 1, stderr: 'instance not found' }),
    });
    expect(result.ok).toBe(false);
    expect(result.why).toContain('instance not found');
  });
});

describe('ожидание готовности', () => {
  it('возвращает да, как только машина ответила', async () => {
    let calls = 0;
    const run = () => (++calls >= 3 ? ok : fail);
    const sleep = vi.fn(async () => {});
    await expect(waitForHost('dezintegra', { run, sleep })).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it('сдаётся по истечении срока, а не ждёт вечно', async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      waitForHost('dezintegra', { run: () => fail, sleep, deadlineMs: 0 }),
    ).resolves.toBe(false);
  });
});

describe('весь ход подготовки', () => {
  it('отвечающую машину не трогает вовсе', async () => {
    const run = vi.fn(() => ok);
    const result = await ensureDeployHost({ run, log: () => {} });
    expect(result).toEqual({ ok: true, started: false });
    expect(run.mock.calls.every((call) => call[0] === 'ssh')).toBe(true);
  });

  it('погашенную поднимает и дожидается', async () => {
    let probes = 0;
    const run = vi.fn((cmd) => {
      if (cmd === 'yc') return ok;
      return ++probes >= 2 ? ok : fail;
    });
    const result = await ensureDeployHost({ run, sleep: async () => {}, log: () => {} });
    expect(result).toEqual({ ok: true, started: true });
    expect(run.mock.calls.some((call) => call[0] === 'yc')).toBe(true);
  });

  it('не поднявшуюся называет причиной, а не молчанием', async () => {
    const run = vi.fn((cmd) => (cmd === 'yc' ? ok : fail));
    const result = await ensureDeployHost({
      run,
      sleep: async () => {},
      deadlineMs: 0,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.why).toContain('не отвечает');
  });

  it('протухший токен облака отменяет подготовку сразу, не дожидаясь готовности', async () => {
    const run = vi.fn((cmd) => (cmd === 'yc' ? { error: { code: 'ETIMEDOUT' } } : fail));
    const result = await ensureDeployHost({ run, sleep: async () => {}, log: () => {} });
    expect(result).toMatchObject({ ok: false, started: false });
    expect(result.why).toContain('протухший токен');
    // Проб связи после отказа облака быть не должно: ждать нечего.
    expect(run.mock.calls.filter((call) => call[0] === 'ssh')).toHaveLength(1);
  });
});
