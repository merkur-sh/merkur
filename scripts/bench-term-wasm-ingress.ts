/**
 * Component A/B for raw receipt ownership and damage application. This is not
 * browser input-to-photon: Bun/JSC executes the production WASM and geometry,
 * without WebTransport, workers, the compositor, or GPU submission.
 *
 * Both arms receive the same authenticated wire bytes under the same sequence
 * range. The direct arm mirrors the current retained-wire pool followed by the
 * wasm-bindgen slice copy. The staged arm mirrors the production reusable input
 * buffer followed by raw staging into a WASM-owned Vec. Raw staging therefore
 * still adds an ownership copy; this harness is a baseline for a future fused
 * validated raw-stage design, not evidence of a copy reduction.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type InitOutput,
  init_regular,
  initSync,
  type Terminal,
} from '../apps/web/src/term-wasm/pkg/term_wasm.js';
import {
  createRetainedWirePayloadPool,
  type RetainedWirePayload,
} from '../apps/web/src/terminal/retained-wire-payload-pool';
import {
  DISPLAY_PATCH_FLAGS_OFFSET,
  DISPLAY_SEQUENCE_OFFSET,
  writeU32BE,
} from '../packages/shared/src';
import { createGeometryCountReader, type GeometryCounts } from './perf/geometry-counts';
import { summarizeSamples } from './perf/harness';
import { ingressFixture } from './term-wasm-ingress-fixture';

const COLS = 120;
const WARMUP_BURSTS = 100;
const RETAINED_POOL_CAPACITY = 64;

export interface IngressBenchmarkCase {
  readonly name: string;
  readonly rows: number;
  readonly dirtyRows: number;
  readonly styled: boolean;
}

export const INGRESS_BENCHMARK_CASES: readonly IngressBenchmarkCase[] = [
  { name: 'cursor-only', rows: 36, dirtyRows: 0, styled: false },
  { name: 'plain-1-row', rows: 36, dirtyRows: 1, styled: false },
  { name: 'plain-8-rows', rows: 36, dirtyRows: 8, styled: false },
  { name: 'plain-36-rows', rows: 36, dirtyRows: 36, styled: false },
  { name: 'styled-1-row', rows: 36, dirtyRows: 1, styled: true },
  { name: 'styled-8-rows', rows: 36, dirtyRows: 8, styled: true },
  { name: 'styled-36-rows', rows: 36, dirtyRows: 36, styled: true },
  { name: 'plain-256-rows', rows: 256, dirtyRows: 256, styled: false },
  { name: 'styled-64-rows', rows: 256, dirtyRows: 64, styled: true },
] as const;

export type IngressTraffic = 'fifo-distinct' | 'reverse-stale-alias';
type IngressArm = 'direct' | 'staged';

export interface ArmAccounting {
  jsRetainedCopyCount: number;
  jsRetainedCopiedBytes: number;
  jsRetainedBackingAllocationRequestedBytes: number;
  jsRetainedObjectAllocationRequestCount: number;
  jsRetainedPoolMissCount: number;
  wasmBoundaryInputCopyCount: number;
  wasmBoundaryInputCopiedBytes: number;
  wasmBoundaryAllocationRequestCount: number;
  wasmBoundaryAllocationRequestedBytes: number;
  wasmBoundaryViewObjectAllocationRequestCount: number;
  wasmStageOwnedCopyCount: number;
  wasmStageOwnedCopiedBytes: number;
}

export interface AccountingPair {
  readonly direct: ArmAccounting;
  readonly staged: ArmAccounting;
}

export interface SequenceRange {
  readonly first: number;
  readonly last: number;
}

interface SemanticAuthority {
  readonly cols: number;
  readonly rows: number;
  readonly rowHashes: readonly bigint[];
  readonly cursor: readonly number[];
  readonly mouseMode: number;
}

export interface IngressTrialOptions {
  readonly samples: number;
  readonly warmups: number;
  readonly depth: number;
  readonly changed: boolean;
  readonly geometry: boolean;
  readonly traffic: IngressTraffic;
}

export interface IngressTrialResult {
  readonly directSamples: readonly number[];
  readonly stagedSamples: readonly number[];
  readonly warmupAccounting: AccountingPair;
  readonly measuredAccounting: AccountingPair;
  readonly warmupSequenceRange: SequenceRange;
  readonly measuredSequenceRange: SequenceRange;
  readonly pairedSequenceRangeCheckCount: number;
  readonly authorityOracleCheckCount: number;
  readonly measuredSemanticMutationBurstCount: number;
  readonly measuredTerminalReportedVisualBurstCount: number;
  readonly directTerminalAssignments: readonly [number, number];
  readonly checksum: number;
  readonly payloadBytes: number;
}

/** The built geometry's instance counts, folded into the trial checksum. */
function geometryChecksum(geometry: readonly GeometryCounts[], terminalIndex: number): number {
  const counts = geometry[terminalIndex];
  if (counts === undefined) throw new Error('missing paired terminal geometry');
  return counts.glyphs() ^ counts.cursors();
}

/** Alternating assignment removes a persistent terminal-instance arm bias. */
export function directTerminalIndexForPair(pairOrdinal: number): 0 | 1 {
  if (!Number.isSafeInteger(pairOrdinal) || pairOrdinal < 0) {
    throw new RangeError('pair ordinal must be a non-negative integer');
  }
  return pairOrdinal % 2 === 0 ? 0 : 1;
}

export function runIngressTrial(
  runtime: InitOutput,
  font: Uint8Array,
  spec: IngressBenchmarkCase,
  options: IngressTrialOptions,
): IngressTrialResult {
  validateTrialOptions(options);
  const terminals = [
    init_regular(1200, 720, font, 14, 1.2, 1),
    init_regular(1200, 720, font, 14, 1.2, 1),
  ] as const;
  const geometry = [
    createGeometryCountReader(runtime.memory, terminals[0]),
    createGeometryCountReader(runtime.memory, terminals[1]),
  ] as const;
  const directSamples: number[] = [];
  const stagedSamples: number[] = [];
  const warmupAccounting = emptyAccountingPair();
  const measuredAccounting = emptyAccountingPair();
  const directTerminalAssignments: [number, number] = [0, 0];
  const retainedPool = createRetainedWirePayloadPool(RETAINED_POOL_CAPACITY);
  const retainedSlots: Array<RetainedWirePayload | null> = Array.from(
    { length: options.depth },
    () => null,
  );
  const handles = new Uint32Array(options.depth);
  const sequences = new Uint32Array(options.depth);
  const order = new Uint16Array(options.depth);
  const phaseFrames = buildTrafficFrames(spec, options.depth, options.traffic, options.changed);
  const payloadBytes = phaseFrames[0][0]?.byteLength;
  if (payloadBytes === undefined) throw new Error('empty ingress traffic fixture');
  const inputPointers: [number, number] = [0, 0];
  let nextSequence = 1;
  let checksum = 0;
  let pairedSequenceRangeCheckCount = 0;
  let authorityOracleCheckCount = 0;
  let measuredSemanticMutationBurstCount = 0;
  let measuredTerminalReportedVisualBurstCount = 0;

  try {
    for (let terminalIndex = 0; terminalIndex < terminals.length; terminalIndex += 1) {
      const terminal = terminals[terminalIndex];
      if (terminal === undefined) throw new Error('missing terminal');
      terminal.resize(COLS, spec.rows);
      const snapshot = ingressFixture(COLS, spec.rows, Math.min(spec.rows, 36), 0, false);
      snapshot[DISPLAY_PATCH_FLAGS_OFFSET] = 1;
      if (!terminal.apply_state_seq(snapshot, 0)) {
        throw new Error(String(terminal.take_last_error()));
      }
      terminal.commit_presentation_state();
      terminal.build_geometry();
      const pointer = terminal.reserve_display_frame_input(payloadBytes) >>> 0;
      if (pointer === 0) throw new Error(String(terminal.take_last_error()));
      inputPointers[terminalIndex] = pointer;
    }
    let previousSemantic = assertEqualAuthority(terminals[0], terminals[1], runtime, spec.rows);

    const totalPairs = options.warmups + options.samples;
    for (let pairOrdinal = 0; pairOrdinal < totalPairs; pairOrdinal += 1) {
      const measured = pairOrdinal >= options.warmups;
      const accounting = measured ? measuredAccounting : warmupAccounting;
      const phase = options.changed ? pairOrdinal & 1 : 0;
      const frames = phaseFrames[phase];
      if (frames === undefined) throw new Error('missing ingress phase');
      const firstSequence = nextSequence;
      for (let index = 0; index < options.depth; index += 1) {
        sequences[index] = nextSequence;
        nextSequence += 1;
        const frame = frames[index];
        if (frame === undefined) throw new Error('missing ingress member');
        // Frame construction is sender-side work. Stamp the exact paired wire
        // range once before either receiver arm's measured boundary.
        writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, sequences[index] ?? 0);
        order[index] = options.traffic === 'fifo-distinct' ? index : options.depth - index - 1;
      }
      const expectedSequenceRange = { first: firstSequence, last: nextSequence - 1 };
      const directTerminalIndex = directTerminalIndexForPair(pairOrdinal);
      directTerminalAssignments[directTerminalIndex] += 1;
      const armOrder: readonly IngressArm[] =
        pairOrdinal % 2 === 0 ? ['direct', 'staged'] : ['staged', 'direct'];
      let directRange: SequenceRange | null = null;
      let stagedRange: SequenceRange | null = null;
      for (const arm of armOrder) {
        const terminalIndex = arm === 'direct' ? directTerminalIndex : 1 - directTerminalIndex;
        const terminal = terminals[terminalIndex];
        const inputPointer = inputPointers[terminalIndex];
        if (terminal === undefined || inputPointer === undefined) {
          throw new Error('missing paired terminal');
        }
        const startedAt = performance.now();
        if (arm === 'direct') {
          applyDirectBurst(terminal, frames, sequences, order, retainedPool, retainedSlots);
        } else {
          applyStagedBurst(terminal, runtime, inputPointer, frames, sequences, order, handles);
        }
        if (options.geometry) {
          terminal.commit_presentation_state();
          terminal.build_geometry();
        }
        const elapsed = performance.now() - startedAt;
        const observed = sequenceRange(sequences);
        if (arm === 'direct') {
          recordDirectAccounting(frames, retainedSlots, accounting.direct);
        } else {
          recordStagedAccounting(frames, accounting.staged);
        }
        if (measured) {
          (arm === 'direct' ? directSamples : stagedSamples).push(elapsed);
        }
        if (arm === 'direct') directRange = observed;
        else stagedRange = observed;
        checksum = (checksum ^ geometryChecksum(geometry, terminalIndex) ^ observed.last) >>> 0;
      }
      if (
        directRange === null ||
        stagedRange === null ||
        directRange.first !== expectedSequenceRange.first ||
        directRange.last !== expectedSequenceRange.last ||
        stagedRange.first !== expectedSequenceRange.first ||
        stagedRange.last !== expectedSequenceRange.last
      ) {
        throw new Error('paired ingress arms used different sequence ranges');
      }
      pairedSequenceRangeCheckCount += 1;
      const currentSemantic = assertEqualAuthority(terminals[0], terminals[1], runtime, spec.rows);
      authorityOracleCheckCount += 1;
      const semanticMutation = !sameSemanticAuthority(previousSemantic, currentSemantic);
      if (measured) {
        if (semanticMutation !== options.changed) {
          throw new Error(
            `ingress population semantic mutation mismatch: expected=${options.changed} actual=${semanticMutation}`,
          );
        }
        if (semanticMutation) measuredSemanticMutationBurstCount += 1;
        if (terminals[0].last_apply_visually_changed()) {
          measuredTerminalReportedVisualBurstCount += 1;
        }
      }
      previousSemantic = currentSemantic;
    }

    return {
      directSamples,
      stagedSamples,
      warmupAccounting,
      measuredAccounting,
      warmupSequenceRange: {
        first: 1,
        last: options.warmups * options.depth,
      },
      measuredSequenceRange: {
        first: options.warmups * options.depth + 1,
        last: (options.warmups + options.samples) * options.depth,
      },
      pairedSequenceRangeCheckCount,
      authorityOracleCheckCount,
      measuredSemanticMutationBurstCount,
      measuredTerminalReportedVisualBurstCount,
      directTerminalAssignments,
      checksum,
      payloadBytes,
    };
  } finally {
    for (const terminal of terminals) terminal.free();
  }
}

async function main(): Promise<void> {
  const requested = Number(process.env.BENCH_SAMPLES ?? 1000);
  if (!Number.isInteger(requested) || requested < 100) {
    throw new Error('BENCH_SAMPLES must be at least 100');
  }
  const wasmBytes = await readFile(
    new URL('../apps/web/src/term-wasm/pkg/term_wasm_bg.wasm', import.meta.url),
  );
  const font = await readFile(
    new URL('../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf', import.meta.url),
  );
  const runtime = initSync({ module: wasmBytes });
  const wasmSha256 = createHash('sha256').update(wasmBytes).digest('hex');
  for (const spec of INGRESS_BENCHMARK_CASES) {
    for (const changed of [false, true]) {
      for (const depth of spec.dirtyRows <= 1 ? [1, 64, 256] : [1]) {
        const traffics: readonly IngressTraffic[] =
          depth === 1 ? ['fifo-distinct'] : ['fifo-distinct', 'reverse-stale-alias'];
        for (const traffic of traffics) {
          for (const geometry of [false, true]) {
            const samples = depth === 1 ? requested : Math.max(100, Math.ceil(requested / depth));
            const result = runIngressTrial(runtime, font, spec, {
              samples,
              warmups: WARMUP_BURSTS,
              depth,
              changed,
              geometry,
              traffic,
            });
            process.stdout.write(
              `${JSON.stringify({
                schema: 1,
                wasmSha256,
                engine: `Bun ${Bun.version}/JavaScriptCore`,
                cols: COLS,
                ...spec,
                alternatesVisibleContent: changed,
                contentPopulation: changed
                  ? 'alternating-content'
                  : 'identical-visible-state-after-warmup',
                depth,
                traffic,
                geometry,
                payloadBytes: result.payloadBytes,
                samples,
                warmups: WARMUP_BURSTS,
                checksum: result.checksum,
                boundary:
                  'retention-or-stage through all applies/releases and optional CPU geometry; no network, worker, compositor, GPU, or physical photons',
                comparisonClaim:
                  'execution-time and explicit-request baseline only; raw staging still copies into a WASM-owned Vec and is not a copy-reduction result',
                unit: 'ms/burst',
                direct: summarizeSamples(result.directSamples),
                staged: summarizeSamples(result.stagedSamples),
                sequenceAuthority: {
                  warmup: result.warmupSequenceRange,
                  measured: result.measuredSequenceRange,
                  pairedRangeCheckCount: result.pairedSequenceRangeCheckCount,
                  fullAuthorityOracleCheckCount: result.authorityOracleCheckCount,
                  measuredSemanticMutationBurstCount: result.measuredSemanticMutationBurstCount,
                  measuredTerminalReportedVisualBurstCount:
                    result.measuredTerminalReportedVisualBurstCount,
                  terminalVisualFlagBoundary:
                    'last_apply_visually_changed is reported independently from the exact semantic oracle; the pre-candidate WASM conservatively marks any admitted newer row',
                  fields: [
                    'row hashes',
                    'row versions',
                    'dimensions',
                    'cursor visible state',
                    'header-derived mouse mode',
                    'last_apply_visually_changed',
                  ],
                  directTerminalAssignments: result.directTerminalAssignments,
                },
                explicitRequests: {
                  retainedPoolCapacity: RETAINED_POOL_CAPACITY,
                  setupOutsideArmBoundary: {
                    retainedPoolConstructionCount: 1,
                    reusableWasmInputCapacityRequestCount: 2,
                    reusableWasmInputCapacityRequestedBytes: result.payloadBytes * 2,
                  },
                  warmup: result.warmupAccounting,
                  measured: result.measuredAccounting,
                  wasmInternalAllocationRequestCount: null,
                  wasmInternalAllocationRequestedBytes: null,
                  wasmInternalAllocationBoundary:
                    'WASM Vec allocator activity is not exported and is intentionally unclaimed; copy/request fields report only operations directly established by the JS and generated-bindgen call sites',
                },
              })}\n`,
            );
          }
        }
      }
    }
  }
}

function buildTrafficFrames(
  spec: IngressBenchmarkCase,
  depth: number,
  traffic: IngressTraffic,
  changed: boolean,
): readonly [readonly Uint8Array[], readonly Uint8Array[]] {
  const phases: [Uint8Array[], Uint8Array[]] = [[], []];
  const disjointCohorts =
    spec.dirtyRows === 0 ? 1 : Math.max(1, Math.floor(spec.rows / spec.dirtyRows));
  for (const phase of [0, 1] as const) {
    for (let member = 0; member < depth; member += 1) {
      const rowStart =
        traffic === 'fifo-distinct' && spec.dirtyRows > 0
          ? (member % disjointCohorts) * spec.dirtyRows
          : 0;
      phases[phase].push(
        ingressFixture(
          COLS,
          spec.rows,
          spec.dirtyRows,
          phase,
          spec.styled,
          rowStart,
          changed ? member : 0,
          !changed,
        ),
      );
    }
  }
  return phases;
}

function applyDirectBurst(
  terminal: Terminal,
  frames: readonly Uint8Array[],
  sequences: Uint32Array,
  order: Uint16Array,
  retainedPool: ReturnType<typeof createRetainedWirePayloadPool>,
  retainedSlots: Array<RetainedWirePayload | null>,
): void {
  let acquired = 0;
  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const sequence = sequences[index];
      if (frame === undefined || sequence === undefined || sequence === 0) {
        throw new Error('missing direct ingress member');
      }
      const retained = retainedPool.acquire(frame);
      retainedSlots[index] = retained;
      acquired += 1;
    }
    for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
      const memberIndex = order[orderIndex];
      if (memberIndex === undefined) throw new Error('missing direct application order');
      const retained = retainedSlots[memberIndex];
      const sequence = sequences[memberIndex];
      if (retained === null || retained === undefined || sequence === undefined) {
        throw new Error('missing retained ingress member');
      }
      if (!terminal.apply_delta_seq(retained.bytes, sequence)) {
        throw new Error(String(terminal.take_last_error()));
      }
    }
  } finally {
    for (let index = 0; index < acquired; index += 1) {
      retainedSlots[index]?.release();
    }
  }
}

function applyStagedBurst(
  terminal: Terminal,
  runtime: InitOutput,
  inputPointer: number,
  frames: readonly Uint8Array[],
  sequences: Uint32Array,
  order: Uint16Array,
  handles: Uint32Array,
): void {
  let staged = 0;
  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const sequence = sequences[index];
      if (frame === undefined || sequence === undefined || sequence === 0) {
        throw new Error('missing staged ingress member');
      }
      // This view object is requested on every production stage; its backing
      // store is the already-reserved WASM memory and therefore allocates none.
      new Uint8Array(runtime.memory.buffer, inputPointer, frame.byteLength).set(frame);
      const handle = terminal.stage_display_frame_input(frame.byteLength) >>> 0;
      if (handle === 0) throw new Error(String(terminal.take_last_error()));
      handles[index] = handle;
      staged += 1;
    }
    for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
      const memberIndex = order[orderIndex];
      if (memberIndex === undefined) throw new Error('missing staged application order');
      const handle = handles[memberIndex];
      const sequence = sequences[memberIndex];
      if (handle === undefined || handle === 0 || sequence === undefined) {
        throw new Error('missing staged handle');
      }
      if (!terminal.apply_staged_delta_seq(handle, sequence)) {
        throw new Error(String(terminal.take_last_error()));
      }
      terminal.release_staged_frame(handle);
      handles[memberIndex] = 0;
      staged -= 1;
    }
  } finally {
    if (staged > 0) {
      for (let index = 0; index < handles.length; index += 1) {
        const handle = handles[index];
        if (handle !== undefined && handle !== 0) {
          terminal.release_staged_frame(handle);
          handles[index] = 0;
        }
      }
    }
  }
}

/** Keep bookkeeping outside the timed receiver boundary. */
function recordDirectAccounting(
  frames: readonly Uint8Array[],
  retainedSlots: Array<RetainedWirePayload | null>,
  accounting: ArmAccounting,
): void {
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const retained = retainedSlots[index];
    if (frame === undefined || retained === null || retained === undefined) {
      throw new Error('missing retained accounting member');
    }
    accounting.jsRetainedCopyCount += 1;
    accounting.jsRetainedCopiedBytes += frame.byteLength;
    accounting.jsRetainedBackingAllocationRequestedBytes += retained.allocationRequestedBytes;
    accounting.jsRetainedObjectAllocationRequestCount += retained.objectAllocationRequestCount;
    if (retained.allocationRequestedBytes > 0) accounting.jsRetainedPoolMissCount += 1;
    // Generated wasm-bindgen calls malloc and copies this complete Uint8Array.
    accounting.wasmBoundaryInputCopyCount += 1;
    accounting.wasmBoundaryInputCopiedBytes += retained.bytes.byteLength;
    accounting.wasmBoundaryAllocationRequestCount += 1;
    accounting.wasmBoundaryAllocationRequestedBytes += retained.bytes.byteLength;
    retainedSlots[index] = null;
  }
}

/** Every fixture is raw: stage owns one exact wire-byte copy per member. */
function recordStagedAccounting(frames: readonly Uint8Array[], accounting: ArmAccounting): void {
  for (const frame of frames) {
    accounting.wasmBoundaryViewObjectAllocationRequestCount += 1;
    accounting.wasmBoundaryInputCopyCount += 1;
    accounting.wasmBoundaryInputCopiedBytes += frame.byteLength;
    accounting.wasmStageOwnedCopyCount += 1;
    accounting.wasmStageOwnedCopiedBytes += frame.byteLength;
  }
}

function sequenceRange(sequences: Uint32Array): SequenceRange {
  const first = sequences[0];
  const last = sequences[sequences.length - 1];
  if (first === undefined || last === undefined || first === 0 || last < first) {
    throw new Error('invalid ingress sequence range');
  }
  return { first, last };
}

function assertEqualAuthority(
  left: Terminal,
  right: Terminal,
  runtime: InitOutput,
  rows: number,
): SemanticAuthority {
  const cols = left.cols();
  const leftRows = left.rows();
  if (cols !== right.cols() || leftRows !== right.rows()) {
    throw new Error('ingress arms diverged in authoritative dimensions');
  }
  const rowHashes: bigint[] = [];
  for (let row = 0; row < rows; row += 1) {
    const rowHash = left.row_hash(row);
    if (rowHash !== right.row_hash(row)) {
      throw new Error(`ingress arms diverged in row hash at row ${row}`);
    }
    rowHashes.push(rowHash);
    if (left.display_row_version(row) !== right.display_row_version(row)) {
      throw new Error(`ingress arms diverged in row version at row ${row}`);
    }
  }
  const mouseMode = left.mouse_mode();
  if (mouseMode !== right.mouse_mode()) {
    throw new Error('ingress arms diverged in header-derived visible mode');
  }
  const leftCursorPointer = left.cursor_info_ptr() >>> 0;
  const leftCursorLength = left.cursor_info_len() >>> 0;
  const rightCursorPointer = right.cursor_info_ptr() >>> 0;
  const rightCursorLength = right.cursor_info_len() >>> 0;
  if (leftCursorLength !== rightCursorLength) {
    throw new Error('ingress arms diverged in cursor visible-state length');
  }
  const memory = new Uint16Array(runtime.memory.buffer);
  const leftOffset = leftCursorPointer / Uint16Array.BYTES_PER_ELEMENT;
  const rightOffset = rightCursorPointer / Uint16Array.BYTES_PER_ELEMENT;
  const cursor: number[] = [];
  for (let index = 0; index < leftCursorLength; index += 1) {
    const word = memory[leftOffset + index];
    if (word !== memory[rightOffset + index]) {
      throw new Error(`ingress arms diverged in cursor visible state at word ${index}`);
    }
    if (word === undefined) throw new Error('cursor visible state left WASM memory');
    cursor.push(word);
  }
  if (left.last_apply_visually_changed() !== right.last_apply_visually_changed()) {
    throw new Error('ingress arms diverged in last_apply_visually_changed');
  }
  return { cols, rows: leftRows, rowHashes, cursor, mouseMode };
}

function sameSemanticAuthority(left: SemanticAuthority, right: SemanticAuthority): boolean {
  if (
    left.cols !== right.cols ||
    left.rows !== right.rows ||
    left.mouseMode !== right.mouseMode ||
    left.rowHashes.length !== right.rowHashes.length ||
    left.cursor.length !== right.cursor.length
  ) {
    return false;
  }
  for (let index = 0; index < left.rowHashes.length; index += 1) {
    if (left.rowHashes[index] !== right.rowHashes[index]) return false;
  }
  for (let index = 0; index < left.cursor.length; index += 1) {
    if (left.cursor[index] !== right.cursor[index]) return false;
  }
  return true;
}

function validateTrialOptions(options: IngressTrialOptions): void {
  if (
    !Number.isSafeInteger(options.samples) ||
    options.samples <= 0 ||
    !Number.isSafeInteger(options.warmups) ||
    options.warmups <= 0 ||
    !Number.isSafeInteger(options.depth) ||
    options.depth <= 0 ||
    options.depth > 256
  ) {
    throw new RangeError('invalid ingress trial options');
  }
}

function emptyAccountingPair(): AccountingPair {
  return { direct: emptyArmAccounting(), staged: emptyArmAccounting() };
}

function emptyArmAccounting(): ArmAccounting {
  return {
    jsRetainedCopyCount: 0,
    jsRetainedCopiedBytes: 0,
    jsRetainedBackingAllocationRequestedBytes: 0,
    jsRetainedObjectAllocationRequestCount: 0,
    jsRetainedPoolMissCount: 0,
    wasmBoundaryInputCopyCount: 0,
    wasmBoundaryInputCopiedBytes: 0,
    wasmBoundaryAllocationRequestCount: 0,
    wasmBoundaryAllocationRequestedBytes: 0,
    wasmBoundaryViewObjectAllocationRequestCount: 0,
    wasmStageOwnedCopyCount: 0,
    wasmStageOwnedCopiedBytes: 0,
  };
}

if (import.meta.main) await main();
