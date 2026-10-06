import { DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH } from '@merkur/shared';

// Browser I/O for Session actions. This module frames opaque records; Rust
// alone authenticates, assigns input sequences and decides carrier ownership.

export interface CarrierEvents {
  splice(json: string): Promise<void>;
  reliable(source: bigint, channel: number, payload: Uint8Array): Promise<void>;
  datagram(payload: Uint8Array): Promise<void>;
  proof(payload: Uint8Array): Promise<void>;
  finite(
    stream: bigint,
    kind: number,
    channel: number,
    total: number,
    bytes: Uint8Array,
  ): Promise<void>;
  closed(egressBudget: boolean): void;
}

type NativeDatagrams = WebTransportDatagramDuplexStream & {
  createWritable?: () => WritableStream<Uint8Array>;
  incomingMaxBufferedDatagrams?: number;
  outgoingMaxBufferedDatagrams?: number;
};

/** Browser queue policy only. Inbound supersession is decided by Rust, never age. */
function configureDatagrams(stream: NativeDatagrams): number {
  try {
    stream.outgoingMaxAge = 48;
  } catch {
    /* setter is an optional native capability */
  }
  const setCapacity = (
    current: 'incomingMaxBufferedDatagrams' | 'outgoingMaxBufferedDatagrams',
    alias: 'incomingHighWaterMark' | 'outgoingHighWaterMark',
    value: number,
  ): void => {
    if (current in stream) {
      try {
        stream[current] = value;
        return;
      } catch {
        /* sample the supported native alias */
      }
    }
    if (alias in stream) {
      try {
        stream[alias] = value;
      } catch {
        /* report actual native depth */
      }
    }
  };
  setCapacity(
    'incomingMaxBufferedDatagrams',
    'incomingHighWaterMark',
    DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH,
  );
  setCapacity('outgoingMaxBufferedDatagrams', 'outgoingHighWaterMark', 2);
  for (const key of ['incomingMaxBufferedDatagrams', 'incomingHighWaterMark'] as const) {
    try {
      const value = stream[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {
      /* unreadable optional native property */
    }
  }
  return 0;
}

// Native handshake admission belongs to the browser. A cancelled Rust attempt
// detaches from an already-started edge handshake: Chromium must decide ready
// before close, otherwise cancellation itself adds a native throttle penalty.
const edgeHandshakes = (() => {
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  let lastFailed = false;
  let onlineListener = false;
  const offline = (): boolean => globalThis.navigator?.onLine === false;
  const startable = (): boolean => !offline() && (inFlight === 0 || !lastFailed);
  const pump = (): void => {
    while (waiting.length > 0 && startable()) {
      inFlight += 1;
      waiting.shift()?.();
    }
    if (waiting.length > 0 && offline() && !onlineListener) {
      onlineListener = true;
      globalThis.addEventListener?.(
        'online',
        () => {
          onlineListener = false;
          pump();
        },
        { once: true },
      );
    }
  };
  const admit = (signal: AbortSignal): true | Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    if (waiting.length === 0 && startable()) {
      inFlight += 1;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const start = (): void => {
        signal.removeEventListener('abort', cancel);
        resolve(true);
      };
      const cancel = (): void => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        resolve(false);
      };
      signal.addEventListener('abort', cancel, { once: true });
      waiting.push(start);
      pump();
    });
  };
  return {
    admit,
    settle(established: boolean): void {
      inFlight -= 1;
      lastFailed = !established;
      pump();
    },
  };
})();

async function nativeTransport(
  url: string,
  hashes: readonly (readonly number[])[],
  direct: boolean,
  signal: AbortSignal,
): Promise<WebTransport> {
  if (signal.aborted) throw new Error('terminal carrier dial retired');
  if (!direct) {
    const admitted = edgeHandshakes.admit(signal);
    if (admitted !== true && !(await admitted)) throw new Error('terminal carrier dial retired');
  }
  let transport: WebTransport;
  try {
    transport = new WebTransport(url, {
      ...(direct ? {} : { allowPooling: false }),
      serverCertificateHashes: hashes.map((value) => ({
        algorithm: 'sha-256',
        value: new Uint8Array(value).buffer,
      })),
    });
  } catch (error) {
    if (!direct) edgeHandshakes.settle(false);
    throw error;
  }
  // Observe closed even when Rust retires the attempt before readiness.
  void transport.closed.catch(() => undefined);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    transport.close();
  };
  const retired = Promise.withResolvers<false>();
  const detach = (): void => {
    if (direct) close();
    retired.resolve(false);
  };
  signal.addEventListener('abort', detach, { once: true });
  if (signal.aborted) detach();
  const decided = transport.ready.then(
    () => true,
    () => false,
  );
  void decided.then((established) => {
    if (!direct) edgeHandshakes.settle(established);
    if (!established || signal.aborted) close();
  });
  const established = await Promise.race([decided, retired.promise]);
  signal.removeEventListener('abort', detach);
  if (!established || signal.aborted) throw new Error('terminal carrier dial retired or rejected');
  return transport;
}

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_PROOF_BYTES = 64 * 1024;
// Four persistent terminal channels and four finite graphics jobs may occupy
// native readers. Hold incoming-stream credit before accepting another stream.
const MAX_INCOMING_STREAMS = 8;
const EMPTY = new Uint8Array(0);

/** A cursor over arbitrary native stream chunks, including split headers. */
export class CarrierReader {
  private chunk: Uint8Array = EMPTY;
  private offset = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async exact(length: number, cleanEnd = false): Promise<Uint8Array | null> {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.offset === this.chunk.byteLength) {
        const next = await this.reader.read();
        if (next.done) {
          if (cleanEnd && written === 0) return null;
          throw new Error('terminal carrier stream ended within a record');
        }
        this.chunk = next.value;
        this.offset = 0;
        if (this.chunk.byteLength === 0) continue;
      }
      const count = Math.min(length - written, this.chunk.byteLength - this.offset);
      result.set(this.chunk.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
    }
    return result;
  }

  async record(maximum = MAX_RECORD_BYTES): Promise<Uint8Array | null> {
    const header = await this.exact(4, true);
    if (header === null) return null;
    const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0);
    if (length > maximum) throw new Error('terminal carrier record exceeds its bound');
    return this.exact(length);
  }

  async part(): Promise<Uint8Array | null> {
    if (this.offset !== this.chunk.byteLength) {
      const result = this.chunk.subarray(this.offset);
      this.offset = this.chunk.byteLength;
      return result;
    }
    const next = await this.reader.read();
    return next.done ? null : next.value;
  }

  dispose(): void {
    void this.reader.cancel().catch(() => undefined);
  }
}

export function carrierRecord(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_RECORD_BYTES) throw new Error('terminal carrier record too large');
  const record = new Uint8Array(payload.byteLength + 4);
  new DataView(record.buffer).setUint32(0, payload.byteLength);
  record.set(payload, 4);
  return record;
}

export interface ClientCarrier {
  readonly receiveQueueDatagrams: number;
  reliable(channel: number, payload: Uint8Array): Promise<void>;
  proof(payload: Uint8Array): Promise<void>;
  datagram(payload: Uint8Array): Promise<void>;
  close(): void;
}

/** Each write awaits native stream credit; no detached per-record write queue. */
export async function dialClientCarrier(
  url: string,
  hashes: readonly (readonly number[])[],
  preface: Uint8Array,
  candidate: boolean,
  direct: boolean,
  events: CarrierEvents,
  signal: AbortSignal,
): Promise<ClientCarrier> {
  let transport: WebTransport;
  try {
    transport = await nativeTransport(url, hashes, direct, signal);
  } catch (error) {
    events.closed(false);
    throw error;
  }
  let ended = false;
  let finiteId = 0n;
  let incomingActive = 0;
  let incomingWake: (() => void) | null = null;
  const readers = new Set<CarrierReader>();
  const writers = new Map<number, WritableStreamDefaultWriter<Uint8Array>>();
  const opening = new Map<number, Promise<WritableStreamDefaultWriter<Uint8Array>>>();
  const nativeDatagrams = transport.datagrams as NativeDatagrams;
  const receiveQueueDatagrams = configureDatagrams(nativeDatagrams);
  const datagramStream = nativeDatagrams.createWritable?.() ?? nativeDatagrams.writable;
  const datagrams = datagramStream.getWriter();
  const abort = (): void => {
    if (ended) return;
    transport.close();
    finish(false);
  };
  let proofWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let prefaceWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const finish = (egressBudget: boolean): void => {
    if (ended) return;
    ended = true;
    signal.removeEventListener('abort', abort);
    incomingWake?.();
    incomingWake = null;
    for (const reader of readers) reader.dispose();
    events.closed(egressBudget);
  };
  const watchWriter = (writer: WritableStreamDefaultWriter<Uint8Array>): void => {
    const closed = (): void => {
      if (ended) return;
      transport.close();
      finish(false);
    };
    void writer.closed.then(closed, closed);
  };
  const run = (operation: Promise<void>): void => {
    void operation.catch(() => {
      if (ended) return;
      transport.close();
      finish(false);
    });
  };
  const borrow = (stream: ReadableStream<Uint8Array>): CarrierReader => {
    const reader = new CarrierReader(stream.getReader());
    readers.add(reader);
    return reader;
  };
  const reliableReader = async (
    reader: CarrierReader,
    source: bigint,
    channel: number,
  ): Promise<void> => {
    try {
      if ((channel & 0x80) !== 0) {
        const header = await reader.exact(4);
        if (header === null) throw new Error('missing finite stream length');
        const total = new DataView(header.buffer).getUint32(0);
        const stream = ++finiteId;
        await events.finite(stream, 3, channel, total, EMPTY);
        let complete = false;
        try {
          for (;;) {
            const part = await reader.part();
            if (part === null) {
              complete = true;
              break;
            }
            await events.finite(stream, 4, channel, 0, part);
          }
        } catch {
          // A failed finite asset is a stream-local failure. Rust owns retry.
        } finally {
          await events.finite(stream, complete ? 5 : 6, channel, 0, EMPTY);
        }
      } else {
        for (;;) {
          const record = await reader.record();
          if (record === null) throw new Error('persistent carrier stream ended');
          await events.reliable(source, channel, record);
        }
      }
    } finally {
      readers.delete(reader);
      reader.dispose();
    }
  };
  const channelWriter = (channel: number): Promise<WritableStreamDefaultWriter<Uint8Array>> => {
    const writer = writers.get(channel);
    if (writer !== undefined) return Promise.resolve(writer);
    const pending = opening.get(channel);
    if (pending !== undefined) return pending;
    const created = (async (): Promise<WritableStreamDefaultWriter<Uint8Array>> => {
      if (ended) throw new Error('terminal carrier ended');
      let writer: WritableStreamDefaultWriter<Uint8Array>;
      if (direct) {
        const stream = await transport.createBidirectionalStream();
        if (ended) throw new Error('terminal carrier ended');
        writer = stream.writable.getWriter();
        watchWriter(writer);
        await writer.write(Uint8Array.of(channel));
        run(reliableReader(borrow(stream.readable), 0n, channel));
      } else {
        const stream = await transport.createUnidirectionalStream();
        if (ended) throw new Error('terminal carrier ended');
        writer = stream.getWriter();
        watchWriter(writer);
        await writer.write(Uint8Array.of(channel));
      }
      if (ended) throw new Error('terminal carrier ended');
      writers.set(channel, writer);
      opening.delete(channel);
      return writer;
    })();
    opening.set(channel, created);
    return created;
  };
  watchWriter(datagrams);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  void transport.closed.then(
    (info) => finish(info.closeCode === 0x4d03 && info.reason === 'egress-budget'),
    () => finish(false),
  );
  try {
    await transport.ready;
    if (ended) throw new Error('terminal carrier dial retired');
    if (!direct) {
      const stream = await transport.createBidirectionalStream();
      if (ended) throw new Error('terminal carrier ended');
      prefaceWriter = stream.writable.getWriter();
      // The edge stops reading once it has the preface (STOP_SENDING); only the
      // inbound half of this stream lives on, so its writer's end is not the carrier's.
      void prefaceWriter.closed.catch(() => undefined);
      await prefaceWriter.write(preface);
      run(
        (async () => {
          const reader = borrow(stream.readable);
          try {
            for (;;) {
              const record = await reader.record(4096);
              if (record === null) throw new Error('persistent carrier stream ended');
              await events.splice(new TextDecoder('utf-8', { fatal: true }).decode(record));
            }
          } finally {
            readers.delete(reader);
            reader.dispose();
          }
        })(),
      );
      if (candidate) {
        const proof = await transport.createBidirectionalStream();
        if (ended) throw new Error('terminal carrier ended');
        proofWriter = proof.writable.getWriter();
        // The proof bridge is finite: the edge ends both of its halves when it
        // promotes this candidate, which carries on as the signaling attachment.
        // Its end is not the carrier's; an unanswered rebind is bounded by the
        // session's own deadlines.
        void proofWriter.closed.catch(() => undefined);
        void (async () => {
          const reader = borrow(proof.readable);
          try {
            for (;;) {
              const record = await reader.record(MAX_PROOF_BYTES);
              if (record === null) return;
              await events.proof(record);
            }
          } finally {
            readers.delete(reader);
            reader.dispose();
          }
        })().catch(() => undefined);
      }
    } else {
      for (const channel of [2, 1, 4]) await channelWriter(channel);
    }
    run(
      (async () => {
        const incoming = transport.incomingUnidirectionalStreams.getReader();
        try {
          for (;;) {
            while (!ended && incomingActive === MAX_INCOMING_STREAMS)
              await new Promise<void>((resolve) => {
                incomingWake = resolve;
              });
            if (ended) return;
            const next = await incoming.read();
            if (next.done) return;
            incomingActive += 1;
            const reader = borrow(next.value);
            run(
              (async () => {
                const head = await reader.exact(direct ? 1 : 9);
                if (head === null) throw new Error('missing terminal channel');
                const view = new DataView(head.buffer);
                const source = direct ? 0n : view.getBigUint64(0);
                const channel = head[direct ? 0 : 8] ?? 0;
                try {
                  await reliableReader(reader, source, channel);
                } finally {
                  incomingActive -= 1;
                  const wake: (() => void) | null = incomingWake as (() => void) | null;
                  incomingWake = null;
                  wake?.();
                }
              })(),
            );
          }
        } finally {
          incoming.releaseLock();
        }
      })(),
    );
    run(
      (async () => {
        const reader = transport.datagrams.readable.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) return;
            await events.datagram(next.value);
          }
        } finally {
          reader.releaseLock();
        }
      })(),
    );
    return {
      receiveQueueDatagrams,
      async reliable(channel, payload): Promise<void> {
        const writer = await channelWriter(channel);
        await writer.ready;
        await writer.write(carrierRecord(payload));
      },
      async proof(payload): Promise<void> {
        if (proofWriter === null) throw new Error('carrier has no proof stream');
        if (payload.byteLength > MAX_PROOF_BYTES) throw new Error('proof record too large');
        await proofWriter.ready;
        await proofWriter.write(carrierRecord(payload));
      },
      async datagram(payload): Promise<void> {
        await datagrams.ready;
        await datagrams.write(payload);
      },
      close(): void {
        if (ended) return;
        ended = true;
        signal.removeEventListener('abort', abort);
        incomingWake?.();
        incomingWake = null;
        for (const reader of readers) reader.dispose();
        // Native connection close owns teardown of every persistent writer.
        // Explicit writer.abort races Chromium's worker connection shutdown.
        transport.close();
      },
    };
  } catch (error) {
    if (!ended) transport.close();
    finish(false);
    throw error;
  }
}
