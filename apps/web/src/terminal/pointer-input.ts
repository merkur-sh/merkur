/** A grid cell address produced by hit-testing a pointer against the terminal. */
export interface CellPos {
  col: number;
  row: number;
}

export interface TerminalPointerGeometry {
  containerLeft: number;
  containerTop: number;
  charWidth: number;
  charHeight: number;
  cols: number;
  rows: number;
}

export function terminalCellAtPoint(
  clientX: number,
  clientY: number,
  geometry: TerminalPointerGeometry,
): CellPos {
  return terminalCellAtPointInto(clientX, clientY, geometry, { col: 0, row: 0 });
}

/**
 * `terminalCellAtPoint` into a caller-owned cell, for the pointer-motion path,
 * which runs at the display's event rate and must not allocate per event.
 */
export function terminalCellAtPointInto(
  clientX: number,
  clientY: number,
  geometry: TerminalPointerGeometry,
  out: CellPos,
): CellPos {
  if (geometry.charWidth === 0 || geometry.charHeight === 0) {
    out.col = 0;
    out.row = 0;
    return out;
  }
  const col = Math.floor((clientX - geometry.containerLeft) / geometry.charWidth);
  const row = Math.floor((clientY - geometry.containerTop) / geometry.charHeight);
  out.col = Math.max(0, Math.min(geometry.cols - 1, col));
  out.row = Math.max(0, Math.min(geometry.rows - 1, row));
  return out;
}

/**
 * The character boundary nearest a point: a row, and a column in `[0, cols]`.
 *
 * `terminalCellAtPoint` floors to the cell the pointer is *inside*, which is
 * what a mouse report needs. A caret belongs to the nearer edge of that cell
 * instead — that is what puts the start of a selection drag on the side of the
 * glyph the pointer is on — and it may sit one past the last cell, at the end
 * of the row.
 */
export function terminalCaretAtPoint(
  clientX: number,
  clientY: number,
  geometry: TerminalPointerGeometry,
): CellPos {
  if (geometry.charWidth === 0 || geometry.charHeight === 0) {
    return { col: 0, row: 0 };
  }
  const col = Math.round((clientX - geometry.containerLeft) / geometry.charWidth);
  const row = Math.floor((clientY - geometry.containerTop) / geometry.charHeight);
  return {
    col: Math.max(0, Math.min(geometry.cols, col)),
    row: Math.max(0, Math.min(geometry.rows - 1, row)),
  };
}

/**
 * Which side owns the button gesture in flight: the application that asked for
 * mouse reports, or the selection the user is dragging.
 *
 * Decided once, at the press, and never revisited, because a release has to be
 * reported to whoever was told about its press. Shift going down mid-drag would
 * otherwise leave an application holding a button it is never told was let go,
 * and Shift coming up mid-drag would hand it a release it never saw pressed.
 */
export interface MouseGestureOwner {
  /**
   * Take the press. With `selectionOwnsMouse` set the application is told
   * nothing at all for this gesture. Returns true when the press is the
   * application's to hear about.
   */
  press(selectionOwnsMouse: boolean): boolean;
  /** True while an application gesture is in flight, so motion follows it. */
  isApplication(): boolean;
  /** Take the release. True when the application must be told it ended. */
  release(): boolean;
  /** The pointer was cancelled, or the gesture is being abandoned. */
  reset(): void;
}

export function createMouseGestureOwner(): MouseGestureOwner {
  let application = false;
  return {
    press(selectionOwnsMouse: boolean): boolean {
      application = !selectionOwnsMouse;
      return application;
    },
    isApplication: () => application,
    release(): boolean {
      const owed = application;
      application = false;
      return owed;
    },
    reset(): void {
      application = false;
    },
  };
}

export interface PointerMotionDeduper {
  shouldReport(cell: CellPos, button: number): boolean;
  reset(): void;
}

export function createPointerMotionDeduper(): PointerMotionDeduper {
  let col = -1;
  let row = -1;
  let button = -1;

  return {
    shouldReport(cell, nextButton): boolean {
      if (col === cell.col && row === cell.row && button === nextButton) return false;
      col = cell.col;
      row = cell.row;
      button = nextButton;
      return true;
    },
    reset(): void {
      col = -1;
      row = -1;
      button = -1;
    },
  };
}
