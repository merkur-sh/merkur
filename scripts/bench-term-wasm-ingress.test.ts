import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  type InitOutput,
  init_regular,
  initSync,
  type Terminal,
} from '../apps/web/src/term-wasm/pkg/term_wasm.js';
import { DISPLAY_SEQUENCE_OFFSET, writeU32BE } from '../packages/shared/src';
import {
  directTerminalIndexForPair,
  INGRESS_BENCHMARK_CASES,
  runIngressTrial,
} from './bench-term-wasm-ingress';
import { ingressFixture, ingressFixtureCodepoint } from './term-wasm-ingress-fixture';

const [wasmBytes, font] = await Promise.all([
  readFile(new URL('../apps/web/src/term-wasm/pkg/term_wasm_bg.wasm', import.meta.url)),
  readFile(new URL('../apps/web/public/fonts/JetBrainsMonoNF-Regular.ttf', import.meta.url)),
]);
const runtime = initSync({ module: wasmBytes });

test('every ingress population fills every declared row and validates in real WASM', () => {
  for (const spec of INGRESS_BENCHMARK_CASES) {
    const terminal = init_regular(1200, 720, font, 14, 1.2, 1);
    try {
      terminal.resize(120, spec.rows);
      const rowStart = spec.rows - spec.dirtyRows;
      let sequence = 1;
      let previousHashes: bigint[] | null = null;
      for (const phase of [0, 1]) {
        const memberOrdinal = 3;
        const frame = ingressFixture(
          120,
          spec.rows,
          spec.dirtyRows,
          phase,
          spec.styled,
          rowStart,
          memberOrdinal,
        );
        writeU32BE(frame, DISPLAY_SEQUENCE_OFFSET, sequence);
        expect(terminal.validate_frame(frame), spec.name).toBe(true);
        expect(terminal.apply_delta_seq(frame, sequence), spec.name).toBe(true);
        const viewport = terminal.viewport_rows().split('\n');
        expect(viewport).toHaveLength(spec.rows);
        for (let rowOffset = 0; rowOffset < spec.dirtyRows; rowOffset += 1) {
          const row = rowStart + rowOffset;
          const expected = Array.from({ length: 120 }, (_, col) =>
            String.fromCharCode(ingressFixtureCodepoint(row, col, phase, memberOrdinal)),
          ).join('');
          expect(viewport[row], `${spec.name} row ${row}`).toBe(expected);
          expect(terminal.display_row_version(row), `${spec.name} row version ${row}`).toBe(
            sequence,
          );
        }
        const hashes = Array.from({ length: spec.rows }, (_, row) => terminal.row_hash(row));
        if (previousHashes !== null && spec.dirtyRows > 0) {
          for (let row = rowStart; row < spec.rows; row += 1) {
            expect(hashes[row], `${spec.name} changed row hash ${row}`).not.toBe(
              previousHashes[row],
            );
          }
        }
        previousHashes = hashes;
        sequence += 1;
      }
    } finally {
      terminal.free();
    }
  }
  expect(() => ingressFixture(120, 256, 256, 0, true)).not.toThrow();
  expect(() => ingressFixture(512, 512, 512, 0, true)).toThrow(
    'fixture exceeds one legitimate wire record',
  );
});

test('cursor-only fixture changes authoritative header state without changing rows', () => {
  const terminal = init_regular(1200, 720, font, 14, 1.2, 1);
  try {
    terminal.resize(120, 36);
    const first = ingressFixture(120, 36, 0, 0, false);
    writeU32BE(first, DISPLAY_SEQUENCE_OFFSET, 1);
    expect(terminal.apply_delta_seq(first, 1)).toBe(true);
    const firstHashes = Array.from({ length: 36 }, (_, row) => terminal.row_hash(row));
    const firstCursor = cursorState(terminal, runtime);
    const firstMode = terminal.mouse_mode();
    const firstReceivedCursor = Array.from(
      new Uint16Array(runtime.memory.buffer, terminal.received_cursor_info_ptr(), 4),
    );

    const second = ingressFixture(120, 36, 0, 1, false);
    writeU32BE(second, DISPLAY_SEQUENCE_OFFSET, 2);
    expect(terminal.apply_delta_seq(second, 2)).toBe(true);
    expect(Array.from({ length: 36 }, (_, row) => terminal.row_hash(row))).toEqual(firstHashes);
    expect(Array.from({ length: 36 }, (_, row) => terminal.display_row_version(row))).toEqual(
      Array.from({ length: 36 }, () => 0),
    );
    // Receipt changes authority immediately, but cannot leak into eligible
    // cursor geometry before the explicit presentation transaction.
    expect(
      Array.from(new Uint16Array(runtime.memory.buffer, terminal.received_cursor_info_ptr(), 4)),
    ).not.toEqual(firstReceivedCursor);
    expect(cursorState(terminal, runtime)).toEqual(firstCursor);
    terminal.commit_presentation_state();
    expect(cursorState(terminal, runtime)).not.toEqual(firstCursor);
    expect(terminal.mouse_mode()).not.toBe(firstMode);
    expect(terminal.last_apply_visually_changed()).toBe(true);
  } finally {
    terminal.free();
  }
});

test('paired FIFO trial shares warmup and measured sequences, swaps instances, and accounts exactly', () => {
  const spec = requiredCase('plain-1-row');
  const result = runIngressTrial(runtime, font, spec, {
    samples: 4,
    warmups: 3,
    depth: 4,
    changed: true,
    geometry: true,
    traffic: 'fifo-distinct',
  });

  expect(result.directSamples).toHaveLength(4);
  expect(result.stagedSamples).toHaveLength(4);
  expect(result.warmupSequenceRange).toEqual({ first: 1, last: 12 });
  expect(result.measuredSequenceRange).toEqual({ first: 13, last: 28 });
  expect(result.pairedSequenceRangeCheckCount).toBe(7);
  expect(result.authorityOracleCheckCount).toBe(7);
  expect(result.measuredSemanticMutationBurstCount).toBe(4);
  expect(result.directTerminalAssignments).toEqual([4, 3]);

  expect(result.warmupAccounting.direct.jsRetainedCopyCount).toBe(12);
  expect(result.warmupAccounting.direct.jsRetainedPoolMissCount).toBe(4);
  expect(result.warmupAccounting.direct.jsRetainedObjectAllocationRequestCount).toBe(8);
  expect(result.warmupAccounting.direct.wasmBoundaryInputCopyCount).toBe(12);
  expect(result.warmupAccounting.direct.wasmBoundaryAllocationRequestCount).toBe(12);
  expect(result.warmupAccounting.staged.wasmBoundaryInputCopyCount).toBe(12);
  expect(result.warmupAccounting.staged.wasmBoundaryViewObjectAllocationRequestCount).toBe(12);
  expect(result.warmupAccounting.staged.wasmStageOwnedCopyCount).toBe(12);

  expect(result.measuredAccounting.direct.jsRetainedCopyCount).toBe(16);
  expect(result.measuredAccounting.direct.jsRetainedCopiedBytes).toBe(result.payloadBytes * 16);
  expect(result.measuredAccounting.direct.jsRetainedPoolMissCount).toBe(0);
  expect(result.measuredAccounting.direct.wasmBoundaryInputCopyCount).toBe(16);
  expect(result.measuredAccounting.direct.wasmBoundaryInputCopiedBytes).toBe(
    result.payloadBytes * 16,
  );
  expect(result.measuredAccounting.direct.wasmBoundaryAllocationRequestCount).toBe(16);
  expect(result.measuredAccounting.direct.wasmBoundaryAllocationRequestedBytes).toBe(
    result.payloadBytes * 16,
  );
  expect(result.measuredAccounting.direct.wasmStageOwnedCopyCount).toBe(0);

  expect(result.measuredAccounting.staged.jsRetainedCopyCount).toBe(0);
  expect(result.measuredAccounting.staged.wasmBoundaryInputCopyCount).toBe(16);
  expect(result.measuredAccounting.staged.wasmBoundaryInputCopiedBytes).toBe(
    result.payloadBytes * 16,
  );
  expect(result.measuredAccounting.staged.wasmBoundaryAllocationRequestCount).toBe(0);
  expect(result.measuredAccounting.staged.wasmBoundaryViewObjectAllocationRequestCount).toBe(16);
  expect(result.measuredAccounting.staged.wasmStageOwnedCopyCount).toBe(16);
  expect(result.measuredAccounting.staged.wasmStageOwnedCopiedBytes).toBe(result.payloadBytes * 16);
});

test('reverse stale/alias traffic is separate and retained pooling is bounded to 64 owners', () => {
  const reverse = runIngressTrial(runtime, font, requiredCase('plain-1-row'), {
    samples: 2,
    warmups: 1,
    depth: 4,
    changed: true,
    geometry: false,
    traffic: 'reverse-stale-alias',
  });
  expect(reverse.pairedSequenceRangeCheckCount).toBe(3);
  expect(reverse.authorityOracleCheckCount).toBe(3);
  expect(reverse.measuredSemanticMutationBurstCount).toBe(2);

  const identical = runIngressTrial(runtime, font, requiredCase('plain-1-row'), {
    samples: 2,
    warmups: 2,
    depth: 64,
    changed: false,
    geometry: false,
    traffic: 'fifo-distinct',
  });
  expect(identical.measuredSemanticMutationBurstCount).toBe(0);
  expect(identical.pairedSequenceRangeCheckCount).toBe(4);

  const capacity = runIngressTrial(runtime, font, requiredCase('cursor-only'), {
    samples: 1,
    warmups: 1,
    depth: 65,
    changed: true,
    geometry: false,
    traffic: 'fifo-distinct',
  });
  expect(capacity.warmupAccounting.direct.jsRetainedPoolMissCount).toBe(65);
  expect(capacity.measuredSemanticMutationBurstCount).toBe(1);
  expect(capacity.measuredAccounting.direct.jsRetainedPoolMissCount).toBe(1);
  expect(capacity.measuredAccounting.direct.jsRetainedBackingAllocationRequestedBytes).toBe(
    capacity.payloadBytes,
  );
  expect(capacity.measuredAccounting.direct.jsRetainedObjectAllocationRequestCount).toBe(2);
});

test('terminal assignment alternates and rejects invalid pair ordinals', () => {
  expect(Array.from({ length: 6 }, (_, index) => directTerminalIndexForPair(index))).toEqual([
    0, 1, 0, 1, 0, 1,
  ]);
  expect(() => directTerminalIndexForPair(-1)).toThrow();
  expect(() => directTerminalIndexForPair(0.5)).toThrow();
});

function requiredCase(name: string) {
  const spec = INGRESS_BENCHMARK_CASES.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`missing ingress benchmark case ${name}`);
  return spec;
}

function cursorState(terminal: Terminal, wasm: InitOutput): number[] {
  const pointer = terminal.cursor_info_ptr() >>> 0;
  const length = terminal.cursor_info_len() >>> 0;
  return Array.from(new Uint16Array(wasm.memory.buffer, pointer, length));
}
