/** Pending obligations are checked-in evidence requirements, never pass receipts. */
export const QUALIFICATION_GROUPS = [
  'common',
  'source',
  'native',
  'integration',
  'transport',
  'assurance',
  'fuzz-campaign',
  'dependency-audit',
  'extended',
  'unsigned-release',
] as const;

export type QualificationGroup = (typeof QUALIFICATION_GROUPS)[number];

/** Until engine-backed acceptance is implemented, erased obligations fail closed. */
export function pendingQualifications(
  value: unknown,
  groups: readonly QualificationGroup[],
): readonly string[] {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...QUALIFICATION_GROUPS].sort().join(',') ||
    groups.some((group) => !QUALIFICATION_GROUPS.includes(group)) ||
    new Set(groups).size !== groups.length
  )
    throw new Error('Complete qualification obligation inventory and unique groups required');
  const inventory = value as Record<string, unknown>;
  for (const group of QUALIFICATION_GROUPS) {
    const obligations = inventory[group];
    if (
      !Array.isArray(obligations) ||
      obligations.length === 0 ||
      obligations.some(
        (obligation) =>
          typeof obligation !== 'string' || obligation === '' || obligation.trim() !== obligation,
      ) ||
      new Set(obligations).size !== obligations.length
    )
      throw new Error(`Qualification group lacks explicit unresolved obligations: ${group}`);
  }
  return [...new Set(['common', ...groups])]
    .flatMap((group) => {
      const obligations = inventory[group];
      if (!Array.isArray(obligations)) throw new Error('Invalid qualification group');
      return obligations.map((obligation) => `${group}: ${String(obligation)}`);
    })
    .sort();
}
