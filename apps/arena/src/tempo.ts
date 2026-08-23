import { readFileSync } from 'node:fs';
import { TICKS_PER_SECOND } from '@td/shared';
import type { ThinRecord } from '@td/shared';

/**
 * Темп записанного матча: шёл ли он вовремя.
 *
 * Запись сама по себе безвременна — в ней номера тиков и команды,
 * — и по ней видно, что случилось, но не видно, вовремя ли.
 * Отметка `atMs` рядом с контрольной суммой это исправляет: суммы
 * снимаются раз в игровую секунду, значит между двумя соседними
 * обязана пройти секунда реального времени. Всё, что сверх, —
 * отставание сервера, и оно ровно то, что игрок видит рывком.
 *
 * Читается это без всякого хранилища метрик: файл записи и есть
 * источник. Приборы `/metrics` отвечают на вопрос «как идёт сейчас»,
 * а здесь — «как шёл тот матч», и второе нельзя получить из первого
 * постфактум.
 */

export interface TempoStep {
  readonly tick: number;
  /** Сколько игрового времени прошло от предыдущей отметки, мс. */
  readonly expectedMs: number;
  /** Сколько прошло реального. */
  readonly actualMs: number;
}

export interface Tempo {
  readonly steps: readonly TempoStep[];
  /** Отметок в записи не оказалось: она снята до их появления. */
  readonly timed: boolean;
}

export const tempoOf = (records: readonly ThinRecord[]): Tempo => {
  const stamps: { tick: number; atMs: number }[] = [];

  for (const record of records) {
    if (record.t !== 'sum' || record.atMs === undefined) continue;
    stamps.push({ tick: record.tick, atMs: record.atMs });
  }

  const steps: TempoStep[] = [];
  for (let index = 1; index < stamps.length; index += 1) {
    const previous = stamps[index - 1];
    const current = stamps[index];
    if (previous === undefined || current === undefined) continue;

    steps.push({
      tick: current.tick,
      expectedMs: ((current.tick - previous.tick) / TICKS_PER_SECOND) * 1000,
      actualMs: current.atMs - previous.atMs,
    });
  }

  return { steps, timed: stamps.length > 0 };
};

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0);

export const printTempo = (path: string): void => {
  const records = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ThinRecord);

  const tempo = tempoOf(records);

  if (!tempo.timed) {
    process.stdout.write(
      'В этой записи нет отметок времени: она снята до их появления.\n' +
        'Темп по ней восстановить нельзя — только состав событий.\n',
    );
    return;
  }

  if (tempo.steps.length === 0) {
    process.stdout.write('Отметка всего одна: мерить промежуток не от чего.\n');
    return;
  }

  const drifts = tempo.steps.map((step) => step.actualMs - step.expectedMs);
  const sorted = [...drifts].sort((a, b) => a - b);
  const late = tempo.steps.filter((step) => step.actualMs > step.expectedMs * 1.1);

  process.stdout.write(
    `отметок: ${String(tempo.steps.length + 1)}, промежутков: ${String(tempo.steps.length)}\n` +
      `отставание за промежуток: медиана ${percentile(sorted, 0.5).toFixed(0)} мс, ` +
      `p95 ${percentile(sorted, 0.95).toFixed(0)}, ` +
      `наибольшее ${Math.max(...drifts).toFixed(0)}\n` +
      `промежутков длиннее ожидаемого более чем на десятую: ${String(late.length)} ` +
      `из ${String(tempo.steps.length)}\n`,
  );

  if (late.length === 0) return;

  process.stdout.write('\nхудшие промежутки:\n');
  for (const step of [...late].sort((a, b) => b.actualMs - a.actualMs).slice(0, 10)) {
    process.stdout.write(
      `  к тику ${String(step.tick).padStart(6)}: ожидалось ${step.expectedMs.toFixed(0)} мс, ` +
        `прошло ${step.actualMs.toFixed(0)}\n`,
    );
  }
};
