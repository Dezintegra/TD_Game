import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createKillTree, readAnswer, startStage } from './run-stage.mjs';

/**
 * Проверки хозяина у процесса.
 *
 * Порождение и снятие подставные: живой запуск стоит десяток секунд и денег,
 * и проверять на нём срок, несостоявшийся запуск и разбор ответа значило бы
 * не проверять их вовсе. Зато дорогие и редкие ходы событий — этап,
 * не уложившийся в срок; команда, которой нет; ответ, который не разобрался —
 * проверяются за миллисекунды.
 */

/** Подставной процесс: те же события, что у настоящего. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // Вход тоже подставной: он помнит, что ему подали и закрыли ли его.
  // Незакрытый вход — не мелочь: приложение ждёт конца потока и без него
  // простоит до истечения срока этапа, ничего не сделав.
  const stdin = new EventEmitter();
  stdin.written = [];
  stdin.closed = false;
  stdin.end = (text) => {
    if (text != null) stdin.written.push(text);
    stdin.closed = true;
  };
  child.stdin = stdin;
  return child;
}

function harness({ timeoutMs = 1000, command, onEvent, onStderr } = {}) {
  const child = fakeChild();
  const killed = [];
  const timers = [];
  const events = [];
  const errors = [];
  const spawned = [];
  const handle = startStage({
    command: command ?? { program: 'claude', args: ['-p'], cwd: '/repo', stdin: 'делай' },
    timeoutMs,
    spawn: (program, list, options) => {
      spawned.push({ program, list, options });
      return child;
    },
    killTree: (pid) => killed.push(pid),
    onEvent:
      onEvent ??
      ((event, line) => {
        events.push({ event, line });
      }),
    onStderr:
      onStderr ??
      ((line) => {
        errors.push(line);
      }),
    setTimer: (fn) => {
      timers.push(fn);
      return { fn };
    },
    clearTimer: () => {},
  });
  return {
    child,
    killed,
    handle,
    events,
    errors,
    spawned,
    fire: () => timers.forEach((fn) => fn()),
  };
}

describe('окно потомка не показывается', () => {
  it('этап порождается со скрытой консолью', () => {
    // Супервизор запускается с `detached: true`, а это на Windows означает
    // процесс ВОВСЕ БЕЗ КОНСОЛИ: каждый его потомок получает свежую и видимую,
    // окна вспыхивают десятками и перехватывают фокус у работающего человека.
    // Проверено делом 02.09.2026 — и потому проверяется здесь, а не на глаз:
    // пропажу этого флага иначе заметит только тот, у кого мигает экран.
    const { spawned } = harness();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].options.windowsHide).toBe(true);
  });

  it('рабочий каталог при этом не теряется', () => {
    const { spawned } = harness();
    expect(spawned[0].options.cwd).toBe('/repo');
  });
});

describe('промпт подаётся на вход', () => {
  it('текст назначения уходит в stdin и вход закрывается', async () => {
    // Аргументы командной строки на Windows ограничены, и назначение растущей
    // задачи однажды перестаёт в них влезать: 01.09.2026 порождение упало
    // с `spawn ENAMETOOLONG` двадцать шесть раз и держало четыре задачи.
    const { child } = harness();
    expect(child.stdin.written).toEqual(['делай']);
    expect(child.stdin.closed).toBe(true);
  });

  it('без промпта вход не трогается вовсе', async () => {
    // Иначе закрытый впустую вход отличался бы от неоткрытого, а этапу
    // без назначения подавать нечего.
    const { child } = harness({ command: { program: 'claude', args: ['-p'], cwd: '/repo' } });
    expect(child.stdin.written).toEqual([]);
    expect(child.stdin.closed).toBe(false);
  });

  it('оборванный вход не роняет супервизор', async () => {
    // Ошибка записи в закрывшийся процесс — обычное дело; исход этапа
    // разберут как всегда, а супервизор ведёт все задачи разом и падать
    // из-за одной не вправе.
    const { child, handle } = harness();
    expect(() => child.stdin.emit('error', new Error('канал закрыт'))).not.toThrow();
    child.emit('close', 0);
    await handle.finished;
  });
});

describe('этап отработал', () => {
  it('отдаёт код возврата и собранный вывод', async () => {
    const { child, handle } = harness();
    child.stdout.emit('data', '{"is_error":false,');
    child.stdout.emit('data', '"result":"готово"}');
    child.emit('close', 0);

    const run = await handle.finished;
    expect(run.code).toBe(0);
    expect(run.killedBy).toBe(null);
    expect(readAnswer(run).outcome).toBe('done');
  });

  it('вывод собирается по кускам: он приходит не разом', async () => {
    const { child, handle } = harness();
    child.stdout.emit('data', '{"is_error":false,"session_id":"abc",');
    child.stdout.emit('data', '"result":"го","total_cost_usd":0.05,"num_turns":3}');
    child.emit('close', 0);

    const answer = readAnswer(await handle.finished);
    expect(answer.sessionId).toBe('abc');
    expect(answer.cost).toBe(0.05);
    expect(answer.turns).toBe(3);
  });
});

describe('этап не уложился в срок', () => {
  it('снимается поддеревом, а не одним процессом', async () => {
    const { child, handle, killed, fire } = harness();
    fire();
    child.emit('close', 1);

    const run = await handle.finished;
    expect(killed).toEqual([child.pid]);
    expect(readAnswer(run).outcome).toBe('timeout');
  });

  it('снятие по сроку — не отказ: оно назначает продолжение', async () => {
    const { child, handle, fire } = harness();
    fire();
    child.emit('close', 1);
    expect(readAnswer(await handle.finished).outcome).not.toBe('failed');
  });
});

describe('запуск не состоялся', () => {
  it('это отказ настройки, а не упавший этап', async () => {
    const { child, handle } = harness();
    child.emit('error', new Error('spawn claude ENOENT'));

    const answer = readAnswer(await handle.finished);
    expect(answer.outcome).toBe('failed');
    expect(answer.why).toContain('ENOENT');
  });
});

describe('разбор ответа', () => {
  const run = (stdout, code = 0) => ({ code, killedBy: null, stdout, stderr: '', error: null });

  it('терпит мусор вокруг объекта: предупреждения печатает не только этап', () => {
    const noisy = 'npm warn Unknown project config\n{"is_error":false,"result":"ок"}\n';
    expect(readAnswer(run(noisy)).result).toBe('ок');
  });

  it('неразобравшийся ответ — отказ, а не молчаливый пропуск', () => {
    const answer = readAnswer(run('совсем не JSON'));
    expect(answer.outcome).toBe('failed');
    expect(answer.why).toContain('не разобрался');
  });

  it('пустой вывод — тоже отказ', () => {
    expect(readAnswer(run('')).outcome).toBe('failed');
  });

  it('ненулевой код возврата отменяет успех, что бы ни говорил ответ', () => {
    expect(readAnswer(run('{"is_error":false,"result":"ок"}', 1)).outcome).toBe('failed');
  });

  it('признак ошибки в самом ответе тоже отменяет успех', () => {
    expect(readAnswer(run('{"is_error":true,"subtype":"error_max_turns"}')).outcome).toBe('failed');
  });

  it('отказанные действия достаются целиком, с именем средства и доводами', () => {
    const denied =
      '{"is_error":false,"result":"ок","permission_denials":' +
      '[{"tool_name":"PowerShell","tool_input":{"command":"npx --yes cowsay"}}]}';
    const answer = readAnswer(run(denied));
    expect(answer.denials).toHaveLength(1);
    expect(answer.denials[0].tool_name).toBe('PowerShell');
    expect(answer.denials[0].tool_input.command).toContain('cowsay');
  });

  it('пустой перечень отказов — обычное дело, а не отсутствие поля', () => {
    expect(readAnswer(run('{"is_error":false,"result":"ок"}')).denials).toEqual([]);
  });
});

describe('поток событий', () => {
  // Ради этого набора и менялся формат вывода этапа. Этап идёт до полутора
  // часов, и при однократном ответе из процесса всё это время не приходит
  // ни байта: отличить «работает» от «повис» можно лишь диспетчером задач.
  const EVENT = '{"type":"assistant","message":{"content":[{"type":"text","text":"читаю"}]}}';
  const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"готово"}';

  it('событие доходит наружу до завершения этапа', () => {
    const { child, events } = harness();
    child.stdout.emit('data', `${EVENT}\n`);
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe('assistant');
  });

  it('строка, разорванная между кусками, собирается, а не теряется', () => {
    // Кусок приходит по мере готовности сокета и обрывается посреди строки
    // где угодно. Разбирай мы куски как строки — на длинном ответе терялось
    // бы каждое второе событие, и заметно это было бы только по пробелам
    // в наблюдении, то есть никогда.
    const { child, events } = harness();
    child.stdout.emit('data', EVENT.slice(0, 30));
    expect(events).toHaveLength(0);
    child.stdout.emit('data', `${EVENT.slice(30)}\n`);
    expect(events).toHaveLength(1);
    expect(events[0].event.message.content[0].text).toBe('читаю');
  });

  it('последняя строка без перевода доносится при завершении', async () => {
    // Без слива остатка терялось бы именно итоговое событие — то самое,
    // из которого берётся весь отчёт.
    const { child, handle, events } = harness();
    child.stdout.emit('data', RESULT);
    child.emit('close', 0);
    await handle.finished;
    expect(events.at(-1).event.type).toBe('result');
  });

  it('неразобравшаяся строка отдаётся сырой, а не проглатывается', () => {
    const { child, events } = harness();
    child.stdout.emit('data', 'npm warn Unknown project config\n');
    expect(events[0].event).toBe(null);
    expect(events[0].line).toContain('npm warn');
  });

  it('падение наблюдателя не роняет супервизор', async () => {
    // Он ведёт все задачи разом, и падение на разборе одного события
    // остановило бы конвейер целиком.
    const { child, handle } = harness({
      onEvent: () => {
        throw new Error('наблюдатель сломался');
      },
    });
    expect(() => child.stdout.emit('data', `${EVENT}\n`)).not.toThrow();
    child.emit('close', 0);
    expect(readAnswer(await handle.finished).outcome).toBe('failed');
  });

  it('поток ошибок разбирается строками отдельно', () => {
    const { child, errors } = harness();
    child.stderr.emit('data', 'предупреждение сборки\n');
    expect(errors).toEqual(['предупреждение сборки']);
  });
});

describe('разбор потока событий', () => {
  const run = (stdout, code = 0) => ({ code, killedBy: null, stdout, stderr: '', error: null });
  const lines = (...items) => items.join('\n');

  it('итоговое событие находится среди прочих', () => {
    // Прежний приём — вырезать от первой скобки до последней — на NDJSON
    // даёт заведомо негодный JSON: срез захватывает все события разом.
    const stream = lines(
      '{"type":"system","subtype":"init","session_id":"abc"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"делаю"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"session_id":"abc",' +
        '"result":"готово","num_turns":4,"total_cost_usd":0.11,"permission_denials":[]}',
    );
    const answer = readAnswer(run(stream));
    expect(answer.outcome).toBe('done');
    expect(answer.result).toBe('готово');
    expect(answer.sessionId).toBe('abc');
    expect(answer.turns).toBe(4);
    expect(answer.cost).toBe(0.11);
  });

  it('берётся последнее итоговое событие, а не первое', () => {
    // Продолженная сессия печатает своё на каждый заход, и первое из них
    // говорит о прошлом ходе работы.
    const stream = lines(
      '{"type":"result","is_error":false,"result":"прошлый заход"}',
      '{"type":"result","is_error":false,"result":"этот заход"}',
    );
    expect(readAnswer(run(stream)).result).toBe('этот заход');
  });

  it('поток без итогового события — отказ, а не молчаливый пропуск', () => {
    const stream = lines(
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[]}}',
    );
    expect(readAnswer(run(stream)).outcome).toBe('failed');
  });

  it('оборвавшийся на первом событии этап не сходит за успешный', () => {
    // Одно-единственное событие разбиралось запасным путём как ответ,
    // а отсутствующий признак ошибки читался как успех: отказ превращался
    // в «сделано» ценой одного события.
    const answer = readAnswer(run('{"type":"assistant","message":{"content":[]}}'));
    expect(answer.outcome).toBe('failed');
  });

  it('метка порядка байтов в начале не мешает разбору', () => {
    // Метка невидима, а разбор спотыкается на ней с жалобой на неожиданный
    // знак в начале — то есть указывает ровно туда, где глазами ничего нет.
    const bom = String.fromCharCode(0xfeff);
    const stream = `${bom}{"type":"result","is_error":false,"result":"ок"}`;
    expect(readAnswer(run(stream)).result).toBe('ок');
  });

  it('отказанные действия достаются из итогового события потока', () => {
    const stream = lines(
      '{"type":"assistant","message":{"content":[]}}',
      '{"type":"result","is_error":false,"result":"ок","permission_denials":' +
        '[{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}]}',
    );
    expect(readAnswer(run(stream)).denials[0].tool_name).toBe('Bash');
  });

  it('однократный ответ по-прежнему понимается: откат делается настройкой', () => {
    expect(readAnswer(run('{"is_error":false,"result":"ок"}')).result).toBe('ок');
  });
});

describe('снятие поддерева', () => {
  it('на Windows зовёт taskkill с ключом дерева: своей группы процессов там нет', () => {
    const run = vi.fn();
    createKillTree(run, 'win32')(1234);
    expect(run).toHaveBeenCalledWith('taskkill', ['/PID', '1234', '/T', '/F']);
  });

  it('без номера процесса не делает ничего', () => {
    const run = vi.fn();
    createKillTree(run, 'win32')(undefined);
    expect(run).not.toHaveBeenCalled();
  });
});
