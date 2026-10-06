export interface DisplayBackingCanvas {
  width: number;
  height: number;
}

export interface ResizableDisplayRenderer {
  resize(width: number, height: number): void;
}

/**
 * Resize the backing store and renderer together.
 *
 * Updating only the GPU viewport leaves OffscreenCanvas at its previous size:
 * font metric changes then render into a clipped/stretched backing texture even
 * though layout reports the new dimensions.
 */
export function resizeDisplaySurface(
  canvas: DisplayBackingCanvas | null,
  renderer: ResizableDisplayRenderer,
  width: number,
  height: number,
): boolean {
  // Assigning either canvas dimension clears the entire backing store even
  // when the value is unchanged. Font/control replay can coincide with the
  // first authoritative frame, so make the common same-size path a true no-op.
  if (canvas !== null && canvas.width === width && canvas.height === height) {
    return false;
  }
  if (canvas !== null) {
    canvas.width = width;
    canvas.height = height;
  }
  renderer.resize(width, height);
  return true;
}
