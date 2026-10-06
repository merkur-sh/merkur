import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MESSAGE_TYPE_INPUT_ROUTING } from '@merkur/protocol';
import {
  DISPLAY_COLOR_MODE_INDEXED,
  DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET,
  DISPLAY_GENERATION_OFFSET,
  DISPLAY_PATCH_BODY_HEADER_BYTES,
  DISPLAY_PATCH_FLAG_RESET,
  DISPLAY_PROTOCOL_VERSION,
  DISPLAY_ROW_PREFIX_BYTES,
  DISPLAY_ROWS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  DISPLAY_STREAM_HEADER_BYTES,
  MESSAGE_TYPE_DISPLAY_PATCH,
  TERMINAL_MODE_INPUT_REPORTS,
  TERMINAL_MODE_KEY_RELEASES,
  TERMINAL_MODE_MODIFIER_KEYS,
  TERMINAL_MODE_PREDICTION_SAFE,
  TRANSPORT_CHANNEL_ID,
  writeU32BE,
} from '@merkur/shared';
import loadWasm, { init_display_receiver_calibration } from './term-wasm/pkg/term_wasm.js';
import {
  createWasmClientViewerHandleFromInstance,
  preloadWasmTerminalRuntime,
  type WasmClientViewerHandle,
} from './wasm-loader';

const INPUT_MAPPING = { epoch: 1, localMinusWire: 0, wireMin: 1, wireMax: 0xffff_ffff };
const COLS = 8;
const ROWS = 2;
const GENERATION = 1;
const REPORTS = TERMINAL_MODE_KEY_RELEASES | TERMINAL_MODE_MODIFIER_KEYS;
const PAUSED = TERMINAL_MODE_PREDICTION_SAFE | REPORTS;
const workerSource = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('./terminal-worker-client.ts', import.meta.url), 'utf8');

function writeU16BE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = (value >>> 8) & 0xff;
  buffer[offset + 1] = value & 0xff;
}

/** A display frame whose header carries `modeFlags`; a snapshot fills every row. */
function displayFrame(seq: number, modeFlags: number, snapshot: boolean): Uint8Array {
  const rowCells = snapshot ? COLS : 0;
  const rowBytes = DISPLAY_ROW_PREFIX_BYTES + 1 + rowCells * 2;
  const rows = snapshot ? ROWS : 0;
  const bodyBytes = DISPLAY_PATCH_BODY_HEADER_BYTES + rows * rowBytes;
  const frame = new Uint8Array(DISPLAY_STREAM_HEADER_BYTES + bodyBytes);
  frame[0] = MESSAGE_TYPE_DISPLAY_PATCH;
  writeU32BE(frame, DISPLAY_DATAGRAM_HEADER_BODY_LENGTH_OFFSET, bodyBytes);
  writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, seq);
  writeU32BE(frame, DISPLAY_GENERATION_OFFSET, GENERATION);
  frame[DISPLAY_STREAM_HEADER_BYTES] = DISPLAY_PROTOCOL_VERSION;
  frame[DISPLAY_STREAM_HEADER_BYTES + 1] = snapshot ? DISPLAY_PATCH_FLAG_RESET : 0;
  writeU16BE(frame, DISPLAY_STREAM_HEADER_BYTES + 2, COLS);
  writeU16BE(frame, DISPLAY_STREAM_HEADER_BYTES + 4, ROWS);
  frame[DISPLAY_STREAM_HEADER_BYTES + 10] = 0x10;
  writeU16BE(frame, DISPLAY_STREAM_HEADER_BYTES + 11, modeFlags);
  writeU16BE(frame, DISPLAY_STREAM_HEADER_BYTES + 23, 1); // chunk_count
  writeU16BE(frame, DISPLAY_STREAM_HEADER_BYTES + 25, rows);
  for (let row = 0; row < rows; row += 1) {
    const at = DISPLAY_ROWS_OFFSET + row * rowBytes;
    writeU16BE(frame, at, row);
    writeU16BE(frame, at + 4, rowCells);
    writeU16BE(frame, at + 6, 1 + rowCells * 2);
    frame[at + DISPLAY_ROW_PREFIX_BYTES] = DISPLAY_COLOR_MODE_INDEXED;
    for (let col = 0; col < rowCells; col += 1) {
      // Default colours, no style, and the cell's code point as one varint.
      frame[at + DISPLAY_ROW_PREFIX_BYTES + 1 + col * 2 + 1] = 0x61 + row;
    }
  }
  return frame;
}

async function createTerminal(committedMode: number): Promise<WasmClientViewerHandle> {
  await preloadWasmTerminalRuntime();
  const runtime = await loadWasm();
  const terminal = createWasmClientViewerHandleFromInstance(
    runtime.memory,
    init_display_receiver_calibration(COLS, ROWS),
  );
  terminal.viewer.fence(0, 1);
  expect(
    terminal.receive(
      0,
      TRANSPORT_CHANNEL_ID.displayCommit,
      displayFrame(1, committedMode, true),
      INPUT_MAPPING,
    ),
  ).toBe(true);
  return terminal;
}

function productionFunctions(names: readonly string[]): string {
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(
    names
      .map((name) => {
        const at = workerSource.indexOf(`function ${name}(`);
        const end = workerSource.indexOf('\n}', at);
        if (at < 0 || end < at) throw new Error(`missing worker ${name}`);
        return workerSource.slice(at, end + 2);
      })
      .join('\n'),
  );
}

/** Main's answer to `mouse_mode_changed`, verbatim from `terminal-worker-client.ts`. */
function mainRaiseStatement(): string {
  const statement = clientSource.match(
    /const raisedReports = [^\n]+\n\s*mouseMode = evt\.mode;\n\s*if \(raisedReports !== 0\) callbacks\.onInputReportsRaised\(\);/,
  )?.[0];
  if (statement === undefined) throw new Error('main no longer raises reports from the mode word');
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(`{ ${statement} }`);
}

/** The exact CTRL protocol frame, received after Session authenticated/opened it. */
function routingEntry(afterSeq: number, serial: number, word: number): Uint8Array {
  const frame = new Uint8Array(18);
  frame[0] = MESSAGE_TYPE_INPUT_ROUTING;
  frame[3] = 14;
  writeU32BE(frame, 4, GENERATION);
  writeU32BE(frame, 8, afterSeq);
  writeU32BE(frame, 12, serial);
  writeU16BE(frame, 16, word);
  return frame;
}

async function createRoutingHarness(committedMode: number) {
  const terminal = await createTerminal(committedMode);
  const posts: { readonly kind: string; readonly mode: number }[] = [];
  let now = 1;
  const worker = {
    wasmTerminal: terminal,
    renderer: null,
    graphicsOfferSpaceReleased: false,
    graphicsPresentationDirty: false,
    graphicsResidents: new Set(),
    publishViewerLinks() {},
    displayEpoch: { generation: GENERATION },
    abandonInFlightLatencyFrame() {},
    firstDisplayGpuFence: { resetEpoch() {}, awaitingFirstApplied: () => false },
    lastMouseMode: 0,
    observedViewerFrames: 0,
    observedViewerSnapshots: 0,
    observedPresentationRevision: 0,
    observedViewerPresentations: 0,
    resumePresentationPending: false,
    perfEnabled: false,
    performance: { now: () => now },
    self: {
      postMessage: (event: (typeof posts)[number]) => {
        if (event.kind === 'mouse_mode_changed') posts.push(event);
      },
    },
    syncDimensionsFromWasm() {},
    updatePhysDimensions() {},
    offscreenCanvas: { width: 0, height: 0 },
    physW: 0,
    physH: 0,
    displaySurfaceResizePending: false,
    observeViewerPresentation() {},
  };
  runInNewContext(productionFunctions(['observeViewerPresentation']), worker);
  let releases = 0;
  const main = {
    mouseMode: 0,
    TERMINAL_MODE_INPUT_REPORTS,
    evt: { mode: 0 },
    callbacks: {
      onInputReportsRaised() {
        releases++;
      },
    },
  };
  const raise = mainRaiseStatement();
  function project(): number[] {
    runInNewContext('observeViewerPresentation();', worker);
    const modes = posts.map((event) => event.mode);
    for (const evt of posts.splice(0)) {
      main.evt = evt;
      runInNewContext(raise, main);
    }
    return modes;
  }
  project();
  return {
    terminal: { free: () => terminal.viewer.free() },
    main,
    releases: () => releases,
    route(afterSeq: number, serial: number, word: number): readonly number[] {
      expect(
        terminal.receive(
          now++,
          TRANSPORT_CHANNEL_ID.ctrl,
          routingEntry(afterSeq, serial, word),
          INPUT_MAPPING,
        ),
      ).toBe(true);
      return project();
    },
    applyDelta(seq: number, mode: number): void {
      expect(
        terminal.receive(
          now++,
          TRANSPORT_CHANNEL_ID.displayDatagram,
          displayFrame(seq, mode, false),
          INPUT_MAPPING,
        ),
      ).toBe(true);
      project();
    },
    fence(lineage: number): void {
      terminal.viewer.fence(now++, lineage);
      project();
    },
    snapshot(mode: number): void {
      expect(
        terminal.receive(
          now++,
          TRANSPORT_CHANNEL_ID.displayCommit,
          displayFrame(0, mode, true),
          INPUT_MAPPING,
        ),
      ).toBe(true);
      project();
    },
  };
}

test('the routing word releases held input once, and the committed header releases nothing twice', async () => {
  // The last committed header: a granted prompt, no key reports.
  const harness = await createRoutingHarness(TERMINAL_MODE_PREDICTION_SAFE);
  expect(harness.main.mouseMode).toBe(TERMINAL_MODE_PREDICTION_SAFE);
  expect(harness.releases()).toBe(0);

  // `CSI > 11 u` inside a synchronized update paused on an image: the daemon
  // sends the routing word, read after frame 1, and main holds releases no longer.
  expect(harness.route(1, 1, REPORTS)).toEqual([PAUSED]);
  expect(harness.releases()).toBe(1);

  // The header the drain commits carries the same word: no second edge.
  harness.applyDelta(2, PAUSED);
  expect(harness.releases()).toBe(1);
  expect(harness.main.mouseMode).toBe(PAUSED);
  harness.terminal.free();
});

test('a frame sent before the routing word cannot take its routing bits back', async () => {
  const harness = await createRoutingHarness(TERMINAL_MODE_PREDICTION_SAFE);
  // Frame 2 left before the pause and is still in flight when the word, read
  // after it, overtakes it on the control lane.
  harness.route(2, 1, REPORTS);
  expect(harness.main.mouseMode).toBe(PAUSED);
  harness.applyDelta(2, TERMINAL_MODE_PREDICTION_SAFE);
  expect(harness.main.mouseMode).toBe(PAUSED);
  expect(harness.releases()).toBe(1);

  // The committed header, captured after the word, releases it. The rest of
  // the transaction popped the flags again, and that header's word wins.
  harness.applyDelta(3, TERMINAL_MODE_PREDICTION_SAFE);
  expect(harness.main.mouseMode).toBe(TERMINAL_MODE_PREDICTION_SAFE);
  // Released: every later header carries the whole word.
  harness.applyDelta(4, PAUSED);
  expect(harness.main.mouseMode).toBe(PAUSED);
  expect(harness.releases()).toBe(2);
  harness.terminal.free();
});

test('a routing word a later header already applied past is dropped', async () => {
  const harness = await createRoutingHarness(TERMINAL_MODE_PREDICTION_SAFE);
  // The committed header lands first; the word read after frame 1 arrives late.
  harness.applyDelta(2, TERMINAL_MODE_PREDICTION_SAFE);
  expect(harness.route(1, 1, REPORTS)).toEqual([]);
  expect(harness.main.mouseMode).toBe(TERMINAL_MODE_PREDICTION_SAFE);
  expect(harness.releases()).toBe(0);
  // Not held: the next header still owns the whole word.
  harness.applyDelta(3, PAUSED);
  expect(harness.main.mouseMode).toBe(PAUSED);
  harness.terminal.free();
});

test('two words at one position keep their serial order across carriers', async () => {
  const harness = await createRoutingHarness(PAUSED);
  expect(harness.releases()).toBe(1);
  // Two pauses of one transaction, the second switching the reports off. Its
  // word (serial 2) crossed the first on another carrier.
  expect(harness.route(2, 2, 0)).toEqual([TERMINAL_MODE_PREDICTION_SAFE]);
  expect(harness.route(2, 1, REPORTS)).toEqual([]);
  // Nor can the frame both words were read after, landing last.
  harness.applyDelta(2, PAUSED);
  expect(harness.main.mouseMode).toBe(TERMINAL_MODE_PREDICTION_SAFE);
  expect(harness.releases()).toBe(1);
  harness.terminal.free();
});

test('a session fence lets the next session order its own words and frames', async () => {
  const harness = await createRoutingHarness(TERMINAL_MODE_PREDICTION_SAFE);
  harness.route(9, 7, REPORTS);
  harness.fence(2);
  // The next session may be another daemon process, whose serials restart...
  expect(harness.route(9, 1, 0)).toEqual([TERMINAL_MODE_PREDICTION_SAFE]);
  expect(harness.route(9, 2, REPORTS)).toEqual([PAUSED]);
  harness.fence(3);
  // ...and whose sequences need not follow the held word's position, yet
  // whatever it applies first was captured after that word.
  harness.snapshot(TERMINAL_MODE_PREDICTION_SAFE);
  expect(harness.main.mouseMode).toBe(TERMINAL_MODE_PREDICTION_SAFE);
  harness.terminal.free();
});
