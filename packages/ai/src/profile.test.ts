import { describe, expect, it } from 'vitest';
import { NUKE_COST, TICKS_PER_SECOND } from '@td/shared';
import {
  BASELINE_PROFILE,
  DEFAULT_PROFILE_ID,
  PROFILES,
  WALL_LIGHT_PROFILE,
  horizonTicks,
  phaseAt,
  profileByName,
  reserveOf,
} from './profile.js';

/**
 * Профиль как таковой: реестр, неизменяемость, перевод единиц.
 *
 * Что профиль воспроизводит прежнее поведение — предмет
 * `profile.golden.test.ts`. Здесь проверяется сам механизм.
 */

describe('реестр профилей', () => {
  it('профиль достаётся по имени', () => {
    expect(profileByName(DEFAULT_PROFILE_ID)).toBe(BASELINE_PROFILE);
    expect(profileByName(WALL_LIGHT_PROFILE.id)).toBe(WALL_LIGHT_PROFILE);
  });

  it('неизвестное имя даёт понятную ошибку, а не молчаливый откат', () => {
    // Молчаливый откат к профилю по умолчанию был бы худшим из возможных
    // поведений: опечатка в имени превратилась бы в прогон не того,
    // что задумано, и разбор матча оказался бы разбором чужой настройки.
    expect(() => profileByName('нет-такого')).toThrow(/неизвестный профиль/);
    expect(() => profileByName('нет-такого')).toThrow(new RegExp(DEFAULT_PROFILE_ID));
  });

  it('идентификатор профиля совпадает с ключом в реестре', () => {
    for (const [key, profile] of Object.entries(PROFILES)) {
      expect(profile.id).toBe(key);
    }
  });

  it('имя профиля содержит дату появления', () => {
    // По имени `baseline-2026-08` через полгода сразу видно, что это
    // за линия поведения и насколько она стара; по имени `default` —
    // ничего.
    for (const id of Object.keys(PROFILES)) {
      expect(id).toMatch(/-\d{4}-\d{2}$/);
    }
  });
});

describe('профиль неизменяем', () => {
  it('верхний уровень заморожен', () => {
    expect(Object.isFrozen(BASELINE_PROFILE)).toBe(true);
  });

  it('вложенные объекты заморожены тоже', () => {
    // Object.freeze неглубок и остановился бы на верхнем уровне, оставив
    // изменяемыми ровно те места, куда потянется рука «подкрутить на ходу».
    expect(Object.isFrozen(BASELINE_PROFILE.posture)).toBe(true);
    expect(Object.isFrozen(BASELINE_PROFILE.posture.frontierFractions)).toBe(true);
    expect(Object.isFrozen(BASELINE_PROFILE.phases)).toBe(true);
    expect(Object.isFrozen(BASELINE_PROFILE.phases[0])).toBe(true);
    expect(Object.isFrozen(BASELINE_PROFILE.phases[0]?.mix)).toBe(true);
    expect(Object.isFrozen(BASELINE_PROFILE.escort.spend)).toBe(true);
  });

  it('запись не меняет значения', () => {
    // Случайная запись посреди матча дала бы поведение, невоспроизводимое
    // по seed, — то есть уничтожила бы главное свойство, ради которого
    // профиль и заводился.
    const before = BASELINE_PROFILE.building.wallEvery;
    const mutable = BASELINE_PROFILE.building as { wallEvery: number };

    try {
      mutable.wallEvery = 999;
    } catch {
      // В строгом режиме запись в замороженное бросает — это тоже успех.
    }

    expect(BASELINE_PROFILE.building.wallEvery).toBe(before);
  });
});

describe('перевод в единицы ядра', () => {
  it('горизонт планирования переводится из секунд в тики', () => {
    // В профиле числа человеческие: `horizonSeconds: 60` понятен сразу,
    // `horizonTicks: 1800` — нет.
    expect(horizonTicks(BASELINE_PROFILE)).toBe(
      BASELINE_PROFILE.posture.horizonSeconds * TICKS_PER_SECOND,
    );
  });

  it('запас фазы разворачивается в цену удара', () => {
    // Запас хранится состоянием, а не числом: иначе цена удара имела бы
    // два источника истины, и поменяв её в балансе, мы оставили бы
    // противника копить не то, что нужно.
    const late = BASELINE_PROFILE.phases[BASELINE_PROFILE.phases.length - 1];
    const early = BASELINE_PROFILE.phases[0];

    expect(late?.reserve).toBe('nuke');
    expect(reserveOf(late!)).toBe(NUKE_COST);
    expect(early?.reserve).toBe('none');
    expect(reserveOf(early!)).toBe(0);
  });
});

describe('фазы матча', () => {
  it('на нулевом тике действует первая фаза', () => {
    expect(phaseAt(BASELINE_PROFILE, 0)).toBe(BASELINE_PROFILE.phases[0]);
  });

  it('фаза сменяется на своём пороге', () => {
    const first = BASELINE_PROFILE.phases[0];
    if (first === undefined) throw new Error('профиль без фаз');

    const border = first.untilSecond * TICKS_PER_SECOND;

    expect(phaseAt(BASELINE_PROFILE, border - 1)).toBe(first);
    expect(phaseAt(BASELINE_PROFILE, border)).not.toBe(first);
  });

  it('поздняя фаза замыкает список и действует до конца матча', () => {
    const last = BASELINE_PROFILE.phases[BASELINE_PROFILE.phases.length - 1];

    expect(last?.untilSecond).toBe(Number.POSITIVE_INFINITY);
    expect(phaseAt(BASELINE_PROFILE, 60 * 60 * TICKS_PER_SECOND)).toBe(last);
  });

  it('пороги фаз возрастают', () => {
    const thresholds = BASELINE_PROFILE.phases.map((phase) => phase.untilSecond);
    const sorted = [...thresholds].sort((a, b) => a - b);

    expect(thresholds).toEqual(sorted);
  });
});
