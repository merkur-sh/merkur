import type { EgressModelSample, PerfTimingRecord } from '@merkur/protocol';
import { advanceInputSequence, inputSequenceAdvances } from '../transport/input-sequence-domain';
import { BROWSER_DISPLAY_IO_SCOPE, type BrowserDisplayIngressRoute } from './browser-display-io';

export type { BrowserDisplayIngressRoute } from './browser-display-io';

type DisplayPerfKind = 'display_received' | 'worker_display_queued' | 'worker_display_applied';
type RenderPerfKind = 'render_start' | 'render_end' | 'frame_complete';

/**
 * Fixed tolerance for rAF timestamp quantization, callback scheduling jitter,
 * and small drift between the render-time refresh estimator and an observed
 * interval. The raw `gap - period` value is retained without subtracting this;
 * the tolerance affects only the independent exceeded-interval count and its
 * acceptance gate. One millisecond is deliberately tied to the current
 * measurement setup and must be reconsidered before generalizing its gate to
 * 240/480 Hz displays, where it is a much larger fraction of one refresh.
 */
export const MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS = 1;

export type TerminalStartupMilestone =
  | 'device_selected'
  | 'terminal_mount_requested'
  | 'worker_ready'
  | 'terminal_view_presented'
  | 'transport_start'
  | 'transport_connected'
  | 'first_display_applied'
  | 'first_display_visible';

/**
 * Why speculative echo was withheld, as the *binding* constraint.
 *
 * `alternate_screen` and `mouse_reporting` are both gone: no terminal mode
 * withholds prediction on its own any more, because both were proxies for "no
 * line editor at the cursor" that a multiplexer breaks. `prediction_not_safe`
 * is renamed `no_prompt_grant`, which says what is actually absent instead of
 * restating that the gate refused. `unsafe_mode` remains as the slot a future
 * mode-based refusal would report through.
 */
export type PredictionGateSuppressionReason =
  | 'mode_uninitialized'
  | 'no_prompt_grant'
  | 'unsafe_mode'
  | 'unknown_mode';

interface DisplayPerfEvent<TKind extends DisplayPerfKind> {
  readonly kind: TKind;
  readonly atMs: number;
  readonly displaySeq: number;
  readonly generation: number;
  readonly inputSeq: number;
  readonly frameId: number;
  /** Zero-based wire chunk index; snapshots may span the persistent reliable lane. */
  readonly chunkIndex: number;
  /** Wire chunks in this logical frame; applied events aggregate all of them. */
  readonly chunkCount: number;
  /** Presentation-only sender grouping; never an apply/ACK ordering key. */
  readonly presentationId: number;
  /** Zero-based advisory slot within the sender presentation, or 0 with count 0. */
  readonly presentationMemberIndex: number;
  /** Advisory original-member count, bounded to u16 on the wire. */
  readonly presentationMemberCount: number;
  /** Latest carrier-admitted row presentation this global state depends on, or zero. */
  readonly rowPredecessorPresentationId: number;
  /**
   * Exact renderer transaction this applied datagram feeds. Zero on receive
   * and queue events, before browser presentation ownership is known.
   */
  readonly presentationTransactionSeq: number;
  readonly presentationCoherent: boolean;
  /** Advisory only: loss of this marker must not block a commit. */
  readonly presentationEnd: boolean;
  /** This exact independent display transformation was reconstructed by FEC. */
  readonly fecRecovered: boolean;
  /** Unknown until apply; afterwards records whether authoritative pixels changed. */
  readonly authoritativeVisualMutation: boolean | null;
  /** Exact worker callback entry to decoded frame availability; received events only. */
  readonly workerReceiptToDecodeMs: number | null;
  /** Exact decoded frame availability to completed terminal-state apply; applied events only. */
  readonly decodeToApplyMs: number | null;
  readonly byteLength: number;
  readonly rowCount: number;
  readonly displayKind: 'display_snapshot' | 'display_delta';
}

/**
 * `group-end-vsync` means complete membership at a real animation frame, and
 * `deadline-vsync` means the frame-count rule expired. `deadline-timer` is no
 * longer produced — the presentation timer it named is gone — but the decoder
 * keeps reading it so recorded rows and e2e artifacts still parse, and so its
 * disappearance from live telemetry is itself the signal the rule shipped.
 */
export type TerminalPresentationCommitReason =
  | 'urgent'
  | 'group-end-vsync'
  | 'deadline-vsync'
  | 'deadline-timer'
  | 'recovery-release'
  | 'repair-target-satisfied'
  | 'repair-deadline-expired'
  | 'safety-revocation'
  | 'membership-complete'
  | 'closure-complete'
  | 'paced-complete';

export type TerminalPresentationDiscardReason = 'resync' | 'epoch-reset' | 'teardown';

/**
 * One renderer submission produced from one or more independently applied
 * display datagrams. The transaction is presentation-only: sequence and group
 * fields are provenance for analysis, never an application barrier.
 */
interface PresentationCommitPerfEvent {
  readonly kind: 'presentation_commit';
  /** Exact worker rAF timestamp; zero when released outside an animation frame. */
  readonly releaseFrameTimeMs: number;
  /** Actual eligible worker animation frames consumed, independent of callback delay. */
  readonly releaseFrameCount: number;
  /** Release-time membership blockers; bits 0..7 are defined by the coordinator. */
  readonly membershipReleaseDisableBits: number;
  /** Renderer submission completion (`render_end`) time. */
  readonly atMs: number;
  readonly transactionSeq: number;
  readonly renderSeq: number;
  readonly generation: number;
  readonly firstDisplaySeq: number;
  readonly lastDisplaySeq: number;
  /** Cumulative daemon input barrier represented by this submission. */
  readonly displayInputSeq: number;
  /**
   * The newest input these pixels could answer: the echo horizon of the
   * submission's members. The barrier above counts only writes the daemon had
   * confirmed when it captured them, and an echo can be read before its own
   * write is confirmed, so this can be newer than the barrier.
   */
  readonly displayEchoHorizonSeq: number;
  readonly firstPresentationId: number;
  readonly lastPresentationId: number;
  /** First state application to this renderer submission, in milliseconds. */
  readonly firstApplyToCommitMs: number;
  /** Last state application to this renderer submission, in milliseconds. */
  readonly lastApplyToCommitMs: number;
  /** Submission lateness beyond the anchored presentation deadline. */
  readonly deadlineOverrunMs: number;
  readonly refreshPeriodMs: number;
  readonly datagramCount: number;
  readonly rowCount: number;
  readonly byteLength: number;
  readonly queueHighWater: number;
  readonly coherent: boolean;
  readonly endSeen: boolean;
  /** At least one authoritative geometry range changed in this submission. */
  readonly authoritativeVisualChange: boolean;
  readonly reason: TerminalPresentationCommitReason;
}

/**
 * A renderer transaction whose authoritative state applications were
 * intentionally superseded before presentation. This resolves exact
 * transaction membership without pretending that offscreen-only work became
 * visible. It is presentation telemetry only and never an apply barrier.
 */
interface PresentationTransactionDiscardedPerfEvent {
  readonly kind: 'presentation_transaction_discarded';
  readonly atMs: number;
  readonly transactionSeq: number;
  readonly generation: number;
  readonly firstDisplaySeq: number;
  readonly lastDisplaySeq: number;
  readonly appliedDatagramCount: number;
  readonly rowCount: number;
  readonly byteLength: number;
  readonly reason: TerminalPresentationDiscardReason;
}

/**
 * Terminal-worker presentation lineage installed at a session (re)authentication.
 *
 * `preserved` says whether the epoch kept the grid it inherited. A carrier swap
 * answered with repairs preserves it, and its presentation lineage continues
 * across the boundary; a discarding epoch starts a new one, and nothing before
 * it belongs to the current lineage.
 */
interface PresentationEpochBoundaryPerfEvent {
  readonly kind: 'presentation_epoch_boundary';
  readonly atMs: number;
  readonly epoch: number;
  readonly preserved: boolean;
}

export type TerminalPresentationMeasurementPhase = 'start' | 'end';
export type TerminalPresentationMeasurementPurpose =
  | 'coherent-redraw'
  | 'isolated-interactive'
  | 'streaming';

/**
 * Explicit profiling-harness boundary around one redraw workload. Unlike a
 * sender presentation id, this scopes the user-visible operation rather than
 * one daemon flush, so jitter cannot split the coherence measurement into
 * zero-exposure singleton groups. It is telemetry only and never gates apply,
 * acknowledgement, or presentation.
 */
interface PresentationMeasurementBoundaryPerfEvent {
  readonly kind: 'presentation_measurement_boundary';
  readonly atMs: number;
  readonly measurementId: number;
  readonly phase: TerminalPresentationMeasurementPhase;
  readonly purpose: TerminalPresentationMeasurementPurpose;
}

/** Exact worker-owned SAB refusal counter at one logical measurement edge. */
interface DisplayRingMeasurementBoundaryPerfEvent {
  readonly kind: 'display_ring_measurement_boundary';
  readonly atMs: number;
  readonly measurementId: number;
  readonly phase: TerminalPresentationMeasurementPhase;
  readonly observationEpoch: number;
  readonly sessionEpoch: number;
  readonly ringDroppedTotal: number;
}

/** One bounded terminal-worker display-pump slice, including reconciliation. */
interface DisplayPumpCompletePerfEvent {
  readonly kind: 'display_pump_complete';
  readonly atMs: number;
  readonly durationMs: number;
  readonly budgetMs: number;
  readonly processedDatagramCount: number;
  readonly processedRowCount: number;
  /** Encoded deferrals only, not the ordinary SAB ingress queue. */
  readonly queueHighWater: number;
  readonly queueRemaining: number;
  /** Exact occupied SAB bytes at the owner boundaries; not a sampled peak. */
  readonly ringBytesAtStart: number;
  readonly ringBytesAtEnd: number;
  readonly ringDroppedTotal: number;
}

/**
 * One continuous, visible main-thread animation-frame interval. The browser's
 * rAF timestamp is the observation; missed-frame classification is performed
 * later against the exact measurement window and is therefore explicitly an
 * estimate rather than a compositor/scan-out claim.
 */
interface MainFrameCadencePerfEvent {
  readonly kind: 'main_frame_cadence';
  /** Endpoint of the interval. */
  readonly atMs: number;
  readonly gapMs: number;
  /** Whether this browser exposed direct `longtask` observations. */
  readonly longTaskObserverSupported: boolean;
}

/** Browser-attributed main-thread long task, independent of rAF cadence. */
interface MainLongTaskPerfEvent {
  readonly kind: 'main_long_task';
  /** Browser-reported task start. */
  readonly atMs: number;
  readonly durationMs: number;
}

/**
 * A display pump applied rows although nothing was presented since the last
 * pump that applied rows: every gate that stood between applied and shown
 * state at that moment. Diagnostic; nothing reads it back.
 */
interface PresentationGatePerfEvent {
  readonly kind: 'presentation_gate';
  readonly atMs: number;
  /** The core's `presentation_gates()` bits in the low half, the worker's above. */
  readonly gates: number;
  /** Since the worker last offered the core a display frame; -1 when never. */
  readonly viewerFrameAgeMs: number;
  readonly frameFenceToken: number;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly presentationCols: number;
  readonly presentationRows: number;
}

/** Main received the worker's first-display completion and accepted it or not. */
interface FirstDisplayGatePerfEvent {
  readonly kind: 'first_display_gate';
  readonly atMs: number;
  readonly accepted: boolean;
  readonly frameFenceToken: number;
  /** Main's newest session-epoch fence token; zero when it has none. */
  readonly currentFenceToken: number;
}

export type BrowserDisplayIoStage =
  | 'transport_ingress'
  | 'terminal_apply'
  | 'transport_fec_ingress'
  | 'terminal_fec';

/**
 * Exact source-level browser display I/O accounting.
 *
 * The counters include only the instrumented copy calls and allocation
 * requests Merkur explicitly executes at the transport-ring boundary,
 * terminal JS/WASM boundary, and JavaScript FEC path. The report's `scope`
 * names the intentionally unmeasured internal/engine-owned regions; these
 * source counters must never be presented as heap allocation measurements.
 */
interface BrowserDisplayIoPerfEvent {
  readonly kind: 'browser_display_io';
  readonly atMs: number;
  readonly stage: BrowserDisplayIoStage;
  /** Exact inbound provider/lane for transport stages; null after the SAB boundary. */
  readonly ingressRoute: BrowserDisplayIngressRoute | null;
  readonly displaySeq: number;
  readonly generation: number;
  readonly frameId: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly payloadByteLength: number;
  /** False means work was performed before SAB admission failed. */
  readonly admitted: boolean;
  /** True only when this terminal apply was reconstructed from FEC parity. */
  readonly fecRecovered: boolean;
  readonly explicitCopyCount: number;
  readonly explicitCopiedBytes: number;
  readonly explicitAllocationRequestCount: number;
  readonly explicitAllocationRequestedBytes: number;
  readonly explicitObjectAllocationRequestCount: number;
}

/**
 * Which mailbox gate actually delayed a submission, recorded from the
 * `MailboxAction` values the render mailbox returned rather than inferred from
 * timing. `immediate` means the render was submitted on the turn it was wanted.
 */
export type TerminalRenderGate = 'immediate' | 'fence' | 'opportunity' | 'fence-and-opportunity';

/**
 * A gpu-queue completion is GPUQueue.onSubmittedWorkDone for the exact submission.
 * It is GPU readiness, never compositor presentation or physical scanout.
 * None means no GPU completion owner exists and is excluded from GPU statistics.
 */
export type TerminalFrameCompletionModeLabel = 'gpu-queue' | 'none';

/**
 * Why the terminal worker abandoned its display lineage and asked the daemon
 * for a fresh snapshot.
 *
 * Every resync costs a generation bump, and a generation bump resets the
 * daemon's acknowledged baseline, so the whole screen is re-sent from scratch.
 * Production ran at roughly one every two seconds without anything recording
 * which of the fourteen call sites was responsible — the reason existed only as
 * a `postDisplayDiag` string, which never leaves the browser.
 *
 * A closed union, not the diag string. Several of those strings interpolate a
 * WASM error message, and the profiling body's privacy contract is that no
 * free-text field exists for terminal content to escape through even from a
 * modified client. The tag says which branch fired; the diag keeps the detail
 * locally for anyone attached to the worker.
 */
export type TerminalDisplayResyncReason =
  | 'queue_admission'
  | 'frame_parse_failed'
  | 'frame_stage_failed'
  | 'ahead_delta_buffer_overflow'
  | 'stale_generation_recovery'
  | 'pending_frame_metadata'
  | 'pending_frame_bytes'
  | 'pending_frame_rows'
  | 'pending_frame_mismatch'
  | 'pending_frame_evicted'
  | 'pending_assemblies_overflow'
  | 'frame_validation_rejected'
  | 'apply_rejected'
  | 'hash_digest_generation_ahead'
  | 'profiling_harness';

/**
 * Transitions of one graphics tile job. The session reports its own
 * (`merkur_client::session::graphics::GraphicsPhase`); the transport worker
 * adds `consumed` and the `retired` after it when the terminal worker has
 * taken the asset. The first seven are the success path in order; the rest are
 * failures, and a job that meets one retires with its `failed` flag set.
 */
export type GraphicsAssetPhase =
  | 'demanded'
  | 'requested'
  | 'first_byte'
  | 'fin'
  | 'published'
  | 'consumed'
  | 'retired'
  | 'refused'
  | 'unavailable'
  | 'cancelled'
  | 'interrupted'
  | 'resumed';

interface RenderPerfEvent<TKind extends RenderPerfKind> {
  readonly kind: TKind;
  readonly atMs: number;
  /**
   * Monotonic identity of this render, shared by its `render_start`,
   * `render_end` and `frame_complete`. Frames must be joined through this and
   * never by timestamp proximity: `render_start` is emitted for every render
   * while `frame_complete` is emitted only for fenced ones, so a proximity join
   * can pair sub-terms that came from different renders and silently stop
   * summing to the whole. Zero means an event from before this field existed.
   */
  readonly renderSeq: number;
  readonly displayInputSeq: number;
  /**
   * Highest exact local input sequence whose speculative effect is visible in this
   * submitted frame. Zero means no visible prediction effect; this is not a
   * cumulative interval.
   */
  readonly predictionInputSeq: number;
  readonly queuedDisplayFrames: number;
}

interface StartedRenderPerfEvent extends RenderPerfEvent<'render_start'> {
  /**
   * When this render first became wanted, i.e. the first `noteDirty` since the
   * previous submission. Zero when unknown, which separates "waited on a gate"
   * from "was not asked for yet".
   */
  readonly wantedAtMs: number;
  readonly gate: TerminalRenderGate;
  /** When the previous frame's fence released the gate; zero when not fence-gated. */
  readonly fenceReleasedAtMs: number;
  /** Exact completed render that released this gate; zero for non-fence gates. */
  readonly fenceReleasedRenderSeq: number;
  /** When the first cadence `wait-frame` was returned; zero when not opportunity-gated. */
  readonly opportunityEnteredAtMs: number;
  /**
   * Delay requested by the FIRST cadence `wait-frame`. Later calls may report
   * only remaining time. Zero when not opportunity-gated; not a post-submit floor.
   */
  readonly opportunityDelayMs: number;
  /** Sum of disjoint active capacity-wait intervals before this submission. */
  readonly fenceWaitMs: number;
  /** Sum of disjoint active cadence-wait intervals; their ordering is unrestricted. */
  readonly opportunityWaitMs: number;
  /** Effective presentation opportunity period at submission, not the confidence fallback. */
  readonly refreshPeriodMs: number;
  /**
   * Independent estimator confidence at submission. Low confidence never
   * substitutes a hardcoded 60Hz period for the presentation opportunity bound.
   */
  readonly refreshConfidence01: number;
}

interface CompletedRenderPerfEvent<TKind extends 'render_end' | 'frame_complete'>
  extends RenderPerfEvent<TKind> {
  /**
   * Exact accepted inputs that caused a visible speculative effect in this
   * frame, copied after reconciliation. This includes a user-caused visible
   * backspace clear, but never gate-off, expiry, mismatch, or flush cleanup.
   */
  readonly visiblePredictionInputSeqs: readonly number[];
  /** An incomplete set is never used to compute optimistic latency metrics. */
  readonly visiblePredictionInputSeqsTruncated: boolean;
}

interface EndedRenderPerfEvent extends CompletedRenderPerfEvent<'render_end'> {
  readonly completionMode: TerminalFrameCompletionModeLabel;
  /** This frame grew the glyph atlas, so its CPU cost is not steady state. */
  readonly atlasUploaded: boolean;
  /** This frame drained queued display work, so it coalesced more than one update. */
  readonly drainedDisplay: boolean;
}

export type TerminalFrameCompletionDisposition = 'latest-submitted' | 'superseded' | 'invalidated';

interface FrameCompletePerfEvent extends CompletedRenderPerfEvent<'frame_complete'> {
  /** Semantic validity and whether a newer frame existed at readiness observation.
   * All dispositions prove command readiness and retain exact submitted membership;
   * only latest-submitted can supply local prediction-visibility evidence. */
  readonly completionDisposition: TerminalFrameCompletionDisposition;
  /** Reserved diagnostic slot: always zero; WebGPU completion does not poll. */
  readonly pollCount: number;
  /**
   * Reserved diagnostic slot: always zero. No intermediate observation narrows
   * the interval between submission and the queue-completion callback.
   */
  readonly previousPollAtMs: number;
}

export type TerminalPerfEvent =
  | ({
      readonly kind: 'recovery_outcome';
      readonly atMs: number;
    } & import('@merkur/shared').RecoveryOutcome)
  | {
      /** One click-correlated marker on the cold session startup path. */
      readonly kind: 'startup_milestone';
      readonly atMs: number;
      readonly attemptId: number;
      readonly deviceId: string;
      readonly milestone: TerminalStartupMilestone;
      readonly elapsedMs: number;
      /**
       * Trace context for this connect attempt, minted on the main thread before the session
       * request is sent and carried on every milestone of the attempt.
       *
       * Packed as six unsigned words rather than interned as a string: these are fixed-width
       * hex, so they are numbers, and the string table is a 64-slot no-eviction structure
       * sized for genuinely free-form values. A fresh trace per connect attempt would exhaust
       * it after 64 reconnects.
       *
       * It rides the ring rather than `postMessage` for the reason `session_bound` does: a
       * message is delivered on a task, so a reader could drain rows past the announcement.
       *
       * Per *attempt*, never per session — one id for a whole tab is the shape that once
       * fused 66,005 records into a single unreadable trace.
       */
      readonly traceId: string;
      readonly spanId: string;
    }
  | {
      /**
       * Starts a new correlation namespace. Input/display sequence numbers are
       * intentionally reusable by a newly authenticated browser peer, so a
       * report must never join events across this boundary.
       *
       * Carries no id, deliberately. It used to carry a `crypto.randomUUID()`
       * minted on the main thread, which was validated here and then read by
       * nothing — and which was not even the browser peer id the rest of the
       * system uses, since the signaling layer mints its own and overwrites it.
       * What this event contributes is the boundary timestamp; the session's
       * identity arrives later, on `session_bound`.
       */
      readonly kind: 'session_start';
      readonly atMs: number;
    }
  | {
      /**
       * Announces the Merkur session id for the namespace opened by the
       * preceding `session_start`, once the server has issued one.
       *
       * A separate event rather than a field on `session_start` because that
       * boundary must be emitted when the session *begins* — before any
       * server-issued id exists — and moving it later would drop every startup
       * milestone that precedes it.
       *
       * It rides the ring rather than arriving by `postMessage` for the same
       * reason the string table does: a message is delivered on a task, so the
       * reader could drain rows past this point before the id arrived. In the
       * ring it is ordered against the rows it describes by construction.
       *
       * The telemetry worker resolves this into a `merkur_session_id` on every
       * row it ships, so no query has to reconstruct the window.
       */
      readonly kind: 'session_bound';
      readonly atMs: number;
      readonly merkurSessionId: string;
      /** `navigator.connection` as the browser exposes it, or `unavailable`. */
      readonly networkType: import('./perf-event-codec').BrowserNetworkType;
      readonly effectiveType: import('./perf-event-codec').BrowserEffectiveType;
    }
  | {
      /** One edge connection of this session closed: which, how, and when. */
      readonly kind: 'carrier_closed';
      readonly atMs: number;
      readonly lane: import('./perf-event-codec').CarrierLane;
      readonly source: import('./perf-event-codec').CarrierCloseSource;
      /** The close code of a clean close, the stream error code of a stream error. */
      readonly closeCode: number;
      readonly lifetimeMs: number;
    }
  | {
      readonly kind: 'input_queued';
      /** Physical browser input origin in the shared performance epoch. */
      readonly atMs: number;
      /** Successful main→worker ring admission, after mapping and prediction classification. */
      readonly admittedAtMs: number;
      readonly inputSeq: number;
      readonly byteLength: number;
    }
  | {
      /** Physical custom-keyboard contact through semantic key commitment. */
      readonly kind: 'keyboard_commit';
      readonly atMs: number;
      readonly touchStartedAtMs: number;
      readonly inputSeq: number;
      readonly repeat: boolean;
    }
  | {
      /**
       * The transport worker admitted this input to its replay outbox and
       * requested a pacer emission. Browser APIs do not expose physical packet
       * transmission, so this is deliberately not used as a wire-time claim.
       */
      readonly kind: 'input_sent';
      readonly atMs: number;
      readonly inputSeq: number;
    }
  | {
      readonly kind: 'input_ack';
      readonly atMs: number;
      readonly inputSeq: number;
      /**
       * The carrier's path RTT floor when this ack landed, so the round trip
       * `input_sent → input_ack` can be split into its network and non-network
       * halves without a second query.
       *
       * The non-network half is what the daemon's ack scheduling costs, and it
       * had no instrument at all while the ack was a wall-clock coalescer
       * deferring every ack of a burst by 8-16 ms: the delay was buried under a
       * round trip whose network term is not measured on the same event, and
       * production `srtt` is only sampled at prediction-gate transitions.
       *
       * It is the windowed MINIMUM (`networkRttFloor`), not the live sample —
       * processing delay only ever adds to an RTT sample, so the floor is the
       * path term with the spikes rejected. Subtracting it therefore yields an
       * UPPER bound on the non-network residual, which is the honest direction:
       * it can overstate the daemon's cost, never hide it.
       *
       * Null until the floor has a sample, and again for one window after a
       * path change, because a new path must not be reported under the old
       * path's floor.
       */
      readonly networkRttMs: number | null;
    }
  | {
      readonly kind: 'prediction_queued';
      readonly atMs: number;
      readonly inputSeq: number;
    }
  | {
      /** The WASM prediction model accepted this exact input action. */
      readonly kind: 'prediction_applied';
      readonly atMs: number;
      readonly inputSeq: number;
    }
  | {
      /**
       * The WASM prediction model refused this input action, so no speculative
       * glyph was produced for it and the causal barrier opened through it.
       *
       * The counterpart to `prediction_applied`, and the denominator that makes
       * prediction coverage readable: without it a rejected key is
       * indistinguishable from one that was never typed. `rejectKind` is the
       * `PredictionCommandKind` numeric constant, so rejections can be
       * attributed to a specific command shape rather than counted in bulk.
       */
      readonly kind: 'prediction_rejected';
      readonly atMs: number;
      readonly inputSeq: number;
      readonly rejectKind: number;
      /**
       * The model's own `CursorCause` code for the refusal — which of its
       * gates said no (`FlushSeedBaseNotReceived`, `FlushAnchorNotPresented`,
       * `LineSealed`, ...). The command kind alone says what was refused, not
       * why, and every refusal opens the causal fence over the keys behind it.
       */
      readonly rejectCauseCode: number;
    }
  | {
      /**
       * The drawn cursor stepped backwards, from term-wasm's cursor journal:
       * the base cursor the renderer was handed moved to a smaller (row,
       * column) than the one before it. `causeCode` is the model's own
       * `CursorCause` code for what moved it — a withdrawn model, a moved
       * projection, or an authoritative header behind the one on screen — and
       * `flags` are the `CURSOR_MOTION_FLAG_*` bits sampled at that instant
       * (was/is modelled, line present/admitted/sealed, mode unsafe). This is
       * the exact instrument behind the "cursor jumps backwards" reports; the
       * e2e cursor-motion spec reads the same journal from the console.
       */
      readonly kind: 'cursor_step';
      readonly atMs: number;
      readonly causeCode: number;
      readonly fromRow: number;
      readonly fromCol: number;
      readonly toRow: number;
      readonly toCol: number;
      readonly flags: number;
      readonly ops: number;
      readonly journalSeq: number;
      /** Newest local input the model had accepted when the step was journalled. */
      readonly predictionInputSeq: number;
      /** Newest local input authoritative display had covered at that moment. */
      readonly displayInputSeq: number;
    }
  | {
      /**
       * The authoritative cursor changed shape or visibility without moving,
       * from the same journal. A header that hides the cursor mid-line is what
       * a torn repaint looks like from the browser.
       */
      readonly kind: 'cursor_shape';
      readonly atMs: number;
      readonly shapeFrom: number;
      readonly visibleFrom: number;
      readonly shapeTo: number;
      readonly visibleTo: number;
      readonly flags: number;
      readonly displaySeq: number;
    }
  | {
      /**
       * An exact grid mismatch withdrew the speculative epoch. This is the only
       * withdrawal there is: no frame-size proxy, no wall-clock cooldown.
       */
      readonly kind: 'prediction_suppressed';
      readonly atMs: number;
      readonly queuedPredictions: number;
      readonly failedPredictions: number;
      /** Neutral tail canceled when one mismatch invalidated its speculative epoch. */
      readonly discardedPredictions: number;
    }
  // One phase of a carrier recovery, with the evidence that produced it. The
  // phases are distinct because starting a replacement dial and seating it are
  // separate decisions with separate triggers; a trace that merged them could
  // not show whether recovery is running on evidence or on a timer.
  // `incumbent_failed` is the second unanswered round trip, which is what a
  // promotion now requires -- a lapse alone starts the dial and nothing else.
  // `promoted` seats a proven standby; `evicted` gives the incumbent up because
  // the replacement dial failed too, so no path to the edge exists from here.
  | {
      readonly kind: 'carrier_recovery';
      readonly atMs: number;
      readonly phase:
        | 'dial_started'
        | 'incumbent_failed'
        | 'promoted'
        | 'rebind_sent'
        | 'restored'
        | 'evicted'
        | 'standby_ready'
        | 'dial_failed'
        | 'dial_retired'
        | 'first_ack';
      readonly reason:
        | 'pong-deadline-lapsed'
        | 'connectivity-hint'
        | 'standby-proved-path'
        | 'edge-unreachable'
        | 'recovery-attempt';
    }
  | {
      /**
       * One transition of a graphics tile job, once per transition and never
       * per chunk. A harness that times input against a transfer reads these
       * to prove what the transfer did; the latency analyzer ignores them.
       */
      readonly kind: 'graphics_asset';
      readonly atMs: number;
      readonly phase: GraphicsAssetPhase;
      /** The asset client's job identity. */
      readonly jobId: number;
      /** Received object bytes at `fin`; zero for every other phase. */
      readonly bytes: number;
      /** Only on `retired`: the job ended without delivering its tile. */
      readonly failed: boolean;
    }
  | {
      readonly kind: 'transport_state';
      readonly atMs: number;
      readonly state:
        | 'connected'
        | 'disconnected'
        | 'signaling_connected'
        | 'signaling_reconnecting';
      readonly reason?: string;
    }
  // Prediction-visibility gate state: posted on state transitions plus a
  // 1s-throttled heartbeat while recording, so traces show threshold drift.
  | {
      /**
       * The prediction visibility gate's state, on a change or a 1 Hz
       * heartbeat, with the trust evidence it was decided on. Visibility is
       * trust and causal safety only; the path RTT it once compared against a
       * measured local paint latency is no longer a term.
       */
      readonly kind: 'prediction_gate';
      readonly atMs: number;
      readonly state: 'learning' | 'visible' | 'suppressed';
      /** `-1` before any rendered header. */
      readonly mode: number;
      readonly suppressionReason: PredictionGateSuppressionReason | null;
      /** Consecutive confirmed predictions since the last reset. */
      readonly trustConsecutive: number;
      /** Confirmed fraction of the bounded recent outcome window. */
      readonly trustRatio: number;
      /** Outcomes in that window. */
      readonly trustWindow: number;
    }
  | ({
      /**
       * Daemon-interior latency for one input, reported by the dataplane: the
       * wire record's terms, unchanged.
       *
       * Closes the largest gap in the chain. Everything from a keystroke
       * reaching the daemon to the display datagram leaving it used to be a
       * single opaque term inside `inputToDisplayReceiveMs`; the record's ten
       * terms partition it, and separate the shell's own think time from
       * Merkur's.
       */
      readonly kind: 'daemon_timing';
      readonly atMs: number;
      /** Reliable diagnostic batch lineage. */
      readonly batchSeq: number;
      /** Browser-owned reset fence carried through the daemon. */
      readonly observationEpoch: number;
    } & PerfTimingRecord)
  | {
      /**
       * Cumulative packet-admission refusals at one Merkur-owned egress hop,
       * as the daemon last read them: its own aggregate group on its primary
       * carrier, or the edge's browser-facing group from its latest quote.
       * Modular u32 counters within one `series`; difference consecutive
       * snapshots of the same series.
       */
      readonly kind: 'transport_egress';
      readonly atMs: number;
      readonly observationEpoch: number;
      readonly hop: TerminalEgressHop;
      /**
       * Identity of the counters: the daemon's group, or the browser
       * attachment whose edge quote carried them. Zero before one exists.
       */
      readonly series: number;
      readonly interactive: TerminalEgressRefusals;
      readonly bulk: TerminalEgressRefusals;
    }
  | {
      /**
       * The edge's cumulative daemon-to-browser datagram residence, receipt
       * from the daemon to admission on the browser connection, in log2
       * microsecond buckets from 16 us (the last is open at 16.384 ms).
       * Recorded only while the daemon profiles.
       */
      readonly kind: 'edge_forward_residence';
      readonly atMs: number;
      readonly observationEpoch: number;
      /** The browser attachment whose edge quote carried the buckets. */
      readonly series: number;
      readonly buckets: readonly number[];
    }
  | {
      /** Exact cumulative completeness envelope for one reliable timing batch. */
      readonly kind: 'daemon_timing_status';
      readonly atMs: number;
      readonly batchSeq: number;
      readonly inputAttributedTotal: number;
      readonly inputDroppedTotal: number;
      readonly inputSkippedTotal: number;
      readonly pendingInputs: number;
      readonly displayAttributedTotal: number;
      readonly displayDroppedTotal: number;
      /** Browser-owned reset fence carried through the daemon. */
      readonly observationEpoch: number;
      /** Number of `daemon_timing` records carried by this exact batch. */
      readonly recordCount: number;
    }
  | {
      /** Latest model state, observed while profiling; epoch zero means no image group. */
      readonly kind: 'egress_model';
      readonly atMs: number;
      readonly observationEpoch: number;
      readonly hop: TerminalEgressHop;
      readonly model: EgressModelSample;
    }
  | DisplayPerfEvent<'display_received'>
  | DisplayPerfEvent<'worker_display_queued'>
  | DisplayPerfEvent<'worker_display_applied'>
  | PresentationCommitPerfEvent
  | PresentationTransactionDiscardedPerfEvent
  | PresentationEpochBoundaryPerfEvent
  | PresentationMeasurementBoundaryPerfEvent
  | DisplayRingMeasurementBoundaryPerfEvent
  | DisplayPumpCompletePerfEvent
  | MainFrameCadencePerfEvent
  | MainLongTaskPerfEvent
  | PresentationGatePerfEvent
  | FirstDisplayGatePerfEvent
  | BrowserDisplayIoPerfEvent
  | {
      /**
       * The terminal worker gave up on its display lineage and requested a
       * snapshot. Emitted at every entry, including the ones that return early
       * because a resync is already pending — a peer asking repeatedly is a
       * different condition from one asking once, and only the count separates
       * them.
       */
      readonly kind: 'display_resync';
      readonly atMs: number;
      readonly reason: TerminalDisplayResyncReason;
      /** Lineage being abandoned. Joins to `generation` on the display events. */
      readonly generation: number;
      /** A snapshot request was already outstanding when this reason fired. */
      readonly alreadyPending: boolean;
    }
  | StartedRenderPerfEvent
  | EndedRenderPerfEvent
  // GPU queue completion observed through the renderer's submitted-work callback.
  // It does not claim compositor/vsync/physical scan-out completion. `atMs`
  // is a browser-callback upper bound, not exact GPU execution time.
  | FrameCompletePerfEvent;

export interface TerminalLatencySample {
  readonly inputSeq: number;
  /** Physical browser event/contact to successful input-ring admission. */
  readonly physicalInputToAdmissionMs: number | null;
  /** Physical contact to semantic custom-keyboard commitment. */
  readonly touchToCommitMs: number | null;
  /** Physical contact to worker GPU submission containing this exact prediction; not paint. */
  readonly touchToPredictionSubmissionMs: number | null;
  /** Physical browser event/contact to worker GPU submission containing this exact prediction. */
  readonly inputToPredictionSubmissionMs: number | null;
  /** Physical browser event/contact to GPU completion for a frame containing the prediction. */
  readonly inputToPredictionPaintMs: number | null;
  /** Input-ring admission to transport-worker outbox admission/pacer request. */
  readonly admissionToInputSentMs: number | null;
  /** Transport-worker outbox admission/pacer request to cumulative daemon ACK. */
  readonly inputSentToAckMs: number | null;
  /** Carrier RTT floor sampled when that ACK arrived. */
  readonly inputAckNetworkRttFloorMs: number | null;
  /** Upper bound: sent→ACK minus the contemporaneous path RTT floor. */
  readonly inputAckNonNetworkUpperBoundMs: number | null;
  readonly inputToDisplayReceiveMs: number | null;
  readonly displayReceiveToWorkerQueueMs: number | null;
  readonly workerQueueToDisplayApplyMs: number | null;
  readonly inputToDisplayApplyMs: number | null;
  /** Input to GPU completion for a frame containing authoritative display. */
  readonly inputToDisplayPaintMs: number | null;
  /**
   * Input to the observed GPU fence of a presentation that performed at least
   * one authoritative geometry upload. Unlike `inputToDisplayPaintMs`, a
   * header-only causal-barrier advertisement cannot satisfy this metric.
   */
  readonly inputToAuthoritativeVisualFenceMs: number | null;
  /**
   * Input to the final fence for the first sender presentation id that
   * acknowledges it. Diagnostic only: a sender id scopes one flush, not a
   * logical PTY redraw.
   */
  readonly inputToCompletedSenderPresentationFenceMs: number | null;
  /**
   * The final input admitted inside an explicit logical-workload window to
   * that window's final observed authoritative GPU fence. Exactly one trigger
   * input is eligible per window; earlier command-entry keystrokes are not
   * relabeled as if each independently completed the whole workload.
   */
  readonly inputToCompletedAuthoritativePresentationFenceMs: number | null;
  /** Display apply to GPU completion; compositor/scan-out time is not observable. */
  readonly displayApplyToPaintMs: number | null;
  /**
   * The three fields below partition `displayApplyToPaintMs` exactly: they are
   * computed from the same four timestamps, so where all four are present they
   * sum to it. That identity is the correctness oracle for the decomposition.
   * All three are null unless the painting frame joined by `renderSeq` and was
   * a real `gpu-queue` frame.
   */
  readonly displayApplyToRenderStartMs: number | null;
  readonly renderStartToRenderEndMs: number | null;
  readonly renderEndToDisplayPaintMs: number | null;
  /**
   * Legacy-named diagnostic: zero for an exactly joined WebGPU completion,
   * null without one. There is no intermediate poll or GPU execution estimate.
   */
  readonly renderEndToLastUnreadyPollMs: number | null;
  /** Full submit-end to queue-callback interval, not polling uncertainty or GPU execution time. */
  readonly fenceObservationIntervalMs: number | null;
  /** Apply to the render first becoming wanted; isolates display-pump scheduling. */
  readonly displayApplyToRenderWantedMs: number | null;
  /** Wanted to the previous frame's fence releasing the gate; null unless fence-gated. */
  readonly renderFenceGateMs: number | null;
  /** Accumulated active opportunity wait; null unless opportunity-gated. */
  readonly renderOpportunityGateMs: number | null;
  readonly inputAckMs: number | null;
}

/** The two egress hops Merkur owns on a daemon-to-browser packet's path. */
export type TerminalEgressHop = 'daemon' | 'edge';
export const TERMINAL_EGRESS_HOPS = [
  'daemon',
  'edge',
] as const satisfies readonly TerminalEgressHop[];

/** Log2 microsecond residence buckets the edge reports, from 16 us. */
export const EDGE_FORWARD_RESIDENCE_BUCKET_COUNT = 12;

/** Cumulative refusals of one traffic class by one aggregate packet group. */
export interface TerminalEgressRefusals {
  /** Refused for aggregate credit, or bulk yielding to queued interactive work. */
  readonly blocked: number;
  /** Refused by the shared pacer. */
  readonly paced: number;
  /** Closed waits: first refusal decision to the next admitted packet. */
  readonly waitedUs: number;
}

/**
 * Exact analyzer observations retained by the network matrix. These names are
 * report paths on purpose: a pooled profile distribution can be checked
 * directly against the per-test report without guessing which stage it came
 * from. Unlike `TerminalLatencyReport`, this surface contains observations,
 * never already-ranked percentiles.
 */
export const TERMINAL_LATENCY_RAW_METRIC_NAMES = [
  'physicalInputToAdmissionMs',
  'touchToCommitMs',
  'touchToPredictionSubmissionMs',
  'inputToPredictionSubmissionMs',
  'inputToPredictionPaintMs',
  'admissionToInputSentMs',
  'inputSentToAckMs',
  'inputAckNetworkRttFloorMs',
  'inputAckNonNetworkUpperBoundMs',
  'inputToDisplayReceiveMs',
  'displayReceiveToWorkerQueueMs',
  'workerQueueToDisplayApplyMs',
  'inputToDisplayApplyMs',
  'inputToDisplayPaintMs',
  'inputToAuthoritativeVisualFenceMs',
  'inputToCompletedSenderPresentationFenceMs',
  'inputToCompletedAuthoritativePresentationFenceMs',
  'displayApplyToPaintMs',
  'displayApplyToRenderStartMs',
  'renderStartToRenderEndMs',
  'renderEndToDisplayPaintMs',
  'renderEndToLastUnreadyPollMs',
  'fenceObservationIntervalMs',
  'renderGate.applyToRenderWantedMs',
  'renderGate.fenceGateWaitMs',
  'renderGate.opportunityGateWaitMs',
  'inputAckMs',
  'daemonPipeline.recvToPtyUs',
  'daemonPipeline.ptyToReadUs',
  'daemonPipeline.gridApplyUs',
  'daemonPipeline.displayCoalesceUs',
  'daemonPipeline.selectCaptureUs',
  'daemonPipeline.prepareQueueUs',
  'daemonPipeline.encodeUs',
  'daemonPipeline.compressionUs',
  'daemonPipeline.completionQueueUs',
  'daemonPipeline.transportSubmitUs',
  'daemonPipeline.gridMutationToEncodedUs',
  'daemonPipeline.queuedBeforeTransportSubmitUs',
  'daemonPipeline.displayOperationTotalUs',
  'daemonPipeline.totalUs',
  'daemonPipeline.writeCompletionUs',
  'daemonPipeline.ackTransmitUs',
  'daemonPipeline.ownerCpuUs',
  'daemonPipeline.ownerOffCpuUs',
  'daemonPipeline.ownerQuinnWaitUs',
  'daemonPipeline.ownerRegistryWaitUs',
  'daemonPipeline.flushLockWaitUs',
  'daemonPipeline.displayOperationOwnerOffCpuUs',
  'daemonPipeline.displayOperationLockWaitUs',
  'displayPipeline.workerReceiptToDecodeMs',
  'displayPipeline.decodeToApplyMs',
  'displayPipeline.pumpDurationMs',
  'displayPipeline.datagramsPerPump',
  'displayPipeline.rowsPerPump',
  'displayPipeline.encodedDeferralQueueHighWaterPerPump',
  'displayPipeline.ringBytesAtPumpStart',
  'displayPipeline.ringBytesAtPumpEnd',
  'displayPipeline.ringRefusedFrameCountPerMeasurementWindow',
  'displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows',
  'mainThread.rafGapMs',
  'mainThread.frameBudgetOverrunMs',
  'mainThread.estimatedMissedFramesPerGap',
  'mainThread.estimatedMissedFramesPerMeasurementWindow',
  'mainThread.longTaskDurationMs',
  'browserDisplayIo.endToEndExplicitCopiesPerUpdate',
  'browserDisplayIo.endToEndExplicitCopiedBytesPerPayloadByte',
  'browserDisplayIo.endToEndExplicitAllocationRequestsPerUpdate',
  'browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerUpdate',
  'browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerPayloadByte',
  'browserDisplayIo.endToEndExplicitObjectAllocationRequestsPerUpdate',
  'presentation.datagramsPerCommit',
  'presentation.rowsPerCommit',
  'presentation.bytesPerCommit',
  'presentation.firstApplyToCommitMs',
  'presentation.lastApplyToCommitMs',
  'presentation.commitToGpuFenceMs',
  'presentation.renderSubmissionMs',
  'presentation.partialPresentationExposureMs',
  'presentation.commitsPerPresentation',
  'presentation.measurementWindowExposureMs',
  'presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs',
  'presentation.commitsPerMeasurementWindow',
  'presentation.ordinaryCommitsPerMeasurementWindow',
  'presentation.repairCommitsPerMeasurementWindow',
  'presentation.expiredRepairCommitsPerMeasurementWindow',
  'presentation.ordinaryMeasurementWindowExposureMs',
  'presentation.rowsPerMeasurementWindow',
  'presentation.datagramsPerMeasurementWindow',
  'presentation.bytesPerMeasurementWindow',
  'presentation.firstDisplayReceiveToCompletedPresentationFenceMs',
  'presentation.refreshPeriodPerMeasurementWindowMs',
  'presentation.fenceObservationIntervalPerMeasurementWindowMs',
] as const;

export type TerminalLatencyRawMetricName = (typeof TERMINAL_LATENCY_RAW_METRIC_NAMES)[number];
export type TerminalLatencyRawMetricSamples = Readonly<
  Record<TerminalLatencyRawMetricName, readonly number[]>
>;

export interface TerminalPresentationReport {
  readonly epochBoundaryCount: number;
  readonly currentEpoch: number | null;
  readonly commitCount: number;
  readonly coherentCommitCount: number;
  readonly urgentCommitCount: number;
  readonly authoritativeVisualCommitCount: number;
  readonly discardedTransactionCount: number;
  readonly discardedDatagramCount: number;
  readonly discardedRowCount: number;
  readonly discardedByteCount: number;
  readonly discardedTransactionCountByReason: Readonly<
    Record<TerminalPresentationDiscardReason, number>
  >;
  readonly groupCount: number;
  readonly groupsWithMultipleCommits: number;
  readonly measurementWindowCount: number;
  readonly measurementWindowCountByPurpose: Readonly<
    Record<TerminalPresentationMeasurementPurpose, number>
  >;
  readonly measurementWindowsWithMultipleCommits: number;
  readonly frameBudgetExceededCount: number;
  readonly deadlineExceededCount: number;
  readonly datagramsPerCommit: TerminalLatencyPercentiles;
  readonly rowsPerCommit: TerminalLatencyPercentiles;
  readonly bytesPerCommit: TerminalLatencyPercentiles;
  readonly firstApplyToCommitMs: TerminalLatencyPercentiles;
  readonly lastApplyToCommitMs: TerminalLatencyPercentiles;
  readonly firstReceiveToCommitMs: TerminalLatencyPercentiles;
  readonly deadlineOverrunMs: TerminalLatencyPercentiles;
  /** Renderer submission to WebGPU queue callback, joined by render identity. */
  readonly commitToGpuFenceMs: TerminalLatencyPercentiles;
  /** One CPU renderer submission per authoritative commit in the measured windows. */
  readonly renderSubmissionMs: TerminalLatencyPercentiles;
  /**
   * Last minus first WebGPU queue callback for each exact
   * presentation id. This is a renderer-visibility proxy, not compositor,
   * vsync, scan-out, or physical-photon timing.
   */
  readonly partialPresentationExposureMs: TerminalLatencyPercentiles;
  /** Authoritative-visual GPU-fenced submissions carrying each presentation id. */
  readonly commitsPerPresentation: TerminalLatencyPercentiles;
  /**
   * Last minus first WebGPU queue callback for authoritative
   * visual commits submitted inside one explicit profiling-harness workload
   * window. The fence may complete after the end boundary. This is a renderer
   * completion proxy, not compositor, vsync, scan-out, or physical photons.
   */
  readonly measurementWindowExposureMs: TerminalLatencyPercentiles;
  /** Window start to its final authoritative WebGPU queue callback. */
  readonly measurementWindowToCompletedAuthoritativePresentationFenceMs: TerminalLatencyPercentiles;
  /** Authoritative-visual GPU-fenced submissions in each explicit workload window. */
  readonly commitsPerMeasurementWindow: TerminalLatencyPercentiles;
  /** Commits not released by an exact reliable repair marker. */
  readonly ordinaryCommitsPerMeasurementWindow: TerminalLatencyPercentiles;
  /** Commits released after every row named by an exact repair marker landed. */
  readonly repairCommitsPerMeasurementWindow: TerminalLatencyPercentiles;
  /** Repair holds that escaped on their bounded deadline; acceptance requires zero. */
  readonly expiredRepairCommitsPerMeasurementWindow: TerminalLatencyPercentiles;
  /** First-to-last ordinary fence only; later exact repair completion is excluded. */
  readonly ordinaryMeasurementWindowExposureMs: TerminalLatencyPercentiles;
  /** Authoritative row transformations represented by each explicit workload window. */
  readonly rowsPerMeasurementWindow: TerminalLatencyPercentiles;
  /** Independent authoritative display transformations in each explicit workload window. */
  readonly datagramsPerMeasurementWindow: TerminalLatencyPercentiles;
  /** Encoded authoritative display bytes represented by each explicit workload window. */
  readonly bytesPerMeasurementWindow: TerminalLatencyPercentiles;
  /**
   * Earliest exact display receipt belonging to a window transaction through
   * that window's final authoritative WebGPU queue callback.
   */
  readonly firstDisplayReceiveToCompletedPresentationFenceMs: TerminalLatencyPercentiles;
  /** Largest measured presentation period among submissions in each workload window. */
  readonly refreshPeriodPerMeasurementWindowMs: TerminalLatencyPercentiles;
  /** Largest full submit-end to queue-callback interval in the window; not polling uncertainty. */
  readonly fenceObservationIntervalPerMeasurementWindowMs: TerminalLatencyPercentiles;
}

export interface TerminalDisplayPipelineReport {
  readonly workerReceiptToDecodeMs: TerminalLatencyPercentiles;
  readonly decodeToApplyMs: TerminalLatencyPercentiles;
  /** Whole bounded pump slice, including the one reconciliation flush. */
  readonly pumpDurationMs: TerminalLatencyPercentiles;
  readonly pumpBudgetMs: TerminalLatencyPercentiles;
  readonly datagramsPerPump: TerminalLatencyPercentiles;
  readonly rowsPerPump: TerminalLatencyPercentiles;
  /** Peak encoded-deferral backlog observed at a pump boundary; excludes SAB ingress. */
  readonly encodedDeferralQueueHighWaterPerPump: TerminalLatencyPercentiles;
  /** Encoded deferrals left for a later owner turn; excludes unread SAB ingress. */
  readonly encodedDeferralQueueRemainingPerPump: TerminalLatencyPercentiles;
  /** Exact SAB occupancy at pump entry. This is a boundary sample, not a peak. */
  readonly ringBytesAtPumpStart: TerminalLatencyPercentiles;
  /** Exact SAB occupancy at pump exit. This is a boundary sample, not a peak. */
  readonly ringBytesAtPumpEnd: TerminalLatencyPercentiles;
  /**
   * Unsigned delta between worker-owned counter snapshots at each explicit
   * logical workload boundary. Missing or cross-lineage pairs are incomplete.
   */
  readonly ringRefusedFrameCountPerMeasurementWindow: TerminalLatencyPercentiles;
  /** Exact refusal deltas between one workload window's end and the next start. */
  readonly ringRefusedFrameCountBetweenMeasurementWindows: TerminalLatencyPercentiles;
  /** Exact refusal delta across the first-start through last-end capture span. */
  readonly ringRefusedFrameCount: number;
  /** False when any boundary or adjacent boundary chain lacks one exact lineage. */
  readonly ringRefusalAccountingComplete: boolean;
  readonly budgetExceededCount: number;
}

/** Main-thread cadence observed only while explicit workload windows are active. */
export interface TerminalMainThreadFrameReport {
  /** False when a workload window was not bracketed by visible rAF intervals. */
  readonly complete: boolean;
  readonly measurementWindowCount: number;
  readonly sampledMeasurementWindowCount: number;
  readonly intervalCount: number;
  /** Raw browser-supplied visible rAF intervals. */
  readonly rafGapMs: TerminalLatencyPercentiles;
  /** `max(0, gap - measured refresh period)` for each sampled interval. */
  readonly frameBudgetOverrunMs: TerminalLatencyPercentiles;
  /** Estimated skipped refresh opportunities per interval; not compositor telemetry. */
  readonly estimatedMissedFramesPerGap: TerminalLatencyPercentiles;
  /** Sum of those estimates in each explicit workload window. */
  readonly estimatedMissedFramesPerMeasurementWindow: TerminalLatencyPercentiles;
  readonly estimatedMissedFrameCount: number;
  /** Intervals whose raw overrun exceeds the exported instrumentation/scheduling tolerance. */
  readonly frameBudgetExceededIntervalCount: number;
  /** Null until at least one cadence sample states browser support. */
  readonly longTaskObserverSupported: boolean | null;
  /** Direct PerformanceObserver durations; unavailable when the browser lacks `longtask`. */
  readonly longTaskDurationMs: TerminalLatencyPercentiles;
  readonly longTaskCount: number;
  readonly longTaskTotalMs: number;
}

export interface TerminalBrowserDisplayIoReport {
  /** Exact accounting boundary; names important browser-owned exclusions. */
  readonly scope: string;
  /** False on malformed/duplicate events, not on an explicitly reported unmatched update. */
  readonly complete: boolean;
  readonly transportIngressUpdateCount: number;
  readonly rejectedTransportIngressUpdateCount: number;
  readonly terminalApplyUpdateCount: number;
  readonly transportFecIngressUpdateCount: number;
  readonly terminalFecProcessingUpdateCount: number;
  /** Stage-wide FEC payload/work totals, separate from patch end-to-end joins. */
  readonly fecPayloadByteCount: number;
  readonly fecExplicitCopyCount: number;
  readonly fecExplicitCopiedByteCount: number;
  readonly fecExplicitAllocationRequestCount: number;
  readonly fecExplicitAllocationRequestedByteCount: number;
  readonly fecExplicitObjectAllocationRequestCount: number;
  readonly endToEndMatchedUpdateCount: number;
  /** Terminal applies proven to have been reconstructed without a data-datagram ingress. */
  readonly fecRecoveredTerminalApplyUpdateCount: number;
  /** Directly matched plus FEC-proven terminal applies divided by all terminal applies. */
  readonly endToEndCoverageRatio: number | null;
  /** Payload bytes represented once per matched transport-to-apply path. */
  readonly endToEndMatchedPayloadByteCount: number;
  /** Payload bytes presented to all accounted stages; a matched path contributes twice. */
  readonly payloadByteCount: number;
  readonly explicitCopyCount: number;
  readonly explicitCopiedByteCount: number;
  readonly explicitAllocationRequestCount: number;
  readonly explicitAllocationRequestedByteCount: number;
  readonly explicitObjectAllocationRequestCount: number;
  readonly endToEndExplicitCopiesPerUpdate: TerminalLatencyPercentiles;
  readonly endToEndExplicitCopiedBytesPerPayloadByte: TerminalLatencyPercentiles;
  readonly endToEndExplicitAllocationRequestsPerUpdate: TerminalLatencyPercentiles;
  readonly endToEndExplicitAllocationRequestedBytesPerUpdate: TerminalLatencyPercentiles;
  readonly endToEndExplicitAllocationRequestedBytesPerPayloadByte: TerminalLatencyPercentiles;
  readonly endToEndExplicitObjectAllocationRequestsPerUpdate: TerminalLatencyPercentiles;
}

export interface TerminalDaemonPipelineReport {
  /** Distinct accepted reliable diagnostic batches. */
  readonly batchCount: number;
  readonly inputAttributedTotal: number;
  readonly inputDroppedTotal: number;
  readonly inputSkippedTotal: number;
  readonly pendingInputs: number;
  readonly displayAttributedTotal: number;
  readonly displayDroppedTotal: number;
  /** False on malformed fields, batch gaps, duplicate inputs, drops, skips, or a pending tail. */
  readonly complete: boolean;
  readonly recvToPtyUs: TerminalLatencyPercentiles;
  readonly ptyToReadUs: TerminalLatencyPercentiles;
  readonly gridApplyUs: TerminalLatencyPercentiles;
  readonly displayCoalesceUs: TerminalLatencyPercentiles;
  readonly selectCaptureUs: TerminalLatencyPercentiles;
  readonly prepareQueueUs: TerminalLatencyPercentiles;
  readonly encodeUs: TerminalLatencyPercentiles;
  readonly compressionUs: TerminalLatencyPercentiles;
  readonly completionQueueUs: TerminalLatencyPercentiles;
  readonly transportSubmitUs: TerminalLatencyPercentiles;
  /** Grid mutation through the completed raw/compressed datagram representation. */
  readonly gridMutationToEncodedUs: TerminalLatencyPercentiles;
  /** Time spent in the prepare and completion queues before transport submission. */
  readonly queuedBeforeTransportSubmitUs: TerminalLatencyPercentiles;
  /** One sample per actual display operation, never weighted by covered inputs. */
  readonly displayOperationTotalUs: TerminalLatencyPercentiles;
  /** One full causal sample per input that reached authoritative display output. */
  readonly totalUs: TerminalLatencyPercentiles;
  /** Acknowledgment half, per input whose boundary the daemon observed. */
  readonly writeCompletionUs: TerminalLatencyPercentiles;
  readonly ackTransmitUs: TerminalLatencyPercentiles;
  /**
   * The daemon's owner thread over each input's span, PTY FIFO enqueue to
   * carrier submission: CPU inside its busy periods, busy time off the CPU,
   * contended QUIC connection-state waits, registry lock waits, and the two
   * waits inside the flush alone.
   */
  readonly ownerCpuUs: TerminalLatencyPercentiles;
  readonly ownerOffCpuUs: TerminalLatencyPercentiles;
  readonly ownerQuinnWaitUs: TerminalLatencyPercentiles;
  readonly ownerRegistryWaitUs: TerminalLatencyPercentiles;
  readonly flushLockWaitUs: TerminalLatencyPercentiles;
  /** The owner over each display operation's flush: busy time off the CPU, and lock waits. */
  readonly displayOperationOwnerOffCpuUs: TerminalLatencyPercentiles;
  readonly displayOperationLockWaitUs: TerminalLatencyPercentiles;
}

/**
 * Refusals and relay residence accumulated across the report window, from the
 * daemon's cumulative snapshots. A counter that went backwards names a new
 * group: its step counts from zero and the window is incomplete, because the
 * replaced group's tail after its last snapshot was never observed.
 */
export interface TerminalTransportEgressReport {
  readonly complete: boolean;
  readonly daemonSnapshotCount: number;
  readonly edgeSnapshotCount: number;
  readonly daemon: TerminalEgressHopDelta;
  readonly edge: TerminalEgressHopDelta;
  /** Per-bucket residence count added across the window. */
  readonly edgeForwardResidence: readonly number[];
}

export interface TerminalEgressHopDelta {
  readonly interactive: TerminalEgressRefusals;
  readonly bulk: TerminalEgressRefusals;
}

export interface TerminalLatencyPercentiles {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  /** False means invalid or truncated events were rejected; inspect count before using tails. */
  readonly complete: boolean;
}

export interface TerminalCompletedPresentationLatencyPercentiles
  extends TerminalLatencyPercentiles {
  /** Final trigger inputs, at most one per completed logical-workload window. */
  readonly eligibleCount: number;
  /** Eligible inputs lacking the window's final authoritative GPU fence. */
  readonly censoredCount: number;
}

export interface TerminalPredictionLatencyPercentiles extends TerminalLatencyPercentiles {
  /** Accepted input actions eligible for an exact prediction-paint match. */
  readonly eligibleCount: number;
  /** Exact visible completions divided by eligible inputs; null if unavailable. */
  readonly coverageRatio: number | null;
}

/**
 * Why submissions waited. Every count comes from the `MailboxAction` the render
 * mailbox actually returned, so a gate is attributed rather than inferred.
 */
export interface TerminalRenderGateReport {
  readonly immediateCount: number;
  readonly fenceCount: number;
  readonly opportunityCount: number;
  readonly fenceAndOpportunityCount: number;
  /** Renders whose gate could not be read; a non-zero value weakens the attribution. */
  readonly unknownCount: number;
  readonly applyToRenderWantedMs: TerminalLatencyPercentiles;
  readonly fenceGateWaitMs: TerminalLatencyPercentiles;
  readonly opportunityGateWaitMs: TerminalLatencyPercentiles;
  /**
   * Cadence delay the mailbox requested, paired with `opportunityGateWaitMs`.
   * A longer observed wait exposes scheduling overshoot separately from the
   * requested opportunity interval; it does not by itself identify a late rAF.
   */
  readonly opportunityDelayRequestedMs: TerminalLatencyPercentiles;
  /** Effective presentation opportunity period, separate from estimator confidence. */
  readonly opportunityPeriodMs: TerminalLatencyPercentiles;
  /** Share of opportunity-gated renders whose estimator confidence was below 0.5. */
  readonly opportunityLowConfidenceRatio: number | null;
}

/**
 * Coverage and exclusions for the decomposition. Exclusion is not incompleteness:
 * a non-fence frame is counted here rather than folded into a percentile, so a
 * contaminated fence claim is visible in the artifact instead of averaged away.
 */
export interface TerminalRenderInstrumentationReport {
  /** All valid command-readiness observations, split without censoring older submissions. */
  readonly latestSubmittedFrameCount: number;
  readonly supersededFrameCount: number;
  readonly invalidatedFrameCount: number;
  /** Frames whose start, end and completion all joined by `renderSeq`. */
  readonly joinedFenceRenderCount: number;
  readonly missingRenderStartCount: number;
  readonly missingRenderEndCount: number;
  /** An out-of-band repaint replaced a fence under a seen `renderSeq`; excluded. */
  readonly duplicateRenderSeqFrameCount: number;
  readonly gpuQueueRenderCount: number;
  /** No real fence exists in this mode; never averaged into a fence number. */
  readonly noFenceRenderCount: number;
  readonly atlasUploadRenderCount: number;
  readonly drainedDisplayRenderCount: number;
  /** CPU submit cost excluding atlas-upload and display-drain frames. */
  readonly renderStartToRenderEndSteadyMs: TerminalLatencyPercentiles;
}

export interface TerminalStartupAttemptReport {
  readonly attemptId: number;
  readonly deviceId: string;
  readonly complete: boolean;
  readonly elapsedMsByMilestone: Partial<Record<TerminalStartupMilestone, number>>;
  /** Physical device-selection handler entry to first authoritative GPU fence. */
  readonly clickToFirstDisplayVisibleMs: number | null;
  /** CPU terminal mutation to completion of the GPU frame containing it. */
  readonly displayApplyToVisibleMs: number | null;
}

export interface TerminalStartupReport {
  readonly attemptCount: number;
  readonly completedCount: number;
  /** False when malformed, contradictory, or recorder-truncated events were observed. */
  readonly complete: boolean;
  readonly attempts: readonly TerminalStartupAttemptReport[];
}

export interface TerminalLatencyReport {
  /** `*PaintMs` names are legacy labels: completion is an observed WebGL fence,
   * never compositor presentation, scan-out, or a physical photon measurement. */
  readonly frameCompletionBoundary: 'browser-observed-webgpu-queue-completion';
  readonly sampleCount: number;
  readonly physicalInputToAdmissionMs: TerminalLatencyPercentiles;
  readonly touchToCommitMs: TerminalLatencyPercentiles;
  readonly touchToPredictionSubmissionMs: TerminalLatencyPercentiles;
  readonly inputToPredictionSubmissionMs: TerminalLatencyPercentiles;
  readonly inputToPredictionPaintMs: TerminalPredictionLatencyPercentiles;
  readonly admissionToInputSentMs: TerminalLatencyPercentiles;
  readonly inputSentToAckMs: TerminalLatencyPercentiles;
  readonly inputAckNetworkRttFloorMs: TerminalLatencyPercentiles;
  readonly inputAckNonNetworkUpperBoundMs: TerminalLatencyPercentiles;
  readonly inputToDisplayReceiveMs: TerminalLatencyPercentiles;
  readonly displayReceiveToWorkerQueueMs: TerminalLatencyPercentiles;
  readonly workerQueueToDisplayApplyMs: TerminalLatencyPercentiles;
  readonly inputToDisplayApplyMs: TerminalLatencyPercentiles;
  readonly inputToDisplayPaintMs: TerminalLatencyPercentiles;
  readonly inputToAuthoritativeVisualFenceMs: TerminalLatencyPercentiles;
  readonly inputToCompletedSenderPresentationFenceMs: TerminalLatencyPercentiles;
  readonly inputToCompletedAuthoritativePresentationFenceMs: TerminalCompletedPresentationLatencyPercentiles;
  readonly displayApplyToPaintMs: TerminalLatencyPercentiles;
  /** These three partition `displayApplyToPaintMs`; see the sample fields. */
  readonly displayApplyToRenderStartMs: TerminalLatencyPercentiles;
  readonly renderStartToRenderEndMs: TerminalLatencyPercentiles;
  readonly renderEndToDisplayPaintMs: TerminalLatencyPercentiles;
  /** Legacy-named zero-only joined diagnostic; no polling or physical GPU lower bound. */
  readonly renderEndToLastUnreadyPollMs: TerminalLatencyPercentiles;
  readonly fenceObservationIntervalMs: TerminalLatencyPercentiles;
  readonly renderGate: TerminalRenderGateReport;
  readonly renderInstrumentation: TerminalRenderInstrumentationReport;
  readonly daemonPipeline: TerminalDaemonPipelineReport;
  readonly transportEgress: TerminalTransportEgressReport;
  readonly displayPipeline: TerminalDisplayPipelineReport;
  readonly mainThread: TerminalMainThreadFrameReport;
  readonly browserDisplayIo: TerminalBrowserDisplayIoReport;
  readonly presentation: TerminalPresentationReport;
  readonly inputAckMs: TerminalLatencyPercentiles;
  readonly startup: TerminalStartupReport;
  readonly samples: readonly TerminalLatencySample[];
}

export interface TerminalPerfRecorder {
  /** Ordered retained tail; materialized only when diagnostics request it. */
  readonly events: readonly TerminalPerfEvent[];
  readonly capacity: number;
  readonly retainedEventCount: number;
  readonly totalRecordedCount: number;
  readonly droppedEventCount: number;
  record(event: TerminalPerfEvent): void;
  reset(): void;
  report(): TerminalLatencyReport;
}

const TRACE_EVENT_TARGET_HZ = 120;
const TRACE_RETENTION_SECONDS = 10 * 60;
const TRACE_EVENTS_PER_FRAME = 10;
const MAX_TRACE_EVENTS = TRACE_EVENT_TARGET_HZ * TRACE_RETENTION_SECONDS * TRACE_EVENTS_PER_FRAME;
const MAX_UINT32_SEQUENCE = 0xffff_ffff;
const MAX_EXACT_PREDICTION_SEQS_PER_FRAME = 256;
/** Diagnostic ceiling: longer means a stale trace or mixed clock domain, not an active frame. */
const MAX_PRESENTATION_DURATION_MS = 60_000;
let installedRecorderObservationEpoch = 1;
const terminalPerfResetListeners = new Set<(observationEpoch: number) => void>();

declare global {
  // Exposed for Playwright and local browser-console perf captures.
  var __merkurTerminalPerf: TerminalPerfRecorder | undefined;
  // E2E installs a capacity-controlled recorder before application modules
  // load. Its reset delegates here so the production-owned daemon lineage is
  // advanced exactly once regardless of which recorder implementation owns
  // storage.
  var __merkurTerminalPerfResetObservation: (() => number) | undefined;
}

function resetTerminalPerfObservation(): number {
  installedRecorderObservationEpoch = (installedRecorderObservationEpoch + 1) >>> 0;
  if (installedRecorderObservationEpoch === 0) installedRecorderObservationEpoch = 1;
  for (const listener of terminalPerfResetListeners) {
    listener(installedRecorderObservationEpoch);
  }
  return installedRecorderObservationEpoch;
}

globalThis.__merkurTerminalPerfResetObservation = resetTerminalPerfObservation;

export function terminalPerfNowMs(): number {
  return performance.timeOrigin + performance.now();
}

export function terminalElapsedMsSince(atMs: number, nowMs = terminalPerfNowMs()): number {
  return Math.max(0, Math.round(nowMs - atMs));
}

export function isTerminalPerfRecording(): boolean {
  return globalThis.__merkurTerminalPerf !== undefined;
}

/** Non-zero browser-owned lineage for daemon timing captured by the active recorder. */
export function terminalPerfObservationEpoch(): number {
  return installedRecorderObservationEpoch;
}

/** Notify a live transport worker whenever diagnostics start a fresh observation window. */
export function onTerminalPerfObservationReset(
  listener: (observationEpoch: number) => void,
): () => void {
  terminalPerfResetListeners.add(listener);
  return () => terminalPerfResetListeners.delete(listener);
}

/** @public Used by benchmark scripts through dynamic imports. */
export function installTerminalPerfRecorder(): TerminalPerfRecorder {
  const existing = globalThis.__merkurTerminalPerf;
  if (existing !== undefined) return existing;

  const recorder = createTerminalPerfRecorder();
  globalThis.__merkurTerminalPerf = recorder;
  return recorder;
}

/**
 * Drop the recorder and its retained trace.
 *
 * Both workers read `isTerminalPerfRecording()` only when they latch their own
 * `perfEnabled` at init, so this takes effect from the next terminal session.
 * The retained trace is released here rather than at the next install: a
 * disabled recorder must not keep up to `MAX_TRACE_EVENTS` of captured timing
 * alive for the rest of the page's life.
 */
export function uninstallTerminalPerfRecorder(): void {
  globalThis.__merkurTerminalPerf = undefined;
}

/**
 * Fixed-capacity O(1)-write recorder used by the browser profiler.
 *
 * Materializing `events` and building a report are explicit diagnostic work;
 * the interactive record path never shifts or splices an existing trace.
 */
export function createTerminalPerfRecorder(capacity = MAX_TRACE_EVENTS): TerminalPerfRecorder {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError(`terminal perf recorder capacity must be positive: ${capacity}`);
  }
  const storage: TerminalPerfEvent[] = [];
  let start = 0;
  let count = 0;
  let totalRecordedCount = 0;
  let droppedEventCount = 0;

  function snapshot(): TerminalPerfEvent[] {
    if (count === 0) return [];
    const tailLength = Math.min(count, capacity - start);
    return storage.slice(start, start + tailLength).concat(storage.slice(0, count - tailLength));
  }

  const recorder: TerminalPerfRecorder = {
    get events(): readonly TerminalPerfEvent[] {
      return snapshot();
    },
    capacity,
    get retainedEventCount(): number {
      return count;
    },
    get totalRecordedCount(): number {
      return totalRecordedCount;
    },
    get droppedEventCount(): number {
      return droppedEventCount;
    },
    record(event): void {
      if (
        globalThis.__merkurTerminalPerf === recorder &&
        (event.kind === 'daemon_timing' ||
          event.kind === 'daemon_timing_status' ||
          event.kind === 'transport_egress' ||
          event.kind === 'edge_forward_residence') &&
        event.observationEpoch !== installedRecorderObservationEpoch
      ) {
        return;
      }
      totalRecordedCount = Math.min(Number.MAX_SAFE_INTEGER, totalRecordedCount + 1);
      if (count < capacity) {
        storage[(start + count) % capacity] = event;
        count += 1;
      } else {
        storage[start] = event;
        start = (start + 1) % capacity;
        droppedEventCount = Math.min(Number.MAX_SAFE_INTEGER, droppedEventCount + 1);
      }
    },
    reset(): void {
      if (globalThis.__merkurTerminalPerf === recorder) {
        resetTerminalPerfObservation();
      }
      storage.length = 0;
      start = 0;
      count = 0;
      totalRecordedCount = 0;
      droppedEventCount = 0;
    },
    report(): TerminalLatencyReport {
      const report = buildTerminalLatencyReport(snapshot());
      return droppedEventCount === 0 ? report : markTerminalLatencyReportIncomplete(report);
    },
  };
  return recorder;
}

/** @public Useful for local browser-console perf captures. */
export function buildTerminalLatencyReport(
  events: readonly TerminalPerfEvent[],
): TerminalLatencyReport {
  return analyzeTerminalLatency(events);
}

/**
 * Return the analyzer's exact observations for lossless offline pooling.
 * This deliberately reruns the diagnostic analyzer; it is used only while
 * writing/replaying artifacts and never enters the terminal hot path.
 */
export function buildTerminalLatencyRawMetricSamples(
  events: readonly TerminalPerfEvent[],
): TerminalLatencyRawMetricSamples {
  const samples = Object.fromEntries(
    TERMINAL_LATENCY_RAW_METRIC_NAMES.map((name) => [name, [] as number[]]),
  ) as Record<TerminalLatencyRawMetricName, number[]>;
  analyzeTerminalLatency(events, samples);
  return samples;
}

function analyzeTerminalLatency(
  events: readonly TerminalPerfEvent[],
  rawMetricSamples?: Record<TerminalLatencyRawMetricName, number[]>,
): TerminalLatencyReport {
  const startup = buildTerminalStartupReport(events);
  const inputQueued = new Map<number, Extract<TerminalPerfEvent, { kind: 'input_queued' }>>();
  const inputSentBySeq = new Map<number, Extract<TerminalPerfEvent, { kind: 'input_sent' }>>();
  const inputAckBySeq = new Map<number, Extract<TerminalPerfEvent, { kind: 'input_ack' }>>();
  const predictionAppliedBySeq = new Map<
    number,
    Extract<TerminalPerfEvent, { kind: 'prediction_applied' }>
  >();
  const keyboardCommitBySeq = new Map<
    number,
    Extract<TerminalPerfEvent, { kind: 'keyboard_commit' }>
  >();
  const daemonTimings: Extract<TerminalPerfEvent, { kind: 'daemon_timing' }>[] = [];
  const daemonTimingStatuses: Extract<TerminalPerfEvent, { kind: 'daemon_timing_status' }>[] = [];
  const transportEgress: Extract<TerminalPerfEvent, { kind: 'transport_egress' }>[] = [];
  const edgeForwardResidence: Extract<TerminalPerfEvent, { kind: 'edge_forward_residence' }>[] = [];
  let transportEgressEventsComplete = true;
  const displayReceived: Extract<TerminalPerfEvent, { kind: 'display_received' }>[] = [];
  const workerQueuedByFrame = new Map<
    string,
    Extract<TerminalPerfEvent, { kind: 'worker_display_queued' }>
  >();
  const displayApplied: Extract<TerminalPerfEvent, { kind: 'worker_display_applied' }>[] = [];
  const presentationCommits: Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>[] = [];
  const presentationDiscards: Extract<
    TerminalPerfEvent,
    { kind: 'presentation_transaction_discarded' }
  >[] = [];
  const presentationMeasurementBoundaries: Extract<
    TerminalPerfEvent,
    { kind: 'presentation_measurement_boundary' }
  >[] = [];
  const displayRingMeasurementBoundaries: Extract<
    TerminalPerfEvent,
    { kind: 'display_ring_measurement_boundary' }
  >[] = [];
  const displayPumps: Extract<TerminalPerfEvent, { kind: 'display_pump_complete' }>[] = [];
  const mainFrameCadence: Extract<TerminalPerfEvent, { kind: 'main_frame_cadence' }>[] = [];
  const mainLongTasks: Extract<TerminalPerfEvent, { kind: 'main_long_task' }>[] = [];
  const browserDisplayIo: Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>[] = [];
  let frameComplete: Extract<TerminalPerfEvent, { kind: 'frame_complete' }>[] = [];
  let inputEventsComplete = true;
  let inputSentEventsComplete = true;
  let inputAckEventsComplete = true;
  let predictionAppliedEventsComplete = true;
  let keyboardCommitEventsComplete = true;
  let daemonTimingEventsComplete = true;
  let displayReceivedEventsComplete = true;
  let workerQueuedEventsComplete = true;
  let displayAppliedEventsComplete = true;
  let frameCompleteEventsComplete = true;
  let presentationCommitEventsComplete = true;
  let presentationDiscardEventsComplete = true;
  let presentationMeasurementEventsComplete = true;
  let displayRingMeasurementEventsComplete = true;
  let displayPumpEventsComplete = true;
  let mainFrameCadenceEventsComplete = true;
  let mainLongTaskEventsComplete = true;
  let browserDisplayIoEventsComplete = true;
  let sessionBoundaryEventsComplete = true;
  let latestSessionStartAtMs = Number.NEGATIVE_INFINITY;
  // Renders are joined by identity, never by timestamp proximity: `render_start`
  // is emitted for every render while `frame_complete` is emitted only for
  // fenced ones, so a proximity join can pair sub-terms from different renders.
  const renderStartBySeq = new Map<number, Extract<TerminalPerfEvent, { kind: 'render_start' }>>();
  const renderEndBySeq = new Map<number, Extract<TerminalPerfEvent, { kind: 'render_end' }>>();
  const duplicateSubmissionRenderSeqs = new Set<number>();
  let renderStartEventsComplete = true;
  let renderEndEventsComplete = true;
  let renderJoinComplete = true;

  for (const event of events) {
    if (event.kind !== 'session_start') continue;
    if (!validTimestamp(event.atMs)) {
      sessionBoundaryEventsComplete = false;
      continue;
    }
    latestSessionStartAtMs = Math.max(latestSessionStartAtMs, event.atMs);
  }

  let presentationEpochEventsComplete = true;
  // The cut before which nothing belongs to the current presentation lineage:
  // the latest boundary that DISCARDED the grid. A preserved boundary -- a
  // carrier swap answered with repairs -- continues the lineage it found, so
  // a measurement window opened before it and closed after it is one window,
  // and the events on both sides of it are one analysis.
  let latestPresentationEpochBoundaryAtMs = Number.NEGATIVE_INFINITY;
  let latestObservedPresentationEpochBoundaryAtMs = Number.NEGATIVE_INFINITY;
  let currentPresentationEpoch: number | null = null;
  let presentationEpochBoundaryCount = 0;
  const seenPresentationEpochs = new Set<number>();
  // Session epoch -> the lineage it belongs to, keyed by the epoch that
  // started that lineage. Ring measurement boundaries carry the session epoch
  // the terminal worker stamped them with; two boundaries in one lineage may
  // carry different epochs and still describe one continuous grid.
  const presentationLineageBySessionEpoch = new Map<number, number>();
  /** An epoch with no boundary in this trace is its own lineage. */
  const presentationLineageOfSeen = (sessionEpoch: number): number =>
    presentationLineageBySessionEpoch.get(sessionEpoch) ?? sessionEpoch;
  for (const event of events) {
    if (event.kind !== 'presentation_epoch_boundary' || event.atMs < latestSessionStartAtMs) {
      continue;
    }
    if (
      !validTimestamp(event.atMs) ||
      !validPositiveSequence(event.epoch) ||
      typeof event.preserved !== 'boolean' ||
      seenPresentationEpochs.has(event.epoch)
    ) {
      presentationEpochEventsComplete = false;
      continue;
    }
    seenPresentationEpochs.add(event.epoch);
    presentationEpochBoundaryCount += 1;
    if (event.atMs <= latestObservedPresentationEpochBoundaryAtMs) {
      presentationEpochEventsComplete = false;
      continue;
    }
    latestObservedPresentationEpochBoundaryAtMs = event.atMs;
    // A missing boundary may have discarded the grid. Preservation only links
    // adjacent epochs; it cannot certify continuity across lost telemetry.
    const adjacentEpoch =
      currentPresentationEpoch !== null &&
      event.epoch === ((currentPresentationEpoch + 1) >>> 0 || 1);
    if (currentPresentationEpoch !== null && !adjacentEpoch) {
      presentationEpochEventsComplete = false;
    }
    // `preserved` is a statement about this epoch's IMMEDIATE predecessor, and
    // epochs are consecutive by construction, so it links to `epoch - 1`
    // whether or not that predecessor's own boundary is in this trace. It
    // usually is not: a profiling reset retains only what follows it, so the
    // epoch a measurement STARTS in typically has no boundary here while the
    // epoch it ends in does. Requiring the predecessor's event was what left
    // `measurementWindowCount: 0` on exactly the carrier swaps this analysis
    // exists to measure. Continuity across a MISSING epoch is still refused:
    // an unseen epoch is its own lineage, so a preserved boundary two above a
    // seen one lands in a lineage the earlier events do not share.
    const lineage = event.preserved
      ? presentationLineageOfSeen(event.epoch === 1 ? 0xffff_ffff : event.epoch - 1)
      : event.epoch;
    const previousLineage =
      currentPresentationEpoch === null
        ? null
        : presentationLineageOfSeen(currentPresentationEpoch);
    presentationLineageBySessionEpoch.set(event.epoch, lineage);
    // The cut before which nothing belongs to the current lineage. A preserved
    // boundary continuing the lineage the trace was already in moves nothing —
    // that continuity is the whole point. Anything else does.
    if (!event.preserved || (previousLineage !== null && lineage !== previousLineage)) {
      latestPresentationEpochBoundaryAtMs = event.atMs;
    }
    currentPresentationEpoch = event.epoch;
  }
  const presentationLineageOf = (sessionEpoch: number): number =>
    presentationLineageOfSeen(sessionEpoch);
  if (Number.isFinite(latestSessionStartAtMs) && currentPresentationEpoch === null) {
    presentationEpochEventsComplete = false;
  }

  for (const event of events) {
    if (event.kind === 'session_start' || event.atMs < latestSessionStartAtMs) continue;
    if (event.kind === 'presentation_epoch_boundary') continue;
    if (event.kind === 'input_queued') {
      if (
        !validTimestamp(event.atMs) ||
        !validTimestamp(event.admittedAtMs) ||
        event.admittedAtMs < event.atMs ||
        event.admittedAtMs - event.atMs > MAX_PRESENTATION_DURATION_MS ||
        !validPositiveSequence(event.inputSeq) ||
        !validNonNegativeInteger(event.byteLength)
      ) {
        inputEventsComplete = false;
        continue;
      }
      const current = inputQueued.get(event.inputSeq);
      if (current === undefined || event.atMs < current.atMs) {
        inputQueued.set(event.inputSeq, event);
      }
    } else if (event.kind === 'input_sent') {
      if (!validTimestamp(event.atMs) || !validPositiveSequence(event.inputSeq)) {
        inputSentEventsComplete = false;
        continue;
      }
      const current = inputSentBySeq.get(event.inputSeq);
      if (current === undefined || event.atMs < current.atMs) {
        inputSentBySeq.set(event.inputSeq, event);
      }
    } else if (event.kind === 'keyboard_commit') {
      if (
        !validTimestamp(event.atMs) ||
        !validTimestamp(event.touchStartedAtMs) ||
        event.touchStartedAtMs > event.atMs ||
        !validPositiveSequence(event.inputSeq) ||
        typeof event.repeat !== 'boolean'
      ) {
        keyboardCommitEventsComplete = false;
        continue;
      }
      // A held-key repeat measures hold duration, not tap recognition latency.
      if (event.repeat) continue;
      const current = keyboardCommitBySeq.get(event.inputSeq);
      if (current === undefined || event.atMs < current.atMs) {
        keyboardCommitBySeq.set(event.inputSeq, event);
      }
    } else if (event.kind === 'input_ack') {
      if (
        !validTimestamp(event.atMs) ||
        !validPositiveSequence(event.inputSeq) ||
        (event.networkRttMs !== null &&
          (!Number.isFinite(event.networkRttMs) ||
            event.networkRttMs < 0 ||
            event.networkRttMs > MAX_PRESENTATION_DURATION_MS))
      ) {
        inputAckEventsComplete = false;
        continue;
      }
      // Earliest-wins: with keystroke racing on both transports the slower
      // path's duplicate ACK must not overwrite the faster one, even when a
      // diagnostic event array was merged out of timestamp order.
      const current = inputAckBySeq.get(event.inputSeq);
      if (current === undefined || event.atMs < current.atMs) {
        inputAckBySeq.set(event.inputSeq, event);
      }
    } else if (event.kind === 'prediction_applied') {
      if (!validTimestamp(event.atMs) || !validPositiveSequence(event.inputSeq)) {
        predictionAppliedEventsComplete = false;
        continue;
      }
      const current = predictionAppliedBySeq.get(event.inputSeq);
      if (current === undefined || event.atMs < current.atMs) {
        predictionAppliedBySeq.set(event.inputSeq, event);
      }
    } else if (event.kind === 'daemon_timing') {
      const durations = [
        event.recvToPtyUs,
        event.ptyToReadUs,
        event.gridApplyUs,
        event.displayCoalesceUs,
        event.selectCaptureUs,
        event.prepareQueueUs,
        event.encodeUs,
        event.compressionUs,
        event.completionQueueUs,
        event.transportSubmitUs,
        event.ownerCpuUs,
        event.ownerOffCpuUs,
        event.ownerQuinnWaitUs,
        event.ownerRegistryWaitUs,
        event.flushLockWaitUs,
      ];
      if (
        !validTimestamp(event.atMs) ||
        !validCumulativeSequence(event.inputSeq) ||
        !validCumulativeSequence(event.batchSeq) ||
        !validPositiveSequence(event.observationEpoch) ||
        durations.some((duration) => !validNonNegativeInteger(duration)) ||
        [event.writeCompletionUs, event.ackTransmitUs].some(
          (duration) => duration !== null && !validNonNegativeInteger(duration),
        )
      ) {
        daemonTimingEventsComplete = false;
        continue;
      }
      daemonTimings.push(event);
    } else if (event.kind === 'transport_egress') {
      if (
        !validTimestamp(event.atMs) ||
        !validPositiveSequence(event.observationEpoch) ||
        ![event.interactive, event.bulk].every(validEgressRefusals)
      ) {
        transportEgressEventsComplete = false;
        continue;
      }
      transportEgress.push(event);
    } else if (event.kind === 'edge_forward_residence') {
      if (
        !validTimestamp(event.atMs) ||
        !validPositiveSequence(event.observationEpoch) ||
        event.buckets.length !== EDGE_FORWARD_RESIDENCE_BUCKET_COUNT ||
        !event.buckets.every(validU32)
      ) {
        transportEgressEventsComplete = false;
        continue;
      }
      edgeForwardResidence.push(event);
    } else if (event.kind === 'daemon_timing_status') {
      if (
        !validTimestamp(event.atMs) ||
        !validCumulativeSequence(event.batchSeq) ||
        !validNonNegativeInteger(event.inputAttributedTotal) ||
        !validNonNegativeInteger(event.inputDroppedTotal) ||
        !validNonNegativeInteger(event.inputSkippedTotal) ||
        !validNonNegativeInteger(event.pendingInputs) ||
        !validNonNegativeInteger(event.displayAttributedTotal) ||
        !validNonNegativeInteger(event.displayDroppedTotal) ||
        !validPositiveSequence(event.observationEpoch) ||
        !validNonNegativeInteger(event.recordCount) ||
        event.recordCount > DAEMON_TIMING_MAX_RECORDS
      ) {
        daemonTimingEventsComplete = false;
        continue;
      }
      daemonTimingStatuses.push(event);
    } else if (event.kind === 'display_received') {
      if (!validDisplayPerfEvent(event)) {
        displayReceivedEventsComplete = false;
        continue;
      }
      displayReceived.push(event);
    } else if (event.kind === 'worker_display_queued') {
      if (!validDisplayPerfEvent(event)) {
        workerQueuedEventsComplete = false;
        continue;
      }
      const key = displayFrameKey(event.generation, event.displaySeq);
      const current = workerQueuedByFrame.get(key);
      if (current === undefined || event.atMs < current.atMs) {
        workerQueuedByFrame.set(key, event);
      }
    } else if (event.kind === 'worker_display_applied') {
      if (!validDisplayPerfEvent(event)) {
        displayAppliedEventsComplete = false;
        continue;
      }
      displayApplied.push(event);
    } else if (event.kind === 'frame_complete') {
      if (!validFrameCompletePerfEvent(event)) {
        frameCompleteEventsComplete = false;
        continue;
      }
      frameComplete.push(event);
    } else if (event.kind === 'presentation_commit') {
      if (event.atMs < latestPresentationEpochBoundaryAtMs) continue;
      if (!validPresentationCommitPerfEvent(event)) {
        presentationCommitEventsComplete = false;
        continue;
      }
      presentationCommits.push(event);
    } else if (event.kind === 'presentation_transaction_discarded') {
      if (event.atMs < latestPresentationEpochBoundaryAtMs) continue;
      if (!validPresentationTransactionDiscardedPerfEvent(event)) {
        presentationDiscardEventsComplete = false;
        continue;
      }
      presentationDiscards.push(event);
    } else if (event.kind === 'presentation_measurement_boundary') {
      if (event.atMs < latestPresentationEpochBoundaryAtMs) continue;
      if (!validPresentationMeasurementBoundaryPerfEvent(event)) {
        presentationMeasurementEventsComplete = false;
        continue;
      }
      presentationMeasurementBoundaries.push(event);
    } else if (event.kind === 'display_ring_measurement_boundary') {
      if (event.atMs < latestPresentationEpochBoundaryAtMs) continue;
      if (!validDisplayRingMeasurementBoundaryPerfEvent(event)) {
        displayRingMeasurementEventsComplete = false;
        continue;
      }
      displayRingMeasurementBoundaries.push(event);
    } else if (event.kind === 'display_pump_complete') {
      if (!validDisplayPumpCompletePerfEvent(event)) {
        displayPumpEventsComplete = false;
        continue;
      }
      displayPumps.push(event);
    } else if (event.kind === 'main_frame_cadence') {
      if (!validMainFrameCadencePerfEvent(event)) {
        mainFrameCadenceEventsComplete = false;
        continue;
      }
      mainFrameCadence.push(event);
    } else if (event.kind === 'main_long_task') {
      if (!validMainLongTaskPerfEvent(event)) {
        mainLongTaskEventsComplete = false;
        continue;
      }
      mainLongTasks.push(event);
    } else if (event.kind === 'browser_display_io') {
      if (!validBrowserDisplayIoPerfEvent(event)) {
        browserDisplayIoEventsComplete = false;
        continue;
      }
      browserDisplayIo.push(event);
    } else if (event.kind === 'render_start') {
      if (!validRenderStartPerfEvent(event)) {
        renderStartEventsComplete = false;
        continue;
      }
      // Earliest-wins, matching every other identity map here. A second
      // `render_start` under a live sequence is broken provenance, not a retry.
      const current = renderStartBySeq.get(event.renderSeq);
      if (current === undefined) {
        renderStartBySeq.set(event.renderSeq, event);
      } else if (event.atMs !== current.atMs) {
        renderStartEventsComplete = false;
        if (event.atMs < current.atMs) renderStartBySeq.set(event.renderSeq, event);
      }
    } else if (event.kind === 'render_end') {
      if (!validRenderEndPerfEvent(event)) {
        renderEndEventsComplete = false;
        continue;
      }
      const current = renderEndBySeq.get(event.renderSeq);
      if (current === undefined) {
        renderEndBySeq.set(event.renderSeq, event);
      } else {
        duplicateSubmissionRenderSeqs.add(event.renderSeq);
        if (event.atMs !== current.atMs) {
          renderEndEventsComplete = false;
          if (event.atMs < current.atMs) renderEndBySeq.set(event.renderSeq, event);
        }
      }
    }
  }

  displayReceived.sort((left, right) => left.atMs - right.atMs);
  displayApplied.sort((left, right) => left.atMs - right.atMs);
  frameComplete.sort((left, right) => left.atMs - right.atMs);
  presentationCommits.sort((left, right) => left.atMs - right.atMs);
  presentationDiscards.sort((left, right) => left.atMs - right.atMs);
  presentationMeasurementBoundaries.sort((left, right) => left.atMs - right.atMs);
  displayPumps.sort((left, right) => left.atMs - right.atMs);
  mainFrameCadence.sort((left, right) => left.atMs - right.atMs);
  mainLongTasks.sort((left, right) => left.atMs - right.atMs);
  browserDisplayIo.sort((left, right) => left.atMs - right.atMs);

  interface DaemonBatchMetadata {
    inputAttributedTotal: number;
    inputDroppedTotal: number;
    inputSkippedTotal: number;
    pendingInputs: number;
    displayAttributedTotal: number;
    displayDroppedTotal: number;
    observationEpoch: number;
    recordCount: number;
  }
  const daemonBatches = new Map<number, DaemonBatchMetadata>();
  const daemonRecordCountByBatch = new Map<number, number>();
  const daemonInputSeqs = new Set<number>();
  const daemonObservationEpochs = new Set<number>();
  let latestDaemonMetadata: DaemonBatchMetadata = {
    inputAttributedTotal: 0,
    inputDroppedTotal: 0,
    inputSkippedTotal: 0,
    pendingInputs: 0,
    displayAttributedTotal: 0,
    displayDroppedTotal: 0,
    observationEpoch: 0,
    recordCount: 0,
  };
  for (const event of daemonTimings) {
    daemonObservationEpochs.add(event.observationEpoch);
    if (event.inputSeq !== 0) {
      if (daemonInputSeqs.has(event.inputSeq)) daemonTimingEventsComplete = false;
      daemonInputSeqs.add(event.inputSeq);
    }
    daemonRecordCountByBatch.set(
      event.batchSeq,
      (daemonRecordCountByBatch.get(event.batchSeq) ?? 0) + 1,
    );
  }
  daemonTimingStatuses.sort(
    (left, right) => left.atMs - right.atMs || left.batchSeq - right.batchSeq,
  );
  let previousDaemonBatchSeq: number | null = null;
  for (const event of daemonTimingStatuses) {
    if (daemonBatches.has(event.batchSeq)) {
      daemonTimingEventsComplete = false;
      continue;
    }
    const metadata = {
      inputAttributedTotal: event.inputAttributedTotal,
      inputDroppedTotal: event.inputDroppedTotal,
      inputSkippedTotal: event.inputSkippedTotal,
      pendingInputs: event.pendingInputs,
      displayAttributedTotal: event.displayAttributedTotal,
      displayDroppedTotal: event.displayDroppedTotal,
      observationEpoch: event.observationEpoch,
      recordCount: event.recordCount,
    } satisfies DaemonBatchMetadata;
    daemonBatches.set(event.batchSeq, metadata);
    daemonObservationEpochs.add(event.observationEpoch);
    if (
      (previousDaemonBatchSeq === null && event.batchSeq !== 1) ||
      (previousDaemonBatchSeq !== null && event.batchSeq !== (previousDaemonBatchSeq + 1) >>> 0)
    ) {
      daemonTimingEventsComplete = false;
    }
    if (
      metadata.inputAttributedTotal < latestDaemonMetadata.inputAttributedTotal ||
      metadata.inputDroppedTotal < latestDaemonMetadata.inputDroppedTotal ||
      metadata.inputSkippedTotal < latestDaemonMetadata.inputSkippedTotal ||
      metadata.displayAttributedTotal < latestDaemonMetadata.displayAttributedTotal ||
      metadata.displayDroppedTotal < latestDaemonMetadata.displayDroppedTotal ||
      (latestDaemonMetadata.observationEpoch !== 0 &&
        metadata.observationEpoch !== latestDaemonMetadata.observationEpoch) ||
      metadata.recordCount !== (daemonRecordCountByBatch.get(event.batchSeq) ?? 0)
    ) {
      daemonTimingEventsComplete = false;
    }
    latestDaemonMetadata = metadata;
    previousDaemonBatchSeq = event.batchSeq;
  }
  for (const batchSeq of daemonRecordCountByBatch.keys()) {
    if (!daemonBatches.has(batchSeq)) daemonTimingEventsComplete = false;
  }
  const daemonInputTimings = daemonTimings.filter((event) => event.inputSeq !== 0);
  const daemonDisplayTimings = daemonTimings.filter((event) => event.inputSeq === 0);
  const daemonPipelineComplete =
    daemonTimingEventsComplete &&
    daemonObservationEpochs.size === 1 &&
    daemonBatches.size > 0 &&
    daemonDisplayTimings.length > 0 &&
    latestDaemonMetadata.inputDroppedTotal === 0 &&
    latestDaemonMetadata.inputSkippedTotal === 0 &&
    latestDaemonMetadata.pendingInputs === 0 &&
    latestDaemonMetadata.displayDroppedTotal === 0 &&
    latestDaemonMetadata.inputAttributedTotal === daemonInputTimings.length &&
    latestDaemonMetadata.displayAttributedTotal === daemonDisplayTimings.length;
  const daemonWriteCompletionUs = daemonInputTimings.flatMap((event) =>
    event.writeCompletionUs === null ? [] : [event.writeCompletionUs],
  );
  const daemonAckTransmitUs = daemonInputTimings.flatMap((event) =>
    event.ackTransmitUs === null ? [] : [event.ackTransmitUs],
  );
  const daemonTotalUs = daemonInputTimings.map(
    (event) =>
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
  );
  const daemonDisplayOperationTotalUs = daemonDisplayTimings.map(
    (event) =>
      event.displayCoalesceUs +
      event.selectCaptureUs +
      event.prepareQueueUs +
      event.encodeUs +
      event.compressionUs +
      event.completionQueueUs +
      event.transportSubmitUs,
  );
  const daemonGridMutationToEncodedUs = daemonDisplayTimings.map(
    (event) =>
      event.displayCoalesceUs +
      event.selectCaptureUs +
      event.prepareQueueUs +
      event.encodeUs +
      event.compressionUs,
  );
  const daemonQueuedBeforeTransportSubmitUs = daemonDisplayTimings.map(
    (event) => event.prepareQueueUs + event.completionQueueUs,
  );

  interface PresentationMeasurementWindow {
    measurementId: number;
    startAtMs: number;
    endAtMs: number;
    purpose: TerminalPresentationMeasurementPurpose;
  }
  interface MutablePresentationMeasurementWindow {
    startAtMs?: number;
    endAtMs?: number;
    purpose?: TerminalPresentationMeasurementPurpose;
  }
  const mutableMeasurementWindows = new Map<number, MutablePresentationMeasurementWindow>();
  for (const boundary of presentationMeasurementBoundaries) {
    let window = mutableMeasurementWindows.get(boundary.measurementId);
    if (window === undefined) {
      window = {};
      mutableMeasurementWindows.set(boundary.measurementId, window);
    }
    if (boundary.phase === 'start') {
      if (window.startAtMs !== undefined) presentationMeasurementEventsComplete = false;
      else {
        window.startAtMs = boundary.atMs;
        window.purpose = boundary.purpose;
      }
    } else if (window.endAtMs !== undefined) {
      presentationMeasurementEventsComplete = false;
    } else {
      window.endAtMs = boundary.atMs;
      if (window.purpose !== boundary.purpose) presentationMeasurementEventsComplete = false;
    }
  }
  const presentationMeasurementWindows: PresentationMeasurementWindow[] = [];
  for (const [measurementId, window] of mutableMeasurementWindows) {
    if (
      window.startAtMs === undefined ||
      window.endAtMs === undefined ||
      window.purpose === undefined ||
      window.endAtMs < window.startAtMs
    ) {
      presentationMeasurementEventsComplete = false;
      continue;
    }
    presentationMeasurementWindows.push({
      measurementId,
      startAtMs: window.startAtMs,
      endAtMs: window.endAtMs,
      purpose: window.purpose,
    });
  }
  presentationMeasurementWindows.sort(
    (left, right) => left.startAtMs - right.startAtMs || left.measurementId - right.measurementId,
  );
  const measurementWindowCountByPurpose: Record<TerminalPresentationMeasurementPurpose, number> = {
    'coherent-redraw': 0,
    'isolated-interactive': 0,
    streaming: 0,
  };
  for (const window of presentationMeasurementWindows) {
    measurementWindowCountByPurpose[window.purpose] += 1;
  }
  for (let index = 1; index < presentationMeasurementWindows.length; index += 1) {
    const previous = presentationMeasurementWindows[index - 1];
    const current = presentationMeasurementWindows[index];
    if (previous !== undefined && current !== undefined && current.startAtMs < previous.endAtMs) {
      presentationMeasurementEventsComplete = false;
    }
  }
  interface MutableDisplayRingMeasurementWindow {
    start?: Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }>;
    end?: Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }>;
  }
  const displayRingMeasurementWindows = new Map<number, MutableDisplayRingMeasurementWindow>();
  for (const boundary of displayRingMeasurementBoundaries) {
    let pair = displayRingMeasurementWindows.get(boundary.measurementId);
    if (pair === undefined) {
      pair = {};
      displayRingMeasurementWindows.set(boundary.measurementId, pair);
    }
    if (pair[boundary.phase] !== undefined) {
      displayRingMeasurementEventsComplete = false;
    } else {
      pair[boundary.phase] = boundary;
    }
  }
  if (displayRingMeasurementWindows.size !== presentationMeasurementWindows.length) {
    displayRingMeasurementEventsComplete = false;
  }
  type DisplayRingMeasurementPair = {
    readonly start: Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }>;
    readonly end: Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }>;
  };
  const displayRingMeasurementPairs: Array<DisplayRingMeasurementPair | null> = [];
  const ringRefusedFramesPerMeasurementWindow: (number | null)[] = [];
  for (const window of presentationMeasurementWindows) {
    const pair = displayRingMeasurementWindows.get(window.measurementId);
    const start = pair?.start;
    const end = pair?.end;
    if (
      start === undefined ||
      end === undefined ||
      start.atMs !== window.startAtMs ||
      end.atMs !== window.endAtMs ||
      start.observationEpoch !== end.observationEpoch ||
      presentationLineageOf(start.sessionEpoch) !== presentationLineageOf(end.sessionEpoch) ||
      window.endAtMs - window.startAtMs > MAX_PRESENTATION_DURATION_MS
    ) {
      displayRingMeasurementEventsComplete = false;
      displayRingMeasurementPairs.push(null);
      ringRefusedFramesPerMeasurementWindow.push(null);
      continue;
    }
    // The SAB counter is uint32 and measurements are bounded to one minute,
    // far below the physical rate required for two wraps. Unsigned subtraction
    // therefore preserves an exact single wrap without interpreting it as a
    // reset or a negative count.
    const refused = (end.ringDroppedTotal - start.ringDroppedTotal) >>> 0;
    displayRingMeasurementPairs.push({ start, end });
    ringRefusedFramesPerMeasurementWindow.push(refused);
  }
  const ringRefusedFramesBetweenMeasurementWindows: (number | null)[] = [];
  for (let index = 1; index < displayRingMeasurementPairs.length; index += 1) {
    const previous = displayRingMeasurementPairs[index - 1];
    const current = displayRingMeasurementPairs[index];
    if (
      previous === undefined ||
      previous === null ||
      current === undefined ||
      current === null ||
      current.start.atMs < previous.end.atMs ||
      current.start.atMs - previous.end.atMs > MAX_PRESENTATION_DURATION_MS ||
      current.start.observationEpoch !== previous.end.observationEpoch ||
      presentationLineageOf(current.start.sessionEpoch) !==
        presentationLineageOf(previous.end.sessionEpoch)
    ) {
      displayRingMeasurementEventsComplete = false;
      ringRefusedFramesBetweenMeasurementWindows.push(null);
      continue;
    }
    ringRefusedFramesBetweenMeasurementWindows.push(
      (current.start.ringDroppedTotal - previous.end.ringDroppedTotal) >>> 0,
    );
  }
  let ringRefusedFrameCount = 0;
  if (displayRingMeasurementPairs.length > 0) {
    const first = displayRingMeasurementPairs[0];
    const last = displayRingMeasurementPairs[displayRingMeasurementPairs.length - 1];
    if (
      first === undefined ||
      first === null ||
      last === undefined ||
      last === null ||
      first.start.observationEpoch !== last.end.observationEpoch ||
      presentationLineageOf(first.start.sessionEpoch) !==
        presentationLineageOf(last.end.sessionEpoch)
    ) {
      displayRingMeasurementEventsComplete = false;
    } else {
      ringRefusedFrameCount = (last.end.ringDroppedTotal - first.start.ringDroppedTotal) >>> 0;
      const partitionedCount = [
        ...ringRefusedFramesPerMeasurementWindow,
        ...ringRefusedFramesBetweenMeasurementWindows,
      ].reduce<number | null>(
        (sum, count) =>
          sum === null || count === null || sum + count > MAX_UINT32_SEQUENCE ? null : sum + count,
        0,
      );
      if (partitionedCount === null || partitionedCount !== ringRefusedFrameCount) {
        displayRingMeasurementEventsComplete = false;
      }
    }
  }
  const ringRefusalAccountingComplete =
    presentationMeasurementEventsComplete && displayRingMeasurementEventsComplete;
  // Retain all events for causal joins and completeness checks. Stage distributions,
  // however, describe the requested workload, not its typed setup/cleanup commands.
  // An invalid/open explicit window never falls back to the whole trace.
  const inMeasuredStageScope = (atMs: number): boolean =>
    presentationMeasurementBoundaries.length === 0 ||
    findPresentationMeasurementWindow(presentationMeasurementWindows, atMs) !== undefined;
  let displayedInputHighWater = 0;
  // An out-of-band repaint can replace a fence while the previous render's
  // sequences are still in flight, producing a second completion under a seen
  // `renderSeq`. Both are poisoned rather than guessed between: the sub-terms
  // drop out while `displayApplyToPaintMs` itself is left exactly as it was.
  const seenFrameRenderSeqs = new Set<number>();
  const poisonedRenderSeqs = new Set<number>();
  const frameCompleteByRenderSeq = new Map<
    number,
    Extract<TerminalPerfEvent, { kind: 'frame_complete' }>
  >();
  frameComplete = frameComplete.filter((event) => {
    if (
      displayedInputHighWater !== 0 &&
      event.displayInputSeq !== displayedInputHighWater &&
      !inputSequenceAdvances(displayedInputHighWater, event.displayInputSeq)
    ) {
      // Authoritative content remains in every later render in a session.
      // A regressing sequence is broken provenance; excluding the frame keeps
      // it from manufacturing a late "pre-authority" prediction sample.
      frameCompleteEventsComplete = false;
      return false;
    }
    displayedInputHighWater = advanceInputSequence(displayedInputHighWater, event.displayInputSeq);
    if (seenFrameRenderSeqs.has(event.renderSeq)) {
      poisonedRenderSeqs.add(event.renderSeq);
    } else {
      seenFrameRenderSeqs.add(event.renderSeq);
      frameCompleteByRenderSeq.set(event.renderSeq, event);
    }
    return true;
  });
  const inputAcks = [...inputAckBySeq.values()].sort((left, right) => left.atMs - right.atMs);

  const inputs = [...inputQueued.values()].sort((left, right) => left.atMs - right.atMs);
  for (let index = 1; index < inputs.length; index += 1) {
    const previous = inputs[index - 1];
    const current = inputs[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.inputSeq !== previous.inputSeq &&
      !inputSequenceAdvances(previous.inputSeq, current.inputSeq)
    ) {
      inputEventsComplete = false;
    }
  }
  const maxIndexedEvents = Math.max(
    displayReceived.length,
    displayApplied.length,
    frameComplete.length,
    inputAcks.length,
  );
  const sequenceIndex = new FirstSequenceAtOrAfterIndex(maxIndexedEvents);
  const firstDisplayReceives = sequenceIndex.match(
    displayReceived,
    inputs,
    (event) => event.inputSeq,
  );
  const firstDisplayApplies = sequenceIndex.match(
    displayApplied,
    inputs,
    (event) => event.inputSeq,
  );
  const firstDisplayPaints = sequenceIndex.match(
    frameComplete,
    inputs,
    (event) => event.displayInputSeq,
  );
  const firstInputAcks = sequenceIndex.match(inputAcks, inputs, (event) => event.inputSeq);
  const admissionToSentComplete =
    inputEventsComplete &&
    inputSentEventsComplete &&
    inputs.length > 0 &&
    inputs.every((input) => {
      const sent = inputSentBySeq.get(input.inputSeq);
      return sent !== undefined && sent.atMs >= input.admittedAtMs;
    });
  const sentToAckComplete =
    admissionToSentComplete &&
    inputAckEventsComplete &&
    inputs.every((input, index) => {
      const sent = inputSentBySeq.get(input.inputSeq);
      const ack = firstInputAcks[index];
      return sent !== undefined && ack !== undefined && ack.atMs >= sent.atMs;
    });
  const inputAckJoinComplete =
    inputEventsComplete &&
    inputAckEventsComplete &&
    inputs.length > 0 &&
    inputs.every((input, index) => {
      const ack = firstInputAcks[index];
      return ack !== undefined && ack.atMs >= input.admittedAtMs;
    });
  const inputAckNetworkFloorComplete =
    sentToAckComplete &&
    firstInputAcks.every((ack) => ack !== undefined && ack.networkRttMs !== null);
  const predictionMatches = matchExactPredictionPaints(
    frameComplete,
    inputQueued,
    predictionAppliedBySeq,
  );
  const predictionSubmissions = matchExactPredictionPaints(
    [...renderEndBySeq.values()]
      .filter((event) => !duplicateSubmissionRenderSeqs.has(event.renderSeq))
      .sort((a, b) => a.atMs - b.atMs),
    inputQueued,
    predictionAppliedBySeq,
  );

  // Render-level accounting. Counted over distinct frames rather than over
  // samples, because several inputs routinely land in one frame and would
  // otherwise each report the same render again.
  let joinedFenceRenderCount = 0;
  let missingRenderStartCount = 0;
  let missingRenderEndCount = 0;
  let latestSubmittedFrameCount = 0;
  let supersededFrameCount = 0;
  let invalidatedFrameCount = 0;
  let renderMembershipComplete = true;
  const fenceOwnerJoined = (
    start: Extract<TerminalPerfEvent, { kind: 'render_start' }>,
  ): boolean => {
    if (start.gate !== 'fence' && start.gate !== 'fence-and-opportunity') return true;
    const owner = frameCompleteByRenderSeq.get(start.fenceReleasedRenderSeq);
    return (
      owner !== undefined &&
      !poisonedRenderSeqs.has(owner.renderSeq) &&
      owner.atMs === start.fenceReleasedAtMs &&
      owner.atMs <= start.atMs &&
      (start.wantedAtMs === 0 || owner.atMs >= start.wantedAtMs)
    );
  };
  for (const frame of frameComplete) {
    if (frame.completionDisposition === 'latest-submitted') latestSubmittedFrameCount += 1;
    else if (frame.completionDisposition === 'superseded') supersededFrameCount += 1;
    else invalidatedFrameCount += 1;
    if (poisonedRenderSeqs.has(frame.renderSeq)) continue;
    const start = renderStartBySeq.get(frame.renderSeq);
    const end = renderEndBySeq.get(frame.renderSeq);
    if (start === undefined) {
      missingRenderStartCount += 1;
      renderJoinComplete = false;
    }
    if (end === undefined) {
      missingRenderEndCount += 1;
      renderJoinComplete = false;
    }
    if (end !== undefined && !sameCompletedRenderMembership(end, frame)) {
      renderMembershipComplete = false;
      renderJoinComplete = false;
    }
    if (start !== undefined && !fenceOwnerJoined(start)) renderJoinComplete = false;
    if (start !== undefined && end !== undefined && end.completionMode === 'gpu-queue') {
      joinedFenceRenderCount += 1;
    }
  }

  let gpuQueueRenderCount = 0;
  let noFenceRenderCount = 0;
  let atlasUploadRenderCount = 0;
  let drainedDisplayRenderCount = 0;
  const steadySubmitMs: (number | null)[] = [];
  for (const [renderSeq, end] of renderEndBySeq) {
    if (end.completionMode === 'gpu-queue') gpuQueueRenderCount += 1;
    else noFenceRenderCount += 1;
    if (end.atlasUploaded) atlasUploadRenderCount += 1;
    if (end.drainedDisplay) drainedDisplayRenderCount += 1;
    // Steady state means neither growing the glyph atlas nor coalescing a
    // display backlog; both make a frame's CPU cost unrepresentative.
    if (end.completionMode !== 'gpu-queue' || end.atlasUploaded || end.drainedDisplay) continue;
    const start = renderStartBySeq.get(renderSeq);
    if (start === undefined) continue;
    steadySubmitMs.push(delta(start.atMs, end.atMs));
  }

  let immediateGateCount = 0;
  let fenceGateCount = 0;
  let opportunityGateCount = 0;
  let fenceAndOpportunityGateCount = 0;
  let opportunityLowConfidenceCount = 0;
  const opportunityDelayRequestedMs: (number | null)[] = [];
  const opportunityPeriodMs: (number | null)[] = [];
  for (const start of renderStartBySeq.values()) {
    if (start.gate === 'immediate') immediateGateCount += 1;
    else if (start.gate === 'fence') fenceGateCount += 1;
    else if (start.gate === 'opportunity') opportunityGateCount += 1;
    else fenceAndOpportunityGateCount += 1;
    opportunityPeriodMs.push(start.refreshPeriodMs);
    if (start.gate !== 'opportunity' && start.gate !== 'fence-and-opportunity') continue;
    opportunityDelayRequestedMs.push(start.opportunityDelayMs);
    // Confidence is independent of the effective presentation opportunity period:
    // a confidence dip does not replace its observed bound with 60Hz.
    if (start.refreshConfidence01 < 0.5) opportunityLowConfidenceCount += 1;
  }
  const opportunityGatedCount = opportunityGateCount + fenceAndOpportunityGateCount;

  // Main publishes `session_start` before the terminal worker has necessarily
  // discarded its old presentation transaction. Build presentation-only joins
  // from the worker's epoch boundary, independently of the general render
  // indexes above, so a reused render identity on either side of that handoff
  // cannot poison or satisfy the current epoch.
  const presentationScopeStartAtMs = Math.max(
    latestSessionStartAtMs,
    latestPresentationEpochBoundaryAtMs,
  );
  const presentationRenderStartBySeq = new Map<
    number,
    Extract<TerminalPerfEvent, { kind: 'render_start' }>
  >();
  const presentationRenderEndBySeq = new Map<
    number,
    Extract<TerminalPerfEvent, { kind: 'render_end' }>
  >();
  const presentationFrameCompleteByRenderSeq = new Map<
    number,
    Extract<TerminalPerfEvent, { kind: 'frame_complete' }>
  >();
  const presentationDisplayApplied: Extract<
    TerminalPerfEvent,
    { kind: 'worker_display_applied' }
  >[] = [];
  let presentationDisplayAppliedEventsComplete = true;
  let presentationRenderStartEventsComplete = true;
  let presentationRenderEndEventsComplete = true;
  let presentationFrameCompleteEventsComplete = true;
  for (const event of events) {
    if (event.atMs < presentationScopeStartAtMs) continue;
    if (event.kind === 'worker_display_applied') {
      if (!validDisplayPerfEvent(event)) {
        presentationDisplayAppliedEventsComplete = false;
        continue;
      }
      presentationDisplayApplied.push(event);
      continue;
    }
    if (event.kind === 'render_start') {
      if (!validRenderStartPerfEvent(event)) {
        presentationRenderStartEventsComplete = false;
        continue;
      }
      const current = presentationRenderStartBySeq.get(event.renderSeq);
      if (current === undefined) presentationRenderStartBySeq.set(event.renderSeq, event);
      else if (event.atMs !== current.atMs) presentationRenderStartEventsComplete = false;
      continue;
    }
    if (event.kind === 'render_end') {
      if (!validRenderEndPerfEvent(event)) {
        presentationRenderEndEventsComplete = false;
        continue;
      }
      const current = presentationRenderEndBySeq.get(event.renderSeq);
      if (current === undefined) presentationRenderEndBySeq.set(event.renderSeq, event);
      else if (event.atMs !== current.atMs) presentationRenderEndEventsComplete = false;
      continue;
    }
    if (event.kind !== 'frame_complete') continue;
    if (!validFrameCompletePerfEvent(event)) {
      presentationFrameCompleteEventsComplete = false;
      continue;
    }
    const current = presentationFrameCompleteByRenderSeq.get(event.renderSeq);
    if (current === undefined) presentationFrameCompleteByRenderSeq.set(event.renderSeq, event);
    else if (event.atMs !== current.atMs) presentationFrameCompleteEventsComplete = false;
  }

  interface PresentationTransactionMembership {
    appliedDatagramCount: number;
    fecRecoveredDatagramCount: number;
    rowCount: number;
    byteLength: number;
    displaySeqs: Set<number>;
    firstAppliedDisplaySeq: number;
    lastAppliedDisplaySeq: number;
    presentationIds: Set<number>;
    earliestAppliedAtMs: number;
    latestAppliedAtMs: number;
  }
  presentationDisplayApplied.sort((left, right) => left.atMs - right.atMs);
  const presentationMembershipByTransaction = new Map<string, PresentationTransactionMembership>();
  for (const applied of presentationDisplayApplied) {
    // A causal/header-only frame still contributes to input/display timing but
    // owns no renderer transaction. Keeping it out of presentation membership
    // prevents transaction zero from becoming an artificial missing commit.
    if (!applied.authoritativeVisualMutation) continue;
    const key = displayFrameKey(applied.generation, applied.presentationTransactionSeq);
    let membership = presentationMembershipByTransaction.get(key);
    if (membership === undefined) {
      membership = {
        appliedDatagramCount: 0,
        fecRecoveredDatagramCount: 0,
        rowCount: 0,
        byteLength: 0,
        displaySeqs: new Set(),
        firstAppliedDisplaySeq: applied.displaySeq,
        lastAppliedDisplaySeq: applied.displaySeq,
        presentationIds: new Set(),
        earliestAppliedAtMs: Number.POSITIVE_INFINITY,
        latestAppliedAtMs: Number.NEGATIVE_INFINITY,
      };
      presentationMembershipByTransaction.set(key, membership);
    }
    membership.appliedDatagramCount += 1;
    if (applied.fecRecovered) membership.fecRecoveredDatagramCount += 1;
    membership.rowCount += applied.rowCount;
    membership.byteLength += applied.byteLength;
    membership.displaySeqs.add(applied.displaySeq);
    membership.lastAppliedDisplaySeq = applied.displaySeq;
    membership.presentationIds.add(applied.presentationId);
    membership.earliestAppliedAtMs = Math.min(membership.earliestAppliedAtMs, applied.atMs);
    membership.latestAppliedAtMs = Math.max(membership.latestAppliedAtMs, applied.atMs);
  }

  const presentationDatagrams: (number | null)[] = [];
  const measuredWindowByTransaction = new Map<string, number>();
  const measuredVisualCommitCountByWindow = new Map<number, number>();
  let presentationStageMembershipComplete = true;
  for (const [key, membership] of presentationMembershipByTransaction) {
    if (presentationMeasurementBoundaries.length === 0) {
      measuredWindowByTransaction.set(key, 0);
      continue;
    }
    const owner = findPresentationMeasurementInterval(
      presentationMeasurementWindows,
      membership.earliestAppliedAtMs,
      membership.latestAppliedAtMs,
    );
    if (owner === false) presentationStageMembershipComplete = false;
    else if (owner !== undefined) measuredWindowByTransaction.set(key, owner.measurementId);
  }
  const presentationRows: (number | null)[] = [];
  const presentationBytes: (number | null)[] = [];
  const firstApplyToCommit: (number | null)[] = [];
  const lastApplyToCommit: (number | null)[] = [];
  const firstReceiveToCommit: (number | null)[] = [];
  const deadlineOverrun: (number | null)[] = [];
  let coherentCommitCount = 0;
  let urgentCommitCount = 0;
  let authoritativeVisualCommitCount = 0;
  let discardedDatagramCount = 0;
  let discardedRowCount = 0;
  let discardedByteCount = 0;
  const discardedTransactionCountByReason: Record<TerminalPresentationDiscardReason, number> = {
    resync: 0,
    'epoch-reset': 0,
    teardown: 0,
  };
  let frameBudgetExceededCount = 0;
  let deadlineExceededCount = 0;
  let presentationFenceJoinComplete = true;
  let presentationMembershipComplete = presentationDisplayAppliedEventsComplete;
  const presentationIdsByCommit = new Map<
    Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>,
    ReadonlySet<number>
  >();
  const firstReceiveAtMsByCommit = new Map<
    Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>,
    number
  >();
  const seenPresentationTransactions = new Set<string>();
  const firstReceiveByFrame = new Map<string, number>();
  const firstReceiveByPresentation = new Map<string, number>();
  for (const received of displayReceived) {
    if (received.atMs < latestPresentationEpochBoundaryAtMs) continue;
    const frameKey = displayFrameKey(received.generation, received.displaySeq);
    const frameAtMs = firstReceiveByFrame.get(frameKey);
    if (frameAtMs === undefined || received.atMs < frameAtMs) {
      firstReceiveByFrame.set(frameKey, received.atMs);
    }
    if (received.presentationId === 0) continue;
    const presentationKey = displayFrameKey(received.generation, received.presentationId);
    const presentationAtMs = firstReceiveByPresentation.get(presentationKey);
    if (presentationAtMs === undefined || received.atMs < presentationAtMs) {
      firstReceiveByPresentation.set(presentationKey, received.atMs);
    }
  }

  for (const commit of presentationCommits) {
    if (commit.coherent) coherentCommitCount += 1;
    else urgentCommitCount += 1;
    if (commit.authoritativeVisualChange) authoritativeVisualCommitCount += 1;
    const transactionKey = displayFrameKey(commit.generation, commit.transactionSeq);
    const membership = presentationMembershipByTransaction.get(transactionKey);
    // Apply ownership follows this exact transaction through a delayed commit
    // and fence. Scoping by commit time silently dropped the very tail under test.
    const measuredWindowId = measuredWindowByTransaction.get(transactionKey);
    const inScope = measuredWindowId !== undefined;
    if (!inScope && inMeasuredStageScope(commit.atMs)) presentationStageMembershipComplete = false;
    if (measuredWindowId !== undefined && commit.authoritativeVisualChange) {
      measuredVisualCommitCountByWindow.set(
        measuredWindowId,
        (measuredVisualCommitCountByWindow.get(measuredWindowId) ?? 0) + 1,
      );
    }
    if (inScope) {
      presentationDatagrams.push(commit.datagramCount);
      presentationRows.push(commit.rowCount);
      presentationBytes.push(commit.byteLength);
      firstApplyToCommit.push(commit.firstApplyToCommitMs);
      lastApplyToCommit.push(commit.lastApplyToCommitMs);
    }

    if (
      seenPresentationTransactions.has(transactionKey) ||
      membership === undefined ||
      membership.appliedDatagramCount !== commit.datagramCount ||
      membership.rowCount !== commit.rowCount ||
      membership.byteLength !== commit.byteLength ||
      membership.displaySeqs.size !== commit.datagramCount ||
      !membership.displaySeqs.has(commit.firstDisplaySeq) ||
      !membership.displaySeqs.has(commit.lastDisplaySeq) ||
      membership.latestAppliedAtMs > commit.atMs ||
      (commit.coherent && membership.presentationIds.size === 0) ||
      (commit.firstPresentationId !== 0 &&
        !membership.presentationIds.has(commit.firstPresentationId)) ||
      (commit.lastPresentationId !== 0 &&
        !membership.presentationIds.has(commit.lastPresentationId))
    ) {
      presentationMembershipComplete = false;
    } else {
      presentationIdsByCommit.set(commit, membership.presentationIds);
    }
    seenPresentationTransactions.add(transactionKey);

    // Exact first/last frame identities cover ordinary and reordered drains;
    // every transaction-labelled presentation identity covers recovered or
    // reordered interiors as well. Avoid a commit×receive scan here—report
    // construction is expected to stay O(events log events).
    let firstReceiveAtMs = Number.POSITIVE_INFINITY;
    for (const candidate of [
      firstReceiveByFrame.get(displayFrameKey(commit.generation, commit.firstDisplaySeq)),
      firstReceiveByFrame.get(displayFrameKey(commit.generation, commit.lastDisplaySeq)),
      firstReceiveByPresentation.get(
        displayFrameKey(commit.generation, commit.firstPresentationId),
      ),
      firstReceiveByPresentation.get(displayFrameKey(commit.generation, commit.lastPresentationId)),
    ]) {
      if (candidate !== undefined) firstReceiveAtMs = Math.min(firstReceiveAtMs, candidate);
    }
    if (membership !== undefined) {
      for (const presentationId of membership.presentationIds) {
        const candidate = firstReceiveByPresentation.get(
          displayFrameKey(commit.generation, presentationId),
        );
        if (candidate !== undefined) firstReceiveAtMs = Math.min(firstReceiveAtMs, candidate);
      }
    }
    if (inScope) {
      firstReceiveToCommit.push(
        Number.isFinite(firstReceiveAtMs) ? delta(firstReceiveAtMs, commit.atMs) : null,
      );
    }
    if (Number.isFinite(firstReceiveAtMs)) firstReceiveAtMsByCommit.set(commit, firstReceiveAtMs);

    const overrun = commit.deadlineOverrunMs;
    if (inScope) {
      deadlineOverrun.push(overrun);
      if (overrun > 0.25) deadlineExceededCount += 1;
    }
    const renderStart = presentationRenderStartBySeq.get(commit.renderSeq);
    const renderEnd = presentationRenderEndBySeq.get(commit.renderSeq);
    if (
      inScope &&
      renderStart !== undefined &&
      renderEnd !== undefined &&
      renderEnd.atMs - renderStart.atMs > commit.refreshPeriodMs
    ) {
      frameBudgetExceededCount += 1;
    }
  }
  for (const discard of presentationDiscards) {
    const transactionKey = displayFrameKey(discard.generation, discard.transactionSeq);
    const membership = presentationMembershipByTransaction.get(transactionKey);
    if (
      seenPresentationTransactions.has(transactionKey) ||
      membership === undefined ||
      membership.appliedDatagramCount !== discard.appliedDatagramCount ||
      membership.displaySeqs.size !== discard.appliedDatagramCount ||
      membership.rowCount !== discard.rowCount ||
      membership.byteLength !== discard.byteLength ||
      membership.firstAppliedDisplaySeq !== discard.firstDisplaySeq ||
      membership.lastAppliedDisplaySeq !== discard.lastDisplaySeq ||
      membership.latestAppliedAtMs > discard.atMs
    ) {
      presentationMembershipComplete = false;
    }
    seenPresentationTransactions.add(transactionKey);
    discardedDatagramCount += discard.appliedDatagramCount;
    discardedRowCount += discard.rowCount;
    discardedByteCount += discard.byteLength;
    discardedTransactionCountByReason[discard.reason] += 1;
  }
  // The join is bidirectional. An applied datagram whose transaction never
  // committed is unresolved at capture time (or its commit record was lost),
  // so a coherence tail computed without it cannot be called complete.
  if (seenPresentationTransactions.size !== presentationMembershipByTransaction.size) {
    presentationMembershipComplete = false;
  } else {
    for (const transactionKey of presentationMembershipByTransaction.keys()) {
      if (!seenPresentationTransactions.has(transactionKey)) {
        presentationMembershipComplete = false;
        break;
      }
    }
  }

  const visualPresentationCommits = presentationCommits.filter(
    (commit) => commit.authoritativeVisualChange,
  );
  let presentationExposureFenceComplete = presentationMembershipComplete;
  for (const commit of visualPresentationCommits) {
    const renderEnd = presentationRenderEndBySeq.get(commit.renderSeq);
    if (
      renderEnd === undefined ||
      renderEnd.atMs < commit.atMs ||
      (renderEnd.completionMode === 'gpu-queue' &&
        presentationFrameCompleteByRenderSeq.get(commit.renderSeq) === undefined)
    ) {
      presentationFenceJoinComplete = false;
    }
    const frame = presentationFrameCompleteByRenderSeq.get(commit.renderSeq);
    if (
      renderEnd?.completionMode !== 'gpu-queue' ||
      frame === undefined ||
      renderEnd.atMs < commit.atMs ||
      frame.atMs < commit.atMs ||
      frame.previousPollAtMs > frame.atMs ||
      frame.atMs < renderEnd.atMs
    ) {
      // A task yield or renderer submission timestamp says nothing about when
      // this visible update completed on the GPU. Exclude it and mark the
      // coherence distribution incomplete rather than manufacturing zero.
      presentationExposureFenceComplete = false;
    }
  }
  const visualPresentationFences = visualPresentationCommits
    .map((commit) => ({
      commit,
      frame: presentationFrameCompleteByRenderSeq.get(commit.renderSeq),
      renderEnd: presentationRenderEndBySeq.get(commit.renderSeq),
    }))
    .filter(
      (
        pair,
      ): pair is {
        commit: Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>;
        frame: Extract<TerminalPerfEvent, { kind: 'frame_complete' }>;
        renderEnd: Extract<TerminalPerfEvent, { kind: 'render_end' }> & {
          completionMode: 'gpu-queue';
        };
      } =>
        pair.frame !== undefined &&
        pair.renderEnd?.completionMode === 'gpu-queue' &&
        pair.renderEnd.atMs >= pair.commit.atMs &&
        pair.frame.atMs >= pair.commit.atMs &&
        pair.frame.previousPollAtMs <= pair.frame.atMs &&
        pair.frame.atMs >= pair.renderEnd.atMs,
    )
    .map(({ commit, frame, renderEnd }) => ({
      atMs: frame.atMs,
      commit,
      frame,
      renderEnd,
    }))
    .sort((left, right) => left.atMs - right.atMs);
  const measuredPresentationFences = visualPresentationFences.filter((pair) =>
    measuredWindowByTransaction.has(
      displayFrameKey(pair.commit.generation, pair.commit.transactionSeq),
    ),
  );
  const commitToGpuFence = measuredPresentationFences.map((pair) =>
    delta(pair.commit.atMs, pair.frame.atMs),
  );
  const presentationRenderSubmission = measuredPresentationFences.map((pair) => {
    const start = presentationRenderStartBySeq.get(pair.commit.renderSeq);
    return start === undefined ? null : delta(start.atMs, pair.renderEnd.atMs);
  });

  interface PresentationGroupAggregate {
    visibleCommitCount: number;
    firstFenceObservedAtMs: number;
    lastFenceObservedAtMs: number;
  }
  const presentationGroups = new Map<string, PresentationGroupAggregate>();
  const completedVisualFenceByGroup = new Map<string, number>();
  for (const pair of visualPresentationFences) {
    const presentationIds = presentationIdsByCommit.get(pair.commit);
    if (presentationIds === undefined) {
      presentationExposureFenceComplete = false;
      continue;
    }
    for (const presentationId of presentationIds) {
      const key = displayFrameKey(pair.commit.generation, presentationId);
      completedVisualFenceByGroup.set(
        key,
        Math.max(completedVisualFenceByGroup.get(key) ?? 0, pair.frame.atMs),
      );
      if (!pair.commit.coherent) continue;
      let aggregate = presentationGroups.get(key);
      if (aggregate === undefined) {
        aggregate = {
          visibleCommitCount: 0,
          firstFenceObservedAtMs: Number.POSITIVE_INFINITY,
          lastFenceObservedAtMs: Number.NEGATIVE_INFINITY,
        };
        presentationGroups.set(key, aggregate);
      }
      aggregate.visibleCommitCount += 1;
      aggregate.firstFenceObservedAtMs = Math.min(
        aggregate.firstFenceObservedAtMs,
        pair.frame.atMs,
      );
      aggregate.lastFenceObservedAtMs = Math.max(aggregate.lastFenceObservedAtMs, pair.frame.atMs);
    }
  }

  const partialPresentationExposure: (number | null)[] = [];
  const commitsPerPresentation: (number | null)[] = [];
  let groupsWithMultipleCommits = 0;
  for (const aggregate of presentationGroups.values()) {
    commitsPerPresentation.push(aggregate.visibleCommitCount);
    if (aggregate.visibleCommitCount > 1) groupsWithMultipleCommits += 1;
    partialPresentationExposure.push(
      Number.isFinite(aggregate.firstFenceObservedAtMs)
        ? aggregate.lastFenceObservedAtMs - aggregate.firstFenceObservedAtMs
        : null,
    );
  }

  // A sender presentation id scopes one flush, so it cannot prove that several
  // independently identified flushes came from one logical PTY redraw. The E2E
  // harness supplies that missing provenance explicitly: it opens a window
  // after a READY marker and closes it after the workload's final marker. Use
  // authoritative apply intervals for membership and GPU fences for exposure;
  // the last fence may legitimately arrive after the end boundary.
  const visualSubmissionsByCommit = visualPresentationFences
    .map((pair) => {
      const membership = presentationMembershipByTransaction.get(
        displayFrameKey(pair.commit.generation, pair.commit.transactionSeq),
      );
      return {
        atMs: pair.commit.atMs,
        firstAppliedAtMs: membership?.earliestAppliedAtMs ?? Number.NaN,
        lastAppliedAtMs: membership?.latestAppliedAtMs ?? Number.NaN,
        fenceObservedAtMs: pair.frame.atMs,
        transactionSeq: pair.commit.transactionSeq,
        reason: pair.commit.reason,
        pureFecRecovery:
          membership !== undefined &&
          membership.appliedDatagramCount > 0 &&
          membership.fecRecoveredDatagramCount === membership.appliedDatagramCount,
        displayInputSeq: pair.commit.displayInputSeq,
        displayEchoHorizonSeq: pair.commit.displayEchoHorizonSeq,
        datagramCount: pair.commit.datagramCount,
        rowCount: pair.commit.rowCount,
        byteLength: pair.commit.byteLength,
        firstReceiveAtMs: firstReceiveAtMsByCommit.get(pair.commit) ?? Number.NaN,
        refreshPeriodMs: pair.commit.refreshPeriodMs,
        fenceObservationIntervalMs:
          pair.frame.atMs - Math.max(pair.frame.previousPollAtMs, pair.renderEnd.atMs),
      };
    })
    .sort((left, right) => left.atMs - right.atMs || left.transactionSeq - right.transactionSeq);
  const measurementWindowExposure: (number | null)[] = [];
  const measurementWindowToCompletedPresentationFence: (number | null)[] = [];
  const commitsPerMeasurementWindow: (number | null)[] = [];
  const ordinaryCommitsPerMeasurementWindow: (number | null)[] = [];
  const repairCommitsPerMeasurementWindow: (number | null)[] = [];
  const expiredRepairCommitsPerMeasurementWindow: (number | null)[] = [];
  const ordinaryMeasurementWindowExposure: (number | null)[] = [];
  const rowsPerMeasurementWindow: (number | null)[] = [];
  const datagramsPerMeasurementWindow: (number | null)[] = [];
  const bytesPerMeasurementWindow: (number | null)[] = [];
  const firstDisplayReceiveToCompletedPresentationFence: (number | null)[] = [];
  const refreshPeriodPerMeasurementWindow: (number | null)[] = [];
  const fenceObservationIntervalPerMeasurementWindow: (number | null)[] = [];
  const completionByMeasurementId = new Map<
    number,
    { fenceObservedAtMs: number; displayInputHighWater: number; echoHorizonHighWater: number }
  >();
  let measurementWindowsWithMultipleCommits = 0;
  let presentationMeasurementMembershipComplete = true;
  let presentationMeasurementReceiveComplete = displayReceivedEventsComplete;
  let presentationMeasurementTailComplete = true;
  const hasPostBoundaryWork = (
    candidates: Iterable<{ readonly atMs: number }>,
    endAtMs: number,
    nextInputAtMs: number,
  ): boolean => {
    for (const candidate of candidates) {
      if (candidate.atMs > endAtMs && candidate.atMs < nextInputAtMs) return true;
    }
    return false;
  };
  for (const window of presentationMeasurementWindows) {
    let nextInputAtMs = Number.POSITIVE_INFINITY;
    for (const input of inputs) {
      if (input.atMs > window.endAtMs) {
        nextInputAtMs = Math.min(nextInputAtMs, input.atMs);
      }
    }
    // `end` is a harness-issued quiescence claim. Any display work before the
    // next local input proves the boundary closed ahead of a reordered/repair
    // tail and must fail closed instead of silently shortening exposure.
    if (
      hasPostBoundaryWork(displayReceived, window.endAtMs, nextInputAtMs) ||
      hasPostBoundaryWork(workerQueuedByFrame.values(), window.endAtMs, nextInputAtMs) ||
      hasPostBoundaryWork(displayApplied, window.endAtMs, nextInputAtMs) ||
      hasPostBoundaryWork(presentationCommits, window.endAtMs, nextInputAtMs) ||
      hasPostBoundaryWork(presentationDiscards, window.endAtMs, nextInputAtMs)
    ) {
      presentationMeasurementTailComplete = false;
    }
    let firstFenceObservedAtMs = Number.POSITIVE_INFINITY;
    let lastFenceObservedAtMs = Number.NEGATIVE_INFINITY;
    let visibleCommitCount = 0;
    let ordinaryCommitCount = 0;
    let repairCommitCount = 0;
    let expiredRepairCommitCount = 0;
    let firstOrdinaryFenceObservedAtMs = Number.POSITIVE_INFINITY;
    let lastOrdinaryFenceObservedAtMs = Number.NEGATIVE_INFINITY;
    let datagramCount = 0;
    let rowCount = 0;
    let byteLength = 0;
    let firstDisplayReceiveAtMs = Number.POSITIVE_INFINITY;
    let maximumRefreshPeriodMs = Number.NEGATIVE_INFINITY;
    let maximumFenceObservationIntervalMs = Number.NEGATIVE_INFINITY;
    let displayInputHighWater = 0;
    let echoHorizonHighWater = 0;
    for (const submission of visualSubmissionsByCommit) {
      // Window membership is the authoritative mutation, not its later commit.
      // A commit/fence after the closing marker is precisely the tail the
      // measurement must retain rather than silently shorten.
      if (
        !Number.isFinite(submission.firstAppliedAtMs) ||
        !Number.isFinite(submission.lastAppliedAtMs) ||
        submission.lastAppliedAtMs < window.startAtMs ||
        submission.firstAppliedAtMs > window.endAtMs
      ) {
        continue;
      }
      if (
        submission.firstAppliedAtMs < window.startAtMs ||
        submission.lastAppliedAtMs > window.endAtMs
      ) {
        // A renderer transaction is indivisible presentation membership. If
        // it straddles a harness boundary, rows/bytes from outside this exact
        // workload cannot be separated honestly, so retain the diagnostic
        // value but poison acceptance completeness.
        presentationMeasurementMembershipComplete = false;
      }
      visibleCommitCount += 1;
      if (submission.reason === 'repair-deadline-expired') {
        // FEC provenance cannot turn an expired, potentially partial repair
        // presentation into a successfully completed repair transaction.
        expiredRepairCommitCount += 1;
      } else if (submission.reason === 'repair-target-satisfied' || submission.pureFecRecovery) {
        repairCommitCount += 1;
      } else {
        ordinaryCommitCount += 1;
        firstOrdinaryFenceObservedAtMs = Math.min(
          firstOrdinaryFenceObservedAtMs,
          submission.fenceObservedAtMs,
        );
        lastOrdinaryFenceObservedAtMs = Math.max(
          lastOrdinaryFenceObservedAtMs,
          submission.fenceObservedAtMs,
        );
      }
      datagramCount += submission.datagramCount;
      rowCount += submission.rowCount;
      byteLength += submission.byteLength;
      if (!Number.isFinite(submission.firstReceiveAtMs)) {
        presentationMeasurementReceiveComplete = false;
      } else {
        firstDisplayReceiveAtMs = Math.min(firstDisplayReceiveAtMs, submission.firstReceiveAtMs);
      }
      displayInputHighWater = advanceInputSequence(
        displayInputHighWater,
        submission.displayInputSeq,
      );
      echoHorizonHighWater = advanceInputSequence(
        echoHorizonHighWater,
        submission.displayEchoHorizonSeq,
      );
      maximumRefreshPeriodMs = Math.max(maximumRefreshPeriodMs, submission.refreshPeriodMs);
      maximumFenceObservationIntervalMs = Math.max(
        maximumFenceObservationIntervalMs,
        submission.fenceObservationIntervalMs,
      );
      firstFenceObservedAtMs = Math.min(firstFenceObservedAtMs, submission.fenceObservedAtMs);
      lastFenceObservedAtMs = Math.max(lastFenceObservedAtMs, submission.fenceObservedAtMs);
    }
    if ((measuredVisualCommitCountByWindow.get(window.measurementId) ?? 0) !== visibleCommitCount) {
      presentationStageMembershipComplete = false;
    }
    commitsPerMeasurementWindow.push(visibleCommitCount);
    ordinaryCommitsPerMeasurementWindow.push(ordinaryCommitCount);
    repairCommitsPerMeasurementWindow.push(repairCommitCount);
    expiredRepairCommitsPerMeasurementWindow.push(expiredRepairCommitCount);
    ordinaryMeasurementWindowExposure.push(
      ordinaryCommitCount <= 1 ? 0 : lastOrdinaryFenceObservedAtMs - firstOrdinaryFenceObservedAtMs,
    );
    if (visibleCommitCount === 0 || lastFenceObservedAtMs < window.startAtMs) {
      presentationMeasurementMembershipComplete = false;
    }
    rowsPerMeasurementWindow.push(visibleCommitCount === 0 ? null : rowCount);
    datagramsPerMeasurementWindow.push(visibleCommitCount === 0 ? null : datagramCount);
    bytesPerMeasurementWindow.push(visibleCommitCount === 0 ? null : byteLength);
    refreshPeriodPerMeasurementWindow.push(
      visibleCommitCount === 0 ? null : maximumRefreshPeriodMs,
    );
    fenceObservationIntervalPerMeasurementWindow.push(
      visibleCommitCount === 0 ? null : maximumFenceObservationIntervalMs,
    );
    if (visibleCommitCount > 1) measurementWindowsWithMultipleCommits += 1;
    measurementWindowExposure.push(
      visibleCommitCount === 0 ? null : lastFenceObservedAtMs - firstFenceObservedAtMs,
    );
    measurementWindowToCompletedPresentationFence.push(
      visibleCommitCount === 0 ? null : lastFenceObservedAtMs - window.startAtMs,
    );
    firstDisplayReceiveToCompletedPresentationFence.push(
      visibleCommitCount === 0 || !Number.isFinite(firstDisplayReceiveAtMs)
        ? null
        : lastFenceObservedAtMs - firstDisplayReceiveAtMs,
    );
    if (visibleCommitCount > 0) {
      completionByMeasurementId.set(window.measurementId, {
        fenceObservedAtMs: lastFenceObservedAtMs,
        displayInputHighWater,
        echoHorizonHighWater,
      });
    }
  }

  // One explicit measurement window describes one logical workload, not one
  // response per key. Attribute its completed-authoritative fence only to the
  // final input admitted before the window closes. The window-start metric
  // above separately reports whole-workload duration, including command entry.
  const completionTriggerInputByMeasurementId = new Map<
    number,
    Extract<TerminalPerfEvent, { kind: 'input_queued' }>
  >();
  for (const input of inputs) {
    const window = findPresentationMeasurementWindow(presentationMeasurementWindows, input.atMs);
    if (window === undefined) continue;
    const current = completionTriggerInputByMeasurementId.get(window.measurementId);
    if (current === undefined || input.atMs >= current.atMs) {
      completionTriggerInputByMeasurementId.set(window.measurementId, input);
    }
  }

  // This is the same cumulative-sequence query as the historical display
  // fence join, but restricted to submissions that actually changed
  // authoritative geometry. Keep it indexed: a profiling trace routinely has
  // tens of thousands of inputs, and a per-input `.find` would turn report
  // generation into quadratic diagnostic work.
  const visualFenceIndex = new FirstSequenceAtOrAfterIndex(visualPresentationFences.length);
  const firstVisualPresentations = visualFenceIndex.match(
    visualPresentationFences,
    inputs,
    (entry) => entry.commit.displayInputSeq,
  );
  // The same query over the newest input each submission's pixels could
  // answer. The daemon can read an echo before it has confirmed the echoed
  // write: that submission's barrier is then the older input, a header-only
  // frame raises the barrier afterwards, and no later submission need follow.
  // Such pixels answer the input once an applied frame has confirmed it.
  const echoHorizonFenceIndex = new FirstSequenceAtOrAfterIndex(visualPresentationFences.length);
  const firstAnsweringPresentations = echoHorizonFenceIndex.match(
    visualPresentationFences,
    inputs,
    (entry) => entry.commit.displayEchoHorizonSeq,
  );

  const samples: TerminalLatencySample[] = [];
  let completedPresentationEligibleInputCount = 0;
  let completedPresentationCensoredInputCount = 0;
  for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
    const input = inputs[inputIndex];
    if (input === undefined) continue;
    const firstPredictionPaint = predictionMatches.unavailable
      ? undefined
      : predictionMatches.firstPaintBySeq.get(input.inputSeq);
    const firstDisplayReceive = firstDisplayReceives[inputIndex];
    const firstDisplayApply = firstDisplayApplies[inputIndex];
    const firstReceivedWorkerQueue =
      firstDisplayReceive === undefined
        ? undefined
        : workerQueuedByFrame.get(
            displayFrameKey(firstDisplayReceive.generation, firstDisplayReceive.displaySeq),
          );
    const firstAppliedWorkerQueue =
      firstDisplayApply === undefined
        ? undefined
        : workerQueuedByFrame.get(
            displayFrameKey(firstDisplayApply.generation, firstDisplayApply.displaySeq),
          );
    const firstDisplayPaint = firstDisplayPaints[inputIndex];
    const firstVisualPresentation = firstAnsweringFence(
      firstVisualPresentations[inputIndex],
      firstAnsweringPresentations[inputIndex],
      firstDisplayApply,
    );
    let completedSenderPresentationAtMs: number | undefined;
    const measurementWindow = findPresentationMeasurementWindow(
      presentationMeasurementWindows,
      input.atMs,
    );
    const measurementCompletion =
      measurementWindow === undefined
        ? undefined
        : completionByMeasurementId.get(measurementWindow.measurementId);
    const isCompletionTrigger =
      measurementWindow !== undefined &&
      completionTriggerInputByMeasurementId.get(measurementWindow.measurementId)?.inputSeq ===
        input.inputSeq;
    const completedVisualPresentationAtMs =
      isCompletionTrigger && measurementCompletion !== undefined
        ? windowAnsweredAtMs(measurementCompletion, input.inputSeq, firstDisplayApply)
        : undefined;
    if (isCompletionTrigger) {
      completedPresentationEligibleInputCount += 1;
      if (completedVisualPresentationAtMs === undefined) {
        completedPresentationCensoredInputCount += 1;
      }
    }
    if (firstVisualPresentation !== undefined) {
      const presentationIds = presentationIdsByCommit.get(firstVisualPresentation.commit);
      if (!firstVisualPresentation.commit.coherent || presentationIds?.size === 0) {
        completedSenderPresentationAtMs = firstVisualPresentation.atMs;
      } else if (presentationIds !== undefined) {
        completedSenderPresentationAtMs = firstVisualPresentation.atMs;
        for (const presentationId of presentationIds) {
          const completedAtMs = completedVisualFenceByGroup.get(
            displayFrameKey(firstVisualPresentation.commit.generation, presentationId),
          );
          if (completedAtMs !== undefined) {
            completedSenderPresentationAtMs = Math.max(
              completedSenderPresentationAtMs,
              completedAtMs,
            );
          }
        }
      }
    }
    // Join the painting frame by identity. `renderSeq` zero is an event from
    // before the field existed; a poisoned sequence had two completions.
    const paintRenderSeq = firstDisplayPaint?.renderSeq ?? 0;
    const joinable = paintRenderSeq !== 0 && !poisonedRenderSeqs.has(paintRenderSeq);
    const renderStart = joinable ? renderStartBySeq.get(paintRenderSeq) : undefined;
    const renderEnd = joinable ? renderEndBySeq.get(paintRenderSeq) : undefined;
    // Sub-terms require actual submitted-work completion evidence. Missing
    // completion primitives cannot be credited by a scheduler task boundary.
    const fenced = renderEnd?.completionMode === 'gpu-queue' && renderStart !== undefined;
    // This partitions JS-observed readiness, not physical GPU execution.
    // Browser sync caches can still report unready after GPU completion.
    // With no preceding false poll, submission is the observation baseline.
    let lastUnreadyPollAtMs: number | null = null;
    if (fenced && firstDisplayPaint !== undefined && renderEnd !== undefined) {
      if (firstDisplayPaint.previousPollAtMs > firstDisplayPaint.atMs) {
        // A poll cannot postdate the completion it preceded; the trace is corrupt.
        renderJoinComplete = false;
      } else {
        lastUnreadyPollAtMs = Math.max(firstDisplayPaint.previousPollAtMs, renderEnd.atMs);
      }
    }
    // Input ACKs are cumulative: ACK N confirms every input through N, so an
    // ACK can legitimately complete several samples after transport batching.
    const ack = firstInputAcks[inputIndex] ?? null;
    const keyboardCommit = keyboardCommitBySeq.get(input.inputSeq);
    const predictionSubmission = predictionSubmissions.unavailable
      ? undefined
      : predictionSubmissions.firstPaintBySeq.get(input.inputSeq);
    const inputSent = inputSentBySeq.get(input.inputSeq);
    const sentToAckMs =
      inputSent === undefined || ack === null ? null : delta(inputSent.atMs, ack.atMs);
    const networkRttFloorMs = ack?.networkRttMs ?? null;
    samples.push({
      inputSeq: input.inputSeq,
      physicalInputToAdmissionMs: delta(input.atMs, input.admittedAtMs),
      touchToCommitMs:
        keyboardCommit === undefined
          ? null
          : delta(keyboardCommit.touchStartedAtMs, keyboardCommit.atMs),
      touchToPredictionSubmissionMs:
        keyboardCommit === undefined
          ? null
          : delta(keyboardCommit.touchStartedAtMs, predictionSubmission?.atMs),
      inputToPredictionSubmissionMs: delta(input.atMs, predictionSubmission?.atMs),
      inputToPredictionPaintMs: delta(input.atMs, firstPredictionPaint?.atMs),
      admissionToInputSentMs: delta(input.admittedAtMs, inputSent?.atMs),
      inputSentToAckMs: sentToAckMs,
      inputAckNetworkRttFloorMs: networkRttFloorMs,
      inputAckNonNetworkUpperBoundMs:
        sentToAckMs === null || networkRttFloorMs === null
          ? null
          : Math.max(0, sentToAckMs - networkRttFloorMs),
      inputToDisplayReceiveMs: delta(input.atMs, firstDisplayReceive?.atMs),
      displayReceiveToWorkerQueueMs:
        firstDisplayReceive !== undefined && firstReceivedWorkerQueue !== undefined
          ? delta(firstDisplayReceive.atMs, firstReceivedWorkerQueue.atMs)
          : null,
      workerQueueToDisplayApplyMs:
        firstAppliedWorkerQueue !== undefined && firstDisplayApply !== undefined
          ? delta(firstAppliedWorkerQueue.atMs, firstDisplayApply.atMs)
          : null,
      inputToDisplayApplyMs: delta(input.atMs, firstDisplayApply?.atMs),
      inputToDisplayPaintMs: delta(input.atMs, firstDisplayPaint?.atMs),
      inputToAuthoritativeVisualFenceMs: delta(input.atMs, firstVisualPresentation?.atMs),
      inputToCompletedSenderPresentationFenceMs: delta(input.atMs, completedSenderPresentationAtMs),
      inputToCompletedAuthoritativePresentationFenceMs: delta(
        input.atMs,
        completedVisualPresentationAtMs,
      ),
      displayApplyToPaintMs:
        firstDisplayApply !== undefined && firstDisplayPaint !== undefined
          ? delta(firstDisplayApply.atMs, firstDisplayPaint.atMs)
          : null,
      displayApplyToRenderStartMs:
        fenced && firstDisplayApply !== undefined && renderStart !== undefined
          ? delta(firstDisplayApply.atMs, renderStart.atMs)
          : null,
      renderStartToRenderEndMs:
        fenced && renderStart !== undefined && renderEnd !== undefined
          ? delta(renderStart.atMs, renderEnd.atMs)
          : null,
      renderEndToDisplayPaintMs:
        fenced && renderEnd !== undefined && firstDisplayPaint !== undefined
          ? delta(renderEnd.atMs, firstDisplayPaint.atMs)
          : null,
      renderEndToLastUnreadyPollMs:
        lastUnreadyPollAtMs !== null && renderEnd !== undefined
          ? delta(renderEnd.atMs, lastUnreadyPollAtMs)
          : null,
      fenceObservationIntervalMs:
        lastUnreadyPollAtMs !== null && firstDisplayPaint !== undefined
          ? delta(lastUnreadyPollAtMs, firstDisplayPaint.atMs)
          : null,
      displayApplyToRenderWantedMs:
        fenced && firstDisplayApply !== undefined && renderStart !== undefined
          ? delta(firstDisplayApply.atMs, renderStart.wantedAtMs)
          : null,
      renderFenceGateMs:
        fenced &&
        renderStart !== undefined &&
        fenceOwnerJoined(renderStart) &&
        (renderStart.gate === 'fence' || renderStart.gate === 'fence-and-opportunity')
          ? renderStart.fenceWaitMs
          : null,
      renderOpportunityGateMs:
        fenced &&
        renderStart !== undefined &&
        (renderStart.gate === 'opportunity' || renderStart.gate === 'fence-and-opportunity')
          ? renderStart.opportunityWaitMs
          : null,
      inputAckMs: delta(input.atMs, ack?.atMs),
    });
  }

  const predictionPercentiles = percentiles(
    samples.map((sample) => sample.inputToPredictionPaintMs),
    sessionBoundaryEventsComplete &&
      inputEventsComplete &&
      predictionAppliedEventsComplete &&
      frameCompleteEventsComplete &&
      renderMembershipComplete &&
      predictionMatches.complete,
    predictionMatches.unavailable,
  );
  const predictionPaintedCount = predictionPercentiles.count;
  // Exclusion is deliberately NOT incompleteness: absent completion and duplicate-seq
  // frames are counted in `renderInstrumentation` and left out of the
  // percentiles, which is a correct measurement, not a broken one.
  const decompositionComplete =
    sessionBoundaryEventsComplete &&
    inputEventsComplete &&
    displayAppliedEventsComplete &&
    frameCompleteEventsComplete &&
    renderStartEventsComplete &&
    renderEndEventsComplete &&
    renderJoinComplete;
  const presentationCoherenceComplete =
    sessionBoundaryEventsComplete &&
    renderMembershipComplete &&
    presentationEpochEventsComplete &&
    presentationCommitEventsComplete &&
    presentationDiscardEventsComplete &&
    presentationDisplayAppliedEventsComplete &&
    presentationRenderStartEventsComplete &&
    presentationRenderEndEventsComplete &&
    presentationFrameCompleteEventsComplete &&
    presentationMembershipComplete &&
    presentationFenceJoinComplete &&
    presentationExposureFenceComplete;
  const presentationMeasurementComplete =
    presentationCoherenceComplete &&
    presentationMeasurementEventsComplete &&
    presentationStageMembershipComplete &&
    presentationMeasurementMembershipComplete &&
    presentationMeasurementTailComplete;

  // Main-thread cadence is scoped by the same explicit workload windows as
  // presentation coherence. A gap contributes when its visible rAF interval
  // overlaps the window; requiring intervals across both boundaries prevents
  // a stalled/unobserved tail from looking like a clean short capture.
  const mainThreadRafGaps: (number | null)[] = [];
  const mainThreadFrameBudgetOverruns: (number | null)[] = [];
  const mainThreadMissedFramesPerGap: (number | null)[] = [];
  const mainThreadMissedFramesPerWindow: (number | null)[] = [];
  const observedMainLongTasks = new Set<Extract<TerminalPerfEvent, { kind: 'main_long_task' }>>();
  let mainThreadComplete =
    presentationMeasurementComplete &&
    mainFrameCadenceEventsComplete &&
    mainLongTaskEventsComplete &&
    presentationMeasurementEventsComplete &&
    presentationMeasurementWindows.length > 0;
  let sampledMainThreadWindowCount = 0;
  let estimatedMissedFrameCount = 0;
  let frameBudgetExceededIntervalCount = 0;
  let longTaskTotalMs = 0;
  let longTaskObserverSupported: boolean | null = null;
  for (let windowIndex = 0; windowIndex < presentationMeasurementWindows.length; windowIndex += 1) {
    const window = presentationMeasurementWindows[windowIndex];
    const refreshPeriodMs = refreshPeriodPerMeasurementWindow[windowIndex];
    if (window === undefined || typeof refreshPeriodMs !== 'number' || !(refreshPeriodMs > 0)) {
      mainThreadMissedFramesPerWindow.push(null);
      mainThreadComplete = false;
      continue;
    }
    let startsCovered = false;
    let endsCovered = false;
    let sampledIntervals = 0;
    let windowMissedFrames = 0;
    for (const event of mainFrameCadence) {
      const intervalStartAtMs = event.atMs - event.gapMs;
      if (event.atMs < window.startAtMs || intervalStartAtMs > window.endAtMs) continue;
      sampledIntervals += 1;
      if (intervalStartAtMs <= window.startAtMs && event.atMs >= window.startAtMs) {
        startsCovered = true;
      }
      if (intervalStartAtMs <= window.endAtMs && event.atMs >= window.endAtMs) {
        endsCovered = true;
      }
      if (longTaskObserverSupported === null) {
        longTaskObserverSupported = event.longTaskObserverSupported;
      } else if (longTaskObserverSupported !== event.longTaskObserverSupported) {
        // Capability cannot change inside one page lifetime. Mixed values mean
        // the event stream was truncated/spliced and must fail closed.
        mainThreadComplete = false;
      }
      const budgetOverrunMs = Math.max(0, event.gapMs - refreshPeriodMs);
      // rAF is not compositor telemetry. This integer is intentionally named
      // an estimate and uses the nearest number of elapsed refresh periods;
      // sub-half-period scheduling jitter never fabricates a missed frame.
      const estimatedMissedFrames = Math.max(0, Math.round(event.gapMs / refreshPeriodMs) - 1);
      // Exceeding one measured frame budget is distinct from estimating that a
      // whole refresh opportunity was skipped. A 1.25-period gap estimates no
      // missed frame, but is still over budget and must not disappear into the
      // integer rounding above. Keep the raw overrun untouched; only this
      // count applies the explicit instrumentation/scheduling tolerance.
      if (budgetOverrunMs > MAIN_THREAD_FRAME_BUDGET_TOLERANCE_MS) {
        frameBudgetExceededIntervalCount += 1;
      }
      estimatedMissedFrameCount += estimatedMissedFrames;
      windowMissedFrames += estimatedMissedFrames;
      mainThreadRafGaps.push(event.gapMs);
      mainThreadFrameBudgetOverruns.push(budgetOverrunMs);
      mainThreadMissedFramesPerGap.push(estimatedMissedFrames);
    }
    if (sampledIntervals === 0 || !startsCovered || !endsCovered) {
      mainThreadMissedFramesPerWindow.push(null);
      mainThreadComplete = false;
    } else {
      sampledMainThreadWindowCount += 1;
      mainThreadMissedFramesPerWindow.push(windowMissedFrames);
    }
    for (const event of mainLongTasks) {
      const taskEndAtMs = event.atMs + event.durationMs;
      const overlapMs =
        Math.min(taskEndAtMs, window.endAtMs) - Math.max(event.atMs, window.startAtMs);
      if (overlapMs <= 0) continue;
      observedMainLongTasks.add(event);
      // Windows are validated non-overlapping, so clipped overlap sums the
      // exact task time inside measured workloads without double counting.
      longTaskTotalMs += overlapMs;
    }
  }
  const mainLongTaskDurations = [...observedMainLongTasks].map((event) => event.durationMs);
  const longTaskMeasurementsUnavailable = longTaskObserverSupported !== true;

  // Account source-level operations independently at ingress and application,
  // then pair repeated identities in timestamp order. A terminal apply without
  // an ingress is accepted only when the apply itself carries exact FEC
  // provenance; loss must never turn arbitrary missing instrumentation into
  // apparently complete evidence.
  const browserDisplayIoInScope = browserDisplayIo.filter(
    (event) =>
      presentationMeasurementWindows.length === 0 ||
      findPresentationMeasurementWindow(presentationMeasurementWindows, event.atMs) !== undefined,
  );
  const ingressByFrame = new Map<
    string,
    Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>[]
  >();
  const ingressCursorByFrame = new Map<string, number>();
  let transportIngressUpdateCount = 0;
  let rejectedTransportIngressUpdateCount = 0;
  let terminalApplyUpdateCount = 0;
  let transportFecIngressUpdateCount = 0;
  let terminalFecProcessingUpdateCount = 0;
  let fecPayloadByteCount = 0;
  let fecExplicitCopyCount = 0;
  let fecExplicitCopiedByteCount = 0;
  let fecExplicitAllocationRequestCount = 0;
  let fecExplicitAllocationRequestedByteCount = 0;
  let fecExplicitObjectAllocationRequestCount = 0;
  let browserIoPayloadByteCount = 0;
  let browserIoExplicitCopyCount = 0;
  let browserIoExplicitCopiedByteCount = 0;
  let browserIoExplicitAllocationRequestCount = 0;
  let browserIoExplicitAllocationRequestedByteCount = 0;
  let browserIoExplicitObjectAllocationRequestCount = 0;
  for (const event of browserDisplayIoInScope) {
    browserIoPayloadByteCount += event.payloadByteLength;
    browserIoExplicitCopyCount += event.explicitCopyCount;
    browserIoExplicitCopiedByteCount += event.explicitCopiedBytes;
    browserIoExplicitAllocationRequestCount += event.explicitAllocationRequestCount;
    browserIoExplicitAllocationRequestedByteCount += event.explicitAllocationRequestedBytes;
    browserIoExplicitObjectAllocationRequestCount += event.explicitObjectAllocationRequestCount;
    if (event.stage === 'transport_fec_ingress' || event.stage === 'terminal_fec') {
      if (event.stage === 'transport_fec_ingress') transportFecIngressUpdateCount += 1;
      else terminalFecProcessingUpdateCount += 1;
      fecPayloadByteCount += event.payloadByteLength;
      fecExplicitCopyCount += event.explicitCopyCount;
      fecExplicitCopiedByteCount += event.explicitCopiedBytes;
      fecExplicitAllocationRequestCount += event.explicitAllocationRequestCount;
      fecExplicitAllocationRequestedByteCount += event.explicitAllocationRequestedBytes;
      fecExplicitObjectAllocationRequestCount += event.explicitObjectAllocationRequestCount;
    } else if (event.stage === 'transport_ingress') {
      transportIngressUpdateCount += 1;
      if (!event.admitted) {
        rejectedTransportIngressUpdateCount += 1;
        continue;
      }
      const key = browserDisplayIoFrameKey(event);
      const retained = ingressByFrame.get(key);
      if (retained === undefined) ingressByFrame.set(key, [event]);
      else retained.push(event);
    } else {
      terminalApplyUpdateCount += 1;
    }
  }
  const endToEndExplicitCopiesPerUpdate: (number | null)[] = [];
  const endToEndExplicitCopiedBytesPerPayloadByte: (number | null)[] = [];
  const endToEndExplicitAllocationRequestsPerUpdate: (number | null)[] = [];
  const endToEndExplicitAllocationRequestedBytesPerUpdate: (number | null)[] = [];
  const endToEndExplicitAllocationRequestedBytesPerPayloadByte: (number | null)[] = [];
  const endToEndExplicitObjectAllocationRequestsPerUpdate: (number | null)[] = [];
  let endToEndMatchedPayloadByteCount = 0;
  let endToEndMatchedUpdateCount = 0;
  let fecRecoveredTerminalApplyUpdateCount = 0;
  for (const applied of browserDisplayIoInScope) {
    if (applied.stage !== 'terminal_apply') continue;
    const key = browserDisplayIoFrameKey(applied);
    const ingress = ingressByFrame.get(key);
    const cursor = ingressCursorByFrame.get(key) ?? 0;
    const received = ingress?.[cursor];
    // Events were sorted by the shared absolute clock before grouping. A
    // future ingress cannot own this apply, but it remains available for a
    // subsequent transformation with the same wrapping wire identity.
    if (applied.fecRecovered) {
      if (received !== undefined && received.atMs <= applied.atMs) {
        // A reconstructed apply cannot also consume an admitted data datagram.
        browserDisplayIoEventsComplete = false;
      } else {
        fecRecoveredTerminalApplyUpdateCount += 1;
      }
      continue;
    }
    if (received === undefined || received.atMs > applied.atMs) {
      browserDisplayIoEventsComplete = false;
      continue;
    }
    ingressCursorByFrame.set(key, cursor + 1);
    if (received.payloadByteLength !== applied.payloadByteLength) {
      browserDisplayIoEventsComplete = false;
      continue;
    }
    const payloadBytes = applied.payloadByteLength;
    const copyCount = received.explicitCopyCount + applied.explicitCopyCount;
    const copiedBytes = received.explicitCopiedBytes + applied.explicitCopiedBytes;
    const allocationRequestCount =
      received.explicitAllocationRequestCount + applied.explicitAllocationRequestCount;
    const allocationRequestedBytes =
      received.explicitAllocationRequestedBytes + applied.explicitAllocationRequestedBytes;
    const objectAllocationRequestCount =
      received.explicitObjectAllocationRequestCount + applied.explicitObjectAllocationRequestCount;
    endToEndMatchedUpdateCount += 1;
    endToEndMatchedPayloadByteCount += payloadBytes;
    endToEndExplicitCopiesPerUpdate.push(copyCount);
    endToEndExplicitCopiedBytesPerPayloadByte.push(copiedBytes / payloadBytes);
    endToEndExplicitAllocationRequestsPerUpdate.push(allocationRequestCount);
    endToEndExplicitAllocationRequestedBytesPerUpdate.push(allocationRequestedBytes);
    endToEndExplicitAllocationRequestedBytesPerPayloadByte.push(
      allocationRequestedBytes / payloadBytes,
    );
    endToEndExplicitObjectAllocationRequestsPerUpdate.push(objectAllocationRequestCount);
  }
  let workerReceiptToDecodeScopeComplete = true;
  let decodeToApplyScopeComplete = true;
  let displayPumpScopeComplete = true;
  const measuredInterval = (endAtMs: number, durationMs: number | null): boolean | undefined => {
    if (durationMs === null) return false;
    if (presentationMeasurementBoundaries.length === 0) return true;
    const owner = findPresentationMeasurementInterval(
      presentationMeasurementWindows,
      endAtMs - durationMs,
      endAtMs,
    );
    return owner === false ? false : owner === undefined ? undefined : true;
  };
  const workerReceiptToDecode = displayReceived
    .filter((event) => {
      const scope = measuredInterval(event.atMs, event.workerReceiptToDecodeMs);
      if (scope === false) workerReceiptToDecodeScopeComplete = false;
      return scope === true;
    })
    .map((event) => event.workerReceiptToDecodeMs);
  const decodeToApply = displayApplied
    .filter((event) => {
      const scope = measuredInterval(event.atMs, event.decodeToApplyMs);
      if (scope === false) decodeToApplyScopeComplete = false;
      return scope === true;
    })
    .map((event) => event.decodeToApplyMs);
  const measuredDisplayPumps = displayPumps.filter((event) => {
    const scope = measuredInterval(event.atMs, event.durationMs);
    if (scope === false) displayPumpScopeComplete = false;
    return scope === true;
  });
  const pumpDurations = measuredDisplayPumps.map((event) => event.durationMs);
  const pumpBudgets = measuredDisplayPumps.map((event) => event.budgetMs);
  const pumpDatagrams = measuredDisplayPumps.map((event) => event.processedDatagramCount);
  const pumpRows = measuredDisplayPumps.map((event) => event.processedRowCount);
  const pumpQueueHighWater = measuredDisplayPumps.map((event) => event.queueHighWater);
  const pumpQueueRemaining = measuredDisplayPumps.map((event) => event.queueRemaining);
  const pumpRingBytesAtStart = measuredDisplayPumps.map((event) => event.ringBytesAtStart);
  const pumpRingBytesAtEnd = measuredDisplayPumps.map((event) => event.ringBytesAtEnd);
  if (rawMetricSamples !== undefined) {
    const retain = (
      name: TerminalLatencyRawMetricName,
      values: readonly (number | null)[],
    ): void => {
      const destination = rawMetricSamples[name];
      for (const value of values) {
        if (value !== null && Number.isFinite(value) && value >= 0) destination.push(value);
      }
    };
    const retainSampleField = (
      name: TerminalLatencyRawMetricName,
      field: Exclude<keyof TerminalLatencySample, 'inputSeq'>,
    ): void =>
      retain(
        name,
        samples.map((sample) => sample[field]),
      );

    for (const field of [
      'physicalInputToAdmissionMs',
      'touchToCommitMs',
      'touchToPredictionSubmissionMs',
      'inputToPredictionSubmissionMs',
      'inputToPredictionPaintMs',
      'admissionToInputSentMs',
      'inputSentToAckMs',
      'inputAckNetworkRttFloorMs',
      'inputAckNonNetworkUpperBoundMs',
      'inputToDisplayReceiveMs',
      'displayReceiveToWorkerQueueMs',
      'workerQueueToDisplayApplyMs',
      'inputToDisplayApplyMs',
      'inputToDisplayPaintMs',
      'inputToAuthoritativeVisualFenceMs',
      'inputToCompletedSenderPresentationFenceMs',
      'inputToCompletedAuthoritativePresentationFenceMs',
      'displayApplyToPaintMs',
      'displayApplyToRenderStartMs',
      'renderStartToRenderEndMs',
      'renderEndToDisplayPaintMs',
      'renderEndToLastUnreadyPollMs',
      'fenceObservationIntervalMs',
      'inputAckMs',
    ] as const) {
      retainSampleField(field, field);
    }
    retainSampleField('renderGate.applyToRenderWantedMs', 'displayApplyToRenderWantedMs');
    retainSampleField('renderGate.fenceGateWaitMs', 'renderFenceGateMs');
    retainSampleField('renderGate.opportunityGateWaitMs', 'renderOpportunityGateMs');

    retain(
      'daemonPipeline.recvToPtyUs',
      daemonInputTimings.map((event) => event.recvToPtyUs),
    );
    retain(
      'daemonPipeline.ptyToReadUs',
      daemonInputTimings.map((event) => event.ptyToReadUs),
    );
    retain(
      'daemonPipeline.gridApplyUs',
      daemonInputTimings.map((event) => event.gridApplyUs),
    );
    retain(
      'daemonPipeline.displayCoalesceUs',
      daemonDisplayTimings.map((event) => event.displayCoalesceUs),
    );
    retain(
      'daemonPipeline.selectCaptureUs',
      daemonDisplayTimings.map((event) => event.selectCaptureUs),
    );
    retain(
      'daemonPipeline.prepareQueueUs',
      daemonDisplayTimings.map((event) => event.prepareQueueUs),
    );
    retain(
      'daemonPipeline.encodeUs',
      daemonDisplayTimings.map((event) => event.encodeUs),
    );
    retain(
      'daemonPipeline.compressionUs',
      daemonDisplayTimings.map((event) => event.compressionUs),
    );
    retain(
      'daemonPipeline.completionQueueUs',
      daemonDisplayTimings.map((event) => event.completionQueueUs),
    );
    retain(
      'daemonPipeline.transportSubmitUs',
      daemonDisplayTimings.map((event) => event.transportSubmitUs),
    );
    retain('daemonPipeline.gridMutationToEncodedUs', daemonGridMutationToEncodedUs);
    retain('daemonPipeline.queuedBeforeTransportSubmitUs', daemonQueuedBeforeTransportSubmitUs);
    retain('daemonPipeline.displayOperationTotalUs', daemonDisplayOperationTotalUs);
    retain('daemonPipeline.totalUs', daemonTotalUs);
    retain('daemonPipeline.writeCompletionUs', daemonWriteCompletionUs);
    retain('daemonPipeline.ackTransmitUs', daemonAckTransmitUs);
    retain(
      'daemonPipeline.ownerCpuUs',
      daemonInputTimings.map((event) => event.ownerCpuUs),
    );
    retain(
      'daemonPipeline.ownerOffCpuUs',
      daemonInputTimings.map((event) => event.ownerOffCpuUs),
    );
    retain(
      'daemonPipeline.ownerQuinnWaitUs',
      daemonInputTimings.map((event) => event.ownerQuinnWaitUs),
    );
    retain(
      'daemonPipeline.ownerRegistryWaitUs',
      daemonInputTimings.map((event) => event.ownerRegistryWaitUs),
    );
    retain(
      'daemonPipeline.flushLockWaitUs',
      daemonInputTimings.map((event) => event.flushLockWaitUs),
    );
    retain(
      'daemonPipeline.displayOperationOwnerOffCpuUs',
      daemonDisplayTimings.map((event) => event.ownerOffCpuUs),
    );
    retain(
      'daemonPipeline.displayOperationLockWaitUs',
      daemonDisplayTimings.map((event) => event.flushLockWaitUs),
    );

    retain('displayPipeline.workerReceiptToDecodeMs', workerReceiptToDecode);
    retain('displayPipeline.decodeToApplyMs', decodeToApply);
    retain('displayPipeline.pumpDurationMs', pumpDurations);
    retain('displayPipeline.datagramsPerPump', pumpDatagrams);
    retain('displayPipeline.rowsPerPump', pumpRows);
    retain('displayPipeline.encodedDeferralQueueHighWaterPerPump', pumpQueueHighWater);
    retain('displayPipeline.ringBytesAtPumpStart', pumpRingBytesAtStart);
    retain('displayPipeline.ringBytesAtPumpEnd', pumpRingBytesAtEnd);
    retain(
      'displayPipeline.ringRefusedFrameCountPerMeasurementWindow',
      ringRefusedFramesPerMeasurementWindow,
    );
    retain(
      'displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows',
      ringRefusedFramesBetweenMeasurementWindows,
    );
    retain('mainThread.rafGapMs', mainThreadRafGaps);
    retain('mainThread.frameBudgetOverrunMs', mainThreadFrameBudgetOverruns);
    retain('mainThread.estimatedMissedFramesPerGap', mainThreadMissedFramesPerGap);
    retain('mainThread.estimatedMissedFramesPerMeasurementWindow', mainThreadMissedFramesPerWindow);
    retain('mainThread.longTaskDurationMs', mainLongTaskDurations);

    retain('browserDisplayIo.endToEndExplicitCopiesPerUpdate', endToEndExplicitCopiesPerUpdate);
    retain(
      'browserDisplayIo.endToEndExplicitCopiedBytesPerPayloadByte',
      endToEndExplicitCopiedBytesPerPayloadByte,
    );
    retain(
      'browserDisplayIo.endToEndExplicitAllocationRequestsPerUpdate',
      endToEndExplicitAllocationRequestsPerUpdate,
    );
    retain(
      'browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerUpdate',
      endToEndExplicitAllocationRequestedBytesPerUpdate,
    );
    retain(
      'browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerPayloadByte',
      endToEndExplicitAllocationRequestedBytesPerPayloadByte,
    );
    retain(
      'browserDisplayIo.endToEndExplicitObjectAllocationRequestsPerUpdate',
      endToEndExplicitObjectAllocationRequestsPerUpdate,
    );

    retain('presentation.datagramsPerCommit', presentationDatagrams);
    retain('presentation.rowsPerCommit', presentationRows);
    retain('presentation.bytesPerCommit', presentationBytes);
    retain('presentation.firstApplyToCommitMs', firstApplyToCommit);
    retain('presentation.lastApplyToCommitMs', lastApplyToCommit);
    retain('presentation.commitToGpuFenceMs', commitToGpuFence);
    retain('presentation.renderSubmissionMs', presentationRenderSubmission);
    retain('presentation.partialPresentationExposureMs', partialPresentationExposure);
    retain('presentation.commitsPerPresentation', commitsPerPresentation);
    retain('presentation.measurementWindowExposureMs', measurementWindowExposure);
    retain(
      'presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs',
      measurementWindowToCompletedPresentationFence,
    );
    retain('presentation.commitsPerMeasurementWindow', commitsPerMeasurementWindow);
    retain('presentation.ordinaryCommitsPerMeasurementWindow', ordinaryCommitsPerMeasurementWindow);
    retain('presentation.repairCommitsPerMeasurementWindow', repairCommitsPerMeasurementWindow);
    retain(
      'presentation.expiredRepairCommitsPerMeasurementWindow',
      expiredRepairCommitsPerMeasurementWindow,
    );
    retain('presentation.ordinaryMeasurementWindowExposureMs', ordinaryMeasurementWindowExposure);
    retain('presentation.rowsPerMeasurementWindow', rowsPerMeasurementWindow);
    retain('presentation.refreshPeriodPerMeasurementWindowMs', refreshPeriodPerMeasurementWindow);
    retain(
      'presentation.fenceObservationIntervalPerMeasurementWindowMs',
      fenceObservationIntervalPerMeasurementWindow,
    );
    retain('presentation.datagramsPerMeasurementWindow', datagramsPerMeasurementWindow);
    retain('presentation.bytesPerMeasurementWindow', bytesPerMeasurementWindow);
    retain(
      'presentation.firstDisplayReceiveToCompletedPresentationFenceMs',
      firstDisplayReceiveToCompletedPresentationFence,
    );
  }
  return {
    frameCompletionBoundary: 'browser-observed-webgpu-queue-completion',
    sampleCount: samples.length,
    physicalInputToAdmissionMs: percentiles(
      samples.map((sample) => sample.physicalInputToAdmissionMs),
      sessionBoundaryEventsComplete && inputEventsComplete,
    ),
    touchToCommitMs: percentiles(
      samples.map((sample) => sample.touchToCommitMs),
      sessionBoundaryEventsComplete && inputEventsComplete && keyboardCommitEventsComplete,
    ),
    touchToPredictionSubmissionMs: percentiles(
      samples.map((sample) => sample.touchToPredictionSubmissionMs),
      sessionBoundaryEventsComplete &&
        inputEventsComplete &&
        keyboardCommitEventsComplete &&
        predictionAppliedEventsComplete &&
        renderEndEventsComplete &&
        predictionSubmissions.complete &&
        duplicateSubmissionRenderSeqs.size === 0,
    ),
    inputToPredictionSubmissionMs: percentiles(
      samples.map((sample) => sample.inputToPredictionSubmissionMs),
      sessionBoundaryEventsComplete &&
        inputEventsComplete &&
        predictionAppliedEventsComplete &&
        renderEndEventsComplete &&
        predictionSubmissions.complete &&
        duplicateSubmissionRenderSeqs.size === 0,
    ),
    inputToPredictionPaintMs: {
      ...predictionPercentiles,
      eligibleCount: predictionMatches.eligibleCount,
      coverageRatio:
        predictionPercentiles.complete &&
        !predictionMatches.unavailable &&
        predictionMatches.eligibleCount > 0
          ? predictionPaintedCount / predictionMatches.eligibleCount
          : null,
    },
    admissionToInputSentMs: percentiles(
      samples.map((sample) => sample.admissionToInputSentMs),
      sessionBoundaryEventsComplete && admissionToSentComplete,
    ),
    inputSentToAckMs: percentiles(
      samples.map((sample) => sample.inputSentToAckMs),
      sessionBoundaryEventsComplete && sentToAckComplete,
    ),
    inputAckNetworkRttFloorMs: percentiles(
      samples.map((sample) => sample.inputAckNetworkRttFloorMs),
      sessionBoundaryEventsComplete && inputAckNetworkFloorComplete,
    ),
    inputAckNonNetworkUpperBoundMs: percentiles(
      samples.map((sample) => sample.inputAckNonNetworkUpperBoundMs),
      sessionBoundaryEventsComplete && inputAckNetworkFloorComplete,
    ),
    inputToDisplayReceiveMs: percentiles(
      samples.map((sample) => sample.inputToDisplayReceiveMs),
      sessionBoundaryEventsComplete && inputEventsComplete && displayReceivedEventsComplete,
    ),
    displayReceiveToWorkerQueueMs: percentiles(
      samples.map((sample) => sample.displayReceiveToWorkerQueueMs),
      sessionBoundaryEventsComplete &&
        inputEventsComplete &&
        displayReceivedEventsComplete &&
        workerQueuedEventsComplete,
    ),
    workerQueueToDisplayApplyMs: percentiles(
      samples.map((sample) => sample.workerQueueToDisplayApplyMs),
      sessionBoundaryEventsComplete &&
        inputEventsComplete &&
        workerQueuedEventsComplete &&
        displayAppliedEventsComplete,
    ),
    inputToDisplayApplyMs: percentiles(
      samples.map((sample) => sample.inputToDisplayApplyMs),
      sessionBoundaryEventsComplete && inputEventsComplete && displayAppliedEventsComplete,
    ),
    inputToDisplayPaintMs: percentiles(
      samples.map((sample) => sample.inputToDisplayPaintMs),
      sessionBoundaryEventsComplete && inputEventsComplete && frameCompleteEventsComplete,
    ),
    inputToAuthoritativeVisualFenceMs: percentiles(
      samples.map((sample) => sample.inputToAuthoritativeVisualFenceMs),
      sessionBoundaryEventsComplete &&
        inputEventsComplete &&
        presentationCommitEventsComplete &&
        renderEndEventsComplete &&
        frameCompleteEventsComplete &&
        presentationFenceJoinComplete,
    ),
    inputToCompletedSenderPresentationFenceMs: percentiles(
      samples.map((sample) => sample.inputToCompletedSenderPresentationFenceMs),
      presentationCoherenceComplete,
    ),
    inputToCompletedAuthoritativePresentationFenceMs: {
      ...percentiles(
        samples.map((sample) => sample.inputToCompletedAuthoritativePresentationFenceMs),
        inputEventsComplete &&
          presentationMeasurementComplete &&
          completedPresentationCensoredInputCount === 0,
        presentationMeasurementWindows.length === 0,
      ),
      eligibleCount: completedPresentationEligibleInputCount,
      censoredCount: completedPresentationCensoredInputCount,
    },
    displayApplyToPaintMs: percentiles(
      samples.map((sample) => sample.displayApplyToPaintMs),
      sessionBoundaryEventsComplete &&
        inputEventsComplete &&
        displayAppliedEventsComplete &&
        frameCompleteEventsComplete,
    ),
    displayApplyToRenderStartMs: percentiles(
      samples.map((sample) => sample.displayApplyToRenderStartMs),
      decompositionComplete,
    ),
    renderStartToRenderEndMs: percentiles(
      samples.map((sample) => sample.renderStartToRenderEndMs),
      decompositionComplete,
    ),
    renderEndToDisplayPaintMs: percentiles(
      samples.map((sample) => sample.renderEndToDisplayPaintMs),
      decompositionComplete,
    ),
    renderEndToLastUnreadyPollMs: percentiles(
      samples.map((sample) => sample.renderEndToLastUnreadyPollMs),
      decompositionComplete,
    ),
    fenceObservationIntervalMs: percentiles(
      samples.map((sample) => sample.fenceObservationIntervalMs),
      decompositionComplete,
    ),
    renderGate: {
      immediateCount: immediateGateCount,
      fenceCount: fenceGateCount,
      opportunityCount: opportunityGateCount,
      fenceAndOpportunityCount: fenceAndOpportunityGateCount,
      unknownCount: missingRenderStartCount,
      applyToRenderWantedMs: percentiles(
        samples.map((sample) => sample.displayApplyToRenderWantedMs),
        decompositionComplete,
      ),
      fenceGateWaitMs: percentiles(
        samples.map((sample) => sample.renderFenceGateMs),
        decompositionComplete,
      ),
      opportunityGateWaitMs: percentiles(
        samples.map((sample) => sample.renderOpportunityGateMs),
        decompositionComplete,
      ),
      opportunityDelayRequestedMs: percentiles(
        opportunityDelayRequestedMs,
        renderStartEventsComplete,
      ),
      opportunityPeriodMs: percentiles(opportunityPeriodMs, renderStartEventsComplete),
      opportunityLowConfidenceRatio:
        opportunityGatedCount > 0 ? opportunityLowConfidenceCount / opportunityGatedCount : null,
    },
    renderInstrumentation: {
      latestSubmittedFrameCount,
      supersededFrameCount,
      invalidatedFrameCount,
      joinedFenceRenderCount,
      missingRenderStartCount,
      missingRenderEndCount,
      duplicateRenderSeqFrameCount: poisonedRenderSeqs.size,
      gpuQueueRenderCount,
      noFenceRenderCount,
      atlasUploadRenderCount,
      drainedDisplayRenderCount,
      renderStartToRenderEndSteadyMs: percentiles(
        steadySubmitMs,
        renderStartEventsComplete && renderEndEventsComplete,
      ),
    },
    daemonPipeline: {
      batchCount: daemonBatches.size,
      inputAttributedTotal: latestDaemonMetadata.inputAttributedTotal,
      inputDroppedTotal: latestDaemonMetadata.inputDroppedTotal,
      inputSkippedTotal: latestDaemonMetadata.inputSkippedTotal,
      pendingInputs: latestDaemonMetadata.pendingInputs,
      displayAttributedTotal: latestDaemonMetadata.displayAttributedTotal,
      displayDroppedTotal: latestDaemonMetadata.displayDroppedTotal,
      complete: daemonPipelineComplete,
      recvToPtyUs: percentiles(
        daemonInputTimings.map((event) => event.recvToPtyUs),
        daemonPipelineComplete,
      ),
      ptyToReadUs: percentiles(
        daemonInputTimings.map((event) => event.ptyToReadUs),
        daemonPipelineComplete,
      ),
      gridApplyUs: percentiles(
        daemonInputTimings.map((event) => event.gridApplyUs),
        daemonPipelineComplete,
      ),
      displayCoalesceUs: percentiles(
        daemonDisplayTimings.map((event) => event.displayCoalesceUs),
        daemonPipelineComplete,
      ),
      selectCaptureUs: percentiles(
        daemonDisplayTimings.map((event) => event.selectCaptureUs),
        daemonPipelineComplete,
      ),
      prepareQueueUs: percentiles(
        daemonDisplayTimings.map((event) => event.prepareQueueUs),
        daemonPipelineComplete,
      ),
      encodeUs: percentiles(
        daemonDisplayTimings.map((event) => event.encodeUs),
        daemonPipelineComplete,
      ),
      compressionUs: percentiles(
        daemonDisplayTimings.map((event) => event.compressionUs),
        daemonPipelineComplete,
      ),
      completionQueueUs: percentiles(
        daemonDisplayTimings.map((event) => event.completionQueueUs),
        daemonPipelineComplete,
      ),
      transportSubmitUs: percentiles(
        daemonDisplayTimings.map((event) => event.transportSubmitUs),
        daemonPipelineComplete,
      ),
      gridMutationToEncodedUs: percentiles(daemonGridMutationToEncodedUs, daemonPipelineComplete),
      queuedBeforeTransportSubmitUs: percentiles(
        daemonQueuedBeforeTransportSubmitUs,
        daemonPipelineComplete,
      ),
      displayOperationTotalUs: percentiles(daemonDisplayOperationTotalUs, daemonPipelineComplete),
      totalUs: percentiles(daemonTotalUs, daemonPipelineComplete),
      writeCompletionUs: percentiles(
        daemonWriteCompletionUs,
        daemonPipelineComplete && daemonWriteCompletionUs.length === daemonInputTimings.length,
      ),
      ackTransmitUs: percentiles(
        daemonAckTransmitUs,
        daemonPipelineComplete && daemonAckTransmitUs.length === daemonInputTimings.length,
      ),
      ownerCpuUs: percentiles(
        daemonInputTimings.map((event) => event.ownerCpuUs),
        daemonPipelineComplete,
      ),
      ownerOffCpuUs: percentiles(
        daemonInputTimings.map((event) => event.ownerOffCpuUs),
        daemonPipelineComplete,
      ),
      ownerQuinnWaitUs: percentiles(
        daemonInputTimings.map((event) => event.ownerQuinnWaitUs),
        daemonPipelineComplete,
      ),
      ownerRegistryWaitUs: percentiles(
        daemonInputTimings.map((event) => event.ownerRegistryWaitUs),
        daemonPipelineComplete,
      ),
      flushLockWaitUs: percentiles(
        daemonInputTimings.map((event) => event.flushLockWaitUs),
        daemonPipelineComplete,
      ),
      displayOperationOwnerOffCpuUs: percentiles(
        daemonDisplayTimings.map((event) => event.ownerOffCpuUs),
        daemonPipelineComplete,
      ),
      displayOperationLockWaitUs: percentiles(
        daemonDisplayTimings.map((event) => event.flushLockWaitUs),
        daemonPipelineComplete,
      ),
    },
    transportEgress: transportEgressReport(
      transportEgress,
      edgeForwardResidence,
      transportEgressEventsComplete,
    ),
    displayPipeline: {
      workerReceiptToDecodeMs: percentiles(
        workerReceiptToDecode,
        displayReceivedEventsComplete &&
          workerReceiptToDecodeScopeComplete &&
          presentationMeasurementComplete,
      ),
      decodeToApplyMs: percentiles(
        decodeToApply,
        displayAppliedEventsComplete &&
          decodeToApplyScopeComplete &&
          presentationMeasurementComplete,
      ),
      pumpDurationMs: percentiles(
        pumpDurations,
        displayPumpEventsComplete && displayPumpScopeComplete && presentationMeasurementComplete,
      ),
      pumpBudgetMs: percentiles(
        pumpBudgets,
        displayPumpEventsComplete && displayPumpScopeComplete && presentationMeasurementComplete,
      ),
      datagramsPerPump: percentiles(
        pumpDatagrams,
        displayPumpEventsComplete && displayPumpScopeComplete && presentationMeasurementComplete,
      ),
      rowsPerPump: percentiles(
        pumpRows,
        displayPumpEventsComplete && displayPumpScopeComplete && presentationMeasurementComplete,
      ),
      encodedDeferralQueueHighWaterPerPump: percentiles(
        pumpQueueHighWater,
        displayPumpEventsComplete && displayPumpScopeComplete && presentationMeasurementComplete,
      ),
      encodedDeferralQueueRemainingPerPump: percentiles(
        pumpQueueRemaining,
        displayPumpEventsComplete && displayPumpScopeComplete && presentationMeasurementComplete,
      ),
      ringBytesAtPumpStart: percentiles(
        pumpRingBytesAtStart,
        displayPumpEventsComplete && displayPumpScopeComplete && presentationMeasurementComplete,
      ),
      ringBytesAtPumpEnd: percentiles(
        pumpRingBytesAtEnd,
        displayPumpEventsComplete && displayPumpScopeComplete && presentationMeasurementComplete,
      ),
      ringRefusedFrameCountPerMeasurementWindow: percentiles(
        ringRefusedFramesPerMeasurementWindow,
        ringRefusalAccountingComplete,
      ),
      ringRefusedFrameCountBetweenMeasurementWindows: percentiles(
        ringRefusedFramesBetweenMeasurementWindows,
        ringRefusalAccountingComplete,
      ),
      ringRefusedFrameCount,
      ringRefusalAccountingComplete,
      budgetExceededCount: measuredDisplayPumps.filter((event) => event.durationMs > event.budgetMs)
        .length,
    },
    mainThread: {
      complete: mainThreadComplete,
      measurementWindowCount: presentationMeasurementWindows.length,
      sampledMeasurementWindowCount: sampledMainThreadWindowCount,
      intervalCount: mainThreadRafGaps.length,
      rafGapMs: percentiles(mainThreadRafGaps, mainThreadComplete),
      frameBudgetOverrunMs: percentiles(mainThreadFrameBudgetOverruns, mainThreadComplete),
      estimatedMissedFramesPerGap: percentiles(mainThreadMissedFramesPerGap, mainThreadComplete),
      estimatedMissedFramesPerMeasurementWindow: percentiles(
        mainThreadMissedFramesPerWindow,
        mainThreadComplete,
      ),
      estimatedMissedFrameCount,
      frameBudgetExceededIntervalCount,
      longTaskObserverSupported,
      longTaskDurationMs: percentiles(
        mainLongTaskDurations,
        mainLongTaskEventsComplete && longTaskObserverSupported === true,
        longTaskMeasurementsUnavailable,
      ),
      longTaskCount: observedMainLongTasks.size,
      longTaskTotalMs,
    },
    browserDisplayIo: {
      scope: BROWSER_DISPLAY_IO_SCOPE,
      complete: browserDisplayIoEventsComplete,
      transportIngressUpdateCount,
      rejectedTransportIngressUpdateCount,
      terminalApplyUpdateCount,
      transportFecIngressUpdateCount,
      terminalFecProcessingUpdateCount,
      fecPayloadByteCount,
      fecExplicitCopyCount,
      fecExplicitCopiedByteCount,
      fecExplicitAllocationRequestCount,
      fecExplicitAllocationRequestedByteCount,
      fecExplicitObjectAllocationRequestCount,
      endToEndMatchedUpdateCount,
      fecRecoveredTerminalApplyUpdateCount,
      endToEndCoverageRatio:
        terminalApplyUpdateCount > 0
          ? (endToEndMatchedUpdateCount + fecRecoveredTerminalApplyUpdateCount) /
            terminalApplyUpdateCount
          : null,
      endToEndMatchedPayloadByteCount,
      payloadByteCount: browserIoPayloadByteCount,
      explicitCopyCount: browserIoExplicitCopyCount,
      explicitCopiedByteCount: browserIoExplicitCopiedByteCount,
      explicitAllocationRequestCount: browserIoExplicitAllocationRequestCount,
      explicitAllocationRequestedByteCount: browserIoExplicitAllocationRequestedByteCount,
      explicitObjectAllocationRequestCount: browserIoExplicitObjectAllocationRequestCount,
      endToEndExplicitCopiesPerUpdate: percentiles(
        endToEndExplicitCopiesPerUpdate,
        browserDisplayIoEventsComplete,
      ),
      endToEndExplicitCopiedBytesPerPayloadByte: percentiles(
        endToEndExplicitCopiedBytesPerPayloadByte,
        browserDisplayIoEventsComplete,
      ),
      endToEndExplicitAllocationRequestsPerUpdate: percentiles(
        endToEndExplicitAllocationRequestsPerUpdate,
        browserDisplayIoEventsComplete,
      ),
      endToEndExplicitAllocationRequestedBytesPerUpdate: percentiles(
        endToEndExplicitAllocationRequestedBytesPerUpdate,
        browserDisplayIoEventsComplete,
      ),
      endToEndExplicitAllocationRequestedBytesPerPayloadByte: percentiles(
        endToEndExplicitAllocationRequestedBytesPerPayloadByte,
        browserDisplayIoEventsComplete,
      ),
      endToEndExplicitObjectAllocationRequestsPerUpdate: percentiles(
        endToEndExplicitObjectAllocationRequestsPerUpdate,
        browserDisplayIoEventsComplete,
      ),
    },
    presentation: {
      epochBoundaryCount: presentationEpochBoundaryCount,
      currentEpoch: currentPresentationEpoch,
      commitCount: presentationCommits.length,
      coherentCommitCount,
      urgentCommitCount,
      authoritativeVisualCommitCount,
      discardedTransactionCount: presentationDiscards.length,
      discardedDatagramCount,
      discardedRowCount,
      discardedByteCount,
      discardedTransactionCountByReason,
      groupCount: presentationGroups.size,
      groupsWithMultipleCommits,
      measurementWindowCount: presentationMeasurementWindows.length,
      measurementWindowCountByPurpose,
      measurementWindowsWithMultipleCommits,
      frameBudgetExceededCount,
      deadlineExceededCount,
      datagramsPerCommit: percentiles(presentationDatagrams, presentationMeasurementComplete),
      rowsPerCommit: percentiles(presentationRows, presentationMeasurementComplete),
      bytesPerCommit: percentiles(presentationBytes, presentationMeasurementComplete),
      firstApplyToCommitMs: percentiles(firstApplyToCommit, presentationMeasurementComplete),
      lastApplyToCommitMs: percentiles(lastApplyToCommit, presentationMeasurementComplete),
      firstReceiveToCommitMs: percentiles(
        firstReceiveToCommit,
        presentationMeasurementComplete && displayReceivedEventsComplete,
      ),
      deadlineOverrunMs: percentiles(deadlineOverrun, presentationMeasurementComplete),
      commitToGpuFenceMs: percentiles(commitToGpuFence, presentationMeasurementComplete),
      renderSubmissionMs: percentiles(
        presentationRenderSubmission,
        presentationMeasurementComplete &&
          presentationRenderSubmission.every((duration) => duration !== null),
      ),
      partialPresentationExposureMs: percentiles(
        partialPresentationExposure,
        presentationCoherenceComplete,
      ),
      commitsPerPresentation: percentiles(commitsPerPresentation, presentationCoherenceComplete),
      measurementWindowExposureMs: percentiles(
        measurementWindowExposure,
        presentationMeasurementComplete,
      ),
      measurementWindowToCompletedAuthoritativePresentationFenceMs: percentiles(
        measurementWindowToCompletedPresentationFence,
        presentationMeasurementComplete,
      ),
      commitsPerMeasurementWindow: percentiles(
        commitsPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
      ordinaryCommitsPerMeasurementWindow: percentiles(
        ordinaryCommitsPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
      repairCommitsPerMeasurementWindow: percentiles(
        repairCommitsPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
      expiredRepairCommitsPerMeasurementWindow: percentiles(
        expiredRepairCommitsPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
      ordinaryMeasurementWindowExposureMs: percentiles(
        ordinaryMeasurementWindowExposure,
        presentationMeasurementComplete,
      ),
      rowsPerMeasurementWindow: percentiles(
        rowsPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
      datagramsPerMeasurementWindow: percentiles(
        datagramsPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
      bytesPerMeasurementWindow: percentiles(
        bytesPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
      firstDisplayReceiveToCompletedPresentationFenceMs: percentiles(
        firstDisplayReceiveToCompletedPresentationFence,
        presentationMeasurementComplete && presentationMeasurementReceiveComplete,
      ),
      refreshPeriodPerMeasurementWindowMs: percentiles(
        refreshPeriodPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
      fenceObservationIntervalPerMeasurementWindowMs: percentiles(
        fenceObservationIntervalPerMeasurementWindow,
        presentationMeasurementComplete,
      ),
    },
    inputAckMs: percentiles(
      samples.map((sample) => sample.inputAckMs),
      sessionBoundaryEventsComplete && inputAckJoinComplete,
    ),
    startup,
    samples,
  };
}

/** Extract click-correlated startup attempts without joining unrelated sessions. */
export function buildTerminalStartupReport(
  events: readonly TerminalPerfEvent[],
): TerminalStartupReport {
  interface MutableAttempt {
    readonly attemptId: number;
    deviceId: string;
    startedAtMs: number;
    valid: boolean;
    readonly elapsedMsByMilestone: Partial<Record<TerminalStartupMilestone, number>>;
  }

  const attemptsById = new Map<number, MutableAttempt>();
  let complete = true;
  for (const event of events) {
    if (event.kind !== 'startup_milestone') continue;
    if (
      !Number.isSafeInteger(event.attemptId) ||
      event.attemptId <= 0 ||
      typeof event.deviceId !== 'string' ||
      event.deviceId.length === 0 ||
      !validTimestamp(event.atMs) ||
      !Number.isFinite(event.elapsedMs) ||
      event.elapsedMs < 0
    ) {
      complete = false;
      continue;
    }
    const startedAtMs = event.atMs - event.elapsedMs;
    let attempt = attemptsById.get(event.attemptId);
    if (attempt === undefined) {
      attempt = {
        attemptId: event.attemptId,
        deviceId: event.deviceId,
        startedAtMs,
        valid: true,
        elapsedMsByMilestone: {},
      };
      attemptsById.set(event.attemptId, attempt);
    }
    if (
      attempt.deviceId !== event.deviceId ||
      Math.abs(attempt.startedAtMs - startedAtMs) > 0.5 ||
      attempt.elapsedMsByMilestone[event.milestone] !== undefined
    ) {
      attempt.valid = false;
      complete = false;
      continue;
    }
    attempt.elapsedMsByMilestone[event.milestone] = event.elapsedMs;
  }

  const attempts = [...attemptsById.values()]
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .map((attempt): TerminalStartupAttemptReport => {
      const elapsed = attempt.elapsedMsByMilestone;
      const applied = elapsed.first_display_applied;
      const visible = elapsed.first_display_visible;
      const causallyOrdered =
        ordered(elapsed.device_selected, elapsed.terminal_mount_requested) &&
        ordered(elapsed.terminal_mount_requested, elapsed.terminal_view_presented) &&
        ordered(elapsed.terminal_mount_requested, elapsed.transport_start) &&
        ordered(elapsed.transport_start, elapsed.transport_connected) &&
        ordered(elapsed.transport_connected, applied) &&
        ordered(applied, visible) &&
        ordered(elapsed.terminal_view_presented, visible) &&
        ordered(elapsed.terminal_mount_requested, elapsed.worker_ready);
      if (!causallyOrdered) {
        attempt.valid = false;
        complete = false;
      }
      const hasCompletePath =
        elapsed.device_selected !== undefined &&
        elapsed.terminal_mount_requested !== undefined &&
        elapsed.worker_ready !== undefined &&
        elapsed.terminal_view_presented !== undefined &&
        elapsed.transport_start !== undefined &&
        elapsed.transport_connected !== undefined &&
        applied !== undefined &&
        visible !== undefined;
      return {
        attemptId: attempt.attemptId,
        deviceId: attempt.deviceId,
        complete: attempt.valid && hasCompletePath,
        elapsedMsByMilestone: { ...elapsed },
        clickToFirstDisplayVisibleMs: visible ?? null,
        displayApplyToVisibleMs:
          applied === undefined || visible === undefined ? null : visible - applied,
      };
    });

  return {
    attemptCount: attempts.length,
    completedCount: attempts.filter((attempt) => attempt.complete).length,
    complete,
    attempts,
  };
}

function ordered(earlier: number | undefined, later: number | undefined): boolean {
  return earlier === undefined || later === undefined || earlier <= later;
}

function displayFrameKey(generation: number, displaySeq: number): string {
  return `${generation}:${displaySeq}`;
}

function browserDisplayIoFrameKey(
  event: Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>,
): string {
  return `${event.generation}:${event.frameId}:${event.chunkIndex}:${event.chunkCount}`;
}

/** One whole interval belongs to one window, or overlapping it invalidates stage attribution. */
function findPresentationMeasurementInterval<
  TWindow extends { readonly startAtMs: number; readonly endAtMs: number },
>(windows: readonly TWindow[], startAtMs: number, endAtMs: number): TWindow | undefined | false {
  if (!Number.isFinite(startAtMs) || !Number.isFinite(endAtMs) || startAtMs > endAtMs) return false;
  let low = 0;
  let high = windows.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    const candidate = windows[middle];
    if (candidate !== undefined && candidate.startAtMs <= endAtMs) low = middle + 1;
    else high = middle;
  }
  const candidate = windows[low - 1];
  if (candidate === undefined || candidate.endAtMs < startAtMs) return undefined;
  return candidate.startAtMs <= startAtMs && endAtMs <= candidate.endAtMs ? candidate : false;
}

function findPresentationMeasurementWindow<
  TWindow extends {
    readonly measurementId: number;
    readonly startAtMs: number;
    readonly endAtMs: number;
  },
>(windows: readonly TWindow[], atMs: number): TWindow | undefined {
  let low = 0;
  let high = windows.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    const candidate = windows[middle];
    if (candidate !== undefined && candidate.startAtMs <= atMs) low = middle + 1;
    else high = middle;
  }
  const candidate = windows[low - 1];
  return candidate !== undefined && atMs <= candidate.endAtMs ? candidate : undefined;
}

function delta(startMs: number, endMs: number | undefined): number | null {
  // A negative duration is a broken/misaligned trace, not a zero-latency
  // sample. Returning null keeps it out of the percentile while the E2E
  // completeness assertions make the telemetry loss visible.
  if (
    endMs === undefined ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs < startMs
  ) {
    return null;
  }
  return endMs - startMs;
}

function matchExactPredictionPaints<
  T extends Extract<TerminalPerfEvent, { kind: 'frame_complete' | 'render_end' }>,
>(
  frames: readonly T[],
  inputs: ReadonlyMap<number, Extract<TerminalPerfEvent, { kind: 'input_queued' }>>,
  appliedBySeq: ReadonlyMap<number, Extract<TerminalPerfEvent, { kind: 'prediction_applied' }>>,
): {
  readonly complete: boolean;
  readonly unavailable: boolean;
  readonly eligibleCount: number;
  readonly firstPaintBySeq: ReadonlyMap<number, T>;
} {
  const eligibleSeqs = new Set<number>();
  for (const [inputSeq, applied] of appliedBySeq) {
    const input = inputs.get(inputSeq);
    if (
      input !== undefined &&
      validPositiveSequence(inputSeq) &&
      Number.isFinite(input.atMs) &&
      Number.isFinite(applied.atMs) &&
      applied.atMs >= input.atMs
    ) {
      eligibleSeqs.add(inputSeq);
    }
  }

  let complete = true;
  let unavailable = false;
  const firstPaintBySeq = new Map<number, T>();
  let displayHighWater = 0;
  for (const frame of frames) {
    // A superseded/invalidated submission still contributes to authoritative readiness and
    // render tails. Its original membership remains in the trace, but observing
    // its old fence after a newer submit cannot credit local prediction visibility.
    if (frame.kind === 'frame_complete' && frame.completionDisposition !== 'latest-submitted')
      continue;
    const visibleSeqs = frame.visiblePredictionInputSeqs;
    if (frame.visiblePredictionInputSeqsTruncated) {
      complete = false;
      unavailable = true;
      continue;
    }
    if (visibleSeqs.length > MAX_EXACT_PREDICTION_SEQS_PER_FRAME) {
      complete = false;
      unavailable = true;
      continue;
    }
    if (
      !Number.isFinite(frame.atMs) ||
      !validCumulativeSequence(frame.displayInputSeq) ||
      !validCumulativeSequence(frame.predictionInputSeq) ||
      visibleSeqs.some((inputSeq) => !validPositiveSequence(inputSeq))
    ) {
      complete = false;
      continue;
    }
    const visibleHighWater = visibleSeqs.reduce(
      (highWater, inputSeq) => advanceInputSequence(highWater, inputSeq),
      0,
    );
    if (
      visibleHighWater !== frame.predictionInputSeq ||
      new Set(visibleSeqs).size !== visibleSeqs.length ||
      (displayHighWater !== 0 &&
        frame.displayInputSeq !== displayHighWater &&
        !inputSequenceAdvances(displayHighWater, frame.displayInputSeq))
    ) {
      complete = false;
      continue;
    }
    displayHighWater = advanceInputSequence(displayHighWater, frame.displayInputSeq);
    for (const inputSeq of visibleSeqs) {
      if (firstPaintBySeq.has(inputSeq) || !eligibleSeqs.has(inputSeq)) continue;
      const input = inputs.get(inputSeq);
      const applied = appliedBySeq.get(inputSeq);
      if (
        input !== undefined &&
        applied !== undefined &&
        inputSequenceAdvances(frame.displayInputSeq, inputSeq) &&
        frame.atMs >= input.atMs &&
        frame.atMs >= applied.atMs
      ) {
        firstPaintBySeq.set(inputSeq, frame);
      }
    }
  }

  return {
    complete,
    unavailable,
    eligibleCount: eligibleSeqs.size,
    firstPaintBySeq,
  };
}

function validPositiveSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_UINT32_SEQUENCE;
}

function validCumulativeSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT32_SEQUENCE;
}

function validTimestamp(value: number): boolean {
  return Number.isFinite(value);
}

function validNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validDisplayPerfEvent(
  event: Extract<
    TerminalPerfEvent,
    {
      kind: 'display_received' | 'worker_display_queued' | 'worker_display_applied';
    }
  >,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    validCumulativeSequence(event.displaySeq) &&
    validCumulativeSequence(event.generation) &&
    validCumulativeSequence(event.inputSeq) &&
    validCumulativeSequence(event.frameId) &&
    validNonNegativeInteger(event.chunkIndex) &&
    validPositiveSequence(event.chunkCount) &&
    event.chunkIndex < event.chunkCount &&
    validPositiveSequence(event.presentationId) &&
    validNonNegativeInteger(event.presentationMemberIndex) &&
    event.presentationMemberIndex <= 0xffff &&
    validNonNegativeInteger(event.presentationMemberCount) &&
    event.presentationMemberCount <= 0xffff &&
    validCumulativeSequence(event.rowPredecessorPresentationId) &&
    (event.kind === 'worker_display_applied'
      ? typeof event.authoritativeVisualMutation === 'boolean' &&
        event.decodeToApplyMs !== null &&
        validPresentationDuration(event.decodeToApplyMs) &&
        event.workerReceiptToDecodeMs === null &&
        (event.authoritativeVisualMutation
          ? validPositiveSequence(event.presentationTransactionSeq)
          : event.presentationTransactionSeq === 0)
      : event.kind === 'display_received'
        ? event.authoritativeVisualMutation === null &&
          event.workerReceiptToDecodeMs !== null &&
          validPresentationDuration(event.workerReceiptToDecodeMs) &&
          event.decodeToApplyMs === null &&
          event.presentationTransactionSeq === 0
        : event.authoritativeVisualMutation === null &&
          event.workerReceiptToDecodeMs === null &&
          event.decodeToApplyMs === null &&
          event.presentationTransactionSeq === 0) &&
    typeof event.presentationCoherent === 'boolean' &&
    typeof event.presentationEnd === 'boolean' &&
    typeof event.fecRecovered === 'boolean' &&
    validNonNegativeInteger(event.byteLength) &&
    validNonNegativeInteger(event.rowCount)
  );
}

function validDisplayPumpCompletePerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'display_pump_complete' }>,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    validPresentationDuration(event.durationMs) &&
    validPresentationDuration(event.budgetMs) &&
    event.budgetMs > 0 &&
    validNonNegativeInteger(event.processedDatagramCount) &&
    event.processedDatagramCount > 0 &&
    validNonNegativeInteger(event.processedRowCount) &&
    validNonNegativeInteger(event.queueHighWater) &&
    validNonNegativeInteger(event.queueRemaining) &&
    event.queueHighWater >= event.queueRemaining &&
    validNonNegativeInteger(event.ringBytesAtStart) &&
    validNonNegativeInteger(event.ringBytesAtEnd) &&
    validNonNegativeInteger(event.ringDroppedTotal)
  );
}

function validMainFrameCadencePerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'main_frame_cadence' }>,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    validPresentationDuration(event.gapMs) &&
    event.gapMs > 0 &&
    typeof event.longTaskObserverSupported === 'boolean'
  );
}

function validMainLongTaskPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'main_long_task' }>,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    validPresentationDuration(event.durationMs) &&
    event.durationMs > 0
  );
}

function validBrowserDisplayIoPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'browser_display_io' }>,
): boolean {
  const transportStage =
    event.stage === 'transport_ingress' || event.stage === 'transport_fec_ingress';
  const patchStage = event.stage === 'transport_ingress' || event.stage === 'terminal_apply';
  const fecStage = event.stage === 'transport_fec_ingress' || event.stage === 'terminal_fec';
  const validIngressRoute =
    event.ingressRoute === 'direct-datagram' ||
    event.ingressRoute === 'direct-reliable' ||
    event.ingressRoute === 'relay-datagram' ||
    event.ingressRoute === 'relay-reliable';
  return (
    validTimestamp(event.atMs) &&
    (patchStage || fecStage) &&
    (transportStage ? validIngressRoute : event.ingressRoute === null) &&
    (patchStage
      ? validCumulativeSequence(event.displaySeq) &&
        validPositiveSequence(event.frameId) &&
        validNonNegativeInteger(event.chunkIndex) &&
        validPositiveSequence(event.chunkCount) &&
        event.chunkIndex < event.chunkCount
      : validPositiveSequence(event.displaySeq) &&
        event.frameId === 0 &&
        event.chunkIndex === 0 &&
        event.chunkCount === 1) &&
    validPositiveSequence(event.generation) &&
    validPositiveSequence(event.payloadByteLength) &&
    typeof event.admitted === 'boolean' &&
    typeof event.fecRecovered === 'boolean' &&
    (event.stage === 'terminal_apply' || !event.fecRecovered) &&
    (event.stage === 'transport_ingress' ||
      event.stage === 'transport_fec_ingress' ||
      event.admitted) &&
    validNonNegativeInteger(event.explicitCopyCount) &&
    validNonNegativeInteger(event.explicitCopiedBytes) &&
    validNonNegativeInteger(event.explicitAllocationRequestCount) &&
    validNonNegativeInteger(event.explicitAllocationRequestedBytes) &&
    validNonNegativeInteger(event.explicitObjectAllocationRequestCount) &&
    event.explicitCopiedBytes >= event.explicitCopyCount &&
    event.explicitAllocationRequestedBytes >= event.explicitAllocationRequestCount
  );
}

function validPresentationCommitPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    Number.isFinite(event.releaseFrameTimeMs) &&
    event.releaseFrameTimeMs >= 0 &&
    validNonNegativeInteger(event.releaseFrameCount) &&
    validNonNegativeInteger(event.membershipReleaseDisableBits) &&
    event.membershipReleaseDisableBits <= 0xff &&
    validPositiveSequence(event.transactionSeq) &&
    validPositiveSequence(event.renderSeq) &&
    validCumulativeSequence(event.generation) &&
    validCumulativeSequence(event.firstDisplaySeq) &&
    validCumulativeSequence(event.lastDisplaySeq) &&
    [event.displayInputSeq, event.displayEchoHorizonSeq].every(validCumulativeSequence) &&
    validPositiveSequence(event.firstPresentationId) &&
    validPositiveSequence(event.lastPresentationId) &&
    validPresentationDuration(event.firstApplyToCommitMs) &&
    validPresentationDuration(event.lastApplyToCommitMs) &&
    event.lastApplyToCommitMs <= event.firstApplyToCommitMs &&
    validPresentationDuration(event.deadlineOverrunMs) &&
    Number.isFinite(event.refreshPeriodMs) &&
    event.refreshPeriodMs > 0 &&
    validNonNegativeInteger(event.datagramCount) &&
    event.datagramCount > 0 &&
    validNonNegativeInteger(event.rowCount) &&
    validNonNegativeInteger(event.byteLength) &&
    validNonNegativeInteger(event.queueHighWater) &&
    typeof event.coherent === 'boolean' &&
    typeof event.endSeen === 'boolean' &&
    typeof event.authoritativeVisualChange === 'boolean' &&
    (event.reason === 'urgent' ||
      event.reason === 'group-end-vsync' ||
      event.reason === 'deadline-vsync' ||
      event.reason === 'deadline-timer' ||
      event.reason === 'recovery-release' ||
      event.reason === 'repair-target-satisfied' ||
      event.reason === 'repair-deadline-expired' ||
      event.reason === 'safety-revocation' ||
      event.reason === 'membership-complete' ||
      event.reason === 'closure-complete' ||
      event.reason === 'paced-complete')
  );
}

function validPresentationTransactionDiscardedPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'presentation_transaction_discarded' }>,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    validPositiveSequence(event.transactionSeq) &&
    validCumulativeSequence(event.generation) &&
    validCumulativeSequence(event.firstDisplaySeq) &&
    validCumulativeSequence(event.lastDisplaySeq) &&
    validNonNegativeInteger(event.appliedDatagramCount) &&
    event.appliedDatagramCount > 0 &&
    validNonNegativeInteger(event.rowCount) &&
    validNonNegativeInteger(event.byteLength) &&
    (event.reason === 'resync' || event.reason === 'epoch-reset' || event.reason === 'teardown')
  );
}

function validPresentationMeasurementBoundaryPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'presentation_measurement_boundary' }>,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    validPositiveSequence(event.measurementId) &&
    (event.phase === 'start' || event.phase === 'end') &&
    (event.purpose === 'coherent-redraw' ||
      event.purpose === 'isolated-interactive' ||
      event.purpose === 'streaming')
  );
}

function validDisplayRingMeasurementBoundaryPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'display_ring_measurement_boundary' }>,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    validPositiveSequence(event.measurementId) &&
    (event.phase === 'start' || event.phase === 'end') &&
    validPositiveSequence(event.observationEpoch) &&
    validPositiveSequence(event.sessionEpoch) &&
    validCumulativeSequence(event.ringDroppedTotal)
  );
}

/** Reject cross-realm clock values masquerading as local presentation durations. */
function validPresentationDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_PRESENTATION_DURATION_MS;
}

function validRenderPerfEventBase(
  event: Extract<TerminalPerfEvent, { kind: RenderPerfKind }>,
): boolean {
  return (
    validTimestamp(event.atMs) &&
    // Zero is the "no identity" sentinel and cannot join, so it is rejected here
    // rather than silently pairing every unidentified render with every other.
    validPositiveSequence(event.renderSeq) &&
    validCumulativeSequence(event.displayInputSeq) &&
    validCumulativeSequence(event.predictionInputSeq) &&
    validNonNegativeInteger(event.queuedDisplayFrames)
  );
}

function validCompletedRenderPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'render_end' | 'frame_complete' }>,
): boolean {
  return (
    validRenderPerfEventBase(event) &&
    Array.isArray(event.visiblePredictionInputSeqs) &&
    typeof event.visiblePredictionInputSeqsTruncated === 'boolean'
  );
}

/** Completion retains the exact submitted membership, even when superseded.
 * Compare sets rather than array order: ring decoding canonicalizes the bitmap. */
function sameCompletedRenderMembership(
  end: Extract<TerminalPerfEvent, { kind: 'render_end' }>,
  frame: Extract<TerminalPerfEvent, { kind: 'frame_complete' }>,
): boolean {
  return (
    end.renderSeq === frame.renderSeq &&
    end.displayInputSeq === frame.displayInputSeq &&
    end.predictionInputSeq === frame.predictionInputSeq &&
    end.queuedDisplayFrames === frame.queuedDisplayFrames &&
    end.visiblePredictionInputSeqsTruncated === frame.visiblePredictionInputSeqsTruncated &&
    end.visiblePredictionInputSeqs.length === frame.visiblePredictionInputSeqs.length &&
    end.visiblePredictionInputSeqs.every((seq) => frame.visiblePredictionInputSeqs.includes(seq)) &&
    frame.visiblePredictionInputSeqs.every((seq) => end.visiblePredictionInputSeqs.includes(seq))
  );
}

function validRenderStartPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'render_start' }>,
): boolean {
  return (
    validRenderPerfEventBase(event) &&
    // Zero means "unknown"/"not gated this way" for the four timestamps below,
    // so each is either zero or a real timestamp.
    (event.wantedAtMs === 0 || validTimestamp(event.wantedAtMs)) &&
    (event.fenceReleasedAtMs === 0 || validTimestamp(event.fenceReleasedAtMs)) &&
    (event.gate === 'fence' || event.gate === 'fence-and-opportunity'
      ? validPositiveSequence(event.fenceReleasedRenderSeq) &&
        event.fenceReleasedAtMs > 0 &&
        event.fenceReleasedRenderSeq !== event.renderSeq
      : event.fenceReleasedRenderSeq === 0 && event.fenceReleasedAtMs === 0) &&
    (event.opportunityEnteredAtMs === 0 || validTimestamp(event.opportunityEnteredAtMs)) &&
    Number.isFinite(event.opportunityDelayMs) &&
    event.opportunityDelayMs >= 0 &&
    Number.isFinite(event.fenceWaitMs) &&
    event.fenceWaitMs >= 0 &&
    Number.isFinite(event.opportunityWaitMs) &&
    event.opportunityWaitMs >= 0 &&
    (event.gate === 'fence' || event.gate === 'fence-and-opportunity' || event.fenceWaitMs === 0) &&
    (event.gate === 'opportunity' ||
      event.gate === 'fence-and-opportunity' ||
      event.opportunityWaitMs === 0) &&
    // Worker durations and epoch timestamps can differ by one microsecond of
    // floating-point precision; no overlapping interval may inflate the sum.
    (event.wantedAtMs === 0 ||
      event.fenceWaitMs + event.opportunityWaitMs <= event.atMs - event.wantedAtMs + 0.001) &&
    Number.isFinite(event.refreshPeriodMs) &&
    event.refreshPeriodMs > 0 &&
    Number.isFinite(event.refreshConfidence01) &&
    event.refreshConfidence01 >= 0 &&
    event.refreshConfidence01 <= 1 &&
    (event.gate === 'immediate' ||
      event.gate === 'fence' ||
      event.gate === 'opportunity' ||
      event.gate === 'fence-and-opportunity')
  );
}

function validRenderEndPerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'render_end' }>,
): boolean {
  return (
    validCompletedRenderPerfEvent(event) &&
    (event.completionMode === 'gpu-queue' || event.completionMode === 'none') &&
    typeof event.atlasUploaded === 'boolean' &&
    typeof event.drainedDisplay === 'boolean'
  );
}

function validFrameCompletePerfEvent(
  event: Extract<TerminalPerfEvent, { kind: 'frame_complete' }>,
): boolean {
  return (
    validCompletedRenderPerfEvent(event) &&
    (event.completionDisposition === 'latest-submitted' ||
      event.completionDisposition === 'superseded' ||
      event.completionDisposition === 'invalidated') &&
    // The sole producer is a genuine WebGPU queue callback, not a JS fence poll.
    // Nonzero legacy polling evidence is not part of the current contract.
    event.pollCount === 0 &&
    event.previousPollAtMs === 0
  );
}

function percentiles(
  values: readonly (number | null)[],
  complete = true,
  unavailable = false,
): TerminalLatencyPercentiles {
  if (unavailable) {
    return {
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      complete: false,
    };
  }
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, max: null, complete };
  }
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? null,
    complete,
  };
}

/** Mirrors the daemon's batch bound: four 52-byte records per control frame. */
const DAEMON_TIMING_MAX_RECORDS = 4;

function validU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validEgressRefusals(refusals: TerminalEgressRefusals): boolean {
  return validU32(refusals.blocked) && validU32(refusals.paced) && validU32(refusals.waitedUs);
}

/**
 * Sum consecutive-snapshot steps of modular counters. A counter cannot wrap
 * inside a report window, so a decrease is a replaced group: the step counts
 * from zero and the result is incomplete.
 */
/** One cumulative egress counter snapshot: its series identity and values. */
export interface EgressCounterSnapshot {
  readonly series: number;
  readonly values: readonly number[];
}

/**
 * The counts between two snapshots of one hop. Within a series the counters
 * are modular u32, so a wrap is an exact step. A new series counts from zero:
 * exactly when the earlier snapshot had none (series zero); otherwise the old
 * series' last steps went unseen and the steps are not continuous.
 */
export function egressCounterSteps(
  previous: EgressCounterSnapshot,
  current: EgressCounterSnapshot,
): { readonly steps: readonly number[]; readonly continuous: boolean } {
  const same = current.series === previous.series;
  return {
    steps: current.values.map((value, field) =>
      same ? (value - (previous.values[field] ?? 0)) >>> 0 : value,
    ),
    continuous: same || previous.series === 0,
  };
}

function transportEgressReport(
  egress: readonly Extract<TerminalPerfEvent, { kind: 'transport_egress' }>[],
  residence: readonly Extract<TerminalPerfEvent, { kind: 'edge_forward_residence' }>[],
  eventsComplete: boolean,
): TerminalTransportEgressReport {
  let complete = eventsComplete;
  const stepsOf = (snapshots: readonly EgressCounterSnapshot[]): number[] => {
    const width = snapshots[0]?.values.length ?? 0;
    const total: number[] = new Array<number>(width).fill(0);
    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const current = snapshots[index];
      if (previous === undefined || current === undefined) continue;
      const { steps, continuous } = egressCounterSteps(previous, current);
      if (!continuous) complete = false;
      for (let field = 0; field < width; field += 1) {
        total[field] = (total[field] ?? 0) + (steps[field] ?? 0);
      }
    }
    return total;
  };
  const hopDelta = (hop: TerminalEgressHop) => {
    const snapshots = egress.filter((event) => event.hop === hop);
    const [ib = 0, ip = 0, iw = 0, bb = 0, bp = 0, bw = 0] = stepsOf(
      snapshots.map((event) => ({
        series: event.series,
        values: [
          event.interactive.blocked,
          event.interactive.paced,
          event.interactive.waitedUs,
          event.bulk.blocked,
          event.bulk.paced,
          event.bulk.waitedUs,
        ],
      })),
    );
    return {
      count: snapshots.length,
      delta: {
        interactive: { blocked: ib, paced: ip, waitedUs: iw },
        bulk: { blocked: bb, paced: bp, waitedUs: bw },
      },
    };
  };
  const daemon = hopDelta('daemon');
  const edge = hopDelta('edge');
  const buckets = stepsOf(
    residence.map((event) => ({ series: event.series, values: event.buckets })),
  );
  return {
    complete,
    daemonSnapshotCount: daemon.count,
    edgeSnapshotCount: edge.count,
    daemon: daemon.delta,
    edge: edge.delta,
    edgeForwardResidence:
      buckets.length === 0
        ? new Array<number>(EDGE_FORWARD_RESIDENCE_BUCKET_COUNT).fill(0)
        : buckets,
  };
}

function markTerminalLatencyReportIncomplete(report: TerminalLatencyReport): TerminalLatencyReport {
  const incomplete = <T extends TerminalLatencyPercentiles>(metric: T): T => ({
    ...metric,
    complete: false,
  });
  return {
    ...report,
    physicalInputToAdmissionMs: incomplete(report.physicalInputToAdmissionMs),
    touchToCommitMs: incomplete(report.touchToCommitMs),
    touchToPredictionSubmissionMs: incomplete(report.touchToPredictionSubmissionMs),
    inputToPredictionSubmissionMs: incomplete(report.inputToPredictionSubmissionMs),
    inputToPredictionPaintMs: {
      ...incomplete(report.inputToPredictionPaintMs),
      coverageRatio: null,
    },
    admissionToInputSentMs: incomplete(report.admissionToInputSentMs),
    inputSentToAckMs: incomplete(report.inputSentToAckMs),
    inputAckNetworkRttFloorMs: incomplete(report.inputAckNetworkRttFloorMs),
    inputAckNonNetworkUpperBoundMs: incomplete(report.inputAckNonNetworkUpperBoundMs),
    inputToDisplayReceiveMs: incomplete(report.inputToDisplayReceiveMs),
    displayReceiveToWorkerQueueMs: incomplete(report.displayReceiveToWorkerQueueMs),
    workerQueueToDisplayApplyMs: incomplete(report.workerQueueToDisplayApplyMs),
    inputToDisplayApplyMs: incomplete(report.inputToDisplayApplyMs),
    inputToDisplayPaintMs: incomplete(report.inputToDisplayPaintMs),
    inputToAuthoritativeVisualFenceMs: incomplete(report.inputToAuthoritativeVisualFenceMs),
    inputToCompletedSenderPresentationFenceMs: incomplete(
      report.inputToCompletedSenderPresentationFenceMs,
    ),
    inputToCompletedAuthoritativePresentationFenceMs: incomplete(
      report.inputToCompletedAuthoritativePresentationFenceMs,
    ),
    displayApplyToPaintMs: incomplete(report.displayApplyToPaintMs),
    displayApplyToRenderStartMs: incomplete(report.displayApplyToRenderStartMs),
    renderStartToRenderEndMs: incomplete(report.renderStartToRenderEndMs),
    renderEndToDisplayPaintMs: incomplete(report.renderEndToDisplayPaintMs),
    renderEndToLastUnreadyPollMs: incomplete(report.renderEndToLastUnreadyPollMs),
    fenceObservationIntervalMs: incomplete(report.fenceObservationIntervalMs),
    renderGate: {
      ...report.renderGate,
      applyToRenderWantedMs: incomplete(report.renderGate.applyToRenderWantedMs),
      fenceGateWaitMs: incomplete(report.renderGate.fenceGateWaitMs),
      opportunityGateWaitMs: incomplete(report.renderGate.opportunityGateWaitMs),
      opportunityDelayRequestedMs: incomplete(report.renderGate.opportunityDelayRequestedMs),
      opportunityPeriodMs: incomplete(report.renderGate.opportunityPeriodMs),
      opportunityLowConfidenceRatio: null,
    },
    renderInstrumentation: {
      ...report.renderInstrumentation,
      renderStartToRenderEndSteadyMs: incomplete(
        report.renderInstrumentation.renderStartToRenderEndSteadyMs,
      ),
    },
    daemonPipeline: {
      ...report.daemonPipeline,
      complete: false,
      recvToPtyUs: incomplete(report.daemonPipeline.recvToPtyUs),
      ptyToReadUs: incomplete(report.daemonPipeline.ptyToReadUs),
      gridApplyUs: incomplete(report.daemonPipeline.gridApplyUs),
      displayCoalesceUs: incomplete(report.daemonPipeline.displayCoalesceUs),
      selectCaptureUs: incomplete(report.daemonPipeline.selectCaptureUs),
      prepareQueueUs: incomplete(report.daemonPipeline.prepareQueueUs),
      encodeUs: incomplete(report.daemonPipeline.encodeUs),
      compressionUs: incomplete(report.daemonPipeline.compressionUs),
      completionQueueUs: incomplete(report.daemonPipeline.completionQueueUs),
      transportSubmitUs: incomplete(report.daemonPipeline.transportSubmitUs),
      gridMutationToEncodedUs: incomplete(report.daemonPipeline.gridMutationToEncodedUs),
      queuedBeforeTransportSubmitUs: incomplete(
        report.daemonPipeline.queuedBeforeTransportSubmitUs,
      ),
      displayOperationTotalUs: incomplete(report.daemonPipeline.displayOperationTotalUs),
      totalUs: incomplete(report.daemonPipeline.totalUs),
      writeCompletionUs: incomplete(report.daemonPipeline.writeCompletionUs),
      ackTransmitUs: incomplete(report.daemonPipeline.ackTransmitUs),
      ownerCpuUs: incomplete(report.daemonPipeline.ownerCpuUs),
      ownerOffCpuUs: incomplete(report.daemonPipeline.ownerOffCpuUs),
      ownerQuinnWaitUs: incomplete(report.daemonPipeline.ownerQuinnWaitUs),
      ownerRegistryWaitUs: incomplete(report.daemonPipeline.ownerRegistryWaitUs),
      flushLockWaitUs: incomplete(report.daemonPipeline.flushLockWaitUs),
      displayOperationOwnerOffCpuUs: incomplete(
        report.daemonPipeline.displayOperationOwnerOffCpuUs,
      ),
      displayOperationLockWaitUs: incomplete(report.daemonPipeline.displayOperationLockWaitUs),
    },
    transportEgress: { ...report.transportEgress, complete: false },
    displayPipeline: {
      ...report.displayPipeline,
      workerReceiptToDecodeMs: incomplete(report.displayPipeline.workerReceiptToDecodeMs),
      decodeToApplyMs: incomplete(report.displayPipeline.decodeToApplyMs),
      pumpDurationMs: incomplete(report.displayPipeline.pumpDurationMs),
      pumpBudgetMs: incomplete(report.displayPipeline.pumpBudgetMs),
      datagramsPerPump: incomplete(report.displayPipeline.datagramsPerPump),
      rowsPerPump: incomplete(report.displayPipeline.rowsPerPump),
      encodedDeferralQueueHighWaterPerPump: incomplete(
        report.displayPipeline.encodedDeferralQueueHighWaterPerPump,
      ),
      encodedDeferralQueueRemainingPerPump: incomplete(
        report.displayPipeline.encodedDeferralQueueRemainingPerPump,
      ),
      ringBytesAtPumpStart: incomplete(report.displayPipeline.ringBytesAtPumpStart),
      ringBytesAtPumpEnd: incomplete(report.displayPipeline.ringBytesAtPumpEnd),
      ringRefusedFrameCountPerMeasurementWindow: incomplete(
        report.displayPipeline.ringRefusedFrameCountPerMeasurementWindow,
      ),
      ringRefusedFrameCountBetweenMeasurementWindows: incomplete(
        report.displayPipeline.ringRefusedFrameCountBetweenMeasurementWindows,
      ),
      ringRefusalAccountingComplete: false,
    },
    mainThread: {
      ...report.mainThread,
      complete: false,
      rafGapMs: incomplete(report.mainThread.rafGapMs),
      frameBudgetOverrunMs: incomplete(report.mainThread.frameBudgetOverrunMs),
      estimatedMissedFramesPerGap: incomplete(report.mainThread.estimatedMissedFramesPerGap),
      estimatedMissedFramesPerMeasurementWindow: incomplete(
        report.mainThread.estimatedMissedFramesPerMeasurementWindow,
      ),
      longTaskDurationMs: incomplete(report.mainThread.longTaskDurationMs),
    },
    browserDisplayIo: {
      ...report.browserDisplayIo,
      complete: false,
      endToEndExplicitCopiesPerUpdate: incomplete(
        report.browserDisplayIo.endToEndExplicitCopiesPerUpdate,
      ),
      endToEndExplicitCopiedBytesPerPayloadByte: incomplete(
        report.browserDisplayIo.endToEndExplicitCopiedBytesPerPayloadByte,
      ),
      endToEndExplicitAllocationRequestsPerUpdate: incomplete(
        report.browserDisplayIo.endToEndExplicitAllocationRequestsPerUpdate,
      ),
      endToEndExplicitAllocationRequestedBytesPerUpdate: incomplete(
        report.browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerUpdate,
      ),
      endToEndExplicitAllocationRequestedBytesPerPayloadByte: incomplete(
        report.browserDisplayIo.endToEndExplicitAllocationRequestedBytesPerPayloadByte,
      ),
      endToEndExplicitObjectAllocationRequestsPerUpdate: incomplete(
        report.browserDisplayIo.endToEndExplicitObjectAllocationRequestsPerUpdate,
      ),
    },
    presentation: {
      ...report.presentation,
      datagramsPerCommit: incomplete(report.presentation.datagramsPerCommit),
      rowsPerCommit: incomplete(report.presentation.rowsPerCommit),
      bytesPerCommit: incomplete(report.presentation.bytesPerCommit),
      firstApplyToCommitMs: incomplete(report.presentation.firstApplyToCommitMs),
      lastApplyToCommitMs: incomplete(report.presentation.lastApplyToCommitMs),
      firstReceiveToCommitMs: incomplete(report.presentation.firstReceiveToCommitMs),
      deadlineOverrunMs: incomplete(report.presentation.deadlineOverrunMs),
      commitToGpuFenceMs: incomplete(report.presentation.commitToGpuFenceMs),
      renderSubmissionMs: incomplete(report.presentation.renderSubmissionMs),
      partialPresentationExposureMs: incomplete(report.presentation.partialPresentationExposureMs),
      commitsPerPresentation: incomplete(report.presentation.commitsPerPresentation),
      measurementWindowExposureMs: incomplete(report.presentation.measurementWindowExposureMs),
      measurementWindowToCompletedAuthoritativePresentationFenceMs: incomplete(
        report.presentation.measurementWindowToCompletedAuthoritativePresentationFenceMs,
      ),
      commitsPerMeasurementWindow: incomplete(report.presentation.commitsPerMeasurementWindow),
      ordinaryCommitsPerMeasurementWindow: incomplete(
        report.presentation.ordinaryCommitsPerMeasurementWindow,
      ),
      repairCommitsPerMeasurementWindow: incomplete(
        report.presentation.repairCommitsPerMeasurementWindow,
      ),
      expiredRepairCommitsPerMeasurementWindow: incomplete(
        report.presentation.expiredRepairCommitsPerMeasurementWindow,
      ),
      ordinaryMeasurementWindowExposureMs: incomplete(
        report.presentation.ordinaryMeasurementWindowExposureMs,
      ),
      rowsPerMeasurementWindow: incomplete(report.presentation.rowsPerMeasurementWindow),
      datagramsPerMeasurementWindow: incomplete(report.presentation.datagramsPerMeasurementWindow),
      bytesPerMeasurementWindow: incomplete(report.presentation.bytesPerMeasurementWindow),
      firstDisplayReceiveToCompletedPresentationFenceMs: incomplete(
        report.presentation.firstDisplayReceiveToCompletedPresentationFenceMs,
      ),
      refreshPeriodPerMeasurementWindowMs: incomplete(
        report.presentation.refreshPeriodPerMeasurementWindowMs,
      ),
      fenceObservationIntervalPerMeasurementWindowMs: incomplete(
        report.presentation.fenceObservationIntervalPerMeasurementWindowMs,
      ),
    },
    inputAckMs: incomplete(report.inputAckMs),
    startup: { ...report.startup, complete: false },
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.min(sorted.length - 1, index)] ?? 0;
}

function lowerBoundTimestamp<T extends { readonly atMs: number }>(
  events: readonly T[],
  atMs: number,
): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const event = events[middle];
    if (event !== undefined && event.atMs < atMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Segment-max index for queries of the form:
 * "first event at/after timestamp T whose cumulative input sequence reaches S".
 *
 * One reusable Uint32 tree keeps all four report correlations O((E + I) log E)
 * with O(E) scratch instead of retaining four indexes. Sparse/missing traces no
 * longer scan the entire remaining event suffix once per input.
 */
class FirstSequenceAtOrAfterIndex {
  private readonly leafCount: number;
  private readonly tree: Uint32Array;

  constructor(maxEvents: number) {
    let leafCount = 1;
    while (leafCount < maxEvents) leafCount *= 2;
    this.leafCount = leafCount;
    this.tree = new Uint32Array(leafCount * 2);
  }

  match<TEvent extends { readonly atMs: number }>(
    events: readonly TEvent[],
    inputs: readonly Extract<TerminalPerfEvent, { kind: 'input_queued' }>[],
    sequenceOf: (event: TEvent) => number,
  ): (TEvent | undefined)[] {
    this.tree.fill(0);
    const anchorSequence = inputs[0]?.inputSeq ?? 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event !== undefined) {
        this.tree[this.leafCount + index] = inputSequenceOrdinal(anchorSequence, sequenceOf(event));
      }
    }
    for (let node = this.leafCount - 1; node > 0; node -= 1) {
      this.tree[node] = Math.max(this.tree[node * 2] ?? 0, this.tree[node * 2 + 1] ?? 0);
    }

    return inputs.map((input) => {
      const startIndex = lowerBoundTimestamp(events, input.atMs);
      const eventIndex = this.findFirst(
        1,
        0,
        this.leafCount,
        startIndex,
        inputSequenceOrdinal(anchorSequence, input.inputSeq),
        events.length,
      );
      return eventIndex === -1 ? undefined : events[eventIndex];
    });
  }

  private findFirst(
    node: number,
    left: number,
    right: number,
    startIndex: number,
    minimumSequence: number,
    eventCount: number,
  ): number {
    if (right <= startIndex || left >= eventCount || (this.tree[node] ?? 0) < minimumSequence) {
      return -1;
    }
    if (right - left === 1) return left;
    const middle = left + Math.floor((right - left) / 2);
    const fromLeft = this.findFirst(
      node * 2,
      left,
      middle,
      startIndex,
      minimumSequence,
      eventCount,
    );
    if (fromLeft !== -1) return fromLeft;
    return this.findFirst(node * 2 + 1, middle, right, startIndex, minimumSequence, eventCount);
  }
}

function inputSequenceAtOrAfter(candidate: number, target: number): boolean {
  return candidate === target || inputSequenceAdvances(target, candidate);
}

type FencedCommit = {
  readonly commit: Extract<TerminalPerfEvent, { kind: 'presentation_commit' }>;
  readonly frame: { readonly atMs: number };
};

/**
 * The first fenced pixels that answer an input, and when they did: the
 * submission whose barrier covers it at its fence, or the one that could hold
 * its answer once an applied frame has confirmed the input, at whichever of
 * that fence and that frame came later. The earlier of the two answers.
 */
function firstAnsweringFence(
  covering: FencedCommit | undefined,
  possible: FencedCommit | undefined,
  confirmed: { readonly atMs: number } | undefined,
): { readonly commit: FencedCommit['commit']; readonly atMs: number } | undefined {
  const answered =
    possible === undefined || confirmed === undefined
      ? undefined
      : { commit: possible.commit, atMs: Math.max(possible.frame.atMs, confirmed.atMs) };
  if (covering === undefined) return answered;
  if (answered !== undefined && answered.atMs < covering.frame.atMs) return answered;
  return { commit: covering.commit, atMs: covering.frame.atMs };
}

/**
 * When a measurement window's fenced pixels answered its closing input: at the
 * window's last fence when their barrier covers it, or, when only their echo
 * horizon does, once an applied frame has confirmed the input as well.
 */
function windowAnsweredAtMs(
  window: {
    readonly fenceObservedAtMs: number;
    readonly displayInputHighWater: number;
    readonly echoHorizonHighWater: number;
  },
  inputSeq: number,
  confirmed: { readonly atMs: number } | undefined,
): number | undefined {
  if (inputSequenceAtOrAfter(window.displayInputHighWater, inputSeq)) {
    return window.fenceObservedAtMs;
  }
  if (confirmed === undefined || !inputSequenceAtOrAfter(window.echoHorizonHighWater, inputSeq)) {
    return undefined;
  }
  return Math.max(window.fenceObservedAtMs, confirmed.atMs);
}

/**
 * Unwrap one bounded recorder window relative to its first input. Recorder
 * capacity is many orders of magnitude below RFC-1982's half-range, so every
 * legitimate successor has one unambiguous ordinal even across MAX -> 1.
 * Zero remains the protocol's "no causal input" sentinel and maps to no leaf.
 */
function inputSequenceOrdinal(anchor: number, candidate: number): number {
  if (!validPositiveSequence(anchor) || !validPositiveSequence(candidate)) return 0;
  if (candidate === anchor) return 1;
  const distance = (candidate - anchor) >>> 0;
  return distance < 0x8000_0000 ? distance + 1 : 0;
}
