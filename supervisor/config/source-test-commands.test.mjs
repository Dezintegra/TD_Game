import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { coversCommand, patternOf } from './permissions.mjs';
import { parseSourceArgs, validateSelection } from '../../scripts/testing/source-runner.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const documents = [
  'CLAUDE.md',
  'docs/agent-setup.md',
  'docs/narrow-source-tests.md',
  'supervisor/skills/design.md',
  'supervisor/skills/implement.md',
  'supervisor/skills/revise.md',
];
const permissions = JSON.parse(read('supervisor/config/stage-settings.json')).permissions;
const allowed = (settings, command) => {
  const matches = (rules) =>
    rules.some((rule) => {
      const pattern = patternOf(rule, 'PowerShell');
      return pattern && coversCommand(pattern, command);
    });
  return matches(settings.allow) && !matches(settings.deny);
};

function checkDocument(path, text, settings) {
  const commands = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('node scripts/test-source.mjs --environment'));
  expect(commands.length, path).toBeGreaterThan(0);
  for (const command of commands) {
    const selection = parseSourceArgs(command.split(' ').slice(2));
    expect(() => validateSelection(selection, root), command).not.toThrow();
    expect(allowed(settings, command), command).toBe(true);
  }
  expect(commands.some((command) => command.includes('--environment node'))).toBe(true);
  expect(commands.some((command) => command.includes('--environment jsdom'))).toBe(true);
  expect(text).not.toContain('npx vitest run <свой файл теста>');
  expect(text).toContain('dist');
  expect(text).toContain('pnpm install --frozen-lockfile --prefer-offline');
  if (path.endsWith('/revise.md')) {
    expect(text).toMatch(/при отсутствии node_modules, даже если lockfile\s+не менялся/);
    expect(text.indexOf('pnpm install --frozen-lockfile --prefer-offline')).toBeLessThan(
      text.indexOf('7. **Красный CI'),
    );
  }
}

it.each(documents)('checks executable source examples in %s', (path) => {
  checkDocument(path, read(path), permissions);
});

it('covers only the intended new entry points and keeps full sets unavailable', () => {
  for (const mode of ['--fresh', '--installed']) {
    const command = `node scripts/testing/check-source-tests.mjs ${mode}`;
    expect(permissions.allow).toContain(`PowerShell(${command})`);
    expect(allowed(permissions, command)).toBe(true);
    expect(allowed(permissions, `${command} --extra`)).toBe(false);
    expect(read('docs/narrow-source-tests.md')).toContain(command);
  }
  for (const command of [
    'pnpm verify',
    'pnpm test:match',
    'pnpm verify:all',
    'node scripts/anything.mjs',
  ])
    expect(allowed(permissions, command)).toBe(false);
  expect(read('supervisor/skills/implement.md').replace(/\s+/g, ' ')).toContain(
    'Ни `pnpm verify`, ни `pnpm test:match`, ни `pnpm verify:all`',
  );
  expect(read('supervisor/skills/revise.md')).toContain('полный матчевый набор запрещён');
});

it('retains the same runner in the delivery adapter and preserves 0013 ownership', () => {
  const text = read('docs/narrow-source-tests.md');
  for (const marker of [
    "import { sourceMain } from '../scripts/testing/source-runner.mjs'",
    "import { checkSourceMain } from '../scripts/testing/check-source-tests.mjs'",
    "checkSourceMain(['--fresh'])",
    'increase-unit-spacing',
    'PR 265',
    'incidentVerification',
    'incidentId',
    'пункта 1.1',
    'пункта 2.1',
    'пункта 3.1',
    'один\n   коммит',
  ])
    expect(text).toContain(marker);
  expect(allowed(permissions, 'node .matchlog/0337-check-source-tests.mjs')).toBe(true);
  for (const file of [
    'determinism.golden.match.test.ts',
    'profile.golden.match.test.ts',
    'navigation.test.ts',
  ])
    expect(text).toContain(file);
});

it.each(['permission', 'missing-files', 'legacy', 'install'])('detects %s regression', (kind) => {
  const path = 'supervisor/skills/revise.md';
  let text = read(path);
  const settings = globalThis.structuredClone(permissions);
  if (kind === 'permission')
    settings.allow = settings.allow.filter(
      (rule) => !rule.includes('node scripts/test-source.mjs'),
    );
  if (kind === 'missing-files')
    text = text.replaceAll(
      'packages/sim/src/crowd.test.ts',
      'packages/sim/src/not-present.test.ts',
    );
  if (kind === 'legacy')
    text = text.replaceAll(
      'node scripts/test-source.mjs --environment node',
      'npx vitest run <свой файл теста>',
    );
  if (kind === 'install')
    text = text.replace('при отсутствии node_modules, даже если lockfile', 'только если lockfile');
  expect(() => checkDocument(path, text, settings)).toThrow();
});
