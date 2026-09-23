#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveConfig } from '../config/defaults.mjs';
import { codexInvocation } from '../lib/provider.mjs';
import {
  PROBE_COMMAND,
  PROBE_DIRECTORY,
  runProjectSkillWriteProbe,
  safeDiagnostic,
} from '../lib/project-skill-write-probe.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  console.log(
    `Ограниченная Windows-приёмка 0299. Запуск: ${PROBE_COMMAND}. Стенд: ${PROBE_DIRECTORY}. Две сессии по пять минут и один resume; существующий стенд повторно не используется. Требуется заранее разрешённый профиль хозяина опыта. Sandbox не отключается, реальная 0083 только читается.`,
  );
} else if (args.length !== 1 || args[0] !== '--run') {
  console.error(
    'Допустим только --run; произвольные root, target, command и profile не принимаются.',
  );
  process.exitCode = 1;
} else {
  const workspace = process.cwd();
  const home = dirname(dirname(fileURLToPath(import.meta.url)));
  if (resolve(home, '..') !== resolve(workspace))
    throw new Error('Запускайте стенд из корня собственной копии проекта.');
  const config = resolveConfig(
    JSON.parse(readFileSync(resolve(home, 'pipeline.config.json'), 'utf8')),
  ).config;
  const versionCommand = codexInvocation(config, ['--version']);
  let version = 'unknown';
  let versionDiagnostic = null;
  try {
    const output = execFileSync(versionCommand.program, versionCommand.args, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    version = /codex-cli [0-9.]+/.exec(output)?.[0] ?? 'unknown';
  } catch (error) {
    versionDiagnostic = safeDiagnostic(error.message);
  }
  const revision = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  }).trim();
  const evidence = await runProjectSkillWriteProbe({ workspace, home, config });
  Object.assign(evidence, {
    version,
    versionDiagnostic,
    revision,
    provenance: {
      profile: 'production codexExecutionArgs + trusted resolver',
      home,
      userConfig: 'ignored by --ignore-user-config',
      managed: 'unknown; runtime enforcement required',
    },
  });
  if (version === 'unknown') {
    evidence.accepted = false;
    evidence.reason += '; CLI version unconfirmed';
  }
  const output = resolve(workspace, '.matchlog/0299-skill-write-evidence.json');
  writeFileSync(output, JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = evidence.accepted ? 0 : 1;
}
