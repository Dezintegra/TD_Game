// Адресное поручение из 0368: это удержание исходного результата, не допуск его отчёта.
export const INCIDENT_REPORT_RECOVERIES = Object.freeze([
  Object.freeze({
    taskId: '0199-nazvat-v-skillah-telo-kommita-faylom-git',
    stage: 'design',
    launchId: '34ba94e3-40a8-409b-a8ad-c1193e043888',
    incidentId: '466e17d3d44d84cddf5c828b',
    repairTaskId: '0368-soglasovat-format-svidetelstv-incidentve',
    change: 'pass-commit-messages-by-file',
    commits: [
      'ac8a349ea764e6687fe982da2544a2c49f398f8b',
      '048143908a2ccf31fe63bb59722a9a8a93a2d6e1',
    ],
  }),
]);

export const incidentRecoveryKey = (item) => `incident-report-recovery-v1:${item.launchId}`;
export const incidentRecoveryOperationKey = (item) =>
  `${incidentRecoveryKey(item)}:saveTask:0:${item.taskId}`;
