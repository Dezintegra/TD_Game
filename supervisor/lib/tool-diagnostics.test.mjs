import { describe, expect, it } from 'vitest';
import { toolControls, powerShellControl, refreshControls } from './tool-controls.mjs';
import { controlFacts, toolContext, diagnoseStageTools } from './tool-diagnostics.mjs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexGitEnvironment } from './codex-environment.mjs';
import { classifyToolControls } from './stage-tool-health.mjs';

const context = { provider: 'codex', cwd: 'work', environmentId: 'env', permissionsId: 'policy' };
describe('refresh investigation uses bounded sequential sessions', () => {
  async function investigate({
    failure,
    narrative = false,
    wrong = false,
    missing = false,
    cancel = false,
    resultFailure = false,
    deny = false,
    expire = false,
  } = {}) {
    const cwd = fileURLToPath(new URL('../../', import.meta.url));
    const command = { program: 'codex', args: [], cwd };
    const env = { PATH: 'fixed', GH_TOKEN: 'fixture-token' };
    const environment = codexGitEnvironment(env, cwd, cwd);
    const events = [];
    const order = [];
    let count = 0;
    let clock = 0;
    const signal = new globalThis.AbortController();
    const result = await diagnoseStageTools({
      assignment: { stage: 'implement' },
      config: { provider: 'codex' },
      root: cwd,
      home: cwd,
      env,
      expectedContext: toolContext(command, 'codex', environment),
      buildCommand: () => command,
      mode: 'refresh-investigation',
      signal: signal.signal,
      now: () => clock,
      evidence: {
        append: (event) => events.push(event),
        primary: () => ({ path: '/primary', sha256: 'fixture' }),
      },
      observer: {
        arm: async () => {
          order.push('arm');
          return {
            captureLaunch: async () => {
              order.push('identity');
              return {};
            },
            close: async () => {
              order.push('close');
            },
          };
        },
      },
      onStart: async () => {
        order.push('begin');
        if (deny) throw new Error('denied');
      },
      onResult: async () => {
        order.push('usage');
        if (resultFailure) throw new Error('save-failed');
      },
      start: ({ command: invoked, beforeInput, onEvent, timeoutMs }) => {
        order.push('spawn');
        const n = ++count;
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(120000);
        expect(invoked.stdin).toContain('четыре отдельных');
        const handle = {
          kill: () => {
            order.push('kill');
          },
        };
        handle.finished = (async () => {
          await beforeInput({ pid: n });
          order.push('input');
          if (expire) clock = 600_001;
          onEvent({ type: 'thread.started', thread_id: 'session-' + n });
          if (cancel) signal.abort();
          if (narrative)
            onEvent({
              type: 'item.completed',
              item: { type: 'agent_message', text: 'All four succeeded' },
            });
          else
            for (const [i, control] of refreshControls(cwd).entries()) {
              if (missing && i === 3) continue;
              onEvent({
                type: 'item.completed',
                item: {
                  id: 'call-' + i,
                  type: 'command_execution',
                  command: wrong ? 'Get-Date' : powerShellControl(control),
                  status: failure === i ? 'failed' : 'completed',
                  ...(failure === i
                    ? { execution_error: { phase: 'spawn', created: false, code: 5 } }
                    : { exit_code: 0 }),
                  aggregated_output: 'safe-result',
                },
              });
            }
          return { code: 0, stdout: '', stderr: '' };
        })();
        return handle;
      },
    });
    return { result, events, order, count };
  }
  it.each([undefined, 0, 3])('keeps first and later failure %s without replay', async (failure) => {
    const h = await investigate({ failure });
    expect(h.count).toBe(2);
    expect(h.events.filter((e) => e.kind === 'command')).toHaveLength(8);
    expect(h.order).toEqual(
      Array(2).fill(['arm', 'begin', 'spawn', 'identity', 'input', 'usage', 'close']).flat(),
    );
    expect(h.result.verdict).toBe('inconclusive'); // no native refresh events in fixture
    if (failure !== undefined) expect(h.events.filter((e) => e.created === false)).toHaveLength(2);
  });
  it('does not promote narrative or missing results', async () => {
    const narrative = await investigate({ narrative: true });
    expect(narrative.events.filter((e) => e.kind === 'command')).toHaveLength(0);
    expect(narrative.events.filter((e) => e.reason === 'missing-command-results')).toHaveLength(2);
    const missing = await investigate({ missing: true });
    expect(missing.events.filter((e) => e.reason === 'missing-command-results')).toHaveLength(2);
  });
  it('stops on mismatched invocation without a new session', async () => {
    const h = await investigate({ wrong: true });
    expect(h.count).toBe(1);
    expect(h.events.some((e) => e.reason === 'unexpected-command-order')).toBe(true);
  });
  it('cancellation prevents the second session but accounts for the first', async () => {
    const h = await investigate({ cancel: true });
    expect(h.count).toBe(1);
    expect(h.order).toContain('usage');
    expect(h.order.at(-1)).toBe('close');
  });
  it('propagates admission and persistence failures to the owner', async () => {
    await expect(investigate({ deny: true })).rejects.toThrow('denied');
    await expect(investigate({ resultFailure: true })).rejects.toThrow('save-failed');
  });
  it('does not start another session after the overall deadline', async () => {
    const h = await investigate({ expire: true });
    expect(h.count).toBe(1);
    expect(h.order.at(-1)).toBe('close');
  });
});
const controls = toolControls({
  stage: 'implement',
  cwd: 'work',
  childScript: 'probe.mjs',
  id: 'test',
});
const control = controls[0];
const code = powerShellControl(control);
const run = (events) => ({
  startedAt: 1,
  finishedAt: 2,
  stdout: events.map(JSON.stringify).join('\n'),
});
const result = (provider, events) =>
  classifyToolControls({
    context,
    controls: [control],
    facts: controlFacts(run(events), control, context, provider),
  }).verdict;

describe('fixed provider controls', () => {
  it.each(['codex', 'claude'])(
    'runs a bounded group in the retained %s context',
    async (provider) => {
      const parent = fileURLToPath(new URL('../../.matchlog', import.meta.url));
      mkdirSync(parent, { recursive: true });
      const cwd = mkdtempSync(join(parent, 'diagnostic-test-'));
      const command = { program: 'provider', args: ['-c', 'approval_policy="never"'], cwd };
      const env = { PATH: 'fixed', GH_TOKEN: 'test-token' };
      const environment = provider === 'codex' ? codexGitEnvironment(env, cwd, cwd) : env;
      const expectedContext = toolContext(command, provider, environment);
      const calls = [];
      const options = {
        assignment: { stage: 'triage' },
        config: { provider },
        root: cwd,
        home: cwd,
        env,
        expectedContext,
        buildCommand: () => command,
        start: ({ command: invoked, timeoutMs }) => {
          calls.push(invoked);
          expect(invoked.cwd).toBe(cwd);
          expect(invoked.env).toEqual(environment);
          expect(invoked.args).toEqual(command.args);
          expect(timeoutMs).toBeGreaterThan(0);
          expect(timeoutMs).toBeLessThanOrEqual(120000);
          const text = invoked.stdin.split('\n')[0].split('без изменений: ')[1];
          const output = text.startsWith('Write-Output')
            ? 'td-tool-shell-ready'
            : 'td-codex-processes-ready';
          const events =
            provider === 'codex'
              ? [
                  {
                    type: 'item.completed',
                    item: {
                      id: 'control',
                      type: 'command_execution',
                      command: text,
                      status: 'completed',
                      exit_code: 0,
                      aggregated_output: output,
                    },
                  },
                ]
              : [
                  {
                    message: {
                      content: [{ type: 'tool_use', id: 'control', input: { command: text } }],
                    },
                  },
                  {
                    message: { content: [{ type: 'tool_result', tool_use_id: 'control' }] },
                    tool_use_result: { exit_code: 0, stdout: output },
                  },
                ];
          return {
            finished: Promise.resolve({ code: 0, stdout: events.map(JSON.stringify).join('\n') }),
          };
        },
      };
      try {
        expect((await diagnoseStageTools(options)).verdict).toBe('healthy');
        expect(calls).toHaveLength(2);
        expect(
          (
            await diagnoseStageTools({
              ...options,
              expectedContext: { ...expectedContext, cwd: 'other' },
            })
          ).verdict,
        ).toBe('inconclusive');
        expect(calls).toHaveLength(2);
        expect(
          (
            await diagnoseStageTools({
              ...options,
              start: () => ({ finished: Promise.resolve({ code: 1, stdout: 'EPERM' }) }),
            })
          ).verdict,
        ).toBe('inconclusive');
      } finally {
        rmSync(cwd, { recursive: true });
      }
    },
  );
  it('separates transport from a dry-run ref and limits SSH to deploy', () => {
    expect(controls.map((c) => c.id)).toEqual([
      'shell',
      'child',
      'git',
      'github',
      'transport',
      'push',
    ]);
    expect(controls.find((c) => c.id === 'push').argv).toContain('--dry-run');
    expect(toolControls({ stage: 'triage', childScript: 'probe' }).map((c) => c.id)).toEqual([
      'shell',
      'child',
    ]);
    expect(
      toolControls({ stage: 'deploy', cwd: 'work', childScript: 'probe', sshScript: 'remote' }).at(
        -1,
      ).argv,
    ).toEqual(['node', 'remote', '--host', 'dezintegra', '--', 'printf td-codex-ssh-ready']);
    expect(() => toolControls({ remote: 'origin; deploy' })).toThrow();
  });
  it('binds Codex tool results to the exact fixed command', () => {
    const item = {
      id: 'e1',
      type: 'command_execution',
      command: code,
      status: 'completed',
      exit_code: 0,
      aggregated_output: control.marker,
    };
    expect(result('codex', [{ type: 'item.completed', item }])).toBe('healthy');
    expect(result('codex', [{ type: 'item.completed', item: { ...item, exit_code: 1 } }])).toBe(
      'confirmed',
    );
    expect(
      result('codex', [
        {
          type: 'item.completed',
          item: {
            ...item,
            status: 'failed',
            exit_code: null,
            execution_error: { phase: 'spawn', created: false, code: 'EPERM' },
          },
        },
      ]),
    ).toBe('confirmed');
    for (const change of [{ command: 'npm test' }, { status: 'declined' }, { exit_code: null }])
      expect(result('codex', [{ type: 'item.completed', item: { ...item, ...change } }])).toBe(
        'inconclusive',
      );
    expect(result('codex', [{ type: 'agent_message', text: JSON.stringify(item) }])).toBe(
      'inconclusive',
    );
  });
  it('binds Claude results by tool_use identity and requires a structural exit code', () => {
    const use = {
      message: { content: [{ type: 'tool_use', id: 'u1', input: { command: code } }] },
    };
    const answer = {
      message: { content: [{ type: 'tool_result', tool_use_id: 'u1' }] },
      tool_use_result: { exit_code: 0, stdout: control.marker },
    };
    expect(result('claude', [use, answer])).toBe('healthy');
    expect(result('claude', [use, { ...answer, tool_use_result: { exit_code: 1 } }])).toBe(
      'confirmed',
    );
    expect(result('claude', [answer])).toBe('inconclusive');
    expect(result('claude', [use, { ...answer, tool_use_result: { stderr: 'EPERM' } }])).toBe(
      'inconclusive',
    );
  });
  it('fingerprints permissions and environment without exposing values or session ids', () => {
    const command = { cwd: '.', args: ['-c', 'approval_policy="never"', '--session-id', 'one'] };
    const first = toolContext(command, 'codex', { SECRET: 'hidden' });
    expect(JSON.stringify(first)).not.toContain('hidden');
    expect(
      toolContext(
        { ...command, args: [...command.args.slice(0, 2), '--session-id', 'two'] },
        'codex',
        { SECRET: 'hidden' },
      ),
    ).toEqual(first);
    expect(toolContext({ ...command, cwd: '..' }, 'codex', { SECRET: 'hidden' })).not.toEqual(
      first,
    );
    expect(toolContext(command, 'codex', { SECRET: 'changed' })).not.toEqual(first);
  });
});
