import type { EventStreamFailure, EventStreamWorkerEvent } from './event-stream-worker-protocol';
import {
  authenticatedRequestHeaders,
  EventStreamHttpError,
  EventStreamTooLargeError,
  type OpenAuthenticatedEventStreamOptions,
} from './lib/authenticated-transport';

/**
 * Authenticated event streams, read off the main thread.
 *
 * Same contract as reading the stream here: resolves on a clean end of body,
 * rejects with `EventStreamHttpError` on a non-2xx answer and with an
 * `AbortError` once `signal` aborts. The fetch and the body reader live in
 * `event-stream-worker.ts`, because iOS WebKit holds back chunks that queue up
 * behind one another while the reading thread is busy, and the main thread is
 * busiest exactly when a sign-in opens the device-events stream.
 *
 * One worker for the page, created on the first stream and kept: the streams
 * it carries are long-lived and reopened, and a dedicated thread per reopen
 * would buy nothing.
 */

interface OpenStream {
  readonly options: OpenAuthenticatedEventStreamOptions;
  settle(error?: Error): void;
}

let worker: Worker | null = null;
const streams = new Map<number, OpenStream>();
let nextStreamId = 0;

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  // Same `new URL(..., import.meta.url)` form the other workers use, so Vite
  // fingerprints it and pins the hashed URL into the main bundle.
  const created = new Worker(new URL('./event-stream-worker.ts', import.meta.url), {
    type: 'module',
  });
  // A worker that died, or one that broke the protocol, takes every stream it
  // carried with it. Each fails as a transport failure, and the next open
  // starts a fresh worker.
  const failWorker = (reason: string): void => {
    if (worker === created) worker = null;
    created.terminate();
    const failed = [...streams.values()];
    for (const stream of failed) stream.settle(new Error(reason));
  };
  created.onmessage = (event: MessageEvent<EventStreamWorkerEvent>): void => {
    const message = event.data;
    const stream = streams.get(message.id);
    if (stream === undefined) return;
    switch (message.kind) {
      case 'open':
        stream.options.onOpen?.();
        return;
      case 'chunk':
        stream.options.onActivity?.();
        for (const sseEvent of message.events) stream.options.onEvent(sseEvent);
        return;
      case 'end':
        stream.settle();
        return;
      case 'failed':
        stream.settle(toError(message.failure));
        return;
    }
  };
  created.onerror = (event: ErrorEvent): void => {
    event.preventDefault();
    failWorker('Event stream worker failed');
  };
  created.onmessageerror = (): void => {
    failWorker('Event stream worker failed to deserialize a message');
  };
  worker = created;
  return created;
}

export function openAuthenticatedEventStream(
  accessToken: string,
  path: string,
  options: OpenAuthenticatedEventStreamOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { signal } = options;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const id = ++nextStreamId;
    const target = ensureWorker();
    const onAbort = (): void => {
      if (!streams.has(id)) return;
      streams.delete(id);
      target.postMessage({ kind: 'close', id });
      reject(abortError());
    };
    streams.set(id, {
      options,
      settle(error) {
        streams.delete(id);
        signal.removeEventListener('abort', onAbort);
        if (error === undefined) resolve();
        else reject(error);
      },
    });
    signal.addEventListener('abort', onAbort, { once: true });
    target.postMessage({
      kind: 'open',
      id,
      path,
      headers: authenticatedRequestHeaders(accessToken, options.headers),
    });
  });
}

function toError(failure: EventStreamFailure): Error {
  switch (failure.type) {
    case 'http':
      return new EventStreamHttpError(failure.status);
    case 'too_large':
      return new EventStreamTooLargeError();
    case 'failed':
      return new Error(failure.message);
  }
}

function abortError(): Error {
  return new DOMException('The event stream was closed', 'AbortError');
}
