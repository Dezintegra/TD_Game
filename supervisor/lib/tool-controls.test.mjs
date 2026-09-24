import { describe, expect, it } from 'vitest';
import { toolControls } from './tool-controls.mjs';

describe('historical read-only profiles', () => {
  it.each([
    ['historical-revise', 'revise', ['revise']],
    ['historical-revise-design', 'revise', ['revise', 'design']],
    ['historical-audit', 'audit', ['audit']],
  ])('%s contains only the assigned reads and lock-free status', (profile, stage, skills) => {
    const controls = toolControls({ profile, stage, cwd: 'C:/assigned tree', id: 'request' });
    expect(controls.map((control) => control.argv)).toEqual([
      ...skills.map((skill) => ['Get-Content', `supervisor/skills/${skill}.md`]),
      ['git', '-C', 'C:/assigned tree', '--no-optional-locks', 'status', '--porcelain'],
    ]);
    expect(new Set(controls.map((control) => control.invocationId)).size).toBe(controls.length);
  });
  it('rejects unknown profiles and mismatched stages', () => {
    for (const profile of ['arbitrary', '__proto__', 'constructor', null]) {
      expect(() => toolControls({ profile, stage: 'revise' })).toThrow(
        'Invalid diagnostic profile',
      );
    }
    expect(() => toolControls({ profile: 'historical-audit', stage: 'revise' })).toThrow(
      'stage mismatch',
    );
  });
});
