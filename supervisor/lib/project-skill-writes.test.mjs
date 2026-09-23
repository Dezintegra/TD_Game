import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const state = vi.hoisted(() => ({ manifest: null, broken: null, git: [], reads: [] }));
vi.mock('node:fs', async (original) => {
  const actual = await original();
  return {
    ...actual,
    readFileSync(file, ...args) {
      state.reads.push(file);
      if (String(file).endsWith('project-skill-writes.json')) return JSON.stringify(state.manifest);
      if (String(file).endsWith('.git')) return `gitdir: ${state.gitdir}`;
      return actual.readFileSync(file, ...args);
    },
    realpathSync(file) {
      return state.broken === 'realpath' ? `${file}-elsewhere` : file;
    },
    lstatSync(file) {
      if (state.broken === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const directory = !String(file).endsWith('SKILL.md') && file !== state.pointer;
      return {
        isSymbolicLink: () => state.broken === 'link',
        isFile: () => !directory && state.broken !== 'directory',
        isDirectory: () => directory,
        nlink: state.broken === 'hardlink' ? 2 : 1,
      };
    },
    statSync() {
      return { isFile: () => true };
    },
  };
});
vi.mock('node:child_process', () => ({
  execFileSync(program, args) {
    if (program === 'powershell') return state.broken === 'reparse' ? '1024' : '16';
    state.git.push(args);
    if (args.includes('--absolute-git-dir'))
      return state.broken === 'gitdir' ? `${state.root}-other/.git/tree` : state.gitdir;
    if (args.includes('--git-common-dir')) return path.join(state.root, '.git');
    if (args.includes('--show-toplevel')) return state.cwd;
    if (args.includes('symbolic-ref'))
      return state.broken === 'branch' ? 'main' : `worktree-${state.taskId}`;
    if (args.includes('list'))
      return state.broken === 'registry' ? '' : `worktree ${state.cwd}\0HEAD abc\0\0`;
    throw new Error(`unexpected command ${args}`);
  },
}));

import {
  pathWithin,
  resolveProjectSkillWrites,
  skillRelativePath,
} from './project-skill-writes.mjs';
import { stageCommand } from './stage-command.mjs';
import { resolveConfig } from '../config/defaults.mjs';

const home = fileURLToPath(new URL('..', import.meta.url));
const taskId = '0083-pravka-purpose-speki-ne-dostavlyaetsya-d';
const change = 'guard-declared-purpose-updates';
const files = [
  '.agents/skills/openspec-archive-change/SKILL.md',
  '.agents/skills/openspec-sync-specs/SKILL.md',
];
let params;
beforeEach(() => {
  Object.assign(state, {
    taskId,
    root: path.resolve('fixture-root'),
    cwd: path.resolve('fixture-root/tree'),
    gitdir: path.resolve('fixture-root/.git/worktrees/tree'),
    pointer: path.resolve('fixture-root/tree/.git'),
    broken: null,
    git: [],
    reads: [],
    manifest: {
      version: 1,
      entries: [{ taskId, change, stages: ['implement', 'revise'], files: [...files] }],
    },
  });
  params = {
    home,
    root: state.root,
    cwd: state.cwd,
    platform: 'win32',
    assignment: {
      taskId,
      stage: 'implement',
      path: 'tree',
      task: { id: taskId, links: { change } },
    },
  };
});

describe('доверенное назначение', () => {
  it('выдаёт ровно два файла и digest перечня из home', () => {
    const result = resolveProjectSkillWrites(params);
    expect(result.files).toEqual(files.map((file) => path.join(state.cwd, file)));
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.source).toBe(path.join(home, 'config/project-skill-writes.json'));
    expect(state.reads).toEqual([result.source]);
    expect(state.git.length).toBeGreaterThan(0);
  });
  it.each(['design', 'audit', 'review', 'cleanup'])('не выдаёт прав на этапе %s', (stage) => {
    params.assignment.stage = stage;
    expect(resolveProjectSkillWrites(params).files).toEqual([]);
    expect(state.git).toEqual([]);
  });
  it('не доверяет произвольным files и промпту другой карточки', () => {
    params.assignment.taskId = '9999-other';
    params.assignment.task.id = '9999-other';
    params.assignment.files = files;
    expect(resolveProjectSkillWrites(params).files).toEqual([]);
  });
  it.each(['task', 'id', 'change'])('отвергает неверное %s', (kind) => {
    if (kind === 'task') delete params.assignment.task;
    if (kind === 'id') params.assignment.task.id = 'other';
    if (kind === 'change') params.assignment.task.links.change = 'other';
    expect(() => resolveProjectSkillWrites(params)).toThrow('task/change');
  });
  it('не обещает права на POSIX', () => {
    params.platform = 'linux';
    expect(() => resolveProjectSkillWrites(params)).toThrow('Windows');
  });
  it('перечитывает назначение при resume и не сохраняет старую выдачу', () => {
    const first = resolveProjectSkillWrites(params);
    params.assignment.continuation = true;
    params.assignment.sessionId = 'old';
    state.manifest.entries = [];
    const second = resolveProjectSkillWrites(params);
    expect(second.files).toEqual([]);
    expect(second.digest).not.toBe(first.digest);
  });
  it.each([null, {}, { version: 2, entries: [] }, { version: 1, entries: [null] }])(
    'отвергает схему %j',
    (manifest) => {
      state.manifest = manifest;
      expect(() => resolveProjectSkillWrites(params)).toThrow('project-skill-writes');
    },
  );
  it.each(['files', 'stages', 'entry'])('отвергает повтор %s', (kind) => {
    const entry = state.manifest.entries[0];
    if (kind === 'entry') state.manifest.entries.push(entry);
    else entry[kind].push(entry[kind][0]);
    expect(() => resolveProjectSkillWrites(params)).toThrow('project-skill-writes');
  });
});

describe('границы файлов', () => {
  it.each([
    '../x',
    '.agents/skills/../SKILL.md',
    '.agents/skills/x/./SKILL.md',
    '.agents/skills/*/SKILL.md',
    '.agents/skills/x/SKILL.md:stream',
    'C:/x/SKILL.md',
    '//server/x',
    '\\\\?\\C:\\x',
    '.agents\\skills\\x\\SKILL.md',
    '.agents/skills/x/other.md',
    '.agents/skills/x./SKILL.md',
  ])('отвергает %s', (file) => {
    expect(() => skillRelativePath(file)).toThrow('точный относительный');
  });
  it('сравнивает компоненты, регистр и разделители Windows', () => {
    expect(pathWithin('C:\\Tree', 'c:/tree/.agents/x', 'win32')).toBe(true);
    expect(pathWithin('C:\\Tree', 'C:/Tree-other/x', 'win32')).toBe(false);
    expect(pathWithin('C:\\Tree', 'C:/Tree', 'win32')).toBe(false);
    expect(pathWithin('C:\\Tree', 'D:/Tree/x', 'win32')).toBe(false);
  });
  it.each(['link', 'hardlink', 'realpath', 'missing', 'directory', 'gitdir', 'branch', 'registry'])(
    'отвергает %s',
    (kind) => {
      state.broken = kind;
      expect(() => resolveProjectSkillWrites(params)).toThrow();
    },
  );
  it.runIf(process.platform === 'win32')('отвергает любой Windows reparse tag', () => {
    state.broken = 'reparse';
    expect(() => resolveProjectSkillWrites(params)).toThrow('reparse');
  });
  it('отвергает main и подменённый cwd', () => {
    expect(() => resolveProjectSkillWrites({ ...params, cwd: state.root })).toThrow(
      'основное дерево',
    );
    expect(() => resolveProjectSkillWrites({ ...params, cwd: `${state.cwd}-other` })).toThrow(
      'cwd',
    );
  });
});

it.runIf(process.platform === 'win32')(
  'stageCommand проводит оба файла и пересчитывает их при resume',
  () => {
    const input = {
      ...params,
      config: resolveConfig({ provider: 'codex' }).config,
      prompt: 'ignored permissions',
    };
    const command = stageCommand(input);
    const profile = command.args.find((arg) => arg.startsWith('permissions='));
    for (const file of files)
      expect(profile).toContain(path.join(state.cwd, file).replaceAll('\\', '/'));
    expect(command.skillWrites.files).toHaveLength(2);
    expect(command.args).toContain('approval_policy="never"');
    input.assignment.continuation = true;
    input.assignment.sessionId = 'old';
    const resumed = stageCommand(input);
    expect(resumed.args.slice(-3)).toEqual(['resume', 'old', '-']);
    expect(resumed.skillWrites).toEqual(command.skillWrites);
    state.manifest.entries = [];
    const revoked = stageCommand(input);
    expect(revoked.skillWrites.files).toEqual([]);
    expect(revoked.args.find((arg) => arg.startsWith('permissions='))).not.toContain('/.agents/');
  },
);
