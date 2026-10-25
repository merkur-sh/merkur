import { expect, test } from 'bun:test';
import { Context, Effect, Exit, Fiber, Option, Scope, SubscriptionRef, type Tracer } from 'effect';
import { TestClock } from 'effect/testing';
import type { DaemonConfig } from '../config';
import type { DaemonProofSigner } from '../services/daemon-proof-signer';
import { createDaemonTelemetryScoped } from './telemetry';

const config: DaemonConfig = {
  daemon_id: 'daemon-1',
  server_origin: 'https://merkur.example',
  daemon_identity_seal: {
    backend: 'software',
    material: Buffer.alloc(32, 1).toString('base64url'),
  },
  shell: '/bin/sh',
  webtransport_port: 44_433,
  session_token_verify_key: Buffer.alloc(2_592, 2).toString('base64url'),
  user_root_public_key: Buffer.alloc(2_592, 3).toString('base64url'),
  root_epoch: 1,
  daemon_binding: {
    userId: 'user-1',
    rootKeyCommitment: Buffer.alloc(64, 4).toString('base64url'),
    daemonId: 'daemon-1',
    daemonIdentityKeyCommitment: Buffer.alloc(64, 5).toString('base64url'),
    serverOrigin: 'https://merkur.example',
    linkClaimId: 'claim-1',
    issuedAt: 1,
    signature: Buffer.alloc(4_627, 7).toString('base64url'),
  },
  revoked_delegations: [],
};

function record(tracer: Tracer.Tracer, name: string): void {
  tracer
    .span({
      name,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      startTime: 0n,
      kind: 'internal',
      root: true,
      sampled: true,
    })
    .end(1n, Exit.void);
}

function harness() {
  const requests: Request[] = [];
  const bodies: string[] = [];
  let hold = false;
  let signatures = 0;
  const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
  const signer: DaemonProofSigner = {
    signEffect: () =>
      Effect.sync(() => {
        signatures += 1;
        return { mldsa: 'test-mldsa', p256: 'test-p256' };
      }),
  };
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      bodies.push(await request.text());
      signalStarted();
      if (hold) {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
          if (request.signal.aborted) reject(request.signal.reason);
        });
      }
      return new Response('{}');
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return {
    requests,
    bodies,
    started,
    signer,
    fetch,
    hold: () => {
      hold = true;
    },
    get signatures() {
      return signatures;
    },
  };
}

// Refusing an export still runs the OTLP exporter's bounded shutdown finalizer.
const closePeriod = (effect: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust('3 seconds');
    yield* Fiber.join(fiber);
  });

test('holds startup spans until consent, aborts off periods, and opens a fresh on period', async () => {
  const fake = harness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const telemetry = yield* createDaemonTelemetryScoped(config, fake.signer);
          expect(yield* SubscriptionRef.get(telemetry.enabled)).toBe(false);
          record(telemetry.tracer, 'held');
          yield* TestClock.adjust('5 seconds');
          expect(fake.requests).toHaveLength(0);
          expect(fake.signatures).toBe(0);

          yield* telemetry.set(true);
          yield* Effect.promise(() => fake.started);
          expect(fake.bodies[0]).toContain('held');
          expect(fake.requests[0]?.headers.has('x-merkur-daemon-id')).toBe(true);
          expect(fake.signatures).toBe(1);
          yield* telemetry.set(true);
          expect(yield* SubscriptionRef.get(telemetry.enabled)).toBe(true);

          yield* closePeriod(telemetry.set(false));
          record(telemetry.tracer, 'off');
          yield* TestClock.adjust('10 seconds');
          expect(fake.requests).toHaveLength(1);
          yield* telemetry.set(false);
          yield* telemetry.set(true);
          record(telemetry.tracer, 'new-period');
          yield* telemetry.retire;
          expect(fake.requests).toHaveLength(2);
          expect(fake.bodies[1]).toContain('new-period');
          expect(fake.bodies[1]).not.toContain('off');
          yield* telemetry.set(true);
          record(telemetry.tracer, 'retired');
          yield* TestClock.adjust('10 seconds');
          expect(fake.requests).toHaveLength(2);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('off aborts an in-flight export and discards the partial batch through scope close', async () => {
  const fake = harness();
  fake.hold();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.fork(yield* Scope.Scope);
          const telemetry = yield* createDaemonTelemetryScoped(config, fake.signer).pipe(
            Scope.provide(scope),
          );
          yield* telemetry.set(true);
          record(telemetry.tracer, 'in-flight');
          yield* TestClock.adjust('5 seconds');
          yield* Effect.promise(() => fake.started);
          record(telemetry.tracer, 'partial');
          const disable = yield* telemetry
            .set(false)
            .pipe(Effect.forkScoped({ startImmediately: true }));
          expect(fake.requests[0]?.signal.aborted).toBe(true);
          yield* TestClock.adjust('3 seconds');
          yield* Fiber.join(disable);
          record(telemetry.tracer, 'off');
          yield* Scope.close(scope, Exit.void);
          yield* TestClock.adjust('10 seconds');
          expect(fake.requests).toHaveLength(1);
          expect(fake.signatures).toBe(1);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const action of ['disable', 'retire'] as const) {
  test(`${action} while pending refuses held exports and the final flush`, async () => {
    const fake = harness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const telemetry = yield* createDaemonTelemetryScoped(config, fake.signer);
            record(telemetry.tracer, 'pending');
            yield* TestClock.adjust('5 seconds');
            record(telemetry.tracer, 'pending-partial');
            yield* closePeriod(action === 'disable' ? telemetry.set(false) : telemetry.retire);
            yield* TestClock.adjust('10 seconds');
            expect(fake.requests).toHaveLength(0);
            expect(fake.signatures).toBe(0);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
