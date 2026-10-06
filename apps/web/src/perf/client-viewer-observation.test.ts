import { expect, test } from 'bun:test';
import { recordClientViewerDiscard, recordClientViewerDisplay } from './client-viewer-observation';
import { decodePerfEvent } from './perf-event-codec';
import { createPerfRingBuffer, createPerfRingReader, createPerfRingWriter } from './perf-ring';
import { createPerfStringResolver, createPerfStringTableBuffer } from './perf-string-table';
import type { TerminalPerfEvent } from './terminal-latency';

function recorded(record: (writer: ReturnType<typeof createPerfRingWriter>) => void) {
  const ring = createPerfRingBuffer(8);
  const resolver = createPerfStringResolver(createPerfStringTableBuffer());
  const events: (TerminalPerfEvent | null)[] = [];

  record(createPerfRingWriter(ring));
  createPerfRingReader(ring).drain((entry) => events.push(decodePerfEvent(entry, resolver)));

  return events;
}

/** Stage 5: generation 4, sequences 2 to 2, one datagram of one row and 97 bytes. */
function discardWords(reason: number): Uint32Array {
  return Uint32Array.of(5, 4, 2, 2, 1, 1, 97, reason, 0, 0, 0, 0, 0, 0);
}

/** Stage 3: the visual snapshot of generation 5 that replaced it. */
const REPLACEMENT = Uint32Array.of(3, 0, 5, 4, 1, 0, 1, 1, 0, 0, 0, 0b11000, 400, 37);

test('a discarded transaction takes the number its commit would have, and its replacement the next', () => {
  let transactions = 8;
  const events = recorded((writer) => {
    transactions = recordClientViewerDiscard(writer, discardWords(0), 100, transactions);
    recordClientViewerDisplay(writer, REPLACEMENT, 101, 100.5, transactions);
  });

  expect(transactions).toBe(9);
  expect(events).toMatchObject([
    {
      kind: 'presentation_transaction_discarded',
      atMs: 100,
      transactionSeq: 9,
      generation: 4,
      firstDisplaySeq: 2,
      lastDisplaySeq: 2,
      reason: 'resync',
    },
    { kind: 'worker_display_applied', generation: 5, presentationTransactionSeq: 10 },
  ]);
});

test('each reason the viewer numbers is named, and one it does not number records nothing', () => {
  for (const [code, reason] of [
    [1, 'epoch-reset'],
    [2, 'teardown'],
  ] as const) {
    expect(
      recorded((writer) => recordClientViewerDiscard(writer, discardWords(code), 1, 0)),
    ).toMatchObject([{ kind: 'presentation_transaction_discarded', transactionSeq: 1, reason }]);
  }

  let transactions = 8;
  const events = recorded((writer) => {
    transactions = recordClientViewerDiscard(writer, discardWords(3), 1, transactions);
  });

  expect(transactions).toBe(8);
  expect(events).toEqual([]);
});
