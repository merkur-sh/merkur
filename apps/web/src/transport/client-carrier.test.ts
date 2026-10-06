import { describe, expect, test } from 'bun:test';
import { DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH } from '@merkur/shared';
import { CarrierReader, carrierRecord, dialClientCarrier } from './client-carrier';

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
    await native.ready.catch(() => undefined);
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
