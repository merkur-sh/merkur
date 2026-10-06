import { describe, expect, test } from 'bun:test';
import {
  assertViewerOutputBound,
  createViewerOutputPublisher,
  type ViewerOutputs,
} from './viewer-output-publisher';
import {
  createViewerOutputRingReader,
  createViewerOutputRingWriter,
  VIEWER_OUTPUT_MAX_BYTES,
  VIEWER_OUTPUT_RING_SIZE,
  VIEWER_OUTPUT_WORDS_BYTES,
  type ViewerOutputRingReader,
} from './viewer-output-ring';

interface Output {
  readonly kind: number;
  readonly words: readonly number[];
  readonly bytes: Uint8Array<ArrayBuffer>;
}

const WORDS_POINTER = 64;
const BYTES_POINTER = 256;

/** A viewer whose outputs lie in real linear memory, as the WASM one's do. */
function fakeViewer(memory: WebAssembly.Memory, maxBytes = VIEWER_OUTPUT_MAX_BYTES) {
  const queue: Output[] = [];
  let length = 0;
  let polls = 0;
  const viewer: ViewerOutputs = {
    poll_output(): number {
      polls += 1;
      const next = queue.shift();
      if (next === undefined) return 0;
      const view = new DataView(memory.buffer);
      for (let index = 0; index < 7; index += 1) {
        view.setUint32(WORDS_POINTER + index * 4, next.words[index] ?? 0, true);
      }
      new Uint8Array(memory.buffer).set(next.bytes, BYTES_POINTER);
      length = next.bytes.byteLength;
      return next.kind;
    },
    output_words_ptr: () => WORDS_POINTER,
    output_bytes_ptr: () => BYTES_POINTER,
    output_bytes_len: () => length,
    output_max_bytes: () => maxBytes,
  };
  return { viewer, queue, polls: () => polls };
}

function body(length: number, seed: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, index) => (seed * 31 + index * 7) & 0xff);
}

function read(reader: ViewerOutputRingReader) {
  const length = reader.nextLength();
  if (length < 0) return null;
  const payload = new Uint8Array(length);
  reader.copyPayload(payload, 0);
  const view = new DataView(payload.buffer);
  const entry = {
    kind: reader.kind(),
    lineage: reader.lineage(),
    frameFenceToken: reader.frameFenceToken(),
    words: Array.from({ length: 7 }, (_, index) => view.getUint32(index * 4, true)),
    bytes: payload.slice(VIEWER_OUTPUT_WORDS_BYTES),
  };
  reader.consume();
  return entry;
}

function harness() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const sab = new SharedArrayBuffer(VIEWER_OUTPUT_RING_SIZE);
  const fake = fakeViewer(memory);
  const publisher = createViewerOutputPublisher(createViewerOutputRingWriter(sab), () => 5);
  return { memory, fake, publisher, reader: createViewerOutputRingReader(sab) };
}

describe('viewer output publisher', () => {
  test('publishes each output with its words, its bytes and the stamp it was polled under', () => {
    const { memory, fake, publisher, reader } = harness();
    const ack = body(44, 1);
    fake.queue.push(
      { kind: 1, words: [1], bytes: ack },
      { kind: 2, words: [], bytes: new Uint8Array(0) },
      { kind: 5, words: [0xdead_beef], bytes: new Uint8Array(0) },
    );

    expect(publisher.drain(fake.viewer, memory, 3, 9)).toBe(false);

    expect(read(reader)).toEqual({
      kind: 1,
      lineage: 3,
      frameFenceToken: 9,
      words: [1, 0, 0, 0, 0, 0, 0],
      bytes: ack,
    });
    expect(read(reader)?.kind).toBe(2);
    expect(read(reader)?.words[0]).toBe(0xdead_beef);
    expect(read(reader)).toBeNull();
  });

  test('says when a resume claim carries row hashes', () => {
    const { memory, fake, publisher } = harness();
    fake.queue.push({ kind: 6, words: [1, 2, 3, 80, 24, 0], bytes: new Uint8Array(0) });
    expect(publisher.drain(fake.viewer, memory, 1, 1)).toBe(false);
    // Another kind's word five is not a claim.
    fake.queue.push({ kind: 1, words: [0, 0, 0, 0, 0, 1], bytes: body(44, 2) });
    expect(publisher.drain(fake.viewer, memory, 1, 1)).toBe(false);
    fake.queue.push(
      { kind: 1, words: [0], bytes: body(44, 3) },
      { kind: 6, words: [1, 2, 3, 80, 24, 1], bytes: body(24 * 8, 4) },
    );
    expect(publisher.drain(fake.viewer, memory, 1, 1)).toBe(true);
  });

  test('a full ring holds one output unpolled-past, and the next drain resumes in order', () => {
    const { memory, fake, publisher, reader } = harness();
    const outputs = Array.from({ length: 12 }, (_, index) => ({
      kind: 3,
      words: [index],
      bytes: body(VIEWER_OUTPUT_MAX_BYTES - index, index),
    }));
    fake.queue.push(...outputs);

    publisher.drain(fake.viewer, memory, 4, 4);
    const pollsWhenFull = fake.polls();
    expect(fake.queue.length).toBeGreaterThan(0);
    // Still full: the held output is tried, and the viewer is not polled again.
    publisher.drain(fake.viewer, memory, 4, 4);
    expect(fake.polls()).toBe(pollsWhenFull);

    const seen: number[] = [];
    for (let rounds = 0; rounds < 20 && seen.length < outputs.length; rounds += 1) {
      for (let entry = read(reader); entry !== null; entry = read(reader)) {
        expect(entry.bytes).toEqual(outputs[entry.words[0] ?? -1]?.bytes ?? new Uint8Array(0));
        seen.push(entry.words[0] ?? -1);
      }
      expect(reader.takeRefusal()).toBe(seen.length < outputs.length);
      publisher.drain(fake.viewer, memory, 4, 4);
    }
    expect(seen).toEqual(outputs.map((_, index) => index));
  });

  test('a held output keeps the stamp it was polled under', () => {
    const { memory, fake, publisher, reader } = harness();
    const largest = { kind: 3, words: [0], bytes: body(VIEWER_OUTPUT_MAX_BYTES, 1) };
    fake.queue.push(largest, largest, largest, largest);
    publisher.drain(fake.viewer, memory, 4, 4);
    while (read(reader) !== null) {
      // Free the ring.
    }
    // Drained under a later fence: what was held is still the old fence's.
    publisher.drain(fake.viewer, memory, 4, 5);
    expect(read(reader)?.frameFenceToken).toBe(4);
  });

  test('reset forgets a held output, and the viewer is polled afresh', () => {
    const { memory, fake, publisher, reader } = harness();
    const largest = { kind: 3, words: [7], bytes: body(VIEWER_OUTPUT_MAX_BYTES, 1) };
    fake.queue.push(largest, largest, largest, largest);
    publisher.drain(fake.viewer, memory, 4, 4);
    const queued = fake.queue.length;
    while (read(reader) !== null) {
      // Free the ring.
    }
    fake.queue.length = 0;
    fake.queue.push({ kind: 2, words: [], bytes: new Uint8Array(0) });
    expect(queued).toBeGreaterThan(0);

    publisher.reset();
    publisher.drain(fake.viewer, memory, 5, 5);
    expect(read(reader)).toMatchObject({ kind: 2, lineage: 5 });
    expect(read(reader)).toBeNull();
  });

  test('a held output survives the linear memory growing under it', () => {
    const { memory, fake, publisher, reader } = harness();
    const outputs = Array.from({ length: 6 }, (_, index) => ({
      kind: 3,
      words: [index],
      bytes: body(VIEWER_OUTPUT_MAX_BYTES, index),
    }));
    fake.queue.push(...outputs);
    publisher.drain(fake.viewer, memory, 1, 1);
    const firstHeld = outputs.length - fake.queue.length - 1;
    while (read(reader) !== null) {
      // Free the ring.
    }
    memory.grow(1);
    publisher.drain(fake.viewer, memory, 1, 1);
    const resumed = read(reader);
    expect(resumed?.words[0]).toBe(firstHeld);
    expect(resumed?.bytes).toEqual(outputs[firstHeld]?.bytes ?? new Uint8Array(0));
  });

  test('a viewer bounded differently from the ring is refused before any output', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(() => assertViewerOutputBound(fakeViewer(memory).viewer)).not.toThrow();
    expect(() =>
      assertViewerOutputBound(fakeViewer(memory, VIEWER_OUTPUT_MAX_BYTES * 2).viewer),
    ).toThrow(/bounded/);
  });
});
