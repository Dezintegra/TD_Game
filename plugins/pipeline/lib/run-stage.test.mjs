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
  return child;
}

function harness({ timeoutMs = 1000 } = {}) {
  const child = fakeChild();
  const killed = [];
  const timers = [];
  const handle = startStage({
    command: { program: 'claude', args: ['-p', 'делай'], cwd: '/repo' },
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
