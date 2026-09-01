import { describe, expect, it } from 'vitest';
import {
  ANSWER_MARK,
  appendQuestion,
  pendingQuestions,
  recordAnswer,
  renderQuestion,
} from './questions.mjs';
import { readAnswers } from './read-state.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Проверки записи и чтения вопросов владельцу продукта.
 *
 * Главная проверка здесь одна и она сквозная: собранный вопрос обязан
 * читаться тем самым разбором, которым конвейер ищет ответы. Писать
 * и читать один файл двумя разборами — верный способ однажды разойтись,
 * и разойтись молча: задача просто останется ждать вечно.
 */

const NOW = '2026-08-27T12:00:00+03:00';

const question = (over = {}) =>
  renderQuestion({
    taskId: '0042-fix-tesla-price',
    askedAt: NOW,
    returnTo: 'design',
    summary: 'Цена Теслы влияет и на покупку, и на прокачку.',
    decisions: [
      '**Вариант А.** Удешевить только покупку.',
      '**Вариант Б.** Удешевить покупку и удорожить прокачку.',
    ],
    ...over,
  });

/** Прочитать ответы настоящим разбором конвейера, через настоящий файл. */
function answersOf(text) {
  const root = mkdtempSync(join(tmpdir(), 'questions-'));
  mkdirSync(join(root, 'manage'), { recursive: true });
  writeFileSync(join(root, 'manage', 'questions.md'), text, 'utf8');
  return readAnswers(root, { paths: { questions: 'manage/questions.md' } });
}

describe('сборка вопроса', () => {
  it('раздел назван идентификатором задачи', () => {
    expect(question()).toContain('### 0042-fix-tesla-price');
  });

  it('названы время вопроса и куда вернётся задача', () => {
    const text = question();
    expect(text).toContain(`- **Спрошено:** ${NOW}`);
    expect(text).toContain('- **Задача вернётся в:** design');
  });

  it('варианты из решений отчёта попадают в вопрос', () => {
    expect(question()).toContain('**Вариант Б.** Удешевить покупку');
  });

  it('пустое место для ответа есть всегда', () => {
    expect(question()).toContain(ANSWER_MARK);
  });

  it('вопрос без вариантов оговаривается вслух, а не прячется', () => {
    // Вопрос без вариантов задавать не велено; молча пропустить нарушение
    // значило бы оставить владельца продукта выбирать из пустоты.
    expect(question({ decisions: [] })).toContain('Вариантов сессия не назвала');
  });

  it('сессия не назвала сути — раздел всё равно отсылает к журналу', () => {
    expect(question({ summary: '   ' })).toContain('смотрите журнал задачи');
  });
});

describe('собранный вопрос читается разбором конвейера', () => {
  it('свежий вопрос считается неотвеченным', () => {
    // Ровно то, ради чего эти два куска держат вместе: пустая пометка —
    // это ещё не ответ, а место для него.
    const text = appendQuestion('# Вопросы\n', question());
    expect(answersOf(text)).toEqual({});
    expect(pendingQuestions(text).map((item) => item.id)).toEqual(['0042-fix-tesla-price']);
  });

  it('после ответа разбор его находит', () => {
    const text = recordAnswer(
      appendQuestion('# Вопросы\n', question()),
      '0042-fix-tesla-price',
      'Вариант А.',
    );
    expect(answersOf(text)['0042-fix-tesla-price']).toContain('Вариант А.');
    expect(pendingQuestions(text)).toEqual([]);
  });
});

describe('дописывание в файл', () => {
  it('прежнее содержимое не трогается', () => {
    const before = '# Вопросы\n\n## Открытые вопросы\n';
    expect(appendQuestion(before, question())).toContain('## Открытые вопросы');
  });

  it('два вопроса подряд не слипаются', () => {
    const text = appendQuestion(
      appendQuestion('# Вопросы\n', question()),
      question({ taskId: '0043-two' }),
    );
    expect(pendingQuestions(text).map((item) => item.id)).toEqual([
      '0042-fix-tesla-price',
      '0043-two',
    ]);
  });

  it('порядок сохраняется: спрошенный раньше отвечается раньше', () => {
    const text = appendQuestion(
      appendQuestion('', question({ taskId: '0001-one' })),
      question({ taskId: '0002-two' }),
    );
    expect(pendingQuestions(text)[0].id).toBe('0001-one');
  });
});

describe('запись ответа', () => {
  const text = appendQuestion('# Вопросы\n', question());

  it('пустой ответ ответом не считается', () => {
    expect(recordAnswer(text, '0042-fix-tesla-price', '   ')).toBeNull();
  });

  it('раздела нет — отказ, а не выдумка нового', () => {
    expect(recordAnswer(text, '0099-none', 'Вариант А.')).toBeNull();
  });

  it('уже отвеченный вопрос не переписывается', () => {
    // Ответы владельца продукта — единственное, чего конвейер в этот файл
    // не пишет сам. Тихо затереть чужой ответ хуже, чем отказаться.
    const answered = recordAnswer(text, '0042-fix-tesla-price', 'Вариант А.');
    expect(recordAnswer(answered, '0042-fix-tesla-price', 'Вариант Б.')).toBeNull();
  });

  it('пометка остаётся на месте: по ней видно, что раздел был вопросом', () => {
    const answered = recordAnswer(text, '0042-fix-tesla-price', 'Вариант А.');
    expect(answered).toContain(ANSWER_MARK);
  });
});
