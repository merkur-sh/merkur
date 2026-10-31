import { describe, expect, test } from 'bun:test';
import { DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH } from '@merkur/shared';
import { carrierChunks } from '../../../../scripts/perf/carrier-reader-fixture';
import { CarrierReader, carrierRecord, dialClientCarrier } from './client-carrier';

function incomingLane() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const disposed = Promise.withResolvers<void>();
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const getReader = readable.getReader.bind(readable);
  Object.defineProperty(readable, 'getReader', {
    value() {
      const reader = getReader();
      const cancel = reader.cancel.bind(reader);
      reader.cancel = () => {
        disposed.resolve();
        return cancel();
      };
      return reader;
    },
  });
  if (controller === undefined) throw new Error('missing lane controller');
  return { readable, controller, disposed: disposed.promise };
}

function transportError(source: 'stream' | 'session', streamErrorCode: number): DOMException {
  return Object.assign(new DOMException('stream reset', 'WebTransportError'), {
    source,
    streamErrorCode,
  });
}

function sourceRecord(source: bigint, channel: number, value: number): Uint8Array {
  const result = new Uint8Array(14);
  new DataView(result.buffer).setBigUint64(0, source);
  result[8] = channel;
  result.set(carrierRecord(Uint8Array.of(value)), 9);
  return result;
}

async function incomingCarrier(direct = false) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  let incoming: ReadableStreamDefaultController<ReadableStream<Uint8Array>> | undefined;
  let closes = 0;
  let datagramInput: ReadableStreamDefaultController<Uint8Array> | undefined;
  const datagramReceived = Promise.withResolvers<Uint8Array>();
  const finiteEnded = Promise.withResolvers<void>();
  const finiteParts: { kind: number; bytes: Uint8Array }[] = [];
  const deliveries: { source: bigint; channel: number; bytes: Uint8Array }[] = [];
  const delivered = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const closed = Promise.withResolvers<void>();
  class Transport {
    readonly ready = Promise.resolve();
    readonly closed = new Promise<{ closeCode: number; reason: string }>(() => {});
    readonly incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
      start(controller) {
        incoming = controller;
      },
    });
    readonly datagrams = {
      writable: new WritableStream<Uint8Array>(),
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          datagramInput = controller;
        },
      }),
    };
    createBidirectionalStream() {
      return Promise.resolve({
        writable: new WritableStream<Uint8Array>(),
        readable: new ReadableStream<Uint8Array>(),
      });
    }
    close(): void {
      closes += 1;
    }
  }
  Object.defineProperty(globalThis, 'WebTransport', { configurable: true, value: Transport });
  const carrier = await dialClientCarrier(
    'https://edge.example',
    [],
    Uint8Array.of(7),
    false,
    direct,
    {
      handshake: () => {},
      splice: async () => {},
      datagram: async (bytes) => {
        datagramReceived.resolve(bytes);
      },
      proof: async () => {},
      finite: async (_stream, kind, _channel, _total, bytes) => {
        finiteParts.push({ kind, bytes });
        if (kind === 5 || kind === 6) finiteEnded.resolve();
      },
      reliable: async (source, channel, bytes) => {
        deliveries.push({ source, channel, bytes });
        delivered.get(deliveries.length)?.resolve();
      },
      closed: () => closed.resolve(),
    },
    new AbortController().signal,
  );
  if (incoming === undefined) throw new Error('missing incoming stream controller');
  return {
    incoming,
    deliveries,
    datagramInput,
    datagramReceived: datagramReceived.promise,
    finiteEnded: finiteEnded.promise,
    finiteParts,
    closed: closed.promise,
    closes: () => closes,
    delivery(count: number): Promise<void> {
      if (deliveries.length >= count) return Promise.resolve();
      const pending = Promise.withResolvers<void>();
      delivered.set(count, pending);
      return pending.promise;
    },
    dispose(): void {
      carrier.close();
      incoming?.close();
      datagramInput?.close();
      if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
      else Object.defineProperty(globalThis, 'WebTransport', original);
    },
  };
}

test('retired_source_does_not_close_successor_carrier', async () => {
  let returned = 0;
  let continued = 0;
  for (const successorFirst of [false, true]) {
    const fixture = await incomingCarrier();
    try {
      const successor = incomingLane();
      if (successorFirst) {
        fixture.incoming.enqueue(successor.readable);
        successor.controller.enqueue(sourceRecord(2n, 2, 41));
        await fixture.delivery(1);
      }
      // Every framing position, repeated beyond the eight incoming reader slots.
      for (let index = 0; index < 18; index += 1) {
        const predecessor = incomingLane();
        fixture.incoming.enqueue(predecessor.readable);
        const wire = sourceRecord(1n, 2, index);
        const position = [0, 4, 9, 11, 13, 14][index % 6] ?? 0;
        if (position > 0) predecessor.controller.enqueue(wire.subarray(0, position));
        const before = fixture.deliveries.length;
        if (position === wire.length) await fixture.delivery(before + 1);
        predecessor.controller.error(transportError('stream', 1));
        await predecessor.disposed;
        returned += 1;
        expect(fixture.closes()).toBe(0);
        if (!successorFirst && index === 0) {
          fixture.incoming.enqueue(successor.readable);
          successor.controller.enqueue(sourceRecord(2n, 2, 41));
        } else {
          successor.controller.enqueue(carrierRecord(Uint8Array.of(index + 42)));
        }
        await fixture.delivery(fixture.deliveries.length + 1);
        continued += 1;
      }
      expect(fixture.closes()).toBe(0);
    } finally {
      fixture.dispose();
    }
  }
  process.stdout.write(
    `retired_source readers_returned=${returned} successor_continuations=${continued} carrier_closes=0\n`,
  );
});

test('retired_source_keeps_unexpected_lane_failures_terminal', async () => {
  for (const failure of [
    'fin',
    'truncated-header',
    'truncated-body',
    'unknown-reset',
    'session-reset',
    'unbranded-reset',
    'oversize',
  ] as const) {
    const fixture = await incomingCarrier();
    try {
      const lane = incomingLane();
      fixture.incoming.enqueue(lane.readable);
      lane.controller.enqueue(sourceRecord(1n, 2, 1));
      await fixture.delivery(1);
      if (failure === 'unknown-reset') {
        lane.controller.error(transportError('stream', 2));
      } else if (failure === 'session-reset') {
        lane.controller.error(transportError('session', 1));
      } else if (failure === 'unbranded-reset') {
        lane.controller.error({ source: 'stream', streamErrorCode: 1 });
      } else if (failure === 'oversize') {
        lane.controller.enqueue(Uint8Array.of(0x7f, 0xff, 0xff, 0xff));
      } else {
        if (failure === 'truncated-header') lane.controller.enqueue(Uint8Array.of(0));
        if (failure === 'truncated-body') lane.controller.enqueue(Uint8Array.of(0, 0, 0, 2, 9));
        lane.controller.close();
      }
      await fixture.closed;
      expect(fixture.closes()).toBe(1);
    } finally {
      fixture.dispose();
    }
  }
  process.stdout.write('active_lane faults=7 carrier_closes=7\n');
});

test('retired_source_code_is_terminal_on_direct_carriers', async () => {
  const fixture = await incomingCarrier(true);
  try {
    const lane = incomingLane();
    fixture.incoming.enqueue(lane.readable);
    lane.controller.enqueue(Uint8Array.of(2, ...carrierRecord(Uint8Array.of(42))));
    await fixture.delivery(1);
    lane.controller.error(transportError('stream', 1));
    await fixture.closed;
    expect(fixture.closes()).toBe(1);
  } finally {
    fixture.dispose();
  }
});

test('retired_source_steady_paths_keep_identical_payloads', async () => {
  let records = 0;
  let payloadBytes = 0;
  for (const direct of [false, true]) {
    const fixture = await incomingCarrier(direct);
    try {
      for (const channel of [1, 2, 4]) {
        const lane = incomingLane();
        fixture.incoming.enqueue(lane.readable);
        lane.controller.enqueue(
          direct ? Uint8Array.of(channel) : sourceRecord(1n, channel, 7).subarray(0, 9),
        );
        for (const size of [0, 1, 64, 16384, 65536]) {
          const body = Uint8Array.from({ length: size }, (_, index) => index & 0xff);
          lane.controller.enqueue(carrierRecord(body));
          await fixture.delivery(fixture.deliveries.length + 1);
          expect(fixture.deliveries.at(-1)).toEqual({
            source: direct ? 0n : 1n,
            channel,
            bytes: body,
          });
          records += 1;
          payloadBytes += size;
        }
      }
      const finite = incomingLane();
      fixture.incoming.enqueue(finite.readable);
      const prefix = direct ? Uint8Array.of(0x87) : sourceRecord(1n, 0x87, 7).subarray(0, 9);
      finite.controller.enqueue(prefix);
      finite.controller.enqueue(Uint8Array.of(0, 0, 0, 3, 7, 8, 9));
      finite.controller.close();
      await fixture.finiteEnded;
      expect(fixture.finiteParts).toEqual([
        { kind: 3, bytes: new Uint8Array() },
        { kind: 4, bytes: Uint8Array.of(7, 8, 9) },
        { kind: 5, bytes: new Uint8Array() },
      ]);
      fixture.datagramInput?.enqueue(Uint8Array.of(2, 9, 8, 7));
      expect(await fixture.datagramReceived).toEqual(Uint8Array.of(2, 9, 8, 7));
      expect(fixture.closes()).toBe(0);
    } finally {
      fixture.dispose();
    }
  }
  process.stdout.write(
    `steady records=${records} payload_bytes=${payloadBytes} finite_payload_bytes=6 datagrams=2 datagram_bytes=8 carrier_closes=0\n`,
  );
});

function reader(chunks: Uint8Array[]): CarrierReader {
  return new CarrierReader(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }).getReader(),
  );
}

describe('native carrier framing', () => {
  test('every header split and empty-chunk pattern owns the same body bytes', async () => {
    for (const size of [0, 1, 64, 16_384]) {
      const payload = Uint8Array.from({ length: size }, (_, index) => (index * 19 + 7) & 255);
      const packet = carrierRecord(payload);
      for (let splits = 0; splits < 8; splits++) {
        for (const empty of [false, true]) {
          const chunks = carrierChunks(packet, splits, empty);
          if (empty) chunks.unshift(new Uint8Array(), new Uint8Array());
          if (empty) chunks.push(new Uint8Array(), new Uint8Array());
          const stream = reader(chunks);
          const body = await stream.record();
          expect(body).toEqual(payload);
          packet.fill(0);
          expect(body).toEqual(payload);
          packet.set(carrierRecord(payload));
          expect(await stream.record()).toBeNull();
        }
      }
    }
  });

  test('EOF distinguishes an absent header from every truncated header and body', async () => {
    for (let length = 0; length < 4; length++) {
      const chunks = Array.from({ length }, () => Uint8Array.of(0));
      chunks.push(new Uint8Array());
      if (length === 0) expect(await reader(chunks).record()).toBeNull();
      else await expect(reader(chunks).record()).rejects.toThrow('ended within a record');
    }
    for (let length = 0; length < 4; length++) {
      const packet = carrierRecord(Uint8Array.of(1, 2, 3, 4));
      await expect(reader([packet.subarray(0, 4 + length)]).record()).rejects.toThrow(
        'ended within a record',
      );
    }
  });

  test('unsigned and boundary lengths reject before reading or allocating the body', async () => {
    for (const length of [65, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff]) {
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, length);
      for (let splits = 0; splits < 8; splits++)
        await expect(reader(carrierChunks(header, splits, true)).record(64)).rejects.toThrow(
          'exceeds its bound',
        );
    }
    expect(await reader([carrierRecord(new Uint8Array(64))]).record(64)).toEqual(
      new Uint8Array(64),
    );
  });
  test('split headers and adjacent records retain exact payload boundaries', async () => {
    const first = carrierRecord(Uint8Array.of(1, 2, 3));
    const second = carrierRecord(Uint8Array.of(9));
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first);
    bytes.set(second, first.length);
    const stream = reader([
      bytes.subarray(0, 1),
      new Uint8Array(),
      bytes.subarray(1, 3),
      bytes.subarray(3),
    ]);
    expect(await stream.record()).toEqual(Uint8Array.of(1, 2, 3));
    expect(await stream.record()).toEqual(Uint8Array.of(9));
    expect(await stream.record()).toBeNull();
  });
  test('empty records are records and only clean EOF is completion', async () => {
    const stream = reader([carrierRecord(new Uint8Array())]);
    expect(await stream.record()).toEqual(new Uint8Array());
    expect(await stream.record()).toBeNull();
    await expect(reader([Uint8Array.of(0, 0)]).record()).rejects.toThrow('within a record');
    await expect(reader([Uint8Array.of(0, 0, 0, 2, 9)]).record()).rejects.toThrow(
      'within a record',
    );
  });
  test('declared record budget is checked before reading payload', async () => {
    await expect(reader([Uint8Array.of(0, 1, 0, 1)]).record(64 * 1024)).rejects.toThrow('exceeds');
  });
  test('finite stream parts retain bytes already consumed with the header', async () => {
    const stream = reader([Uint8Array.of(0, 0, 0, 3, 8, 7), Uint8Array.of(6)]);
    expect(await stream.exact(4)).toEqual(Uint8Array.of(0, 0, 0, 3));
    expect(await stream.part()).toEqual(Uint8Array.of(8, 7));
    expect(await stream.part()).toEqual(Uint8Array.of(6));
    expect(await stream.part()).toBeNull();
  });
});

test('edge retirement detaches until native readiness and rejected admissions serialize', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  const instances: PendingTransport[] = [];
  let eventsClosed = 0;
  class PendingTransport {
    readonly decision = Promise.withResolvers<void>();
    readonly ready = this.decision.promise;
    readonly done = Promise.withResolvers<{ closeCode: number; reason: string }>();
    readonly closed = this.done.promise;
    closeCount = 0;
    constructor(
      _url: string,
      readonly options: WebTransportOptions,
    ) {
      instances.push(this);
    }
    close(): void {
      this.closeCount += 1;
      this.done.resolve({ closeCode: 0, reason: '' });
    }
  }
  Object.defineProperty(globalThis, 'WebTransport', {
    configurable: true,
    value: PendingTransport,
  });
  const events = {
    handshake: () => {},
    splice: async () => {},
    reliable: async () => {},
    datagram: async () => {},
    proof: async () => {},
    finite: async () => {},
    closed: () => {
      eventsClosed += 1;
    },
  };
  const dial = (owner: AbortController) =>
    dialClientCarrier(
      'https://edge.example',
      [],
      new Uint8Array(),
      false,
      false,
      events,
      owner.signal,
    );
  try {
    const firstOwner = new AbortController();
    const first = dial(firstOwner);
    const native = instances[0];
    if (native === undefined) throw new Error('native edge handshake missing');
    expect(native.options.allowPooling).toBe(false);
    firstOwner.abort();
    await expect(first).rejects.toThrow('retired');
    expect(native.closeCount).toBe(0);
    native.decision.reject(new Error('native rejection'));
    await expect(native.ready).rejects.toThrow('native rejection');
    await Promise.resolve();
    expect(native.closeCount).toBe(1);
    const activeOwner = new AbortController();
    const active = dial(activeOwner);
    const waitingOwner = new AbortController();
    const waiting = dial(waitingOwner);
    expect(instances).toHaveLength(2);
    waitingOwner.abort();
    await expect(waiting).rejects.toThrow('retired');
    expect(instances).toHaveLength(2);
    const second = instances[1];
    if (second === undefined) throw new Error('serialized handshake missing');
    activeOwner.abort();
    await expect(active).rejects.toThrow('retired');
    second.decision.resolve();
    await second.ready;
    await Promise.resolve();
    expect(second.closeCount).toBe(1);
    expect(eventsClosed).toBe(3);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
    else Object.defineProperty(globalThis, 'WebTransport', original);
  }
});

test('native datagram capacity and age remain host policy', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  const datagrams = {
    writable: new WritableStream<Uint8Array>(),
    incomingHighWaterMark: 1,
    outgoingHighWaterMark: 99,
    outgoingMaxAge: 0,
  };
  class ReadyTransport {
    readonly ready = Promise.resolve();
    readonly closed = new Promise(() => {});
    readonly datagrams = datagrams;
    createBidirectionalStream(): never {
      throw new Error('fixture ends after queue policy');
    }
    close(): void {}
  }
  Object.defineProperty(globalThis, 'WebTransport', { configurable: true, value: ReadyTransport });
  try {
    await expect(
      dialClientCarrier(
        'https://edge.example',
        [],
        new Uint8Array(),
        false,
        false,
        {
          handshake: () => {},
          splice: async () => {},
          reliable: async () => {},
          datagram: async () => {},
          proof: async () => {},
          finite: async () => {},
          closed: () => {},
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('fixture ends');
    expect(datagrams.incomingHighWaterMark).toBe(DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH);
    expect(datagrams.outgoingHighWaterMark).toBe(2);
    expect(datagrams.outgoingMaxAge).toBe(48);
    expect(Object.hasOwn(datagrams, 'incomingMaxAge')).toBe(false);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
    else Object.defineProperty(globalThis, 'WebTransport', original);
  }
});

test('an idle persistent writer rejection retires its carrier without reopening or aborting writers', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  const streams: WritableStreamDefaultController[] = [];
  const ended = Promise.withResolvers<void>();
  let nativeClose = 0;
  let nativeAbort = 0;
  const receive = () => new ReadableStream<Uint8Array>();
  class DirectTransport {
    readonly ready = Promise.resolve();
    readonly completion = Promise.withResolvers<{ closeCode: number; reason: string }>();
    readonly closed = this.completion.promise;
    readonly incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>();
    readonly datagrams = { writable: new WritableStream<Uint8Array>(), readable: receive() };
    createBidirectionalStream() {
      return Promise.resolve({
        readable: receive(),
        writable: new WritableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
          },
          abort() {
            nativeAbort += 1;
          },
        }),
      });
    }
    close(): void {
      nativeClose += 1;
      this.completion.resolve({ closeCode: 0, reason: '' });
    }
  }
  Object.defineProperty(globalThis, 'WebTransport', { configurable: true, value: DirectTransport });
  try {
    const carrier = await dialClientCarrier(
      'https://direct.example',
      [],
      new Uint8Array(),
      false,
      true,
      {
        handshake: () => {},
        splice: async () => {},
        reliable: async () => {},
        datagram: async () => {},
        proof: async () => {},
        finite: async () => {},
        closed: () => {
          ended.resolve();
        },
      },
      new AbortController().signal,
    );
    expect(streams).toHaveLength(3);
    streams[0]?.error(new Error('persistent CTRL writer reset'));
    await ended.promise;
    carrier.close();
    expect(nativeClose).toBe(1);
    expect(nativeAbort).toBe(0);
    expect(streams).toHaveLength(3);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
    else Object.defineProperty(globalThis, 'WebTransport', original);
  }
});

test('the edge stopping the routing preface stream keeps the carrier open', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  const prefaces: WritableStreamDefaultController[] = [];
  const written: Uint8Array[] = [];
  let nativeClose = 0;
  let eventsClosed = 0;
  class EdgeTransport {
    readonly ready = Promise.resolve();
    readonly closed = new Promise<{ closeCode: number; reason: string }>(() => {});
    readonly incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>();
    readonly datagrams = {
      writable: new WritableStream<Uint8Array>(),
      readable: new ReadableStream<Uint8Array>(),
    };
    createBidirectionalStream() {
      return Promise.resolve({
        readable: new ReadableStream<Uint8Array>(),
        writable: new WritableStream<Uint8Array>({
          start(controller) {
            prefaces.push(controller);
          },
          write(chunk) {
            written.push(chunk);
          },
        }),
      });
    }
    close(): void {
      nativeClose += 1;
    }
  }
  Object.defineProperty(globalThis, 'WebTransport', { configurable: true, value: EdgeTransport });
  try {
    const carrier = await dialClientCarrier(
      'https://edge.example',
      [],
      Uint8Array.of(7, 7),
      false,
      false,
      {
        handshake: () => {},
        splice: async () => {},
        reliable: async () => {},
        datagram: async () => {},
        proof: async () => {},
        finite: async () => {},
        closed: () => {
          eventsClosed += 1;
        },
      },
      new AbortController().signal,
    );
    expect(written).toEqual([Uint8Array.of(7, 7)]);
    // What the edge's STOP_SENDING does to the preface stream's writer.
    prefaces[0]?.error(new Error('Received STOP_SENDING.'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nativeClose).toBe(0);
    expect(eventsClosed).toBe(0);
    carrier.close();
    expect(nativeClose).toBe(1);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
    else Object.defineProperty(globalThis, 'WebTransport', original);
  }
});

test('a promoted candidate outlives its proof bridge', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  const writers: WritableStreamDefaultController[] = [];
  const readers: ReadableStreamDefaultController<Uint8Array>[] = [];
  let nativeClose = 0;
  let eventsClosed = 0;
  class CandidateTransport {
    readonly ready = Promise.resolve();
    readonly closed = new Promise<{ closeCode: number; reason: string }>(() => {});
    readonly incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>();
    readonly datagrams = {
      writable: new WritableStream<Uint8Array>(),
      readable: new ReadableStream<Uint8Array>(),
    };
    createBidirectionalStream() {
      return Promise.resolve({
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            readers.push(controller);
          },
        }),
        writable: new WritableStream<Uint8Array>({
          start(controller) {
            writers.push(controller);
          },
        }),
      });
    }
    close(): void {
      nativeClose += 1;
    }
  }
  Object.defineProperty(globalThis, 'WebTransport', {
    configurable: true,
    value: CandidateTransport,
  });
  try {
    const carrier = await dialClientCarrier(
      'https://edge.example',
      [],
      Uint8Array.of(7),
      true,
      false,
      {
        handshake: () => {},
        splice: async () => {},
        reliable: async () => {},
        datagram: async () => {},
        proof: async () => {},
        finite: async () => {},
        closed: () => {
          eventsClosed += 1;
        },
      },
      new AbortController().signal,
    );
    expect(writers).toHaveLength(2);
    // What promotion does to the proof stream: its inbound half is stopped
    // and its outbound half ends.
    writers[1]?.error(new Error('Received STOP_SENDING.'));
    readers[1]?.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nativeClose).toBe(0);
    expect(eventsClosed).toBe(0);
    carrier.close();
    expect(nativeClose).toBe(1);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
    else Object.defineProperty(globalThis, 'WebTransport', original);
  }
});

test('stream credit settling after retirement cannot send its persistent prefix', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  const creating = Promise.withResolvers<void>();
  let prefixWrites = 0;
  let nativeClose = 0;
  class RetiredTransport {
    readonly ready = Promise.resolve();
    readonly completion = Promise.withResolvers<{ closeCode: number; reason: string }>();
    readonly closed = this.completion.promise;
    readonly opening = Promise.withResolvers<{
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    }>();
    readonly datagrams = { writable: new WritableStream<Uint8Array>() };
    createBidirectionalStream() {
      creating.resolve();
      return this.opening.promise;
    }
    close(): void {
      nativeClose += 1;
      this.opening.resolve({
        readable: new ReadableStream<Uint8Array>(),
        writable: new WritableStream<Uint8Array>({
          write() {
            prefixWrites += 1;
          },
        }),
      });
      this.completion.resolve({ closeCode: 0, reason: '' });
    }
  }
  Object.defineProperty(globalThis, 'WebTransport', {
    configurable: true,
    value: RetiredTransport,
  });
  try {
    const owner = new AbortController();
    const pending = dialClientCarrier(
      'https://direct.example',
      [],
      new Uint8Array(),
      false,
      true,
      {
        handshake: () => {},
        splice: async () => {},
        reliable: async () => {},
        datagram: async () => {},
        proof: async () => {},
        finite: async () => {},
        closed: () => {},
      },
      owner.signal,
    );
    await creating.promise;
    owner.abort();
    await expect(pending).rejects.toThrow('ended');
    expect(prefixWrites).toBe(0);
    expect(nativeClose).toBe(1);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
    else Object.defineProperty(globalThis, 'WebTransport', original);
  }
});

test('native readiness owns the handshake result even when channel binding fails', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  const outcomes: string[] = [];
  class ReadyTransport {
    readonly ready = Promise.resolve();
    readonly closed = new Promise(() => {});
    readonly datagrams = { writable: new WritableStream<Uint8Array>() };
    createBidirectionalStream(): never {
      throw new Error('channel binding refused');
    }
    close(): void {}
  }
  Object.defineProperty(globalThis, 'WebTransport', { configurable: true, value: ReadyTransport });
  try {
    await expect(
      dialClientCarrier(
        'https://203.0.113.1:49152',
        [],
        new Uint8Array(),
        false,
        true,
        {
          handshake: (outcome) => outcomes.push(outcome),
          splice: async () => {},
          reliable: async () => {},
          datagram: async () => {},
          proof: async () => {},
          finite: async () => {},
          closed: () => {},
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('channel binding refused');
    expect(outcomes).toEqual(['ready']);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
    else Object.defineProperty(globalThis, 'WebTransport', original);
  }
});

test('a retired started direct constructor cannot be refunded as unused', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
  const decision = Promise.withResolvers<void>();
  const outcomes: string[] = [];
  let constructed = 0;
  let closed = 0;
  class PendingTransport {
    readonly ready = decision.promise;
    readonly closed = new Promise(() => {});
    constructor() {
      constructed += 1;
    }
    close(): void {
      closed += 1;
    }
  }
  Object.defineProperty(globalThis, 'WebTransport', {
    configurable: true,
    value: PendingTransport,
  });
  const events = {
    handshake: (outcome: 'ready' | 'failed' | 'unused') => {
      outcomes.push(outcome);
    },
    splice: async () => {},
    reliable: async () => {},
    datagram: async () => {},
    proof: async () => {},
    finite: async () => {},
    closed: () => {},
  };
  try {
    const retired = new AbortController();
    retired.abort();
    await expect(
      dialClientCarrier(
        'https://203.0.113.1:49152',
        [],
        new Uint8Array(),
        false,
        true,
        events,
        retired.signal,
      ),
    ).rejects.toThrow('retired');
    expect(constructed).toBe(0);
    expect(outcomes).toEqual(['unused']);
    outcomes.length = 0;
    const owner = new AbortController();
    const dial = dialClientCarrier(
      'https://203.0.113.1:49152',
      [],
      new Uint8Array(),
      false,
      true,
      events,
      owner.signal,
    );
    expect(constructed).toBe(1);
    owner.abort();
    await expect(dial).rejects.toThrow('retired');
    expect(outcomes).toEqual([]);
    expect(closed).toBe(0);
    decision.reject(new Error('native handshake failed after cancellation'));
    await expect(decision.promise).rejects.toThrow('native handshake failed after cancellation');
    await Promise.resolve();
    expect(outcomes).toEqual(['failed']);
    expect(closed).toBe(1);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'WebTransport');
    else Object.defineProperty(globalThis, 'WebTransport', original);
  }
});
