import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { File, Task } from '@vitest/runner';

const descriptor = JSON.parse(process.env.TD_MUTATION_DESCRIPTOR!);
function fullName(task: Task): string[] {
  const names = [task.name];
  let parent = task.suite;
  while (parent && !('filepath' in parent)) {
    names.unshift(parent.name);
    parent = parent.suite;
  }
  return names;
}
export default class MutationReporter {
  onFinished(files: File[] = [], errors: unknown[] = []) {
    const tests: Task[] = [];
    const suiteErrors: unknown[] = [];
    function visit(task: Task) {
      if (task.type === 'suite') {
        suiteErrors.push(...(task.result?.errors || []));
        task.tasks.forEach(visit);
      } else tests.push(task);
    }
    files.forEach(visit);
    const selected = tests.filter(
      (test) => JSON.stringify(fullName(test)) === JSON.stringify(descriptor.pair.fullName),
    );
    const test = selected[0];
    const unexpected = tests.filter(
      (candidate) =>
        !selected.includes(candidate) && ['pass', 'fail'].includes(candidate.result?.state || ''),
    );
    if (unexpected.length) suiteErrors.push('Unexpected additional tests executed');
    let evidence = {};
    try {
      evidence = JSON.parse(readFileSync(descriptor.evidencePath, 'utf8'));
    } catch {
      /* Отсутствие свидетельства проверяет модель. */
    }
    const testErrors = test?.result?.errors || [];
    const hookErrors = Object.entries(test?.result?.hooks || {}).filter(
      ([, state]) => state !== 'pass',
    );
    const report = {
      ...evidence,
      runId: descriptor.runId,
      phase: descriptor.phase,
      pairKey: descriptor.pairKey,
      evidenceIdentityValid: ['runId', 'phase', 'pairKey'].every(
        (key) => evidence[key as keyof typeof evidence] === descriptor[key],
      ),
      selectedCount: selected.length,
      testFile: test ? relative(descriptor.root, test.file.filepath).replaceAll('\\', '/') : null,
      fullName: test ? fullName(test) : null,
      status:
        test?.result?.state === 'pass'
          ? 'passed'
          : test?.result?.state === 'fail'
            ? 'failed'
            : 'skipped',
      hookErrors,
      runnerErrors: [...errors, ...suiteErrors],
      testErrors,
    };
    writeFileSync(descriptor.reportPath, JSON.stringify(report, null, 2));
  }
}
