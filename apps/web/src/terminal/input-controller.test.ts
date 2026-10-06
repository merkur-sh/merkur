import { describe, expect, test } from 'bun:test';
import {
  type DecodedInputRecord,
  decodeInputRecord,
  encodeMouseRecordInto,
  FUNCTIONAL_KEY,
  KEY_EVENT_PRESS,
  KEY_EVENT_RELEASE,
  KEY_MOD_ALT,
  KEY_MOD_CAPS_LOCK,
  KEY_MOD_CTRL,
  KEY_MOD_SHIFT,
  KEY_MOD_SUPER,
  MOUSE_ACTION_MOTION,
  MOUSE_BUTTON_NONE,
  MOUSE_RECORD_MAX_BYTES,
} from '@merkur/protocol';
import {
  TERMINAL_MODE_FOCUS,
  TERMINAL_MODE_KEY_RELEASES,
  TERMINAL_MODE_MODIFIER_KEYS,
} from '@merkur/shared';
import type { TerminalWorkerClient } from '../terminal-worker-client';
import {
  INPUT_AWAITED,
  INPUT_DEFERRED,
  INPUT_UNAWAITED,
  type InputDelivery,
  type TerminalSession,
} from '../transport-worker-client';
import {
  createTerminalInputController,
  PREDICTION_BACKSPACE,
  PREDICTION_CURSOR_LEFT,
  PREDICTION_CURSOR_RIGHT,
  PREDICTION_DELETE,
  PREDICTION_FLUSH,
  predictionIntent,
  type TerminalInputControllerOptions,
} from './input-controller';

interface IntentOverrides {
  readonly mods?: number;
  readonly compositionActive?: boolean;
  readonly predictionSafe?: boolean;
}

/**
 * Names the positional arguments for readability. Production passes them
 * directly — this object exists only so the assertions below stay legible, and
 * never on the per-keystroke path.
 */
function intentFor(key: number, text: string | null, overrides: IntentOverrides = {}): number {
  return predictionIntent(
    key,
    text === null ? -1 : (text.codePointAt(0) ?? -1),
    overrides.mods ?? 0,
    overrides.compositionActive ?? false,
    overrides.predictionSafe ?? true,
  );
}

const A = 0x61;

describe('predictionIntent', () => {
  test('returns the codepoint itself for plain printables', () => {
    expect(intentFor(A, 'a')).toBe(0x61);
    expect(intentFor(0x20, ' ')).toBe(0x20);
  });

  test('predicts the shifted and caps-locked text a key typed', () => {
    expect(intentFor(A, 'A', { mods: KEY_MOD_SHIFT })).toBe(0x41);
    expect(intentFor(A, 'A', { mods: KEY_MOD_CAPS_LOCK })).toBe(0x41);
  });

  test('every non-printable sentinel is negative and distinct', () => {
    const sentinels = [
      PREDICTION_FLUSH,
      PREDICTION_BACKSPACE,
      PREDICTION_DELETE,
      PREDICTION_CURSOR_LEFT,
      PREDICTION_CURSOR_RIGHT,
    ];
    expect(new Set(sentinels).size).toBe(sentinels.length);
    for (const sentinel of sentinels) expect(sentinel).toBeLessThan(0);
  });

  test('routes backspace, delete, and arrows without modifiers', () => {
    expect(intentFor(FUNCTIONAL_KEY.BACKSPACE, null)).toBe(PREDICTION_BACKSPACE);
    expect(intentFor(FUNCTIONAL_KEY.DELETE, null)).toBe(PREDICTION_DELETE);
    expect(intentFor(FUNCTIONAL_KEY.LEFT, null)).toBe(PREDICTION_CURSOR_LEFT);
    expect(intentFor(FUNCTIONAL_KEY.RIGHT, null)).toBe(PREDICTION_CURSOR_RIGHT);
    expect(intentFor(FUNCTIONAL_KEY.LEFT, null, { mods: KEY_MOD_CAPS_LOCK })).toBe(
      PREDICTION_CURSOR_LEFT,
    );
  });

  test('any modifier disqualifies the editing keys', () => {
    expect(intentFor(FUNCTIONAL_KEY.BACKSPACE, null, { mods: KEY_MOD_SHIFT })).toBe(
      PREDICTION_FLUSH,
    );
    expect(intentFor(FUNCTIONAL_KEY.LEFT, null, { mods: KEY_MOD_CTRL })).toBe(PREDICTION_FLUSH);
  });

  test('flushes while composing or when the grant is closed', () => {
    expect(intentFor(A, 'a', { compositionActive: true })).toBe(PREDICTION_FLUSH);
    expect(intentFor(A, 'a', { predictionSafe: false })).toBe(PREDICTION_FLUSH);
  });

  test('flushes control-modified keys and combining marks', () => {
    expect(intentFor(A, null, { mods: KEY_MOD_CTRL })).toBe(PREDICTION_FLUSH);
    expect(intentFor(A, 'a', { mods: KEY_MOD_SUPER })).toBe(PREDICTION_FLUSH);
    // U+0301 combining acute accent is not width-one predictable.
    expect(intentFor(0x301, '́')).toBe(PREDICTION_FLUSH);
  });

  test('keeps history traversal, completion and Enter authority-only', () => {
    expect(intentFor(FUNCTIONAL_KEY.UP, null)).toBe(PREDICTION_FLUSH);
    expect(intentFor(FUNCTIONAL_KEY.DOWN, null)).toBe(PREDICTION_FLUSH);
    expect(intentFor(FUNCTIONAL_KEY.TAB, null)).toBe(PREDICTION_FLUSH);
    expect(intentFor(FUNCTIONAL_KEY.TAB, null, { mods: KEY_MOD_SHIFT })).toBe(PREDICTION_FLUSH);
    expect(intentFor(FUNCTIONAL_KEY.ENTER, null)).toBe(PREDICTION_FLUSH);
  });
});

// ── Controller senders (typed fakes, no DOM) ─────────────────────────────────

interface SentFrame {
  readonly bytes: Uint8Array;
  readonly source: Uint8Array;
  readonly shadowModelled: boolean;
  readonly delivery: InputDelivery;
}

function createFakeSession(
  sent: SentFrame[],
  acceptAttempt: (attempt: number) => boolean = () => true,
  isAcceptingInput: () => boolean = () => true,
): TerminalSession {
  let attempts = 0;
  return {
    start: () => Promise.resolve(),
    isAcceptingInput,
    sendKeystroke(
      input: Uint8Array,
      _inputAtMs?: number,
      classifyShadowModelled?: (inputSeq: number) => boolean,
      delivery: InputDelivery = INPUT_AWAITED,
    ): number | null {
      attempts += 1;
      if (!acceptAttempt(attempts)) return null;
      const seq = sent.length + 1;
      sent.push({
        bytes: input.slice(),
        source: input,
        shadowModelled: classifyShadowModelled?.(seq) === true,
        delivery,
      });
      return seq;
    },
    releaseDeferredInput: () => {},
    sendResize: () => {},
    takeGeometryControl: () => {},
    requestDisplaySnapshot: () => {},
    notifyResumed: () => {},
    sendTransportHint: () => {},
    getConnectionQuality: () => ({
      rttMs: null,
      rttFloorMs: null,
      inputAckMs: null,
      inputAckSeq: 0,
      path: 'unknown',
      state: 'ready',
      degraded: false,
      resyncCount: 0,
      seq: 0,
    }),
    setWindowFocused: () => {},
    onConnectionQualityChange: () => () => {},
    getThroughput: () => ({ txBytes: 0, rxBytes: 0 }),
    onTransportActivity: () => () => {},
    close: () => {},
  };
}

interface FakeWorkerState {
  flushes: number;
  flushInputSeqs?: Array<number | undefined>;
  printablePredictions?: Array<{ readonly inputSeq: number; readonly codepoint: number }>;
  provisionalPrintables?: Array<{ readonly pointerId: number; readonly codepoint: number }>;
  clearedProvisionalPointers?: number[];
  /** The display mode word the fake reports; 0 when absent. */
  mode?: number;
}

function createFakeWorkerClient(state: FakeWorkerState): TerminalWorkerClient {
  return {
    resize: () => {},
    refreshLayout: () => {},
    refreshRender: () => {},
    updateFont: () => {},
    updateFontFamily: () => {},
    updateTheme: () => {},
    setSelectionEnabled: () => {},
    setLinkModifierLatched: () => {},
    getViewportText: () => false,
    setPreedit: () => {},
    isAltScreenActive: () => false,
    isPredictionSafe: () => true,
    terminalMode: () => state.mode ?? 0,
    previewPrintable: (pointerId, codepoint) => {
      state.provisionalPrintables?.push({ pointerId, codepoint });
      return true;
    },
    clearProvisionalPrintable: (pointerId) => {
      state.clearedProvisionalPointers?.push(pointerId);
    },
    predictPrintable: (inputSeq, codepoint) => {
      state.printablePredictions?.push({ inputSeq, codepoint });
      return true;
    },
    predictBackspace: () => true,
    predictDelete: () => true,
    predictCursorShift: () => true,
    flushPredictions: (inputSeq) => {
      state.flushes += 1;
      state.flushInputSeqs?.push(inputSeq);
    },
    updateRtt: () => {},
    resetSrtt: () => {},
    updateDisplayEnv: () => {},
    notifyDisplayAvailable: () => {},
    requestHealth: () => {},
    verifyGridConvergence: () => Promise.reject(new Error('not available in input test')),
    readDisplayRingBoundary: () => Promise.reject(new Error('not available in input test')),
    notifySessionEpoch: () => {},
    close: () => {},
  };
}

/** A terminal panel containing exactly `inside`. */
function fakePanel(...inside: readonly object[]): HTMLElement {
  return { contains: (node: unknown) => inside.includes(node as object) } as unknown as HTMLElement;
}

function createController(
  sent: SentFrame[],
  state: FakeWorkerState,
  acceptAttempt?: (attempt: number) => boolean,
  modifiers = { shift: false, ctrl: false, alt: false, meta: false },
  ownerEl: HTMLElement = fakePanel(),
): ReturnType<typeof createTerminalInputController> {
  const session = createFakeSession(sent, acceptAttempt);
  const workerClient = createFakeWorkerClient(state);
  const options: TerminalInputControllerOptions = {
    touchKeyboardEligible: false,
    ownerEl,
    getSession: () => session,
    getWorkerClient: () => workerClient,
    getTouchSurfaceEl: () => null,
    getVirtualModifiers: () => modifiers,
    clearVirtualModifiers: () => {},
    focusTerminal: () => {},
    onToggleFocusMode: () => {},
  };
  return createTerminalInputController(options);
}

/**
 * Let the input queue's retry timer run. The drain re-arms at 4 ms while the
 * session is accepting input, so a few turns covers a short backlog.
 */
async function waitForDrain(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function decoded(frame: SentFrame | undefined): DecodedInputRecord {
  const record = frame === undefined ? null : decodeInputRecord(frame.bytes);
  if (record === null) throw new Error('sent bytes are not a canonical input record');
  return record;
}

/** The text every text, paste, and key press record typed, in order. */
function typedText(sent: SentFrame[]): string {
  let text = '';
  for (const frame of sent) {
    const record = decoded(frame);
    if (record.kind === 'text' || record.kind === 'paste') text += record.text;
    else if (record.kind === 'key' && record.event === KEY_EVENT_PRESS) {
      if (record.key === FUNCTIONAL_KEY.TAB) text += '\t';
      else text += record.text ?? '';
    }
  }
  return text;
}

describe('input controller paste', () => {
  test('a paste is one paste record the daemon brackets', () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = { flushes: 0, flushInputSeqs: [] };
    const controller = createController(sent, state);

    controller.sendPaste('safe\x1b[201~; rm -rf /\x1b');
    expect(sent).toHaveLength(1);
    expect(decoded(sent[0])).toEqual({ kind: 'paste', text: 'safe\x1b[201~; rm -rf /\x1b' });
    expect(state.flushInputSeqs).toEqual([undefined, 1]);
    expect(sent.every((frame) => !frame.shadowModelled)).toBe(true);
  });

  test('large pastes are chunked but text-identical', () => {
    const sent: SentFrame[] = [];
    const controller = createController(sent, { flushes: 0 });

    const big = 'x'.repeat(20_000);
    controller.sendPaste(big);
    expect(sent).toHaveLength(3);
    expect(typedText(sent)).toBe(big);
  });

  test('a chunk boundary never splits a code point', () => {
    const sent: SentFrame[] = [];
    const controller = createController(sent, { flushes: 0 });
    // Three-byte characters never divide an 8 KiB chunk evenly.
    const big = '€'.repeat(5_000);

    controller.sendPaste(big);
    expect(sent.length).toBeGreaterThan(1);
    expect(typedText(sent)).toBe(big);
  });

  test('a rejected chunk queues the rest behind it', () => {
    const sent: SentFrame[] = [];
    // If the controller admitted past the refusal, attempt 3 would be accepted.
    const controller = createController(sent, { flushes: 0 }, (attempt) => attempt !== 2);

    controller.sendPaste('x'.repeat(20_000));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.bytes).toHaveLength(1 + 8 * 1024);
  });
});

describe('input controller native text', () => {
  test('committed text is one text record, newlines and all', () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = { flushes: 0, flushInputSeqs: [] };
    const controller = createController(sent, state);

    controller.sendNativeText('echo hi\n');
    expect(sent.map(decoded)).toEqual([{ kind: 'text', text: 'echo hi\n' }]);
    expect(state.flushInputSeqs).toEqual([undefined, 1]);
    expect(sent.every((frame) => !frame.shadowModelled)).toBe(true);
  });

  test('a latched Ctrl turns each committed character into its key', () => {
    const sent: SentFrame[] = [];
    const controller = createController(sent, { flushes: 0 }, undefined, {
      shift: false,
      ctrl: true,
      alt: false,
      meta: false,
    });

    controller.sendNativeText('c');
    expect(sent.map(decoded)).toEqual([
      {
        kind: 'key',
        event: KEY_EVENT_PRESS,
        key: 0x63,
        mods: KEY_MOD_CTRL,
        shifted: null,
        base: null,
        text: null,
      },
      {
        kind: 'key',
        event: KEY_EVENT_RELEASE,
        key: 0x63,
        mods: KEY_MOD_CTRL,
        shifted: null,
        base: null,
        text: null,
      },
    ]);
  });
});

describe('input controller virtual keyboard', () => {
  test('stages and clears an unsent printable for immediate touch feedback', () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = {
      flushes: 0,
      provisionalPrintables: [],
      clearedProvisionalPointers: [],
    };
    const controller = createController(sent, state);
    const a = { id: 'key-a', label: 'a', inputKey: 'a' } as const;

    controller.previewVirtualKey(a, 17);
    expect(sent).toHaveLength(0);
    expect(state.provisionalPrintables).toEqual([{ pointerId: 17, codepoint: 97 }]);
    controller.previewVirtualKey(null, 17);
    expect(state.clearedProvisionalPointers).toEqual([17]);
    controller.destroy();
  });

  test('a tap is a modelled press followed by an unmodelled release', () => {
    const sent: SentFrame[] = [];
    const controller = createController(sent, { flushes: 0 });

    controller.sendVirtualKey({ id: 'key-a', label: 'a', inputKey: 'a' });

    expect(sent.map(decoded)).toEqual([
      {
        kind: 'key',
        event: KEY_EVENT_PRESS,
        key: A,
        mods: 0,
        shifted: null,
        base: null,
        text: 'a',
      },
      {
        kind: 'key',
        event: KEY_EVENT_RELEASE,
        key: A,
        mods: 0,
        shifted: null,
        base: null,
        text: null,
      },
    ]);
    expect(sent.map((frame) => frame.shadowModelled)).toEqual([true, false]);
    // A plain letter is a two-byte record.
    expect(sent[0]?.bytes).toHaveLength(2);
    controller.destroy();
  });

  test('retries transient admission failure without reordering rapid keys', async () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = {
      flushes: 0,
      flushInputSeqs: [],
      printablePredictions: [],
    };
    const controller = createController(sent, state, (attempt) => attempt !== 1);

    controller.sendVirtualKey({ id: 'key-a', label: 'a', inputKey: 'a' });
    controller.sendVirtualKey({ id: 'key-b', label: 'b', inputKey: 'b' });
    expect(sent).toHaveLength(0);

    await Bun.sleep(20);

    expect(typedText(sent)).toBe('ab');
    expect(state.flushInputSeqs).toEqual([]);
    expect(state.printablePredictions).toEqual([
      { inputSeq: 1, codepoint: 97 },
      { inputSeq: 3, codepoint: 98 },
    ]);
    controller.destroy();
  });

  test('keeps completion authority-only while predicting ordinary virtual characters', () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = {
      flushes: 0,
      flushInputSeqs: [],
      printablePredictions: [],
    };
    const controller = createController(sent, state);

    controller.sendVirtualKey({ id: 'key-a', label: 'a', inputKey: 'a' });
    controller.sendVirtualKey({ id: 'tab', label: 'tab', inputKey: 'Tab' });

    expect(typedText(sent)).toBe('a\t');
    expect(state.printablePredictions).toEqual([{ inputSeq: 1, codepoint: 97 }]);
    expect(state.flushInputSeqs).toEqual([3]);
    expect(sent.map((frame) => frame.shadowModelled)).toEqual([true, false, false, false]);
    controller.destroy();
  });

  test('reuses immutable records for repeated keys', () => {
    const sent: SentFrame[] = [];
    const controller = createController(sent, { flushes: 0 });
    const a = { id: 'key-a', label: 'a', inputKey: 'a' } as const;

    controller.sendVirtualKey(a);
    controller.sendVirtualKey(a);

    expect(sent).toHaveLength(4);
    expect(sent[0]?.source).toBe(sent[2]?.source);
    expect(sent[1]?.source).toBe(sent[3]?.source);
    controller.destroy();
  });

  test('drains a rapid queued burst without drops or reordering', async () => {
    const sent: SentFrame[] = [];
    const controller = createController(sent, { flushes: 0 }, (attempt) => attempt !== 1);
    const a = { id: 'key-a', label: 'a', inputKey: 'a' } as const;
    const b = { id: 'key-b', label: 'b', inputKey: 'b' } as const;

    for (let index = 0; index < 1_000; index += 1) {
      controller.sendVirtualKey(index & 1 ? b : a);
    }
    await Bun.sleep(20);

    expect(sent).toHaveLength(2_000);
    expect(typedText(sent)).toBe('ab'.repeat(500));
    expect(sent.filter((_, index) => index % 2 === 0).every((frame) => frame.shadowModelled)).toBe(
      true,
    );
    controller.destroy();
  });
});

describe('input controller composition gate', () => {
  test('notifyCompositionStart flushes predictions; end does not re-flush', () => {
    const sent: SentFrame[] = [];
    const state = { flushes: 0 };
    const controller = createController(sent, state);

    controller.notifyCompositionStart();
    expect(state.flushes).toBe(1);
    controller.notifyCompositionEnd();
    expect(state.flushes).toBe(1);
  });

  /**
   * The gap this closes: input refused by the ring was dropped outright — for
   * physical keys `onKeyDown` simply returned — so anything typed while a
   * session was restarting was gone for good.
   */
  test('input refused by the ring is replayed, not lost', async () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = { flushes: 0, flushInputSeqs: [] };
    // Reject the first attempt, accept everything after it.
    const controller = createController(sent, state, (attempt) => attempt > 1);

    controller.sendNativeText('a');
    expect(sent.length, 'the first attempt was refused').toBe(0);

    await waitForDrain();
    expect(typedText(sent)).toBe('a');
    controller.destroy();
  });

  /**
   * The ordering rule every producer obeys: once anything is pending, later
   * input goes BEHIND it. Admitting directly past a non-empty queue would
   * reorder the command line, which is indistinguishable from corruption.
   */
  test('input produced after a refusal queues behind it', async () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = { flushes: 0, flushInputSeqs: [] };
    const controller = createController(sent, state, (attempt) => attempt > 1);

    controller.sendNativeText('a');
    controller.sendNativeText('b');
    controller.sendPointerRecord(Uint8Array.of(0x80, 1, 1, 1));
    controller.sendNativeText('c');

    await waitForDrain();
    expect(typedText(sent)).toBe('abc');
    expect(decoded(sent[2]).kind).toBe('wheel');
    controller.destroy();
  });

  /**
   * Pointer motion is encoded into one record for every cell crossing. What is
   * sent at once is copied into the ring before the call returns; what has to
   * wait is the controller's own copy, so the next crossing cannot rewrite it.
   */
  test('a queued record survives its producer reusing the buffer', async () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = { flushes: 0, flushInputSeqs: [] };
    const controller = createController(sent, state, (attempt) => attempt > 1);
    const scratch = new Uint8Array(MOUSE_RECORD_MAX_BYTES);
    const report = (column: number, row: number): Uint8Array =>
      scratch.subarray(
        0,
        encodeMouseRecordInto(scratch, MOUSE_ACTION_MOTION, MOUSE_BUTTON_NONE, 0, column, row),
      );

    // Refused, so it queues; the second goes behind it into the same scratch.
    controller.sendPointerRecord(report(300, 7));
    controller.sendPointerRecord(report(301, 7));
    scratch.fill(0xff);

    await waitForDrain();
    expect(sent.map(decoded)).toEqual([
      {
        kind: 'mouse',
        action: MOUSE_ACTION_MOTION,
        button: MOUSE_BUTTON_NONE,
        mods: 0,
        column: 300,
        row: 7,
      },
      {
        kind: 'mouse',
        action: MOUSE_ACTION_MOTION,
        button: MOUSE_BUTTON_NONE,
        mods: 0,
        column: 301,
        row: 7,
      },
    ]);
    controller.destroy();
  });

  /**
   * Buffered input must never outlive the identity it was typed under. This is
   * the rule `shouldPreserveInputOnDisconnect` applies to the worker's outbox,
   * and the two halves have to agree or one replays what the other discarded.
   */
  test('discardPendingInput destroys buffered input', async () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = { flushes: 0, flushInputSeqs: [] };
    const controller = createController(sent, state, (attempt) => attempt > 1);

    controller.sendNativeText('a');
    expect(sent.length).toBe(0);
    controller.discardPendingInput();

    await waitForDrain();
    expect(sent.length, 'a discarded keystroke is never delivered').toBe(0);
    controller.destroy();
  });

  /**
   * A paste rejected part-way must complete rather than truncate: every later
   * chunk lands behind the one that was refused.
   */
  test('a paste refused part-way still lands whole and in order', async () => {
    const sent: SentFrame[] = [];
    const state: FakeWorkerState = { flushes: 0, flushInputSeqs: [] };
    const controller = createController(sent, state, (attempt) => attempt !== 1);

    controller.sendPaste('hello world');

    await waitForDrain();
    expect(typedText(sent)).toBe('hello world');
    controller.destroy();
  });
});

// ── Physical keyboard (a window and document with listener sinks) ────────────

interface FakeKey {
  readonly key: string;
  readonly code: string;
  /** The focused element; null (the default) is a press with nothing focused. */
  readonly target?: object | null;
  readonly preventDefault?: () => void;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly repeat?: boolean;
  readonly locks?: readonly string[];
}

function installKeyboardWindow(): {
  press(event: FakeKey): void;
  release(event: FakeKey): void;
  blur(): void;
  restore(): void;
} {
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  for (const name of [
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLElement',
  ]) {
    saved.set(name, globals[name]);
    globals[name] ??= class {};
  }
  const sink = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const bucket = listeners.get(type) ?? [];
      bucket.push(handler);
      listeners.set(type, bucket);
    },
    removeEventListener: () => {},
  };
  saved.set('window', globals.window);
  saved.set('document', globals.document);
  globals.window = sink;
  globals.document = { ...sink, visibilityState: 'visible', hasFocus: () => true };
  const dispatch = (type: string, event: FakeKey): void => {
    for (const handler of listeners.get(type) ?? []) {
      handler({
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        keyCode: 0,
        location: 0,
        defaultPrevented: false,
        target: null,
        timeStamp: 0,
        preventDefault: () => {},
        stopPropagation: () => {},
        getModifierState: (name: string) => event.locks?.includes(name) === true,
        ...event,
      });
    }
  };
  return {
    press: (event) => dispatch('keydown', event),
    release: (event) => dispatch('keyup', event),
    blur(): void {
      for (const handler of listeners.get('blur') ?? []) handler({});
    },
    restore(): void {
      for (const [name, value] of saved) {
        if (value === undefined) delete globals[name];
        else globals[name] = value;
      }
    },
  };
}

describe('input controller physical keys', () => {
  test('a key aimed at a control outside the panel is left to that control', () => {
    const keyboard = installKeyboardWindow();
    try {
      const Element = (globalThis as Record<string, unknown>).HTMLElement as new () => object;
      const reloadButton = new Element();
      const editingSurface = new Element();
      const sent: SentFrame[] = [];
      const prevented: string[] = [];
      const controller = createController(
        sent,
        { flushes: 0 },
        undefined,
        undefined,
        fakePanel(editingSurface),
      );
      controller.attach();
      const keys = (): SentFrame[] => sent.filter((frame) => decoded(frame).kind !== 'focus');
      const press = (key: string, code: string, target: object): void =>
        keyboard.press({
          key,
          code,
          target,
          preventDefault: () => prevented.push(code),
        });

      press('Enter', 'Enter', reloadButton);
      press(' ', 'Space', reloadButton);
      press('Tab', 'Tab', reloadButton);
      expect(keys()).toHaveLength(0);
      expect(prevented).toEqual([]);

      press('Enter', 'Enter', editingSurface);
      expect(keys().map(decoded)).toMatchObject([{ kind: 'key', key: FUNCTIONAL_KEY.ENTER }]);
      expect(prevented).toEqual(['Enter']);
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });

  test('reuses immutable records for repeated physical keys', () => {
    const keyboard = installKeyboardWindow();
    try {
      const sent: SentFrame[] = [];
      const controller = createController(sent, { flushes: 0 });
      controller.attach();
      const keys = (): SentFrame[] => sent.filter((frame) => decoded(frame).kind !== 'focus');

      keyboard.press({ key: 'a', code: 'KeyA' });
      keyboard.press({ key: 'a', code: 'KeyA', repeat: true });
      keyboard.press({ key: 'c', code: 'KeyC', ctrlKey: true });
      keyboard.press({ key: 'c', code: 'KeyC', ctrlKey: true, repeat: true });
      keyboard.press({ key: 'a', code: 'KeyA', repeat: true });

      expect(keys()).toHaveLength(5);
      expect(keys()[1]?.source).toBe(keys()[4]?.source);
      expect(keys()[0]?.source).not.toBe(keys()[1]?.source);
      expect(decoded(keys()[2])).toMatchObject({ key: 0x63, mods: KEY_MOD_CTRL, text: null });
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });

  test('a release carries the identity its press reported', () => {
    const keyboard = installKeyboardWindow();
    try {
      const sent: SentFrame[] = [];
      const controller = createController(sent, { flushes: 0 });
      controller.attach();
      const keys = (): SentFrame[] => sent.filter((frame) => decoded(frame).kind !== 'focus');

      keyboard.press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
      keyboard.press({ key: '!', code: 'Digit1', shiftKey: true });
      keyboard.release({ key: 'Shift', code: 'ShiftLeft' });
      // Shift is already up, so the layout now calls this key `1`.
      keyboard.release({ key: '1', code: 'Digit1' });

      expect(keys().map(decoded)).toEqual([
        {
          kind: 'key',
          event: KEY_EVENT_PRESS,
          key: FUNCTIONAL_KEY.LEFT_SHIFT,
          mods: KEY_MOD_SHIFT,
          shifted: null,
          base: null,
          text: null,
        },
        {
          kind: 'key',
          event: KEY_EVENT_PRESS,
          key: 0x21,
          mods: KEY_MOD_SHIFT,
          shifted: null,
          base: 0x31,
          text: '!',
        },
        {
          kind: 'key',
          event: KEY_EVENT_RELEASE,
          key: FUNCTIONAL_KEY.LEFT_SHIFT,
          mods: 0,
          shifted: null,
          base: null,
          text: null,
        },
        {
          kind: 'key',
          event: KEY_EVENT_RELEASE,
          key: 0x21,
          mods: 0,
          shifted: null,
          base: 0x31,
          text: null,
        },
      ]);
      expect(keys().map((frame) => frame.shadowModelled)).toEqual([false, true, false, false]);
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });

  test('only keys whose press was sent are released, and blur releases the rest', () => {
    const keyboard = installKeyboardWindow();
    try {
      const sent: SentFrame[] = [];
      const controller = createController(sent, { flushes: 0 });
      controller.attach();
      const keys = (): SentFrame[] => sent.filter((frame) => decoded(frame).kind !== 'focus');

      // A dead key composes in the editing surface: no press, so no release.
      keyboard.press({ key: 'Dead', code: 'Quote' });
      keyboard.release({ key: "'", code: 'Quote' });
      keyboard.press({ key: 'x', code: 'KeyX' });
      keyboard.blur();
      keyboard.release({ key: 'x', code: 'KeyX' });

      expect(keys().map((frame) => decoded(frame))).toMatchObject([
        { kind: 'key', event: KEY_EVENT_PRESS, key: 0x78 },
        { kind: 'key', event: KEY_EVENT_RELEASE, key: 0x78, mods: 0 },
      ]);
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });

  test('a letter under Shift is the lowercase key with its shifted form', () => {
    const keyboard = installKeyboardWindow();
    try {
      const sent: SentFrame[] = [];
      const controller = createController(sent, { flushes: 0 });
      controller.attach();
      const keys = (): SentFrame[] => sent.filter((frame) => decoded(frame).kind !== 'focus');

      keyboard.press({ key: 'A', code: 'KeyA', shiftKey: true });
      keyboard.press({ key: 'A', code: 'KeyA', locks: ['CapsLock'] });
      keyboard.press({ key: 'Enter', code: 'Enter', shiftKey: true });

      expect(keys().map(decoded)).toEqual([
        {
          kind: 'key',
          event: KEY_EVENT_PRESS,
          key: A,
          mods: KEY_MOD_SHIFT,
          shifted: 0x41,
          base: null,
          text: 'A',
        },
        {
          kind: 'key',
          event: KEY_EVENT_PRESS,
          key: A,
          mods: KEY_MOD_CAPS_LOCK,
          shifted: null,
          base: null,
          text: 'A',
        },
        {
          kind: 'key',
          event: KEY_EVENT_PRESS,
          key: FUNCTIONAL_KEY.ENTER,
          mods: KEY_MOD_SHIFT,
          shifted: null,
          base: null,
          text: null,
        },
      ]);
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });
});

describe('input controller records nothing answers', () => {
  test('releases, bare modifiers and focus are neither modelled, flushed, nor awaited', () => {
    const keyboard = installKeyboardWindow();
    try {
      const sent: SentFrame[] = [];
      const state: FakeWorkerState = { flushes: 0, flushInputSeqs: [] };
      const controller = createController(sent, state);
      controller.attach();

      keyboard.press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
      keyboard.press({ key: 'A', code: 'KeyA', shiftKey: true });
      keyboard.release({ key: 'A', code: 'KeyA', shiftKey: true });
      keyboard.release({ key: 'Shift', code: 'ShiftLeft' });

      expect(
        sent.map((frame) => {
          const record = decoded(frame);
          return record.kind === 'key' ? `${record.event}:${record.key}` : record.kind;
        }),
      ).toEqual([
        'focus',
        `${KEY_EVENT_PRESS}:${FUNCTIONAL_KEY.LEFT_SHIFT}`,
        `${KEY_EVENT_PRESS}:${A}`,
        `${KEY_EVENT_RELEASE}:${A}`,
        `${KEY_EVENT_RELEASE}:${FUNCTIONAL_KEY.LEFT_SHIFT}`,
      ]);
      // Only the letter is awaited on screen, and only it is modelled. Nothing
      // reports the rest, so it waits in the ring for the letter to carry it.
      expect(sent.map((frame) => frame.delivery)).toEqual([
        INPUT_DEFERRED,
        INPUT_DEFERRED,
        INPUT_AWAITED,
        INPUT_DEFERRED,
        INPUT_DEFERRED,
      ]);
      expect(sent.map((frame) => frame.shadowModelled)).toEqual([false, false, true, false, false]);
      // The Shift press typed nothing, so it flushed no prediction.
      expect(state.flushInputSeqs).toEqual([]);
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });

  test('each record is sent at once exactly when the mode word says it encodes', () => {
    const cases: ReadonlyArray<readonly [number, InputDelivery[]]> = [
      // Releases only: the letter's release, not the modifier or its release.
      [
        TERMINAL_MODE_KEY_RELEASES,
        [INPUT_DEFERRED, INPUT_DEFERRED, INPUT_AWAITED, INPUT_UNAWAITED, INPUT_DEFERRED],
      ],
      // Every key as an escape, no event types: the modifier press only.
      [
        TERMINAL_MODE_MODIFIER_KEYS,
        [INPUT_DEFERRED, INPUT_UNAWAITED, INPUT_AWAITED, INPUT_DEFERRED, INPUT_DEFERRED],
      ],
      [
        TERMINAL_MODE_KEY_RELEASES | TERMINAL_MODE_MODIFIER_KEYS | TERMINAL_MODE_FOCUS,
        [INPUT_UNAWAITED, INPUT_UNAWAITED, INPUT_AWAITED, INPUT_UNAWAITED, INPUT_UNAWAITED],
      ],
    ];
    for (const [mode, expected] of cases) {
      const keyboard = installKeyboardWindow();
      try {
        const sent: SentFrame[] = [];
        const controller = createController(sent, { flushes: 0, mode });
        controller.attach();
        keyboard.press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
        keyboard.press({ key: 'A', code: 'KeyA', shiftKey: true });
        keyboard.release({ key: 'A', code: 'KeyA', shiftKey: true });
        keyboard.release({ key: 'Shift', code: 'ShiftLeft' });
        expect(sent.map((frame) => frame.delivery)).toEqual(expected);
        controller.destroy();
      } finally {
        keyboard.restore();
      }
    }
  });
});

describe('input controller focus reports', () => {
  test("a session hears this window's focus first, then every change", () => {
    const keyboard = installKeyboardWindow();
    try {
      const sent: SentFrame[] = [];
      const controller = createController(sent, { flushes: 0 });
      controller.attach();

      keyboard.press({ key: 'x', code: 'KeyX' });
      keyboard.blur();

      expect(sent.map((frame) => decoded(frame))).toMatchObject([
        { kind: 'focus', focused: true },
        { kind: 'key', event: KEY_EVENT_PRESS, key: 0x78 },
        { kind: 'key', event: KEY_EVENT_RELEASE, key: 0x78 },
        { kind: 'focus', focused: false },
      ]);
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });
});

type PaintTrace = Array<'classify' | 'predict'>;

/**
 * A session that records when it invokes the classifier and keeps the
 * classifier itself, so a test can assert both the order of the send tail and
 * that the controller hands the same function to every physical keystroke.
 */
function createTracingSession(
  trace: PaintTrace,
  classifiers: Array<(inputSeq: number) => boolean>,
  accept: () => boolean,
): TerminalSession {
  const base = createFakeSession([]);
  let nextSeq = 1;
  return {
    ...base,
    sendKeystroke(
      _input: Uint8Array,
      _inputAtMs?: number,
      classifyShadowModelled?: (inputSeq: number) => boolean,
    ): number | null {
      if (!accept()) return null;
      const seq = nextSeq;
      nextSeq += 1;
      if (classifyShadowModelled !== undefined) {
        trace.push('classify');
        classifiers.push(classifyShadowModelled);
        classifyShadowModelled(seq);
      }
      return seq;
    },
  };
}

function createTracingController(
  trace: PaintTrace,
  classifiers: Array<(inputSeq: number) => boolean>,
  accept: () => boolean,
): ReturnType<typeof createTerminalInputController> {
  const session = createTracingSession(trace, classifiers, accept);
  const workerClient: TerminalWorkerClient = {
    ...createFakeWorkerClient({ flushes: 0 }),
    predictPrintable: () => {
      trace.push('predict');
      return true;
    },
  };
  return createTerminalInputController({
    touchKeyboardEligible: false,
    ownerEl: fakePanel(),
    getSession: () => session,
    getWorkerClient: () => workerClient,
    getTouchSurfaceEl: () => null,
    getVirtualModifiers: () => ({ shift: false, ctrl: false, alt: false, meta: false }),
    clearVirtualModifiers: () => {},
    focusTerminal: () => {},
    onToggleFocusMode: () => {},
  });
}

describe('input controller worker-only prediction ordering', () => {
  test('a physical key classifies and queues prediction without a main-thread paint', () => {
    const keyboard = installKeyboardWindow();
    try {
      const trace: PaintTrace = [];
      const controller = createTracingController(trace, [], () => true);
      controller.attach();

      keyboard.press({ key: 'a', code: 'KeyA' });

      expect(trace).toEqual(['classify', 'predict']);
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });

  test('a virtual key classifies and queues prediction without a main-thread paint', () => {
    const trace: PaintTrace = [];
    const controller = createTracingController(trace, [], () => true);

    controller.sendVirtualKey({ id: 'key-a', label: 'a', inputKey: 'a' });

    expect(trace).toEqual(['classify', 'predict']);
    controller.destroy();
  });

  test('a refused keystroke never classifies or queues prediction', () => {
    const keyboard = installKeyboardWindow();
    try {
      const trace: PaintTrace = [];
      const controller = createTracingController(trace, [], () => false);
      controller.attach();

      keyboard.press({ key: 'a', code: 'KeyA' });

      expect(trace).toEqual([]);
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });

  test('every physical keystroke is classified by the same function', () => {
    const keyboard = installKeyboardWindow();
    try {
      const classifiers: Array<(inputSeq: number) => boolean> = [];
      const controller = createTracingController([], classifiers, () => true);
      controller.attach();

      keyboard.press({ key: 'a', code: 'KeyA' });
      keyboard.press({ key: 'b', code: 'KeyB' });

      expect(classifiers).toHaveLength(2);
      expect(classifiers[0]).toBe(classifiers[1] ?? (() => false));
      controller.destroy();
    } finally {
      keyboard.restore();
    }
  });
});

describe('input controller macros', () => {
  test('each step sends an ordered press/release with its own modifiers, independent of latches', async () => {
    const sent: SentFrame[] = [];
    const controller = createController(sent, { flushes: 0 }, (attempt) => attempt !== 1, {
      ctrl: true,
      shift: true,
      alt: true,
      meta: true,
    });
    controller.sendVirtualKey({
      id: 'macro:test',
      label: 'Sequence',
      macro: [
        { key: 'key-a', ctrl: true, alt: false, shift: false, meta: false },
        { key: 'key-b', ctrl: false, alt: true, shift: false, meta: false },
        { key: 'tab', ctrl: false, alt: false, shift: false, meta: false },
      ],
    });
    controller.sendVirtualKey({ id: 'key-z', label: 'z', inputKey: 'z' });
    await waitForDrain();
    const records = sent.map(decoded);
    expect(records).toHaveLength(8);
    const chordPresses = records.filter(
      (record) => record.kind === 'key' && record.event === KEY_EVENT_PRESS,
    );
    expect(chordPresses.slice(0, 3)).toMatchObject([
      { key: 97, mods: KEY_MOD_CTRL, text: null },
      { key: 98, mods: KEY_MOD_ALT, text: null },
      { key: FUNCTIONAL_KEY.TAB, mods: 0, text: null },
    ]);
    expect(
      records.slice(0, 6).map((record) => (record.kind === 'key' ? record.event : null)),
    ).toEqual([
      KEY_EVENT_PRESS,
      KEY_EVENT_RELEASE,
      KEY_EVENT_PRESS,
      KEY_EVENT_RELEASE,
      KEY_EVENT_PRESS,
      KEY_EVENT_RELEASE,
    ]);
    controller.destroy();
  });
});
