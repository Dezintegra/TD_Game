import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Запись измеренной величины для журнала замеров.
 *
 * Замер отличается от проверки тем, что его ответ — число, а не «прошло»
 * или «упало». Порог 55 кадров говорит, что стало совсем плохо; но между
 * 61 и 56 разницы в исходе теста нет никакой, а в жизни она есть, и видна
 * она только рядом с прошлыми замерами.
 *
 * Значения пишутся в файл, а не в отчёт Playwright. Через отчёт их пришлось
 * бы доставать аннотациями, полагаясь на внутреннюю раскладку JSON, которая
 * меняется от версии к версии; файл из двух полей не меняется никогда.
 *
 * Путь приходит из `PERF_OUT`, который ставит `scripts/perf-run.mjs`.
 * Без него запись молча не ведётся: прямой прогон Playwright — это отладка,
 * и засорять журнал отладочными цифрами не нужно.
 */
export const record = (name: string, value: number): void => {
  const out = process.env['PERF_OUT'];
  if (out === undefined || out === '') return;

  mkdirSync(dirname(out), { recursive: true });
  appendFileSync(out, `${JSON.stringify({ name, value })}\n`, 'utf8');
};
