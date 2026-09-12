import { describe, expect, it } from 'vitest';
import { CLOUD_PARALLAX, CLOUD_PUFF_LIMIT, CLOUD_VARIANTS, cloudPuffs } from './clouds.js';

/**
 * Мгла — фон, и в этом вся сложность её проверки: сломанный фон не роняет
 * ничего, он просто перестаёт быть похожим на воздух. Поэтому проверяются
 * не картинки, а свойства раскладки, каждое из которых отвечает за свою
 * беду: пропавшее покрытие, дрожание при откате предсказания, застывшая
 * или, наоборот, летящая мгла, слой, едущий вровень с миром.
 */

const viewport = { width: 1920, height: 856 };
const still = { x: 0, y: 0 };

/** Кратчайшая разность на торе: слой заворачивается, и 1919 ближе к 0. */
const wrapDelta = (a: number, b: number, span: number): number => {
  const raw = (((a - b) % span) + span) % span;
  return raw > span / 2 ? raw - span : raw;
};

describe('раскладка мглы', () => {
  it('число пятен не превышает предела ни при каком окне и смещении', () => {
    // Предел существует ради закраски: пятна крупные и полупрозрачные,
    // и каждое лишнее — это лишний полноэкранный проход.
    for (const size of [
      { width: 320, height: 480 },
      { width: 1280, height: 720 },
      { width: 1920, height: 856 },
      { width: 3840, height: 2160 },
    ]) {
      for (const camera of [still, { x: 5000, y: -5000 }, { x: -12345, y: 6789 }]) {
        const puffs = cloudPuffs(12_345, camera, size);

        expect(puffs.length).toBeLessThanOrEqual(CLOUD_PUFF_LIMIT);
        for (const puff of puffs) {
          expect(puff.variant).toBeGreaterThanOrEqual(0);
          expect(puff.variant).toBeLessThan(CLOUD_VARIANTS);
        }
      }
    }
  });

  it('свёрнутое окно не считается вовсе', () => {
    expect(cloudPuffs(0, still, { width: 0, height: 0 })).toHaveLength(0);
  });

  it('два вызова с тем же временем совпадают до числа', () => {
    // Главное свойство. Клиент переигрывает тики при откате предсказания,
    // то есть рисует один и тот же кадр дважды; разойдись раскладка —
    // мгла дёргалась бы ровно в те мгновения, когда связь и без того
    // не радует.
    expect(cloudPuffs(7_000, { x: 120, y: -40 }, viewport)).toEqual(
      cloudPuffs(7_000, { x: 120, y: -40 }, viewport),
    );
  });

  it('за секунду меняются положение, поворот и размер', () => {
    // Обратная беда: мгла, посчитанная один раз, читается наклейкой
    // на стекле, а не воздухом.
    const before = cloudPuffs(0, still, viewport);
    const after = cloudPuffs(1_000, still, viewport);

    for (let index = 0; index < before.length; index += 1) {
      const was = before[index];
      const now = after[index];
      if (was === undefined || now === undefined) throw new Error('пятно потерялось');

      const moved = Math.hypot(
        wrapDelta(now.x, was.x, viewport.width),
        wrapDelta(now.y, was.y, viewport.height),
      );

      // Двигается — и при этом не летит: за секунду не больше десятой
      // доли шага решётки. Мгла далёкая, а далёкое ползёт.
      expect(moved).toBeGreaterThan(0);
      expect(moved).toBeLessThan(viewport.width / 4 / 10);

      expect(now.rotation).not.toBe(was.rotation);
      expect(now.scale).not.toBe(was.scale);
    }
  });

  it('пятно не покидает своей ячейки ни в какое мгновение матча', () => {
    // Отсюда и следует покрытие: окно в четверть экрана — это два шага
    // решётки по каждой стороне, а отрезок в два шага непременно содержит
    // целую ячейку. Проверяется на длине матча с запасом: свободный снос
    // за это время унёс бы пятно на тысячи точек.
    const cellWidth = viewport.width / 4;
    const cellHeight = viewport.height / 4;

    for (let timeMs = 0; timeMs <= 1_200_000; timeMs += 3_100) {
      const puffs = cloudPuffs(timeMs, still, viewport);

      for (let index = 0; index < puffs.length; index += 1) {
        const puff = puffs[index];
        if (puff === undefined) throw new Error('пятно потерялось');

        const column = index % 4;
        const row = Math.floor(index / 4);

        expect(puff.x).toBeGreaterThan(column * cellWidth);
        expect(puff.x).toBeLessThan((column + 1) * cellWidth);
        expect(puff.y).toBeGreaterThan(row * cellHeight);
        expect(puff.y).toBeLessThan((row + 1) * cellHeight);
      }
    }
  });

  it('дыхание размера и прозрачности не совпадает по такту', () => {
    // Совпади периоды — все пятна дышали бы разом, а это читается
    // не движением воздуха, а ошибкой синхронизации.
    const puffs = cloudPuffs(0, still, viewport);
    const later = cloudPuffs(17_000, still, viewport);

    const scaleReturned = puffs.every(
      (puff, index) => Math.abs(puff.scale - (later[index]?.scale ?? 0)) < 1e-9,
    );
    const alphaReturned = puffs.every(
      (puff, index) => Math.abs(puff.alpha - (later[index]?.alpha ?? 0)) < 1e-9,
    );

    // Через период размера размер вернулся, а прозрачность — нет.
    expect(scaleReturned).toBe(true);
    expect(alphaReturned).toBe(false);
  });

  it('смещение камеры двигает мглу медленнее самой камеры', () => {
    // Иначе слой едет вровень с миром и перестаёт читаться далёким.
    const shift = 400;
    const before = cloudPuffs(3_000, still, viewport);
    const after = cloudPuffs(3_000, { x: shift, y: 0 }, viewport);

    for (let index = 0; index < before.length; index += 1) {
      const was = before[index];
      const now = after[index];
      if (was === undefined || now === undefined) throw new Error('пятно потерялось');

      const moved = wrapDelta(now.x, was.x, viewport.width);

      expect(moved).toBeCloseTo(shift * CLOUD_PARALLAX, 6);
      expect(Math.abs(moved)).toBeLessThan(shift);
      expect(wrapDelta(now.y, was.y, viewport.height)).toBeCloseTo(0, 6);
    }
  });

  it('пустой четверти экрана не бывает', () => {
    // Следствие предыдущей проверки, взятое с той стороны, с какой беда
    // видна глазом: дыра в мгле за краем поля. Времена взяты с разбросом
    // до десяти минут — столько идёт матч.
    for (const timeMs of [0, 4_000, 60_000, 600_000]) {
      for (const camera of [still, { x: 777, y: -333 }, { x: -4321, y: 8642 }]) {
        const puffs = cloudPuffs(timeMs, camera, viewport);

        for (const [left, top] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          const inQuarter = puffs.filter(
            (puff) =>
              puff.x >= ((left ?? 0) * viewport.width) / 2 &&
              puff.x < (((left ?? 0) + 1) * viewport.width) / 2 &&
              puff.y >= ((top ?? 0) * viewport.height) / 2 &&
              puff.y < (((top ?? 0) + 1) * viewport.height) / 2,
          );

          expect(inQuarter.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('прозрачность и размер остаются в разумных границах', () => {
    // Ушедшая за единицу прозрачность означала бы глухую стену вместо
    // мглы, а нулевой размер — пропавший слой.
    for (const timeMs of [0, 2_500, 9_000, 45_000]) {
      for (const puff of cloudPuffs(timeMs, still, viewport)) {
        expect(puff.alpha).toBeGreaterThan(0.2);
        expect(puff.alpha).toBeLessThan(0.8);
        expect(puff.scale).toBeGreaterThan(0.4);
        expect(puff.scale).toBeLessThan(1.6);
      }
    }
  });
});
