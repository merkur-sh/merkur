const DISPLAY_SERIAL_HALF_RANGE = 0x8000_0000;

/**
 * RFC-1982 ordering for Merkur's nonzero wrapping u32 display serials.
 *
 * Display generations, datagram sequences, and sender presentation IDs skip
 * zero. Zero is the browser's reset/no-baseline sentinel, so every valid
 * serial succeeds it and it can never succeed a live serial. Exactly half the
 * sequence space is unordered and therefore fails closed in both directions.
 */
export function displaySerialIsNewer(candidate: number, current: number): boolean {
  const next = candidate >>> 0;
  const baseline = current >>> 0;
  if (next === 0) return false;
  if (baseline === 0) return true;
  const distance = (next - baseline) >>> 0;
  return distance !== 0 && distance < DISPLAY_SERIAL_HALF_RANGE;
}

/** Whether `current` is the same valid serial as `target`, or succeeds it. */
export function displaySerialReached(current: number, target: number): boolean {
  const value = current >>> 0;
  return value !== 0 && (value === target >>> 0 || displaySerialIsNewer(value, target));
}
