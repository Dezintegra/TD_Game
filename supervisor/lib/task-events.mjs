import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { NEEDS_SESSION } from '../config/transitions.mjs';
import { clip, toolDigest } from './console.mjs';

const TASK_ID = /^[0-9]{4}-[a-z0-9][a-z0-9-]*$/;
const MAX_DETAIL = 300;
const MAX_ACTION = 180;
const MAX_TOOL = 60;
const KINDS = new Set([
  'spawn-attempt',
  'launch-start',
  'spawn-failed',
  'action-start',
  'action-finish',
  'error',
  'stderr',
  'launch-finish',
]);

const bounded = (value, limit) => clip(String(value ?? ''), limit);

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join(' ');
}

const contentParts = (event) =>
  Array.isArray(event.message?.content) ? event.message.content : [];

/** Разрешённая выжимка из потока провайдера: промпты и полный вывод сюда не попадают. */
export function taskEventSummaries(provider, event) {
  if (!event || typeof event !== 'object') return [];
  if (provider === 'codex') {
    if (event.type === 'error' || event.type === 'turn.failed')
      return [
        { kind: 'error', detail: bounded(event.error?.message ?? event.message, MAX_DETAIL) },
      ];
    if (event.type !== 'item.started' && event.type !== 'item.completed') return [];
    const item = event.item;
    if (!item || !['command_execution', 'file_change'].includes(item.type)) return [];
    const fields = {
      tool: item.type,
      ...(item.id ? { actionId: bounded(item.id, 80) } : {}),
      ...(item.command ? { action: bounded(item.command, MAX_ACTION) } : {}),
    };
    if (event.type === 'item.started') return [{ kind: 'action-start', ...fields }];
    const status = bounded(item.status ?? 'completed', 40);
    const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
    const failed =
      ['failed', 'declined', 'error'].includes(status) || (exitCode != null && exitCode !== 0);
    const finished = {
      kind: 'action-finish',
      ...fields,
      status,
      ...(exitCode != null ? { exitCode } : {}),
    };
    if (!failed) return [finished];
    return [
      finished,
      {
        kind: 'error',
        ...fields,
        detail: bounded(item.aggregated_output ?? status, MAX_DETAIL),
      },
    ];
  }
  if (provider === 'claude') {
    if (event.type === 'assistant')
      return contentParts(event)
        .filter((part) => part?.type === 'tool_use')
        .map((part) => ({
          kind: 'action-start',
          tool: bounded(part.name, MAX_TOOL),
          ...(part.id ? { actionId: bounded(part.id, 80) } : {}),
          action: bounded(toolDigest(part.name, part.input), MAX_ACTION),
        }));
    if (event.type === 'user')
      return contentParts(event)
        .filter((part) => part?.type === 'tool_result')
        .flatMap((part) => {
          const fields = {
            ...(part.tool_use_id ? { actionId: bounded(part.tool_use_id, 80) } : {}),
          };
          const finish = {
            kind: 'action-finish',
            ...fields,
            status: part.is_error ? 'failed' : 'completed',
          };
          return part.is_error
            ? [
                finish,
                { kind: 'error', ...fields, detail: bounded(resultText(part.content), MAX_DETAIL) },
              ]
            : [finish];
        });
  }
  return [];
}

/** По одному синхронному append+flush на событие, чтобы обрыв не унёс предыдущие строки. */
export function openTaskEvents(directory, { disk = fs } = {}) {
  const root = resolve(directory);
  function safeDirectory() {
    for (let path = root; ; path = dirname(path)) {
      const stat = disk.lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`unsafe task log directory: ${path}`);
      if (dirname(path) === path) break;
    }
  }
  function append(taskId, event) {
    let fd;
    try {
      if (!TASK_ID.test(taskId)) throw new Error('invalid task id');
      if (!NEEDS_SESSION.includes(event?.stage)) throw new Error('invalid stage');
      if (!KINDS.has(event?.kind)) throw new Error('invalid event kind');
      const at = new Date(event.at).toISOString();
      const path = join(root, `${taskId}.jsonl`);
      disk.mkdirSync(root, { recursive: true });
      safeDirectory();
      try {
        const stat = disk.lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe task log file');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const record = {
        at,
        taskId,
        stage: event.stage,
        ...(event.launchId ? { launchId: bounded(event.launchId, 80) } : {}),
        kind: event.kind,
        ...(event.pid != null ? { pid: event.pid } : {}),
        ...(event.tool ? { tool: bounded(event.tool, MAX_TOOL) } : {}),
        ...(event.actionId ? { actionId: bounded(event.actionId, 80) } : {}),
        ...(event.action ? { action: bounded(event.action, MAX_ACTION) } : {}),
        ...(event.status ? { status: bounded(event.status, 40) } : {}),
        ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}),
        ...(event.detail ? { detail: bounded(event.detail, MAX_DETAIL) } : {}),
      };
      fd = disk.openSync(path, 'a');
      if (!disk.fstatSync(fd).isFile()) throw new Error('task log handle is not a file');
      disk.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      disk.fsyncSync(fd);
      disk.closeSync(fd);
      fd = undefined;
      return { ok: true, path };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (fd !== undefined) disk.closeSync(fd);
    }
  }
  return { append };
}
