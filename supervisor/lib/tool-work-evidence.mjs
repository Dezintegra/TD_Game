/** Снимок счётчика не является квитанцией конкретного списания. */
export function launchCharge(launchId, continuation = false) {
  return {
    launchId,
    state: continuation ? 'pending' : 'not-required',
    key: `continuation:${launchId}`,
  };
}

export function confirmLaunchCharge(charge, receipt) {
  if (charge.state !== 'pending') return charge;
  if (
    receipt?.launchId !== charge.launchId ||
    receipt?.key !== charge.key ||
    receipt?.confirmed !== true
  )
    return charge;
  return { ...charge, state: 'confirmed' };
}

/** Неуспешное чтение никогда не превращается в пустой хвост. */
export function gitWorkEvidence(readings, previous = null) {
  const names = ['head', 'branch', 'upstream', 'tail', 'dirty'];
  if (
    names.some(
      (name) =>
        !readings?.[name] || readings[name].code !== 0 || typeof readings[name].stdout !== 'string',
    )
  ) {
    return { state: 'unknown', reason: 'incomplete-git-inspection', previous };
  }
  const head = readings.head.stdout.trim();
  const branch = readings.branch.stdout.trim();
  const upstream = readings.upstream.stdout.trim();
  const tail = readings.tail.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (
    !/^[a-f0-9]{40,64}$/.test(head) ||
    !branch ||
    branch === 'HEAD' ||
    !upstream ||
    tail.some((sha) => !/^[a-f0-9]{40,64}$/.test(sha))
  )
    return { state: 'unknown', reason: 'invalid-git-inspection', previous };
  return {
    state: 'known',
    head,
    branch,
    upstream,
    tail,
    dirty: readings.dirty.stdout.split(/\r?\n/).filter(Boolean),
  };
}
