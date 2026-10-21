/**
 * Reader for the dataplane's capture file, `.mtrace`, which `merkur-trace` writes
 * (`packages/merkur-trace/src/file.rs` documents the layout). Both sides are pinned by
 * `packages/merkur-trace/testdata/capture.mtrace`.
 *
 * Every count and value must be a safe integer: an unsafe u64 rejects the capture rather
 * than rounding. Evidence keeps the record shape the e2e oracles join on.
 */

const MAGIC = 'MRKTRACE';
const HEADER_WORDS = 9;
const EVIDENCE_WORDS = 19;
const SPAN_WORDS = 4;

/** The anchor clock a capture's times are measured against. */
export type NativeTraceClock = 'mach-uptime-raw' | 'linux-monotonic';

export interface NativePerfTraceRecord {
  readonly ordinal: number;
  readonly owner: number;
  /** Process-monotonic microseconds, never browser epoch milliseconds. */
  readonly at_us: number;
  readonly kind: string;
  readonly fields: readonly number[];
}

export interface NativeTraceSpan {
  /** The writing thread's system id. */
  readonly thread: number;
  readonly name: string;
  readonly phase: 'begin' | 'end' | 'mark';
  /** Nanoseconds since the recorder's origin. */
  readonly atNs: number;
  readonly arg: number;
}

export interface NativeTraceCapture {
  readonly owner: number;
  readonly peerId: string;
  readonly sessionId: string;
  readonly observationEpoch: number;
  /** Current-owner records refused. Timing claims require zero. */
  readonly dropped: number;
  /** Earlier owners' records: informational, never current loss. */
  readonly stale: number;
  /** The span clock jumped (the machine slept); span times prove nothing. */
  readonly discontinuous: boolean;
  readonly clock: NativeTraceClock;
  /** The recorder's origin on the anchor clock, in nanoseconds. */
  readonly originAnchorNs: bigint;
  /** Bound on the error mapping spans and the origin onto the anchor clock. */
  readonly clockErrorNs: number;
  /** The recording process, which a CPU profile of it names too. */
  readonly pid: number;
  /** Evidence, sorted by ordinal. */
  readonly records: readonly NativePerfTraceRecord[];
  /** Spans grouped by thread, each thread's in the order it wrote them. */
  readonly spans: readonly NativeTraceSpan[];
}

export class NativeTraceDecodeError extends Error {
  override readonly name = 'NativeTraceDecodeError';
}

class Reader {
  private offset = 0;
  private readonly view: DataView;
  private readonly text = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remainingWords(): number {
    return Math.floor((this.bytes.byteLength - this.offset) / 8);
  }

  get done(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  magic(): void {
    const magic = this.text.decode(this.take(8));
    if (magic !== MAGIC) throw new NativeTraceDecodeError('not a native trace capture');
  }

  big(): bigint {
    if (this.remainingWords < 1) throw new NativeTraceDecodeError('capture is truncated');
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  word(what: string): number {
    const value = this.big();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new NativeTraceDecodeError(`${what} is not a safe integer`);
    }
    return Number(value);
  }

  count(what: string, wordsEach: number): number {
    const count = this.word(what);
    if (count * wordsEach > this.remainingWords) {
      throw new NativeTraceDecodeError(`${what} exceeds the capture`);
    }
    return count;
  }

  string(what: string): string {
    const length = this.word(what);
    const padded = Math.ceil(length / 8) * 8;
    if (padded > this.bytes.byteLength - this.offset) {
      throw new NativeTraceDecodeError(`${what} exceeds the capture`);
    }
    const value = this.text.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += padded;
    return value;
  }

  private take(length: number): Uint8Array {
    if (length > this.bytes.byteLength - this.offset) {
      throw new NativeTraceDecodeError('capture is truncated');
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
}

function clockOf(domain: number): NativeTraceClock {
  if (domain === 1) return 'mach-uptime-raw';
  if (domain === 2) return 'linux-monotonic';
  throw new NativeTraceDecodeError(`unknown clock domain ${domain}`);
}

function phaseOf(phase: number): NativeTraceSpan['phase'] {
  if (phase === 1) return 'begin';
  if (phase === 2) return 'end';
  if (phase === 3) return 'mark';
  throw new NativeTraceDecodeError(`unknown span phase ${phase}`);
}

/** Decodes one capture file; throws `NativeTraceDecodeError` on any malformed byte. */
export function decodeNativeTrace(bytes: Uint8Array): NativeTraceCapture {
  const reader = new Reader(bytes);
  reader.magic();
  if (reader.remainingWords < HEADER_WORDS)
    throw new NativeTraceDecodeError('capture is truncated');
  const owner = reader.word('owner');
  const observationEpoch = reader.word('observation epoch');
  const dropped = reader.word('dropped');
  const stale = reader.word('stale');
  const discontinuous = reader.word('discontinuity');
  const clock = clockOf(reader.word('clock domain'));
  const originAnchorNs = reader.big();
  const clockErrorNs = reader.word('clock error');
  const pid = reader.word('process id');
  if (owner === 0 || owner > 0xffff_ffff) throw new NativeTraceDecodeError('invalid owner');
  if (observationEpoch === 0 || observationEpoch > 0xffff_ffff) {
    throw new NativeTraceDecodeError('invalid observation epoch');
  }
  if (discontinuous > 1) throw new NativeTraceDecodeError('invalid discontinuity flag');
  const peerId = reader.string('peer id');
  const sessionId = reader.string('session id');
  const siteCount = reader.count('site count', 1);
  const sites: string[] = [];
  for (let index = 0; index < siteCount; index += 1) sites.push(reader.string('site name'));
  const siteName = (id: number): string => {
    const name = sites[id - 1];
    if (name === undefined || name.length === 0) {
      throw new NativeTraceDecodeError(`record names unknown site ${id}`);
    }
    return name;
  };

  const records: NativePerfTraceRecord[] = [];
  const evidenceCount = reader.count('evidence count', EVIDENCE_WORDS);
  let previousOrdinal = 0;
  for (let index = 0; index < evidenceCount; index += 1) {
    const ordinal = reader.word('ordinal');
    const atNs = reader.word('evidence time');
    const kind = siteName(reader.word('evidence site'));
    const fields: number[] = [];
    for (let field = 0; field < 16; field += 1) fields.push(reader.word('evidence field'));
    if (ordinal <= previousOrdinal)
      throw new NativeTraceDecodeError('evidence is not in ordinal order');
    previousOrdinal = ordinal;
    records.push({ ordinal, owner, at_us: Math.floor(atNs / 1000), kind, fields });
  }

  const spans: NativeTraceSpan[] = [];
  const spanCount = reader.count('span count', SPAN_WORDS);
  for (let index = 0; index < spanCount; index += 1) {
    const thread = reader.word('span thread');
    const sitePhase = reader.big();
    const atNs = reader.word('span time');
    const arg = reader.word('span value');
    if (sitePhase >> 40n !== 0n) throw new NativeTraceDecodeError('invalid span site');
    spans.push({
      thread,
      name: siteName(Number(sitePhase & 0xffff_ffffn)),
      phase: phaseOf(Number(sitePhase >> 32n)),
      atNs,
      arg,
    });
  }
  if (!reader.done) throw new NativeTraceDecodeError('capture has trailing bytes');
  return {
    owner,
    peerId,
    sessionId,
    observationEpoch,
    dropped,
    stale,
    discontinuous: discontinuous === 1,
    clock,
    originAnchorNs,
    clockErrorNs,
    pid,
    records,
    spans,
  };
}
