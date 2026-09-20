import { isDeepStrictEqual } from 'node:util';

export function deployRetryAssignment(entry) {
  const a = entry?.assignment;
  const batch = a?.batch?.map((task) => task.id);
  return Boolean(
    a &&
    a.taskId === entry.taskId &&
    a.stage === 'deploy' &&
    batch?.length &&
    batch.includes(entry.taskId) &&
    new Set(batch).size === batch.length &&
    isDeepStrictEqual(batch, entry.batch) &&
    a.deployment?.path === a.path &&
    a.deployment.revision === a.deploymentRevision &&
    /^[a-f0-9]{40,64}$/.test(a.deploymentRevision) &&
    typeof a.deployment.host === 'string' &&
    a.deployment.directory === 'td',
  );
}

export function deployRetryEvidence(entry) {
  return (
    deployRetryAssignment(entry) &&
    entry.retry?.remote?.state === 'known' &&
    entry.retry.remote.published === true &&
    entry.retry.remote.revision === entry.assignment.deploymentRevision
  );
}
