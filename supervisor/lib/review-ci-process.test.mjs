import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const head = JSON.parse(readFileSync(new URL('./testing/ci-pr-219.json', import.meta.url))).pr
  .headRefOid;
const preload = './supervisor/lib/testing/review-ci-gh-fixture.mjs';

function invoke(scenario, shell = false, invalid = false) {
  mkdirSync(join(root, '.matchlog'), { recursive: true });
  const temp = mkdtempSync(join(root, '.matchlog/review-ci-process-'));
  const calls = join(temp, 'calls.jsonl');
  const args = [
    '--import',
    preload,
    'supervisor/bin/review-ci.mjs',
    ...(invalid ? ['--bad'] : ['--pr', '219', '--head', head]),
  ];
  try {
    const command = ['node', ...args].map((s) => `'${s.replaceAll("'", "''")}'`).join(' ');
    const result = spawnSync(
      shell ? 'pwsh' : process.execPath,
      shell ? ['-NoProfile', '-NonInteractive', '-Command', `& ${command}`] : args,
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        env: { ...process.env, REVIEW_CI_SCENARIO: scenario, REVIEW_CI_CALLS: calls },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    return { code: result.status, json: JSON.parse(result.stdout), calls: existsSync(calls) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('настоящий процесс review-ci', () => {
  it.each([
    ['success', 'success', 0],
    ['failure', 'failure', 1],
    ['unknown', 'pending', 2],
    ['transport', 'pending', 2],
    ['head', 'pending', 2],
    ['conflict', 'conflict', 3],
    ['confirmed', 'success', 0],
  ])('%s: JSON %s и код %s', (scenario, state, code) => {
    expect(invoke(scenario)).toMatchObject({
      code,
      calls: true,
      json: {
        state,
        pr: 219,
        expectedHead: head,
      },
    });
  });
  it('неверные аргументы дают 64 без gh', () => {
    expect(invoke('success', false, true)).toMatchObject({
      code: 64,
      calls: false,
      json: { state: 'pending', pr: null },
    });
  });
  it.runIf(process.platform === 'win32')(
    'PowerShell нормализует ненулевой код при -Command',
    () => {
      expect(invoke('unknown')).toMatchObject({ code: 2, json: { state: 'pending' } });
      expect(invoke('unknown', true)).toMatchObject({ code: 1, json: { state: 'pending' } });
    },
  );
});
