import { treaty } from '@elysia/eden';
import type { App } from '@merkur/server';
import { Effect, type Scope } from 'effect';
import type { DaemonConfig } from '../config';
import type { Logger } from '../logger';
import {
  type BellReportScheduler,
  type BellReportSender,
  createBellReportSchedulerScoped,
} from './bell-report-scheduler';
import { createDaemonFetch } from './daemon-fetch';
import type { DaemonProofSigner } from './daemon-proof-signer';

const REPORT_MIN_INTERVAL_MS = 1_000;

export interface TerminalBellReporter extends BellReportScheduler {}

export function createTerminalBellReporterScoped(
  config: DaemonConfig,
  logger: Logger,
  signer: DaemonProofSigner,
): Effect.Effect<TerminalBellReporter, never, Scope.Scope> {
  return createBellReportSchedulerScoped(
    createBellSender(config, logger, signer),
    REPORT_MIN_INTERVAL_MS,
  );
}

function createBellSender(
  config: DaemonConfig,
  logger: Logger,
  signer: DaemonProofSigner,
): BellReportSender {
  const api = treaty<App>(config.server_origin, { fetcher: createDaemonFetch(config, signer) });
  const postBell = (occurredAt: number, signal: AbortSignal) =>
    api.api.daemon['terminal-bell'].post(
      { occurredAt },
      {
        fetch: { signal },
      },
    );
  type BellPostResponse = Awaited<ReturnType<typeof postBell>>;
  type BellPostResult =
    | { readonly _tag: 'Response'; readonly response: BellPostResponse }
    | { readonly _tag: 'TransportError'; readonly error: unknown };

  return (occurredAt) =>
    Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.callback<BellPostResult>((resume) => {
          try {
            void postBell(occurredAt, controller.signal).then(
              (response) => resume(Effect.succeed({ _tag: 'Response', response })),
              (error) => resume(Effect.succeed({ _tag: 'TransportError', error })),
            );
          } catch (error) {
            resume(Effect.succeed({ _tag: 'TransportError', error }));
          }
        }),
      // The AbortController is an Effect resource, so every completion path
      // (including deadline and daemon-scope interruption) aborts the request.
      (controller) => Effect.sync(() => controller.abort()),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result._tag === 'TransportError') {
            logger.warn('terminal_bell_report_error', {
              error: String(result.error),
            });
          } else if (result.response.error !== null) {
            logger.warn('terminal_bell_report_failed', {
              status: result.response.error.status,
            });
          }
        }),
      ),
      Effect.asVoid,
    );
}
