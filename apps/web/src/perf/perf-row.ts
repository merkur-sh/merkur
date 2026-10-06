import { cursorCauseLabel } from './cursor-cause-names';
import type { TerminalPerfEvent } from './terminal-latency';

/**
 * Flattens one profiling event into the row shape ingested by Axiom.
 *
 * # Why a fixed, enumerated schema
 *
 * The dataset has a hard ceiling of 256 fields, and Axiom counts a field the
 * first time it is ever seen — a dataset cannot un-see one. So field names are
 * a closed set declared in `PERF_ROW_FIELD_NAMES` and asserted by test against
 * what this function can actually emit. Deriving a field name from data, even
 * once, would burn slots permanently.
 *
 * Undefined-valued keys are omitted rather than serialised as null: a sparse
 * row is cheaper to ingest and Axiom treats an absent field and a null field
 * the same at query time.
 */
export type PerfRow = Record<string, number | string | boolean>;

/**
 * Every field name this module can emit.
 *
 * The union across all event kinds, plus the envelope. Kept well inside the
 * 256-field ceiling so the daemon-side sub-terms and any future stage still fit.
 */
export const PERF_ROW_FIELD_NAMES = [
  'bulk_outcome',
  'interactive_outcome',
  'signaling_outcome',
  'handshake_admission_ms',
  'backoff_delay_ms',
  'retry_index',
  'capability_remaining_ms',
  'cancellation_initiator',
  'recovery_end_reason',
  'recovery_phase',
  'recovery_trigger',
  'issuance_id',
  'carrier_id',
  'owner_id',
  // Envelope, present on every row.
  'kind',
  'at_ms',
  // Stamped onto EVERY row by the telemetry worker, not set by any event
  // mapping below. It is the id the server and edge spans use, so a profiling
  // row can be joined to a trace directly instead of by reconstructing the
  // session window from `session_start` timestamps in every query.
  'merkur_session_id',
  // Also stamped onto every row by the telemetry worker: the build that emitted
  // it. Without it a release comparison is a join against tag times, which
  // cannot separate the rollout hour from the release — and a rollout is exactly
  // when the two sides disagree. This is the BROWSER's version, which ships with
  // the server and so matches `service.version` on `merkur-server` spans, not
  // the daemon's release line; the daemon reports its version to the server on
  // the control link, never to the browser.
  'merkur_version',
  // Input and prediction.
  'input_seq',
  'input_admitted_at_ms',
  // On `input_ack`: the carrier's path RTT floor when the ack landed, so
  // `(ack.at_ms - sent.at_ms) - network_rtt_ms` isolates what is NOT the
  // network — which is where a daemon-side ack coalescer shows up, and which
  // nothing measured while one existed.
  'network_rtt_ms',
  'byte_length',
  'touch_started_at_ms',
  'repeat',
  'reject_kind',
  'reject_cause',
  // Cursor journal: a backwards step of the drawn cursor, or an authoritative
  // shape/visibility change. `cursor_cause` is the term-wasm `CursorCause`
  // name; `cursor_flags` the `CURSOR_MOTION_FLAG_*` bits.
  'cursor_cause',
  'cursor_from_row',
  'cursor_from_col',
  'cursor_to_row',
  'cursor_to_col',
  'cursor_flags',
  'cursor_ops',
  'cursor_journal_seq',
  'cursor_shape_from',
  'cursor_visible_from',
  'cursor_shape_to',
  'cursor_visible_to',
  // Prediction withdrawal (an exact grid mismatch; there is no other cause).
  'queued_predictions',
  'failed_predictions',
  'discarded_predictions',
  // Transport.
  'transport_state',
  'transport_reason',
  // Carrier recovery: which phase, and the evidence that produced it.
  'carrier_phase',
  'carrier_reason',
  // An edge connection closing: which of the three, how, with what code, and
  // how long it lived (`duration_ms`, a name the dataset already carries).
  'carrier_lane',
  'carrier_close_source',
  'carrier_close_code',
  'duration_ms',
  // On `session_bound`: the network class, where the browser says.
  'browser_network_type',
  'browser_effective_type',
  // Graphics tile job transitions; `byte_length` carries the size at `fin`.
  'graphics_asset_phase',
  'graphics_asset_job_id',
  'graphics_asset_failed',
  // Prediction gate.
  'gate_state',
  'trust_consecutive',
  'trust_ratio',
  'trust_window',
  'mode',
  'suppression_reason',
  // Display.
  'display_seq',
  'generation',
  'frame_id',
  'chunk_index',
  'chunk_count',
  'presentation_id',
  'presentation_member_index',
  'presentation_member_count',
  'row_predecessor_presentation_id',
  'presentation_transaction_seq',
  'presentation_coherent',
  'presentation_end',
  'authoritative_visual_mutation',
  'worker_receipt_to_decode_ms',
  'decode_to_apply_ms',
  'row_count',
  'display_kind',
  'resync_reason',
  'already_pending',
  // Render.
  'render_seq',
  'display_input_seq',
  'prediction_input_seq',
  'queued_display_frames',
  'wanted_at_ms',
  'gate',
  'fence_released_at_ms',
  'fence_released_render_seq',
  'opportunity_entered_at_ms',
  'opportunity_delay_ms',
  'fence_wait_ms',
  'opportunity_wait_ms',
  'refresh_period_ms',
  'refresh_confidence_01',
  'completion_mode',
  'completion_disposition',
  'atlas_uploaded',
  'drained_display',
  'visible_prediction_count',
  'visible_prediction_truncated',
  'poll_count',
  'previous_poll_at_ms',
  // Browser presentation transaction (independent of transport application).
  'transaction_seq',
  'first_display_seq',
  'last_display_seq',
  'first_presentation_id',
  'last_presentation_id',
  'first_apply_to_commit_ms',
  'last_apply_to_commit_ms',
  'deadline_overrun_ms',
  'release_frame_time_ms',
  'release_frame_count',
  'membership_release_disable_bits',
  'datagram_count',
  'queue_high_water',
  'end_seen',
  'authoritative_visual_change',
  'commit_reason',
  'discard_reason',
  'applied_datagram_count',
  'presentation_epoch',
  'presentation_preserved',
  // Bounded display-pump slice.
  'pump_duration_ms',
  'pump_budget_ms',
  'processed_datagram_count',
  'processed_row_count',
  'queue_remaining',
  'ring_bytes_at_start',
  'ring_bytes_at_end',
  'ring_dropped_total',
  // Main-thread browser scheduling evidence.
  'main_frame_gap_ms',
  'long_task_observer_supported',
  'main_long_task_duration_ms',
  // Presentation diagnostics: what held applied state off screen, and whether
  // main took the worker's first-display completion for its current fence.
  'presentation_gates',
  'viewer_frame_age_ms',
  'presentation_state',
  'first_display_accepted',
  // Exact Merkur-owned browser display copy/allocation requests.
  'browser_display_io_stage',
  'browser_display_ingress_route',
  'browser_display_io_admitted',
  'explicit_copy_count',
  'explicit_copied_bytes',
  'explicit_allocation_request_count',
  'explicit_allocation_requested_bytes',
  'explicit_object_allocation_request_count',
  // Explicit profiling-harness presentation window.
  'measurement_id',
  'measurement_phase',
  'measurement_observation_epoch',
  'measurement_session_epoch',
  // Startup.
  'attempt_id',
  'device_id',
  'milestone',
  'elapsed_ms',
  'trace_id',
  // Daemon-interior partition. Microsecond units are kept in the field names so
  // a query cannot silently mix them with the millisecond browser terms.
  'recv_to_pty_us',
  'pty_to_read_us',
  'grid_apply_us',
  'display_coalesce_us',
  'select_capture_us',
  'prepare_queue_us',
  'encode_us',
  'compression_us',
  'completion_queue_us',
  'transport_submit_us',
  'daemon_batch_seq',
  'daemon_observation_epoch',
  'daemon_input_attributed_total',
  'daemon_input_dropped_total',
  'daemon_input_skipped_total',
  'daemon_pending_inputs',
  'daemon_display_attributed_total',
  'daemon_display_dropped_total',
  'daemon_record_count',
  'daemon_total_us',
  // Acknowledgment half of a daemon record, parallel to the partition above.
  'write_completion_us',
  'ack_transmit_us',
  // The daemon owner thread over the record's span, also beside the partition.
  'owner_cpu_us',
  'owner_off_cpu_us',
  'owner_quinn_wait_us',
  'owner_registry_wait_us',
  'flush_lock_wait_us',
  // Cumulative packet-admission refusals at one egress hop, per traffic class,
  // and the edge's residence buckets as one comma-joined value: twelve
  // numeric fields would spend twelve of the dataset's permanent slots.
  'egress_hop',
  'egress_model_epoch',
  'egress_model_bw',
  'egress_model_rtprop_us',
  'egress_model_pacing_rate',
  'egress_model_bulk_cap',
  'egress_model_quantum',
  'egress_model_phase',
  'egress_model_probes_gated',
  'egress_model_probes_aborted',
  'egress_model_interactive_in_probe',
  'egress_model_queue_growth_cuts',
  'egress_model_loss_rounds',
  'egress_model_ce_rounds',
  'egress_model_probe_rtts',

  // The counters' identity: modular within one series, a new series restarts.
  'egress_series',
  'egress_interactive_blocked',
  'egress_interactive_paced',
  'egress_interactive_waited_us',
  'egress_bulk_blocked',
  'egress_bulk_paced',
  'egress_bulk_waited_us',
  'edge_forward_residence',
] as const;

export function perfEventToRow(event: TerminalPerfEvent): PerfRow {
  switch (event.kind) {
    case 'startup_milestone':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        attempt_id: event.attemptId,
        device_id: event.deviceId,
        milestone: event.milestone,
        elapsed_ms: event.elapsedMs,
        // The attempt's trace id, so a profiling row joins directly to the trace its
        // bootstrap spans belong to rather than only to the session window.
        trace_id: event.traceId,
      };
    case 'session_start':
      return { kind: event.kind, at_ms: event.atMs };
    case 'session_bound':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        merkur_session_id: event.merkurSessionId,
        browser_network_type: event.networkType,
        browser_effective_type: event.effectiveType,
      };
    case 'recovery_outcome':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        owner_id: event.ownerId,
        attempt_id: event.attemptId,
        carrier_id: event.carrierId,
        issuance_id: event.issuanceId,
        merkur_session_id: event.sessionId,
        recovery_trigger: event.trigger,
        recovery_phase: event.phase,
        recovery_end_reason: event.endReason,
        cancellation_initiator: event.cancellationInitiator,
        duration_ms: event.durationMs,
        capability_remaining_ms: event.capabilityRemainingMs,
        retry_index: event.retryIndex,
        backoff_delay_ms: event.backoffDelayMs,
        handshake_admission_ms: event.handshakeAdmissionMs,
        signaling_outcome: event.signalingOutcome,
        interactive_outcome: event.interactiveOutcome,
        bulk_outcome: event.bulkOutcome,
      };
    case 'carrier_closed':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        carrier_lane: event.lane,
        carrier_close_source: event.source,
        carrier_close_code: event.closeCode,
        duration_ms: Math.round(event.lifetimeMs),
      };
    case 'input_queued':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        input_admitted_at_ms: event.admittedAtMs,
        input_seq: event.inputSeq,
        byte_length: event.byteLength,
      };
    case 'keyboard_commit':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        touch_started_at_ms: event.touchStartedAtMs,
        input_seq: event.inputSeq,
        repeat: event.repeat,
      };
    case 'input_ack':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        input_seq: event.inputSeq,
        // Omitted, never null: an absent floor must not read as a zero-latency
        // path and silently inflate the residual it is subtracted from.
        ...(event.networkRttMs === null ? {} : { network_rtt_ms: event.networkRttMs }),
      };
    case 'daemon_timing':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        input_seq: event.inputSeq,
        recv_to_pty_us: event.recvToPtyUs,
        pty_to_read_us: event.ptyToReadUs,
        grid_apply_us: event.gridApplyUs,
        display_coalesce_us: event.displayCoalesceUs,
        select_capture_us: event.selectCaptureUs,
        prepare_queue_us: event.prepareQueueUs,
        encode_us: event.encodeUs,
        compression_us: event.compressionUs,
        completion_queue_us: event.completionQueueUs,
        transport_submit_us: event.transportSubmitUs,
        daemon_batch_seq: event.batchSeq,
        daemon_observation_epoch: event.observationEpoch,
        // Omitted when unobserved, never zero: see `input_ack`'s floor.
        ...(event.writeCompletionUs === null
          ? {}
          : { write_completion_us: event.writeCompletionUs }),
        ...(event.ackTransmitUs === null ? {} : { ack_transmit_us: event.ackTransmitUs }),
        owner_cpu_us: event.ownerCpuUs,
        owner_off_cpu_us: event.ownerOffCpuUs,
        owner_quinn_wait_us: event.ownerQuinnWaitUs,
        owner_registry_wait_us: event.ownerRegistryWaitUs,
        flush_lock_wait_us: event.flushLockWaitUs,
        // Precomputed so a query does not have to re-derive the identity the
        // ten terms are supposed to satisfy, and so a partition that fails to
        // sum is visible directly rather than by arithmetic in every query.
        daemon_total_us:
          event.recvToPtyUs +
          event.ptyToReadUs +
          event.gridApplyUs +
          event.displayCoalesceUs +
          event.selectCaptureUs +
          event.prepareQueueUs +
          event.encodeUs +
          event.compressionUs +
          event.completionQueueUs +
          event.transportSubmitUs,
      };
    case 'egress_model':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        daemon_observation_epoch: event.observationEpoch,
        egress_hop: event.hop,
        egress_model_epoch: event.model.epoch,
        egress_model_bw: event.model.bw,
        egress_model_rtprop_us: event.model.rtpropUs,
        egress_model_pacing_rate: event.model.pacingRate,
        egress_model_bulk_cap: event.model.bulkCap,
        egress_model_quantum: event.model.quantum,
        egress_model_phase: event.model.phase,
        egress_model_probes_gated: event.model.probesGated,
        egress_model_probes_aborted: event.model.probesAborted,
        egress_model_interactive_in_probe: event.model.interactiveInProbe,
        egress_model_queue_growth_cuts: event.model.queueGrowthCuts,
        egress_model_loss_rounds: event.model.lossRounds,
        egress_model_ce_rounds: event.model.ceRounds,
        egress_model_probe_rtts: event.model.probeRtts,
      };
    case 'transport_egress':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        daemon_observation_epoch: event.observationEpoch,
        egress_hop: event.hop,
        egress_series: event.series,
        egress_interactive_blocked: event.interactive.blocked,
        egress_interactive_paced: event.interactive.paced,
        egress_interactive_waited_us: event.interactive.waitedUs,
        egress_bulk_blocked: event.bulk.blocked,
        egress_bulk_paced: event.bulk.paced,
        egress_bulk_waited_us: event.bulk.waitedUs,
      };
    case 'edge_forward_residence':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        daemon_observation_epoch: event.observationEpoch,
        egress_series: event.series,
        edge_forward_residence: event.buckets.join(','),
      };
    case 'daemon_timing_status':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        daemon_batch_seq: event.batchSeq,
        daemon_input_attributed_total: event.inputAttributedTotal,
        daemon_input_dropped_total: event.inputDroppedTotal,
        daemon_input_skipped_total: event.inputSkippedTotal,
        daemon_pending_inputs: event.pendingInputs,
        daemon_display_attributed_total: event.displayAttributedTotal,
        daemon_display_dropped_total: event.displayDroppedTotal,
        daemon_observation_epoch: event.observationEpoch,
        daemon_record_count: event.recordCount,
      };
    case 'prediction_rejected':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        input_seq: event.inputSeq,
        reject_kind: event.rejectKind,
        reject_cause: cursorCauseLabel(event.rejectCauseCode),
      };
    case 'cursor_step':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        cursor_cause: cursorCauseLabel(event.causeCode),
        cursor_from_row: event.fromRow,
        cursor_from_col: event.fromCol,
        cursor_to_row: event.toRow,
        cursor_to_col: event.toCol,
        cursor_flags: event.flags,
        cursor_ops: event.ops,
        cursor_journal_seq: event.journalSeq,
        prediction_input_seq: event.predictionInputSeq,
        display_input_seq: event.displayInputSeq,
      };
    case 'cursor_shape':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        cursor_shape_from: event.shapeFrom,
        cursor_visible_from: event.visibleFrom,
        cursor_shape_to: event.shapeTo,
        cursor_visible_to: event.visibleTo,
        cursor_flags: event.flags,
        display_seq: event.displaySeq,
      };
    case 'prediction_suppressed':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        queued_predictions: event.queuedPredictions,
        failed_predictions: event.failedPredictions,
        discarded_predictions: event.discardedPredictions,
      };
    case 'carrier_recovery':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        carrier_phase: event.phase,
        carrier_reason: event.reason,
      };
    case 'graphics_asset':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        graphics_asset_phase: event.phase,
        graphics_asset_job_id: event.jobId,
        // Each value exists only on its own phase, so a query never averages zeros.
        ...(event.phase === 'fin' ? { byte_length: event.bytes } : {}),
        ...(event.phase === 'retired' ? { graphics_asset_failed: event.failed } : {}),
      };
    case 'transport_state':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        transport_state: event.state,
        ...(event.reason === undefined ? {} : { transport_reason: event.reason }),
      };
    case 'prediction_gate':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        gate_state: event.state,
        trust_consecutive: event.trustConsecutive,
        trust_ratio: event.trustRatio,
        trust_window: event.trustWindow,
        mode: event.mode,
        ...(event.suppressionReason === null
          ? {}
          : { suppression_reason: event.suppressionReason }),
      };
    case 'display_received':
    case 'worker_display_queued':
    case 'worker_display_applied':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        display_seq: event.displaySeq,
        generation: event.generation,
        input_seq: event.inputSeq,
        frame_id: event.frameId,
        chunk_index: event.chunkIndex,
        chunk_count: event.chunkCount,
        presentation_id: event.presentationId,
        presentation_member_index: event.presentationMemberIndex,
        presentation_member_count: event.presentationMemberCount,
        row_predecessor_presentation_id: event.rowPredecessorPresentationId,
        presentation_transaction_seq: event.presentationTransactionSeq,
        presentation_coherent: event.presentationCoherent,
        presentation_end: event.presentationEnd,
        ...(event.authoritativeVisualMutation === null
          ? {}
          : { authoritative_visual_mutation: event.authoritativeVisualMutation }),
        ...(event.workerReceiptToDecodeMs === null
          ? {}
          : { worker_receipt_to_decode_ms: event.workerReceiptToDecodeMs }),
        ...(event.decodeToApplyMs === null ? {} : { decode_to_apply_ms: event.decodeToApplyMs }),
        byte_length: event.byteLength,
        row_count: event.rowCount,
        display_kind: event.displayKind,
      };
    case 'display_pump_complete':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        pump_duration_ms: event.durationMs,
        pump_budget_ms: event.budgetMs,
        processed_datagram_count: event.processedDatagramCount,
        processed_row_count: event.processedRowCount,
        queue_high_water: event.queueHighWater,
        queue_remaining: event.queueRemaining,
        ring_bytes_at_start: event.ringBytesAtStart,
        ring_bytes_at_end: event.ringBytesAtEnd,
        ring_dropped_total: event.ringDroppedTotal,
      };
    case 'main_frame_cadence':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        main_frame_gap_ms: event.gapMs,
        long_task_observer_supported: event.longTaskObserverSupported,
      };
    case 'main_long_task':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        main_long_task_duration_ms: event.durationMs,
      };
    case 'presentation_gate':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        presentation_gates: event.gates,
        viewer_frame_age_ms: event.viewerFrameAgeMs,
        presentation_state: `fence ${event.frameFenceToken} grid ${event.gridCols}x${event.gridRows} shown ${event.presentationCols}x${event.presentationRows}`,
      };
    case 'first_display_gate':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        first_display_accepted: event.accepted,
        presentation_state: `fence ${event.frameFenceToken} current ${event.currentFenceToken}`,
      };
    case 'browser_display_io':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        browser_display_io_stage: event.stage,
        ...(event.ingressRoute === null
          ? {}
          : { browser_display_ingress_route: event.ingressRoute }),
        display_seq: event.displaySeq,
        generation: event.generation,
        frame_id: event.frameId,
        chunk_index: event.chunkIndex,
        chunk_count: event.chunkCount,
        byte_length: event.payloadByteLength,
        browser_display_io_admitted: event.admitted,
        explicit_copy_count: event.explicitCopyCount,
        explicit_copied_bytes: event.explicitCopiedBytes,
        explicit_allocation_request_count: event.explicitAllocationRequestCount,
        explicit_allocation_requested_bytes: event.explicitAllocationRequestedBytes,
        explicit_object_allocation_request_count: event.explicitObjectAllocationRequestCount,
      };
    case 'presentation_commit':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        release_frame_time_ms: event.releaseFrameTimeMs,
        release_frame_count: event.releaseFrameCount,
        membership_release_disable_bits: event.membershipReleaseDisableBits,
        transaction_seq: event.transactionSeq,
        render_seq: event.renderSeq,
        generation: event.generation,
        first_display_seq: event.firstDisplaySeq,
        last_display_seq: event.lastDisplaySeq,
        display_input_seq: event.displayInputSeq,
        first_presentation_id: event.firstPresentationId,
        last_presentation_id: event.lastPresentationId,
        first_apply_to_commit_ms: event.firstApplyToCommitMs,
        last_apply_to_commit_ms: event.lastApplyToCommitMs,
        deadline_overrun_ms: event.deadlineOverrunMs,
        refresh_period_ms: event.refreshPeriodMs,
        datagram_count: event.datagramCount,
        row_count: event.rowCount,
        byte_length: event.byteLength,
        queue_high_water: event.queueHighWater,
        presentation_coherent: event.coherent,
        end_seen: event.endSeen,
        authoritative_visual_change: event.authoritativeVisualChange,
        commit_reason: event.reason,
      };
    case 'presentation_transaction_discarded':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        transaction_seq: event.transactionSeq,
        generation: event.generation,
        first_display_seq: event.firstDisplaySeq,
        last_display_seq: event.lastDisplaySeq,
        applied_datagram_count: event.appliedDatagramCount,
        row_count: event.rowCount,
        byte_length: event.byteLength,
        discard_reason: event.reason,
      };
    case 'presentation_epoch_boundary':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        presentation_epoch: event.epoch,
        presentation_preserved: event.preserved,
      };
    case 'presentation_measurement_boundary':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        measurement_id: event.measurementId,
        measurement_phase: event.phase,
      };
    case 'display_ring_measurement_boundary':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        measurement_id: event.measurementId,
        measurement_phase: event.phase,
        measurement_observation_epoch: event.observationEpoch,
        measurement_session_epoch: event.sessionEpoch,
        ring_dropped_total: event.ringDroppedTotal,
      };
    case 'display_resync':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        resync_reason: event.reason,
        generation: event.generation,
        already_pending: event.alreadyPending,
      };
    case 'render_start':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        render_seq: event.renderSeq,
        display_input_seq: event.displayInputSeq,
        prediction_input_seq: event.predictionInputSeq,
        queued_display_frames: event.queuedDisplayFrames,
        wanted_at_ms: event.wantedAtMs,
        gate: event.gate,
        fence_released_at_ms: event.fenceReleasedAtMs,
        fence_released_render_seq: event.fenceReleasedRenderSeq,
        opportunity_entered_at_ms: event.opportunityEnteredAtMs,
        opportunity_delay_ms: event.opportunityDelayMs,
        fence_wait_ms: event.fenceWaitMs,
        opportunity_wait_ms: event.opportunityWaitMs,
        refresh_period_ms: event.refreshPeriodMs,
        refresh_confidence_01: event.refreshConfidence01,
      };
    case 'render_end':
      return {
        kind: event.kind,
        at_ms: event.atMs,
        render_seq: event.renderSeq,
        display_input_seq: event.displayInputSeq,
        prediction_input_seq: event.predictionInputSeq,
        queued_display_frames: event.queuedDisplayFrames,
        // The sequences themselves are a variable-length array, which would be
        // a poor column. The count plus the truncation flag is what any query
        // actually needs, and the join identity is `render_seq`.
        visible_prediction_count: event.visiblePredictionInputSeqs.length,
        visible_prediction_truncated: event.visiblePredictionInputSeqsTruncated,
        completion_mode: event.completionMode,
        atlas_uploaded: event.atlasUploaded,
        drained_display: event.drainedDisplay,
      };
    case 'frame_complete':
      return {
        kind: event.kind,
        completion_disposition: event.completionDisposition,
        at_ms: event.atMs,
        render_seq: event.renderSeq,
        display_input_seq: event.displayInputSeq,
        prediction_input_seq: event.predictionInputSeq,
        queued_display_frames: event.queuedDisplayFrames,
        visible_prediction_count: event.visiblePredictionInputSeqs.length,
        visible_prediction_truncated: event.visiblePredictionInputSeqsTruncated,
        poll_count: event.pollCount,
        previous_poll_at_ms: event.previousPollAtMs,
      };
    default:
      // What is left is the kinds whose entire payload is one input sequence.
      return { kind: event.kind, at_ms: event.atMs, input_seq: event.inputSeq };
  }
}
