/**
 * Decide whether a single-consumer ring reader may have parked while its
 * producer was copying a new entry.
 *
 * `observedReadCursor` is the producer's snapshot before the copy;
 * `currentReadCursor` is reloaded after the new write cursor is published.
 */
export function readerNeedsWakeAfterPublish(
  previousWriteCursor: number,
  observedReadCursor: number,
  currentReadCursor: number,
): boolean {
  return observedReadCursor === previousWriteCursor || currentReadCursor === previousWriteCursor;
}
