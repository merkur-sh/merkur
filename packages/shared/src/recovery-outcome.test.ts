import { expect, test } from 'bun:test';
import { isRecoveryOutcomeRow } from './recovery-outcome';

const row = {
  kind: 'recovery_outcome',
  at_ms: 1,
  owner_id: 'owner',
  attempt_id: 1,
  carrier_id: 0,
  issuance_id: '',
  merkur_session_id: '',
  recovery_trigger: 'initial',
  recovery_phase: 'issuance_requested',
  recovery_end_reason: 'issuance_failed',
  cancellation_initiator: 'attempt',
  duration_ms: 20,
  capability_remaining_ms: 0,
  retry_index: 0,
  backoff_delay_ms: 0,
  handshake_admission_ms: 0,
  signaling_outcome: 'not_started',
  interactive_outcome: 'not_started',
  bulk_outcome: 'not_started',
};
test('failed startup outcomes need no session binding', () => {
  expect(isRecoveryOutcomeRow(row)).toBe(true);
  expect(isRecoveryOutcomeRow({ ...row, recovery_end_reason: 'guessed' })).toBe(false);
  expect(isRecoveryOutcomeRow({ ...row, duration_ms: -1 })).toBe(false);
  expect(isRecoveryOutcomeRow({ ...row, session_token: 'secret' })).toBe(false);
});
