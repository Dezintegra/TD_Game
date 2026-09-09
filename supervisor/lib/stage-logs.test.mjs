import * as fs from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStageLogs, stageLogIdentity } from './stage-logs.mjs';

const task = '0082-preserve-logs';
const stage = 'implement';
const roots = [];
const launch = (n) => ({
  launchId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  startedAt: `2026-08-${String(n).padStart(2, '0')}T12:00:00.000Z`,
  sessionId: 'same-session',
  machine: 'test',
  pid: 42,
});
function setup(options = {}) {
  const parent = resolve('.matchlog');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(join(parent, 'stage-logs-'));
  roots.push(root);
  const diagnostics = [];
  return {
    root,
    diagnostics,
    store: openStageLogs(root, { diagnose: (message) => diagnostics.push(message), ...options }),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('история заходов', () => {
  it('resume, перезапуск и новый круг сохраняют разные байты; повтор и старый запуск не откатывают копию', () => {
    const { root, store } = setup();
    const first = store.writeStageLog(task, stage, 'FIRST', launch(1));
    const firstBytes = fs.readFileSync(first.path);
    const firstAge = fs.statSync(first.path).mtimeMs;
    const second = store.writeStageLog(task, stage, 'SECOND', launch(2));
    expect(first.path).not.toBe(second.path);
    const reopened = openStageLogs(root);
    const third = reopened.writeStageLog(task, stage, 'THIRD', launch(3));
    reopened.writeStageLog(task, stage, 'MUST NOT REPLACE', launch(1));
    expect(fs.readFileSync(first.path)).toEqual(firstBytes);
    expect(fs.statSync(first.path).mtimeMs).toBe(firstAge);
    const history = reopened.readStageLogs(task, stage).entries;
    expect(history.map((item) => item.launchId)).toEqual([3, 2, 1].map((n) => launch(n).launchId));
    expect(history[0].historyPath).toBe(third.path);
    expect(history[0].path).toBe(join(root, `${task}-${stage}.log`));
    expect(history[0].text).toContain('THIRD');
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.log'))).toHaveLength(4);
  });

  it('старый дескриптор имеет устойчивый ключ, отличный при смене запуска', () => {
    const old = { ...launch(1), launchId: undefined };
    expect(stageLogIdentity(task, stage, old)).toBe(stageLogIdentity(task, stage, { ...old }));
    expect(stageLogIdentity(task, stage, old)).not.toBe(
      stageLogIdentity(task, stage, { ...old, startedAt: launch(2).startedAt }),
    );
    const { store } = setup();
    expect(store.writeStageLog(task, stage, 'OLD DESCRIPTOR', old).launchId).toMatch(/^legacy-/);
  });

  it('импортирует прежние байты и mtime без омоложения и повторного размножения', () => {
    const { root, store } = setup();
    const alias = join(root, `${task}-${stage}.log`);
    const age = new Date('2025-01-01T00:00:00Z');
    fs.writeFileSync(alias, 'legacy bytes\r\n');
    fs.utimesSync(alias, age, age);
    expect(store.readStageLogs(task, stage).entries[0].text).toBe('legacy bytes\r\n');
    store.writeStageLog(task, stage, 'NEW', launch(1));
    store.writeStageLog(task, stage, 'NEW', launch(1));
    const legacy = store.readStageLogs(task, stage).entries[1];
    expect(legacy.text).toBe('legacy bytes\r\n');
    expect(fs.statSync(legacy.path).mtimeMs).toBe(age.getTime());
    expect(fs.readdirSync(root)).toHaveLength(3);
  });

  it('сверяет legacy по байтам и выбирает копию источником без дублирования', () => {
    const { root, store } = setup();
    const alias = join(root, `${task}-${stage}.log`);
    fs.writeFileSync(alias, `начат:         ${launch(3).startedAt}\nLEGACY`);
    store.writeStageLog(task, stage, 'OLDER', launch(1));
    const entries = store.readStageLogs(task, stage).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe(alias);
    expect(entries[0].historyPath).toBeTruthy();
    expect(entries[0].text).toContain('LEGACY');
  });

  it.each(['stale', 'missing', 'unreadable'])(
    'использует историю с диагностикой при %s копии',
    (failure) => {
      const { root, store } = setup();
      const first = store.writeStageLog(task, stage, 'FIRST', launch(1));
      store.writeStageLog(task, stage, 'SECOND', launch(2));
      const alias = join(root, `${task}-${stage}.log`);
      if (failure === 'stale') fs.copyFileSync(first.path, alias);
      if (failure === 'missing') fs.unlinkSync(alias);
      const reader = openStageLogs(root, {
        disk: {
          ...fs,
          readFileSync(path, ...args) {
            if (failure === 'unreadable' && path === alias) throw new Error('EACCES');
            return fs.readFileSync(path, ...args);
          },
        },
      });
      const entries = reader.readStageLogs(task, stage).entries;
      expect(entries).toHaveLength(2);
      expect(entries[0].path).not.toBe(alias);
      expect(entries[0].diagnostic).toContain(alias);
      expect(entries[0].text).toContain('SECOND');
      expect(entries[1].text).toContain('FIRST');
    },
  );

  it.each(['writeFileSync', 'linkSync', 'renameSync'])(
    'сбой %s сохраняет прежнюю копию',
    (operation) => {
      const { root, store } = setup();
      store.writeStageLog(task, stage, 'FIRST', launch(1));
      const alias = join(root, `${task}-${stage}.log`);
      const before = fs.readFileSync(alias);
      const diagnostics = [];
      const broken = openStageLogs(root, {
        diagnose: (message) => diagnostics.push(message),
        disk: {
          ...fs,
          [operation]() {
            throw new Error('disk failure');
          },
        },
      });
      expect(broken.writeStageLog(task, stage, 'SECOND', launch(2)).ok).toBe(false);
      expect(fs.readFileSync(alias)).toEqual(before);
      expect(diagnostics.join('\n')).toContain('disk failure');
      expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
    },
  );

  it('сбой импорта legacy не заменяет единственный старый файл', () => {
    const { root } = setup();
    const alias = join(root, `${task}-${stage}.log`);
    fs.writeFileSync(alias, 'ONLY LEGACY');
    const store = openStageLogs(root, {
      disk: {
        ...fs,
        linkSync() {
          throw new Error('no publication');
        },
      },
    });
    expect(store.writeStageLog(task, stage, 'NEW', launch(1)).ok).toBe(false);
    expect(fs.readFileSync(alias, 'utf8')).toBe('ONLY LEGACY');
  });

  it('не читает неизвестные имена, каталоги, ссылки и чужие этапы', () => {
    const { root, store } = setup();
    const first = store.writeStageLog(task, stage, 'FIRST', launch(1));
    const directory = first.path.replace(launch(1).launchId, launch(2).launchId);
    fs.mkdirSync(directory);
    fs.writeFileSync(join(root, 'unknown.log'), 'SECRET');
    const disk = {
      ...fs,
      lstatSync(path) {
        const stat = fs.lstatSync(path);
        return path === first.path
          ? { ...stat, isFile: () => true, isSymbolicLink: () => true }
          : stat;
      },
    };
    const reader = openStageLogs(root, { disk });
    expect(reader.readStageLogs(task, stage).entries[0].historyPath).toBeUndefined();
    expect(store.readStageLogs('../escape', stage).entries).toEqual([]);
    expect(store.readStageLogs(task, null).entries).toEqual([]);
    expect(store.readStageLogs(task, 'review').entries[0].text).toBeNull();
  });

  it('выбирает три новейших; ошибка чтения выбранного файла не скрывает остальные', () => {
    const { root, store } = setup();
    const files = [1, 2, 3, 4, 5].map(
      (n) => store.writeStageLog(task, stage, `MARKER-${n}`, launch(n)).path,
    );
    const reader = openStageLogs(root, {
      disk: {
        ...fs,
        readFileSync(path, ...args) {
          if (path === files[3]) throw new Error('disappeared');
          return fs.readFileSync(path, ...args);
        },
      },
    });
    const entries = reader.readStageLogs(task, stage).entries;
    expect(entries.map((item) => item.launchId)).toEqual([5, 4, 3].map((n) => launch(n).launchId));
    expect(entries[1].error).toBe('disappeared');
    expect(entries[0].text).toContain('MARKER-5');
    expect(entries[2].text).toContain('MARKER-3');
  });
});
