import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_CHUNK_INDEX_OFFSET,
  DISPLAY_COLOR_MODE_INDEXED,
  DISPLAY_COLUMNS_OFFSET,
  DISPLAY_COMPRESSED_LENGTH_OFFSET,
  DISPLAY_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET,
  DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
  DISPLAY_FRAME_ID_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_GRID_ROWS_OFFSET,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
  DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
  DISPLAY_MESSAGE_TYPE_OFFSET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_PRESENTATION_ID_OFFSET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_COUNT_OFFSET,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  DISPLAY_VERSION_OFFSET,
  MESSAGE_TYPE_DISPLAY_PATCH,
  writeU32BE,
} from '@merkur/shared';
import type { WasmTerminalHandle } from '../wasm-loader';
import type { DisplayReceiverProfileWriter } from './display-receiver-profile';

export const DISPLAY_RECEIVER_CALIBRATION_COLS = 120;
export const DISPLAY_RECEIVER_CALIBRATION_ROWS = 29;
const CALIBRATION_SAMPLES = 8;
const CALIBRATION_DICTIONARY_GENERATION = 1;
const CALIBRATION_DICTIONARY_ID = 1;
const CALIBRATION_DICTIONARY_HASH = 441_442_863;
const CALIBRATION_FRAME_ID = 1;
const CALIBRATION_PRESENTATION_ID = 1;
const CALIBRATION_BUSY_RETRY_MS = 4;

export type DisplayReceiverCalibrationTerminal = Pick<
  WasmTerminalHandle,
  | 'destroy'
  | 'applyDelta'
  | 'installDisplayDictionary'
  | 'clearDisplayDictionaries'
  | 'stageDisplayFrame'
  | 'validateStagedFrame'
  | 'applyStagedDelta'
  | 'releaseStagedFrame'
  | 'resetDisplayOrdering'
  | 'takeLastError'
>;

interface CalibrationFixture {
  readonly rows: number;
  readonly plainBlock: string;
  readonly dictionaryBlock: string;
}

interface CalibrationObservation {
  readonly rawBytes: number;
  readonly wireBytes: number;
  readonly dictionary: boolean;
  readonly rawUs: number;
  readonly fusedUs: number;
}

interface PreparedCalibrationFixture {
  readonly rows: number;
  readonly raw: Uint8Array;
  readonly plain: Uint8Array;
  readonly dictionary: Uint8Array;
}

export type DisplayReceiverCalibrationStep =
  | { readonly status: 'pending' }
  | { readonly status: 'complete' }
  | { readonly status: 'failed'; readonly error: string };

export interface DisplayReceiverCalibrationRun {
  /** Execute at most one expensive decode, validation, or apply operation. */
  step(): DisplayReceiverCalibrationStep;
  /** Idempotently clear calibration-only state and free the isolated terminal. */
  cancel(): void;
}

export interface DisplayReceiverCalibrationScheduler {
  start(epoch: number, generation: number): void;
  cancel(): void;
  isActive(): boolean;
}

export interface DisplayReceiverCalibrationSchedulerOptions<THandle> {
  createTerminal(): Promise<DisplayReceiverCalibrationTerminal>;
  createRun(terminal: DisplayReceiverCalibrationTerminal): DisplayReceiverCalibrationRun;
  currentEpoch(): number;
  currentGeneration(): number;
  hasLiveWork(): boolean;
  onComplete(): void;
  onFailure(error: string): void;
  schedule(callback: () => void, delayMs: number): THandle;
  cancelScheduled(handle: THandle): void;
}

// Trained by `packages/zstd-fixture --make-dictionary` on calibration-shaped
// rows with a different glyph pattern, sampled as the split payloads frames
// carry, never on the measured fixtures below. It is a zstd dictionary with an
// embedded id: the decoder verifies both this protocol hash and that id.
const CALIBRATION_DICTIONARY_BASE64 =
  'N6Qw7IP1PTQjENibOQzDMAzDMHKNjRAiGUcHFiLd2N1ERESESCmllFJKKVMjBQAABovFIiFnAwAkQAAMAgQDAYkFgQMEAQIFgQQDgQUEgYIDgQIEAQWDCQKEBAEBDYYKkFNwJWaTJB0EWzEEYRBGISIiIiIiIiIiSZKkAwEAAAAEAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWVxfIiUoKy4xNDc6PUBDRklMT1JVWFteISQnKi0wMzY5PD9CRUhLTlFUV1pdICMmKSwvMjU4Oz5BREdKTVBTVllcXyIlKCsuMTQ3Oj1AQ0ZJTE9SVVhbXiEkJyotMDM2OTw/QkVIS05RVFdaXSAjJiksLzI1ODs+XiEkJyotMDM2OTw/QkVIS05RVFdaXSAjJiksLzI1ODs+QURHSk1QU1ZZXF8iJSgrLjE0Nzo9QENGSUxPUlVYW14hJCcqLTAzNjk8P0JFSEtOUVRXWl0gIyYpLC8yNTg7PkFER0pNUFNWWVxfIiUoKy4xNDc6PUBDIyYpLC8yNTg7PkFER0pNUFNWWVxfIiUoKy4xNDc6PUBDRklMT1JVWFteISQnKi0wMzY5PD9CRUhLTlFUV1pdICMmKSwvMjU4Oz5BREdKTVBTVllcXyIlKCsuMTQ3Oj1AQ0ZJTE9SVVhbXiEkJyotMDM2OTw/QkVIKCsuMTQ3Oj1AQ0ZJTE9SVVhbXiEkJyotMDM2OTw/QkVIS05RVFdaXSAjJiksLzI1ODs+QURHSk1QU1ZZXF8iJSgrLjE0Nzo9QENGSUxPUlVYW14hJCcqLTAzNjk8P0JFSEtOUVRXWl0gIyYpLC8yNTg7PkFER0pN4AMAAAAXABgAGQAaAAAAAAAAAAAAeAB4AHgAeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPUBDRklMT1JVWFteISQnKi0wMzY5PD9CRUhLTlFUV1pdICMmKSwvMjU4Oz5BREdKTVBTVllcXyIlKCsuMTQ3Oj1AQ0ZJTE9SVVhbXiEkJyotMDM2OTw/QkVIS05RVFdaXSAjJiksLzI1ODs+QURHSk1QU1ZZXF8iQkVIS05RVFdaXSAjJiksLzI1ODs+QURHSk1QU1ZZXF8iJSgrLjE0Nzo9QENGSUxPUlVYW14hJCcqLTAzNjk8P0JFSEtOUVRXWl0gIyYpLC8yNTg7PkFER0pNUFNWWVxfIiUoKy4xNDc6PUBDRklMT1JVWFteISQnR0pNUFNWWVxfIiUoKy4xNDc6PUBDRklMT1JVWFteISQnKi0wMzY5PD9CRUhLTlFUV1pdICMmKSwvMjU4Oz5BREdKTVBTVllcXyIlKCsuMTQ3Oj1AQ0ZJTE9SVVhbXiEkJyotMDM2OTw/QkVIS05RVFdaXSAjJiksTE9SVVhbXiEkJyotMDM2OTw/QkVIS05RVFdaXSAjJiksLzI1ODs+QURHSk1QU1ZZXF8iJSgrLjE0Nzo9QENGSUxPUlVYW14hJCcqLTAzNjk8P0JFSEtOUVRXWl0gIyYpLC8yNTg7PkFER0pNUFNWWVxfIiUoKy4x4AMAAAAUABUAFgAXAAAAAAAAAAAAeAB4AHgAeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABRVFdaXSAjJiksLzI1ODs+QURHSk1QU1ZZXF8iJSgrLjE0Nzo9QENGSUxPUlVYW14hJCcqLTAzNjk8P0JFSEtOUVRXWl0gIyYpLC8yNTg7PkFER0pNUFNWWVxfIiUoKy4xNDc6PUBDRklMT1JVWFteISQnKi0wMzZWWVxfIiUoKy4xNDc6PUBDRklMT1JVWFteISQnKi0wMzY5PD9CRUhLTlFUV1pdICMmKSwvMjU4Oz5BREdKTVBTVllcXyIlKCsuMTQ3Oj1AQ0ZJTE9SVVhbXiEkJyotMDM2OTw/QkVIS05RVFdaXSAjJiksLzI1ODtbXiEkJyotMDM2OTw/QkVIS05RVFdaXSAjJiksLzI1ODs+QURHSk1QU1ZZXF8iJSgrLjE0Nzo9QENGSUxPUlVYW14hJCcqLTAzNjk8P0JFSEtOUVRXWl0gIyYpLC8yNTg7PkFER0pNUFNWWVxfIiUoKy4xNDc6PUAgIyY=';

const CALIBRATION_FIXTURES: readonly CalibrationFixture[] = [
  {
    rows: 1,
    plainBlock:
      'AACNAgBEBHgAeAAgISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fAwBAh3DGChLGABY=',
    dictionaryBlock:
      'AwCD9T00jQIAFAR4ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eXwT8QIcNJyzuyda9aGEB',
  },
  {
    rows: 2,
    plainBlock:
      'AADtAgCEBPABAHgAeAAgISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fWAYA1YME1HoC0CGcxo2jmTIhAEM=',
    dictionaryBlock:
      'AwCD9T005QIAVATwAQABICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX1gG/NXTqNcBA3RYmJv3wixgU4ZO3w0=',
  },
  {
    rows: 4,
    plainBlock:
      'AABNAwC0BOADAAEAAgB4ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX1hZWgoAFKRCIb3qQQpqPQHoEE4DB8pyzmDZFiQWGAI=',
    dictionaryBlock:
      'AwCD9T00DQMApAQAAAEAAgADICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX1hZWgf8FDl9ufoJ6rhaAR3q4wW3KYS0BA==',
  },
  {
    rows: 8,
    plainBlock:
      'AAj9AwB0BcAHAAEAAgADAAQABQAGAHggISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fWFlaW1xdXg4AFKRCQXoUpIyCVChIj0LK1YNk1HoG0CGcRhxUlusYcFtzUgCG',
    dictionaryBlock:
      'AwiD9T00DQQAdAXABwABAAIAAwAEAAUABgAHICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX1hZWltcXV4Q/BQ5PRuKFuU+mkCUqfro1PwEADoQwv7zSubjl0Ez4g+jAfuGAt8N',
  },
  {
    rows: 16,
    plainBlock:
      'ABBlBQD0BoAPAAEAAgADAAQABQAGAAcACAAJAAoACwAMAA0ADgB4ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX1hZWltcXV5fICEiIyQlJhYAFKRCQXoUpIyCVChIj4KUUZAKBelRkDIKUqEgPQpSRkEqFNKrHqSg1hOADuE0xsFvuYYBsxQ1LgBD',
    dictionaryBlock:
      'AxCD9T00HQUA80YaCxQkQHDAQIEbNvZq0NCbkXfDxl4NGnoz8vBk3NnFgFH3wgVdCxbJFSqQKVCcMHEsQWKEiBAgPnjoMMdhg5yGDBguWKhAYYKECBAeOGjAYIGCBAgOGCgQHPhv3+/u7ezr6uno5+blQSwBF/wUOT0bihblPppAFDNailRO1HGqNDQtSn40QpSP6kOEBTpIAnErd4fmC29DN/xPnNRMHAp8Nw==',
  },
  {
    rows: 29,
    plainBlock:
      'ABg9BwCECZgbAAEAAgADAAQABQAGAAcACAAJAAoACwAMAA0ADgAPABAAEQASABMAFAAVABYAFwAYABkAGgAbABwAeCAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9YWVpbXF1eXyAhIiMkJSYnKCkqKywtLi8wMTIzIiDQQ+U0FZoeTRlNhUqPpoymQtOjKaNSoenRlNFUaHpUymgqND2aMpoKlR5NGU2FpkdTRqVC06OVcvUkGfWeAXQ4LbbZN3cy/O0VugE=',
    dictionaryBlock:
      'AxiD9T00tQYAk8gfGC5YqEBhgoQIEB44aMBggYIECA4YKHDDxl4NGnoz8m7Y2KtBQ29GHp6MO7sYMOpeuKBrwSK5QgUyBYoTJo4lSIwQEQLEBw8d5jhskNOQAcMFCxUoTJAQAcIDBw0YLFCQAMEBAwWGYjyuOPHhwoMD/+373b2dfV09Hf3cvDwOTiT8FDk9G4oW5T6aQBQzWopUTtRxqjQ0LUp+NELUZTQRqZyo5FQ29FkU+WiEqMxoFKk3UcKpbOgkqksOAXTI9octb+xbLTGEw6ytxQa1DJiVoe53Aw==',
  },
];

/**
 * Build the calibration as an explicitly stepped transaction over an isolated
 * terminal. Production executes one step per worker task after the first
 * authoritative GPU fence; the synchronous harness below drives these same
 * steps without introducing a second calibration implementation.
 *
 * No writer state changes until every fixture has validated and every paired
 * measurement has succeeded. Completion, failure, and cancellation all erase
 * the calibration dictionary, reset ordering, and free the scratch terminal.
 */
export function createDisplayReceiverCalibrationRun(
  terminal: DisplayReceiverCalibrationTerminal,
  writer: DisplayReceiverProfileWriter,
  clock: () => number = () => performance.now(),
): DisplayReceiverCalibrationRun {
  const prepared: PreparedCalibrationFixture[] = [];
  const observations: CalibrationObservation[] = [];
  let phase:
    | 'install'
    | 'prepare'
    | 'validate-raw'
    | 'validate-plain'
    | 'validate-dictionary'
    | 'measure'
    | 'publish'
    | 'complete'
    | 'failed'
    | 'cancelled' = 'install';
  let fixtureIndex = 0;
  let dictionaryClass = 0;
  let sample = 0;
  let measurementOperation = 0;
  let sequence = 1;
  let rawUs = 0;
  let fusedUs = 0;
  let cleaned = false;
  let failure = '';

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    try {
      terminal.clearDisplayDictionaries();
    } catch {
      // Scratch teardown remains best-effort so `destroy` always runs.
    }
    try {
      terminal.resetDisplayOrdering();
    } catch {
      // A trapped calibration instance is retired below rather than reused.
    }
    try {
      terminal.destroy();
    } catch {
      // The isolated instance owns no live terminal state after this point.
    }
  }

  function reject(error: string): DisplayReceiverCalibrationStep {
    failure = error;
    phase = 'failed';
    cleanup();
    return { status: 'failed', error };
  }

  function validateStaged(
    fixture: PreparedCalibrationFixture,
    wire: Uint8Array,
    label: string,
  ): DisplayReceiverCalibrationStep {
    const handle = terminal.stageDisplayFrame(wire);
    let valid = false;
    try {
      valid = handle !== 0 && terminal.validateStagedFrame(handle);
    } finally {
      if (handle !== 0) terminal.releaseStagedFrame(handle);
    }
    if (!valid) {
      return reject(
        `rows=${fixture.rows} ${label}: ${terminal.takeLastError() ?? 'validation_rejected'}`,
      );
    }
    return { status: 'pending' };
  }

  function measureRaw(fixture: PreparedCalibrationFixture): boolean {
    const startedAt = clock();
    const applied = terminal.applyDelta(fixture.raw, sequence);
    rawUs = Math.max(0, clock() - startedAt) * 1_000;
    sequence = (sequence + 1) >>> 0 || 1;
    return applied;
  }

  function measureFused(wire: Uint8Array): boolean {
    const startedAt = clock();
    const handle = terminal.stageDisplayFrame(wire);
    let applied = false;
    try {
      applied = handle !== 0 && terminal.applyStagedDelta(handle, sequence);
    } finally {
      if (handle !== 0) terminal.releaseStagedFrame(handle);
    }
    fusedUs = Math.max(0, clock() - startedAt) * 1_000;
    sequence = (sequence + 1) >>> 0 || 1;
    return applied;
  }

  return {
    step(): DisplayReceiverCalibrationStep {
      if (phase === 'complete') return { status: 'complete' };
      if (phase === 'failed') return { status: 'failed', error: failure };
      if (phase === 'cancelled') return { status: 'failed', error: 'calibration_cancelled' };
      try {
        if (phase === 'install') {
          const dictionary = decodeBase64(CALIBRATION_DICTIONARY_BASE64);
          if (
            !terminal.installDisplayDictionary(
              CALIBRATION_DICTIONARY_GENERATION,
              CALIBRATION_DICTIONARY_ID,
              CALIBRATION_DICTIONARY_HASH,
              dictionary,
            )
          ) {
            return reject(terminal.takeLastError() ?? 'dictionary_install_rejected');
          }
          phase = 'prepare';
          return { status: 'pending' };
        }

        if (phase === 'prepare') {
          const fixture = CALIBRATION_FIXTURES[fixtureIndex];
          if (fixture === undefined) {
            fixtureIndex = 0;
            phase = 'validate-raw';
            return { status: 'pending' };
          }
          const raw = createCalibrationFrame(fixture.rows, 0);
          prepared.push({
            rows: fixture.rows,
            raw,
            plain: createCompressedFrame(raw, decodeBase64(fixture.plainBlock), false),
            dictionary: createCompressedFrame(raw, decodeBase64(fixture.dictionaryBlock), true),
          });
          fixtureIndex += 1;
          return { status: 'pending' };
        }

        const fixture = prepared[fixtureIndex];
        if (phase === 'validate-raw') {
          if (fixture === undefined) {
            fixtureIndex = 0;
            dictionaryClass = 0;
            sample = 0;
            measurementOperation = 0;
            phase = 'measure';
            return { status: 'pending' };
          }
          const applied = terminal.applyDelta(fixture.raw, sequence);
          sequence = (sequence + 1) >>> 0 || 1;
          if (!applied) {
            return reject(
              `rows=${fixture.rows} raw: ${terminal.takeLastError() ?? 'validation_rejected'}`,
            );
          }
          phase = 'validate-plain';
          return { status: 'pending' };
        }
        if (phase === 'validate-plain') {
          if (fixture === undefined) return reject('calibration_fixture_missing');
          const result = validateStaged(fixture, fixture.plain, 'plain');
          if (result.status === 'failed') return result;
          phase = 'validate-dictionary';
          return result;
        }
        if (phase === 'validate-dictionary') {
          if (fixture === undefined) return reject('calibration_fixture_missing');
          const result = validateStaged(fixture, fixture.dictionary, 'dictionary');
          if (result.status === 'failed') return result;
          fixtureIndex += 1;
          phase = 'validate-raw';
          return result;
        }
        if (phase === 'measure') {
          if (fixture === undefined) {
            phase = 'publish';
            return { status: 'pending' };
          }
          const wire = dictionaryClass === 0 ? fixture.plain : fixture.dictionary;
          const rawFirst = (sample & 1) === 0;
          const applyRaw = measurementOperation === (rawFirst ? 0 : 1);
          const applied = applyRaw ? measureRaw(fixture) : measureFused(wire);
          if (!applied) {
            return reject(terminal.takeLastError() ?? 'calibration_apply_rejected');
          }
          measurementOperation += 1;
          if (measurementOperation < 2) return { status: 'pending' };

          observations.push({
            rawBytes: fixture.raw.byteLength,
            wireBytes: wire.byteLength,
            dictionary: dictionaryClass === 1,
            rawUs,
            fusedUs,
          });
          measurementOperation = 0;
          sample += 1;
          if (sample < CALIBRATION_SAMPLES) return { status: 'pending' };
          sample = 0;
          dictionaryClass += 1;
          if (dictionaryClass < 2) return { status: 'pending' };
          dictionaryClass = 0;
          fixtureIndex += 1;
          return { status: 'pending' };
        }

        cleanup();
        for (const observation of observations) {
          writer.recordRaw(observation.rawBytes, observation.rawUs);
          writer.recordCompressed(
            observation.rawBytes,
            observation.wireBytes,
            observation.dictionary,
            observation.fusedUs,
          );
        }
        writer.publish(0);
        phase = 'complete';
        return { status: 'complete' };
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
    },

    cancel(): void {
      if (phase === 'complete' || phase === 'failed' || phase === 'cancelled') return;
      phase = 'cancelled';
      cleanup();
    },
  };
}

/** Deterministic harness driver over the production step machine. */
export function runDisplayReceiverCalibrationSynchronously(
  terminal: DisplayReceiverCalibrationTerminal,
  writer: DisplayReceiverProfileWriter,
  clock: () => number = () => performance.now(),
): string | null {
  const run = createDisplayReceiverCalibrationRun(terminal, writer, clock);
  for (;;) {
    const result = run.step();
    if (result.status === 'complete') return null;
    if (result.status === 'failed') return result.error;
  }
}

/**
 * One calibration operation per task. Terminal creation is asynchronous and
 * token-fenced, so even an unresolved factory cannot delay worker readiness or
 * retain a terminal after an epoch transition.
 */
export function createDisplayReceiverCalibrationScheduler<THandle>(
  options: DisplayReceiverCalibrationSchedulerOptions<THandle>,
): DisplayReceiverCalibrationScheduler {
  let token = 0;
  let active = false;
  let scheduled: THandle | null = null;
  let run: DisplayReceiverCalibrationRun | null = null;

  function cancelScheduled(): void {
    if (scheduled === null) return;
    options.cancelScheduled(scheduled);
    scheduled = null;
  }

  function retire(): void {
    token = (token + 1) >>> 0;
    active = false;
    cancelScheduled();
    run?.cancel();
    run = null;
  }

  function scheduleStep(
    expectedToken: number,
    epoch: number,
    generation: number,
    delayMs: number,
  ): void {
    cancelScheduled();
    scheduled = options.schedule(() => {
      scheduled = null;
      if (
        !active ||
        token !== expectedToken ||
        options.currentEpoch() !== epoch ||
        options.currentGeneration() !== generation
      ) {
        retire();
        return;
      }
      if (options.hasLiveWork()) {
        scheduleStep(expectedToken, epoch, generation, CALIBRATION_BUSY_RETRY_MS);
        return;
      }
      const currentRun = run;
      if (currentRun === null) return;
      const result = currentRun.step();
      if (result.status === 'pending') {
        scheduleStep(expectedToken, epoch, generation, 0);
        return;
      }
      active = false;
      run = null;
      if (result.status === 'complete') options.onComplete();
      else options.onFailure(result.error);
    }, delayMs);
  }

  return {
    start(epoch, generation): void {
      if (
        active ||
        epoch === 0 ||
        generation === 0 ||
        options.currentEpoch() !== epoch ||
        options.currentGeneration() !== generation
      ) {
        return;
      }
      active = true;
      token = (token + 1) >>> 0;
      const expectedToken = token;
      scheduled = options.schedule(() => {
        scheduled = null;
        if (
          !active ||
          token !== expectedToken ||
          options.currentEpoch() !== epoch ||
          options.currentGeneration() !== generation
        ) {
          retire();
          return;
        }
        void options.createTerminal().then(
          (terminal) => {
            if (
              !active ||
              token !== expectedToken ||
              options.currentEpoch() !== epoch ||
              options.currentGeneration() !== generation
            ) {
              terminal.destroy();
              return;
            }
            try {
              run = options.createRun(terminal);
            } catch (error) {
              terminal.destroy();
              active = false;
              options.onFailure(error instanceof Error ? error.message : String(error));
              return;
            }
            scheduleStep(expectedToken, epoch, generation, 0);
          },
          (error: unknown) => {
            if (
              !active ||
              token !== expectedToken ||
              options.currentEpoch() !== epoch ||
              options.currentGeneration() !== generation
            ) {
              return;
            }
            active = false;
            options.onFailure(error instanceof Error ? error.message : String(error));
          },
        );
      }, 0);
    },

    cancel(): void {
      retire();
    },

    isActive(): boolean {
      return active;
    },
  };
}

function createCalibrationFrame(encodedRows: number, patchFlags: number): Uint8Array {
  const cellBytes = 1 + DISPLAY_RECEIVER_CALIBRATION_COLS * 2;
  const rowBytes = DISPLAY_ROW_PREFIX_BYTES + cellBytes;
  const frame = new Uint8Array(DISPLAY_ROWS_OFFSET + encodedRows * rowBytes);
  frame[DISPLAY_MESSAGE_TYPE_OFFSET] = MESSAGE_TYPE_DISPLAY_PATCH;
  writeU32BE(
    frame,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    frame.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  frame[DISPLAY_VERSION_OFFSET] = DISPLAY_PROTOCOL_VERSION;
  frame[DISPLAY_PATCH_FLAGS_OFFSET] = patchFlags;
  writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, 1);
  writeU32BE(frame, DISPLAY_GENERATION_OFFSET, CALIBRATION_DICTIONARY_GENERATION);
  writeU16(frame, DISPLAY_COLUMNS_OFFSET, DISPLAY_RECEIVER_CALIBRATION_COLS);
  writeU16(frame, DISPLAY_GRID_ROWS_OFFSET, DISPLAY_RECEIVER_CALIBRATION_ROWS);
  writeU32BE(frame, DISPLAY_FRAME_ID_OFFSET, CALIBRATION_FRAME_ID);
  writeU32BE(frame, DISPLAY_PRESENTATION_ID_OFFSET, CALIBRATION_PRESENTATION_ID);
  writeU16(frame, DISPLAY_CHUNK_INDEX_OFFSET, 0);
  writeU16(frame, DISPLAY_CHUNK_COUNT_OFFSET, 1);
  writeU16(frame, DISPLAY_ROW_COUNT_OFFSET, encodedRows);
  let offset = DISPLAY_ROWS_OFFSET;
  for (let row = 0; row < encodedRows; row += 1) {
    writeU16(frame, offset, row);
    writeU16(frame, offset + 4, DISPLAY_RECEIVER_CALIBRATION_COLS);
    writeU16(frame, offset + 6, cellBytes);
    frame[offset + DISPLAY_ROW_PREFIX_BYTES] = DISPLAY_COLOR_MODE_INDEXED;
    let cellOffset = offset + DISPLAY_ROW_PREFIX_BYTES + 1;
    for (let col = 0; col < DISPLAY_RECEIVER_CALIBRATION_COLS; col += 1) {
      frame[cellOffset] = 0;
      frame[cellOffset + 1] = 0x20 + ((row + col) & 0x3f);
      cellOffset += 2;
    }
    offset += rowBytes;
  }
  return frame;
}

function createCompressedFrame(
  raw: Uint8Array,
  block: Uint8Array,
  dictionary: boolean,
): Uint8Array {
  const payloadOffset = dictionary
    ? DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET
    : DISPLAY_COMPRESSED_PAYLOAD_OFFSET;
  const wire = new Uint8Array(payloadOffset + block.byteLength);
  wire.set(raw.subarray(0, DISPLAY_ROWS_OFFSET));
  wire[DISPLAY_DATAGRAM_HEADER_FLAGS_OFFSET] =
    DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD |
    (dictionary ? DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT : 0);
  if (dictionary) {
    writeU32BE(wire, DISPLAY_GENERATION_OFFSET, CALIBRATION_DICTIONARY_GENERATION);
    writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET + 4, CALIBRATION_DICTIONARY_ID);
    writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET + 8, CALIBRATION_DICTIONARY_HASH);
  }
  writeU32BE(
    wire,
    DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
    wire.byteLength - DISPLAY_STREAM_HEADER_BYTES,
  );
  writeU32BE(wire, DISPLAY_COMPRESSED_LENGTH_OFFSET, raw.byteLength - DISPLAY_ROWS_OFFSET);
  wire.set(block, payloadOffset);
  return wire;
}

function decodeBase64(encoded: string): Uint8Array {
  const decoded = atob(encoded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}
