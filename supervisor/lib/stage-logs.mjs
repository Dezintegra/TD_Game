import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NEEDS_SESSION } from '../config/transitions.mjs';

const taskPattern = '[0-9]{4}-[a-z0-9][a-z0-9-]*';
const idPattern = '(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|legacy-[0-9a-f]{64})';
const timestampPattern = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}[.][0-9]{3}Z';
const historyPattern = new RegExp(
  `^(${taskPattern})-(${NEEDS_SESSION.join('|')})-(${timestampPattern})-(${idPattern})[.]log$`,
);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const stamp = (value) => new Date(value).toISOString().replaceAll(':', '-');
const ordered = (a, b) => b.startedAt.localeCompare(a.startedAt) || b.name.localeCompare(a.name);
export const STAGE_LOG_DAY_MS = 24 * 60 * 60 * 1000;
export const STAGE_LOG_RETENTION_MS = 30 * STAGE_LOG_DAY_MS;

/** Мягкий readStages не годится для удаления: повреждение не означает пустоту. */
export function readLiveLogProtection(path, { disk = fs } = {}) {
  let value;
  try {
    value = JSON.parse(disk.readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('unknown stages state');
  return Object.entries(value).flatMap(([key, entry]) => {
    if (typeof entry === 'string') return [];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('unknown stage descriptor');
    if (entry.live == null) return [];
    const separator = key.lastIndexOf(':');
    return [
      {
        taskId: key.slice(0, separator),
        stage: key.slice(separator + 1),
        launchId: entry.live?.launchId,
      },
    ];
  });
}

/** Суточный проход вызывается обычным циклом; замок проверяется до чтения защиты. */
export function createStageLogMaintenance({
  store,
  getProtection,
  ownsLock,
  now = Date.now,
  diagnose = () => {},
}) {
  let last = null;
  return () => {
    try {
      if (!ownsLock()) return { skipped: true };
      const time = now();
      if (last !== null && time - last < STAGE_LOG_DAY_MS) return { skipped: true };
      last = time;
      return store.prune(getProtection);
    } catch (error) {
      diagnose(`Очистка логов пропущена: ${error.message}`);
      return { skipped: true, error: error.message };
    }
  };
}

export function stageLogIdentity(taskId, stage, launch = {}) {
  if (launch.launchId && new RegExp(`^${idPattern}$`).test(launch.launchId)) return launch.launchId;
  if (launch.launchId) throw new Error('invalid launchId');
  return `legacy-${digest(JSON.stringify([taskId, stage, launch.machine ?? null, launch.startedAt ?? null, launch.pid ?? null]))}`;
}

/** Политика локальных логов; один владелец замка сериализует публикацию. */
export function openStageLogs(directory, { disk = fs, now = Date.now, diagnose = () => {} } = {}) {
  const root = resolve(directory);
  function pair(taskId, stage) {
    if (!new RegExp(`^${taskPattern}$`).test(taskId) || !NEEDS_SESSION.includes(stage))
      throw new Error('unknown task or stage');
    return `${taskId}-${stage}`;
  }
  function directorySafe() {
    // Проверяем и родителей: logs внутри junction тоже не принадлежит этому дереву.
    for (let path = root; ; path = dirname(path)) {
      const stat = disk.lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`unsafe log directory: ${path}`);
      if (dirname(path) === path) break;
    }
  }
  function regular(path) {
    if (dirname(path) !== root) throw new Error(`outside logs: ${path}`);
    directorySafe();
    const stat = disk.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular log: ${path}`);
    return stat;
  }
  function read(path) {
    regular(path);
    return disk.readFileSync(path);
  }
  function list(taskId, stage) {
    directorySafe();
    return disk
      .readdirSync(root)
      .flatMap((name) => {
        const match = historyPattern.exec(name);
        if (!match || (taskId && (match[1] !== taskId || match[2] !== stage))) return [];
        const startedAt = match[3].replace(/T([0-9]{2})-([0-9]{2})-([0-9]{2})/, 'T$1:$2:$3');
        if (!Number.isFinite(Date.parse(startedAt)) || stamp(startedAt) !== match[3]) return [];
        const path = join(root, name);
        try {
          const stat = regular(path);
          return [
            {
              taskId: match[1],
              stage: match[2],
              name,
              path,
              startedAt,
              launchId: match[4],
              mtimeMs: stat.mtimeMs,
            },
          ];
        } catch (error) {
          diagnose(`Лог ${path}: ${error.message}`);
          return [];
        }
      })
      .sort(ordered);
  }
  function publish(path, bytes, { replace = false, age = now() } = {}) {
    const temporary = join(root, `.stage-log-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = disk.openSync(temporary, 'wx');
      disk.writeFileSync(fd, bytes);
      disk.fsyncSync(fd);
      disk.closeSync(fd);
      fd = undefined;
      disk.utimesSync(temporary, new Date(age), new Date(age));
      if (replace) disk.renameSync(temporary, path);
      else {
        // link публикует все байты сразу и, в отличие от rename, не заменяет историю.
        try {
          disk.linkSync(temporary, path);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          regular(path);
        }
      }
    } finally {
      if (fd !== undefined) disk.closeSync(fd);
      try {
        disk.unlinkSync(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') diagnose(`Временный лог ${temporary}: ${error.message}`);
      }
    }
  }
  function entryPath(taskId, stage, startedAt, launchId) {
    return join(root, `${pair(taskId, stage)}-${stamp(startedAt)}-${launchId}.log`);
  }
  function writeStageLog(taskId, stage, text, launch = {}) {
    try {
      const prefix = pair(taskId, stage);
      const launchId = stageLogIdentity(taskId, stage, launch);
      const startedAt = new Date(launch.startedAt).toISOString();
      disk.mkdirSync(root, { recursive: true });
      directorySafe();
      const alias = join(root, `${prefix}.log`);
      let history = list(taskId, stage);
      let previous;
      try {
        previous = { bytes: read(alias), stat: regular(alias) };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (previous) {
        const identity = /^launchId: +([^\r\n]+)/m.exec(previous.bytes.toString('utf8'))?.[1];
        const represented = history.find((item) => item.launchId === identity);
        if (!represented || !read(represented.path).equals(previous.bytes)) {
          const legacyId = `legacy-${digest(Buffer.concat([Buffer.from(prefix), previous.bytes]))}`;
          const headerDate = /^начат: +([^\r\n]+)/m.exec(previous.bytes.toString('utf8'))?.[1];
          const date = Number.isFinite(Date.parse(headerDate)) ? headerDate : previous.stat.mtimeMs;
          const path =
            history.find((item) => item.launchId === legacyId)?.path ??
            entryPath(taskId, stage, date, legacyId);
          publish(path, previous.bytes, { age: previous.stat.mtimeMs });
        }
      }
      // Идентичность важнее времени в повторно доставленных метаданных.
      const existing = history.find((item) => item.launchId === launchId);
      const path = existing?.path ?? entryPath(taskId, stage, startedAt, launchId);
      if (!existing) {
        const header = `launchId:     ${launchId}\n`;
        publish(path, Buffer.from(header + text));
      }
      history = list(taskId, stage);
      const newest = history[0];
      const bytes = read(newest.path);
      if (!previous?.bytes.equals(bytes)) publish(alias, bytes, { replace: true });
      return { ok: true, path, launchId };
    } catch (error) {
      diagnose(`Запись лога ${taskId}/${stage}: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }
  function readStageLog(taskId, stage) {
    let path;
    try {
      path = join(root, `${pair(taskId, stage)}.log`);
      const text = read(path).toString('utf8');
      return {
        stage,
        path,
        text,
        launchId: 'legacy',
        startedAt: new Date(regular(path).mtimeMs).toISOString(),
      };
    } catch (error) {
      return { stage, path, text: null, error: error.message };
    }
  }
  function readStageLogs(taskId, stage) {
    try {
      pair(taskId, stage);
      let history;
      try {
        history = list(taskId, stage);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        history = [];
      }
      if (!history.length) return { stage, entries: [readStageLog(taskId, stage)] };
      const seen = new Set();
      const selected = history
        .filter((item) => {
          if (seen.has(item.launchId)) return false;
          seen.add(item.launchId);
          return true;
        })
        .slice(0, 3);
      const alias = join(root, `${pair(taskId, stage)}.log`);
      return {
        stage,
        entries: selected.map((item, index) => {
          const entry = { ...item };
          try {
            const bytes = read(item.path);
            entry.text = bytes.toString('utf8');
            if (index === 0) {
              try {
                const copy = read(alias);
                const identity = /^launchId: +([^\r\n]+)/m.exec(copy.toString('utf8'))?.[1];
                if (
                  !copy.equals(bytes) ||
                  (!item.launchId.startsWith('legacy-') && identity !== item.launchId)
                )
                  throw new Error('копия не совпадает с новейшей историей');
                entry.path = alias;
                entry.historyPath = item.path;
                entry.text = copy.toString('utf8');
              } catch (error) {
                entry.diagnostic = `${alias}: ${error.message}`;
              }
            }
          } catch (error) {
            entry.error = error.message;
          }
          return entry;
        }),
      };
    } catch (error) {
      return { stage, entries: [], error: error.message };
    }
  }
  function protectionSnapshot(getProtection) {
    const entries = getProtection();
    if (!Array.isArray(entries)) throw new Error('unknown log protection');
    const launches = new Set();
    const pairs = new Set();
    for (const entry of entries) {
      const prefix = pair(entry?.taskId, entry?.stage);
      if (typeof entry.launchId === 'string' && new RegExp(`^${idPattern}$`).test(entry.launchId))
        launches.add(`${prefix}:${entry.launchId}`);
      else pairs.add(prefix);
    }
    return (entry) =>
      pairs.has(pair(entry.taskId, entry.stage)) ||
      launches.has(`${pair(entry.taskId, entry.stage)}:${entry.launchId}`);
  }
  function prune(getProtection) {
    const removed = [];
    try {
      protectionSnapshot(getProtection);
      let history;
      try {
        history = list();
      } catch (error) {
        if (error.code === 'ENOENT') return { removed };
        throw error;
      }
      const counts = new Map();
      const cutoff = now() - STAGE_LOG_RETENTION_MS;
      for (const entry of history) {
        const prefix = pair(entry.taskId, entry.stage);
        const count = (counts.get(prefix) ?? 0) + 1;
        counts.set(prefix, count);
        if (count <= 3 || entry.mtimeMs >= cutoff) continue;
        // Защиту перечитываем перед каждым удалением, включая неприменённые отчёты.
        if (protectionSnapshot(getProtection)(entry)) continue;
        try {
          if (regular(entry.path).mtimeMs >= cutoff) continue;
          disk.unlinkSync(entry.path);
          removed.push(entry.path);
        } catch (error) {
          diagnose(`Удаление лога ${entry.path}: ${error.message}`);
        }
      }
      return { removed };
    } catch (error) {
      diagnose(`Очистка логов пропущена: ${error.message}`);
      return { removed, skipped: true, error: error.message };
    }
  }
  return { writeStageLog, readStageLog, readStageLogs, prune };
}
