/**
 * Names for term-wasm's `CursorCause` codes, for the telemetry worker.
 *
 * The worker that journals a step resolves the name through WASM itself
 * (`cursorCauseName` in `wasm-loader.ts`); the telemetry worker that builds the
 * row has no WASM, so it carries this mirror. `cursor-cause-names.test.ts` pins
 * it to the enum in `packages/term-wasm/src/lib.rs` in both directions, so a
 * variant added or renumbered there fails the suite rather than shipping rows
 * under the wrong name. An unknown code reads back as `cause(<code>)`, exactly
 * as the WASM function answers.
 */
const CURSOR_CAUSE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'Unknown'],
  [1, 'AuthorityHeader'],
  [2, 'AuthorityShape'],
  [3, 'AuthorityResize'],
  [10, 'FlushExternal'],
  [11, 'FlushSnapshot'],
  [12, 'FlushResize'],
  [13, 'FlushPreedit'],
  [14, 'FlushUnpredictableKey'],
  [15, 'FlushModeUnsafe'],
  [16, 'FlushBaseMismatch'],
  [17, 'FlushLineFull'],
  [18, 'FlushOpFailed'],
  [19, 'FlushEditorAnchor'],
  [20, 'FlushModeRevoked'],
  [21, 'FlushReconcileMismatch'],
  [22, 'FlushExpiredCovered'],
  [23, 'FlushExpiredStalled'],
  [24, 'FlushNoSeedableLine'],
  [25, 'FlushRowTailNotPredictable'],
  [26, 'FlushAnchorNotPresented'],
  [27, 'FlushReceivedIncompatible'],
  [28, 'FlushSeedBaseNotReceived'],
  [29, 'SealExternal'],
  [30, 'PredictOp'],
  [31, 'ReconcileRebase'],
  [32, 'LineSealed'],
  [33, 'FlushSealResolved'],
  [40, 'AdmissionWithheld'],
  [41, 'EpochTentative'],
]);

export function cursorCauseLabel(code: number): string {
  return CURSOR_CAUSE_NAMES.get(code) ?? `cause(${code})`;
}
