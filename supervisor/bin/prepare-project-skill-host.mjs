import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareProjectSkillHost, classifyHostError } from '../lib/windows-diagnostic-host.mjs';

export async function main(args = process.argv.slice(2), effects = {}) {
  const output = effects.output ?? console.log;
  if (!args.length) {
    output(
      'Owner only, between executor sessions: node supervisor/bin/prepare-project-skill-host.mjs --prepare',
    );
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--prepare') {
    output('Expected no arguments (help) or exactly --prepare');
    return 2;
  }
  try {
    const workspace = resolve(process.cwd());
    const home = dirname(dirname(fileURLToPath(import.meta.url)));
    const config = (
      effects.readConfig ??
      (() => JSON.parse(readFileSync(join(home, 'pipeline.config.json'), 'utf8')))
    )();
    const result = await (effects.prepare ?? prepareProjectSkillHost)({ workspace, home, config });
    output(JSON.stringify(result, null, 2));
    return result.status === 'ready' ? 0 : 1;
  } catch (error) {
    output(JSON.stringify({ status: 'failed', reason: classifyHostError(error) }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
