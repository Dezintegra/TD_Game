import { describe, expect, it } from 'vitest';
import { AI_DECISION_INTERVAL_TICKS, TICKS_PER_SECOND, asPlayerId } from '@td/shared';
import type { PlayerId } from '@td/shared';
import { checksum, createWorld, step } from '@td/sim';
import { createOpponent } from './opponent.js';
import { AttemptNote } from './observer.js';
import type { DecisionRecord } from './observer.js';

/**
 * Наблюдение за решениями.
 *
 * Главный тест здесь — первый. Случайность противника живёт в замыкании,
 * и одно лишнее обращение к ней сдвинуло бы всю последующую
 * последовательность решений: разбирать мы стали бы не тот матч, который
 * играли. Ошибка эта тихая и не ловится ничем, кроме прямого сравнения.
 */

const SEED = 20260820;
const AI: PlayerId = asPlayerId(1);
const SECONDS = 60;

const playSilently = (): number => {
  const opponent = createOpponent(AI, SEED);
  let world = createWorld(SEED);

  for (let tick = 0; tick < SECONDS * TICKS_PER_SECOND; tick += 1) {
    world = step(world, opponent.decide(world));
  }

  return checksum(world);
};

const playObserved = (): { checksum: number; records: readonly DecisionRecord[] } => {
  const records: DecisionRecord[] = [];
  const opponent = createOpponent(AI, SEED, undefined, (record) => records.push(record));
  let world = createWorld(SEED);

  for (let tick = 0; tick < SECONDS * TICKS_PER_SECOND; tick += 1) {
    world = step(world, opponent.decide(world));
  }

  return { checksum: checksum(world), records };
};

describe('наблюдение не меняет игру', () => {
  const observed = playObserved();

  it('прогон с наблюдателем и без даёт одинаковый мир', () => {
    expect(observed.checksum).toBe(playSilently());
  });

  it('наблюдатель получает запись на каждое решение', () => {
    // Решения принимаются раз в `AI_DECISION_INTERVAL_TICKS`, и записей
    // должно быть ровно столько же: пропущенная запись означала бы
    // дыру в разборе, а лишняя — что наблюдение зовётся не там.
    expect(observed.records.length).toBe(
      Math.ceil((SECONDS * TICKS_PER_SECOND) / AI_DECISION_INTERVAL_TICKS),
    );
  });

  it('записи идут по возрастанию тика и все принадлежат наблюдаемому', () => {
    let previous = -1;
    for (const entry of observed.records) {
      expect(entry.tick).toBeGreaterThan(previous);
      expect(entry.player).toBe(AI);
      previous = entry.tick;
    }
  });
});

describe('запись объясняет решение', () => {
  const { records } = playObserved();

  it('содержит оценки ВСЕХ рубежей, а не только выбранного', () => {
    // Оценка одного лишь победителя не даёт ответить на главный вопрос
    // разбора: обошёл ли он соседа заметно или на два процента.
    const withFrontiers = records.filter((entry) => entry.frontiers.length > 0);

    expect(withFrontiers.length).toBeGreaterThan(0);
    expect(Math.max(...withFrontiers.map((entry) => entry.frontiers.length))).toBeGreaterThan(1);
  });

  it('ровно один рубеж помечен выбранным', () => {
    for (const entry of records) {
      if (entry.frontiers.length === 0) continue;

      expect(entry.frontiers.filter((frontier) => frontier.chosen)).toHaveLength(1);
    }
  });

  it('различает «нет места» и «нет денег»', () => {
    // Ради этого различия наблюдатель во многом и заведён: снаружи оба
    // случая выглядят как «противник не строит».
    const notes = new Set(
      records.flatMap((entry) => entry.attempts.map((attempt) => attempt.note)),
    );

    expect(notes.size).toBeGreaterThan(1);
    // За минуту матча противник заведомо упирается хотя бы в одну
    // из денежных причин.
    const money: readonly string[] = [
      AttemptNote.StructureUnaffordable,
      AttemptNote.UpgradeUnaffordable,
      AttemptNote.UnitUnaffordable,
    ];
    expect([...notes].some((note) => note !== undefined && money.includes(note))).toBe(true);
  });

  it('у состоявшейся покупки причины отказа нет', () => {
    for (const entry of records) {
      for (const attempt of entry.attempts) {
        if (attempt.result === 'bought') expect(attempt.note).toBeUndefined();
        else expect(attempt.note).toBeDefined();
      }
    }
  });

  it('помнит порядок трат и признак сопровождения', () => {
    // Без них «купил юнита вместо улучшения» выглядит необъяснимым
    // отклонением от порядка фазы.
    for (const entry of records) {
      expect(entry.spendOrder.length).toBeGreaterThan(0);
      expect(typeof entry.escorting).toBe('boolean');
      expect(entry.liveUnits).toBeGreaterThanOrEqual(0);
    }
  });

  it('помнит, где стоял генерал и как далеко зашёл', () => {
    const walked = records.filter((entry) => entry.generalCell >= 0);

    expect(walked.length).toBeGreaterThan(0);
    for (const entry of walked) {
      expect(entry.generalFromHome).toBeGreaterThanOrEqual(-1);
      expect(entry.approachShortest).toBeGreaterThan(0);
    }
  });

  it('недостижимая клетка записывается как «неизвестно», а не сентинелом', () => {
    // Генерала может обстроить со всех сторон, и поле расстояний вернёт
    // сентинел недостижимости. Записать его как расстояние значило бы
    // подсунуть разбору два миллиарда клеток: один такой матч ломает
    // сводку по всей пачке.
    for (const entry of records) {
      // Доля пути заведомо не превышает нескольких единиц: обойти карту
      // кругом можно, обойти её миллион раз — нет.
      if (entry.generalFromHome < 0) continue;

      expect(entry.generalFromHome / entry.approachShortest).toBeLessThan(10);
    }
  });

  it('номер фазы указывает на существующую фазу', () => {
    for (const entry of records) {
      expect(entry.phaseIndex).toBeGreaterThanOrEqual(0);
    }
  });
});
