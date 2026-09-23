import { describe, it, expect, vi } from 'vitest';
import { dirname, join, parse, resolve } from 'node:path';
import {
  CONSUMER_TASK,
  HOST_DIRECTORY,
  TARGETS,
  CONTROLS,
  INITIAL,
  fixtureFiles,
  createHostFixture,
  verifyHostFixture,
  validateLinkedTree,
  ordinaryPath,
  within,
} from './project-skill-host-fixture.mjs';

function virtualIO() {
  const files = new Map();
  const dirs = new Set();
  const root = resolve('virtual-project');
  let tree = join(root, 'tree');
  let common = join(root, '.git');
  let gitdir = join(common, 'worktrees', 'tree');
  function directory(path) {
    dirs.add(path);
    if (dirname(path) !== path) directory(dirname(path));
  }
  directory(tree);
  directory(gitdir);
  files.set(join(tree, '.git'), `gitdir: ${gitdir}\n`);
  files.set(join(gitdir, 'gitdir'), join(tree, '.git'));
  files.set(join(gitdir, 'commondir'), '../..');
  const io = {
    platform: 'win32',
    checkTime: vi.fn(),
    now: () => 0,
    exec: vi.fn(() => '16'),
    fs: {
      lstatSync: vi.fn((path) => {
        if (!dirs.has(path) && !files.has(path))
          throw Object.assign(new Error(), { code: 'ENOENT' });
        return {
          isSymbolicLink: () => false,
          isDirectory: () => dirs.has(path),
          isFile: () => files.has(path),
          nlink: 1,
        };
      }),
      realpathSync: vi.fn((path) => path),
      readFileSync: vi.fn((path) => files.get(path)),
      mkdirSync: vi.fn((path, options) => {
        if (dirs.has(path) && !options?.recursive)
          throw Object.assign(new Error(), { code: 'EEXIST' });
        directory(path);
      }),
      writeFileSync: vi.fn((path, content, options) => {
        if (files.has(path) && options?.flag === 'wx')
          throw Object.assign(new Error(), { code: 'EEXIST' });
        files.set(path, content);
      }),
    },
    git: vi.fn((cwd, ...args) => {
      const command = args.join(' ');
      if (args[0] === 'init') {
        common = join(cwd, '.git');
        directory(common);
        return '';
      }
      if (args.includes('commit')) return '';
      if (args[0] === 'worktree' && args[1] === 'add') {
        tree = args.at(-1);
        gitdir = join(common, 'worktrees', 'tree');
        directory(tree);
        directory(gitdir);
        files.set(join(tree, '.git'), `gitdir: ${gitdir}\n`);
        files.set(join(gitdir, 'gitdir'), join(tree, '.git'));
        files.set(join(gitdir, 'commondir'), '../..');
        return '';
      }
      if (command === 'rev-parse --absolute-git-dir') return gitdir;
      if (command === 'rev-parse --path-format=absolute --git-common-dir') return common;
      if (command === 'rev-parse --show-toplevel') return tree;
      if (command === 'symbolic-ref --short HEAD') return `worktree-${CONSUMER_TASK}`;
      if (command === 'worktree list --porcelain -z')
        return `worktree ${tree}\0branch refs/heads/worktree-${CONSUMER_TASK}\0\0`;
      throw new Error(`Unexpected Git ${command}`);
    }),
  };
  return { io, root, tree, common, gitdir, files, dirs, directory };
}

describe('host path and Git identity', () => {
  it('requires all Git answers and both pointer directions', () => {
    const { io, root, tree, gitdir } = virtualIO();
    expect(validateLinkedTree(root, tree, CONSUMER_TASK, io).gitdir).toBe(gitdir);
    expect(io.git).toHaveBeenCalledTimes(5);
  });
  it.each([
    [
      'rev-parse --absolute-git-dir',
      resolve('virtual-project/.git-other/worktrees/tree'),
      'gitdir-mismatch',
    ],
    [
      'rev-parse --path-format=absolute --git-common-dir',
      resolve('foreign/.git'),
      'common-mismatch',
    ],
    ['rev-parse --show-toplevel', resolve('foreign/tree'), 'toplevel-mismatch'],
    ['symbolic-ref --short HEAD', 'main', 'branch-mismatch'],
    ['worktree list --porcelain -z', '', 'registration-mismatch'],
  ])('rejects %s mismatch', (command, answer, code) => {
    const { io, root, tree } = virtualIO();
    const original = io.git.getMockImplementation();
    io.git.mockImplementation((cwd, ...args) =>
      args.join(' ') === command ? answer : original(cwd, ...args),
    );
    expect(() => validateLinkedTree(root, tree, CONSUMER_TASK, io)).toThrow(code);
    expect(io.fs.mkdirSync).not.toHaveBeenCalled();
  });
  it.each(['link', 'reparse', 'redirect', 'hardlink'])('rejects %s before Git', (kind) => {
    const { io, root, tree } = virtualIO();
    if (kind === 'reparse') io.exec.mockReturnValue('1040');
    if (kind === 'redirect') io.fs.realpathSync.mockReturnValue(resolve('elsewhere'));
    if (kind === 'link') io.fs.lstatSync.mockReturnValue({ isSymbolicLink: () => true });
    if (kind === 'hardlink') {
      const original = io.fs.lstatSync.getMockImplementation();
      io.fs.lstatSync.mockImplementation((path) => ({ ...original(path), nlink: 2 }));
    }
    expect(() => validateLinkedTree(root, tree, CONSUMER_TASK, io)).toThrow();
    expect(io.git).not.toHaveBeenCalled();
  });
  it('does not accept a similar prefix as containment', () => {
    expect(within(resolve('base'), resolve('base-sibling/file'))).toBe(false);
    expect(within(resolve('base'), resolve('base'))).toBe(false);
  });
  it('rejects unknown Windows attributes', () => {
    const { io, tree } = virtualIO();
    io.exec.mockReturnValue('unknown');
    expect(() => ordinaryPath(tree, true, io)).toThrow('reparse-point');
  });
});

describe('fixed fixture', () => {
  it('creates and rechecks the fixed topology, then detects a changed control', () => {
    const { io, root, directory, files } = virtualIO();
    directory(join(root, '.matchlog'));
    const fixture = createHostFixture(root, io);
    expect(fixture.root).toBe(join(root, HOST_DIRECTORY, 'main'));
    expect(fixture.cwd).toBe(join(root, HOST_DIRECTORY, 'tree'));
    expect(Object.keys(verifyHostFixture(root, fixture, io))).toHaveLength(7);
    files.set(resolve(fixture.cwd, CONTROLS[2]), 'changed');
    expect(() => verifyHostFixture(root, fixture, io)).toThrow('fixture-content');
  });
  it('has the two targets, three controls and non-mutating r+ observer', () => {
    const files = fixtureFiles();
    for (const file of [...TARGETS, ...CONTROLS]) expect(files[file]).toBe(INITIAL);
    expect(Object.keys(files)).toHaveLength(7);
    expect(files['.matchlog/negative.mjs']).toContain("openSync(file, 'r+')");
    expect(files['.matchlog/negative.mjs']).toContain("result:'unexpected-write-access'}); break;");
    expect(files['.matchlog/negative.mjs']).not.toContain('writeFile');
  });
  it('stops at an occupied stand without initializing Git', () => {
    const { io, root, directory } = virtualIO();
    directory(join(root, HOST_DIRECTORY));
    expect(() => createHostFixture(root, io)).toThrow();
    expect(io.git).not.toHaveBeenCalled();
    expect(io.fs.writeFileSync).not.toHaveBeenCalled();
  });
  it('rejects changed topology without filesystem effects', () => {
    const { io, root } = virtualIO();
    expect(() => verifyHostFixture(root, { stand: root, cwd: root, root }, io)).toThrow(
      'fixture-topology',
    );
    expect(io.git).not.toHaveBeenCalled();
  });
  it('checks root components as well as the leaf', () => {
    const { io, tree } = virtualIO();
    ordinaryPath(tree, true, io);
    expect(io.fs.lstatSync).toHaveBeenCalledWith(parse(tree).root);
  });
});
