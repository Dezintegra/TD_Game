import { describe, expect, it } from 'vitest';
import { countFailure, shouldPause } from './lock.mjs';
import { resolveConfig } from '../config/defaults.mjs';

/**
 * Проверки счёта неудач.
 *
 * Пауза — тяжёлая мера: снимается она только руками, и до тех пор конвейер
 * стоит целиком. Значит цена ошибки несимметрична. Не взвести паузу там,
 * где надо, — конвейер помолотит вхолостую ещё пять минут. Взвести там,
 * где не надо, — он встанет до утра из-за пропавшей на минуту сети.
 *
 * Поэтому исходы, связанные с доской, проверяются отдельно.
 */

const { config } = resolveConfig({ trello: { board: 'b' } });

describe('доска недоступна', () => {
  it('это не неудача: сеть вернётся сама, а пауза снимается руками', () => {
    expect(countFailure(2, 'unreachable')).toBe(0);
  });

  it('и трёх недоступностей подряд не хватит, чтобы встать', () => {
    let failures = 0;
    for (let cycle = 0; cycle < 3; cycle += 1) failures = countFailure(failures, 'unreachable');
    expect(shouldPause(failures, config).pause).toBe(false);
  });
});

describe('доступ не настроен', () => {
  it('тоже не взводит паузу: она добавила бы к починке второй шаг', () => {
    expect(countFailure(2, 'misconfigured')).toBe(0);
  });
});

describe('настоящие неудачи', () => {
  it('считаются подряд', () => {
    expect(countFailure(1, 'conflict')).toBe(2);
  });

  it('на третьей взводят паузу', () => {
    expect(shouldPause(3, config).pause).toBe(true);
  });

  it('сбрасываются удачным циклом', () => {
    expect(countFailure(2, 'done')).toBe(0);
  });

  it('перемежаясь с удачными, до паузы не доходят', () => {
    const outcomes = ['conflict', 'done', 'conflict', 'done', 'conflict'];
    const failures = outcomes.reduce((count, outcome) => countFailure(count, outcome), 0);
    expect(shouldPause(failures, config).pause).toBe(false);
  });
});
