import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recover } from './recover-codex-ledger.mjs';

const id = '01a07333-9085-7400-b661-8dd74ccf3d2a';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ledger-root-'));
  const sessions = mkdtempSync(join(tmpdir(), 'ledger-sessions-'));
  const cwd = join(root, '.claude', 'worktrees', '0231-example');
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(root, '.pipeline', 'codex-usage.json'),
    JSON.stringify({
      version: 2,
      tasks: {
        '0231-example': {
          sessions: {
            [id]: { knownTokens: 1585645, snapshot: null, reasons: ['legacy-unknown', 'other'] },
          },
          launches: {},
        },
      },
    }),
  );
  writeFileSync(
    join(sessions, `rollout-${id}.jsonl`),
    [
      JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }),
      JSON.stringify({
        type: 'token_usage_record',
        payload: {
          thread_id: id,
          session_id: id,
          turn_id: 'turn',
          response_id: 'response',
          usage: { input_tokens: 2007334, output_tokens: 0, total_tokens: 2007334 },
          thread_token_usage: { input_tokens: 2007334, output_tokens: 0, total_tokens: 2007334 },
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } }),
    ].join('\n'),
  );
  return { root, sessions };
}

describe('recovery CLI', () => {
  it('dry-run ничего не пишет, а apply создаёт backup и остаётся идемпотентным', () => {
    const { root, sessions } = fixture();
    const path = join(root, '.pipeline', 'codex-usage.json');
    const original = readFileSync(path, 'utf8');
    expect(recover({ root, sessionsRoot: sessions }).proposed).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(recover({ root, sessionsRoot: sessions, apply: true })).toMatchObject({ applied: true });
    expect(recover({ root, sessionsRoot: sessions, apply: true })).toMatchObject({
      applied: false,
      proposed: [],
    });
  });

  it('не применяет реестр при живом или неоднозначном замке', () => {
    const { root, sessions } = fixture();
    writeFileSync(join(root, '.pipeline', 'supervisor.lock'), JSON.stringify({ pid: process.pid }));
    expect(() => recover({ root, sessionsRoot: sessions, apply: true })).toThrow('живой процесс');
  });

  it('принимает flat ledger и main-root cwd, а entrypoint исполняется', () => {
    const { root, sessions } = fixture();
    const path = join(root, '.pipeline', 'codex-usage.json');
    const json = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ '0231-example': { [id]: 1585645 } }));
    const session = join(sessions, `rollout-${id}.jsonl`);
    writeFileSync(
      session,
      readFileSync(session, 'utf8').replace(
        json.tasks['0231-example'] ? join(root, '.claude', 'worktrees', '0231-example') : '',
        root,
      ),
    );
    expect(recover({ root, sessionsRoot: sessions }).proposed).toHaveLength(1);
    const run = spawnSync(process.execPath, ['supervisor/bin/recover-codex-ledger.mjs', '--help'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage:');
  });
});
