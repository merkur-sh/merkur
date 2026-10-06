export type LogLevel = 'info' | 'warn' | 'error';

export interface MerkurLogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly context: Record<string, unknown>;
  readonly fiberId?: string;
  /**
   * Elapsed milliseconds per `Effect.withLogSpan` label. **Log** spans, not trace spans —
   * a duration map, not a span identity. `traceId`/`spanId` below are the trace ones.
   */
  readonly spans?: Record<string, number>;
  /**
   * Trace identity of the span this record was logged inside, when there was one.
   *
   * Present only for records emitted in a fiber that has a current span, which is what
   * makes a log line pivotable to its trace. A record from an EventEmitter callback or a
   * connection-lifecycle handler legitimately has none: it belongs to a connection, not to
   * a request, and inventing an id would be worse than omitting it.
   */
  readonly traceId?: string;
  readonly spanId?: string;
}

const SENSITIVE_CONTEXT_KEY =
  /api.?key|authorization|cookie|credential|decapsulation.?key|hmac|pairing.?(?:code|root)|password|private.?key|psk|secret|seed|token/i;
const MAX_SANITIZE_DEPTH = 8;
const REDACTED = '<redacted>';
const CIRCULAR = '<circular>';
const TRUNCATED = '<truncated>';

const LEVEL_SEVERITY: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const SILENT_SEVERITY = 3;

/**
 * Minimum severity to emit, from `LOG_LEVEL`. `silent` drops every record,
 * which is how the unit suite keeps deliberate failure-path logging out of
 * test output. An unset or unrecognized value emits everything: logging is an
 * observability side effect and must never become lifecycle authority, so a
 * malformed level degrades to the current behavior rather than throwing.
 */
function isLevelEnabled(level: LogLevel): boolean {
  if (typeof process === 'undefined') {
    return true;
  }

  const configured = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (configured === undefined || configured.length === 0) {
    return true;
  }

  const threshold =
    configured === 'silent' ? SILENT_SEVERITY : LEVEL_SEVERITY[configured as LogLevel];
  return threshold === undefined ? true : LEVEL_SEVERITY[level] >= threshold;
}

export function writeMerkurLog(record: MerkurLogRecord): void {
  if (!isLevelEnabled(record.level)) {
    return;
  }

  try {
    const sanitizedRecord = sanitizeMerkurLogRecord(record);

    if (typeof process !== 'undefined' && typeof process.stdout?.write === 'function') {
      process.stdout.write(`${JSON.stringify(sanitizedRecord)}\n`);
      return;
    }

    const sink =
      record.level === 'error'
        ? // biome-ignore lint/suspicious/noConsole: the logger package is the console boundary
          console.error
        : record.level === 'warn'
          ? // biome-ignore lint/suspicious/noConsole: the logger package is the console boundary
            console.warn
          : // biome-ignore lint/suspicious/noConsole: the logger package is the console boundary
            console.info;
    sink(`[${record.scope}] ${record.message}`, sanitizedRecord.context);
  } catch {
    // Logging is an observability side effect, never lifecycle authority.
    // Broken pipes, hostile stream shims, or serialization defects must not
    // interrupt resource cleanup or strand a supervised worker.
  }
}

export function sanitizeLogContext(context: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const sanitized: Record<string, unknown> = {};
  const entries = safeEntries(context);
  if (entries === null) {
    return { context: '<unserializable>' };
  }
  for (const [key, value] of entries) {
    sanitized[key] = SENSITIVE_CONTEXT_KEY.test(key) ? REDACTED : sanitizeLogValue(value, seen, 0);
  }
  return sanitized;
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeLogString(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'undefined') {
    return null;
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return TRUNCATED;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    const sanitized = value.map((entry) => sanitizeLogValue(entry, seen, depth + 1));
    seen.delete(value);
    return sanitized;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  const entries = safeEntries(value);
  if (entries === null) {
    seen.delete(value);
    return '<unserializable>';
  }
  for (const [key, entry] of entries) {
    sanitized[key] = SENSITIVE_CONTEXT_KEY.test(key)
      ? REDACTED
      : sanitizeLogValue(entry, seen, depth + 1);
  }
  seen.delete(value);
  return sanitized;
}

function sanitizeLogString(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1<redacted>')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1<redacted>@')
    .replace(/([?&](?:api_?key|key|password|secret|token)=)[^&\s]+/gi, '$1<redacted>');
}

function safeEntries(value: object): Array<[string, unknown]> | null {
  try {
    return Object.entries(value);
  } catch {
    return null;
  }
}

function sanitizeMerkurLogRecord(record: MerkurLogRecord): MerkurLogRecord {
  return {
    ...record,
    message: sanitizeLogString(record.message),
    context: sanitizeLogContext(record.context),
  };
}
