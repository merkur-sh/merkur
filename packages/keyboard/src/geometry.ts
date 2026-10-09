import type {
  KeyboardGeometryProfile,
  KeyboardLayout,
  KeyboardRect,
  ResolvedKeyboardGeometry,
  ResolvedKeyboardKey,
} from './types';

const NO_KEY = 255;
export const KEYBOARD_CANDIDATE_COUNT = 4;

export const CUPERTINO_PORTRAIT_PROFILE: KeyboardGeometryProfile = {
  // Measured from Apple's 402 pt-wide keyboard at 3x. Keeping the half-point
  // inset is intentional: the solver snaps every edge to a physical pixel.
  horizontalPadding: 6.5,
  topPadding: 73 / 3,
  // The root already reserves env(safe-area-inset-bottom). A second inset here
  // created the visible strip below the final row on home-indicator devices.
  bottomPadding: 0,
  // Apple's language/microphone rail is 44 pt above the 34 pt home-indicator
  // safe area. It remains visually outside the key surface, while the bottom
  // row's invisible hit regions extend through it.
  bottomUtilityHeight: 44,
  keyGap: 6,
  rowGap: 11,
  keyHeight: 43,
  cornerRadius: 5,
  hysteresis: 3,
  tapDrift: 12,
  // Three key pitches. Chosen by sweeping both things it trades between, on the
  // replay corpus and on the engine itself.
  //
  // Accuracy under in-contact drift improves monotonically as this grows —
  // 86.4% at one pitch, 92.3% at 60px, 94.1% here, against 94.7% for never
  // ramping at all — because a larger value keeps trusting the contact point,
  // and the contact point is what the aim actually was.
  //
  // The opposing constraint is slide-to-correct, and it binds later than it
  // looks: one-, two- and three-key slides in both directions all still land on
  // the intended key at every value up to here, and only start failing at 200px.
  // So this sits at the accuracy-optimal end of the range that keeps the gesture
  // working, with a margin before the first failure.
  slideDrift: 120,
  // A tap's release point is the one sample corrupted by the finger pivoting as
  // it lifts, and it already carries the heaviest weight in the recency-weighted
  // trajectory centroid. Scoring it a second time on its own only re-applies
  // that roll-off bias, so a tap is decided by contact plus path. Drift beyond
  // tapDrift is a deliberate slide and is still decided by the release point;
  // tapDrift stays below half a key pitch, so no drift small enough to be
  // treated as a tap can cross into a neighbouring key.
  releaseWeight: 0,
  // Measured on the HOW-WE-TYPE-MOBILE replay corpus: 0.25 recovers most of the
  // available error reduction, and weights at or above 1 start losing accuracy
  // because the prior begins overriding taps the geometry had right.
  priorWeight: 0.25,
  maximumPointers: 10,
};

export const CUPERTINO_LANDSCAPE_PROFILE: KeyboardGeometryProfile = {
  ...CUPERTINO_PORTRAIT_PROFILE,
  topPadding: 5,
  bottomPadding: 4,
  bottomUtilityHeight: 0,
  rowGap: 4,
  keyHeight: 32,
  cornerRadius: 5,
};

/**
 * The posture a keyboard of this width is being held in.
 *
 * One definition, because there were three and they could disagree. `dom.ts`
 * compared the keyboard root's width to the viewport height, the Solid adapter
 * compared the resolved geometry's width, and the offset store compared
 * `window.innerWidth` — which is not the same thing in split view or any
 * shrunk viewport, so a landscape profile could be composed with
 * portrait-learned offsets. The keyboard's own width is the right input: it is
 * what the layout was actually solved for.
 */
export function keyboardOrientation(width: number): 'portrait' | 'landscape' {
  return width > window.innerHeight ? 'landscape' : 'portrait';
}

export function solveKeyboardGeometry(
  layout: KeyboardLayout,
  layerId: string,
  width: number,
  devicePixelRatio: number,
  profile: KeyboardGeometryProfile,
): ResolvedKeyboardGeometry {
  const layer = layout.layers[layerId];
  if (layer === undefined) throw new Error(`Unknown keyboard layer: ${layerId}`);
  if (!Number.isFinite(width) || width <= profile.horizontalPadding * 2) {
    throw new Error('Keyboard width must be larger than its horizontal padding');
  }
  validateProfile(profile);

  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const snap = (value: number): number => Math.round(value * dpr) / dpr;
  const innerWidth = width - profile.horizontalPadding * 2;
  const pitch = (innerWidth + profile.keyGap) / layer.columns;
  const rows: number[][] = [];
  const keys: ResolvedKeyboardKey[] = [];

  for (let rowIndex = 0; rowIndex < layer.rows.length; rowIndex += 1) {
    const row = layer.rows[rowIndex];
    if (row === undefined) continue;
    const rowKeys: number[] = [];
    const y = snap(profile.topPadding + rowIndex * (profile.keyHeight + profile.rowGap));
    for (const placement of row.keys) {
      const definition = layout.keys[placement.key];
      if (definition === undefined) continue;
      const span = placement.span ?? 1;
      const left = snap(profile.horizontalPadding + placement.column * pitch);
      const right = snap(
        profile.horizontalPadding + (placement.column + span) * pitch - profile.keyGap,
      );
      const index = keys.length;
      keys.push({
        index,
        row: rowIndex,
        definition,
        placement,
        rect: {
          x: left,
          y,
          width: Math.max(1 / dpr, right - left),
          height: snap(profile.keyHeight),
        },
      });
      rowKeys.push(index);
    }
    rows.push(rowKeys);
  }

  const height = snap(
    profile.topPadding +
      layer.rows.length * profile.keyHeight +
      Math.max(0, layer.rows.length - 1) * profile.rowGap +
      profile.bottomPadding,
  );
  const hitHeight = height + profile.bottomUtilityHeight;
  const atlasWidth = Math.max(1, Math.ceil(width));
  const surfaceAtlasHeight = Math.max(1, Math.ceil(height));
  const atlasHeight = Math.max(1, Math.ceil(hitHeight));
  const candidateAtlas = buildCandidateAtlas(keys, atlasWidth, surfaceAtlasHeight, atlasHeight);

  return {
    layerId,
    width,
    hitHeight,
    height,
    atlasWidth,
    atlasHeight,
    candidateAtlas,
    keys,
    rows,
  };
}

/** Returns the shared atlas offset without allocating a candidate object. */
export function keyboardHitAtlasOffset(
  geometry: ResolvedKeyboardGeometry,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x >= geometry.width || y >= geometry.hitHeight) return -1;
  const atlasX = Math.floor(x);
  const atlasY = Math.floor(y);
  if (atlasX < 0 || atlasY < 0 || atlasX >= geometry.atlasWidth || atlasY >= geometry.atlasHeight) {
    return -1;
  }
  return atlasY * geometry.atlasWidth + atlasX;
}

export function hitTestKeyboard(
  geometry: ResolvedKeyboardGeometry,
  x: number,
  y: number,
): number | null {
  const offset = keyboardHitAtlasOffset(geometry, x, y);
  if (offset < 0) return null;
  const index = geometry.candidateAtlas[offset * KEYBOARD_CANDIDATE_COUNT];
  return index === undefined || index === NO_KEY ? null : index;
}

export function rectContainsExpanded(
  rect: KeyboardRect,
  x: number,
  y: number,
  expansion: number,
): boolean {
  return (
    x >= rect.x - expansion &&
    x <= rect.x + rect.width + expansion &&
    y >= rect.y - expansion &&
    y <= rect.y + rect.height + expansion
  );
}

function buildCandidateAtlas(
  keys: readonly ResolvedKeyboardKey[],
  width: number,
  surfaceHeight: number,
  atlasHeight: number,
): Uint8Array {
  const atlas = new Uint8Array(width * atlasHeight * KEYBOARD_CANDIDATE_COUNT);
  if (keys.length === 0) return atlas.fill(NO_KEY);

  const rowCount = keys.reduce((count, key) => Math.max(count, key.row + 1), 0);
  const rowKeys: number[][] = Array.from({ length: rowCount }, () => []);
  for (const key of keys) rowKeys[key.row]?.push(key.index);

  // All keys in a row share the same vertical score. Therefore a row's fifth
  // closest horizontal key can never enter the global top four: four keys in
  // that same row will always outrank it after the common vertical score is
  // added. Preselecting four keys per row is exact and roughly halves the hot
  // atlas-construction scan for the terminal layouts.
  const rowStride = width * KEYBOARD_CANDIDATE_COUNT;
  const xCandidateIndices = new Uint8Array(rowCount * rowStride);
  const xCandidateDistances = new Float32Array(rowCount * rowStride);
  xCandidateIndices.fill(NO_KEY);
  xCandidateDistances.fill(Number.POSITIVE_INFINITY);

  for (let row = 0; row < rowCount; row += 1) {
    const indices = rowKeys[row];
    if (indices === undefined || indices.length === 0) continue;
    const rowOffset = row * rowStride;
    for (let x = 0; x < width; x += 1) {
      const sampleX = x + 0.5;
      let distance0 = Number.POSITIVE_INFINITY;
      let distance1 = Number.POSITIVE_INFINITY;
      let distance2 = Number.POSITIVE_INFINITY;
      let distance3 = Number.POSITIVE_INFINITY;
      let index0 = NO_KEY;
      let index1 = NO_KEY;
      let index2 = NO_KEY;
      let index3 = NO_KEY;

      for (const keyIndex of indices) {
        const key = keys[keyIndex];
        if (key === undefined) continue;
        const right = key.rect.x + key.rect.width;
        const dx =
          sampleX < key.rect.x ? key.rect.x - sampleX : sampleX > right ? sampleX - right : 0;
        const centerDx = sampleX - key.rect.x - key.rect.width * 0.5;
        const distance = Math.fround(dx * dx + centerDx * centerDx * 1e-9);

        if (distance < distance0 || (distance === distance0 && keyIndex < index0)) {
          distance3 = distance2;
          index3 = index2;
          distance2 = distance1;
          index2 = index1;
          distance1 = distance0;
          index1 = index0;
          distance0 = distance;
          index0 = keyIndex;
        } else if (distance < distance1 || (distance === distance1 && keyIndex < index1)) {
          distance3 = distance2;
          index3 = index2;
          distance2 = distance1;
          index2 = index1;
          distance1 = distance;
          index1 = keyIndex;
        } else if (distance < distance2 || (distance === distance2 && keyIndex < index2)) {
          distance3 = distance2;
          index3 = index2;
          distance2 = distance;
          index2 = keyIndex;
        } else if (distance < distance3 || (distance === distance3 && keyIndex < index3)) {
          distance3 = distance;
          index3 = keyIndex;
        }
      }

      const offset = rowOffset + x * KEYBOARD_CANDIDATE_COUNT;
      xCandidateDistances[offset] = distance0;
      xCandidateDistances[offset + 1] = distance1;
      xCandidateDistances[offset + 2] = distance2;
      xCandidateDistances[offset + 3] = distance3;
      xCandidateIndices[offset] = index0;
      xCandidateIndices[offset + 1] = index1;
      xCandidateIndices[offset + 2] = index2;
      xCandidateIndices[offset + 3] = index3;
    }
  }

  const yDistances = new Float32Array(surfaceHeight * rowCount);
  for (let y = 0; y < surfaceHeight; y += 1) {
    const sampleY = y + 0.5;
    const offset = y * rowCount;
    for (let row = 0; row < rowCount; row += 1) {
      const firstKeyIndex = rowKeys[row]?.[0];
      const key = firstKeyIndex === undefined ? undefined : keys[firstKeyIndex];
      if (key === undefined) {
        yDistances[offset + row] = Number.POSITIVE_INFINITY;
        continue;
      }
      const bottom = key.rect.y + key.rect.height;
      const dy =
        sampleY < key.rect.y ? key.rect.y - sampleY : sampleY > bottom ? sampleY - bottom : 0;
      const centerDy = sampleY - key.rect.y - key.rect.height * 0.5;
      yDistances[offset + row] = dy * dy + centerDy * centerDy * 1e-9;
    }
  }

  for (let y = 0; y < surfaceHeight; y += 1) {
    const yOffset = y * rowCount;
    for (let x = 0; x < width; x += 1) {
      let distance0 = Number.POSITIVE_INFINITY;
      let distance1 = Number.POSITIVE_INFINITY;
      let distance2 = Number.POSITIVE_INFINITY;
      let distance3 = Number.POSITIVE_INFINITY;
      let index0 = NO_KEY;
      let index1 = NO_KEY;
      let index2 = NO_KEY;
      let index3 = NO_KEY;

      for (let row = 0; row < rowCount; row += 1) {
        const verticalDistance = yDistances[yOffset + row] ?? Number.POSITIVE_INFINITY;
        const xOffset = row * rowStride + x * KEYBOARD_CANDIDATE_COUNT;
        for (let position = 0; position < KEYBOARD_CANDIDATE_COUNT; position += 1) {
          const keyIndex = xCandidateIndices[xOffset + position] ?? NO_KEY;
          const distance =
            (xCandidateDistances[xOffset + position] ?? Number.POSITIVE_INFINITY) +
            verticalDistance;
          // This row's candidates are sorted by distance. Once one exceeds
          // the global fourth distance, every remaining candidate does too.
          if (distance > distance3) break;

          if (distance < distance0 || (distance === distance0 && keyIndex < index0)) {
            distance3 = distance2;
            index3 = index2;
            distance2 = distance1;
            index2 = index1;
            distance1 = distance0;
            index1 = index0;
            distance0 = distance;
            index0 = keyIndex;
          } else if (distance < distance1 || (distance === distance1 && keyIndex < index1)) {
            distance3 = distance2;
            index3 = index2;
            distance2 = distance1;
            index2 = index1;
            distance1 = distance;
            index1 = keyIndex;
          } else if (distance < distance2 || (distance === distance2 && keyIndex < index2)) {
            distance3 = distance2;
            index3 = index2;
            distance2 = distance;
            index2 = keyIndex;
          } else if (distance < distance3 || (distance === distance3 && keyIndex < index3)) {
            distance3 = distance;
            index3 = keyIndex;
          }
        }
      }

      const offset = (y * width + x) * KEYBOARD_CANDIDATE_COUNT;
      atlas[offset] = index0;
      atlas[offset + 1] = index1;
      atlas[offset + 2] = index2;
      atlas[offset + 3] = index3;
    }
  }
  if (surfaceHeight < atlasHeight) {
    const rowLength = width * KEYBOARD_CANDIDATE_COUNT;
    const lastSurfaceRow = atlas.subarray(
      (surfaceHeight - 1) * rowLength,
      surfaceHeight * rowLength,
    );
    for (let row = surfaceHeight; row < atlasHeight; row += 1) {
      atlas.set(lastSurfaceRow, row * rowLength);
    }
  }
  return atlas;
}

function validateProfile(profile: KeyboardGeometryProfile): void {
  const nonNegative = [
    profile.horizontalPadding,
    profile.topPadding,
    profile.bottomPadding,
    profile.bottomUtilityHeight,
    profile.keyGap,
    profile.rowGap,
    profile.cornerRadius,
    profile.hysteresis,
    profile.tapDrift,
  ];
  if (nonNegative.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Keyboard geometry profile contains an invalid length');
  }
  if (!Number.isFinite(profile.keyHeight) || profile.keyHeight <= 0) {
    throw new Error('Keyboard key height must be positive');
  }
  if (
    !Number.isFinite(profile.releaseWeight) ||
    profile.releaseWeight < 0 ||
    profile.releaseWeight > 1
  ) {
    throw new Error('Keyboard release weight must be between zero and one');
  }
  if (!Number.isFinite(profile.priorWeight) || profile.priorWeight < 0) {
    throw new Error('Keyboard prior weight must be non-negative');
  }
  if (!Number.isFinite(profile.slideDrift) || profile.slideDrift < profile.tapDrift) {
    throw new Error('Keyboard slide drift must be at least the tap drift');
  }
  if (!Number.isInteger(profile.maximumPointers) || profile.maximumPointers <= 0) {
    throw new Error('Keyboard maximum pointer count must be a positive integer');
  }
}
