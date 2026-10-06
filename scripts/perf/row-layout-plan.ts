export function rowLayoutFootprint(cols: number, rows: number, liveGlyphs: number) {
  if (
    !Number.isSafeInteger(cols) ||
    cols < 1 ||
    cols > 512 ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 256 ||
    cols * rows > 96 * 1024 ||
    !Number.isSafeInteger(liveGlyphs) ||
    liveGlyphs < 0 ||
    liveGlyphs > cols * rows
  )
    throw new Error('invalid bounded row-layout fixture');
  return {
    slots: cols * rows,
    liveGlyphs,
    glyphBytes: cols * rows * 56,
    backgroundBytes: cols * rows * 28,
    // Six builtin-cell rectangles plus underline and strikeout per cell.
    decorationBytes: cols * rows * 8 * 28,
    vacantSlots: cols * rows - liveGlyphs,
  };
}
