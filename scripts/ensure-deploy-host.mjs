#!/usr/bin/env node
/**
 * Поднять боевую машину, если облако её погасило, и дождаться готовности.
 *
 * Машина прерываемая: облако гасит её не позже чем через сутки. Прежде
 * поднимал её человек командой `yc compute instance start td`, а сессия
 * выкладки в этом случае просто отчитывалась о неудаче. С выкладкой пакетом
 * это стало дороже: пакет копится до пяти часов, и вероятность застать
 * машину погашенной выросла ровно во столько же раз.
 *
 * Прямой вызов `yc` из сессии остаётся запрещённым, и запрет обоснован:
 * при протухшем токене утилита молча ждёт браузерной авторизации и держит
 * этап до снятия по сроку (проверено 25.08.2026). Поэтому подъём вынесен
 * сюда, в один сценарий с ограниченными сроками: ожидание авторизации
 * превращается в быстрый отказ с названной причиной, а сессия зовёт
 * разрешённый сценарий вместо облачной утилиты.
 *
 * Коды возврата: 0 — машина отвечает (сама или после подъёма);
 * 1 — не удалось, причина названа в выводе.
 */
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { deploySshHost, deploySshOptions } from './deploy-ssh.mjs';

/** Сколько ждём облачную утилиту. Больше минуты она честно работать не должна. */
export const CLOUD_TIMEOUT_MS = 60_000;
/** Сколько всего ждём готовности хоста после запуска. */
export const READY_TIMEOUT_MS = 180_000;
/** Пауза между пробами связи. */
export const PROBE_INTERVAL_MS = 10_000;

const say = (text) => console.log(`  ${text}`);

/**
 * Одна проба связи. Ответ вместо исключения: недоступность здесь — обычное
 * дело, ради которого сценарий и написан.
 */
export function probeHost(host, { run = spawnSync } = {}) {
  const result = run('ssh', [...deploySshOptions(), '--', host, 'true'], {
    stdio: 'ignore',
    timeout: 30_000,
  });
  return !result.error && result.status === 0;
}

/**
 * Позвать облако. Возвращает `{ ok, why }`, а не бросает: причина отказа
 * нужна вызывающему словами, и «утилита ждала авторизации» — самая важная
 * из них.
 */
export function startInstance(instance, { run = spawnSync, timeout = CLOUD_TIMEOUT_MS } = {}) {
  const result = run('yc', ['compute', 'instance', 'start', instance, '--no-user-output'], {
    encoding: 'utf8',
    timeout,
    // Стандартный ввод закрыт намеренно: утилита, решившая спросить,
    // получит конец файла и упадёт, а не встанет ждать навсегда.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal)
    return {
      ok: false,
      why:
        `облачная утилита не ответила за ${Math.round(timeout / 1000)} с и снята. ` +
        'Чаще всего это протухший токен: она ждёт браузерной авторизации. ' +
        'Обновите учётные данные облака и повторите выкладку',
    };
  if (result.error) return { ok: false, why: `не удалось запустить yc: ${result.error.message}` };
  if (result.status !== 0)
    return {
      ok: false,
      why: `yc завершился с кодом ${result.status}: ${String(result.stderr ?? '').trim()}`,
    };
  return { ok: true };
}

/** Ждать готовности, пока не кончится отведённое время. */
export async function waitForHost(
  host,
  { run = spawnSync, sleep, deadlineMs = READY_TIMEOUT_MS, intervalMs = PROBE_INTERVAL_MS } = {},
) {
  const pause = sleep ?? wait;
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (probeHost(host, { run })) return true;
    if (Date.now() >= until) return false;
    await pause(intervalMs);
  }
}

export async function ensureDeployHost({
  host = deploySshHost(process.env.TD_DEPLOY_HOST ?? 'dezintegra'),
  instance = process.env.TD_DEPLOY_INSTANCE ?? 'td',
  run = spawnSync,
  sleep,
  deadlineMs = READY_TIMEOUT_MS,
  log = say,
} = {}) {
  if (probeHost(host, { run })) {
    log(`машина «${host}» отвечает, поднимать нечего`);
    return { ok: true, started: false };
  }
  log(`машина «${host}» не отвечает — поднимаю «${instance}»`);
  const started = startInstance(instance, { run });
  if (!started.ok) return { ok: false, started: false, why: started.why };
  const ready = await waitForHost(host, { run, sleep, deadlineMs });
  return ready
    ? { ok: true, started: true }
    : {
        ok: false,
        started: true,
        why:
          `машина «${instance}» запущена, но «${host}» не отвечает ` +
          `за ${Math.round(deadlineMs / 1000)} с`,
      };
}

// Запуск как сценария. При импорте из теста ничего не делаем.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const result = await ensureDeployHost();
  if (!result.ok) {
    console.error(`\n  Не удалось подготовить машину: ${result.why}\n`);
    process.exit(1);
  }
  if (result.started) say('машина поднята и отвечает');
  process.exit(0);
}
