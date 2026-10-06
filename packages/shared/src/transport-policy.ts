export const BYTES_PER_KIB = 1024;
export const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;

export const TRANSPORT_PROFILE = {
  balanced: 0,
  conservative: 1,
  aggressive: 2,
} as const;

// The RTT/jitter congestion score that once lived here fed only the flush
// interval the daemon no longer paces from; the hint carries receiver facts
// (chunk and snapshot targets, queue depth, refresh period) and nothing else.
export const TRANSPORT_POLICY = {
  adaptiveTickMs: 250,
  minAdaptiveTickSpacingMs: 125,
  /** The RTT the tuner's reward treats as "no latency cost", in ms. */
  rttBaselineMs: 20,
  chunkTargetMinBytes: 4 * BYTES_PER_KIB,
  chunkTargetMaxBytes: 64 * BYTES_PER_KIB,
  displaySnapshotTargetMinBytes: 32 * BYTES_PER_KIB,
  displaySnapshotTargetDefaultBytes: 8 * BYTES_PER_MIB,
  displaySnapshotTargetMaxBytes: 16 * BYTES_PER_MIB,
} as const;
