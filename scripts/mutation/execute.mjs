import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { classifyPair, pairKey, phaseError } from './model.mjs';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function readPhaseReport(raw, descriptor, exitCode) {
  try {
    const report = JSON.parse(raw);
    const error = phaseError(report, descriptor);
    if (
      error ||
      report.evidenceIdentityValid !== true ||
      exitCode !== (report.status === 'passed' ? 0 : 1) ||
      (report.status === 'failed' &&
        (!report.testErrors?.length || report.testErrors.some((e) => e.name !== 'AssertionError')))
    ) {
      return { ...report, error: error || 'Untrusted evidence or process exit' };
    }
    return report;
  } catch {
    return { error: 'Missing or invalid JSON report' };
  }
}

async function killProcess(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Конфиг принудительно использует threads: workers принадлежат этому процессу.
    // taskkill требует отдельного доступа к списку процессов и может зависнуть в sandbox.
    child.kill('SIGKILL');
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

export async function executePhase(pair, tuning, phase, options) {
  const directory = resolve(options.directory, `${phase}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const descriptor = {
    root: projectRoot,
    pair,
    tuning,
    phase,
    runId: options.runId,
    pairKey: pairKey(pair),
    reportPath: resolve(directory, 'report.json'),
    evidencePath: resolve(directory, 'evidence.json'),
    testTimeoutMs: options.testTimeoutMs,
  };
  await writeFile(resolve(directory, 'descriptor.json'), JSON.stringify(descriptor, null, 2));
  const args = [
    vitest,
    'run',
    '--config',
    resolve(projectRoot, 'scripts/mutation/vitest.config.ts'),
    '--testNamePattern',
    `^${escapeRegex(pair.fullName.join(' '))}$`,
  ];
  const env = { ...process.env, TD_MUTATION_DESCRIPTOR: JSON.stringify(descriptor) };
  // Вложенный Vitest не наследует состояние worker родительского теста оснастки.
  for (const key of ['VITEST', 'VITEST_WORKER_ID', 'VITEST_POOL_ID']) delete env[key];
  let stdout = '',
    stderr = '',
    timedOut = false,
    launchError;
  const child = spawn(process.execPath, args, {
    cwd: resolve(projectRoot, 'packages/sim'),
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void killProcess(child);
  }, options.timeoutMs ?? 600000);
  const exitCode = await new Promise((done) => {
    child.once('error', (error) => {
      launchError = error.message;
    });
    child.once('close', (code) => done(code));
  });
  clearTimeout(timer);
  await writeFile(resolve(directory, 'stdout.log'), stdout);
  await writeFile(resolve(directory, 'stderr.log'), stderr);
  if (timedOut || launchError)
    return { error: timedOut ? 'Process timeout' : launchError, directory, exitCode };
  let raw = '';
  try {
    raw = await readFile(descriptor.reportPath, 'utf8');
  } catch {
    /* Модель вернёт явную ошибку. */
  }
  return { ...readPhaseReport(raw, descriptor, exitCode), directory, exitCode };
}

export async function executePair(pair, mutation, options) {
  const baseline = await executePhase(pair, {}, 'baseline', options);
  const baselineError = phaseError(baseline, { pair, runId: options.runId, phase: 'baseline' });
  const mutant =
    baselineError || baseline.status !== 'passed'
      ? null
      : await executePhase(pair, mutation.tuning, 'mutant', options);
  return {
    ...classifyPair(pair, baseline, mutant, options.runId),
    pair,
    mutation,
    baseline,
    mutant,
  };
}
