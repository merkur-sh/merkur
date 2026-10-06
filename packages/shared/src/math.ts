export function nextPowerOfTwo(value: number): number {
  if (!Number.isInteger(value) || value <= 1) {
    return 1;
  }

  let next = 1;
  while (next < value) {
    next <<= 1;
  }

  return next;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}
