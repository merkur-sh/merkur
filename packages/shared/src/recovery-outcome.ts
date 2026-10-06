/** Closed vocabulary for one worker-owned recovery attempt, including failed startups. */
export const RECOVERY_PHASES = [
  'issuance_requested',
  'issued',
  'carrier_ready',
  'preface_sent',
  'binding_done',
  'auth_queued',
  'auth_written',
  'session_ready',
  'noise_established',
] as const;
export const RECOVERY_END_REASONS = [
  'authenticated',
  'incumbent_progress',
  'owner_cancelled',
  'worker_failed',
  'issuance_failed',
  'carrier_failed',
  'authorization_rejected',
  'capability_expired',
  'binding_failed',
  'auth_rejected',
  'auth_timeout',
  'session_ready_failed',
  'noise_failed',
  'rebind_refused',
  'counterpart_absent',
  'rebind_failed',
] as const;
export const RECOVERY_CANCEL_INITIATORS = [
  'none',
  'owner',
  'attempt',
  'incumbent',
  'worker',
] as const;
export const RECOVERY_NATIVE_OUTCOMES = [
  'not_started',
  'pending',
  'ready',
  'rejected',
  'closed',
  'cancelled',
] as const;
export type RecoveryPhase = (typeof RECOVERY_PHASES)[number];
export type RecoveryEndReason = (typeof RECOVERY_END_REASONS)[number];
export type RecoveryNativeOutcome = (typeof RECOVERY_NATIVE_OUTCOMES)[number];

export interface RecoveryOutcome {
  readonly ownerId: string;
  readonly attemptId: number;
  readonly carrierId: number;
  readonly issuanceId: string;
  readonly sessionId: string;
  readonly trigger: (typeof RECOVERY_TRIGGERS)[number];
  readonly phase: RecoveryPhase;
  readonly endReason: RecoveryEndReason;
  readonly cancellationInitiator: (typeof RECOVERY_CANCEL_INITIATORS)[number];
  readonly durationMs: number;
  readonly capabilityRemainingMs: number;
  readonly retryIndex: number;
  readonly backoffDelayMs: number;
  readonly handshakeAdmissionMs: number;
  readonly signalingOutcome: RecoveryNativeOutcome;
  readonly interactiveOutcome: RecoveryNativeOutcome;
  readonly bulkOutcome: RecoveryNativeOutcome;
}

export const RECOVERY_TRIGGERS = [
  'initial',
  'edge-closed',
  'edge-egress-budget',
  'connectivity-hint',
  'page-resumed',
  'pong-deadline-lapsed',
  'standby-proved-path',
  'edge-unreachable',
] as const;

/** The perf ingest boundary accepts only the closed recovery row schema. */
export function isRecoveryOutcomeRow(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const numbers = [
    'at_ms',
    'attempt_id',
    'carrier_id',
    'duration_ms',
    'capability_remaining_ms',
    'retry_index',
    'backoff_delay_ms',
    'handshake_admission_ms',
  ];
  const identifiers = ['owner_id', 'issuance_id', 'merkur_session_id'];
  const enums = {
    recovery_trigger: RECOVERY_TRIGGERS,
    recovery_phase: RECOVERY_PHASES,
    recovery_end_reason: RECOVERY_END_REASONS,
    cancellation_initiator: RECOVERY_CANCEL_INITIATORS,
    signaling_outcome: RECOVERY_NATIVE_OUTCOMES,
    interactive_outcome: RECOVERY_NATIVE_OUTCOMES,
    bulk_outcome: RECOVERY_NATIVE_OUTCOMES,
  };
  const allowed = new Set([
    'kind',
    'merkur_version',
    ...numbers,
    ...identifiers,
    ...Object.keys(enums),
  ]);
  return (
    row.kind === 'recovery_outcome' &&
    Object.keys(row).every((key) => allowed.has(key)) &&
    numbers.every(
      (key) => typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0,
    ) &&
    identifiers.every((key) => typeof row[key] === 'string' && row[key].length <= 96) &&
    Object.entries(enums).every(([key, values]) => values.some((member) => member === row[key]))
  );
}

/** Worker progress uses the same closed vocabulary as its final perf row. */
export function isRecoveryOutcome(value: unknown): value is RecoveryOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = value as Record<string, unknown>;
  return isRecoveryOutcomeRow({
    kind: 'recovery_outcome',
    at_ms: 0,
    owner_id: outcome.ownerId,
    attempt_id: outcome.attemptId,
    carrier_id: outcome.carrierId,
    issuance_id: outcome.issuanceId,
    merkur_session_id: outcome.sessionId,
    recovery_trigger: outcome.trigger,
    recovery_phase: outcome.phase,
    recovery_end_reason: outcome.endReason,
    cancellation_initiator: outcome.cancellationInitiator,
    duration_ms: outcome.durationMs,
    capability_remaining_ms: outcome.capabilityRemainingMs,
    retry_index: outcome.retryIndex,
    backoff_delay_ms: outcome.backoffDelayMs,
    handshake_admission_ms: outcome.handshakeAdmissionMs,
    signaling_outcome: outcome.signalingOutcome,
    interactive_outcome: outcome.interactiveOutcome,
    bulk_outcome: outcome.bulkOutcome,
  });
}
