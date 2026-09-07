import { describe, expect, it } from 'vitest';
import { clipMiddle, stagePrompt } from './stage-prompt.mjs';
import { ROUTING_CONTRACT } from './routing-contract.mjs';

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

it('новый анализ 0032 получает основание ожидания и артефакты 0120', () => {
  const predecessor = {
    id: '0120-progon-areny-s-priborom-pomeh-yadernogo-',
    status: 'completed',
    links: { run: '0120-arena-result' },
  };
  const source = {
    ...task,
    id: '0032-yadernyy-udar-vredit-svoim-general-na-ch',
    type: 'note',
    status: 'new',
    analysisGeneration: 1,
    dependsOn: [predecessor.id],
    links: { change: 'nuke-counts-own-losses', pr: 23 },
    blockedContext: {
      from: 'triage',
      operation: 'accepted',
      reasons: [
        {
          taskId: predecessor.id,
          reason: 'Без измерения нельзя оценить потери',
          result: 'Артефакты помех ядерного удара',
        },
      ],
    },
  };
  const text = stagePrompt({
    assignment: { ...assignment, taskId: source.id, stage: 'triage' },
    task: source,
    board: [predecessor],
  });
  expect(text).toContain(ROUTING_CONTRACT);
  for (const value of [
    source.links.change,
    predecessor.id,
    predecessor.links.run,
    source.blockedContext.reasons[0].reason,
    source.blockedContext.reasons[0].result,
  ])
    expect(text).toContain(value);
});

it('новый бюджет и запрет его изменения агентом не обрезаются старым журналом', () => {
  const text = stagePrompt({
    assignment,
    task,
    journal: 'старый предел 25 млн\n'.repeat(1000),
    journalLimit: 200,
    tokenBudget: { value: 35000000, spent: 26093350, source: 'user' },
  });
  expect(text).toContain('полный лимит 35000000');
  expect(text).toContain('Учтено 26093350');
  expect(text).toContain('Агенту запрещено менять лимит');
  expect(text).toContain('Этот снимок новее');
});

describe('состав', () => {
  it('передаёт закреплённую ревизию снимка выкладки', () => {
    const deploymentRevision = 'a'.repeat(40);
    const text = stagePrompt({
      assignment: { ...assignment, stage: 'deploy', branch: null, deploymentRevision },
      task,
    });
    expect(text).toContain(`"deploymentRevision": "${deploymentRevision}"`);
    expect(text).toContain('"branch": null');
  });
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

describe('пакет выкладки', () => {
  const batch = [
    { id: '0042-fix-tesla-price', title: 'Снизить цену Теслы', pr: 137, change: 'fix-tesla-price' },
    { id: '0043-fix-nuke', title: 'Поправить удар', pr: 138, change: 'fix-nuke' },
  ];

  it('идентификаторы пакета стоят в назначении, выписки — своим разделом', () => {
    // Сессии нужен номер pull request каждой задачи, чтобы проверить
    // вливание, а открывать бэклог ей нельзя: чего нет в промпте, того
    // для неё не существует.
    const text = stagePrompt({ assignment: { ...assignment, stage: 'deploy', batch }, task });
    expect(text).toContain('"batch": [');
    expect(text).toContain('## Пакет выкладки');
    expect(text).toContain('0043-fix-nuke');
    expect(text).toContain('138');
    expect(text).toContain('`skipped`');
  });

  it('без пакета ни поля, ни раздела нет', () => {
    const text = stagePrompt({ assignment, task });
    expect(text).not.toContain('"batch"');
    expect(text).not.toContain('Пакет выкладки');
  });

  it('пустой перечень пакетом не считается', () => {
    const text = stagePrompt({ assignment: { ...assignment, batch: [] }, task });
    expect(text).not.toContain('Пакет выкладки');
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

describe('лог упавшего этапа', () => {
  const analysing = { taskId: task.id, stage: 'postmortem', branch: null, path: null };
  const halted = { ...task, status: 'postmortem', returnTo: 'implement' };

  it('прикладывается разбору вместе с путём к файлу', () => {
    const text = stagePrompt({
      assignment: analysing,
      task: halted,
      stageLog: {
        stage: 'implement',
        path: '.pipeline/logs/0042-fix-tesla-price-implement.log',
        text: 'отказов:   3\nотказано Bash Get-ChildItem',
      },
    });
    expect(text).toContain('Лог упавшего этапа (implement)');
    expect(text).toContain('.pipeline/logs/0042-fix-tesla-price-implement.log');
    expect(text).toContain('Get-ChildItem');
  });

  it('отсутствие лога названо вслух: это само по себе улика', () => {
    const text = stagePrompt({
      assignment: analysing,
      task: halted,
      stageLog: { stage: 'implement', path: '.pipeline/logs/нет.log', text: null },
    });
    expect(text).toContain('Лога нет');
  });

  it('прочим этапам лога не дают: им нечего с ним делать', () => {
    expect(stagePrompt({ assignment, task })).not.toContain('Лог упавшего этапа');
  });

  it('берётся голова и хвост, а пропущенное названо числом', () => {
    // Смысл лога лежит по краям: в голове сводка исхода и отказанные
    // действия, в хвосте — то, на чём всё оборвалось. Середина бывает
    // в сотни килобайт вывода сборки.
    const long = `НАЧАЛО${'середина'.repeat(5000)}КОНЕЦ`;
    const clipped = clipMiddle(long, 100, 100);
    expect(clipped).toContain('НАЧАЛО');
    expect(clipped).toContain('КОНЕЦ');
    expect(clipped).toContain(`пропущено ${long.length - 200} знаков`);
  });

  it('короткий лог не режется вовсе', () => {
    expect(clipMiddle('коротко', 100, 100)).toBe('коротко');
    expect(clipMiddle('коротко', 100, 100)).not.toContain('пропущено');
  });
});

describe('журнал', () => {
  it.each([120, 8])('оставляет полное пояснение revise вне лимита %i', (journalLimit) => {
    const journal = `${'история\n'.repeat(100)}P1: блоккер\nвладелец: принято`;
    const text = stagePrompt({
      assignment: { ...assignment, stage: 'revise' },
      task: { ...task, status: 'revise' },
      journal,
      journalLimit,
    });
    const [clipped, explanation] = text
      .split('## Журнал задачи\n\n')[1]
      .split('\n\n## Восстановление замечаний\n\n');
    expect(clipped.length).toBeLessThanOrEqual(journalLimit);
    if (journalLimit === 120) {
      expect(clipped).toContain('P1: блоккер\nвладелец: принято');
    }
    for (const part of [
      `.pipeline/logs/${task.id}-review.log`,
      'основного дерева',
      'git -C <дерево> worktree list',
      'supervisor/skills/revise.md',
      'проверка соответствия текущему возврату обязательна',
      'дополнительный источник',
      'не заменяет полный журнал карточки',
      'ответ владельца продукта',
      'Не обращайся к Trello',
      'failed до исправлений',
      'путь и причину',
    ])
      expect(explanation).toContain(part);
    // Тот же хвост у другого этапа: пояснение не отнимает место в журнале.
    const other = stagePrompt({ assignment, task, journal, journalLimit });
    expect(other).toContain(`## Журнал задачи\n\n${clipped}\n\n`);
    expect(other).not.toContain('## Восстановление замечаний');
    expect(other).not.toContain('целиком — в журнале задачи');
  });

  it.each(['', 'полный журнал'])('не добавляет пояснение к необрезанному revise: %j', (journal) => {
    const text = stagePrompt({ assignment: { ...assignment, stage: 'revise' }, task, journal });
    expect(text).not.toContain('## Восстановление замечаний');
    expect(text).toContain(journal || '_пусто_');
  });

  it('обрезается, и обрезка названа вслух: молчаливая обманывает', () => {
    const long = 'строка журнала\n'.repeat(2000);
    const text = stagePrompt({ assignment, task, journal: long, journalLimit: 100 });
    expect(text).toContain('пропущена');
    expect(text.length).toBeLessThan(long.length);
  });

  it('пустой показан пустым, а не отсутствующим', () => {
    expect(stagePrompt({ assignment, task, journal: '' })).toContain('_пусто_');
  });

  it('сохраняет свежие P1 и ответ владельца после большого старого журнала', () => {
    const journal = `${'старый отчёт\n'.repeat(2000)}P1: исправить блоккер\nвладелец: принято`;
    const text = stagePrompt({ assignment, task, journal, journalLimit: 120 });
    expect(text).toContain('ранняя часть журнала пропущена');
    expect(text).toContain('P1: исправить блоккер');
    expect(text).toContain('владелец: принято');
  });

  it('сохраняет bounded tail единственной последней строки, даже когда она длиннее лимита', () => {
    const journal = `${'старое\n'.repeat(100)}${'x'.repeat(400)} END-P1`;
    const text = stagePrompt({ assignment, task, journal, journalLimit: 90 });
    expect(text).toContain('пропущена');
    expect(text).toContain('END-P1');
  });
});
