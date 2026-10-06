import { createAuthorizationHeader, traceparentHeader } from '@merkur/shared';

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * A definitive HTTP rejection from the event-stream endpoint.
 *
 * Keep this distinct from fetch/reader failures: only an explicit 401 proves
 * that rotating the one-use refresh credential and repeating the request is
 * safe. A network failure may have happened after the server accepted it.
 */
export class EventStreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`Event stream failed: ${status}`);
    this.name = 'EventStreamHttpError';
  }
}

// Device snapshots are small in normal operation. Bound a malformed or
// delimiter-starved event before it can retain arbitrary browser memory.
export const MAX_SSE_EVENT_CHARS = 1024 * 1024;

export class EventStreamTooLargeError extends Error {
  constructor() {
    super(`Event stream event exceeds ${MAX_SSE_EVENT_CHARS} characters`);
    this.name = 'EventStreamTooLargeError';
  }
}

export interface OpenAuthenticatedEventStreamOptions {
  readonly signal: AbortSignal;
  /** Extra request headers, alongside the authorization header. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly onOpen?: () => void;
  readonly onEvent: (event: SseEvent) => void;
  /**
   * Every chunk the reader yields, framed or not.
   *
   * Liveness is a property of the socket, not of the events carried on it: a
   * server's keep-alive comment is discarded by the parser below, so an event
   * callback alone cannot tell a healthy quiet stream from a half-open one. The
   * consumer times this out.
   */
  readonly onActivity?: () => void;
}

/**
 * The headers every authenticated request carries, plus `extra`, as a plain
 * record: the form that can cross to the event-stream worker.
 */
export function authenticatedRequestHeaders(
  accessToken: string,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    mergeHeaders(extra, { ...createAuthorizationHeader(accessToken), ...traceparentHeader() }),
  );
}

interface EventStreamReadCallbacks {
  readonly onOpen: () => void;
  /** One reader chunk: every event it completed, possibly none. */
  readonly onChunk: (events: readonly SseEvent[]) => void;
}

/**
 * One event-stream request, fetched and read on the calling thread.
 *
 * Only `event-stream-worker.ts` calls this. Reading a streamed body on the
 * main thread loses data on iOS: when two or more network chunks arrive while
 * the reading thread is busy, WebKit hands the reader the first and holds the
 * rest until the next chunk arrives. On this stream the next chunk is a
 * keep-alive 15 s away, so a sign-in that keeps the main thread busy while the
 * opening frame lands left the machine list a skeleton until then, or until
 * the stall deadline. Every read mode on the main thread does it (default,
 * BYOB, `pipeTo`, `pipeThrough`); a thread that does nothing else never does.
 */
export async function readEventStream(
  path: string,
  init: { readonly signal: AbortSignal; readonly headers: Readonly<Record<string, string>> },
  callbacks: EventStreamReadCallbacks,
): Promise<void> {
  const response = await fetch(path, {
    credentials: 'include',
    signal: init.signal,
    headers: init.headers,
    /**
     * Never touch the HTTP cache, in either direction.
     *
     * Browsers give a cache entry one writer and make every other request for
     * the same key wait on it. An event stream never finishes, so the entry it
     * opens is held open forever, and the next request for this URL — the next
     * page after a reload, say — blocks on that writer with nothing to show
     * for it: no headers, no bytes, no error, and no request at the server
     * either, until the browser's own lock timeout expires (20.5 s, measured
     * in Firefox against production). The response says `no-store` for the
     * same reason, but that only arrives once the response does; declaring it
     * on the request is what keeps the entry from existing in the first place.
     */
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new EventStreamHttpError(response.status);
  }
  if (response.body === null) {
    throw new Error('Event stream response has no body');
  }

  callbacks.onOpen();

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let completed: SseEvent[] = [];
  const parser = createSseEventParser((event) => completed.push(event));

  try {
    while (!init.signal.aborted) {
      const next = await reader.read();
      if (next.done) {
        break;
      }

      parser.push(next.value);
      callbacks.onChunk(completed);
      completed = [];
    }
  } catch (error) {
    // A malformed/oversized stream must release the underlying fetch body
    // immediately instead of leaving the producer running without a reader.
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function mergeHeaders(base: HeadersInit | undefined, next: HeadersInit): Headers {
  const headers = new Headers(base);
  for (const [key, value] of new Headers(next)) {
    headers.set(key, value);
  }
  return headers;
}

export function createSseEventParser(onEvent: (event: SseEvent) => void): {
  push(chunk: string): void;
} {
  let event = 'message';
  const dataLines: string[] = [];
  let lineParts: string[] = [];
  let lineLength = 0;
  let completedEventChars = 0;

  function resetEvent(): void {
    event = 'message';
    dataLines.length = 0;
    completedEventChars = 0;
  }

  function processLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      if (dataLines.length > 0) {
        onEvent({ event, data: dataLines.join('\n') });
      }
      resetEvent();
      return;
    }
    if (line.startsWith(':')) return;

    if (line.startsWith('event:')) {
      const value = line.slice('event:'.length);
      event = value.startsWith(' ') ? value.slice(1) : value;
      return;
    }

    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }

  return {
    push(chunk: string): void {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf('\n', start);
        const end = newline === -1 ? chunk.length : newline;
        if (end > start) {
          const part = chunk.slice(start, end);
          lineParts.push(part);
          lineLength += part.length;
          if (completedEventChars + lineLength > MAX_SSE_EVENT_CHARS) {
            throw new EventStreamTooLargeError();
          }
        }
        if (newline === -1) return;

        const line = lineParts.length === 0 ? '' : lineParts.join('');
        completedEventChars += lineLength + 1;
        lineParts = [];
        lineLength = 0;
        processLine(line);
        start = newline + 1;
      }
    },
  };
}
