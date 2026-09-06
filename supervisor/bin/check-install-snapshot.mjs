import { pathToFileURL } from 'node:url';
import { checkInstallSnapshot } from '../lib/install-snapshot-check.mjs';

export function main(
  args = process.argv.slice(2),
  { check = checkInstallSnapshot, output = console.log } = {},
) {
  if (args.length === 0) {
    output(
      'Run from the assigned workspace: node supervisor/bin/check-install-snapshot.mjs --run\nCreates a fresh snapshot in .matchlog and performs a real pnpm install. Keep the tool cwd in the assigned workspace.',
    );
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--run') {
    output('Expected no arguments (help) or exactly --run');
    return 2;
  }
  const result = check({ cwd: process.cwd() });
  output(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
