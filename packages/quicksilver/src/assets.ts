import { readFileSync } from 'node:fs';

/**
 * One frame of the real orb, captured from the shader itself rather than
 * approximated: a hand-written gradient cannot be a raymarched liquid-metal
 * surface, and next to the live one it read as a different mark. 96 CSS px at
 * 2x, produced by `scripts/capture-orb-still.ts` into `assets/orb-still.webp`.
 * Lossy WebP with alpha: the surface is noise, so PNG cannot compress it
 * (40 KB), and a JPEG (9 KB) has no alpha, which forced the earlier still to
 * be flattened onto one ground colour and drew a black disc anywhere else. At
 * quality 0.85 this is 5 KB and sits on any surface.
 *
 * A data URI rather than a URL: the orb at rest is what a surface paints
 * before any script runs — the app's boot splash — and the whole point of
 * that paint is that it needs no round trip.
 */
export const ORB_STILL_DATA_URI = `data:image/webp;base64,${readFileSync(
  new URL('../assets/orb-still.webp', import.meta.url),
).toString('base64')}`;
