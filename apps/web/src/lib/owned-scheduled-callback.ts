/**
 * Owns one cancellable scheduled callback.
 *
 * Browsers are allowed to have already queued a timer/rAF task when
 * clearTimeout/cancelAnimationFrame runs. A bare callback that clears a shared
 * handle can therefore steal a newer replacement's slot. Each arm below gets a
 * private owner token; only the callback that still owns the slot may consume
 * it.
 *
 * The publication handshake also supports synchronous test schedulers: an
 * inline callback is deferred until its returned handle has been published.
 */
export interface OwnedScheduledCallback<
  CallbackArgs extends unknown[],
  ScheduleArgs extends unknown[],
> {
  arm(callback: (...args: CallbackArgs) => void, ...scheduleArgs: ScheduleArgs): void;
  cancel(): void;
  isArmed(): boolean;
}

export function createOwnedScheduledCallback<
  Handle,
  CallbackArgs extends unknown[],
  ScheduleArgs extends unknown[],
>(
  schedule: (callback: (...args: CallbackArgs) => void, ...scheduleArgs: ScheduleArgs) => Handle,
  cancelScheduled: (handle: Handle) => void,
): OwnedScheduledCallback<CallbackArgs, ScheduleArgs> {
  interface Owner {
    active: boolean;
    published: boolean;
    handle: Handle | undefined;
    inlineArgs: CallbackArgs | null;
  }

  let current: Owner | null = null;

  function cancel(): void {
    const owner = current;
    if (owner === null) return;
    current = null;
    owner.active = false;
    if (owner.published && owner.handle !== undefined) {
      cancelScheduled(owner.handle);
    }
  }

  return {
    arm(callback, ...scheduleArgs): void {
      cancel();
      const owner: Owner = {
        active: true,
        published: false,
        handle: undefined,
        inlineArgs: null,
      };
      current = owner;

      const invoke = (...args: CallbackArgs): void => {
        if (!owner.published) {
          owner.inlineArgs = args;
          return;
        }
        if (!owner.active || current !== owner) return;
        owner.active = false;
        current = null;
        callback(...args);
      };

      try {
        owner.handle = schedule(invoke, ...scheduleArgs);
        owner.published = true;
      } catch (error) {
        owner.active = false;
        if (current === owner) current = null;
        throw error;
      }

      const inlineArgs = owner.inlineArgs;
      owner.inlineArgs = null;
      if (inlineArgs !== null) invoke(...inlineArgs);
    },

    cancel,

    isArmed(): boolean {
      return current !== null;
    },
  };
}

export type OwnedTimeout = OwnedScheduledCallback<[], [delayMs: number]>;

/**
 * The fixed-arity forms run on every render frame, pump continuation, and
 * keystroke emit, so they carry the same ownership contract without the
 * generic form's per-arm owner record and rest/spread argument arrays. The
 * owner token is the scheduled function itself: only the function currently
 * held in `current` may consume the slot, a cancelled one the platform still
 * delivers finds a different `current`, and slot state below belongs to that
 * one current arm. One function object per arm is the whole allocation.
 */
export function createOwnedTimeout<Handle>(
  setTimer: (callback: () => void, delayMs: number) => Handle,
  clearTimer: (handle: Handle) => void,
): OwnedTimeout {
  let current: (() => void) | null = null;
  let currentCallback: (() => void) | null = null;
  let handle: Handle | undefined;
  let published = false;
  let inlinePending = false;

  function cancel(): void {
    if (current === null) return;
    current = null;
    currentCallback = null;
    if (published && handle !== undefined) clearTimer(handle);
  }

  return {
    arm(callback, delayMs): void {
      cancel();
      published = false;
      inlinePending = false;
      currentCallback = callback;
      // A named function expression refers to itself without a per-arm
      // environment; an arrow capturing `invoke` would allocate one.
      const invoke = function ownedTimeoutInvoke(): void {
        if (current !== ownedTimeoutInvoke) return;
        if (!published) {
          inlinePending = true;
          return;
        }
        const run = currentCallback;
        current = null;
        currentCallback = null;
        run?.();
      };
      current = invoke;
      let scheduled: Handle;
      try {
        scheduled = setTimer(invoke, delayMs);
      } catch (error) {
        if (current === invoke) {
          current = null;
          currentCallback = null;
        }
        throw error;
      }
      // Slot state belongs to the current arm only. A scheduler that cancelled
      // or re-armed this slot re-entrantly owns it now; this arm's timer, if it
      // ever fires, finds a different `current`.
      if (current !== invoke) return;
      handle = scheduled;
      published = true;
      if (inlinePending) {
        inlinePending = false;
        invoke();
      }
    },

    cancel,

    isArmed(): boolean {
      return current !== null;
    },
  };
}

export type OwnedAnimationFrame = OwnedScheduledCallback<[frameTimeMs: number], []>;

export function createOwnedAnimationFrame(
  requestFrame: (callback: (frameTimeMs: number) => void) => number,
  cancelFrame: (handle: number) => void,
): OwnedAnimationFrame {
  let current: ((frameTimeMs: number) => void) | null = null;
  let currentCallback: ((frameTimeMs: number) => void) | null = null;
  let handle = 0;
  let published = false;
  let inlinePending = false;
  let inlineFrameTimeMs = 0;

  function cancel(): void {
    if (current === null) return;
    current = null;
    currentCallback = null;
    if (published) cancelFrame(handle);
  }

  return {
    arm(callback): void {
      cancel();
      published = false;
      inlinePending = false;
      currentCallback = callback;
      const invoke = function ownedFrameInvoke(frameTimeMs: number): void {
        if (current !== ownedFrameInvoke) return;
        if (!published) {
          inlinePending = true;
          inlineFrameTimeMs = frameTimeMs;
          return;
        }
        const run = currentCallback;
        current = null;
        currentCallback = null;
        run?.(frameTimeMs);
      };
      current = invoke;
      let scheduled: number;
      try {
        scheduled = requestFrame(invoke);
      } catch (error) {
        if (current === invoke) {
          current = null;
          currentCallback = null;
        }
        throw error;
      }
      if (current !== invoke) return;
      handle = scheduled;
      published = true;
      if (inlinePending) {
        inlinePending = false;
        invoke(inlineFrameTimeMs);
      }
    },

    cancel,

    isArmed(): boolean {
      return current !== null;
    },
  };
}

/**
 * Hand the event loop a macrotask turn.
 *
 * A timer task rather than a microtask on purpose: the point is to let *other
 * task sources* — the input-ring wake, heartbeats, lifecycle messages — be
 * selected, and a microtask yields to none of them because it runs before the
 * current task ends.
 *
 * The timer is armed from a `MessagePort` handler rather than from the caller.
 * Chromium clamps a `setTimeout(0)` to ≥4 ms once the *running task* is five
 * timers deep, and a drain loop that yields from its own timer continuation is
 * exactly that task; a message task starts at nesting level zero, so the timer
 * it arms is never clamped. This is the alternating-source shape the fence
 * poll and the ring continuations already use — the handler arms one timer
 * and stops, it never reposts to itself, so the port's task source is never
 * continuously backlogged and cannot monopolize worker task selection. FIFO
 * by construction: port messages are ordered, each arms one timer, and equal
 * timers fire in the order they were armed.
 *
 * Lives here, beside the other scheduling primitives, because two hot loops in
 * two realms need the identical thing and a second private copy would be a
 * second definition of the same fairness boundary.
 */
export function yieldToFairTask(): Promise<void> {
  return new Promise((resolve) => {
    fairYieldWaiters.push(resolve);
    fairYieldPort().postMessage(0);
  });
}

// One channel per realm, created on first use; the sending end is the only
// thing the caller touches and the number posted on it is not read.
const fairYieldWaiters: Array<() => void> = [];
let fairYieldSender: MessagePort | null = null;

function fairYieldPort(): MessagePort {
  if (fairYieldSender === null) {
    const channel = new MessageChannel();
    channel.port2.onmessage = armFairYieldTimer;
    fairYieldSender = channel.port1;
  }
  return fairYieldSender;
}

function armFairYieldTimer(): void {
  setTimeout(resolveOldestFairYield, 0);
}

function resolveOldestFairYield(): void {
  const resolve = fairYieldWaiters.shift();
  if (resolve !== undefined) resolve();
}
