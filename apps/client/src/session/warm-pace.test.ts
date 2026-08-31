import { describe, expect, it } from 'vitest';
import { WARM_HORIZON_MS, WARM_SAMPLE_MIN, createWarmPace } from './warm-pace.js';

/** Сколько запеканий в базовом наборе. Порядок величины, не точное число. */
const QUEUE = 208;

/** Порция прогрева: столько запеканий укладывается в один простой. */
const PORTION = 4;

/**
 * Прогнать прогрев по заданной цене запекания и вернуть, на какой порции
 * он был прекращён. `undefined` — прошёл очередь целиком.
 *
 * Время идёт ровно с той скоростью, которую задаёт цена: это и есть
 * то, что мерка наблюдает в жизни — промежуток между порциями.
 */
const runAt = (costMs: number, queue = QUEUE): number | undefined => {
  const pace = createWarmPace();
  let clock = 0;
  let rest = queue;
  let portions = 0;

  while (rest > 0) {
    const baked = Math.min(PORTION, rest);
    rest -= baked;
    clock += baked * costMs;
    portions += 1;

    if (!pace.afford(baked, rest, clock)) return portions;
  }

  return undefined;
};

describe('мерка скорости прогрева', () => {
  it('пропускает машину с проектной ценой запекания', () => {
    // 13 мс на комбинацию — то, ради чего прогрев и заведён: очередь
    // проходится за 2,7 с, и меню этого не замечает.
    expect(runAt(13)).toBeUndefined();
  });

  it('останавливает машину, на которой рисует процессор', () => {
    // 72 мс — замер 31.08.2026 в режиме runner'а. Очередь при такой
    // цене стоит 15 с, то есть впятеро против проектного.
    const stoppedAt = runAt(72);

    expect(stoppedAt).toBeDefined();
    // Приговор выносится сразу, как только набралось замеров: тянуть
    // незачем, каждая лишняя порция — это дёрганое меню.
    expect(stoppedAt).toBe(WARM_SAMPLE_MIN + 1);
  });

  it('не судит раньше, чем накопит замеры', () => {
    const pace = createWarmPace();

    // Цена запредельная — секунда на запекание, — и всё же первые
    // порции проходят: одиночный долгий промежуток означает заминку
    // браузера, а не негодную машину.
    for (let portion = 0; portion < WARM_SAMPLE_MIN; portion += 1) {
      expect(pace.afford(PORTION, QUEUE, (portion + 1) * 4_000)).toBe(true);
    }

    expect(pace.afford(PORTION, QUEUE, (WARM_SAMPLE_MIN + 1) * 4_000)).toBe(false);
  });

  it('не судит машину по компиляции шейдера', () => {
    // Первое запекание сессии несёт компиляцию шейдера — 746–830 мс,
    // одну на всю сессию. Войди она в замер, негодной оказалась бы любая
    // машина: 800 мс на очередь дают прогноз в два с половиной часа.
    const pace = createWarmPace();
    let clock = 800;
    let rest = QUEUE - 1;

    // Первая порция — одно запекание, и оно же самое дорогое.
    expect(pace.afford(1, rest, clock)).toBe(true);

    for (let portion = 0; portion < WARM_SAMPLE_MIN + 2; portion += 1) {
      const baked = PORTION;
      rest -= baked;
      clock += baked * 13;

      expect(pace.afford(baked, rest, clock)).toBe(true);
    }
  });

  it('судит по лучшему промежутку, а не по среднему', () => {
    // Свёрнутая вкладка растягивает промежуток на любую величину,
    // и растянутый замер говорит о вкладке, а не о машине. Укоротить
    // же промежуток нечем: быстрее собственной работы прогрев не пойдёт.
    const pace = createWarmPace();
    let clock = 0;
    let rest = QUEUE;

    const portion = (gapMs: number): boolean => {
      rest -= PORTION;
      clock += gapMs;

      return pace.afford(PORTION, rest, clock);
    };

    // Здоровая машина, но с одной десятисекундной ямой посередине.
    expect(portion(52)).toBe(true);
    expect(portion(10_000)).toBe(true);
    expect(portion(52)).toBe(true);
    expect(portion(52)).toBe(true);
    expect(portion(52)).toBe(true);
  });

  it('судит по остатку очереди, а не по одной цене', () => {
    // Остаток — часть приговора наравне с ценой. У короткого хвоста
    // та же цена запекания укладывается в срок, у длинного — нет.
    const costMs = 60;
    const affordable = Math.floor(WARM_HORIZON_MS / costMs);

    expect(runAt(costMs, affordable)).toBeUndefined();
    expect(runAt(costMs, affordable * 3)).toBeDefined();
  });

  it('показывает измеренную цену, чтобы объяснению было чем оперировать', () => {
    const pace = createWarmPace();

    expect(pace.costMs()).toBeUndefined();

    pace.afford(PORTION, QUEUE, 100);
    pace.afford(PORTION, QUEUE - PORTION, 300);

    expect(pace.costMs()).toBe(50);
  });
});
