/**
 * The browser failure report's vocabulary, as a contract rather than a copy.
 *
 * Two implementations meet on this body — `apps/web/src/perf/error-reporter.ts`
 * classifies and coalesces, `ApiModels.BrowserErrorReportBody` validates — and
 * nothing at runtime detects drift between them: a report carrying a value the
 * server's union does not list is refused with a 422 and dropped, which is
 * exactly the silence this signal exists to break. The literals therefore live
 * here, once, and the server suite pins its own union against them.
 *
 * Every field is a closed union or a bounded count. There is no message, no
 * stack, and no free-text field of any kind, so terminal content cannot be
 * carried here even by a modified client — see `docs/observability.md`.
 */

export const BROWSER_ERROR_SOURCES = [
  'window',
  'unhandled_rejection',
  /** Terminal session creation failed — WASM, worker start, transport, or issuance. */
  'session_start',
  'transport_worker',
  'telemetry_worker',
  /**
   * A device-events stream that was owed a frame and produced none.
   *
   * The only source here that is not a thrown value: nothing throws when a
   * request is simply never answered, which is exactly why the failure it
   * describes was invisible everywhere else.
   */
  'device_events',
] as const;

export type BrowserErrorSource = (typeof BROWSER_ERROR_SOURCES)[number];

/**
 * Failure classes.
 *
 * Deliberately coarse. The value of this signal is "which of a handful of things
 * is going wrong in the field", not a stack trace — and every additional class
 * is another metric label, so the set stays small enough to read at a glance.
 */
export const BROWSER_ERROR_KINDS = [
  /**
   * A request that was neither answered nor refused. `classifyBrowserError`
   * never returns this one: no value is thrown, so there is nothing to
   * classify — it is recorded directly by the code that was left waiting.
   */
  'no_response',
  /** A stream that opened and never sent the frame its protocol owes it. */
  'no_frame',
  'wasm_instantiate',
  'webgl_context',
  'worker_start',
  'security',
  'network',
  'quota',
  'abort',
  'type_error',
  'range_error',
  'reference_error',
  'other',
] as const;

export type BrowserErrorKind = (typeof BROWSER_ERROR_KINDS)[number];

export interface BrowserErrorReportBody {
  readonly source: BrowserErrorSource;
  readonly kind: BrowserErrorKind;
  readonly count: number;
}
