import { describe, expect, it, vi } from 'vitest';
import { main } from './check-install-snapshot.mjs';

describe('check-install-snapshot CLI', () => {
  it.each([[], ['--help'], ['--run', 'elsewhere'], ['--unknown']])(
    'does not write for %j',
    (...args) => {
      const check = vi.fn();
      const output = vi.fn();
      expect(main(args, { check, output })).toBe(args.length ? 2 : 0);
      expect(check).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalled();
    },
  );
  it.each([true, false])('returns the library result: %s', (ok) => {
    const check = vi.fn(() => ({ ok, stage: 'test' }));
    const output = vi.fn();
    expect(main(['--run'], { check, output })).toBe(ok ? 0 : 1);
    expect(check).toHaveBeenCalledWith({ cwd: process.cwd() });
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({ ok, stage: 'test' });
  });
});
