export type DirectRedrawCoverageKind = 'small-multirow' | 'bounded-cat' | 'tmux' | 'neovim';

export type DirectRedrawTriggerWorkload = Extract<
  DirectRedrawCoverageKind,
  'small-multirow' | 'bounded-cat'
>;

export const DIRECT_REDRAW_TRIGGER_SAMPLE_MINIMUM = 100;
export const DIRECT_REDRAW_TRIGGER_SAMPLE_MAXIMUM = 500;

/**
 * Build one shell-resident redraw driver before a recorder observation begins.
 *
 * `ready-000` is emitted only after the complete driver is installed. Every
 * subsequent marker is causally gated by exactly one line read, so an Enter is
 * the only terminal input in each judged window. The sample ordinal is part of
 * every row, preventing an identical-write optimization from turning the dense
 * workload into a changing-marker-only redraw.
 */
export function buildDirectRedrawLoopCommand(
  workload: DirectRedrawTriggerWorkload,
  readyPrefix: string,
  finalMarker: string,
  sampleCount: number,
): string {
  if (
    (workload !== 'small-multirow' && workload !== 'bounded-cat') ||
    !/^[a-z0-9-]+$/u.test(readyPrefix) ||
    !/^[a-z0-9-]+$/u.test(finalMarker) ||
    readyPrefix === finalMarker ||
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < DIRECT_REDRAW_TRIGGER_SAMPLE_MINIMUM ||
    sampleCount > DIRECT_REDRAW_TRIGGER_SAMPLE_MAXIMUM
  ) {
    throw new Error('invalid Direct redraw-trigger loop contract');
  }
  const render =
    workload === 'small-multirow'
      ? 'printf \'\\033[2J\\033[Hdirect-small-%03d-alpha\\ndirect-small-%03d-bravo\\n\' "$_merkur_sample" "$_merkur_sample"'
      : `printf '\\033[2J\\033[H'; _merkur_row=0; while [ "$_merkur_row" -lt 240 ]; do printf 'direct-cat-%03d-%03d-${'payload-'.repeat(12)}\\n' "$_merkur_sample" "$_merkur_row"; _merkur_row=$((_merkur_row+1)); done`;
  return (
    `_merkur_sample=0; printf '\\033[2K\\r%s-%03d\\n' '${readyPrefix}' "$_merkur_sample"; ` +
    `while [ "$_merkur_sample" -lt ${sampleCount} ]; do IFS= read -r _merkur_go; ${render}; ` +
    `_merkur_sample=$((_merkur_sample+1)); if [ "$_merkur_sample" -lt ${sampleCount} ]; then ` +
    `printf '\\033[2K\\r%s-%03d\\n' '${readyPrefix}' "$_merkur_sample"; else ` +
    `printf '\\033[2K\\r%s\\n' '${finalMarker}'; fi; done\n`
  );
}

export function directRedrawReadyMarker(readyPrefix: string, sample: number): string {
  if (
    !/^[a-z0-9-]+$/u.test(readyPrefix) ||
    !Number.isSafeInteger(sample) ||
    sample < 0 ||
    sample >= DIRECT_REDRAW_TRIGGER_SAMPLE_MAXIMUM
  ) {
    throw new Error('invalid Direct redraw-trigger ready marker');
  }
  return `${readyPrefix}-${String(sample).padStart(3, '0')}`;
}

export interface DirectRedrawCoverage {
  readonly kind: DirectRedrawCoverageKind;
  readonly windowCount: number;
  readonly minimumRowsPerWindow: number;
  readonly observedMinimumRows: number;
  readonly appliedDisplayUnitCount: number;
  readonly payloadByteCount: number;
  readonly singletonFullUpdateWindowCount: number;
  readonly multiUnitWindowCount: number;
  readonly crossUnitCoverage:
    | 'observed-in-this-population'
    | 'suite-carrier-repair-multi-unit-sentinel';
}

/**
 * Prove that every nominal redraw window carried its predeclared authoritative
 * row density. `datagramsPerMeasurementWindow` is deliberately described as
 * applied display units here: the retained commit field has no carrier/jumbo
 * discriminator. A single independently applied unit is valid only when that
 * same exact window proves the complete row density and a non-empty payload.
 */
export function summarizeDirectRedrawCoverage(
  kind: DirectRedrawCoverageKind,
  rowsPerWindow: readonly number[],
  appliedDisplayUnitsPerWindow: readonly number[],
  bytesPerWindow: readonly number[],
  expectedWindowCount: number,
): DirectRedrawCoverage {
  if (!Number.isSafeInteger(expectedWindowCount) || expectedWindowCount <= 0) {
    throw new Error('Direct redraw coverage requires a positive exact window count');
  }
  if (
    rowsPerWindow.length !== expectedWindowCount ||
    appliedDisplayUnitsPerWindow.length !== expectedWindowCount ||
    bytesPerWindow.length !== expectedWindowCount
  ) {
    throw new Error('Direct redraw row/unit/byte populations do not match the window count');
  }
  const minimumRowsPerWindow = kind === 'small-multirow' ? 2 : 23;
  let observedMinimumRows = Number.POSITIVE_INFINITY;
  let appliedDisplayUnitCount = 0;
  let payloadByteCount = 0;
  let singletonFullUpdateWindowCount = 0;
  let multiUnitWindowCount = 0;
  for (let index = 0; index < expectedWindowCount; index += 1) {
    const rows = rowsPerWindow[index];
    const appliedDisplayUnits = appliedDisplayUnitsPerWindow[index];
    const bytes = bytesPerWindow[index];
    if (rows === undefined || appliedDisplayUnits === undefined || bytes === undefined) {
      throw new Error(`Direct ${kind} window ${index} is missing exact coverage evidence`);
    }
    if (!Number.isSafeInteger(rows) || rows < minimumRowsPerWindow) {
      throw new Error(
        `Direct ${kind} window ${index} applied ${rows} rows; at least ${minimumRowsPerWindow} are required`,
      );
    }
    if (!Number.isSafeInteger(appliedDisplayUnits) || appliedDisplayUnits <= 0) {
      throw new Error(`Direct ${kind} window ${index} has no applied display unit`);
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`Direct ${kind} window ${index} has no applied display payload bytes`);
    }
    observedMinimumRows = Math.min(observedMinimumRows, rows);
    appliedDisplayUnitCount += appliedDisplayUnits;
    payloadByteCount += bytes;
    if (appliedDisplayUnits === 1) singletonFullUpdateWindowCount += 1;
    else multiUnitWindowCount += 1;
  }
  return {
    kind,
    windowCount: expectedWindowCount,
    minimumRowsPerWindow,
    observedMinimumRows,
    appliedDisplayUnitCount,
    payloadByteCount,
    singletonFullUpdateWindowCount,
    multiUnitWindowCount,
    crossUnitCoverage:
      multiUnitWindowCount > 0
        ? 'observed-in-this-population'
        : 'suite-carrier-repair-multi-unit-sentinel',
  };
}
