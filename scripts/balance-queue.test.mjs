import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queueFromBacklog } from './balance-queue.mjs';

/**
 * Проверки сборки очереди из бэклога.
 *
 * Отдельного файла очереди больше нет, и от этой сборки зависит, что именно
 * ночная джоба погонит на чужом железе. Ошибка здесь стоит часа впустую либо,
 * что хуже, тишины: вопрос задан, а никто его не померил.
 *
 * Свой временный каталог на каждую проверку: общий каталог временных файлов
 * один на все сессии, и соседняя запросто перепишет файл с ходовым именем.
 */

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'balance-queue-'));
  mkdirSync(join(root, 'manage', 'tasks'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Задача-прогон в бэклоге. */
const putRun = (id, over = {}) => {
  const task = {
    id,
    type: 'run',
    title: 'Проба',
    description: 'Зачем меряем.',
    status: 'new',
    priority: 30,
    run: {
      kind: 'arena',
      params: { profiles: ['baseline', 'siege'], matches: 60, seed: 7, change: 'моё-изменение' },
      expectation: 'Чего ждём.',
    },
    ...over,
  };
  writeFileSync(join(root, 'manage', 'tasks', `${id}.json`), JSON.stringify(task, null, 2));
  return task;
};

describe('что попадает в очередь', () => {
  it('задача-прогон арены попадает и переносит все поля', () => {
    putRun('0001-proba');
    const [entry] = queueFromBacklog(root);
    expect(entry).toEqual({
      id: '0001-proba',
      task: 'моё-изменение',
      why: 'Зачем меряем.',
      profiles: ['baseline', 'siege'],
      matches: 60,
      seed: 7,
      expect: 'Чего ждём.',
    });
  });

  it('порядок задан именем файла, а не тем, как их вернула система', () => {
    putRun('0003-tri');
    putRun('0001-raz');
    putRun('0002-dva');
    expect(queueFromBacklog(root).map((item) => item.id)).toEqual([
      '0001-raz',
      '0002-dva',
      '0003-tri',
    ]);
  });

  it('пустой бэклог даёт пустую очередь, а не беду', () => {
    expect(queueFromBacklog(root)).toEqual([]);
  });

  it('нет каталога задач — тоже пусто', () => {
    rmSync(join(root, 'manage'), { recursive: true, force: true });
    expect(queueFromBacklog(root)).toEqual([]);
  });
});

describe('что в очередь не попадает', () => {
  it('доработки не меряются', () => {
    putRun('0001-feature', { type: 'feature', run: undefined });
    expect(queueFromBacklog(root)).toEqual([]);
  });

  it('замер кадров ночной джобе не годится', () => {
    // Кадры мерят на живой машине с видеокартой, а не на runner'е.
    putRun('0001-perf', {
      run: { kind: 'perf', params: {}, expectation: 'не ниже порога' },
    });
    expect(queueFromBacklog(root)).toEqual([]);
  });

  it('закрытая задача не меряется повторно', () => {
    putRun('0001-zakryta', { status: 'closed' });
    expect(queueFromBacklog(root)).toEqual([]);
  });

  it('остановленная задача ждёт человека, а не прогона', () => {
    putRun('0001-oshibka', { status: 'failed' });
    expect(queueFromBacklog(root)).toEqual([]);
  });

  it('задача в работе меряется: она за тем и взята', () => {
    putRun('0001-v-rabote', { status: 'benchmark' });
    expect(queueFromBacklog(root)).toHaveLength(1);
  });
});

describe('стойкость', () => {
  it('испорченный файл не отменяет остальных', () => {
    putRun('0001-godnaya');
    writeFileSync(join(root, 'manage', 'tasks', '0002-bitaya.json'), '{ это не JSON');
    const jalobs = [];
    const queue = queueFromBacklog(root, (message) => jalobs.push(message));
    expect(queue).toHaveLength(1);
    expect(jalobs.join()).toContain('0002-bitaya');
  });

  it('метка порядка байтов не отменяет задачу', () => {
    const bom = String.fromCharCode(0xfeff);
    const task = {
      id: '0001-bom',
      type: 'run',
      description: 'Зачем.',
      status: 'new',
      run: { kind: 'arena', params: {}, expectation: 'Чего ждём.' },
    };
    writeFileSync(join(root, 'manage', 'tasks', '0001-bom.json'), bom + JSON.stringify(task));
    expect(queueFromBacklog(root)).toHaveLength(1);
  });

  it('посторонние файлы не мешают', () => {
    putRun('0001-proba');
    writeFileSync(join(root, 'manage', 'tasks', '.gitkeep'), '');
    writeFileSync(join(root, 'manage', 'tasks', 'zametka.md'), 'не задача');
    expect(queueFromBacklog(root)).toHaveLength(1);
  });
});

describe('настоящий бэклог этого репозитория', () => {
  it('разбирается и содержит перенесённые из очереди замеры', () => {
    // Проверка на живых данных: если перенос очереди что-то испортил,
    // здесь это видно сразу.
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const queue = queueFromBacklog(repo);
    expect(queue.length).toBeGreaterThan(0);
    for (const entry of queue) {
      expect(entry.profiles, entry.id).toHaveLength(2);
      expect(entry.matches, entry.id).toBeGreaterThan(0);
      expect(String(entry.expect ?? ''), entry.id).not.toBe('');
    }
  });
});
