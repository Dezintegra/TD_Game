import { createHistogram } from './histogram.js';
import type { Histogram, HistogramOptions, HistogramSnapshot } from './histogram.js';

/**
 * Приборы и их отдача.
 *
 * Лежат в общем пакете, а не у сервера, потому что приборы нужны
 * не одному процессу. Служба компьютерных дежурных уезжает в свой,
 * и заминка её раздумий должна быть видна там же, где происходит, —
 * иначе после переезда величины `td_ai_decision_*` просто исчезли бы
 * из отдачи, и польза переезда осталась бы недоказуемой.
 *
 * Формат текстовый, прометеевский, и написан здесь своими руками,
 * а не взят библиотекой. Причина не в гордости: игровой сервер стоит
 * в интернете, а весь нужный вывод — полсотни строк. Зависимость,
 * которую тянут ради полусотни строк, оплачивается своим деревом
 * транзитивных пакетов и своей поверхностью обновлений.
 *
 * Что здесь есть и чего здесь нет — предмет требования «Показания
 * отдаются без сведений об игроках». Ни прозвищ, ни идентификаторов,
 * ни номеров комнат, ни билетов: точка по природе своей доступна тому,
 * кто дотянулся до порта. Разметка ограничена именем профиля манеры
 * и номером стороны — первое не про человека вовсе, второе никого
 * не опознаёт.
 */

/** Имя разметки и её значение. Значения экранируются при выводе. */
export type Labels = Readonly<Record<string, string>>;

interface Series {
  readonly name: string;
  readonly help: string;
  readonly labels: Labels;
  readonly histogram: Histogram;
}

export interface Metrics {
  /**
   * Гистограмма с этим именем и этой разметкой.
   *
   * Повторный вызов с теми же именем и разметкой отдаёт ту же
   * гистограмму: иначе показания одного и того же прибора разъехались
   * бы по нескольким копиям, и наружу поехала бы последняя.
   *
   * `shape` задаёт границы корзин и то, что считается превышением.
   * По умолчанию — миллисекунды и бюджет тика, но не всё меряется
   * временем: у «сколько команд за решение» границы в штуках,
   * и бюджет тика там означал бы бессмыслицу.
   */
  histogram(name: string, help: string, labels?: Labels, shape?: HistogramOptions): Histogram;
  /** Значение, которое просто читается в момент опроса. */
  gauge(name: string, help: string, read: () => number): void;
  counter(name: string, help: string): Counter;
  /** Текст в формате Prometheus. */
  render(): string;
}

export interface Counter {
  add(delta?: number): void;
}

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const labelsOf = (labels: Labels, extra?: readonly [string, string]): string => {
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  if (extra !== undefined) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);

  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
};

/**
 * Ключ ряда: имя плюс разметка в устойчивом порядке.
 *
 * Порядок именно устойчивый, а не тот, в котором ключи пришли:
 * `{profile, side}` и `{side, profile}` — один и тот же прибор,
 * и раздваиваться он не должен.
 */
const keyOf = (name: string, labels: Labels): string => {
  const parts = Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .sort();

  return `${name}|${parts.join(',')}`;
};

/**
 * Корзины у Prometheus накопительные: `le="8"` означает «не больше
 * восьми», то есть включает всё, что меньше. Гистограмма хранит
 * раздельные счётчики, поэтому здесь они складываются на ходу.
 */
const renderHistogram = (series: Series, snapshot: HistogramSnapshot): string => {
  const lines: string[] = [];
  let cumulative = 0;

  for (const bucket of snapshot.buckets) {
    cumulative += bucket.count;
    lines.push(
      `${series.name}_bucket${labelsOf(series.labels, ['le', String(bucket.bound)])} ${String(cumulative)}`,
    );
  }

  lines.push(
    `${series.name}_bucket${labelsOf(series.labels, ['le', '+Inf'])} ${String(snapshot.count)}`,
  );
  lines.push(`${series.name}_sum${labelsOf(series.labels)} ${snapshot.sum.toFixed(3)}`);
  lines.push(`${series.name}_count${labelsOf(series.labels)} ${String(snapshot.count)}`);

  // Максимум и число превышений — не часть прометеевской гистограммы,
  // и выводятся отдельными рядами намеренно. Перцентиль по корзинам —
  // оценка шириной в корзину, а хвост и есть то, ради чего всё
  // затевалось: у него должно быть точное число.
  lines.push(`${series.name}_max${labelsOf(series.labels)} ${snapshot.max.toFixed(3)}`);
  lines.push(`${series.name}_over_budget${labelsOf(series.labels)} ${String(snapshot.overBudget)}`);

  return lines.join('\n');
};

/**
 * Наибольшее число наблюдений в одном присланном снимке.
 *
 * Матч длиной в двадцать минут при ста двадцати кадрах в секунду даёт
 * сто сорок четыре тысячи кадров. Миллион — запас в семь раз, и вместе
 * с тем предел, за которым отчёт заведомо выдуман: принимать его
 * значило бы позволить одному запросу перевесить все настоящие.
 */
const MAX_REPORT_OBSERVATIONS = 1_000_000;

/**
 * Прочитать присланный снимок, если он на снимок похож.
 *
 * Тело запроса — `unknown` не для строгости ради строгости: это
 * браузер игрока, и прислать он может что угодно, включая
 * правдоподобную чепуху. Форму проверяем здесь, числа — в `merge`.
 *
 * Отдельно от вливания потому, что вливают снимок не всегда целиком.
 * Приёмник, которому снимки приходят десятками за матч, вливает
 * разность с прошлым — а посчитать разность можно только над уже
 * прочитанным. Две проверки формы в двух местах разошлись бы.
 */
export const readSnapshot = (value: unknown): HistogramSnapshot | null => {
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as Partial<HistogramSnapshot>;
  if (!Array.isArray(candidate.buckets)) return null;
  if (typeof candidate.count !== 'number') return null;
  if (candidate.count > MAX_REPORT_OBSERVATIONS) return null;

  for (const bucket of candidate.buckets) {
    if (typeof bucket !== 'object' || bucket === null) return null;
    if (typeof bucket.bound !== 'number' || typeof bucket.count !== 'number') return null;
  }

  return {
    count: candidate.count,
    sum: typeof candidate.sum === 'number' ? candidate.sum : Number.NaN,
    max: typeof candidate.max === 'number' ? candidate.max : Number.NaN,
    overBudget: typeof candidate.overBudget === 'number' ? candidate.overBudget : 0,
    overflow: typeof candidate.overflow === 'number' ? candidate.overflow : 0,
    buckets: candidate.buckets,
    // Перцентили присланные не используются вовсе: они пересчитаются
    // из корзин при отдаче. Складывать их было бы неверно.
    p50: 0,
    p95: 0,
    p99: 0,
  };
};

/** Влить присланный снимок целиком, если он на снимок похож. */
export const mergeReport = (histogram: Histogram, value: unknown): boolean => {
  const snapshot = readSnapshot(value);
  return snapshot !== null && histogram.merge(snapshot);
};

export const createMetrics = (): Metrics => {
  const series = new Map<string, Series>();
  const gauges = new Map<string, { help: string; read: () => number }>();
  const counters = new Map<string, { help: string; value: number }>();

  return {
    histogram(name, help, labels = {}, shape) {
      const key = keyOf(name, labels);
      const existing = series.get(key);
      if (existing !== undefined) return existing.histogram;

      const histogram = createHistogram(shape);
      series.set(key, { name, help, labels, histogram });

      return histogram;
    },

    gauge(name, help, read) {
      gauges.set(name, { help, read });
    },

    counter(name, help) {
      const existing = counters.get(name);
      if (existing === undefined) counters.set(name, { help, value: 0 });

      return {
        add(delta = 1) {
          const entry = counters.get(name);
          if (entry !== undefined) entry.value += delta;
        },
      };
    },

    render() {
      const blocks: string[] = [];

      // Ряды одного имени идут одной группой с одним заголовком:
      // Prometheus требует, чтобы HELP и TYPE не повторялись.
      const byName = new Map<string, Series[]>();
      for (const entry of series.values()) {
        const list = byName.get(entry.name);
        if (list === undefined) byName.set(entry.name, [entry]);
        else list.push(entry);
      }

      for (const [name, list] of byName) {
        const help = list[0]?.help ?? '';
        blocks.push(`# HELP ${name} ${help}`);
        blocks.push(`# TYPE ${name} histogram`);
        for (const entry of list) blocks.push(renderHistogram(entry, entry.histogram.snapshot()));
      }

      for (const [name, entry] of counters) {
        blocks.push(`# HELP ${name} ${entry.help}`);
        blocks.push(`# TYPE ${name} counter`);
        blocks.push(`${name} ${String(entry.value)}`);
      }

      for (const [name, entry] of gauges) {
        blocks.push(`# HELP ${name} ${entry.help}`);
        blocks.push(`# TYPE ${name} gauge`);
        blocks.push(`${name} ${String(entry.read())}`);
      }

      return `${blocks.join('\n')}\n`;
    },
  };
};
