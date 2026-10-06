import {
  createNativePerfTraceValidator,
  isNativePerfTraceChunk,
  type NativePerfTraceChunk,
} from '../../../packages/shared/src/native-perf-trace';

export interface DaemonPerfTraceCapture {
  readonly status: 'pending' | 'complete' | 'invalid' | 'failed';
  readonly terminalMarkerSeen: boolean;
  readonly daemonId: string;
  readonly requestedAfterMs: number;
  readonly commandId: string | null;
  readonly captureRequestedAtMs: number | null;
  readonly captureCompletedAtMs: number | null;
  readonly chunks: readonly NativePerfTraceChunk[];
  readonly errors: readonly string[];
  readonly rawLog: string;
}

/** Cold post-phase capture. Never infer record identity from timestamp proximity. */
export function collectDaemonPerfTraceCapture(
  rawLog: string,
  daemonId: string,
  requestedAfterMs: number,
): DaemonPerfTraceCapture {
  const chunks: NativePerfTraceChunk[] = [];
  const errors: string[] = [];
  let status: DaemonPerfTraceCapture['status'] = 'pending';
  let terminalMarkerSeen = false;
  let commandId: string | null = null;
  let captureRequestedAtMs: number | null = null;
  let captureCompletedAtMs: number | null = null;
  let validator: ReturnType<typeof createNativePerfTraceValidator> | null = null;
  for (const line of rawLog.split(/\r?\n/u)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || typeof value.message !== 'string') continue;
    const context = value.context;
    if (
      !isRecord(context) ||
      context.daemonId !== daemonId ||
      !safeTime(context.captureRequestedAtMs) ||
      context.captureRequestedAtMs < requestedAfterMs
    ) {
      continue;
    }
    if (
      value.message !== 'daemon_perf_trace_chunk' &&
      value.message !== 'daemon_perf_trace_capture_complete' &&
      value.message !== 'daemon_perf_trace_capture_failed'
    ) {
      continue;
    }
    const chunk = context.chunk;
    const id =
      value.message === 'daemon_perf_trace_chunk' && isRecord(chunk)
        ? chunk.command_id
        : context.commandId;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push('native capture omitted its exact command identity');
      continue;
    }
    if (commandId === null) {
      commandId = id;
      captureRequestedAtMs = context.captureRequestedAtMs;
      validator = createNativePerfTraceValidator(id);
    }
    if (id !== commandId || context.captureRequestedAtMs !== captureRequestedAtMs) {
      errors.push('multiple native capture identities in one requested boundary');
      continue;
    }
    if (status !== 'pending') errors.push('native capture records arrived after completion');
    if (value.message === 'daemon_perf_trace_chunk') {
      if (!isNativePerfTraceChunk(chunk)) {
        errors.push('malformed native capture chunk');
      } else {
        chunks.push(chunk);
        if (validator === null || !validator.accept(chunk))
          errors.push('invalid native chunk sequence');
      }
      continue;
    }
    if (value.message === 'daemon_perf_trace_capture_failed') {
      terminalMarkerSeen = true;
      errors.push(`native capture failed: ${String(context.reason)}`);
      status = 'failed';
      continue;
    }
    terminalMarkerSeen = true;
    if (
      !safeTime(context.captureCompletedAtMs) ||
      context.captureCompletedAtMs < context.captureRequestedAtMs ||
      validator === null ||
      !validator.complete ||
      context.chunkCount !== validator.chunkCount ||
      context.recordCount !== validator.recordCount
    ) {
      errors.push('native capture completion does not cover its exact ordered chunks');
    } else {
      captureCompletedAtMs = context.captureCompletedAtMs;
    }
    status = 'complete';
  }
  if (errors.length > 0 && status !== 'failed') status = 'invalid';
  return {
    status,
    terminalMarkerSeen,
    daemonId,
    requestedAfterMs,
    commandId,
    captureRequestedAtMs,
    captureCompletedAtMs,
    chunks,
    errors,
    rawLog,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
