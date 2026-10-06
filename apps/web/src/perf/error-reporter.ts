/**
 * Browser failure reporting.
 *
 * # The hole this closes
 *
 * Every other browser surface measures a *working* session: link quality, upgrade outcomes,
 * profiling rows, bootstrap spans. All of them require the thing they measure to be
 * functioning. A session that dies because WASM would not instantiate, because WebGL lost
 * its context, or because an unhandled rejection tore down the controller produced **zero
 * signal anywhere** — no metric, no log, no span. The failure modes that hurt users most
 * were silent by construction.
 *
 * # Why it carries no free text
 *
 * An error message is attacker- and content-influenced: `throw new Error(received)` puts
 * terminal bytes in a string, and a stack trace is a code path that says nothing about which
 * *kind* of failure occurred anyway. The whole browser telemetry posture is that no
 * free-text field exists, so terminal content cannot be carried even by a modified client.
 * That posture is not weakened here.
 *
 * So a report is two closed unions — where it came from and what class of failure it was —
 * plus a count. That is enough to answer "are browsers failing, how, and how often", which
 * is the question that had no answer at all. The message and stack stay in the DevTools
 * console, where the person debugging can see them and nobody else can.
 *
 * # Why it coalesces
 *
 * A render loop that throws every frame would otherwise post every frame. Reports are
 * accumulated per `source:kind` and flushed on a slow timer, so a storm becomes one report
 * with a count rather than a denial-of-service against the endpoint it is reporting to.
 */

// The vocabulary itself is a wire contract, so it lives in `@merkur/shared`
// beside the other API contracts and the server's suite pins its own union
// against it. A report carrying a value that union does not list is refused and
// dropped, which is exactly the silence this reporter exists to break.
import {
  BROWSER_ERROR_KINDS,
  BROWSER_ERROR_SOURCES,
  type BrowserErrorKind,
  type BrowserErrorReportBody,
  type BrowserErrorSource,
} from '@merkur/shared';

export type BrowserErrorSender = (report: BrowserErrorReportBody) => void;

/** How long failures accumulate before a flush. */
const FLUSH_INTERVAL_MS = 10_000;

/**
 * Distinct `source:kind` pairs held at once: every well-formed pair fits, so the bound
 * guards memory against a bug in classification rather than against traffic.
 */
const MAX_PENDING_KEYS = BROWSER_ERROR_SOURCES.length * BROWSER_ERROR_KINDS.length;

/** One report cannot claim more failures than this, however many actually occurred. */
const MAX_COUNT = 10_000;

/**
 * Classify a thrown value without reading its message.
 *
 * Matching is on the error's *name* and on `instanceof` where the platform gives a distinct
 * type. A message is never inspected: it is exactly the field that can carry content, and
 * matching on it would make the classification a function of untrusted text.
 */
export function classifyBrowserError(error: unknown): BrowserErrorKind {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'SecurityError':
      case 'NotAllowedError':
        return 'security';
      case 'QuotaExceededError':
        return 'quota';
      case 'AbortError':
        return 'abort';
      case 'NetworkError':
        return 'network';
      default:
        return 'other';
    }
  }

  if (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError) {
    return 'wasm_instantiate';
  }
  if (error instanceof WebAssembly.RuntimeError) {
    return 'wasm_instantiate';
  }
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof RangeError) return 'range_error';
  if (error instanceof ReferenceError) return 'reference_error';

  if (error instanceof Error) {
    switch (error.name) {
      case 'AbortError':
        return 'abort';
      case 'SecurityError':
        return 'security';
      default:
        return 'other';
    }
  }

  return 'other';
}

function keyOf(source: BrowserErrorSource, kind: BrowserErrorKind): string {
  return `${source}:${kind}`;
}

export interface BrowserErrorReporter {
  /** Classify and accumulate one failure. */
  readonly record: (source: BrowserErrorSource, error: unknown) => void;
  /**
   * Accumulate one already-classified failure.
   *
   * For failures that are not thrown values: a request nobody answered has no
   * error object to classify, and inventing one to feed `record` would put the
   * classification in the wrong place.
   */
  readonly count: (source: BrowserErrorSource, kind: BrowserErrorKind) => void;
  /** Post everything accumulated so far. */
  readonly flush: () => void;
  /** Stop timers and listeners, discarding anything unflushed. */
  readonly stop: () => void;
}

/** The platform's timer handle, which differs between DOM and Node typings. */
type TimerHandle = ReturnType<typeof setInterval>;

export interface BrowserErrorReporterOptions {
  readonly send: BrowserErrorSender;
  /** Injected so tests need no timers. */
  readonly setInterval?: (handler: () => void, ms: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
}

/**
 * Accumulates classified failures and flushes them on a timer.
 *
 * Does not install any global listener itself — `installGlobalErrorHandlers` does that — so
 * the accumulation logic is testable without touching `globalThis`.
 */
export function createBrowserErrorReporter(
  options: BrowserErrorReporterOptions,
): BrowserErrorReporter {
  const pending = new Map<
    string,
    { source: BrowserErrorSource; kind: BrowserErrorKind; count: number }
  >();
  const schedule = options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const cancel = options.clearInterval ?? ((handle: TimerHandle) => clearInterval(handle));

  const flush = (): void => {
    if (pending.size === 0) return;
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      options.send({
        source: entry.source,
        kind: entry.kind,
        count: Math.min(entry.count, MAX_COUNT),
      });
    }
  };

  const handle = schedule(flush, FLUSH_INTERVAL_MS);

  const count = (source: BrowserErrorSource, kind: BrowserErrorKind): void => {
    const key = keyOf(source, kind);
    const existing = pending.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    if (pending.size >= MAX_PENDING_KEYS) return;
    pending.set(key, { source, kind, count: 1 });
  };

  return {
    record(source, error) {
      count(source, classifyBrowserError(error));
    },
    count,
    flush,
    stop() {
      cancel(handle);
      pending.clear();
    },
  };
}

/**
 * Install `error` and `unhandledrejection` listeners that feed a reporter.
 *
 * Returns a teardown. Both listeners are passive: they never call `preventDefault`, so the
 * console still receives everything it did before and local debugging is unchanged.
 */
export function installGlobalErrorHandlers(reporter: BrowserErrorReporter): () => void {
  const onError = (event: ErrorEvent): void => {
    reporter.record('window', event.error ?? new Error(event.message));
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    reporter.record('unhandled_rejection', event.reason);
  };

  /**
   * Flush when the page is hidden.
   *
   * Without this the coalescing window is a hole exactly where it matters most: a user who
   * hits a fatal error and closes the tab does so well inside the flush interval, so the
   * one report worth having would be the one always lost. `visibilitychange` is the last
   * event a page reliably gets, which is why the link reporter already uses it.
   */
  const onHidden = (): void => {
    if (host?.visibilityState === 'hidden') reporter.flush();
  };

  // Read off `globalThis` rather than the bare global: this module is imported by code that
  // also runs where there is no DOM, and a reporter must never be the thing that throws.
  const host = (globalThis as { document?: Document }).document;

  globalThis.addEventListener('error', onError);
  globalThis.addEventListener('unhandledrejection', onRejection);
  host?.addEventListener('visibilitychange', onHidden);

  return () => {
    globalThis.removeEventListener('error', onError);
    globalThis.removeEventListener('unhandledrejection', onRejection);
    host?.removeEventListener('visibilitychange', onHidden);
  };
}
