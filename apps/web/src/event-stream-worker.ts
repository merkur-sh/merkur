import type {
  EventStreamFailure,
  EventStreamWorkerCommand,
  EventStreamWorkerEvent,
} from './event-stream-worker-protocol';
import {
  EventStreamHttpError,
  EventStreamTooLargeError,
  readEventStream,
} from './lib/authenticated-transport';

/**
 * Fetches and reads the page's authenticated event streams.
 *
 * It exists for the thread, not the work: this worker does nothing else, so it
 * is never busy when a chunk arrives. On iOS a streamed body read by a busy
 * thread keeps the first of several queued chunks and holds the rest until
 * more data arrives (see `readEventStream`), which on the device-events stream
 * is a keep-alive 15 s later.
 */

const streams = new Map<number, AbortController>();

function post(event: EventStreamWorkerEvent): void {
  self.postMessage(event);
}

function describe(error: unknown): EventStreamFailure {
  if (error instanceof EventStreamHttpError) return { type: 'http', status: error.status };
  if (error instanceof EventStreamTooLargeError) return { type: 'too_large' };
  return { type: 'failed', message: error instanceof Error ? error.message : String(error) };
}

self.onmessage = (event: MessageEvent<EventStreamWorkerCommand>): void => {
  const command = event.data;
  if (command.kind === 'close') {
    streams.get(command.id)?.abort();
    streams.delete(command.id);
    return;
  }
  const { id } = command;
  const controller = new AbortController();
  streams.set(id, controller);
  // Nothing is posted once the page has closed the stream: it settled its own
  // side when it asked, and a late answer has no one to go to.
  void readEventStream(
    command.path,
    { signal: controller.signal, headers: command.headers },
    {
      onOpen: () => post({ kind: 'open', id }),
      onChunk: (events) => post({ kind: 'chunk', id, events }),
    },
  ).then(
    () => {
      if (controller.signal.aborted) return;
      streams.delete(id);
      post({ kind: 'end', id });
    },
    (error: unknown) => {
      if (controller.signal.aborted) return;
      streams.delete(id);
      post({ kind: 'failed', id, failure: describe(error) });
    },
  );
};
