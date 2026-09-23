import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coversCommand, patternOf, SHELLS, uncoveredCommands } from './permissions.mjs';

const { permissions } = JSON.parse(
  readFileSync(new URL('./stage-settings.json', import.meta.url), 'utf8'),
);
const prefixes = ['git', 'git -C "C:/probe repo"'];
const leases = prefixes.map((prefix) => `${prefix} push --force-with-lease origin probe-0078`);
const forces = prefixes.flatMap((prefix) => [
  `${prefix} push --force`,
  `${prefix} push --force origin probe-0078`,
]);

function denied(rules, shell, command) {
  return rules.some((rule) => {
    const pattern = patternOf(rule, shell);
    return pattern !== null && coversCommand(pattern, command);
  });
}

// Это регрессионная модель настройки; живое поведение проверяется отдельной пробой.
describe('lease и безусловная принудительная отправка', () => {
  it('покрывает обычную отправку и lease в обеих формах', () => {
    expect(
      uncoveredCommands(permissions, [
        ...leases,
        ...prefixes.map((prefix) => `${prefix} push origin probe-0078`),
      ]),
    ).toEqual([]);
  });

  for (const shell of SHELLS) {
    it(`${shell}: запрещает полный токен force с доводами и без них`, () => {
      for (const command of forces)
        expect(denied(permissions.deny, shell, command), command).toBe(true);
      for (const command of leases)
        expect(denied(permissions.deny, shell, command), command).toBe(false);
    });
  }

  it('замечает чрезмерный запрет, перекрывающий lease', () => {
    const tooBroad = {
      ...permissions,
      deny: [...permissions.deny, ...SHELLS.map((shell) => `${shell}(git * push --force*)`)],
    };
    expect(uncoveredCommands(tooBroad, [leases[1]])).toEqual(
      SHELLS.map((shell) => `${shell}: ${leases[1]}`),
    );
  });

  it('замечает снятие защиты force, несмотря на широкое allow', () => {
    const unprotected = {
      ...permissions,
      deny: permissions.deny.filter((rule) => !rule.includes('push --force')),
    };
    expect(uncoveredCommands(unprotected, forces)).toEqual([]);
    for (const shell of SHELLS) {
      for (const command of forces)
        expect(denied(unprotected.deny, shell, command), command).toBe(false);
    }
  });
});
