import { afterEach, describe, expect, test } from 'bun:test';
import { type Duration, Effect, Exit, Redacted, Scope } from 'effect';

import type { Logger } from '../logger';
import { createRybbitEvents } from './rybbit-events';

interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface LogRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly context: Record<string, unknown>;
}

const API_KEY = 'rybbit-test-key';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('RybbitEvents', () => {
  test('sends one custom event naming the website and the event, and nothing about the person', async () => {
    const rybbit = startRybbit(() => Response.json({ success: true }));
    const { events } = await createEvents(rybbit.origin);

    await Effect.runPromise(events.send('waitlist_joined'));
    await rybbit.arrival(1);

    expect(rybbit.received).toHaveLength(1);
    const [request] = rybbit.received;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/api/track');
    expect(request?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers['x-forwarded-for']).toBeUndefined();
    expect(JSON.parse(request?.body ?? '')).toEqual({
      site_id: 'site-1',
      type: 'custom_event',
      hostname: 'www.merkur.test',
      pathname: '/',
      event_name: 'waitlist_joined',
    });
  });

  test('returns before Rybbit answers, so no response waits on it', async () => {
    const answer = Promise.withResolvers<Response>();
    const rybbit = startRybbit(() => answer.promise);
    cleanups.push(async () => answer.resolve(Response.json({ success: true })));
    const { events, log } = await createEvents(rybbit.origin);

    // Resolves while Rybbit is still holding the request unanswered.
    await Effect.runPromise(events.send('waitlist_joined'));
    await rybbit.arrival(1);

    expect(log.records).toEqual([]);
  });

  test('logs a refused event with its status, once, and does not retry', async () => {
    const rybbit = startRybbit(() => new Response('nope', { status: 500 }));
    const { events, log } = await createEvents(rybbit.origin);

    await Effect.runPromise(events.send('waitlist_joined'));
    const record = await log.next();

    expect(record).toEqual({
      level: 'warn',
      message: 'rybbit_event_failed',
      context: { event: 'waitlist_joined', status: 500 },
    });
    expect(rybbit.received).toHaveLength(1);
  });

  test('abandons a call Rybbit leaves unanswered past the timeout', async () => {
    const answer = Promise.withResolvers<Response>();
    const rybbit = startRybbit(() => answer.promise);
    // Released before the server stops, which waits for the held request.
    cleanups.push(async () => answer.resolve(new Response(null, { status: 204 })));
    const { events, log } = await createEvents(rybbit.origin, '50 millis');

    await Effect.runPromise(events.send('waitlist_joined'));
    const record = await log.next();

    expect(record.message).toBe('rybbit_event_failed');
    expect(record.context).toMatchObject({ event: 'waitlist_joined', status: null });
    expect(rybbit.received).toHaveLength(1);
  });

  test('logs an unreachable Rybbit without failing the caller', async () => {
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    const origin = `http://127.0.0.1:${closed.port}`;
    await closed.stop(true);
    const { events, log } = await createEvents(origin);

    const exit = await Effect.runPromiseExit(events.send('waitlist_joined'));
    const record = await log.next();

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(record.message).toBe('rybbit_event_failed');
    expect(record.context).toMatchObject({ event: 'waitlist_joined', status: null });
  });
});

async function createEvents(host: string, timeout: Duration.Input = '5 seconds') {
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const log = recordingLogger();
  const events = createRybbitEvents({
    rybbit: { host, siteId: 'site-1', apiKey: Redacted.make(API_KEY) },
    siteOrigin: 'https://www.merkur.test',
    logger: log.logger,
    scope,
    timeout,
  });
  return { events, log };
}

/** A stand-in for Rybbit's `/api/track` that keeps every request it is sent. */
function startRybbit(answer: (request: Request) => Response | Promise<Response>) {
  const received: ReceivedRequest[] = [];
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      received.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      for (const waiter of waiters.splice(0)) {
        if (received.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
      return answer(request);
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    origin: `http://127.0.0.1:${server.port}`,
    received,
    arrival(count: number): Promise<void> {
      if (received.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

/** Keeps every record; `next` resolves with the first one not yet taken, now or when it lands. */
function recordingLogger() {
  const records: LogRecord[] = [];
  let taken = 0;
  let waiter: ((record: LogRecord) => void) | null = null;
  const push =
    (level: LogRecord['level']) =>
    (message: string, context: Record<string, unknown> = {}) => {
      records.push({ level, message, context });
      const resolve = waiter;
      const record = records[taken];
      if (resolve !== null && record !== undefined) {
        waiter = null;
        taken += 1;
        resolve(record);
      }
    };
  const logger: Logger = { info: push('info'), warn: push('warn'), error: push('error') };
  return {
    logger,
    records,
    next(): Promise<LogRecord> {
      const record = records[taken];
      if (record !== undefined) {
        taken += 1;
        return Promise.resolve(record);
      }
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
  };
}
