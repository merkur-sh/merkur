export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record whose own keys are exactly `keys`, in any order: nothing missing, nothing extra. */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is JsonRecord {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function parseJson(value: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

export function readStringField(value: JsonRecord, key: string): string | null {
  const field = value[key];
  if (typeof field !== 'string') {
    return null;
  }

  return field;
}

export function readNonEmptyStringField(value: JsonRecord, key: string): string | null {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    return null;
  }

  return field;
}

export function readFiniteNumberField(value: JsonRecord, key: string): number | null {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    return null;
  }

  return field;
}

export function readNullableFiniteNumberField(
  value: JsonRecord,
  key: string,
): number | null | undefined {
  const field = value[key];
  if (field === null) {
    return null;
  }

  if (typeof field === 'number' && Number.isFinite(field)) {
    return field;
  }

  return undefined;
}
