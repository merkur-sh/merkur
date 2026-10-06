const RELEASE_VERSION_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type ReleaseVersion = readonly [major: number, minor: number, patch: number];

/** Returns true only when both values are exact releases and current is older than target. */
export function isReleaseVersionBehind(
  currentVersion: string | null,
  targetVersion: string | null,
): boolean {
  if (currentVersion === null || targetVersion === null) return false;

  const current = parseReleaseVersion(currentVersion);
  const target = parseReleaseVersion(targetVersion);
  if (current === null || target === null) return false;

  for (let index = 0; index < current.length; index += 1) {
    const currentPart = current[index];
    const targetPart = target[index];
    if (currentPart === undefined || targetPart === undefined) return false;
    if (currentPart < targetPart) return true;
    if (currentPart > targetPart) return false;
  }

  return false;
}

function parseReleaseVersion(version: string): ReleaseVersion | null {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (match === null) return null;

  const parts: ReleaseVersion = [Number(match[1]), Number(match[2]), Number(match[3])];
  return parts.every(Number.isSafeInteger) ? parts : null;
}
