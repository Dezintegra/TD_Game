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

function harness({ timeoutMs = 1000, command } = {}) {
  const child = fakeChild();
  const killed = [];
  const timers = [];
  const handle = startStage({
    command: command ?? { program: 'claude', args: ['-p'], cwd: '/repo', stdin: 'делай' },
    timeoutMs,
    spawn: () => child,
    killTree: (pid) => killed.push(pid),
    setTimer: (fn) => {
      timers.push(fn);
      return { fn };
    },
    clearTimer: () => {},
  });
  return { child, killed, handle, fire: () => timers.forEach((fn) => fn()) };
}

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
