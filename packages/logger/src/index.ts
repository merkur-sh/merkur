import { Effect } from 'effect';
import { type LogLevel, sanitizeLogContext, writeMerkurLog } from './sink';

export { MerkurJsonLogger, MerkurLoggerLayer } from './effect-logger';
export type { LogLevel } from './sink';
/**
 * Direct stdout write, bypassing any registered export sink.
 *
 * Public solely so a sink owner can fall back when its runtime cannot serve the
 * record — calling `logger.error` there would re-enter the failing sink. Normal
 * logging goes through `createLogger`.
 */
export { writeMerkurLog } from './sink';
/**
 * Development tracer. Selected when no OTLP endpoint is configured, so spans
 * that would otherwise be created and discarded are printed as a tree.
 */
export { SpanTreeTracerLayer } from './span-tree-tracer';

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /**
   * Native Effect logging for code already running in a fiber. Optional so
   * small callback-oriented test doubles can implement only the sync surface.
   */
  readonly effect?: (
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ) => Effect.Effect<void>;
}

const LOG_ANNOTATION_SCOPE = 'scope';
const LOG_ANNOTATION_CONTEXT_JSON = '__merkur_context_json';

/**
 * Structured log context for a caught error. Preserves the message, error
 * name, and Effect `_tag` (when present) instead of flattening everything
 * to `String(error)`.
 */
export function errorLogContext(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const context: Record<string, unknown> = {
      error: error.message,
      errorName: error.name,
    };
    if ('_tag' in error && typeof error._tag === 'string') {
      context.errorTag = error._tag;
    }
    return context;
  }
  return { error: String(error) };
}

export function createLogger(scope: string): Logger {
  return {
    info(message: string, context: Record<string, unknown> = {}): void {
      logWithLevel('info', scope, message, context);
    },
    warn(message: string, context: Record<string, unknown> = {}): void {
      logWithLevel('warn', scope, message, context);
    },
    error(message: string, context: Record<string, unknown> = {}): void {
      logWithLevel('error', scope, message, context);
    },
    effect(level, message, context = {}): Effect.Effect<void> {
      return logEffect(level, scope, message, context);
    },
  };
}

/**
 * Emits one log record through an Effect runtime. Registered by the process
 * that owns a runtime; see `setExportedLogSink`.
 */
export type ExportedLogSink = (
  level: LogLevel,
  scope: string,
  message: string,
  context: Record<string, unknown>,
) => void;

let exportedLogSink: ExportedLogSink | null = null;

/**
 * Route the synchronous logging surface through an Effect runtime so it reaches
 * the OTLP log exporter.
 *
 * # Why this exists
 *
 * `createLogger(...).error()` wrote straight to stdout. Only Effect-native
 * records (`logEffect` / `logWithLoggerEffect`) were exported, so 17 of the
 * server's 59 error/warn sites were invisible to the backend — including
 * `redis_error`, `server_fatal`, and the entire daemon-control error surface.
 * Those sites are EventEmitter callbacks, `try`/`catch` blocks and Elysia
 * handlers: they have no fiber to `yield*` from, so converting them
 * individually is not possible, and services inside `ServerLive` cannot import
 * the runtime without a cycle.
 *
 * Delegating instead of duplicating is deliberate. `logEffect` reaches the OTLP
 * logger AND `MerkurJsonLogger`, which writes the same stdout line this
 * function would have written — so the record still appears exactly once on
 * stdout. Writing both would double every line.
 *
 * The sink must be registered only once a runtime can serve it. A sink that
 * throws falls back to stdout: a broken exporter must never lose a log.
 */
export function setExportedLogSink(sink: ExportedLogSink | null): void {
  exportedLogSink = sink;
}

function logWithLevel(
  level: LogLevel,
  scope: string,
  message: string,
  context: Record<string, unknown>,
): void {
  const sink = exportedLogSink;
  if (sink !== null) {
    try {
      sink(level, scope, message, context);
      return;
    } catch {
      // Fall through to stdout below.
    }
  }
  writeMerkurLog({
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    context,
  });
}

export function logEffect(
  level: LogLevel,
  scope: string,
  message: string,
  context: Record<string, unknown> = {},
): Effect.Effect<void> {
  const baseLog =
    level === 'info'
      ? Effect.logInfo(message)
      : level === 'warn'
        ? Effect.logWarning(message)
        : Effect.logError(message);

  return baseLog.pipe(
    Effect.annotateLogs(LOG_ANNOTATION_SCOPE, scope),
    Effect.annotateLogs(LOG_ANNOTATION_CONTEXT_JSON, JSON.stringify(sanitizeLogContext(context))),
  );
}

export function logWithLoggerEffect(
  logger: Logger,
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
): Effect.Effect<void> {
  if (logger.effect !== undefined) {
    return logger.effect(level, message, context);
  }
  return Effect.sync(() => {
    logger[level](message, context);
  });
}
