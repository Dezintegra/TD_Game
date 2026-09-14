/** A retained result is not an admitted report, including when report is null. */
export function retainedReportView(entry) {
  if (entry.disposition === 'ordinary')
    return {
      ...entry.report,
      reportId: entry.reportId,
      launchId: entry.launchId,
      startedAt: entry.startedAt,
      machine: entry.machine,
      rejection: entry.rejection ?? null,
      disposition: 'ordinary',
    };
  return {
    taskId: entry.taskId,
    stage: entry.stage,
    batch: entry.batch,
    reportId: entry.reportId,
    launchId: entry.launchId,
    disposition: entry.disposition,
  };
}

export function isToolHeld(report) {
  return Boolean(report?.disposition && report.disposition !== 'ordinary');
}

/** API failures and trust failures retain their existing admission owners. */
export function needsToolDiagnosis(answer, parsed, stage) {
  return (
    !['api-error', 'token-limit'].includes(answer.outcome) &&
    !(answer.denials ?? []).some((denial) =>
      /(?:AskUserQuestion|request_user_input)/i.test(denial.tool_name ?? ''),
    ) &&
    (!parsed.report || parsed.report.stage === stage) &&
    (!parsed.report || parsed.report.outcome === 'failed' || answer.outcome !== 'done')
  );
}

/** Only this coordinator changes a diagnostic disposition; it never writes a task. */
export function createToolReportHold({ store, diagnose, pause, archive, log = () => {} }) {
  const running = new Set();
  let storageError = null;
  return {
    get blocked() {
      return storageError !== null;
    },
    restore() {
      for (const entry of store.entries()) {
        if (entry.disposition === 'infrastructure-held') {
          try {
            pause(entry);
          } catch (error) {
            storageError = error;
          }
        }
        if (entry.disposition !== 'diagnosing' || running.size) continue;
        running.add(entry.reportId);
        // Keeping the envelope before starting the probe also protects a crash here.
        Promise.resolve()
          .then(async () => {
            let evidence;
            try {
              evidence = await diagnose(entry);
            } catch (error) {
              evidence = { verdict: 'inconclusive', checks: [], reason: error.message };
            }
            if (!['confirmed', 'healthy', 'inconclusive'].includes(evidence?.verdict))
              evidence = { verdict: 'inconclusive', checks: [], reason: 'invalid-control-result' };
            store.update(entry.reportId, { evidence });
            if (evidence.verdict === 'confirmed') {
              store.update(entry.reportId, { disposition: 'infrastructure-held' });
              pause(store.get(entry.reportId));
            } else if (entry.originalResult.accepted) {
              store.update(entry.reportId, { disposition: 'ordinary' });
            } else {
              // Invalid JSON remains inadmissible. Archive succeeds before releasing hold.
              await archive(store.get(entry.reportId));
              store.acknowledge(entry.reportId);
            }
            storageError = null;
          })
          .catch((error) => {
            storageError = error;
            log(`tool diagnosis retention: ${error.message}`);
          })
          .finally(() => running.delete(entry.reportId));
      }
    },
  };
}
