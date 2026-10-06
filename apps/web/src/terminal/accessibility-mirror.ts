// Screen-reader mirror for the WebGL terminal. The grid canvas is opaque to
// assistive technology, so new terminal output is mirrored into a visually
// hidden `role="log"` live region. Output is fetched from the worker as plain
// text (the same get_viewport_rows path the selection layer reads) once the
// display has settled, diffed per row, and announced politely.
//
// The settle is decided in the terminal worker (`display-output-settle.ts`),
// which posts one `display_output_changed` on the first presented transaction of a burst and
// one `display_output_settled` once the output has been still. This mirror
// owns no timer: it takes its silent baseline on the first change and refreshes
// on each settle.
//
// The baseline is keyed by row index, so a resize re-indexes it: the daemon
// re-wraps the grid and re-snapshots, and every row lands somewhere else. The
// next read after a resize is therefore compared by membership instead — a line
// that was already on screen is not new output, wherever it now sits — which
// announces what actually arrived without re-reading the screen the user has
// already heard. Alt-screen suppression invalidates the baseline outright,
// because a restored screen is not new output at all.

const MAX_LOG_ENTRIES = 32;
const MAX_ANNOUNCEMENT_CHARS = 2048;

const HIDDEN_STYLE =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;' +
  'clip-path:inset(50%);overflow:hidden;white-space:nowrap';

export interface AccessibilityMirrorOptions {
  /**
   * Fetch the current viewport text (rows joined by \n). Returns false (and
   * never invokes the callback) if the display cannot answer yet.
   */
  getViewportText(cb: (text: string) => void): boolean;
  /** Cursor row index, or null if unknown — its churn is never announced. */
  getCursorRow(): number | null;
  /** Suppress announcements (full-screen apps repaint far too often). */
  isSuppressed(): boolean;
}

export interface AccessibilityMirror {
  readonly element: HTMLElement;
  /**
   * Output started changing (the first presented transaction of a burst). Establishes the
   * silent baseline the first time; otherwise nothing is read until the settle.
   */
  noteOutputChanged(): void;
  /** Output has been still for the settle window: fetch, diff, announce. */
  noteOutputSettled(): void;
  /**
   * The terminal grid changed shape. The baseline is keyed by row index and a
   * resize re-indexes every row, so the next read is compared by membership
   * rather than position: only lines the baseline did not hold are announced.
   */
  noteResized(): void;
  destroy(): void;
}

export function createAccessibilityMirror(
  options: AccessibilityMirrorOptions,
): AccessibilityMirror {
  const element = document.createElement('div');
  element.setAttribute('role', 'log');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('aria-label', 'Terminal output');
  element.style.cssText = HIDDEN_STYLE;

  let previousRows: string[] | null = null;
  let requestInFlight = false;
  let refreshQueued = false;
  // How the next read must be compared against the baseline, when the baseline
  // no longer describes the screen the user last heard:
  //
  // - 'silent': output changed while suppressed (alt screen). A restored screen
  //   is not new output, so the read resyncs and announces nothing.
  // - 'reindexed': the grid resized. The lines are the same lines at different
  //   indices, so position tells us nothing and membership tells us everything.
  let pendingResync: 'none' | 'silent' | 'reindexed' = 'none';
  // Bumped by every invalidation. A read carries the generation it was issued
  // at, because a read in flight when the baseline was invalidated describes a
  // screen that no longer exists: it is neither a baseline nor a diff source,
  // and applying it would spend the resync against the wrong text and announce
  // the whole next screen.
  let generation = 0;
  let destroyed = false;

  function invalidateBaseline(mode: 'silent' | 'reindexed'): void {
    // A pending silent resync outranks a resize: the alt screen owes the user
    // no announcement at all, and a resize under it does not create one.
    if (!(mode === 'reindexed' && pendingResync === 'silent')) pendingResync = mode;
    generation += 1;
  }

  function noteOutputChanged(): void {
    if (destroyed) return;
    if (options.isSuppressed()) {
      invalidateBaseline('silent');
      return;
    }
    // Establish the silent baseline on the first output of the session. Waiting
    // for the settle would let sustained output postpone this fetch until it
    // also contains the first output that should be announced.
    if (previousRows === null) refresh();
  }

  function noteOutputSettled(): void {
    if (destroyed) return;
    if (options.isSuppressed()) {
      invalidateBaseline('silent');
      return;
    }
    refresh();
  }

  function noteResized(): void {
    if (destroyed) return;
    invalidateBaseline('reindexed');
  }

  function refresh(): void {
    if (destroyed) return;
    if (options.isSuppressed()) {
      invalidateBaseline('silent');
      return;
    }
    if (requestInFlight) {
      // A settle landed while a read was in flight: the screen may have moved
      // past what that read will return, so read once more after it lands.
      refreshQueued = true;
      return;
    }
    requestInFlight = true;
    const issuedAt = generation;
    const issued = options.getViewportText((text) => {
      requestInFlight = false;
      if (destroyed) return;
      if (issuedAt === generation) applyViewport(text);
      if (refreshQueued) {
        refreshQueued = false;
        refresh();
      }
    });
    if (!issued) requestInFlight = false;
  }

  function applyViewport(text: string): void {
    const rows = text.split('\n');
    const cursorRow = options.getCursorRow();
    const baseline = previousRows;
    previousRows = rows;

    const resync = pendingResync;
    pendingResync = 'none';

    // First fetch establishes the baseline silently: announcing a whole
    // restored screen on connect drowns the user in stale scrollback. A fresh
    // baseline owes nothing to a pending resync, and leaving one armed would
    // spend it on the next read and swallow the first output that follows.
    // The element says when it has one: output before that point is baseline,
    // output after it is announced, and an observer can wait for the edge.
    if (baseline === null) {
      element.setAttribute('data-baseline', '');
      return;
    }
    if (resync === 'silent') return;

    // After a resize the rows are the same rows at different indices, so a
    // positional diff reports the whole screen. Membership is the comparison
    // that survives a re-index: a line already on screen is not new output.
    const seen = resync === 'reindexed' ? new Set(baseline) : null;
    const changed: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      // The cursor row is where the user types; announcing every echoed
      // keystroke after each settle is noise, not output.
      if (i === cursorRow) continue;
      const line = rows[i] ?? '';
      if (line.length === 0) continue;
      if (seen === null ? (baseline[i] ?? '') !== line : !seen.has(line)) changed.push(line);
    }
    if (changed.length === 0) return;

    let announcement = changed.join('\n');
    if (announcement.length > MAX_ANNOUNCEMENT_CHARS) {
      announcement = announcement.slice(-MAX_ANNOUNCEMENT_CHARS);
      // Don't start on the tail half of a surrogate pair.
      const first = announcement.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) announcement = announcement.slice(1);
    }

    const entry = document.createElement('div');
    entry.textContent = announcement;
    element.appendChild(entry);
    while (element.childElementCount > MAX_LOG_ENTRIES) {
      element.firstElementChild?.remove();
    }
  }

  function destroy(): void {
    destroyed = true;
    element.remove();
  }

  return { element, noteOutputChanged, noteOutputSettled, noteResized, destroy };
}
