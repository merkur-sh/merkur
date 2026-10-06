export function nativeExitCode(
  result: { exitCode: number; signalCode?: string | null },
  owner: string,
): number {
  if (result.signalCode !== undefined && result.signalCode !== null)
    throw new Error(`${owner} terminated by ${result.signalCode}`);
  if (!Number.isInteger(result.exitCode) || result.exitCode < 0)
    throw new Error(`${owner} did not return an exit status`);
  return result.exitCode;
}
