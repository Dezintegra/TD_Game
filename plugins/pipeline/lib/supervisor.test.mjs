import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createSupervisor } from './supervisor.mjs';
import { resolveConfig } from '../config/defaults.mjs';

/**
 * Проверки хозяйства идущих этапов.
 *
 * Порождение подставное, поэтому проверяется ровно то, ради чего супервизор
 * и написан: квота прямым счётом детей, отчёт из вывода, память о сессии
 * ради возобновления и — главное — недоверие отчёту при отказанных
 * действиях. Последнее словами не заменишь: беда сменила вид с заметной
 * («сессия висит») на незаметную («этап тихо сделал не то»).
 */

const { config } = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.claude/worktrees',
});

function harness(over = {}) {
  const children = [];
  const killed = [];
  const logged = [];
  const saved = [];

  const spawn = () => {
    const child = new EventEmitter();
    child.pid = 1000 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    return child;
  };

  const supervisor = createSupervisor({
    config: { ...config, ...over.config },
    root: '/repo',
    spawn,
    killTree: (pid) => killed.push(pid),
    now: () => '2026-08-31T12:00:00+03:00',
    saveStages: (stages) => saved.push({ ...stages }),
    stages: over.stages ?? {},
    log: (line) => logged.push(line),
  });

  /** Довести последний порождённый процесс до конца с таким выводом. */
  const answer = async (envelope, code = 0) => {
    const child = children.at(-1);
    child.stdout.emit('data', JSON.stringify(envelope));
    child.emit('close', code);
    // Дать промису завершения дойти до обработчика.
    await sleep(0);
  };

  return { supervisor, children, killed, logged, saved, answer };
}

const assignment = (over = {}) => ({
  taskId: '0001-one',
  stage: 'design',
  branch: 'worktree-0001-one',
  path: '.claude/worktrees/0001-one',
  task: { id: '0001-one', status: 'design', title: 'проба' },
  journal: '',
  board: [],
  ...over,
});

const report = { taskId: '0001-one', stage: 'design', outcome: 'done', summary: 'сделано' };

const envelope = (over = {}) => ({
  is_error: false,
  session_id: 'сессия-от-приложения',
  result: JSON.stringify(report),
  ...over,
});

describe('порождение', () => {
  it('этап становится видимым как идущий', () => {
    const { supervisor } = harness();
    expect(supervisor.spawnStage(assignment()).ok).toBe(true);
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'design' }]);
  });

  it('по одной задаче второго этапа не заводят', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    const second = supervisor.spawnStage(assignment({ stage: 'audit' }));
    expect(second.ok).toBe(false);
    expect(second.why).toContain('уже идёт');
  });

  it('квота — это счёт живых детей, а не число в настройке', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    const other = supervisor.spawnStage(assignment({ taskId: '0002-two' }));
    expect(other.ok).toBe(false);
    expect(supervisor.busy()).toBe(1);
  });

  it('при большей квоте второй этап проходит', () => {
    const { supervisor } = harness({ config: { maxConcurrent: 2 } });
    supervisor.spawnStage(assignment());
    expect(supervisor.spawnStage(assignment({ taskId: '0002-two' })).ok).toBe(true);
  });

  it('идентификатор сессии выдаётся заранее и запоминается', () => {
    // Тогда возобновлять есть что даже после падения супервизора.
    const { supervisor, saved } = harness();
    const { sessionId } = supervisor.spawnStage(assignment());
    expect(sessionId).toBeTruthy();
    expect(saved.at(-1)['0001-one:design']).toBe(sessionId);
  });

  it('память о сессии переживает перезапуск', () => {
    const { supervisor } = harness({ stages: { '0001-one:design': 'прежняя' } });
    expect(supervisor.lastSession('0001-one', 'design')).toBe('прежняя');
    expect(supervisor.lastSession('0001-one', 'audit')).toBe(null);
  });

  it('забытая сессия не возобновляется и забвение переживает перезапуск', () => {
    // Задачу вернули на пройденный этап: возобновлённая сессия ответила бы
    // из своей памяти «всё сделано», не читая замечания, ради которого её
    // и позвали. Забвение обязано лечь на диск — иначе перезапуск супервизора
    // воскресит ту же память.
    const { supervisor, saved } = harness({
      stages: { '0001-one:design': 'прежняя', '0001-one:audit': 'аудиторская' },
    });
    expect(supervisor.forgetSession('0001-one', 'design')).toBe(true);
    expect(supervisor.lastSession('0001-one', 'design')).toBe(null);
    expect(saved.at(-1)).not.toHaveProperty('0001-one:design');
    // Чужую сессию забвение не задевает.
    expect(supervisor.lastSession('0001-one', 'audit')).toBe('аудиторская');
  });

  it('забывать нечего — и говорится об этом прямо', () => {
    const { supervisor, saved } = harness();
    expect(supervisor.forgetSession('0001-one', 'design')).toBe(false);
    expect(saved).toEqual([]);
  });
});

describe('этап кончился', () => {
  it('отчёт уходит в очередь на перенос', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(supervisor.reports).toHaveLength(1);
    expect(supervisor.reports[0]).toMatchObject({ taskId: '0001-one', outcome: 'done' });
    expect(supervisor.running()).toEqual([]);
  });

  it('место освобождается для следующей задачи', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());
    expect(supervisor.spawnStage(assignment({ taskId: '0002-two' })).ok).toBe(true);
  });

  it('идентификатор из ответа точнее выданного и замещает его', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());
    expect(supervisor.lastSession('0001-one', 'design')).toBe('сессия-от-приложения');
  });

  it('приписка вокруг отчёта его не портит', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: `Готово!\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`` }));
    expect(supervisor.reports).toHaveLength(1);
  });
});

describe('отказанные действия лишают отчёт доверия', () => {
  // Прежде неразрешённое действие вешало сессию насмерть — беда была
  // заметной. Теперь оно даёт отказ, и этап тихо докладывает об успехе,
  // часть которого ему не позволили сделать.
  const denied = {
    permission_denials: [
      { tool_name: 'PowerShell', tool_input: { command: 'npx --yes openspec' } },
    ],
  };

  it('отчёт не принимается', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope(denied));
    expect(supervisor.reports).toEqual([]);
  });

  it('отказ назван в журнале целиком: это указание, где скилл разошёлся с делом', async () => {
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope(denied));
    expect(logged.join()).toContain('PowerShell');
    expect(logged.join()).toContain('openspec');
  });
});

describe('этап не дошёл до отчёта', () => {
  it('неразобравшийся вывод отчётом не считается и назван вслух', async () => {
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'я всё сделал, а отчёт забыл' }));
    expect(supervisor.reports).toEqual([]);
    expect(logged.join()).toContain('не разобрался');
  });

  it('отчёт о чужом этапе не применяется', async () => {
    // Он посчитан по другой картине мира: применить молча значило бы
    // двинуть задачу неизвестно куда.
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, stage: 'audit' }) }));
    expect(supervisor.reports).toEqual([]);
    expect(logged.join()).toContain('не принят');
  });

  it('ненулевой код возврата отчёта не даёт', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope(), 1);
    expect(supervisor.reports).toEqual([]);
  });

  it('место всё равно освобождается: иначе задача встала бы навсегда', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'без отчёта' }));
    expect(supervisor.running()).toEqual([]);
  });
});

describe('разбор исхода не роняет супервизор', () => {
  it('падение на одном отчёте освобождает место, а не останавливает всё', async () => {
    // Супервизор ведёт все задачи разом: упав на разборе одного отчёта,
    // он остановил бы конвейер целиком.
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    // Ответ, на котором разбор споткнётся: `result` не строка и не объект.
    await answer(envelope({ result: { неожиданно: true } }));

    expect(supervisor.running()).toEqual([]);
    expect(logged.join()).not.toBe('');
  });
});

describe('остановка', () => {
  it('снимает всех детей', () => {
    const { supervisor, children, killed } = harness({ config: { maxConcurrent: 2 } });
    supervisor.spawnStage(assignment());
    supervisor.spawnStage(assignment({ taskId: '0002-two' }));

    supervisor.stopAll();

    expect(killed).toEqual(children.map((child) => child.pid));
  });
});
