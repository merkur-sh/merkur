import { FASTEST_SUPPORTED_REFRESH_PERIOD_MS } from './refresh-rate-estimator';

/** Numeric peer-port edge; zero remains the task-mode ring wake. */
export const PRESENTATION_PERIOD_CHANGED_EDGE = 1;
export const MIN_PRESENTATION_PERIOD_US = Math.round(FASTEST_SUPPORTED_REFRESH_PERIOD_MS * 1_000);
export const MAX_PRESENTATION_PERIOD_US = 0xffff;

/** The renderer's measured cadence is a host fact independent of display lineage. */
export function createPresentationCadenceBuffer(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.store(new Int32Array(buffer), 0, MIN_PRESENTATION_PERIOD_US);
  return buffer;
}

export function quantizePresentationPeriodUs(periodMs: number): number {
  if (periodMs === Number.POSITIVE_INFINITY) return MAX_PRESENTATION_PERIOD_US;
  if (!Number.isFinite(periodMs)) return MIN_PRESENTATION_PERIOD_US;
  return Math.min(
    MAX_PRESENTATION_PERIOD_US,
    Math.max(MIN_PRESENTATION_PERIOD_US, Math.round(periodMs * 1_000)),
  );
}

export interface PresentationCadenceWriter {
  setPresentationPeriodUs(periodUs: number): boolean;
}
export interface PresentationCadenceReader {
  presentationPeriodUs(): number;
}

export function createPresentationCadenceWriter(
  buffer: SharedArrayBuffer,
): PresentationCadenceWriter {
  const words = new Int32Array(buffer);
  let current = Atomics.load(words, 0) >>> 0;
  return {
    setPresentationPeriodUs(periodUs: number): boolean {
      const next = Math.min(
        MAX_PRESENTATION_PERIOD_US,
        Math.max(
          MIN_PRESENTATION_PERIOD_US,
          Number.isFinite(periodUs) ? Math.round(periodUs) : MIN_PRESENTATION_PERIOD_US,
        ),
      );
      if (next === current) return false;
      current = next;
      Atomics.store(words, 0, next);
      return true;
    },
  };
}

export function createPresentationCadenceReader(
  buffer: SharedArrayBuffer,
): PresentationCadenceReader {
  const words = new Int32Array(buffer);
  return {
    presentationPeriodUs(): number {
      const value = Atomics.load(words, 0) >>> 0;
      return value >= MIN_PRESENTATION_PERIOD_US && value <= MAX_PRESENTATION_PERIOD_US
        ? value
        : MIN_PRESENTATION_PERIOD_US;
    },
  };
}
