import { describe, expect, it } from 'vitest';
import { stagePrompt } from './stage-prompt.mjs';

/**
 * Проверки промпта назначения.
 *
 * Главное здесь — самодостаточность. Сессия начинается с чистого листа
 * и о разговоре, в котором задача возникла, не знает ничего. Всё, что прежде
 * лежало в слоте и выписке рядом с ним, обязано быть в этих строках; чего
 * здесь нет, того для исполнителя не существует.
 */

const task = {
  id: '0042-fix-tesla-price',
  title: 'Снизить цену Теслы',
  type: 'feature',
  status: 'implement',
  description: 'Цена 240 не окупается: профиль качает Теслу и перестаёт её покупать.',
  links: { change: 'fix-tesla-price', pr: 137 },
  attempts: { continuations: 1 },
  owner: 'СТАНЦИЯ',
};

const assignment = {
  taskId: task.id,
  stage: 'implement',
  branch: 'worktree-0042-fix-tesla-price',
  path: '.claude/worktrees/0042-fix-tesla-price',
};

describe('состав', () => {
  const text = stagePrompt({ assignment, task, journal: 'вердикт аудита: пропущено' });

  it('называет задачу, этап, ветку и дерево', () => {
    for (const part of [task.id, 'implement', assignment.branch, assignment.path]) {
      expect(text).toContain(part);
    }
  });

  it('несёт описание задачи: бэклог исполнителю открывать незачем', () => {
    expect(text).toContain('не окупается');
  });

  it('несёт журнал: там лежат оговорки аудита, которых больше нигде нет', () => {
    expect(text).toContain('вердикт аудита');
  });

  it('несёт ссылки на артефакты и израсходованные попытки', () => {
    expect(text).toContain('fix-tesla-price');
    expect(text).toContain('continuations');
  });

  it('требует вернуть отчёт сообщением, а не файлом', () => {
    expect(text).toContain('последним сообщением');
    expect(text).not.toContain('.pipeline/reports');
  });
});

describe('продолжение', () => {
  it('называется вслух: возобновлённая сессия не знает, что её прервали', () => {
    const text = stagePrompt({
      assignment: { ...assignment, continuation: true, reason: 'снят по сроку' },
      task,
    });
    expect(text).toContain('продолжение прерванного этапа');
    expect(text).toContain('снят по сроку');
  });

  it('обычному этапу об этом не говорят', () => {
    expect(stagePrompt({ assignment, task })).not.toContain('продолжение прерванного');
  });
});

describe('опись доски', () => {
  it('прикладывается, когда есть: аудиту нужны чужие задачи в работе', () => {
    const text = stagePrompt({
      assignment,
      task,
      board: [{ id: '0043-other', title: 'Другая', type: 'feature', status: 'design' }],
    });
    expect(text).toContain('0043-other');
  });

  it('пустая не поминается вовсе', () => {
    expect(stagePrompt({ assignment, task, board: [] })).not.toContain('Прочие задачи');
  });
});

describe('журнал', () => {
  it('обрезается, и обрезка названа вслух: молчаливая обманывает', () => {
    const long = 'строка журнала\n'.repeat(2000);
    const text = stagePrompt({ assignment, task, journal: long, journalLimit: 100 });
    expect(text).toContain('обрезано');
    expect(text.length).toBeLessThan(long.length);
  });

  it('пустой показан пустым, а не отсутствующим', () => {
    expect(stagePrompt({ assignment, task, journal: '' })).toContain('_пусто_');
  });
});
