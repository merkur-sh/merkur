import type { SseEvent } from './lib/authenticated-transport';

/**
 * Wire shapes for the event-stream worker.
 *
 * The worker owns the fetch and the body reader of every authenticated event
 * stream; the page sees parsed events. Streams are multiplexed by `id`, which
 * the page allocates.
 */
export type EventStreamWorkerCommand =
  | {
      kind: 'open';
      id: number;
      path: string;
      /** Built on the page, so the worker holds no credential of its own. */
      headers: Record<string, string>;
    }
  | { kind: 'close'; id: number };

/** Why a stream ended without a clean end of body. */
export type EventStreamFailure =
  | { readonly type: 'http'; readonly status: number }
  | { readonly type: 'too_large' }
  | { readonly type: 'failed'; readonly message: string };

export type EventStreamWorkerEvent =
  | { kind: 'open'; id: number }
  /** One reader chunk and the events it completed, in stream order. */
  | { kind: 'chunk'; id: number; events: readonly SseEvent[] }
  | { kind: 'end'; id: number }
  | { kind: 'failed'; id: number; failure: EventStreamFailure };
