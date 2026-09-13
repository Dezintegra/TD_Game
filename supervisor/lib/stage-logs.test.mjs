import * as fs from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openStageLogs,
  stageLogIdentity,
  readLiveLogProtection,
  createStageLogMaintenance,
  STAGE_LOG_DAY_MS,
  STAGE_LOG_RETENTION_MS,
} from './stage-logs.mjs';

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

describe('возрастная очистка', () => {
  const time = Date.parse('2026-10-01T12:00:00.000Z');
  function populated(options = {}) {
    const fixture = setup({ now: () => time - STAGE_LOG_RETENTION_MS - 1, ...options });
    const files = [1, 2, 3, 4, 5].map(
      (n) => fixture.store.writeStageLog(task, stage, `TEXT-${n}`, launch(n)).path,
    );
    return {
      ...fixture,
      files,
      cleaner: openStageLogs(fixture.root, {
        now: () => time,
        diagnose: (message) => fixture.diagnostics.push(message),
      }),
    };
  }

  it('удаляет строго старше срока, оставляет границу и последние три независимо от возраста', () => {
    const { root, files, cleaner } = populated();
    const boundary = new Date(time - STAGE_LOG_RETENTION_MS);
    fs.utimesSync(files[1], boundary, boundary);
    expect(cleaner.prune(() => []).removed).toEqual([files[0]]);
    expect(files.map((path) => fs.existsSync(path))).toEqual([false, true, true, true, true]);
    const nextDay = openStageLogs(root, { now: () => time + STAGE_LOG_DAY_MS });
    expect(nextDay.prune(() => []).removed).toEqual([files[1]]);
    expect(files.slice(2).every((path) => fs.existsSync(path))).toBe(true);
    expect(fs.existsSync(join(root, `${task}-${stage}.log`))).toBe(true);
  });

  it('считает минимум отдельно для каждой пары, оставляя свежую старшую запись', () => {
    const { root, files, cleaner } = populated();
    const writer = openStageLogs(root, { now: () => time - STAGE_LOG_RETENTION_MS - 1 });
    const review = [1, 2, 3, 4].map(
      (n) => writer.writeStageLog(task, 'review', `REVIEW-${n}`, launch(n)).path,
    );
    fs.utimesSync(files[0], new Date(time), new Date(time));
    expect(new Set(cleaner.prune(() => []).removed)).toEqual(new Set([files[1], review[0]]));
    expect(fs.existsSync(files[0])).toBe(true);
    expect(review.slice(1).every((path) => fs.existsSync(path))).toBe(true);
  });

  it('legacy сохраняет возраст при импорте и удаляется только вне последних трёх', () => {
    const { root, store } = setup({ now: () => time });
    const alias = join(root, `${task}-${stage}.log`);
    fs.writeFileSync(alias, 'old legacy');
    const age = new Date('2025-01-01T00:00:00Z');
    fs.utimesSync(alias, age, age);
    store.writeStageLog(task, stage, 'first', launch(1));
    const legacy = store.readStageLogs(task, stage).entries[1].path;
    expect(store.prune(() => []).removed).toEqual([]);
    store.writeStageLog(task, stage, 'second', launch(2));
    store.writeStageLog(task, stage, 'third', launch(3));
    expect(store.prune(() => []).removed).toEqual([legacy]);
  });

  it('защищает запуск и неприменённый отчёт до снятия защиты', () => {
    const { files, cleaner } = populated();
    const protection = [1, 2].map((n) => ({ taskId: task, stage, launchId: launch(n).launchId }));
    expect(cleaner.prune(() => protection).removed).toEqual([]);
    expect(cleaner.prune(() => protection.slice(1)).removed).toEqual([files[0]]);
    expect(cleaner.prune(() => []).removed).toEqual([files[1]]);
  });

  it.each([undefined, 'unknown-id'])('неполная идентичность %s защищает всю пару', (launchId) => {
    const { files, cleaner } = populated();
    expect(cleaner.prune(() => [{ taskId: task, stage, launchId }]).removed).toEqual([]);
    expect(files.every((path) => fs.existsSync(path))).toBe(true);
  });

  it.each([
    () => {
      throw new Error('unreadable protection');
    },
    () => null,
    () => [{ taskId: null, stage }],
  ])('неизвестная защита отменяет проход', (getProtection) => {
    const { files, cleaner, diagnostics } = populated();
    expect(cleaner.prune(getProtection)).toMatchObject({ skipped: true, removed: [] });
    expect(files.every((path) => fs.existsSync(path))).toBe(true);
    expect(diagnostics.join('\n')).toContain('Очистка логов пропущена');
  });

  it('перед удалением перечитывает защиту, не доверяя прежнему пустому снимку', () => {
    const { files, cleaner } = populated();
    let calls = 0;
    expect(cleaner.prune(() => (++calls === 1 ? [] : [{ taskId: task, stage }])).removed).toEqual(
      [],
    );
    expect(calls).toBe(3);
    expect(files.every((path) => fs.existsSync(path))).toBe(true);
  });

  it('копии, каталоги, ссылки и неизвестные файлы не удаляются; ошибка unlink не останавливает проход', () => {
    const { root, files, diagnostics } = populated();
    fs.writeFileSync(join(root, 'unknown.log'), 'keep');
    const directory = files[0].replace(launch(1).launchId, launch(6).launchId);
    fs.mkdirSync(directory);
    const linked = files[0].replace(launch(1).launchId, launch(7).launchId);
    fs.writeFileSync(linked, 'link target marker');
    const removed = [];
    const cleaner = openStageLogs(root, {
      now: () => time,
      diagnose: (message) => diagnostics.push(message),
      disk: {
        ...fs,
        lstatSync(path) {
          const stat = fs.lstatSync(path);
          return path === linked
            ? { ...stat, isFile: () => true, isSymbolicLink: () => true }
            : stat;
        },
        unlinkSync(path) {
          if (path === files[1]) throw new Error('cannot unlink');
          removed.push(path);
          fs.unlinkSync(path);
        },
      },
    });
    expect(cleaner.prune(() => []).removed).toEqual([files[0]]);
    expect(removed).toEqual([files[0]]);
    expect(fs.existsSync(linked)).toBe(true);
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.existsSync(join(root, 'unknown.log'))).toBe(true);
    expect(fs.existsSync(join(root, `${task}-${stage}.log`))).toBe(true);
    expect(diagnostics.join('\n')).toContain('cannot unlink');
  });

  it('читает защиту live строго: отсутствие файла допустимо, повреждение не пустота', () => {
    const { root } = setup();
    const path = join(root, 'stages.json');
    expect(readLiveLogProtection(path)).toEqual([]);
    fs.writeFileSync(
      path,
      JSON.stringify({ [`${task}:${stage}`]: { live: { launchId: launch(1).launchId } } }),
    );
    expect(readLiveLogProtection(path)).toEqual([
      { taskId: task, stage, launchId: launch(1).launchId },
    ]);
    fs.writeFileSync(path, '{');
    expect(() => readLiveLogProtection(path)).toThrow();
    fs.writeFileSync(path, '[]');
    expect(() => readLiveLogProtection(path)).toThrow('unknown stages state');
    expect(() =>
      readLiveLogProtection(path, {
        disk: {
          readFileSync() {
            throw new Error('EACCES');
          },
        },
      }),
    ).toThrow('EACCES');
  });

  it('следующий суточный проход не требует перезапуска и проверяет владельца замка', () => {
    const { files, cleaner } = populated();
    let clock = time;
    let owned = false;
    let reads = 0;
    let protectedEntries = [{ taskId: task, stage }];
    const maintain = createStageLogMaintenance({
      store: cleaner,
      now: () => clock,
      ownsLock: () => owned,
      getProtection: () => {
        reads++;
        return protectedEntries;
      },
    });
    expect(maintain().skipped).toBe(true);
    expect(reads).toBe(0);
    owned = true;
    expect(maintain().removed).toEqual([]);
    protectedEntries = [];
    clock += STAGE_LOG_DAY_MS - 1;
    expect(maintain().skipped).toBe(true);
    clock++;
    expect(maintain().removed).toEqual([files[1], files[0]]);
  });
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

  it('восстановленная legacy-копия без даты не размножает историю после смены mtime', () => {
    const { root, store } = setup();
    const alias = join(root, `${task}-${stage}.log`);
    fs.writeFileSync(alias, 'LEGACY WITHOUT HEADER');
    const age = new Date('2026-09-01T00:00:00Z');
    fs.utimesSync(alias, age, age);
    store.writeStageLog(task, stage, 'FIRST', launch(1));
    const count = fs.readdirSync(root).length;
    fs.utimesSync(alias, new Date('2026-09-02T00:00:00Z'), new Date('2026-09-02T00:00:00Z'));
    store.writeStageLog(task, stage, 'REPLAY', launch(1));
    expect(fs.readdirSync(root)).toHaveLength(count);
    expect(store.readStageLogs(task, stage).entries).toHaveLength(2);
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
