import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { taskFromRequest } from './requests.mjs';
import { isLocalRun } from './run-source.mjs';
import { createAssignmentPreparer } from './benchmark-source.mjs';
import { createSupervisor } from './supervisor.mjs';
import { resolveConfig } from '../config/defaults.mjs';
import { NEEDS_WORKTREE } from '../config/transitions.mjs';

const home = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const skills = ['implement', 'revise', 'review', 'deploy', 'triage'];
const accept = (request) =>
  taskFromRequest(
    { categories: ['infrastructure'], ...request },
    {
      id: '0089-local-run',
      now: '2026-09-09T00:00:00Z',
      sourceId: '0041-visual',
    },
  );
function localRequests(value) {
  if (!value || typeof value !== 'object') return [];
  if (value.type === 'run' && isLocalRun(value.run)) return [value];
  return Object.values(value).flatMap(localRequests);
}
function examples(text) {
  return [...text.matchAll(/```json\s*\n([\s\S]*?)\n[ \t]*```/g)].flatMap((match) =>
    localRequests(JSON.parse(match[1])),
  );
}
function senderProblems(text) {
  const required = [
    /perf или bench-tick обязателен\s+`run.params.source`/,
    /ровно с одним ключом `branch` или `worktree`/,
    /текущая локальная ревизия при старте/,
    /Автоматического checkout,\s+создания или обновления дерева нет/,
    /`run.params.change`[^\n]*не заменяет источник кода/,
    /без подстановки main/,
  ];
  return required
    .filter((pattern) => !pattern.test(text))
    .map(String)
    .concat(examples(text).flatMap((request) => accept(request).problems));
}
function benchmarkProblems(text) {
  const required = [
    'независимо от типа задачи обязателен `run.params.source`',
    'процесс из `benchmarkSource.path`',
    'без подстановки main',
    'git -C <дерево> rev-parse --show-toplevel',
    'git -C <дерево> rev-parse --symbolic-full-name HEAD',
    'git -C <дерево> rev-parse --verify HEAD',
    'git -C <дерево> status --porcelain --untracked-files=no',
    'до подготовки зависимостей, непосредственно перед замером',
    'и после замера.',
    'SHA — `benchmarkSource.head`',
    'статус отслеживаемых исходников — пустой',
    'после замера не выдавай числа за ответ на заказ',
    'фактический абсолютный путь, ветку или detached и полный SHA',
    'не заменяют обязательный `links.run`',
    'не подписывай запись history SHA текущего замера',
  ];
  return required.filter((part) => !text.includes(part));
}

describe('заявки в инструкциях проходят настоящую приёмку', () => {
  it.each(skills)('%s объявляет обязательный источник', (name) => {
    const text = read(`../skills/${name}.md`);
    expect(senderProblems(text)).toEqual([]);
    const withoutRule = text.replace(/## Источник локального замера[\s\S]*?(?=## Отчёт)/, '');
    expect(senderProblems(withoutRule).length).toBeGreaterThan(0);
    for (const request of examples(text)) {
      expect(accept(request).task).not.toBeNull();
      const missing = globalThis.structuredClone(request);
      delete missing.run.params.source;
      expect(accept(missing).task).toBeNull();
      expect(accept(missing).problems.join(' ')).toContain('run.params.source');
    }
  });
  it('контроль обнаруживает прежние params: {} в review', () => {
    const text = read('../skills/review.md');
    expect(examples(text).length).toBeGreaterThan(0);
    const regression = text.replace('"params": { "source": { "branch": "main" } }', '"params": {}');
    expect(regression).not.toBe(text);
    expect(senderProblems(regression).join(' ')).toContain('run.params.source');
  });
  it('benchmark связывает три сверки с атрибуцией, не возвращается к main', () => {
    const text = read('../skills/benchmark.md');
    expect(benchmarkProblems(text)).toEqual([]);
    for (const phrase of [
      'процесс из `benchmarkSource.path`',
      'до подготовки зависимостей, непосредственно перед замером',
      'и после замера.',
      'git -C <дерево> rev-parse --verify HEAD',
      'фактический абсолютный путь, ветку или detached и полный SHA',
    ])
      expect(benchmarkProblems(text.replace(phrase, '')).length).toBeGreaterThan(0);
    expect(
      benchmarkProblems(
        text.replace(
          /3\. \*\*Проверь назначенный источник кода\.[\s\S]*?(?=4\. \*\*Арена)/,
          '3. Любой run работает в main.\n',
        ),
      ).length,
    ).toBeGreaterThan(0);
    expect(text).toContain('perf-lock');
    expect(text).toContain('--client-port 5199 --port 3055');
    expect(text).toContain('pnpm install --frozen-lockfile --prefer-offline');
    expect(text).toContain('pnpm build');
  });
});

const root = resolve('virtual repo');
const tree = resolve('outside source tree');
const mainHead = '1'.repeat(40);
const initialHead = '2'.repeat(40);
function harness(provider, state = { present: true, head: initialHead }) {
  const calls = [];
  const children = [];
  const config = resolveConfig({ provider, codexMaxTaskTokens: null }).config;
  const ops = {
    prepareDeploySnapshot: vi.fn((_root, _config, a) => {
      calls.push('deploy');
      return a.stage === 'deploy' ? { ...a, path: '.pipeline/deploy-checkouts/snapshot' } : a;
    }),
    prepareCodexPerfFiles: vi.fn((...args) => calls.push(['files', ...args])),
    realpath: (path) => resolve(path),
    git: vi.fn((cwd, ...args) => {
      const command = args.join(' ');
      calls.push(command);
      if (state.error) throw new Error(state.error);
      if (command === 'worktree list --porcelain -z')
        return (
          `worktree ${root}\0branch refs/heads/main\0\0` +
          (state.present ? `worktree ${tree}\0branch refs/heads/worktree-0041-visual\0\0` : '')
        );
      if (command === 'rev-parse --show-toplevel') return cwd;
      if (command === 'rev-parse --path-format=absolute --git-common-dir')
        return resolve(root, '.git');
      if (command === 'rev-parse --symbolic-full-name HEAD')
        return `refs/heads/${cwd === root ? 'main' : 'worktree-0041-visual'}`;
      if (command === 'rev-parse --verify HEAD') return cwd === root ? mainHead : state.head;
      throw new Error(`unexpected command: ${command}`);
    }),
  };
  const prepareAssignment = createAssignmentPreparer(root, config, ops);
  const evidence = vi.fn(() => ({ ok: false, reason: 'test-evidence' }));
  const supervisor = createSupervisor({
    root,
    home,
    config,
    prepareAssignment,
    readCodexEvidence: evidence,
    spawn: (program, args, options) => {
      calls.push('spawn');
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = (text) => {
        child.prompt = text;
      };
      child.options = options;
      children.push(child);
      return child;
    },
    killTree: vi.fn(),
  });
  return { supervisor, prepareAssignment, calls, children, ops, evidence };
}
const assignment = (source, kind = 'perf', type = 'run') => ({
  taskId: '0089-local-run',
  stage: 'benchmark',
  path: null,
  task: { id: '0089-local-run', type, run: { kind, params: { source }, expectation: '55 FPS' } },
});
const promptAssignment = (text) =>
  JSON.parse(text.slice(text.lastIndexOf('## Назначение')).match(/```json\n([\s\S]*?)\n```/)[1]);

describe.each(['claude', 'codex'])('производственная композиция %s', (provider) => {
  it.each(['perf', 'bench-tick'])(
    'доставляет %s в настоящее порождение, промпт и свидетельство',
    async (kind) => {
      for (const type of ['run', 'feature'])
        for (const source of [
          { branch: 'main' },
          { branch: 'worktree-0041-visual' },
          { worktree: tree },
        ]) {
          const h = harness(provider);
          const input = assignment(source, kind, type);
          const expectedPath = source.branch === 'main' ? root : tree;
          const expectedHead = expectedPath === root ? mainHead : initialHead;
          const launched = h.supervisor.spawnStage(input);
          expect(launched, JSON.stringify(launched)).toMatchObject({ ok: true });
          expect(input.path).toBeNull();
          const child = h.children[0];
          expect(child.options.cwd).toBe(expectedPath);
          expect(promptAssignment(child.prompt)).toMatchObject({
            worktree: expectedPath,
            benchmarkSource: { source, path: expectedPath, head: expectedHead },
          });
          expect(h.calls.indexOf('rev-parse --verify HEAD')).toBeLessThan(h.calls.indexOf('spawn'));
          if (provider === 'codex') {
            expect(h.ops.prepareCodexPerfFiles).toHaveBeenCalledWith(root, expectedPath);
            expect(h.calls.indexOf('rev-parse --verify HEAD')).toBeLessThan(
              h.calls.findIndex((call) => Array.isArray(call) && call[0] === 'files'),
            );
          } else expect(h.ops.prepareCodexPerfFiles).not.toHaveBeenCalled();
          child.emit('close', 0);
          await sleep(0);
          if (provider === 'codex') expect(h.evidence.mock.calls[0][0].path).toBe(expectedPath);
        }
    },
  );
  it.each([undefined, { branch: 'missing' }])(
    'не готовит файлы и не порождает процесс при %j',
    (source) => {
      const h = harness(provider);
      expect(h.supervisor.spawnStage(assignment(source))).toMatchObject({
        ok: false,
        reason: 'not-born',
        why: expect.stringContaining('run.params.source'),
      });
      expect(h.ops.prepareCodexPerfFiles).not.toHaveBeenCalled();
      expect(h.children).toHaveLength(0);
    },
  );
  it('повторно разрешает источник при продолжении; исчезновение и EACCES не заменяет main', () => {
    const state = { present: true, head: initialHead };
    const h = harness(provider, state);
    const first = h.prepareAssignment(assignment({ branch: 'worktree-0041-visual' }));
    state.head = '3'.repeat(40);
    const resumed = { ...first, continuation: true, path: root };
    expect(h.prepareAssignment(resumed, first).benchmarkSource.head).toBe(state.head);
    h.ops.prepareCodexPerfFiles.mockClear();
    state.present = false;
    expect(h.supervisor.spawnStage(resumed).why).toContain('найдено 0');
    state.error = 'EACCES';
    expect(h.supervisor.spawnStage(resumed).why).toContain('EACCES');
    expect(h.ops.prepareCodexPerfFiles).not.toHaveBeenCalled();
    expect(h.children).toHaveLength(0);
  });
  it('сохраняет прежнюю подготовку arena, interpret и deploy', () => {
    const h = harness(provider);
    const arena = assignment(undefined, 'arena');
    arena.task.run.params = { matches: 20, seed: 1 };
    for (const input of [arena, { ...assignment(undefined), stage: 'interpret' }]) {
      expect(h.prepareAssignment(input)).toBe(input);
      expect(h.ops.git).not.toHaveBeenCalled();
      if (provider === 'codex')
        expect(h.ops.prepareCodexPerfFiles).toHaveBeenLastCalledWith(root, root);
    }
    const input = { ...assignment(undefined), stage: 'deploy' };
    const previous = { deployment: { path: 'saved' } };
    const prepared = h.prepareAssignment(input, previous);
    expect(h.ops.prepareDeploySnapshot).toHaveBeenLastCalledWith(
      root,
      expect.any(Object),
      input,
      previous,
    );
    expect(prepared.path).toBe('.pipeline/deploy-checkouts/snapshot');
    expect(h.ops.git).not.toHaveBeenCalled();
    if (provider === 'codex')
      expect(h.ops.prepareCodexPerfFiles).toHaveBeenLastCalledWith(
        root,
        resolve(root, prepared.path),
      );
  });
});

it('entrypoint передаёт проверенную композицию и не заводит дерево для benchmark', () => {
  expect(read('../bin/supervise.mjs')).toMatch(
    /prepareAssignment:\s*createAssignmentPreparer\(root, config\)/,
  );
  expect(NEEDS_WORKTREE).not.toContain('benchmark');
});
