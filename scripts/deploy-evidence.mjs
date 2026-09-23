/** Written only after compose and proxy restart; a new source directory has no old marker. */
export function deploymentMarkerCommand(revision) {
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('invalid deployment revision');
  return `printf '%s\\n' '${revision}' "$(docker compose ps -q --status running server)" "$(docker compose ps -q --status running web)" > .deployment-evidence.tmp\nmv .deployment-evidence.tmp .deployment-evidence`;
}

/** Fixed read-only probe; no repair, startup or publication is permitted here. */
export const deploymentReadCommand = [
  'set -e',
  'cd ~/td',
  "printf 'TD_DEPLOY_EVIDENCE_V1\\n'",
  'cat .deployment-evidence',
  'docker compose ps -q --status running server',
  'docker compose ps -q --status running web',
  '. ./.env',
  'curl -fsS --max-time 15 "https://$TD_DOMAIN/health"',
  "printf '\\nTD_DEPLOY_EVIDENCE_END\\n'",
].join('\n');

export function deploymentEvidence(run, revision) {
  const unknown = {
    state: 'unknown',
    reason: 'remote revision or running containers are unconfirmed',
  };
  if (run?.code !== 0 || run.error) return unknown;
  const lines = String(run.stdout ?? '')
    .trim()
    .split(/\r?\n/);
  if (
    lines.length !== 8 ||
    lines[0] !== 'TD_DEPLOY_EVIDENCE_V1' ||
    lines[7] !== 'TD_DEPLOY_EVIDENCE_END' ||
    lines[1] !== revision ||
    !/^[a-f0-9]{40,64}$/.test(revision) ||
    !lines.slice(2, 6).every((id) => /^[a-f0-9]{12,64}$/.test(id)) ||
    lines[2] !== lines[4] ||
    lines[3] !== lines[5]
  )
    return unknown;
  try {
    if (JSON.parse(lines[6]).status !== 'ok') return unknown;
  } catch {
    return unknown;
  }
  return {
    state: 'known',
    revision,
    published: true,
    containers: { server: lines[2], web: lines[3] },
    health: lines[6],
  };
}
