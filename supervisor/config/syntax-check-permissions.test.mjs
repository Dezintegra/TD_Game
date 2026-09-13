import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { uncoveredCommands } from './permissions.mjs';

const permissions = JSON.parse(
  readFileSync(new URL('./stage-settings.json', import.meta.url), 'utf8'),
).permissions;
const shells = ['Bash', 'PowerShell'];
const syntaxCommands = [
  'node --check supervisor/config/permissions.mjs',
  'node --check "supervisor/config/path with spaces.mjs"',
];
const preparationCommands = [
  'pnpm install --frozen-lockfile',
  'pnpm install --frozen-lockfile --prefer-offline',
  'npx eslint supervisor/config/syntax-check-permissions.test.mjs',
  'npx prettier --check supervisor/config/stage-settings.json',
  'npx vitest run --root supervisor config/syntax-check-permissions.test.mjs',
];
const executionCommands = [
  'node supervisor/config/permissions.mjs',
  'node --check-extra supervisor/config/permissions.mjs',
  'node --eval "2"',
];
const uncoveredIn = (shell, commands) => commands.map((command) => `${shell}: ${command}`);
const allExecutionDenied = shells.flatMap((shell) => uncoveredIn(shell, executionCommands));

// Строки команд — только входы модели: тест не запускает их в оболочке.
describe('syntax check permissions', () => {
  it('covers syntax checks and existing preparation in both shells', () => {
    expect(uncoveredCommands(permissions, [...syntaxCommands, ...preparationCommands])).toEqual([]);
  });

  it('keeps execution and neighbouring Node options uncovered', () => {
    expect(uncoveredCommands(permissions, executionCommands)).toEqual(allExecutionDenied);
  });

  describe.each(shells)('%s controls', (shell) => {
    it('detects a removed syntax check permission in precisely this shell', () => {
      const changed = JSON.parse(JSON.stringify(permissions));
      changed.allow = changed.allow.filter((rule) => rule !== `${shell}(node --check:*)`);
      expect(uncoveredCommands(changed, [...syntaxCommands, ...preparationCommands])).toEqual(
        uncoveredIn(shell, syntaxCommands),
      );
    });

    it('detects an exact permission without the file argument', () => {
      const changed = JSON.parse(JSON.stringify(permissions));
      changed.allow = changed.allow.map((rule) =>
        rule === `${shell}(node --check:*)` ? `${shell}(node --check)` : rule,
      );
      expect(uncoveredCommands(changed, syntaxCommands)).toEqual(
        uncoveredIn(shell, syntaxCommands),
      );
    });

    it('detects a deny overriding the syntax check allow', () => {
      const changed = JSON.parse(JSON.stringify(permissions));
      changed.deny.push(`${shell}(node --check:*)`);
      expect(uncoveredCommands(changed, syntaxCommands)).toEqual(
        uncoveredIn(shell, syntaxCommands),
      );
    });

    it('detects a broad Node permission through the execution guard', () => {
      const changed = JSON.parse(JSON.stringify(permissions));
      changed.allow = changed.allow.map((rule) =>
        rule === `${shell}(node --check:*)` ? `${shell}(node:*)` : rule,
      );
      const uncovered = uncoveredCommands(changed, executionCommands);
      expect(uncovered).not.toEqual(allExecutionDenied);
      expect(uncovered).toEqual(
        shells
          .filter((other) => other !== shell)
          .flatMap((other) => uncoveredIn(other, executionCommands)),
      );
    });
  });
});
