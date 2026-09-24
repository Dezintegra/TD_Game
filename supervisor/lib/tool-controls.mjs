import { randomUUID } from 'node:crypto';

export const TOOL_DIAGNOSTIC_TIMEOUT_MS = 120_000;

/** Общий каталог readiness и повторной диагностики не читает команды из отчёта. */
export function toolControls({
  stage,
  cwd,
  remote = 'origin',
  host = 'dezintegra',
  childScript,
  sshScript,
  id = randomUUID(),
  profile = 'default',
}) {
  const historical = {
    'historical-revise': ['revise'],
    'historical-revise-design': ['revise', 'design'],
    'historical-audit': ['audit'],
  };
  if (profile !== 'default') {
    if (!Object.hasOwn(historical, profile)) throw new Error('Invalid diagnostic profile');
    if (stage !== historical[profile][0]) throw new Error('Diagnostic profile stage mismatch');
    return [
      ...historical[profile].map((skill) => ({
        id: `read-${skill}`,
        argv: ['Get-Content', `supervisor/skills/${skill}.md`],
      })),
      {
        id: 'git-status',
        argv: ['git', '-C', cwd, '--no-optional-locks', 'status', '--porcelain'],
      },
    ].map((control) => ({ ...control, invocationId: `${id}:${control.id}` }));
  }
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(remote)) throw new Error('Invalid diagnostic remote');
  if (!/^[a-zA-Z0-9_[\]][a-zA-Z0-9_.@:[\]-]*$/.test(host))
    throw new Error('Invalid diagnostic host');
  const controls = [
    { id: 'shell', argv: ['Write-Output', 'td-tool-shell-ready'], marker: 'td-tool-shell-ready' },
    { id: 'child', argv: ['node', childScript], marker: 'td-codex-processes-ready' },
  ];
  if (['design', 'audit', 'implement', 'revise', 'review', 'cleanup', 'deploy'].includes(stage)) {
    controls.push(
      { id: 'git', argv: ['git', '-C', cwd, 'rev-parse', '--is-inside-work-tree'], marker: 'true' },
      {
        id: 'github',
        argv: ['gh', 'api', 'user', '--jq', '"td-tool-github-ready"'],
        marker: 'td-tool-github-ready',
      },
      { id: 'transport', argv: ['git', '-C', cwd, 'ls-remote', remote, 'HEAD'] },
      {
        id: 'push',
        capability: 'push',
        argv: [
          'git',
          '-C',
          cwd,
          'push',
          '--dry-run',
          remote,
          `HEAD:refs/heads/codex/readiness${id ? `-${id}` : ''}`,
        ],
      },
    );
  }
  if (stage === 'deploy')
    controls.push({
      id: 'ssh',
      argv: ['node', sshScript, '--host', host, '--', 'printf td-codex-ssh-ready'],
      marker: 'td-codex-ssh-ready',
    });
  return controls.map((control) => ({ ...control, invocationId: `${id}:${control.id}` }));
}

export function powerShellControl(control) {
  return control.argv
    .map((part) =>
      /^[a-zA-Z0-9_.:/=-]+$/.test(part) ? part : "'" + part.replaceAll("'", "''") + "'",
    )
    .join(' ');
}
