/** Two-owner input-ring conservation fixture; publication races use explicit handshakes. */
import { parentPort, workerData } from 'node:worker_threads';
import { createInputRingReader, createInputRingWriter } from './input-ring';

export type InputConservationCommand =
  | { kind: 'write'; sequence: number; length: number; deferred?: boolean }
  | { kind: 'read'; count: number }
  | { kind: 'release'; through: number; race?: SharedArrayBuffer }
  | { kind: 'publish-race'; sequence: number; length: number; race: SharedArrayBuffer }
  | { kind: 'discard' }
  | { kind: 'restart' };

type InputConservationValue =
  | boolean
  | number
  | { ordinal: number; sequence: number; bytes: number[] }[]
  | { loads: number; comparisons: number; subtractions: number };

export type InputConservationReply =
  | { ready: true }
  | {
      result: InputConservationValue;
      bytes: number;
      entries: number;
      written: number;
      consumed: number;
      acknowledged: number;
    };

if (parentPort === null) throw new Error('input conservation fixture requires a worker');
const port = parentPort;
const sab: SharedArrayBuffer = workerData.sab;
const role: 'writer' | 'reader' = workerData.role;
const meta = new Int32Array(sab, 0, 8);
let writer = role === 'writer' ? createInputRingWriter(sab) : null;
let reader = role === 'reader' ? createInputRingReader(sab) : null;

function producer() {
  if (writer === null) throw new Error('conservation command requires the producer');
  return writer;
}

function consumer() {
  if (reader === null) throw new Error('conservation command requires the consumer');
  return reader;
}

function snapshot(result: InputConservationValue) {
  return {
    result,
    bytes: Atomics.load(meta, 5),
    entries: Atomics.load(meta, 6),
    written: Atomics.load(meta, 0),
    consumed: Atomics.load(meta, 7),
    acknowledged: Atomics.load(meta, 1),
  };
}

function raceRelease(through: number, race: SharedArrayBuffer) {
  const signal = new Int32Array(race);
  let armed = true;
  const load = Atomics.load;
  const sub = Atomics.sub;
  const compareExchange = Atomics.compareExchange;
  const operations = { loads: 0, comparisons: 0, subtractions: 0 };
  const rendezvous = () => {
    armed = false;
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    while (Atomics.load(signal, 0) === 1) Atomics.wait(signal, 0, 1);
  };
  try {
    Object.defineProperty(Atomics, 'load', {
      value(array: Int32Array, index: number) {
        const value = load(array, index);
        if (array.buffer === sab && (index === 5 || index === 6)) operations.loads++;
        if (armed && array.buffer === sab && index === 5) rendezvous();
        return value;
      },
    });
    Object.defineProperty(Atomics, 'sub', {
      value(array: Int32Array, index: number, amount: number) {
        if (array.buffer === sab && (index === 5 || index === 6)) operations.subtractions++;
        if (armed && array.buffer === sab && index === 5) rendezvous();
        return sub(array, index, amount);
      },
    });
    Object.defineProperty(Atomics, 'compareExchange', {
      value(array: Int32Array, index: number, expected: number, replacement: number) {
        if (array.buffer === sab && (index === 5 || index === 6)) operations.comparisons++;
        return compareExchange(array, index, expected, replacement);
      },
    });
    consumer().release(through);
    if (armed) throw new Error('release did not debit its published charge');
  } finally {
    Object.defineProperty(Atomics, 'load', { value: load });
    Object.defineProperty(Atomics, 'sub', { value: sub });
    Object.defineProperty(Atomics, 'compareExchange', { value: compareExchange });
  }
  return operations;
}

port.on('message', (command: InputConservationCommand) => {
  let result: InputConservationValue;
  switch (command.kind) {
    case 'write':
      result = producer().write(
        command.sequence,
        new Uint8Array(command.length).fill(command.sequence),
        undefined,
        command.deferred,
      );
      break;
    case 'read': {
      const entries = [];
      for (let index = 0; index < command.count; index++) {
        const input = consumer();
        const ordinal = input.tryReadNext();
        if (ordinal < 0) break;
        const bytes = new Uint8Array(input.payloadLength(ordinal));
        input.copyPayload(ordinal, bytes, 0);
        entries.push({ ordinal, sequence: input.localSeq(ordinal), bytes: Array.from(bytes) });
      }
      result = entries;
      break;
    }
    case 'release':
      if (command.race === undefined) {
        consumer().release(command.through);
        result = consumer().releasedOrdinal();
      } else result = raceRelease(command.through, command.race);
      break;
    case 'discard':
      result = consumer().discardQueuedEntries();
      break;
    case 'restart':
      if (role === 'writer') writer = createInputRingWriter(sab);
      else reader = createInputRingReader(sab);
      result = true;
      break;
    case 'publish-race': {
      const signal = new Int32Array(command.race);
      port.postMessage({ ready: true });
      while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0);
      result = producer().write(
        command.sequence,
        new Uint8Array(command.length).fill(command.sequence),
      );
      Atomics.store(signal, 0, 2);
      Atomics.notify(signal, 0);
      break;
    }
  }
  port.postMessage(snapshot(result));
});
