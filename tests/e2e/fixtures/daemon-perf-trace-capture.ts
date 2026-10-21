import { readFileSync } from 'node:fs';
import { Predicate } from 'effect';
import {
  decodeNativeTrace,
  type NativeTraceCapture,
  NativeTraceDecodeError,
} from '../../../packages/profile/src/mtrace';

export interface DaemonPerfTraceCapture {
  readonly status: 'pending' | 'complete' | 'invalid' | 'failed';
  readonly terminalMarkerSeen: boolean;
  readonly daemonId: string;
  readonly requestedAfterMs: number;
  readonly commandId: string | null;
  readonly captureRequestedAtMs: number | null;
  readonly captureCompletedAtMs: number | null;
  /** The file the dataplane wrote, as the daemon logged it. */
  readonly path: string | null;
  /** The decoded capture, once complete. */
  readonly trace: NativeTraceCapture | null;
  readonly errors: readonly string[];
  readonly rawLog: string;
}

/** Cold post-phase capture. Never infer record identity from timestamp proximity. */
export function collectDaemonPerfTraceCapture(
  rawLog: string,
  daemonId: string,
  requestedAfterMs: number,
  readCapture: (path: string) => Uint8Array = readFileSync,
): DaemonPerfTraceCapture {
  const errors: string[] = [];
  let status: DaemonPerfTraceCapture['status'] = 'pending';
  let terminalMarkerSeen = false;
  let commandId: string | null = null;
  let captureRequestedAtMs: number | null = null;
  let captureCompletedAtMs: number | null = null;
  let capturePath: string | null = null;
  let trace: NativeTraceCapture | null = null;
  for (const line of rawLog.split(/\r?\n/u)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || !Predicate.isString(value.message)) continue;
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
      value.message !== 'daemon_perf_trace_capture_complete' &&
      value.message !== 'daemon_perf_trace_capture_failed'
    ) {
      continue;
    }
    const id = context.commandId;
    if (!Predicate.isString(id) || id.length === 0) {
      errors.push('native capture omitted its exact command identity');
      continue;
    }
    if (terminalMarkerSeen) {
      errors.push('multiple native capture identities in one requested boundary');
      continue;
    }
    terminalMarkerSeen = true;
    commandId = id;
    captureRequestedAtMs = context.captureRequestedAtMs;
    if (value.message === 'daemon_perf_trace_capture_failed') {
      errors.push(`native capture failed: ${String(context.reason)}`);
      status = 'failed';
      continue;
    }
    status = 'complete';
    if (
      !safeTime(context.captureCompletedAtMs) ||
      context.captureCompletedAtMs < context.captureRequestedAtMs ||
      !Predicate.isString(context.path) ||
      context.path.length === 0
    ) {
      errors.push('native capture completion does not name its file and completion time');
      continue;
    }
    captureCompletedAtMs = context.captureCompletedAtMs;
    capturePath = context.path;
    try {
      trace = decodeNativeTrace(readCapture(context.path));
    } catch (error) {
      errors.push(
        error instanceof NativeTraceDecodeError
          ? `malformed native capture: ${error.message}`
          : `native capture file unreadable: ${String(error)}`,
      );
    }
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
    path: capturePath,
    trace: status === 'complete' ? trace : null,
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
