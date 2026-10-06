---
paths:
  - "**/*.test.ts"
  - "tests/**"
---

# Tests

- Run Effect programs with `Effect.runPromise` at the test boundary. Fake services with
  `Layer.succeed`; wrap resource/finalizer layers in `Effect.scoped`. Config tests use
  `ConfigProvider.fromUnknown` + `ConfigProvider.layer` rather than mutating the process
  environment.
- For retry, scheduling, SSE, heartbeat, or reconnect code, keep tests bounded and
  interrupt forked fibers; no infinite stream or loop outlives a test.
- Redis-backed services keep both a fake-backed unit test and a `*.dragonfly.test.ts`;
  update the pair together.
- Add or update tests when changing auth flows, Redis presence claims, session lifecycle,
  route error mapping, daemon config validation, protocol encoding, display ACK/resync,
  or transport fallback.
- One `bun test` process, many paths; split only for files calling `mock.module`, which
  is process-global.
- A deadline is asserted in virtual time, never waited out. Plain code: `jest.useFakeTimers()`
  from `bun:test` replaces `setTimeout`, `Bun.sleep`, `Date.now`, `performance.now` and
  `Bun.nanoseconds` while real sockets keep working; advance to the production value and
  restore with `jest.useRealTimers()` in `finally`. Effect code: `TestClock`, when the sleep is
  registered before `adjust` runs. When a fake also reads `Date.now`, or the sleep sits behind
  promises, use the fake timers instead: `Effect.sleep` is a `setTimeout` and the scheduler
  yields on `setImmediate`, so advance a millisecond per `Effect.yieldNow` until the fiber
  settles (`elapse` in `realtime-coordination-service.test.ts`).
- A stand-in executable is `linkTestExecutable` (`scripts/test-executables.ts`), never a
  freshly written file: macOS assesses each new executable on its first run (0.3–0.6 s, one
  system daemon for every worker). Pass per-test paths through the environment so the bytes
  stay shared.
- No synchronous spawn runs in a test worker, in the test or in the code it calls: run a
  child with `runTestProcess` (`scripts/test-process.ts`), and make the function under test
  await its own. `Bun.spawnSync`, `execFileSync` and `execSync` can lose the child's exit and
  spin forever, or fail every later one in the worker (oven-sh/bun#34069), so the test
  preload replaces them with a function that throws. A library that spawns synchronously is
  given what it would have asked for (Playwright's `request.newContext({ userAgent })`).
- An e2e worker's daemon, PTY and shell outlive every spec that uses them, so a spec
  inherits the prompt, modes and screen an earlier one left: `terminal-cursor-motion` leaves
  a `PS1` that opens an `OSC 133;B` editor boundary at every prompt. Count from a baseline
  read after the spec's own setup, and wait on a signal only that setup produces
  (`merkur-tui headless` reports `input.sent`, `input.covered` and `prediction.armed`), never
  on a state the inherited prompt may already satisfy.
- `createLifecycleClock().until` moves the clock to each deadline; do not advance by a
  computed distance, which a fractional (jittered) deadline can miss by one float step.
