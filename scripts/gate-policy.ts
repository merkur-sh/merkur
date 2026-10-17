import { Glob } from 'bun';

import { DEFAULT_HOT_PATH_FILES } from './check-latency-boundaries';

/**
 * What a change earns beyond `bazel test //...`, which runs every unit test and static gate and
 * skips the ones whose inputs it already proved: the gates that are not Bazel tests, and the
 * browser, container and proof suites that take minutes.
 */
export interface RuleEffects {
  /** Rows carrying no gate beyond `check:docs`: prose and agent-harness files. */
  readonly noGate?: true;
  /** `rust:lint`: Clippy's findings held to their baseline. */
  readonly rustLint?: true;
  /** Scripts that run with the gates. */
  readonly scripts?: readonly string[];
  /** `check:audit` and `check:js-dependency-policy`. */
  readonly audit?: true;
  /** The changed spec's owning Playwright suite. */
  readonly e2e?: true;
  /** Scripts that take minutes; printed for the operator, run only with `--all`. */
  readonly deferred?: readonly string[];
}

/**
 * A named set of globs. It matches exactly like listing its members inline; the label is
 * what the generated table prints in their place, so a list the repo already owns (the
 * enforced hot-path list) reads as one phrase instead of forty paths.
 */
export interface GlobGroup {
  readonly label: string;
  readonly globs: readonly string[];
}

export interface Rule {
  readonly name: string;
  readonly globs: readonly (string | GlobGroup)[];
  readonly exclude?: readonly string[];
  readonly effects: RuleEffects;
  /** Why the row runs what it runs; rendered into the generated table's last column. */
  readonly note?: string;
}

const TEST_FILE_GLOBS = ['**/*.test.ts', '**/*.test.tsx'] as const;

/** Server services with a `*.dragonfly.test.ts` twin. */
const REDIS_BACKED_SERVER_SOURCES = [
  'apps/server/src/http/daemon-request-auth.ts',
  'apps/server/src/services/auth-flow-store.ts',
  'apps/server/src/services/browser-session-presence.ts',
  'apps/server/src/services/daemon-control-service.ts',
  'apps/server/src/services/edge-registry-service.ts',
  'apps/server/src/services/rate-limit-service.ts',
  'apps/server/src/services/realtime-coordination-service.ts',
  'apps/server/src/services/session-issuance-service.ts',
  'apps/server/src/services/redis-*.ts',
] as const;

const DATAPLANE = 'apps/daemon/dataplane';

/** The verification table, one entry per prose row, matched against repo-relative paths. */
export const RULES: readonly Rule[] = [
  {
    name: 'docs',
    globs: [
      '**/*.md',
      '**/*.mdx',
      'docs/**',
      '.claude/**',
      '.codex/**',
      '.agents/**',
      'LICENSE',
      '.gitignore',
      '.worktreeinclude',
    ],
    effects: { noGate: true },
  },
  {
    name: 'rust',
    globs: [
      '**/*.rs',
      '**/Cargo.toml',
      'Cargo.lock',
      'rust-toolchain.toml',
      'clippy.toml',
      'lint-baselines/clippy.json',
      'scripts/rust-lint.ts',
      'scripts/lint-ratchet.ts',
      'MODULE.bazel',
      'MODULE.bazel.lock',
      '.bazelrc',
      '**/BUILD.bazel',
      '**/*.bzl',
    ],
    effects: { rustLint: true },
    note: 'Clippy runs as a Bazel aspect, cached per crate; `rust:lint` sorts its findings into classes and holds them to the baseline, so a Rust source, manifest, build-graph or lint-configuration change earns it.',
  },
  {
    name: 'web-hot-path',
    globs: [
      { label: 'the `check:latency-boundaries` hot-path list', globs: DEFAULT_HOT_PATH_FILES },
      'apps/web/src/terminal/**',
      'apps/web/src/transport/**',
      'apps/web/src/perf/**',
      'apps/web/src/*-worker.ts',
      'apps/web/src/*-worker-client.ts',
      'apps/web/src/*-worker-protocol.ts',
      'apps/web/src/renderer-webgpu.ts',
      'apps/web/src/terminal-renderer.ts',
      'apps/web/src/wasm-loader.ts',
    ],
    exclude: TEST_FILE_GLOBS,
    effects: { deferred: ['test:e2e:latency'] },
    note: 'The browser hot path: the enforced latency-boundary list plus the directories the worker, prediction, display and render code lives in. A test file under those directories is not the render path; it does not earn the edge harness.',
  },
  {
    name: 'server-redis',
    globs: ['apps/server/src/**/*.dragonfly.test.ts', ...REDIS_BACKED_SERVER_SOURCES],
    effects: { deferred: ['test:dragonfly'] },
    note: 'Each source has a `*.dragonfly.test.ts` twin and the pair is updated together, so a change to either side implicates the container run.',
  },
  {
    name: 'nat-traversal',
    globs: [
      `${DATAPLANE}/src/network/**`,
      'apps/stun/src/**',
      'apps/stun/Cargo.toml',
      'apps/server/src/services/stun-ticket-service.ts',
      'apps/server/src/services/stun-ticket-service.test.ts',
    ],
    effects: { deferred: ['test:natlab'] },
    note: "The ticket format has two implementations pinned to one vector, and NAT traversal is proven only across the lab's real NATs.",
  },
  {
    name: 'site',
    globs: ['apps/site/**'],
    effects: { deferred: ['test:e2e:site'] },
    note: 'The pages are proven only as served: `test:e2e:site` builds them and the static server, then reads the headers, the markup without script, the waitlist and the analytics proxy in a browser.',
  },
  {
    name: 'tui',
    globs: ['apps/tui/**'],
    effects: { deferred: ['test:e2e:transport'] },
    note: 'The terminal client is proven only against a real splice: `tui-headless` drives the built binary in the transport phase.',
  },
  {
    name: 'simulator',
    globs: [
      'tools/sim/**',
      'scripts/sim-tests.ts',
      'scripts/generated-cargo-workspace.ts',
      `${DATAPLANE}/src/**`,
      `${DATAPLANE}/Cargo.toml`,
      'apps/edge/src/**',
      'apps/edge/Cargo.toml',
      'packages/merkur-client/**',
      'packages/merkur-client-native/**',
      'packages/wtransport-patch/**',
      'packages/quinn-patch/**',
      'packages/quinn-proto-patch/**',
    ],
    exclude: ['**/*.md'],
    effects: { scripts: ['test:sim'] },
    note: 'The real client, edge and dataplane run whole sessions in one deterministic simulation (`tools/sim`); a change to any of them, or to the simulator, replays every scenario and its seeds.',
  },
  {
    name: 'bounded-proofs',
    globs: [
      'tools/bolero/**',
      'scripts/fuzz-tests.ts',
      'packages/merkur-wire/**',
      'packages/merkur-codec/**',
      'packages/merkur-client/**',
      'packages/merkur-e2e/**',
    ],
    exclude: ['**/*.md'],
    effects: { deferred: ['test:fuzz:kani'] },
    note: 'The crates the Kani proofs compile, and their runner. The rebind keeper proof stubs `merkur-e2e` functions by signature, so a change anywhere in that crate can break it.',
  },
  {
    name: 'real-helper',
    globs: [
      'packages/merkur-image-worker/**',
      'packages/merkur-graphics/**',
      'packages/merkur-codec/**',
      `${DATAPLANE}/src/**`,
      `${DATAPLANE}/Cargo.toml`,
      `${DATAPLANE}/build.rs`,
      'Cargo.lock',
    ],
    effects: { deferred: ['test:graphics:long'] },
    note: 'The 64-seed convergence runs spread their seeds across cores; the Kitty one is bound by the kernel launching sandboxed helpers.',
  },
  {
    name: 'e2e-specs',
    globs: ['tests/e2e/**/*.e2e.ts', 'playwright*.config.mjs'],
    effects: { e2e: true },
    note: 'Select the spec’s owning Playwright configuration, including calibrated rebind/reorder runs.',
  },
  {
    name: 'e2e-fixtures',
    globs: ['tests/e2e/**/*.ts', 'scripts/native-artifacts.ts'],
    exclude: ['tests/e2e/**/*.e2e.ts', '**/*.test.ts'],
    effects: {
      deferred: ['test:e2e', 'test:e2e:transport', 'test:e2e:rebind', 'test:e2e:transport:reorder'],
    },
    note: 'Shared fixture changes require their real browser consumers, as well as fixture unit tests.',
  },
  {
    name: 'dependencies',
    globs: ['package.json', '**/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    effects: { audit: true },
  },
  {
    name: 'protocol',
    globs: [
      'packages/protocol/**',
      'packages/daemon-control-protocol/**',
      'packages/merkur-codec/**',
      'packages/merkur-e2e/**',
      'packages/merkur-authorization/**',
      'packages/merkur-identity-seal/**',
      'packages/merkur-wire/**',
      'packages/merkur-edge-protocol/**',
      'packages/merkur-client/**',
      'packages/merkur-client-native/**',
      'packages/e2e-wasm/**',
      'packages/term-wasm/**',
      'packages/merkur-stun-protocol/**',
      'packages/shared/src/transport*.ts',
      'packages/shared/src/display-stream*.ts',
      'packages/shared/src/ipc*.ts',
      'packages/shared/src/edge-*.ts',
      'packages/shared/src/signaling/**',
      'packages/shared/src/terminal.ts',
      'packages/auth/src/session-authorization*.ts',
      'packages/config/src/reconnect-policy*.ts',
      `${DATAPLANE}/src/ipc/**`,
      `${DATAPLANE}/src/session/**`,
      `${DATAPLANE}/src/network/**`,
      `${DATAPLANE}/src/webtransport/**`,
      `${DATAPLANE}/src/auth.rs`,
      `${DATAPLANE}/src/connection.rs`,
      `${DATAPLANE}/src/edge_tunnel.rs`,
      `${DATAPLANE}/src/transport.rs`,
      `${DATAPLANE}/src/wt_upgrade.rs`,
      `${DATAPLANE}/src/display/wire.rs`,
      'apps/daemon/src/config.ts',
      'apps/daemon/src/services/dataplane-client*.ts',
      'apps/edge/src/**',
      'apps/server/src/http/routes/edge-routes*.ts',
      'apps/server/src/http/routes/session-routes*.ts',
      'apps/server/src/services/edge-registry-service*.ts',
      'apps/web/src/session/**',
      'apps/web/src/transport/**',
      'apps/web/src/lib/webtransport*.ts',
    ],
    effects: { deferred: ['test:e2e:transport'] },
    note: "Wire format, channel ids, IPC frames, crypto bootstrap and daemon config: every side of a contract, plus the daemon's IPC surface and config, which are protocol changes even when nothing under `packages/protocol` moved. `bazel test //...` holds every contract test; only the edge harness proves a live session.",
  },
  {
    name: 'transport-e2e',
    globs: [
      `${DATAPLANE}/src/display/**`,
      `${DATAPLANE}/src/input.rs`,
      `${DATAPLANE}/src/pty/**`,
      'apps/web/src/terminal/display-*.ts',
      'apps/web/src/terminal-worker.ts',
      'apps/web/src/transport-worker.ts',
      'packages/shared/src/transport-policy.ts',
      'scripts/run-edge-harness.ts',
    ],
    exclude: TEST_FILE_GLOBS,
    effects: { deferred: ['test:e2e:transport'] },
    note: 'Display scheduling, mirroring and transport policy are not wire changes, but the edge harness is the only gate that exercises them against a real splice.',
  },
  {
    name: 'rebind',
    globs: [
      `${DATAPLANE}/src/session/rebind_flow.rs`,
      `${DATAPLANE}/src/session/policy.rs`,
      `${DATAPLANE}/src/session/resume.rs`,
      `${DATAPLANE}/src/edge_tunnel.rs`,
      'apps/edge/src/splice.rs',
      'apps/edge/src/relay.rs',
      'packages/merkur-e2e/src/rebind.rs',
      'packages/config/src/reconnect-policy.ts',
      'packages/merkur-client/src/session*.rs',
      'apps/web/src/session/session-state.ts',
      'apps/web/src/transport/browser-client-session.ts',
      'apps/web/src/transport/client-carrier.ts',
      'apps/web/src/session/wake-detector.ts',
      'tests/e2e/carrier-rebind.e2e.ts',
      'packages/merkur-client/**',
      'packages/merkur-client-native/**',
      'apps/tui/**',
      'tests/e2e/tui-rebind.e2e.ts',
      'tests/e2e/fixtures/headless-client.ts',
    ],
    effects: { deferred: ['test:e2e:rebind'] },
  },
];

const compiledGlobs = new Map<string, Glob>();

export function gatePathMatches(pattern: string, file: string): boolean {
  let glob = compiledGlobs.get(pattern);
  if (glob === undefined) {
    glob = new Glob(pattern);
    compiledGlobs.set(pattern, glob);
  }
  return glob.match(file);
}

/** A rule's globs with every group expanded to its members. */
export function ruleGlobs(rule: Rule): string[] {
  return rule.globs.flatMap((entry) => (typeof entry === 'string' ? [entry] : [...entry.globs]));
}

export function ruleMatches(rule: Rule, file: string): boolean {
  if (!ruleGlobs(rule).some((pattern) => gatePathMatches(pattern, file))) {
    return false;
  }
  return !(rule.exclude ?? []).some((pattern) => gatePathMatches(pattern, file));
}
