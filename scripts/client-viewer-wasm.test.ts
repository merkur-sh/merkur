import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { recordClientViewerDisplay } from '../apps/web/src/perf/client-viewer-observation';
import { decodePerfEvent } from '../apps/web/src/perf/perf-event-codec';
import {
  createPerfRingBuffer,
  createPerfRingReader,
  createPerfRingWriter,
} from '../apps/web/src/perf/perf-ring';
import {
  createPerfStringResolver,
  createPerfStringTableBuffer,
} from '../apps/web/src/perf/perf-string-table';
import type { TerminalPerfEvent } from '../apps/web/src/perf/terminal-latency';
import {
  ClientViewer,
  init_display_receiver_calibration,
  initSync,
} from '../apps/web/src/term-wasm/pkg/term_wasm.js';
import {
  DISPLAY_CHUNK_COUNT_OFFSET,
  DISPLAY_CHUNK_INDEX_OFFSET,
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  writeU32BE,
} from '../packages/shared/src';
import { ingressFixture, ingressFixtureCodepoint } from './term-wasm-ingress-fixture';

const runtime = initSync({
  module: readFileSync(new URL('../apps/web/src/term-wasm/pkg/term_wasm_bg.wasm', import.meta.url)),
});

function receive(viewer: ClientViewer, frame: Uint8Array, channel: number, now = 1): void {
  const pointer = viewer.reserve_ingress(frame.byteLength);
  expect(pointer).not.toBe(0);
  new Uint8Array(runtime.memory.buffer, pointer, frame.byteLength).set(frame);
  expect(viewer.receive(now, channel, frame.byteLength)).toBe(true);
}

function output(viewer: ClientViewer, now = 1) {
  const kind = viewer.poll_output(now);
  return {
    kind,
    words: new Uint32Array(runtime.memory.buffer, viewer.output_words_ptr(), 7).slice(),
    bytes: new Uint8Array(
      runtime.memory.buffer,
      viewer.output_bytes_ptr(),
      viewer.output_bytes_len(),
    ).slice(),
  };
}

function rooted(): ClientViewer {
  const viewer = new ClientViewer(init_display_receiver_calibration(3, 2));
  viewer.fence(0, 1);
  while (output(viewer, 0).kind !== 0) {}
  const snapshot = ingressFixture(3, 2, 2, 0, false);
  snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
  receive(viewer, snapshot, 4);
  expect(viewer.present_now(1)).toBe(true);
  return viewer;
}

test('WASM viewer admits a complete snapshot atomically across reusable ingress writes', () => {
  const viewer = new ClientViewer(init_display_receiver_calibration(80, 24));
  try {
    viewer.fence(0, 1);
    expect(output(viewer, 0).kind).toBe(2);
    expect(output(viewer, 0).words[0]).toBe(1); // dictionary readiness
    for (let index = 0; index < 2; index += 1) {
      const chunk = ingressFixture(3, 2, 1, 0, false, index);
      chunk[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
      const header = new DataView(chunk.buffer);
      header.setUint16(DISPLAY_CHUNK_COUNT_OFFSET, 2);
      header.setUint16(DISPLAY_CHUNK_INDEX_OFFSET, index);
      // The shared snapshot header is independent of its row cohort.
      header.setUint16(DISPLAY_STREAM_HEADER_BYTES + 8, 0);
      receive(viewer, chunk, 4, index + 1);
      if (index === 0) {
        expect(viewer.cols()).toBe(80);
        expect(viewer.rows()).toBe(24);
        expect(viewer.present_now(1)).toBe(false);
      }
    }
    expect(viewer.present_now(2)).toBe(true);
    expect([viewer.cols(), viewer.rows()]).toEqual([3, 2]);
    expect(viewer.presentation_viewport_rows()).toBe(
      [0, 1]
        .map((row) =>
          [0, 1, 2]
            .map((col) => String.fromCodePoint(ingressFixtureCodepoint(row, col, 0, 0)))
            .join(''),
        )
        .join('\n'),
    );
    expect(viewer.reserve_ingress(0)).toBe(0);
    expect(viewer.reserve_ingress(0x1000004)).toBe(0);
    expect(viewer.receive(3, 4, 0)).toBe(false);
    expect(viewer.receive(Number.NaN, 4, 1)).toBe(false);
  } finally {
    viewer.free();
  }
});

test('WASM display telemetry follows real chunk decode and complete-frame application', () => {
  const viewer = new ClientViewer(init_display_receiver_calibration(80, 24));
  const observations: { words: number[]; since: number; at: number }[] = [];
  const ring = createPerfRingBuffer(32);
  const writer = createPerfRingWriter(ring);
  const reader = createPerfRingReader(ring);
  const resolver = createPerfStringResolver(createPerfStringTableBuffer());
  let clock = 10;
  viewer.set_display_observer((pointer, since) => {
    const at = ++clock;
    recordClientViewerDisplay(
      writer,
      new Uint32Array(runtime.memory.buffer, pointer, 14),
      at,
      since,
      7,
    );
    observations.push({
      words: Array.from(new Uint32Array(runtime.memory.buffer, pointer, 14)),
      since,
      at,
    });
    return at;
  });
  try {
    viewer.set_tracing(true);
    for (let index = 0; index < 2; index++) {
      const chunk = ingressFixture(3, 2, 1, 0, false, index);
      chunk[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
      const header = new DataView(chunk.buffer);
      header.setUint16(DISPLAY_CHUNK_COUNT_OFFSET, 2);
      header.setUint16(DISPLAY_CHUNK_INDEX_OFFSET, index);
      header.setUint16(DISPLAY_STREAM_HEADER_BYTES + 8, 0);
      receive(viewer, chunk, 4, 10);
      if (index === 0) expect(observations.map((o) => o.words[0])).toEqual([1, 2]);
    }
    expect(observations.map((o) => o.words[0])).toEqual([1, 2, 1, 2, 3]);
    const applied = observations.at(-1);
    expect(applied?.words[6]).toBe(2);
    expect(applied?.words[13]).toBe(2);
    expect(applied?.since).toBe(observations[0]?.at);
    expect((applied?.words[11] ?? 0) & 24).toBe(24);
    const events: (TerminalPerfEvent | null)[] = [];
    reader.drain((record) => events.push(decodePerfEvent(record, resolver)));
    expect(events.map((event) => event?.kind)).toEqual([
      'display_received',
      'worker_display_queued',
      'display_received',
      'worker_display_queued',
      'worker_display_applied',
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: 'worker_display_applied',
      chunkCount: 2,
      rowCount: 2,
      displayKind: 'display_snapshot',
      authoritativeVisualMutation: true,
      presentationTransactionSeq: 8,
      decodeToApplyMs: 4,
    });
    observations.length = 0;
    viewer.set_tracing(false);
    receive(viewer, ingressFixture(3, 2, 1, 1, false), 3, 20);
    expect(observations).toEqual([]);
    // A fresh authentication keeps the host observer but resets tracing.
    viewer.reset_session();
    viewer.set_tracing(true);
    const snapshot = ingressFixture(3, 2, 2, 0, false);
    snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    receive(viewer, snapshot, 4, 30);
    expect(observations.map((o) => o.words[0])).toEqual([1, 2, 3]);
  } finally {
    viewer.free();
  }
});

test('WASM ACK bytes describe applied deltas and a fence claims the retained row hashes', () => {
  const viewer = rooted();
  try {
    const delta = ingressFixture(3, 2, 1, 1, false);
    writeU32BE(delta, DISPLAY_SEQUENCE_OFFSET, 1);
    receive(viewer, delta, 3, 2);
    viewer.present_now(2);
    const ack = output(viewer, 2);
    expect(ack.kind).toBe(1);
    expect(ack.bytes.byteLength).toBe(44);
    const ackWords = new DataView(ack.bytes.buffer);
    expect(ackWords.getUint32(0)).toBe(1);
    expect(ackWords.getUint32(4)).toBe(1);
    expect(ackWords.getUint32(8) & 1).toBe(1);
    while (output(viewer, 2).kind !== 0) {}
    const shown = viewer.presentation_viewport_rows();
    viewer.fence(3, 2);
    const resume = output(viewer, 3);
    expect(resume.kind).toBe(6);
    expect(Array.from(resume.words.subarray(0, 6))).toEqual([1, 1, 2, 3, 2, 1]);
    const hashes = new DataView(resume.bytes.buffer);
    expect(hashes.byteLength).toBe(16);
    for (let row = 0; row < 2; row += 1) {
      expect(hashes.getBigUint64(row * 8)).toBe(viewer.row_hash(row));
    }
    expect(viewer.presentation_viewport_rows()).toBe(shown);
    expect(output(viewer, 3).kind).toBe(4);
  } finally {
    viewer.free();
  }
});

test('WASM viewer ignores an older row sequence and clears control definitions at a fence', () => {
  const viewer = rooted();
  try {
    const newer = ingressFixture(3, 2, 1, 1, false);
    writeU32BE(newer, DISPLAY_SEQUENCE_OFFSET, 8);
    receive(viewer, newer, 3, 2);
    viewer.present_now(2);
    const shown = viewer.presentation_viewport_rows();
    const old = ingressFixture(3, 2, 1, 0, false);
    writeU32BE(old, DISPLAY_SEQUENCE_OFFSET, 7);
    receive(viewer, old, 3, 3);
    viewer.present_now(3);
    expect(viewer.presentation_viewport_rows()).toBe(shown);
    expect(viewer.display_row_version(0)).toBe(8);
    const uri = new TextEncoder().encode('https://example.com/');
    const table = new Uint8Array(4 + 1 + 8 + uri.byteLength);
    table[0] = 0x35;
    const bodyLength = table.byteLength - 4;
    table[1] = bodyLength >>> 16;
    table[2] = bodyLength >>> 8;
    table[3] = bodyLength;
    table[4] = 1;
    writeU32BE(table, 5, 17);
    writeU32BE(table, 9, uri.byteLength);
    table.set(uri, 13);
    receive(viewer, table, 2, 4);
    expect(viewer.link_uri(17)).toBe('https://example.com/');
    viewer.fence(5, 2);
    expect(viewer.link_uri(17)).toBeUndefined();
  } finally {
    viewer.free();
  }
});

test('WASM input borrows and wipes its reusable ingress, including malformed records', () => {
  const viewer = rooted();
  try {
    for (const [record, now] of [
      [new Uint8Array([1, 115, 101, 99, 114, 101, 116]), 2],
      [new Uint8Array([255, 115, 101, 99, 114, 101, 116]), 3],
      [new Uint8Array([1, 115, 101, 99, 114, 101, 116]), Number.NaN],
    ] as const) {
      const pointer = viewer.reserve_ingress(record.byteLength);
      new Uint8Array(runtime.memory.buffer, pointer, record.byteLength).set(record);
      expect(viewer.input(now, 1, record.byteLength)).toBe(false);
      expect(Array.from(new Uint8Array(runtime.memory.buffer, pointer, record.byteLength))).toEqual(
        Array(record.byteLength).fill(0),
      );
    }
    expect(viewer.input(4, 1, 0)).toBe(false);
    expect(viewer.input(4, 1, 0x1000004)).toBe(false);
  } finally {
    viewer.free();
  }
});

test('WASM captured prediction commands fail closed on invalid time, sequence, or kind', () => {
  const viewer = rooted();
  try {
    expect(viewer.prediction_command(Number.NaN, 1, 1, 120, true)).toBe(false);
    expect(viewer.prediction_command(2, 0, 1, 120, true)).toBe(false);
    expect(viewer.prediction_command(2, 1, 255, 120, true)).toBe(false);
    expect(viewer.has_predictions()).toBe(false);
    const shown = viewer.presentation_viewport_rows();
    expect(viewer.prediction_command(2, 1, 1, 120, true)).toBe(false); // no prompt grant
    expect(viewer.presentation_viewport_rows()).toBe(shown);
  } finally {
    viewer.free();
  }
});

test('WASM captured command kinds execute editing and fence a refused cursor move', () => {
  const viewer = new ClientViewer(init_display_receiver_calibration(20, 2));
  try {
    viewer.fence(0, 1);
    while (output(viewer, 0).kind !== 0) {}
    const snapshot = ingressFixture(20, 2, 2, 0, false);
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 20; col += 1) {
        snapshot[DISPLAY_ROWS_OFFSET + row * 49 + 10 + col * 2] = 32;
      }
    }
    new DataView(snapshot.buffer).setUint16(DISPLAY_STREAM_HEADER_BYTES + 8, 0);
    snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    snapshot[DISPLAY_STREAM_HEADER_BYTES + 10] = 0x11;
    new DataView(snapshot.buffer).setUint16(DISPLAY_STREAM_HEADER_BYTES + 11, 1 << 5);
    receive(viewer, snapshot, 4);
    viewer.present_now(1);
    expect(viewer.prediction_command(2, 1, 1, 120, true)).toBe(true);
    expect(viewer.prediction_command(3, 2, 1, 121, false)).toBe(true);
    expect(viewer.prediction_command(4, 3, 4, -1, false)).toBe(true);
    expect(viewer.prediction_command(5, 4, 3, 0, false)).toBe(true);
    expect(viewer.prediction_command(6, 5, 2, 0, false)).toBe(true);
    const model = new Uint32Array(runtime.memory.buffer, viewer.prediction_model_ptr(), 6);
    expect(Array.from(model.subarray(1, 4))).toEqual([0, 0, 0]);
    expect(viewer.prediction_command(7, 6, 4, 1, true)).toBe(false);
    expect(viewer.prediction_command(8, 7, 1, 122, true)).toBe(false);
    expect(viewer.prediction_command(9, 8, 5, 0, false)).toBe(false);
  } finally {
    viewer.free();
  }
});

test('WASM owned resize fences old snapshots and measures only matching authority', () => {
  const viewer = rooted();
  const observations: number[][] = [];
  viewer.set_display_observer((pointer, since) => {
    observations.push(Array.from(new Uint32Array(runtime.memory.buffer, pointer, 14)));
    return since;
  });
  try {
    viewer.set_tracing(true);
    viewer.resize(5, 3);
    const old = ingressFixture(3, 2, 2, 0, false);
    old[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    writeU32BE(old, 10, 2);
    receive(viewer, old, 4, 2);
    expect([viewer.cols(), viewer.rows()]).toEqual([5, 3]);
    expect(observations.filter((words) => words[0] === 4)).toEqual([]);
    const matching = ingressFixture(5, 3, 3, 1, false);
    matching[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
    writeU32BE(matching, 10, 3);
    receive(viewer, matching, 4, 3);
    viewer.frame(16, 16, true, -1);
    expect([viewer.cols(), viewer.rows()]).toEqual([5, 3]);
    const resize = observations.filter((words) => words[0] === 4);
    expect(resize).toHaveLength(1);
    expect(resize[0]?.slice(0, 6)).toEqual([4, 5, 3, 1, 3, 3]);
    while (output(viewer, 3).kind !== 0) {}
    viewer.fence(4, 2);
    const resume = output(viewer, 4);
    expect(resume.kind).toBe(6);
    expect(resume.words[5]).toBe(1);
    expect(resume.bytes.byteLength).toBe(24);
  } finally {
    viewer.free();
  }
});

test('WASM local reflow cannot claim row hashes and yielding restores daemon geometry', () => {
  for (const yieldOwnership of [false, true]) {
    const viewer = rooted();
    try {
      viewer.resize(5, 3);
      if (yieldOwnership) {
        viewer.release_geometry(2);
        while (output(viewer, 2).kind !== 0) {}
        const authoritative = ingressFixture(3, 2, 2, 0, false);
        authoritative[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
        writeU32BE(authoritative, 10, 2);
        receive(viewer, authoritative, 4, 3);
        expect([viewer.cols(), viewer.rows()]).toEqual([3, 2]);
      }
      while (output(viewer, 3).kind !== 0) {}
      viewer.fence(4, 2);
      const resume = output(viewer, 4);
      expect(resume.kind).toBe(6);
      expect(resume.words[5]).toBe(yieldOwnership ? 1 : 0);
      expect(resume.bytes.byteLength).toBe(yieldOwnership ? 16 : 0);
    } finally {
      viewer.free();
    }
  }
});
