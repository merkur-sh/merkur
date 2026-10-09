import type { DisplayReceiverProfileBucket, DisplayReceiverProfileMessage } from '@merkur/protocol';

export const DISPLAY_RECEIVER_SIZE_CLASSES = 6;
export const DISPLAY_RECEIVER_DICTIONARY_CLASSES = 2;
export const DISPLAY_RECEIVER_RATIO_CLASSES = 4;
export const DISPLAY_RECEIVER_PROFILE_BUCKETS =
  DISPLAY_RECEIVER_SIZE_CLASSES *
  DISPLAY_RECEIVER_RATIO_CLASSES *
  DISPLAY_RECEIVER_DICTIONARY_CLASSES;

const HEADER_WORDS = 4;
const BUCKET_WORDS = 5;
const VERSION_WORD = 0;
const REVISION_WORD = 1;
const PUBLISHED_AT_WORD = 2;
const SERVICE_DEBT_WORD = 3;
const WINDOW_SAMPLES = 32;
const MAX_U32 = 0xffff_ffff;

export const DISPLAY_RECEIVER_PROFILE_WORDS =
  HEADER_WORDS + DISPLAY_RECEIVER_PROFILE_BUCKETS * BUCKET_WORDS;
export const DISPLAY_RECEIVER_PROFILE_BYTES =
  DISPLAY_RECEIVER_PROFILE_WORDS * Int32Array.BYTES_PER_ELEMENT;

export function createDisplayReceiverProfileBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(DISPLAY_RECEIVER_PROFILE_BYTES);
}

export function displayReceiverSizeClass(rawBytes: number): number {
  if (rawBytes <= 512) return 0;
  if (rawBytes <= 1_024) return 1;
  if (rawBytes <= 2_048) return 2;
  if (rawBytes <= 4_096) return 3;
  if (rawBytes <= 8_192) return 4;
  return 5;
}

export function displayReceiverRatioClass(rawBytes: number, wireBytes: number): number {
  const ratio = wireBytes / Math.max(1, rawBytes);
  if (ratio <= 0.125) return 0;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  return 3;
}

function saturatingU32(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_U32, Math.round(value)) >>> 0;
}

function ageU32(nowMs: number, thenSeconds: number): number {
  const nowSeconds = Math.trunc(nowMs / 1_000) >>> 0;
  const elapsedSeconds = (nowSeconds - (thenSeconds >>> 0)) >>> 0;
  return Math.min(MAX_U32, elapsedSeconds * 1_000) >>> 0;
}

/**
 * Fixed-memory empirical posterior over the receiver representation penalty.
 *
 * Each bucket retains the newest 32 observations exactly. Publishing derives
 * mean, sample variance, and a conservative normal-predictive p95 from that
 * bounded window. This deliberately is not an EWMA: the planner receives
 * uncertainty and an upper quantile, while the sliding window still follows
 * thermal/contention changes instead of letting an ancient session dominate.
 */
export interface DisplayReceiverProfileWriter {
  recordRaw(rawBytes: number, validationApplyUs: number): void;
  recordCompressed(
    rawBytes: number,
    wireBytes: number,
    dictionary: boolean,
    fusedValidationApplyUs: number,
  ): void;
  publish(serviceDebtUs: number, nowMs?: number): void;
}

export function createDisplayReceiverProfileWriter(
  sab: SharedArrayBuffer,
): DisplayReceiverProfileWriter {
  if (sab.byteLength !== DISPLAY_RECEIVER_PROFILE_BYTES) {
    throw new Error('display receiver profile buffer has invalid size');
  }
  const words = new Int32Array(sab);
  const rawValues = new Float64Array(DISPLAY_RECEIVER_SIZE_CLASSES * WINDOW_SAMPLES);
  const rawCounts = new Uint8Array(DISPLAY_RECEIVER_SIZE_CLASSES);
  const rawCursors = new Uint8Array(DISPLAY_RECEIVER_SIZE_CLASSES);
  // Raw costs are non-negative, so -1 marks a mean invalidated by a new sample.
  const rawMeans = new Float64Array(DISPLAY_RECEIVER_SIZE_CLASSES);
  const penaltyValues = new Float64Array(DISPLAY_RECEIVER_PROFILE_BUCKETS * WINDOW_SAMPLES);
  const ratioValues = new Float64Array(DISPLAY_RECEIVER_PROFILE_BUCKETS * WINDOW_SAMPLES);
  const counts = new Uint8Array(DISPLAY_RECEIVER_PROFILE_BUCKETS);
  const cursors = new Uint8Array(DISPLAY_RECEIVER_PROFILE_BUCKETS);
  // The first publication also clears any preceding writer's bucket state.
  const dirty = new Uint8Array(DISPLAY_RECEIVER_PROFILE_BUCKETS).fill(1);

  function insert(
    values: Float64Array,
    bucket: number,
    countsView: Uint8Array,
    cursorsView: Uint8Array,
    value: number,
  ): void {
    const cursor = cursorsView[bucket] ?? 0;
    values[bucket * WINDOW_SAMPLES + cursor] = Math.max(0, value);
    cursorsView[bucket] = (cursor + 1) % WINDOW_SAMPLES;
    countsView[bucket] = Math.min(WINDOW_SAMPLES, (countsView[bucket] ?? 0) + 1);
  }

  function rawMean(sizeClass: number): number {
    const cached = rawMeans[sizeClass] ?? 0;
    if (cached !== -1) return cached;
    const count = rawCounts[sizeClass] ?? 0;
    if (count === 0) return 0;
    let sum = 0;
    const start = sizeClass * WINDOW_SAMPLES;
    for (let index = 0; index < count; index += 1) sum += rawValues[start + index] ?? 0;
    const mean = sum / count;
    rawMeans[sizeClass] = mean;
    return mean;
  }

  return {
    recordRaw(rawBytes, validationApplyUs): void {
      const sizeClass = displayReceiverSizeClass(rawBytes);
      insert(rawValues, sizeClass, rawCounts, rawCursors, validationApplyUs);
      rawMeans[sizeClass] = -1;
    },

    recordCompressed(rawBytes, wireBytes, dictionary, fusedValidationApplyUs): void {
      const sizeClass = displayReceiverSizeClass(rawBytes);
      const ratioClass = displayReceiverRatioClass(rawBytes, wireBytes);
      const bucket =
        ((dictionary ? 1 : 0) * DISPLAY_RECEIVER_SIZE_CLASSES + sizeClass) *
          DISPLAY_RECEIVER_RATIO_CLASSES +
        ratioClass;
      // Until a same-size raw sample exists, the full compressed service cost
      // is the safe upper bound. As raw evidence arrives, subtract only its
      // empirical mean; negative representation cost is clamped to zero.
      const incrementalUs = Math.max(0, fusedValidationApplyUs - rawMean(sizeClass));
      const cursor = cursors[bucket] ?? 0;
      const at = bucket * WINDOW_SAMPLES + cursor;
      penaltyValues[at] = incrementalUs;
      ratioValues[at] = wireBytes / Math.max(1, rawBytes);
      cursors[bucket] = (cursor + 1) % WINDOW_SAMPLES;
      counts[bucket] = Math.min(WINDOW_SAMPLES, (counts[bucket] ?? 0) + 1);
      dirty[bucket] = 1;
    },

    publish(serviceDebtUs, nowMs = Date.now()): void {
      const priorRevision = Atomics.load(words, REVISION_WORD) >>> 0;
      const revision = priorRevision >= MAX_U32 ? 1 : priorRevision + 1;
      const version = Atomics.load(words, VERSION_WORD);
      Atomics.store(words, VERSION_WORD, (version + 1) | 1);
      Atomics.store(words, REVISION_WORD, revision | 0);
      // Epoch seconds retain a 136-year unsigned range. Milliseconds would
      // alias a cache older than 49.7 days back into a fresh-looking profile,
      // while the wire age itself saturates safely to u32 milliseconds.
      Atomics.store(words, PUBLISHED_AT_WORD, (Math.trunc(nowMs / 1_000) >>> 0) | 0);
      Atomics.store(words, SERVICE_DEBT_WORD, saturatingU32(serviceDebtUs) | 0);
      for (let bucket = 0; bucket < DISPLAY_RECEIVER_PROFILE_BUCKETS; bucket += 1) {
        if (dirty[bucket] === 0) continue;
        const count = counts[bucket] ?? 0;
        let mean = 0;
        let ratio = 0;
        let m2 = 0;
        const start = bucket * WINDOW_SAMPLES;
        for (let index = 0; index < count; index += 1) {
          const value = penaltyValues[start + index] ?? 0;
          const delta = value - mean;
          mean += delta / (index + 1);
          m2 += delta * (value - mean);
          ratio += ratioValues[start + index] ?? 0;
        }
        const variance = count > 1 ? m2 / (count - 1) : 0;
        const predictiveDeviation = Math.sqrt(Math.max(0, variance) * (1 + 1 / Math.max(1, count)));
        const at = HEADER_WORDS + bucket * BUCKET_WORDS;
        Atomics.store(words, at, count);
        Atomics.store(words, at + 1, saturatingU32((ratio / Math.max(1, count)) * 1_000_000) | 0);
        Atomics.store(words, at + 2, saturatingU32(mean) | 0);
        Atomics.store(words, at + 3, saturatingU32(variance) | 0);
        Atomics.store(words, at + 4, saturatingU32(mean + 1.645 * predictiveDeviation) | 0);
        dirty[bucket] = 0;
      }
      Atomics.store(words, VERSION_WORD, (version + 2) & ~1);
    },
  };
}

export interface DisplayReceiverProfileReader {
  readIfChanged(): DisplayReceiverProfileMessage | null;
}

export function createDisplayReceiverProfileReader(
  sab: SharedArrayBuffer,
): DisplayReceiverProfileReader {
  if (sab.byteLength !== DISPLAY_RECEIVER_PROFILE_BYTES) {
    throw new Error('display receiver profile buffer has invalid size');
  }
  const words = new Int32Array(sab);
  let lastRevision = 0;
  return {
    readIfChanged(): DisplayReceiverProfileMessage | null {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = Atomics.load(words, VERSION_WORD);
        if ((before & 1) !== 0) continue;
        const sampleRevision = Atomics.load(words, REVISION_WORD) >>> 0;
        if (sampleRevision === 0 || sampleRevision === lastRevision) return null;
        const publishedAt = Atomics.load(words, PUBLISHED_AT_WORD) >>> 0;
        const serviceDebtUs = Atomics.load(words, SERVICE_DEBT_WORD) >>> 0;
        const buckets: DisplayReceiverProfileBucket[] = [];
        for (let bucket = 0; bucket < DISPLAY_RECEIVER_PROFILE_BUCKETS; bucket += 1) {
          const at = HEADER_WORDS + bucket * BUCKET_WORDS;
          const sampleCount = Atomics.load(words, at) >>> 0;
          if (sampleCount === 0) continue;
          buckets.push({
            dictionaryClass: Math.floor(
              bucket / (DISPLAY_RECEIVER_SIZE_CLASSES * DISPLAY_RECEIVER_RATIO_CLASSES),
            ),
            sizeClass:
              Math.floor(bucket / DISPLAY_RECEIVER_RATIO_CLASSES) % DISPLAY_RECEIVER_SIZE_CLASSES,
            ratioClass: bucket % DISPLAY_RECEIVER_RATIO_CLASSES,
            sampleCount,
            wireRatioPpm: Atomics.load(words, at + 1) >>> 0,
            meanUs: Atomics.load(words, at + 2) >>> 0,
            varianceUs2: Atomics.load(words, at + 3) >>> 0,
            upperUs: Atomics.load(words, at + 4) >>> 0,
          });
        }
        if (Atomics.load(words, VERSION_WORD) !== before) continue;
        lastRevision = sampleRevision;
        return {
          kind: 'display_receiver_profile',
          sampleRevision,
          ageMs: ageU32(Date.now(), publishedAt),
          serviceDebtUs,
          buckets,
        };
      }
      return null;
    },
  };
}
