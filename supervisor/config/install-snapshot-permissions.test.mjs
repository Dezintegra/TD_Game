import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rules = JSON.parse(readFileSync(new URL('./stage-settings.json', import.meta.url), 'utf8'))
  .permissions.allow;
const command = 'node supervisor/bin/check-install-snapshot.mjs';

function allowed(value) {
  return rules.some((rule) => {
    if (!rule.startsWith('PowerShell(')) return false;
    const pattern = rule.slice(11, -1);
    if (pattern.endsWith(':*'))
      return value === pattern.slice(0, -2) || value.startsWith(`${pattern.slice(0, -2)} `);
    return new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(value);
  });
}

describe('install snapshot permissions', () => {
  it('allows precisely help and run', () => {
    expect(rules).toContain(`PowerShell(${command})`);
    expect(rules).toContain(`PowerShell(${command} --run)`);
    expect(allowed(command)).toBe(true);
    expect(allowed(`${command} --run`)).toBe(true);
  });
  it.each([
    `${command} --run elsewhere`,
    `${command} --other`,
    'node supervisor/bin/unrelated.mjs',
    'node supervisor/bin/supervise.mjs',
    'node supervisor/bin/launch.mjs --stop',
  ])('does not allow %s', (value) => {
    expect(allowed(value)).toBe(false);
  });
});
