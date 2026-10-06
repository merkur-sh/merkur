export interface FinalDaemonTransportCapture {
  readonly captureRequestedAtMs: number;
  readonly captureCompletedAtMs: number;
  readonly observedAtMs: number;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 8_000;
const CAPTURE_POLL_MS = 10;

/**
 * Locate a final owner-loop transport sample emitted in response to a signal
 * sent at or after `requestedAfterMs`. Chunk boundaries are irrelevant because
 * the daemon fixture joins its bounded in-memory log before parsing lines.
 */
export function findFinalDaemonTransportCapture(
  logText: string,
  requestedAfterMs: number,
): FinalDaemonTransportCapture | null {
  const lines = logText.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.includes('daemon_transport_capture_complete')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.message !== 'daemon_transport_capture_complete') continue;
    const context = value.context;
    if (!isRecord(context) || !isRecord(context.metrics)) continue;
    const transport = context.metrics.latestDataplaneTransport;
    if (!isRecord(transport)) continue;
    const captureRequestedAtMs = context.captureRequestedAtMs;
    const captureCompletedAtMs = context.captureCompletedAtMs;
    const observedAtMs = transport.observedAtMs;
    if (
      !isNonNegativeSafeInteger(captureRequestedAtMs) ||
      !isNonNegativeSafeInteger(captureCompletedAtMs) ||
      !isNonNegativeSafeInteger(observedAtMs) ||
      captureRequestedAtMs < requestedAfterMs ||
      observedAtMs < captureRequestedAtMs ||
      captureCompletedAtMs < observedAtMs
    ) {
      continue;
    }
    return { captureRequestedAtMs, captureCompletedAtMs, observedAtMs };
  }
  return null;
}

export async function waitForFinalDaemonTransportCapture(
  logChunks: readonly string[],
  requestedAfterMs: number,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
): Promise<FinalDaemonTransportCapture> {
  const deadlineAtMs = Date.now() + timeoutMs;
  while (true) {
    const capture = findFinalDaemonTransportCapture(logChunks.join(''), requestedAfterMs);
    if (capture !== null) return capture;
    if (Date.now() >= deadlineAtMs) {
      throw new Error(`daemon did not emit a fresh final transport capture within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_POLL_MS));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}
