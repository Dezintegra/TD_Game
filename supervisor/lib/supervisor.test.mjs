import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createSupervisor } from './supervisor.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { TAG } from './console.mjs';

/**
 * Проверки хозяйства идущих этапов.
 *
 * Порождение подставное, поэтому проверяется ровно то, ради чего супервизор
 * и написан: квота прямым счётом детей, отчёт из вывода, память об этапе
 * ради возобновления и отметка его начала.
 *
 * Судить отказанные действия супервизор больше не берётся: здесь отчёт ещё
 * не разобран, и след этапа проверить нечем. Его дело — назвать отказы
 * в журнале цикла и увезти их вместе с отчётом.
 */

const { config } = resolveConfig({
  commands: { verify: 'x', deploy: 'x', perf: 'x' },
  worktreeDir: '.claude/worktrees',
});

const NOW = '2026-08-31T12:00:00+03:00';

function harness(over = {}) {
  const children = [];
  const killed = [];
  const logged = [];
  const saved = [];

  const spawn = () => {
    if (over.spawnThrows) throw new Error(over.spawnThrows);
    const child = new EventEmitter();
    // Номер процесса — признак рождения. Подставной `spawn` умеет и не давать
    // его: так ведёт себя настоящий на несуществующей команде.
    if (!over.stillborn) child.pid = 1000 + children.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    return child;
  };

  const logsAsked = [];
  const probed = [];
  const wrote = [];
  const said = [];

  const supervisor = createSupervisor({
    config: { ...config, ...over.config },
    root: '/repo',
    spawn,
    killTree: (pid) => killed.push(pid),
    // Опрос системы подставной: живых процессов проверки не поднимают.
    // По умолчанию отвечает «процесс жив, образ claude.exe» — так выглядит
    // только что порождённый этап.
    probe:
      over.probe === null
        ? null
        : (pid) => {
            probed.push(pid);
            return over.probe ? over.probe(pid) : { known: true, alive: true, image: 'claude.exe' };
          },
    machine: over.machine ?? 'станция-1',
    supervisorPid: over.supervisorPid ?? 777,
    now: over.now ?? (() => NOW),
    nowMs: over.nowMs ?? (() => 1_000_000),
    saveStages: (stages) => saved.push(JSON.parse(JSON.stringify(stages))),
    stages: over.stages ?? {},
    log: (line) => logged.push(line),
    // Запись лога этапа собирается так же, как журнал цикла, и по той же
    // причине: умолчание в `createSupervisor` — пустая функция, и без этого
    // довода содержимое лога не видно ни одной проверке. Шапку его до сих пор
    // не читал никто, кроме человека, — оттого расхождение в ней и прожило
    // так долго.
    writeStageLog: (taskId, stage, text) => wrote.push({ taskId, stage, text }),
    // Рассказчик подставной, и метка запоминается отдельно от текста: судить
    // её по знакам в строке значило бы проверять раскраску, а не выбор.
    say: { line: (tag, text) => said.push({ tag, text }) },
    readStageLog: (taskId, stage) => {
      logsAsked.push(`${taskId}:${stage}`);
      return { stage, path: `.pipeline/logs/${taskId}-${stage}.log`, text: 'отказов:   3' };
    },
  });

  /** Довести последний порождённый процесс до конца с таким выводом. */
  const answer = async (envelope, code = 0) => {
    const child = children.at(-1);
    child.stdout.emit('data', JSON.stringify(envelope));
    child.emit('close', code);
    // Дать промису завершения дойти до обработчика.
    await sleep(0);
  };

  return { supervisor, children, killed, logged, saved, answer, logsAsked, probed, wrote, said };
}

/** Строка итога этапа из всего, что рассказчик напечатал. */
const finishedLine = (said) => said.find((line) => line.text.includes('завершён:'));

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

  it('разбору берётся лог того этапа, из которого задача упала', () => {
    // Имя лога складывается из задачи и этапа, а этап хранит сама задача —
    // состоянием возврата. Угадывать его по журналу было бы гаданием.
    const { supervisor, logsAsked } = harness();
    supervisor.spawnStage(
      assignment({
        stage: 'postmortem',
        task: { id: '0001-one', status: 'postmortem', returnTo: 'implement', title: 'проба' },
      }),
    );
    expect(logsAsked).toEqual(['0001-one:implement']);
  });

  it('прочим этапам лог не читается вовсе', () => {
    const { supervisor, logsAsked } = harness();
    supervisor.spawnStage(assignment());
    expect(logsAsked).toEqual([]);
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
    expect(saved.at(-1)['0001-one:design'].sessionId).toBe(sessionId);
  });

  it('память о сессии переживает перезапуск', () => {
    const { supervisor } = harness({
      stages: { '0001-one:design': { sessionId: 'прежняя', startedAt: NOW } },
    });
    expect(supervisor.lastSession('0001-one', 'design')).toBe('прежняя');
    expect(supervisor.lastSession('0001-one', 'audit')).toBe(null);
  });

  it('забытая сессия не возобновляется и забвение переживает перезапуск', () => {
    // Задачу вернули на пройденный этап: возобновлённая сессия ответила бы
    // из своей памяти «всё сделано», не читая замечания, ради которого её
    // и позвали. Забвение обязано лечь на диск — иначе перезапуск супервизора
    // воскресит ту же память.
    const { supervisor, saved } = harness({
      stages: {
        '0001-one:design': { sessionId: 'прежняя', startedAt: NOW },
        '0001-one:audit': { sessionId: 'аудиторская', startedAt: NOW },
      },
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

describe('несостоявшийся запуск', () => {
  // Отказ порождения и упавший этап — разные беды, и лечатся они по-разному.
  // Разбирается это полем `reason`, а не текстом сообщения: сравнение русских
  // строк между файлами превратило бы правку формулировки в подмену смысла.

  it('теснота называется занятостью, а не поломкой', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    expect(supervisor.spawnStage(assignment({ taskId: '0002-two' })).reason).toBe('busy');
    expect(supervisor.spawnStage(assignment({ stage: 'audit' })).reason).toBe('busy');
  });

  it('теснота не делает этап идущим', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    supervisor.spawnStage(assignment({ taskId: '0002-two' }));
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'design' }]);
  });

  it('процесс без номера запущенным не считается', () => {
    // Так `spawn` отвечает на несуществующую команду: объект возвращает сразу,
    // а `ENOENT` присылает событием позже. Дожидаться события нельзя.
    const { supervisor } = harness({ stillborn: true });
    const spawned = supervisor.spawnStage(assignment());

    expect(spawned.ok).toBe(false);
    expect(spawned.reason).toBe('not-born');
    expect(supervisor.running()).toEqual([]);
  });

  it('идентификатор незаведённой сессии не запоминается', () => {
    // Иначе следующее продолжение ушло бы возобновлять то, чего не было,
    // и умерло бы за секунды с «No conversation found with session ID».
    const { supervisor, saved } = harness({ stillborn: true });
    supervisor.spawnStage(assignment());

    expect(supervisor.lastSession('0001-one', 'design')).toBe(null);
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(null);
    expect(saved).toEqual([]);
  });

  it('о несостоявшемся запуске не пишут «запущен»', () => {
    const { supervisor, logged } = harness({ stillborn: true });
    supervisor.spawnStage(assignment());
    expect(logged.join()).not.toContain('запущен');
  });

  it('упавшее порождение — тоже не рождение', () => {
    // Так выглядел `spawn ENAMETOOLONG`, отбивший запуск двенадцати задачам
    // за ночь 31.08–01.09.2026.
    const { supervisor } = harness({ spawnThrows: 'spawn ENAMETOOLONG' });
    const spawned = supervisor.spawnStage(assignment());

    expect(spawned.reason).toBe('not-born');
    expect(spawned.why).toContain('ENAMETOOLONG');
    expect(supervisor.running()).toEqual([]);
  });

  it('удавшееся порождение по-прежнему помнит сессию и говорит о запуске', () => {
    const { supervisor, logged } = harness();
    const spawned = supervisor.spawnStage(assignment());

    expect(spawned.ok).toBe(true);
    expect(supervisor.lastSession('0001-one', 'design')).toBe(spawned.sessionId);
    expect(logged.join()).toContain('запущен');
  });
});

describe('отметка начала этапа', () => {
  // Ею отличают свежий коммит от чужого, когда отказ судят по следу.
  const LATER = '2026-08-31T13:00:00+03:00';

  it('первый заход её ставит', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(NOW);
  });

  it('продолжение её не двигает', async () => {
    // Продолжатель приходит к уже сделанным коммитам: сдвинув отметку,
    // он объявил бы их чужими и отправил бы задачу в разбор ни за что.
    let clock = NOW;
    const { supervisor, answer } = harness({ now: () => clock });
    supervisor.spawnStage(assignment());
    clock = LATER;
    await answer(envelope({ result: 'без отчёта' }));

    supervisor.spawnStage(assignment({ continuation: true }));
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(NOW);
  });

  it('отчёт замещает идентификатор сессии, но не отметку', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(supervisor.lastSession('0001-one', 'design')).toBe('сессия-от-приложения');
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(NOW);
  });

  it('забвение стирает и отметку', () => {
    const { supervisor } = harness();
    supervisor.spawnStage(assignment());
    supervisor.forgetSession('0001-one', 'design');
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(null);
  });

  it('файл прежней раскладки читается, а отметка выходит пустой', () => {
    // Так выглядит первый запуск после обновления: супервизор перезапускает
    // сторож, и он приходит к файлу, где значением была голая строка.
    const { supervisor } = harness({ stages: { '0001-one:design': 'прежняя' } });
    expect(supervisor.lastSession('0001-one', 'design')).toBe('прежняя');
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(null);
  });
});

describe('дескриптор живого этапа', () => {
  // Всё изменение затевалось ради него. Пока живость жила единственным
  // экземпляром в памяти, преемник, взявший замок, не видел ни одного этапа,
  // порождённого прежним супервизором: он выдавал живому этапу продолжение
  // и заводил второй процесс на его рабочем дереве (0074, 0030).

  it('после порождения лежит на диске с номером процесса и опознанием', () => {
    const { supervisor, saved, children } = harness();
    supervisor.spawnStage(assignment());

    const live = saved.at(-1)['0001-one:design'].live;
    expect(live).toMatchObject({
      pid: children.at(-1).pid,
      image: 'claude.exe',
      machine: 'станция-1',
      supervisorPid: 777,
    });
    expect(live.startedAt).toBe(NOW);
    expect(live.timeoutMs).toBeGreaterThan(0);
  });

  it('опознание спрашивается у системы номером порождённого процесса', () => {
    // Не выводится из настройки: `claudeCommand` равно «claude», на Windows
    // это обёртка `.cmd`, и образ живого процесса ей не равен — сверка
    // с настройкой давала бы несовпадение всегда.
    const { supervisor, children, probed } = harness();
    supervisor.spawnStage(assignment());
    expect(probed).toEqual([children.at(-1).pid]);
  });

  it('не спросилось — дескриптор всё равно ложится, но без опознания', () => {
    const { supervisor, saved, logged } = harness({
      probe: () => ({ known: false, alive: false, image: null }),
    });
    supervisor.spawnStage(assignment());

    const live = saved.at(-1)['0001-one:design'].live;
    expect(live.pid).toBeTruthy();
    expect(live.image).toBeUndefined();
    expect(logged.join()).toContain('без опознания');
  });

  it('упавший опрос системы порождение не отменяет', () => {
    // Супервизор ведёт все задачи разом: падать на опросе одного процесса
    // он не вправе, а этап уже порождён и работает.
    const { supervisor, saved } = harness({
      probe: () => {
        throw new Error('нет такой команды');
      },
    });
    expect(supervisor.spawnStage(assignment()).ok).toBe(true);
    expect(saved.at(-1)['0001-one:design'].live.image).toBeUndefined();
  });

  it('после завершения этапа дескриптора нет, а память о сессии осталась', async () => {
    const { supervisor, saved, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(saved.at(-1)['0001-one:design'].live).toBeUndefined();
    expect(supervisor.lastSession('0001-one', 'design')).toBe('сессия-от-приложения');
    expect(supervisor.stageStartedAt('0001-one', 'design')).toBe(NOW);
  });

  it('дескриптор стирается и при исходе без отчёта', async () => {
    // Оставленный, он объявил бы задачу занятой навсегда — и это было бы
    // хуже прежней беды, а не лучше.
    const { supervisor, saved, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'без отчёта', session_id: null }));

    expect(saved.at(-1)['0001-one:design'].live).toBeUndefined();
  });

  it('несостоявшееся порождение дескриптора не оставляет', () => {
    const { supervisor, saved } = harness({ stillborn: true });
    supervisor.spawnStage(assignment());
    expect(saved).toEqual([]);
  });

  it('запись прежней раскладки читается без дескриптора и без ошибки', () => {
    // Так выглядит первый запуск после обновления: значением была голая
    // строка, и отсутствие дескриптора означает «этап не идёт».
    const { supervisor } = harness({ stages: { '0001-one:design': 'прежняя' } });
    expect(supervisor.lastSession('0001-one', 'design')).toBe('прежняя');
    expect(supervisor.running()).toEqual([]);
  });
});

describe('сироты при запуске', () => {
  // Ради этого и затевалось изменение. Прежде преемник, взявший замок, не видел
  // ни одного этапа, порождённого прежним супервизором: сканер спрашивал
  // живость, получал «нет» и следующим же оборотом выдавал живому этапу
  // продолжение, заводя второй процесс на его рабочем дереве.

  /** Состояние на диске с дескриптором живого этапа. */
  const withLive = (over = {}) => ({
    '0001-one:implement': {
      sessionId: 'прежняя',
      startedAt: NOW,
      live: {
        pid: 29704,
        image: 'claude.exe',
        machine: 'станция-1',
        supervisorPid: 111,
        startedAt: NOW,
        startedMs: 900_000,
        timeoutMs: 3_600_000,
        ...over,
      },
    },
  });

  it('живой опознанный сирота числится идущим этапом', () => {
    const { supervisor } = harness({ stages: withLive() });
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'implement' }]);
    expect(supervisor.busy()).toBe(1);
  });

  it('опознание сверяется с записанным, а не с настройкой', () => {
    // Номер занял посторонний процесс: дескриптор протух. Этап не идёт,
    // а сам процесс не наш, и снимать его нельзя.
    const { supervisor, killed } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: true, image: 'chrome.exe' }),
    });
    expect(supervisor.running()).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('исчезнувший процесс освобождает задачу и назван в журнале цикла', () => {
    const { supervisor, logged } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(supervisor.running()).toEqual([]);
    expect(logged.join()).toContain('осиротел');
  });

  it('сирота без опознания в дескрипторе числится идущим', () => {
    // Опросить систему при рождении могло не удаться. Объявить такого
    // исчезнувшим — это ровно выдача продолжения живому этапу.
    const { supervisor } = harness({
      stages: withLive({ image: undefined }),
      probe: () => ({ known: true, alive: true, image: 'claude.exe' }),
    });
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'implement' }]);
  });

  it('неотвечающий опрос системы тоже оставляет этап идущим', () => {
    const { supervisor } = harness({
      stages: withLive(),
      probe: () => ({ known: false, alive: false, image: null }),
    });
    expect(supervisor.running()).toEqual([{ taskId: '0001-one', stage: 'implement' }]);
  });

  it('дескриптор исчезнувшего остаётся на диске до записи исхода в журнал', () => {
    // Обрыв между «убрал из перечня» и «записал в журнал» обязан оставлять
    // дескриптор на месте: повторная запись стоит одного лишнего
    // комментария, потерянная — необъяснимого провала в журнале задачи.
    const { supervisor, saved } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(saved).toEqual([]);

    expect(supervisor.forgetOrphan('0001-one', 'implement')).toBe(true);
    expect(saved.at(-1)['0001-one:implement'].live).toBeUndefined();
    expect(supervisor.orphanOutcomes).toEqual([]);
  });

  it('дескриптор чужой станции не судится, стирается и назван в журнале', () => {
    const { supervisor, saved, logged, probed } = harness({
      stages: withLive({ machine: 'станция-2' }),
    });
    expect(supervisor.running()).toEqual([]);
    expect(saved.at(-1)['0001-one:implement'].live).toBeUndefined();
    expect(logged.join()).toContain('станция-2');
    // И опрашивать его незачем: номер чужой машины здесь не значит ничего.
    expect(probed).toEqual([]);
  });

  it('память о сессии сироты остаётся: её и будет возобновлять продолжатель', () => {
    const { supervisor } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(supervisor.lastSession('0001-one', 'implement')).toBe('прежняя');
    expect(supervisor.stageStartedAt('0001-one', 'implement')).toBe(NOW);
  });

  it('второго процесса по задаче живого сироты не порождается', () => {
    const { supervisor, children } = harness({ stages: withLive() });
    const spawned = supervisor.spawnStage(assignment({ taskId: '0001-one', stage: 'implement' }));

    expect(spawned.ok).toBe(false);
    expect(spawned.reason).toBe('busy');
    expect(children).toEqual([]);
  });
});

describe('обход сирот по обороту', () => {
  // Сирота живёт минутами и часами, поэтому судить его один раз при запуске
  // мало: он кончится посреди работы супервизора, и место должно
  // освободиться тогда же, а не при следующем перезапуске.

  /** Дескриптор с управляемым возрастом: начат в 900 000, срок — час. */
  const withLive = (over = {}) => ({
    '0001-one:implement': {
      sessionId: 'прежняя',
      startedAt: NOW,
      live: {
        pid: 29704,
        image: 'claude.exe',
        machine: 'станция-1',
        supervisorPid: 111,
        startedAt: NOW,
        startedMs: 900_000,
        timeoutMs: 3_600_000,
        ...over,
      },
    },
  });

  /** Часы: 900 000 — миг рождения, дальше — сколько прошло. */
  const at = (ms) => () => 900_000 + ms;

  it('кончившийся посреди работы уходит из перечня в тот же обход', () => {
    let alive = true;
    const { supervisor } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive, image: 'claude.exe' }),
    });
    expect(supervisor.running()).toHaveLength(1);

    alive = false;
    supervisor.sweep();
    expect(supervisor.running()).toEqual([]);
  });

  it('исход исчезнувшего встаёт в очередь с номером процесса и отметкой начала', () => {
    const { supervisor } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(supervisor.orphanOutcomes).toHaveLength(1);
    expect(supervisor.orphanOutcomes[0]).toMatchObject({
      taskId: '0001-one',
      stage: 'implement',
      pid: 29704,
      startedAt: NOW,
      outcome: 'gone',
    });
  });

  it('переживший срок опознанный снимается поддеревом', () => {
    const { supervisor, killed } = harness({
      stages: withLive(),
      nowMs: at(3_600_001),
    });
    expect(killed).toEqual([29704]);
    expect(supervisor.orphanOutcomes[0].outcome).toBe('killed');
    expect(supervisor.running()).toEqual([]);
  });

  it('срок берётся из дескриптора, а не назначается заново', () => {
    // Этапу отпущено то, что ему отпустили при запуске: час у дескриптора
    // и час не прошёл — значит он идёт, чего бы ни стояло в настройке.
    const { supervisor, killed } = harness({
      stages: withLive(),
      nowMs: at(3_599_000),
    });
    expect(killed).toEqual([]);
    expect(supervisor.running()).toHaveLength(1);
  });

  it('протухший дескриптор исход даёт, а процесс не снимает', () => {
    // Номер переиспользован системой: под ним работает кто угодно, и снятие
    // поддеревом унесло бы постороннее дерево процессов рабочей станции.
    const { supervisor, killed } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: true, image: 'chrome.exe' }),
      nowMs: at(3_600_001),
    });
    expect(killed).toEqual([]);
    expect(supervisor.orphanOutcomes[0].outcome).toBe('stale');
  });

  it('неопознанный в пределах срока остаётся идущим и назван один раз', () => {
    const { supervisor, logged } = harness({
      stages: withLive(),
      probe: () => ({ known: false, alive: false, image: null }),
      nowMs: at(60_000),
    });
    supervisor.sweep();
    supervisor.sweep();

    expect(supervisor.running()).toHaveLength(1);
    expect(logged.filter((line) => line.includes('не опознаётся'))).toHaveLength(1);
  });

  it('неопознанный за сроком уходит из перечня, но не снимается', () => {
    const { supervisor, killed } = harness({
      stages: withLive(),
      probe: () => ({ known: false, alive: false, image: null }),
      nowMs: at(3_600_001),
    });
    expect(supervisor.running()).toEqual([]);
    expect(killed).toEqual([]);
    expect(supervisor.orphanOutcomes[0].outcome).toBe('left');
  });

  it('дескриптор без опознания судится тем же правилом', () => {
    // Опрос при рождении мог не удаться. Живой процесс с таким дескриптором
    // неотличим от неопознанного, и снимать его нельзя точно так же.
    const { supervisor, killed } = harness({
      stages: withLive({ image: undefined }),
      nowMs: at(3_600_001),
    });
    expect(killed).toEqual([]);
    expect(supervisor.orphanOutcomes[0].outcome).toBe('left');
  });

  it('исход одного сироты не тянет за собой второго', () => {
    const stages = {
      ...withLive(),
      '0002-two:audit': {
        sessionId: 'вторая',
        startedAt: NOW,
        live: {
          pid: 30000,
          image: 'claude.exe',
          machine: 'станция-1',
          supervisorPid: 111,
          startedAt: NOW,
          startedMs: 900_000,
          timeoutMs: 3_600_000,
        },
      },
    };
    const { supervisor } = harness({
      stages,
      config: { maxConcurrent: 3 },
      probe: (pid) => ({ known: true, alive: pid !== 29704, image: 'claude.exe' }),
    });

    expect(supervisor.running()).toEqual([{ taskId: '0002-two', stage: 'audit' }]);
    expect(supervisor.orphanOutcomes.map((item) => item.taskId)).toEqual(['0001-one']);
  });

  it('забыть можно только записанный исход, и чужой при этом не трогается', () => {
    const { supervisor, saved } = harness({
      stages: withLive(),
      probe: () => ({ known: true, alive: false, image: null }),
    });
    expect(supervisor.forgetOrphan('0002-two', 'audit')).toBe(false);
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

describe('отказанные действия едут вместе с отчётом', () => {
  // Прежде отчёт при непустом перечне отказов не принимался вовсе. Мерка
  // оказалась слишком грубой: вечер 31.08.2026 дал шесть отброшенных отчётов
  // подряд, и ни один не потерян из-за настоящей беды. Судить отказ по следу
  // этапа здесь нечем — отчёт ещё не разобран, — и потому суд переехал
  // в перенос отчёта, а супервизор остался хозяином процессов.
  const denied = {
    permission_denials: [
      { tool_name: 'PowerShell', tool_input: { command: 'npx --yes openspec' } },
    ],
  };

  it('отчёт кладётся в очередь переноса, а отказы едут в нём', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope(denied));

    expect(supervisor.reports).toHaveLength(1);
    expect(supervisor.reports[0].denials).toEqual(denied.permission_denials);
  });

  it('отказ назван в журнале целиком: это указание, где скилл разошёлся с делом', async () => {
    const { supervisor, answer, logged } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope(denied));
    expect(logged.join()).toContain('PowerShell');
    expect(logged.join()).toContain('openspec');
  });

  it('без отказов поле остаётся пустым перечнем', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());
    expect(supervisor.reports[0].denials).toEqual([]);
  });

  it('отчёт о чужом этапе не спасают никакие отказы', async () => {
    const { supervisor, answer } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ ...denied, result: JSON.stringify({ ...report, stage: 'audit' }) }));
    expect(supervisor.reports).toEqual([]);
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

describe('лог этапа', () => {
  // Лог этапа читает ровно один этап — разбор, — и читает после падения,
  // когда самого процесса давно нет. Поэтому он обязан лечь на диск при
  // ЛЮБОМ исходе и нести то, чего в отчёте нет по устройству: код возврата,
  // отказанные действия и вывод целиком.

  it('пишется на этап, оставивший отчёт', async () => {
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(wrote).toHaveLength(1);
    expect(wrote[0].taskId).toBe('0001-one');
    expect(wrote[0].stage).toBe('design');
  });

  it('пишется и на этап, отчёта не оставивший', async () => {
    // Как раз тогда он единственное, что осталось от сессии.
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'я всё сделал, а отчёт забыл' }), 1);

    expect(wrote).toHaveLength(1);
  });

  it('несёт код возврата', async () => {
    // Ищем с любым отступом: колонку значений задаёт самое длинное имя поля,
    // и сторож не должен падать от перевыравнивания шапки.
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ is_error: true }), 3);

    expect(wrote[0].text).toMatch(/код:\s+3/);
  });

  it('несёт перечень отказанных действий', async () => {
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(
      envelope({
        permission_denials: [{ tool_name: 'PowerShell', tool_input: { command: 'pnpm install' } }],
      }),
    );

    expect(wrote[0].text).toContain('--- отказанные действия ---');
    expect(wrote[0].text).toContain('PowerShell');
    expect(wrote[0].text).toContain('pnpm install');
    expect(wrote[0].text).toMatch(/отказов:\s+1/);
  });

  it('называет ответ сессии и исход отчёта разными словами', async () => {
    // Ровно та ловушка, ради которой всё затеяно: процесс отработал и вернул
    // разбираемый ответ (`done`), а этап отчитался неудачей.
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, outcome: 'failed' }) }));

    expect(wrote[0].text).toMatch(/ответ сессии:\s+done/);
    expect(wrote[0].text).toMatch(/исход отчёта:\s+failed/);
  });

  it('слова «исход» без уточнения в шапке не остаётся', async () => {
    // Знакомое слово остановит читателя раньше, чем он дойдёт до нужного
    // поля, — потому оно и не сохранено синонимом ни одного из двух.
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(wrote[0].text).not.toMatch(/^исход:/m);
  });

  it('отчёт не разобрался — сказано это и сказана причина', async () => {
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'я всё сделал, а отчёт забыл' }));

    expect(wrote[0].text).toMatch(/исход отчёта:\s+отчёта нет — .*объекта JSON/);
  });

  it('ответа нет вовсе — это отличают от испорченного отчёта', async () => {
    // Снятие по сроку: сессию оборвали на середине работы, и отчёта она
    // не начинала писать. Причина разбора была бы здесь формально верной
    // и увела бы разбор искать испорченный отчёт.
    const { supervisor, children, wrote } = harness({
      config: { stageTimeoutMinutes: { ...config.stageTimeoutMinutes, design: 0.0005 } },
    });
    supervisor.spawnStage(assignment());
    await sleep(60);
    children.at(-1).emit('close', 0);
    await sleep(0);

    expect(wrote[0].text).toMatch(/ответ сессии:\s+timeout/);
    expect(wrote[0].text).toMatch(/исход отчёта:\s+отчёта нет — сессия ответа не оставила/);
  });

  it('отчёт о чужом этапе назван неприменённым', async () => {
    const { supervisor, answer, wrote } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, stage: 'audit' }) }));

    // Целой строкой, а не по слову «audit»: оно есть и в stdout, и сторож
    // по нему зеленел бы вхолостую.
    expect(wrote[0].text).toMatch(
      /исход отчёта:\s+done \(отчёт об этапе «audit», а шёл «design» — не применён\)/,
    );
  });

  it('несёт stdout целиком, а не разобранную его часть', async () => {
    // Разбор берёт из вывода последний годный объект. Всё, что было до него,
    // разбору падения нужнее всего — там и лежит рассказ о том, что пошло
    // не так.
    const { supervisor, children, wrote } = harness();
    supervisor.spawnStage(assignment());
    const child = children.at(-1);
    child.stdout.emit('data', 'приписка до конверта\n');
    child.stdout.emit('data', JSON.stringify(envelope()));
    child.emit('close', 0);
    await sleep(0);

    expect(wrote[0].text).toContain('--- stdout ---');
    expect(wrote[0].text).toContain('приписка до конверта');
  });
});

describe('строка итога этапа на консоли', () => {
  // Консоль смотрят, а логи открывают: та же подмена здесь попадается чаще.
  // Человек, отошедший на час, читает полосу строк и различает их цветом
  // раньше, чем словами.

  it('называет оба значения', async () => {
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, outcome: 'failed' }) }));

    expect(finishedLine(said).text).toContain('ответ done');
    expect(finishedLine(said).text).toContain('исход отчёта failed');
  });

  it('отчитавшийся неудачей получает предупреждающую метку при нулевом коде', async () => {
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, outcome: 'failed' }) }));

    expect(finishedLine(said).tag).toBe(TAG.warn);
  });

  it('спокойная метка причитается только отчитавшемуся done', async () => {
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope());

    expect(finishedLine(said).tag).toBe(TAG.stage);
  });

  it('отчёт о чужом этапе спокойным не считается', async () => {
    // Он не применялся вовсе, каким бы ни был его исход.
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: JSON.stringify({ ...report, stage: 'audit' }) }));

    expect(finishedLine(said).tag).toBe(TAG.warn);
  });

  it('отсутствие отчёта спокойным не считается', async () => {
    const { supervisor, answer, said } = harness();
    supervisor.spawnStage(assignment());
    await answer(envelope({ result: 'я всё сделал, а отчёт забыл' }));

    expect(finishedLine(said).tag).toBe(TAG.warn);
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

  it('живого сироту не трогает, и дескриптор его остаётся на диске', () => {
    // Своего ребёнка супервизор снимает И записывает исход. Чужого он снял бы,
    // не сумев записать: очередь исходов в этот миг исполнять уже некому.
    // Вышла бы та же потеря, ради отмены которой всё и затеяно.
    const { supervisor, killed, saved } = harness({
      stages: {
        '0001-one:implement': {
          sessionId: 'прежняя',
          startedAt: NOW,
          live: {
            pid: 29704,
            image: 'claude.exe',
            machine: 'станция-1',
            supervisorPid: 111,
            startedAt: NOW,
            startedMs: 900_000,
            timeoutMs: 3_600_000,
          },
        },
      },
    });

    supervisor.stopAll();

    expect(killed).toEqual([]);
    expect(saved).toEqual([]);
  });
});
