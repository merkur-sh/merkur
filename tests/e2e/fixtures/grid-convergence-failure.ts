/** Scalar-only diagnostic; never serialize terminal contents or an arbitrary rejected value. */
export function gridConvergenceFailureDetail(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'result=unavailable';
  const result = value as Record<string, unknown>;
  const fields: string[] = [];
  if (result.probeError === 'request-rejected' || result.probeError === 'hook-unavailable')
    fields.push(`probeError=${result.probeError}`);
  if (typeof result.converged === 'boolean') fields.push(`converged=${result.converged}`);
  if (
    result.failureReason === null ||
    result.failureReason === 'not-ready' ||
    result.failureReason === 'superseded' ||
    result.failureReason === 'timeout' ||
    result.failureReason === 'mismatch'
  )
    fields.push(`failureReason=${result.failureReason}`);
  for (const key of [
    'observationEpoch',
    'probeId',
    'attempts',
    'selectiveRepairCount',
    'generation',
    'lastAdmittedDisplaySeq',
    'rows',
    'elapsedMs',
  ]) {
    const field = result[key];
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0)
      fields.push(`${key}=${field}`);
  }
  return fields.length === 0 ? 'result=malformed' : fields.join(' ');
}
