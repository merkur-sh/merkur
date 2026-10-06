// Device-agnostic terminal input controller. Owns every path that turns user
// input into input records or worker predictions: the window keydown/keyup
// fast path, clipboard paste, pointer reports, and virtual-keyboard sends.
// Composition, soft-keyboard editing intents, and committed IME text live in
// the editing surface (see terminal/editing-surface.ts), which feeds back
// through sendNativeText/sendVirtualKey/notifyComposition*. TerminalPanel
// keeps only Solid UI state and rendering.
//
// Nothing here decides which bytes an application reads. Every input leaves as
// a record of what the user did (`@merkur/protocol` input records) and the
// daemon encodes it against the terminal it owns — the keyboard modes an
// application sets reach the browser a round trip late, so any encoding made
// here would be made in the wrong mode during exactly that window.

import {
  encodeFocusRecord,
  encodePasteRecordInto,
  encodeTextRecord,
  FUNCTIONAL_KEY,
  KEY_EVENT_PRESS,
  KEY_EVENT_REPEAT,
  KEY_MOD_CAPS_LOCK,
  KEY_MOD_NUM_LOCK,
  KEY_MOD_SHIFT,
  type KeyEvent,
} from '@merkur/protocol';
import { TERMINAL_MODE_FOCUS } from '@merkur/shared';
import { e2eWasm } from '@merkur/shared/e2e-wasm-runtime';
import {
  IS_APPLE_PLATFORM,
  type KeyIdentity,
  modifiersOf,
  REPORTED_ALWAYS,
  resolveKeyboardEvent,
  resolveRelease,
  resolveVirtualKey,
  type TerminalModifierState,
} from '../lib/key-record';
import { createOwnedTimeout } from '../lib/owned-scheduled-callback';
import { isRightAltHeld, isRightMetaHeld, observeRightMeta } from '../lib/right-meta';
import { mainPerfWriter } from '../perf/main-perf-writer';
import { emitKeyboardCommit } from '../perf/perf-event-codec';
import { isTerminalPerfRecording, terminalPerfNowMs } from '../perf/terminal-latency';
import type { TerminalWorkerClient } from '../terminal-worker-client';
import { MAX_BUFFERED_INPUT_BYTES } from '../transport/input-ring';
import {
  INPUT_AWAITED,
  INPUT_DEFERRED,
  INPUT_UNAWAITED,
  type InputDelivery,
  type TerminalSession,
} from '../transport-worker-client';
import { getVirtualKeyDefinition, type VirtualKeyDefinition } from './virtual-keyboard';

/** Paste body per record; the record adds its one-byte head. */
const PASTE_CHUNK = 8 * 1024;
const FOCUS_MODE_SHORTCUT_KEY = 's';
/**
 * Transient ring/budget backpressure clears in single-digit milliseconds.
 *
 * This is the ONLY retry cadence. A session that is not accepting input at all
 * used to poll at 250 ms, which meant up to a quarter second of withheld input
 * followed by a catch-up dump — a timer standing in for an edge the worker
 * already sends. `input_ready` is that edge, and `drainPendingInput` is now
 * called from it directly.
 */
const INPUT_RETRY_MS = 4;
const MAX_PENDING_INPUTS = 4_096;
const LOCK_MODS = KEY_MOD_CAPS_LOCK | KEY_MOD_NUM_LOCK;
/** No key number and no text: the input is never shadow-modelled. */
const UNCLASSIFIED = -1;

// ── Prediction routing (pure — unit-tested) ──────────────────────────────────

/**
 * `predictionIntent` returns a single number so the per-keystroke path never
 * allocates a route object: a non-negative result IS the predictable codepoint,
 * and these negative sentinels carry every other decision.
 */
export const PREDICTION_FLUSH = -1;
export const PREDICTION_BACKSPACE = -2;
export const PREDICTION_DELETE = -3;
export const PREDICTION_CURSOR_LEFT = -4;
export const PREDICTION_CURSOR_RIGHT = -5;

/**
 * Decide what a key press may speculatively do to the local shadow model.
 *
 * Reads the key record's own fields — its Kitty key number, the single code
 * point it typed (or -1) and its modifier bits — because those, not an
 * encoding, are what the daemon checks the claim against: a record it could
 * not have modelled is treated as unmodelled whatever the browser claims.
 *
 * Arguments are positional rather than an options object because this runs on
 * every keypress; callers already hold each value and must not allocate to ask.
 */
export function predictionIntent(
  key: number,
  textCodePoint: number,
  mods: number,
  compositionActive: boolean,
  predictionSafe: boolean,
): number {
  if (compositionActive) return PREDICTION_FLUSH;
  // Neither `altScreenActive` nor mouse reporting is consulted. Both were
  // proxies for "no line editor here", and a multiplexer breaks both at once:
  // tmux never leaves the alternate screen, and sets mouse tracking whenever
  // `mouse on` is configured, while the shell inside it has an ordinary line
  // editor. Mouse tracking governs how *pointer* events are encoded and says
  // nothing about whether the shell echoes typed characters.
  //
  // `predictionSafe` is the daemon's authenticated prompt-boundary grant and is
  // the only signal that may close this gate; it already goes through the one
  // shared mask in `packages/shared/src/terminal-mode.ts`, so re-adding a mode
  // proxy is a visible edit there rather than a bitmask widening in a copy.
  if (!predictionSafe) return PREDICTION_FLUSH;

  // Lock state changes neither editing keys nor what a printable key typed.
  const chord = mods & ~LOCK_MODS;
  if (chord === 0) {
    if (key === FUNCTIONAL_KEY.BACKSPACE) return PREDICTION_BACKSPACE;
    if (key === FUNCTIONAL_KEY.DELETE) return PREDICTION_DELETE;
    if (key === FUNCTIONAL_KEY.LEFT) return PREDICTION_CURSOR_LEFT;
    if (key === FUNCTIONAL_KEY.RIGHT) return PREDICTION_CURSOR_RIGHT;
  }
  if ((chord & ~KEY_MOD_SHIFT) === 0 && textCodePoint >= 0) {
    if (isPredictableWidthOnePrintable(textCodePoint)) return textCodePoint;
  }
  // History traversal and completion stay authority-only. PREDICTION_SAFE is
  // a daemon-issued heuristic for the PTY/editor mode, but the browser has
  // neither the shell's history nor its remote filesystem/functions/plugins.
  // ArrowUp, ArrowDown, Tab, and Shift+Tab therefore take this flush path
  // instead of guessing a valuable whole-line or multi-row result.
  //
  // The prompt anchor (MSG_TYPE_EDITOR_ANCHOR) does not change this. It
  // authenticates *geometry* — where the editable region begins — which lets
  // the speculative model re-seed after a flush and lets edits reach back to
  // the prompt. It says nothing about history contents, completion results, or
  // this shell's word semantics, so those remain authority-only. Enter is also
  // deliberately excluded, and the daemon enforces it: predicting it would mark
  // the keystroke shadow-modelled, which suppresses the daemon's pre-emptive
  // prediction revocation and is the only defense against a same-process
  // silent read.
  return PREDICTION_FLUSH;
}

function isPredictableWidthOnePrintable(codepoint: number): boolean {
  // Space advances the cursor and is part of ordinary command text. Treating
  // it as an unmodelled gap flushed "echo " and made the next printable start
  // from a stale cursor under latency. Printable ASCII is one cell under any
  // width table, so the typing path answers it here; anything else is the
  // core's question, asked of the grid's own table, so this intent, the
  // core's and the terminal's cannot disagree.
  if (codepoint >= 0x20 && codepoint <= 0x7e) return true;
  return e2eWasm().predictable_width_one(codepoint);
}

/** The Keyboard Lock API, which only Chromium ships. */
interface KeyboardLock {
  lock(): Promise<void>;
  unlock(): void;
}

function keyboardLock(): KeyboardLock | null {
  const candidate = (navigator as Navigator & { readonly keyboard?: Partial<KeyboardLock> })
    .keyboard;
  return typeof candidate?.lock === 'function' && typeof candidate.unlock === 'function'
    ? (candidate as KeyboardLock)
    : null;
}

function isHiddenInput(element: HTMLElement): boolean {
  return element.dataset.terminalHiddenInput === 'true' || element.offsetParent === null;
}

// ── Controller ───────────────────────────────────────────────────────────────

export interface TerminalInputControllerOptions {
  readonly touchKeyboardEligible: boolean;
  /**
   * The terminal panel. Every element that takes terminal input — the editing
   * surface, the accessibility mirror, the chrome that hands focus back on
   * click — lives inside it.
   */
  readonly ownerEl: HTMLElement;
  getSession(): TerminalSession | null;
  getWorkerClient(): TerminalWorkerClient | null;
  /**
   * Touch-mode editing surface element; null on desktop. The window keydown
   * fast path must not map plain keys targeted at it — soft keyboards do not
   * reliably honor preventDefault, and the text arrives via `beforeinput`.
   */
  getTouchSurfaceEl(): HTMLElement | null;
  getVirtualModifiers(): TerminalModifierState;
  clearVirtualModifiers(): void;
  /** Restore focus to the terminal input element. */
  focusTerminal(): void;
  /** The right-⌘ S focus-mode shortcut was pressed. */
  onToggleFocusMode(): void;
  /**
   * Buffered input was destroyed rather than held. User-visible: at this point
   * keystrokes the user typed are gone, which a log line alone does not convey.
   */
  onInputOverflow?(): void;
  /**
   * Input reached the terminal from somewhere other than the on-screen
   * keyboard: a hardware key, a paste, native text or a pointer report. The
   * keyboard's correction analysis ends its line here, because it can no longer
   * know what the line holds.
   */
  onNonKeyboardInput?(): void;
}

export interface TerminalInputController {
  /**
   * Destroy input that was buffered but never admitted.
   *
   * Invoked for exactly the disconnect reasons that reset the worker's outbox,
   * because the two hold different halves of the same keystroke stream and must
   * agree about which of it survives.
   */
  discardPendingInput(): void;
  /**
   * Release input parked while the session would not admit it.
   *
   * Driven by the worker's `input_ready` edge rather than polled. Idempotent.
   */
  drainPendingInput(): void;
  /** Install the window-level keyboard/paste listeners. */
  attach(): void;
  destroy(): void;
  /** Paste; the daemon brackets it when the application asked. */
  sendPaste(text: string): void;
  /** Read the clipboard and paste it (virtual-keyboard paste key). */
  pasteFromClipboard(): void;
  sendVirtualKey(
    definition: VirtualKeyDefinition,
    touchStartedAtMs?: number,
    repeat?: boolean,
  ): void;
  /** Show or clear an unsent printable selected by an active touch pointer. */
  previewVirtualKey(definition: VirtualKeyDefinition | null, pointerId: number): void;
  /** Send committed text (IME commit, emoji picker, soft-keyboard insert). */
  sendNativeText(text: string): void;
  /**
   * A mouse or wheel record. It queues behind pending keystrokes like every
   * other input, so a click can never overtake the text typed before it.
   */
  sendPointerRecord(record: Uint8Array): void;
  /** Composition began on the editing surface — gates and flushes predictions. */
  notifyCompositionStart(): void;
  /** Composition ended on the editing surface. */
  notifyCompositionEnd(): void;
}

/**
 * Single printable ASCII characters, what a system keyboard sends per tap, as
 * shared records under the key-record contract (`lib/key-record.ts`): the ring
 * copies a record synchronously and a queued entry only holds the array, so a
 * tap after a character's first allocates nothing.
 */
const PRINTABLE_ASCII_TEXT_RECORDS: (Uint8Array | undefined)[] = [];

function nativeTextRecord(text: string): Uint8Array {
  const index = text.length === 1 ? text.charCodeAt(0) - 0x20 : -1;
  if (index < 0 || index > 0x7e - 0x20) return encodeTextRecord(text);
  const cached = PRINTABLE_ASCII_TEXT_RECORDS[index];
  if (cached !== undefined) return cached;
  const record = encodeTextRecord(text);
  PRINTABLE_ASCII_TEXT_RECORDS[index] = record;
  return record;
}

export function createTerminalInputController(
  options: TerminalInputControllerOptions,
): TerminalInputController {
  /**
   * An input parked while the session would not admit it. Flat on purpose:
   * the classification primitives are scalars lifted off the record, so a
   * queued entry retains no DOM event and the prediction is minted at DRAIN
   * time, under whatever lineage is live then. This record exists only when an
   * input actually queues; the direct path passes the same scalars as
   * arguments and allocates nothing.
   */
  interface PendingInput {
    readonly session: TerminalSession;
    readonly bytes: Uint8Array;
    readonly inputAtMs: number;
    /** Kitty key number of a classifiable press, or `UNCLASSIFIED`. */
    readonly key: number;
    readonly textCodePoint: number;
    readonly mods: number;
    /** Native text and paste flush predictions against the admitted sequence. */
    readonly flushPredictions: boolean;
    /** `ResolvedKey.reportedWhen`: the mode bits under which this input encodes. */
    readonly reportedWhen: number;
    readonly touchStartedAtMs: number | null;
    readonly repeat: boolean;
  }

  const { touchKeyboardEligible } = options;
  let compositionActive = false;
  let attached = false;
  let stopTrackingRightMeta: (() => void) | null = null;
  /**
   * ONE queue, not one per source.
   *
   * Physical keys, virtual keys, paste chunks, pointer reports and native text
   * all reach the same PTY in the order the user produced them. Two queues
   * would drain independently and interleave them wrongly — which on a
   * command line is indistinguishable from corruption.
   */
  const pendingInputs: PendingInput[] = [];
  /** Retained payload bytes, bounded alongside the entry count. */
  let pendingInputBytes = 0;
  let pendingInputHead = 0;
  // The classification latch `classifyInput` reads: one stable function for
  // every keystroke, so no closure is minted per key for the ring to call back.
  let classifyingKey = UNCLASSIFIED;
  let classifyingTextCodePoint = -1;
  let classifyingMods = 0;
  let classifyingInputAtMs = 0;
  /**
   * Keys whose press was sent, by physical position, with the identity the
   * press reported. A release is sent only for these, and carries that
   * identity: Shift let go before `1` still releases the key that typed `!`.
   */
  const pressedKeys = new Map<string, KeyIdentity>();
  /**
   * Keys pressed while ⌘ was held on an Apple platform. The browser never
   * delivers their keyup while ⌘ is down, so the ⌘ keyup releases them.
   */
  const pressedUnderCommand = new Set<string>();
  /**
   * The session whose daemon has been told this window's focus. A daemon
   * learns a browser's focus only from its records, so a new session hears it
   * before anything else this controller sends on it.
   */
  let focusReportedSession: TerminalSession | null = null;
  const FOCUS_IN = encodeFocusRecord(true);
  const FOCUS_OUT = encodeFocusRecord(false);
  const inputRetry = createOwnedTimeout(
    (callback, delayMs) => setTimeout(callback, delayMs),
    (handle) => clearTimeout(handle),
  );

  // ── Senders ────────────────────────────────────────────────────────────────

  function noteNonKeyboardInput(): void {
    options.onNonKeyboardInput?.();
  }

  function sendPaste(text: string): void {
    const session = options.getSession();
    if (!session || !text) return;
    noteNonKeyboardInput();
    const workerClient = options.getWorkerClient();
    workerClient?.flushPredictions();
    let lastAcceptedSeq: number | null = null;
    // One record per chunk, each a complete paste: the daemon brackets every
    // record on its own, so a chunk refused by backpressure can never strand
    // an unmatched opening marker. `encodeInto` ends a chunk on a code point.
    let offset = 0;
    while (offset < text.length) {
      const buffer = new Uint8Array(1 + PASTE_CHUNK);
      const { length, read } = encodePasteRecordInto(buffer, text.slice(offset));
      offset += read;
      // A rejected chunk queues, and every chunk after it queues behind it
      // because the queue is non-empty, so the paste completes in order instead
      // of being truncated at the boundary.
      const accepted = sendOrQueue(
        session,
        buffer.subarray(0, length),
        terminalPerfNowMs(),
        UNCLASSIFIED,
        -1,
        0,
        false,
        REPORTED_ALWAYS,
        null,
        false,
      );
      if (accepted !== null) lastAcceptedSeq = accepted;
    }
    if (lastAcceptedSeq !== null) workerClient?.flushPredictions(lastAcceptedSeq);
  }

  function pasteFromClipboard(): void {
    void navigator.clipboard
      .readText()
      .then((text) => sendPaste(text))
      .catch(() => {});
    options.clearVirtualModifiers();
    options.focusTerminal();
  }

  function sendVirtualKey(
    definition: VirtualKeyDefinition,
    touchStartedAtMs?: number,
    repeat = false,
  ): void {
    const session = options.getSession();
    if (!session) return;
    const modifiers = options.getVirtualModifiers();
    if (definition.macro !== undefined) {
      for (const step of definition.macro) {
        const inputKey = getVirtualKeyDefinition(step.key)?.inputKey;
        if (inputKey !== undefined) sendKey(session, inputKey, step, touchStartedAtMs, false);
      }
      options.clearVirtualModifiers();
    } else {
      if (definition.inputKey === undefined) return;
      sendKey(session, definition.inputKey, modifiers, touchStartedAtMs, repeat);
      if (hasModifier(modifiers)) options.clearVirtualModifiers();
    }
    options.focusTerminal();
  }

  function sendKey(
    session: TerminalSession,
    inputKey: string,
    modifiers: TerminalModifierState,
    touchStartedAtMs: number | undefined,
    repeat: boolean,
  ): void {
    const resolved = resolveVirtualKey(inputKey, modifiers);
    if (resolved === null) return;

    const admissionAttemptAtMs = terminalPerfNowMs();
    const touchStart = validTouchStart(touchStartedAtMs, admissionAttemptAtMs)
      ? touchStartedAtMs
      : null;
    const { press, release } = resolved;
    sendOrQueue(
      session,
      press.record,
      touchStart ?? admissionAttemptAtMs,
      press.reportedWhen === REPORTED_ALWAYS ? press.identity.key : UNCLASSIFIED,
      press.textCodePoint,
      press.mods,
      false,
      press.reportedWhen,
      touchStart,
      repeat,
    );
    // A tap is a press and a release: an application reporting releases sees
    // the key come back up rather than held forever.
    if (release !== null) {
      sendOrQueue(
        session,
        release.record,
        admissionAttemptAtMs,
        UNCLASSIFIED,
        -1,
        0,
        false,
        release.reportedWhen,
        null,
        false,
      );
    }
  }

  function hasModifier(modifiers: TerminalModifierState): boolean {
    return modifiers.shift || modifiers.ctrl || modifiers.alt || modifiers.meta;
  }

  function previewVirtualKey(definition: VirtualKeyDefinition | null, pointerId: number): void {
    const workerClient = options.getWorkerClient();
    if (workerClient === null) return;
    if (definition === null || definition.inputKey === undefined) {
      workerClient.clearProvisionalPrintable(pointerId);
      return;
    }
    const resolved = resolveVirtualKey(definition.inputKey, options.getVirtualModifiers());
    if (resolved === null) {
      workerClient.clearProvisionalPrintable(pointerId);
      return;
    }
    const { press } = resolved;
    const intent = predictionIntent(
      press.identity.key,
      press.textCodePoint,
      press.mods,
      compositionActive,
      workerClient.isPredictionSafe(),
    );
    if (intent >= 0) workerClient.previewPrintable(pointerId, intent);
    else workerClient.clearProvisionalPrintable(pointerId);
  }

  function sendPointerRecord(record: Uint8Array): void {
    const session = options.getSession();
    if (!session) return;
    noteNonKeyboardInput();
    sendOrQueue(
      session,
      record,
      terminalPerfNowMs(),
      UNCLASSIFIED,
      -1,
      0,
      false,
      REPORTED_ALWAYS,
      null,
      false,
    );
  }

  /**
   * The contact timestamp comes from a pointer event converted into the perf
   * recorder's epoch domain, so it must precede admission and cannot be
   * implausibly old. A clock the page does not control produced it; rejecting
   * out-of-range values keeps one bad conversion from poisoning the metric.
   */
  function validTouchStart(value: number | undefined, inputAtMs: number): value is number {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value <= inputAtMs &&
      value >= inputAtMs - 60_000
    );
  }

  function enqueueInput(input: PendingInput): void {
    if (pendingInputs.length - pendingInputHead >= MAX_PENDING_INPUTS) {
      // This represents minutes of continuously rejected human input. Refuse an
      // unbounded stale-command buffer; ordinary transient ring pressure drains
      // long before reaching this explicit safety boundary.
      options.onInputOverflow?.();
      return;
    }
    // Entries alone were sized for single keypresses. Paste chunks are three
    // orders of magnitude larger, so the entry bound would permit tens of
    // megabytes of retained clipboard data; this is the same end-to-end backlog
    // budget the ring admits against, expressed on the other side of admission.
    if (pendingInputBytes + input.bytes.byteLength > MAX_BUFFERED_INPUT_BYTES) {
      options.onInputOverflow?.();
      return;
    }
    // Drop the NEWEST, never the oldest. Dropping from the head would punch a
    // hole in the middle of a command line; truncating the tail leaves a
    // correct prefix.
    pendingInputs.push(input);
    pendingInputBytes += input.bytes.byteLength;
    armInputRetry();
  }

  /**
   * Re-arm the drain against transient backpressure.
   *
   * Only ring/budget backpressure is polled, because only it clears on its own
   * within milliseconds. A session that is not accepting input at all is
   * waiting out a reconnect ladder that can run for `DORMANT_GRACE_MS`, and no
   * cadence is right for that: too tight is thousands of pointless main-thread
   * wakeups on a phone already having a bad time, too loose is a visible stall
   * after the session returns. Neither is necessary — the worker publishes
   * `input_ready` on exactly that transition and `drainPendingInput` runs from
   * it, so the buffer is released on the edge rather than discovered by a poll.
   */
  function armInputRetry(): void {
    if (inputRetry.isArmed()) return;
    // A controller with no session yet, or one whose session is closed, parks
    // without a timer and waits for `drainPendingInput`.
    if (options.getSession()?.isAcceptingInput() !== true) return;
    inputRetry.arm(drainInputs, INPUT_RETRY_MS);
  }

  /**
   * The worker will admit input again: drain what was parked while it would not.
   *
   * Idempotent and safe to call when nothing is pending — `drainInputs` returns
   * immediately on an empty queue. Called from the `input_ready` edge, which the
   * transport worker already filters by `startId`, so a late signal from a
   * superseded start cannot release its replacement's buffer.
   */
  function drainPendingInput(): void {
    // The `input_ready` edge is also where a new session first accepts input,
    // which is when its daemon has to learn whether this window has focus.
    const session = options.getSession();
    if (session !== null) reportFocusToNewSession(session);
    if (pendingInputs.length === 0) return;
    inputRetry.cancel();
    drainInputs();
  }

  function drainInputs(): void {
    const currentSession = options.getSession();
    if (currentSession === null && pendingInputHead < pendingInputs.length) {
      armInputRetry();
      return;
    }
    while (pendingInputHead < pendingInputs.length) {
      const pending = pendingInputs[pendingInputHead];
      if (pending === undefined) break;
      if (currentSession !== pending.session) {
        pendingInputBytes -= pending.bytes.byteLength;
        pendingInputHead += 1;
        continue;
      }
      const accepted = trySend(
        pending.session,
        pending.bytes,
        pending.inputAtMs,
        pending.key,
        pending.textCodePoint,
        pending.mods,
        pending.flushPredictions,
        pending.reportedWhen,
        pending.touchStartedAtMs,
        pending.repeat,
      );
      if (accepted === null) {
        armInputRetry();
        return;
      }
      pendingInputBytes -= pending.bytes.byteLength;
      pendingInputHead += 1;
    }
    clearPendingInputs();
  }

  /**
   * The send tail over scalars, so the direct keydown path mints no record.
   * `key` is `UNCLASSIFIED` for everything that is not a key press: releases,
   * text, paste and pointer reports are never shadow-modelled.
   */
  function trySend(
    session: TerminalSession,
    bytes: Uint8Array,
    inputAtMs: number,
    key: number,
    textCodePoint: number,
    mods: number,
    flushPredictions: boolean,
    reportedWhen: number,
    touchStartedAtMs: number | null,
    repeat: boolean,
  ): number | null {
    if (key === UNCLASSIFIED) {
      const accepted = session.sendKeystroke(bytes, inputAtMs, undefined, delivery(reportedWhen));
      if (accepted !== null && flushPredictions) {
        options.getWorkerClient()?.flushPredictions(accepted);
      }
      return accepted;
    }
    // Latched here, not at capture: the grant belongs to whatever display
    // lineage is live at admission, and `isPredictionSafe()` is read now.
    classifyingKey = key;
    classifyingTextCodePoint = textCodePoint;
    classifyingMods = mods;
    classifyingInputAtMs = inputAtMs;
    try {
      const inputSeq = session.sendKeystroke(bytes, inputAtMs, classifyInput);
      if (inputSeq !== null && touchStartedAtMs !== null && isTerminalPerfRecording()) {
        const writer = mainPerfWriter();
        if (writer !== null) {
          emitKeyboardCommit(
            writer,
            // Timestamp the successful ring admission, not the first attempt.
            // Under transient backpressure this keeps the metric honest while
            // preserving the physical pointer-down estimate from the original
            // tap callback.
            terminalPerfNowMs(),
            // The physical touch-down itself, so this stage measures pointer
            // dispatch and key recognition rather than a duration the engine
            // would have to report as zero for a key decided at touch-down.
            touchStartedAtMs,
            inputSeq,
            repeat,
          );
        }
      }
      return inputSeq;
    } finally {
      classifyingKey = UNCLASSIFIED;
    }
  }

  /**
   * Input every application receives is awaited. Anything else is sent now
   * only while the terminal's mode word says it encodes to bytes; otherwise it
   * is held in the ring and leaves with the next input, costing no datagram
   * and no acknowledgement. The word is one frame stale at worst, and a rising
   * edge releases whatever was held under the old one.
   */
  function delivery(reportedWhen: number): InputDelivery {
    if (reportedWhen === REPORTED_ALWAYS) return INPUT_AWAITED;
    const mode = options.getWorkerClient()?.terminalMode() ?? 0;
    return (mode & reportedWhen) === reportedWhen ? INPUT_UNAWAITED : INPUT_DEFERRED;
  }

  function classifyInput(inputSeq: number): boolean {
    const key = classifyingKey;
    const workerClient = options.getWorkerClient();
    if (key === UNCLASSIFIED || workerClient === null) return false;
    const intent = predictionIntent(
      key,
      classifyingTextCodePoint,
      classifyingMods,
      compositionActive,
      workerClient.isPredictionSafe(),
    );
    return applyPredictionIntent(workerClient, intent, inputSeq, classifyingInputAtMs);
  }

  /**
   * Send now, or queue behind whatever is already queued.
   *
   * The ordering rule every producer must obey: once anything is pending, a new
   * input goes BEHIND it. Admitting directly while the queue is non-empty would
   * put a later keystroke ahead of earlier ones and scramble the command line.
   *
   * `bytes` are the caller's: sending copies them into the input ring, and
   * queueing keeps its own copy, so a producer may encode every record into
   * one buffer.
   */
  function sendOrQueue(
    session: TerminalSession,
    bytes: Uint8Array,
    inputAtMs: number,
    key: number,
    textCodePoint: number,
    mods: number,
    flushPredictions: boolean,
    reportedWhen: number,
    touchStartedAtMs: number | null,
    repeat: boolean,
  ): number | null {
    discardInputsForReplacedSession(session);
    reportFocusToNewSession(session);
    if (pendingInputHead === pendingInputs.length) {
      const accepted = trySend(
        session,
        bytes,
        inputAtMs,
        key,
        textCodePoint,
        mods,
        flushPredictions,
        reportedWhen,
        touchStartedAtMs,
        repeat,
      );
      if (accepted !== null) return accepted;
    }
    enqueueInput({
      session,
      bytes: bytes.slice(),
      inputAtMs,
      key,
      textCodePoint,
      mods,
      flushPredictions,
      reportedWhen,
      touchStartedAtMs,
      repeat,
    });
    return null;
  }

  function reportFocus(session: TerminalSession, focused: boolean): void {
    focusReportedSession = session;
    // The same edge decides who owns the shared geometry: the focused window
    // claims it, so its own layout — the on-screen keyboard, rotation, a window
    // resize — is what the shell is sized to.
    session.setWindowFocused(focused);
    sendOrQueue(
      session,
      focused ? FOCUS_IN : FOCUS_OUT,
      terminalPerfNowMs(),
      UNCLASSIFIED,
      -1,
      0,
      false,
      TERMINAL_MODE_FOCUS,
      null,
      false,
    );
  }

  /** Tell a session's daemon this window's focus, once, before other input. */
  function reportFocusToNewSession(session: TerminalSession): void {
    if (!attached || session === focusReportedSession) return;
    reportFocus(session, document.hasFocus());
  }

  const onWindowFocus = (): void => {
    const session = options.getSession();
    if (session !== null) reportFocus(session, true);
  };

  const onWindowBlur = (): void => {
    releaseAllPressed();
    const session = options.getSession();
    if (session !== null) reportFocus(session, false);
  };

  function discardInputsForReplacedSession(session: TerminalSession): void {
    const pending = pendingInputs[pendingInputHead];
    if (pending === undefined || pending.session === session) return;
    clearPendingInputs();
  }

  function clearPendingInputs(): void {
    pendingInputs.length = 0;
    pendingInputHead = 0;
    pendingInputBytes = 0;
    inputRetry.cancel();
  }

  function sendNativeText(text: string): void {
    const session = options.getSession();
    if (!session || text.length === 0) return;
    noteNonKeyboardInput();
    const workerClient = options.getWorkerClient();
    workerClient?.flushPredictions();

    const modifiers = options.getVirtualModifiers();
    if (!modifiers.ctrl && !modifiers.alt && !modifiers.meta) {
      // `flushPredictions` rides the entry so a queued send still drops stale
      // predictions when it is finally admitted, not when it was typed.
      sendOrQueue(
        session,
        nativeTextRecord(text),
        terminalPerfNowMs(),
        UNCLASSIFIED,
        -1,
        0,
        true,
        REPORTED_ALWAYS,
        null,
        false,
      );
      return;
    }

    // A latched Ctrl, Alt or ⌘ applies to what the soft keyboard typed, so
    // each character becomes the key that types it.
    for (const char of text) {
      const resolved = resolveVirtualKey(char === '\n' ? 'Enter' : char, modifiers);
      if (resolved === null) continue;
      for (const record of [resolved.press, resolved.release]) {
        if (record === null) continue;
        sendOrQueue(
          session,
          record.record,
          terminalPerfNowMs(),
          UNCLASSIFIED,
          -1,
          0,
          true,
          record.reportedWhen,
          null,
          false,
        );
      }
    }
    options.clearVirtualModifiers();
  }

  // ── Composition gate (driven by the editing surface) ──────────────────────

  function notifyCompositionStart(): void {
    compositionActive = true;
    options.getWorkerClient()?.flushPredictions();
  }

  function notifyCompositionEnd(): void {
    compositionActive = false;
  }

  // ── Window listeners (keydown/keyup fast path, paste) ─────────────────────

  /** Whether the held Alt composes text: the right Option on Apple keyboards. */
  function altComposes(e: KeyboardEvent): boolean {
    return IS_APPLE_PLATFORM && e.altKey && isRightAltHeld();
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const handlerEnteredAtMs = isTerminalPerfRecording() ? terminalPerfNowMs() : 0;
    // First, ahead of every shortcut below it. This listener is on the window
    // and knows nothing about the command palette or the dialogs stacked over
    // the terminal, so a field that owns focus is the only signal that the
    // press was aimed somewhere else — and the clipboard shortcuts in
    // particular used to run before this check, which sent a ⌘V aimed at the
    // palette's query straight into the shell as a paste.
    const tgt = e.target;
    if (
      (tgt instanceof HTMLInputElement ||
        tgt instanceof HTMLTextAreaElement ||
        tgt instanceof HTMLSelectElement) &&
      !isHiddenInput(tgt)
    )
      return;
    if (tgt instanceof HTMLElement && tgt.isContentEditable && !isHiddenInput(tgt)) return;
    // Focus on a control outside the panel — a dialog's button, the update
    // banner — means the press is that control's: Enter and Space activate it
    // and Tab leaves it. With nothing focused the target is the body, which
    // stays the terminal's.
    if (
      tgt instanceof HTMLElement &&
      tgt !== document.body &&
      tgt !== document.documentElement &&
      !options.ownerEl.contains(tgt)
    )
      return;

    // Right ⌘ only, so left ⌘ S still reaches the terminal and the shortcut
    // cannot fire from a chord the user aimed at the shell.
    if (e.metaKey && isRightMetaHeld() && e.key.toLowerCase() === FOCUS_MODE_SHORTCUT_KEY) {
      e.preventDefault();
      e.stopPropagation();
      options.onToggleFocusMode();
      return;
    }

    const session = options.getSession();
    if (!session || e.defaultPrevented) return;

    // IME composition owns these keydowns. Recording or preventDefault-ing
    // them would break the composition or double-send the composed text.
    // `isComposing` is the spec-blessed signal; keyCode 229 / key 'Process'
    // cover engines that under-report it on the first keydown of a
    // composition; 'Dead' lets dead-key accents compose in the surface.
    if (e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') return;

    // Plain keys targeted at the touch editing surface flow through its
    // `beforeinput` path (soft keyboards do not reliably honor preventDefault
    // on keydown; recording here would double-send). The surface owns the
    // Backspace/Delete intent dedup and preventDefaults those keydowns, which
    // the `defaultPrevented` check above already filters out.
    if (touchKeyboardEligible && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const touchEl = options.getTouchSurfaceEl();
      if (touchEl !== null && e.target === touchEl) return;
    }

    // Ctrl+Shift+V (Linux/Windows) or Cmd+V (macOS) → paste from clipboard
    if ((e.ctrlKey && e.shiftKey && e.key === 'V') || (e.metaKey && !e.ctrlKey && e.key === 'v')) {
      e.preventDefault();
      void navigator.clipboard
        .readText()
        .then((t) => sendPaste(t))
        .catch(() => {});
      return;
    }

    // Copy. The selection lives in the DOM selection layer, so the browser's
    // own copy pipeline owns it and the text reaches the clipboard inside this
    // gesture — which is the whole point, because WebKit refuses a write once
    // the handler has returned. Cmd+C must NOT be preventDefault'd: cancelling
    // the default cancels the copy. Ctrl+Shift+C has no native binding, so it
    // dispatches the same `copy` event over the same selection instead. Plain
    // Ctrl+C is deliberately untouched and still reaches the PTY as SIGINT.
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      e.preventDefault();
      document.execCommand('copy');
      return;
    }
    if (e.metaKey && !e.ctrlKey && e.key === 'c') return;

    // An autorepeat of a key whose press was never sent (its press went to a
    // shortcut, or ⌘'s keyup already released it) starts it afresh.
    const keyEvent: KeyEvent =
      e.repeat && pressedKeys.has(e.code) ? KEY_EVENT_REPEAT : KEY_EVENT_PRESS;
    const composes = altComposes(e);
    const resolved = resolveKeyboardEvent(e, keyEvent, composes);
    if (resolved === null) return;

    e.preventDefault();
    pressedKeys.set(e.code, resolved.identity);
    if (IS_APPLE_PLATFORM && e.metaKey && e.key !== 'Meta') pressedUnderCommand.add(e.code);
    // Scalars lifted off the resolution: the direct path passes them straight
    // to the send tail and mints nothing; only a queued entry becomes a record,
    // and that record retains no DOM object. Prediction is minted at admission
    // rather than at capture either way.
    sendOrQueue(
      session,
      resolved.record,
      handlerEnteredAtMs === 0
        ? terminalPerfNowMs()
        : physicalKeyboardInputAtMs(e.timeStamp, handlerEnteredAtMs),
      // A bare modifier is sent for the applications that report it, but it
      // types nothing: it is neither modelled nor allowed to flush predictions.
      resolved.reportedWhen === REPORTED_ALWAYS ? resolved.identity.key : UNCLASSIFIED,
      resolved.textCodePoint,
      resolved.mods,
      false,
      resolved.reportedWhen,
      null,
      false,
    );
    noteNonKeyboardInput();
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const identity = pressedKeys.get(e.code);
    if (identity === undefined) return;
    const session = options.getSession();
    const mods = modifiersOf(e, altComposes(e));
    if (IS_APPLE_PLATFORM && e.key === 'Meta') {
      // The browser swallowed the keyups of every key released while ⌘ was
      // down; this keyup is the moment they are known to be up.
      for (const code of pressedUnderCommand) {
        const held = pressedKeys.get(code);
        pressedKeys.delete(code);
        if (held !== undefined && session !== null) sendRelease(session, held, mods);
      }
      pressedUnderCommand.clear();
    }
    pressedKeys.delete(e.code);
    pressedUnderCommand.delete(e.code);
    if (session !== null) sendRelease(session, identity, mods);
  };

  function sendRelease(session: TerminalSession, identity: KeyIdentity, mods: number): void {
    const release = resolveRelease(identity, mods);
    if (release === null) return;
    sendOrQueue(
      session,
      release.record,
      terminalPerfNowMs(),
      UNCLASSIFIED,
      -1,
      0,
      false,
      release.reportedWhen,
      null,
      false,
    );
  }

  /**
   * Keys held when the window loses focus never deliver their keyup here, so
   * they are released at the loss — what a native terminal reports too.
   */
  function releaseAllPressed(): void {
    const session = options.getSession();
    if (session !== null) {
      for (const identity of pressedKeys.values()) sendRelease(session, identity, 0);
    }
    pressedKeys.clear();
    pressedUnderCommand.clear();
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') releaseAllPressed();
  };

  function physicalKeyboardInputAtMs(eventTimeStamp: number, handlerEnteredAtMs: number): number {
    if (!Number.isFinite(eventTimeStamp) || eventTimeStamp <= 0) return handlerEnteredAtMs;
    const candidate =
      eventTimeStamp > 1_000_000_000_000 ? eventTimeStamp : performance.timeOrigin + eventTimeStamp;
    if (
      !Number.isFinite(candidate) ||
      candidate > handlerEnteredAtMs + 1 ||
      candidate < handlerEnteredAtMs - 60_000
    ) {
      return handlerEnteredAtMs;
    }
    return Math.min(candidate, handlerEnteredAtMs);
  }

  function applyPredictionIntent(
    workerClient: TerminalWorkerClient,
    intent: number,
    inputSeq: number,
    inputAtMs: number,
  ): boolean {
    if (intent === PREDICTION_BACKSPACE) {
      return workerClient.predictBackspace(inputSeq, inputAtMs);
    } else if (intent === PREDICTION_DELETE) {
      return workerClient.predictDelete(inputSeq, inputAtMs);
    } else if (intent === PREDICTION_CURSOR_LEFT) {
      return workerClient.predictCursorShift(inputSeq, -1, inputAtMs);
    } else if (intent === PREDICTION_CURSOR_RIGHT) {
      return workerClient.predictCursorShift(inputSeq, 1, inputAtMs);
    } else if (intent >= 0) {
      return workerClient.predictPrintable(inputSeq, intent, inputAtMs);
    }
    workerClient.flushPredictions(inputSeq);
    return false;
  }

  const onPaste = (e: ClipboardEvent): void => {
    const tgt = e.target;
    if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    sendPaste(text);
  };

  function attach(): void {
    if (attached) return;
    attached = true;
    stopTrackingRightMeta = observeRightMeta();
    // The browser honours the lock only while the page is fullscreen, so in a
    // window ⌘W and ⌘T still close and open tabs, and in fullscreen they are
    // the terminal's. Where the API is absent the browser keeps them always.
    keyboardLock()
      ?.lock()
      .catch(() => {});
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('paste', onPaste);
  }

  function destroy(): void {
    clearPendingInputs();
    pressedKeys.clear();
    pressedUnderCommand.clear();
    focusReportedSession = null;
    if (attached) {
      attached = false;
      keyboardLock()?.unlock();
      stopTrackingRightMeta?.();
      stopTrackingRightMeta = null;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('focus', onWindowFocus);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('paste', onPaste);
    }
  }

  return {
    attach,
    destroy,
    /**
     * Destroy buffered, never-admitted input.
     *
     * Called for exactly the disconnect reasons that reset the worker's outbox
     * (`shouldPreserveInputOnDisconnect`). The two must agree: this buffer holds
     * keystrokes the outbox never saw, so replaying it after an `auth-failed`
     * would deliver input typed under one identity into another, and after a
     * queue overflow would re-overflow the queue that just failed.
     */
    discardPendingInput: clearPendingInputs,
    drainPendingInput,
    sendPaste,
    pasteFromClipboard,
    sendVirtualKey,
    previewVirtualKey,
    sendNativeText,
    sendPointerRecord,
    notifyCompositionStart,
    notifyCompositionEnd,
  };
}
