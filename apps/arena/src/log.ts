import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogRecord } from './records.js';

/**
 * Писатель JSONL.
 *
 * Устроен нарочито тупо: копит строки в памяти и сбрасывает порциями.
 * Никакой умной буферизации, никаких асинхронных очередей — писатель,
 * который может что-то потерять или переупорядочить, обесценивает весь
 * разбор, а выигрыш от сложности здесь измеряется миллисекундами
 * на матч, идущий минуты.
 *
 * Дописывание, а не перезапись целиком: прерванный прогон должен
 * оставлять годные первые строки. Последняя строка при этом может
 * оказаться обрезанной — сборка базы такую пропускает с предупреждением.
 */

/** Сколько записей копится до сброса на диск. */
const FLUSH_EVERY = 512;

export interface LogWriter {
  write(record: LogRecord): void;
  /** Дописать остаток. Обязателен в конце — иначе хвост не доедет. */
  close(): void;
}

export const createLogWriter = (path: string): LogWriter => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');

  let pending: string[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;

    appendFileSync(path, `${pending.join('\n')}\n`);
    pending = [];
  };

  return {
    write(record) {
      pending.push(JSON.stringify(record));
      if (pending.length >= FLUSH_EVERY) flush();
    },
    close: flush,
  };
};

/** Писатель, который ничего не пишет. Нужен прогонам без лога. */
export const NO_LOG: LogWriter = {
  write: () => undefined,
  close: () => undefined,
};
