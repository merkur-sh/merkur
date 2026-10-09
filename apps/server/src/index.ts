import './elysia-runtime';
import '@merkur/shared/e2e-wasm-bun';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForProcessSignal } from '@merkur/shared/node-signals';
import { Effect, Fiber, Schedule } from 'effect';

import { ServerConfigService } from './config';
import { runMigrationsEffect } from './db/migrate';
import { createServerApp } from './http/server-app';
import { createDeviceEventsSseLifetime } from './http/sse';
import {
  createLogger,
  errorLogContext,
  logEffect,
  setExportedLogSink,
  writeMerkurLog,
} from './logger';
import { createAuthorizeRequest } from './middleware/authenticated-user';
import { runServerProgram, serverRuntime } from './runtime';
import {
  ACCOUNT_DELETION_SWEEP_INTERVAL,
  sweepDeletedAccountsEffect,
} from './services/account-deletion-sweep';
import { BOX_REMOVAL_INTERVAL, drainBoxRemovalsEffect } from './services/box-removal';
import { DaemonControlServiceTag } from './services/daemon-control-service';
import { DATA_RETENTION_INTERVAL, enforceDataRetentionEffect } from './services/data-retention';
import { HealthServiceTag, SERVER_HEALTH_COMPONENTS } from './services/health-service';
import { NotificationOutboxServiceTag } from './services/notification-outbox-service';
import { RealtimeCoordinationServiceTag } from './services/realtime-coordination-service';
import {
  refreshServerHealthEffect,
  runServerHealthMonitorEffect,
} from './services/server-health-monitor';
import { cleanupExpiredTokensEffect, TOKEN_CLEANUP_INTERVAL } from './services/token-cleanup';

const logger = createLogger('server');
const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIRECTORY = process.env.MERKUR_BUILD_ID
  ? '/deployment/web'
  : path.join(CURRENT_DIRECTORY, '../../../apps/web/dist');
export async function startServer(webDistDirectory: string): Promise<void> {
  const webIndexFile = path.join(webDistDirectory, 'index.html');
  const serverProgram = Effect.scoped(
    Effect.gen(function* () {
      // Route the synchronous logging surface through this runtime so call sites
      // that have no fiber to yield from — EventEmitter handlers, `catch` blocks,
      // Elysia handlers — still reach the OTLP log exporter. Before this, 17 of
      // the server's 59 error/warn sites were stdout-only and therefore invisible
      // to the backend, including `redis_error` and every daemon-control failure.
      //
      // Registered here rather than at module scope because the sink needs a
      // runtime that can already serve it: by the time this program runs,
      // `ServerLive` is built, so `runServerProgram` cannot re-enter layer
      // construction. Released on shutdown so a disposing runtime stops receiving
      // records it can no longer export.
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          setExportedLogSink((level, scope, message, context) => {
            void runServerProgram(logEffect(level, scope, message, context)).catch(() => {
              // The runtime could not serve the record (disposing, or failed).
              // Write it directly rather than through `logger`, which would
              // re-enter this same sink.
              writeMerkurLog({ ts: new Date().toISOString(), level, scope, message, context });
            });
          }),
        ),
        () => Effect.sync(() => setExportedLogSink(null)),
      );

      const config = yield* ServerConfigService;
      const health = yield* HealthServiceTag;
      // Materialize the scoped control service (including its Redis subscription)
      // before accepting daemon WebSocket upgrades.
      const daemonControl = yield* DaemonControlServiceTag;
      const coordination = yield* RealtimeCoordinationServiceTag;

      const deviceEventsLifetime = createDeviceEventsSseLifetime();
      const app = createServerApp({
        deviceEventsLifetime,
        config,
        runServerProgram,
        authorizeRequest: createAuthorizeRequest(runServerProgram),
        logger,
        webIndexFile,
        webDistDirectory,
      });
      yield* runMigrationsEffect(logger);
      const notificationOutbox = yield* NotificationOutboxServiceTag;
      yield* notificationOutbox.start;
      yield* refreshServerHealthEffect;
      const healthMonitorFiber = yield* runServerHealthMonitorEffect.pipe(
        Effect.andThen(
          Effect.die(
            new Error('Server health monitor returned despite its unbounded supervision schedule'),
          ),
        ),
        Effect.forkScoped,
      );

      // Token deletion is non-critical maintenance: start one immediate pass in
      // the scoped background loop, but never run a duplicate blocking pass
      // before the HTTP listener can open.
      yield* cleanupExpiredTokensEffect(logger).pipe(
        Effect.catch((error: unknown) =>
          logEffect('error', 'server', 'expired_token_cleanup_failed', {
            ...errorLogContext(error),
          }),
        ),
        Effect.repeat(Schedule.spaced(TOKEN_CLEANUP_INTERVAL)),
        Effect.catch((error: unknown) =>
          logEffect('error', 'server', 'expired_token_cleanup_loop_failed', {
            ...errorLogContext(error),
          }),
        ),
        Effect.forkScoped,
      );

      // Erasing an account is maintenance in the same sense: it must happen, it
      // must not hold up the listener, and a failed pass is retried by the next
      // one rather than losing the request — the row stays until the purge
      // actually succeeds.
      yield* sweepDeletedAccountsEffect(logger).pipe(
        Effect.catch((error: unknown) =>
          logEffect('error', 'server', 'account_deletion_sweep_failed', {
            ...errorLogContext(error),
          }),
        ),
        Effect.repeat(Schedule.spaced(ACCOUNT_DELETION_SWEEP_INTERVAL)),
        Effect.catch((error: unknown) =>
          logEffect('error', 'server', 'account_deletion_sweep_loop_failed', {
            ...errorLogContext(error),
          }),
        ),
        Effect.forkScoped,
      );

      yield* enforceDataRetentionEffect(logger).pipe(
        Effect.catch((error) =>
          logEffect('error', 'server', 'data_retention_failed', errorLogContext(error)),
        ),
        Effect.repeat(Schedule.spaced(DATA_RETENTION_INTERVAL)),
        Effect.forkScoped,
      );

      // A password reset or retention expiry queues boxes for destruction instead of
      // waiting on the box host; this is what carries the queue out.
      yield* drainBoxRemovalsEffect(logger).pipe(
        Effect.catch((error: unknown) =>
          logEffect('error', 'server', 'box_removal_drain_failed', {
            ...errorLogContext(error),
          }),
        ),
        Effect.repeat(Schedule.spaced(BOX_REMOVAL_INTERVAL)),
        Effect.catch((error: unknown) =>
          logEffect('error', 'server', 'box_removal_loop_failed', {
            ...errorLogContext(error),
          }),
        ),
        Effect.forkScoped,
      );

      yield* Effect.acquireRelease(
        // No context reset is needed here any more. Binding the listener inside a
        // fiber used to leak the ambient OpenTelemetry span into every later
        // request callback, because Bun hands each one the async context captured
        // at bind time. Nothing publishes a span into that context now, so there
        // is nothing for the listener to capture.
        Effect.sync(() =>
          app.listen({
            hostname: config.host,
            port: config.port,
          }),
        ),
        // Awaited: `stop()` drains in-flight requests, and anything still
        // finishing must complete before the scope's earlier resources release.
        (server) =>
          Effect.promise(async () => {
            // Stop stream admission and join their scoped cleanup before the
            // graceful listener drain waits for these otherwise unbounded bodies.
            await deviceEventsLifetime.stop();
            await server.stop();
          }),
      );

      yield* logEffect('info', 'server', 'server_started', {
        host: config.host,
        port: config.port,
      });

      const signal = yield* Effect.raceFirst(
        waitForProcessSignal(),
        Effect.raceFirst(
          Fiber.join(healthMonitorFiber),
          Effect.raceFirst(daemonControl.awaitCriticalFailure, coordination.awaitCriticalFailure),
        ),
      );
      yield* Effect.all(
        SERVER_HEALTH_COMPONENTS.map((component) =>
          health.markUnhealthy(component, 'server_shutdown'),
        ),
        { discard: true },
      );
      yield* logEffect('info', 'server', 'server_shutdown_started', { signal });
    }),
    // `withLogSpan` only stamps elapsed time onto log records, so it is safe on an
    // effect that runs until a shutdown signal. A *trace* span is not: this program
    // never returns, so `Effect.withSpan('server.runtime')` opened a span that never
    // ended and therefore never exported. That alone is reason enough, and
    // `scripts/check-span-lifetimes.ts` enforces it.
    //
    // It was also, historically, how 66,005 records over 12.7 hours landed in one
    // trace: the span stayed ambient in OpenTelemetry's global context and adopted
    // every request. That second failure mode is gone — nothing publishes into a
    // global context any more — but the first is intrinsic to an unbounded span.
    // Requests are rooted by their route span; background loops root per iteration.
  ).pipe(Effect.withLogSpan('server.runtime'));

  try {
    await serverRuntime.runPromise(serverProgram);
    await serverRuntime.dispose();
  } catch (error) {
    // Awaited through the runtime rather than fire-and-forget. `dispose()` below
    // flushes the OTLP exporter, so an unawaited log would race that flush and be
    // dropped on the one path where the reason for exiting matters most. The
    // fallback writes directly: `logger.error` would re-enter the export sink,
    // which is exactly what just failed.
    await runServerProgram(
      logEffect('error', 'server', 'server_fatal', errorLogContext(error)),
    ).catch(() => {
      writeMerkurLog({
        ts: new Date().toISOString(),
        level: 'error',
        scope: 'server',
        message: 'server_fatal',
        context: errorLogContext(error),
      });
    });
    await serverRuntime.dispose();
    process.exit(1);
  }
}

if (import.meta.main) await startServer(WEB_DIST_DIRECTORY);

export type App = ReturnType<typeof createServerApp>;
