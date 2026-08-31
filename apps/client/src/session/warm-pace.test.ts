import { describe, expect, it } from 'vitest';
import {
  WARM_FRAME_LIMIT_MS,
  WARM_WINDOW_FRAMES_MIN,
  WARM_WINDOW_MS,
  createWarmPace,
} from './warm-pace.js';

/** Кадр на экране с шестьюдесятью герцами. */
const SMOOTH_MS = 1000 / 60;

/** Кадр на машине, которую прогрев душит: замер в режиме runner'а. */
const JANKY_MS = 50;

/**
 * Прокрутить кадровые часы и вернуть приговор каждого кадра.
 *
 * Время идёт ровно теми шагами, которые задал вызывающий: это и есть
 * то, что мерка видит в жизни — метки `requestAnimationFrame`.
 */
const play = (deltas: readonly number[]): boolean[] => {
  const pace = createWarmPace();
  let clock = 1_000;

  return deltas.map((delta) => {
    clock += delta;

    return pace.frame(clock);
  });
};

/** Столько ровных кадров укладывается в одно окно наблюдения. */
const perWindow = Math.ceil(WARM_WINDOW_MS / SMOOTH_MS);

/** Кадры одной длины: столько-то окон подряд. */
const steady = (deltaMs: number, windows: number): number[] =>
  Array.from({ length: Math.ceil((WARM_WINDOW_MS * windows) / deltaMs) + 1 }, () => deltaMs);

describe('мерка вреда от прогрева', () => {
  it('не трогает прогрев на ровных кадрах', () => {
    // Шестьдесят кадров в секунду — то, что замер показал на здоровой
    // машине ВО ВРЕМЯ прогрева. Прогрев там не мешает никому.
    expect(play(steady(SMOOTH_MS, 6)).every(Boolean)).toBe(true);
  });

  it('прекращает прогрев на дёрганых кадрах', () => {
    // Пятьдесят миллисекунд на кадр — двадцать кадров в секунду, ровно
    // как в замере больной машины во время прогрева.
    const verdicts = play(steady(JANKY_MS, 4));

    expect(verdicts.includes(false)).toBe(true);
  });

  it('не судит по первому окну: там загрузка страницы', () => {
    // Первое окно несёт компиляцию шейдера — 746–830 мс на первое
    // запекание сессии. Судить по ней значило бы признать негодной
    // любую машину.
    const verdicts = play([...steady(JANKY_MS, 1), ...steady(SMOOTH_MS, 4)]);

    expect(verdicts.every(Boolean)).toBe(true);
  });

  it('прекращает прогрев на втором дёрганом окне, а не позже', () => {
    // Приговор нужен вовремя: на больной машине каждое лишнее окно —
    // это полсекунды дёрганого меню.
    const verdicts = play(steady(JANKY_MS, 4));

    expect(verdicts.indexOf(false)).toBeLessThan(2 * Math.ceil(WARM_WINDOW_MS / JANKY_MS) + 2);
  });

  it('не отменяет прогрев из-за одной заминки', () => {
    // Сборка мусора, перерисовка списка комнат, чужой процесс на ядре —
    // один долгий кадр среди ровных случается и на здоровой машине.
    // Судится СРЕДНЯЯ длина кадра в окне, и одна заминка её не тянет.
    const window = [...Array.from({ length: perWindow }, () => SMOOTH_MS), 200];
    const verdicts = play([...window, ...window, ...window]);

    expect(verdicts.every(Boolean)).toBe(true);
  });

  it('не судит по одному кадру', () => {
    const pace = createWarmPace();

    // Окно закрывается по времени, и одинокий долгий кадр закрыл бы его
    // сам собой. Средняя длина кадра по одному кадру — это не средняя
    // длина, а сам этот кадр.
    expect(pace.frame(1_000)).toBe(true);
    expect(pace.frame(1_000 + WARM_WINDOW_MS * 2)).toBe(true);
    expect(pace.frameMs()).toBeUndefined();
  });

  it('забывает окно на время матча', () => {
    const pace = createWarmPace();
    let clock = 1_000;

    for (let frame = 0; frame < perWindow * 3; frame += 1) {
      clock += SMOOTH_MS;
      expect(pace.frame(clock)).toBe(true);
    }

    // Матч на пять минут. Без сброса первый же кадр после него дал бы
    // «длину кадра» во весь матч и отменил бы прогрев ни за что.
    pace.pause();
    clock += 5 * 60 * 1000;

    for (let frame = 0; frame < perWindow * 3; frame += 1) {
      clock += SMOOTH_MS;
      expect(pace.frame(clock)).toBe(true);
    }
  });

  it('показывает измеренную длину кадра, чтобы объяснению было чем оперировать', () => {
    const pace = createWarmPace();
    let clock = 1_000;

    expect(pace.frameMs()).toBeUndefined();

    // Два окна: первое не судит, второе называет цифру.
    for (let frame = 0; frame < perWindow * 2 + WARM_WINDOW_FRAMES_MIN; frame += 1) {
      clock += SMOOTH_MS;
      pace.frame(clock);
    }

    expect(pace.frameMs()).toBeCloseTo(SMOOTH_MS, 5);
    expect(pace.frameMs()).toBeLessThan(WARM_FRAME_LIMIT_MS);
  });
});
