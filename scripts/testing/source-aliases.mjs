import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function sourceAliases(root = repoRoot) {
  return [
    { find: /^@td\/shared$/, replacement: resolve(root, 'packages/shared/src/index.ts') },
    { find: /^@td\/sim$/, replacement: resolve(root, 'packages/sim/src/index.ts') },
  ];
}
