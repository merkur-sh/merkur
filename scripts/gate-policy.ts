import { Glob } from 'bun';

import { DEFAULT_HOT_PATH_FILES } from './check-latency-boundaries';

export const STATIC_GATES: readonly string[] = [
  'check:types',
  'check:lint',
  'check:latency-boundaries',
  'check:span-lifetimes',
  'check:span-attributes',
  'check:dead',
  'check:ratchet',
  'check:slop',
  'check:docs',
];

export interface RuleEffects {
  /** Rows carrying no gate beyond `check:docs`: prose and agent-harness files. */
  readonly noGate?: true;
  /** Directory handed to `bun test`. */
  readonly bunTestDir?: string;
  /** Individual test files handed to `bun test`. */
  readonly bunTestFiles?: readonly string[];
  /** Crates for one `cargo test --locked -p …`; every Rust row also runs `rust:lint`. */
  readonly crates?: readonly string[];
  /** The dataplane tests that run the built image helper: `REAL_HELPER_LANE`. */
  readonly realHelper?: true;
  /** Scripts that compile Rust, run in the cargo lane after its `cargo test` runs. */
  readonly cargoScripts?: readonly string[];
  readonly rustLint?: true;
  /** Scripts run before everything else, in this order. */
  readonly builds?: readonly string[];
  readonly protocol?: true;
  readonly audit?: true;
  readonly e2e?: true;
  readonly allUnit?: true;
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

const TS_PACKAGES = [
  'auth',
  'config',
  'daemon-control-protocol',
  'keyboard',
  'logger',
  'protocol',
  'quicksilver',
  'shared',
  'user-agent',
] as const;

const RUST_PACKAGES: readonly (readonly [directory: string, crate: string])[] = [
  ['merkur-authorization', 'merkur-authorization'],
  ['merkur-client', 'merkur-client'],
  ['merkur-client-native', 'merkur-client-native'],
  ['merkur-codec', 'merkur-codec'],
  ['merkur-fec', 'merkur-fec'],
  ['merkur-graphics', 'merkur-graphics'],
  ['merkur-image-worker', 'merkur-image-worker'],
  ['merkur-identity-seal', 'merkur-identity-seal'],
  ['merkur-e2e', 'merkur-e2e'],
  ['merkur-edge-protocol', 'merkur-edge-protocol'],
  ['merkur-stun-protocol', 'merkur-stun-protocol'],
  ['merkur-wire', 'merkur-wire'],
  ['zstd-fixture', 'zstd-fixture'],
  ['alacritty-terminal-patch', 'alacritty_terminal'],
  ['vte-patch', 'vte'],
];

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

/** The browser transport cipher's wasm32 test run (`packages/merkur-e2e/src/wasm_chacha.rs`). */
const WASM_CIPHER_TESTS = 'test:wasm-cipher';

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
    name: 'web',
    globs: ['apps/web/**'],
    effects: { bunTestDir: 'apps/web' },
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
    name: 'server',
    globs: ['apps/server/**'],
    effects: { bunTestDir: 'apps/server' },
  },
  {
    name: 'server-redis',
    globs: ['apps/server/src/**/*.dragonfly.test.ts', ...REDIS_BACKED_SERVER_SOURCES],
    effects: { deferred: ['test:dragonfly'] },
    note: 'Each source has a `*.dragonfly.test.ts` twin and the pair is updated together, so a change to either side implicates the container run.',
  },
  {
    name: 'daemon',
    globs: ['apps/daemon/src/**', 'apps/daemon/*.ts'],
    effects: { bunTestDir: 'apps/daemon' },
  },
  {
    name: 'dataplane',
    globs: [`${DATAPLANE}/src/**`, `${DATAPLANE}/Cargo.toml`, `${DATAPLANE}/build.rs`],
    effects: { rustLint: true, crates: ['merkur-dataplane'] },
    note: 'The cargo run is filtered to the changed modules: a directory module selects its subtree, a root-level file selects by name, and `main.rs`, the manifest or the build script select the whole crate.',
  },
  {
    name: 'edge',
    globs: ['apps/edge/src/**', 'apps/edge/Cargo.toml'],
    effects: { rustLint: true, crates: ['merkur-edge'] },
  },
  {
    name: 'stun',
    globs: [
      'apps/stun/src/**',
      'apps/stun/Cargo.toml',
      'apps/server/src/services/stun-ticket-service.ts',
      'apps/server/src/services/stun-ticket-service.test.ts',
    ],
    effects: {
      rustLint: true,
      crates: ['merkur-stun'],
      bunTestFiles: ['apps/server/src/services/stun-ticket-service.test.ts'],
      deferred: ['test:natlab'],
    },
    note: 'The ticket format has two implementations pinned to one vector; nothing at runtime detects drift, so both suites run for a change on either side.',
  },
  {
    name: 'nat-traversal',
    globs: [`${DATAPLANE}/src/network/**`],
    effects: { deferred: ['test:natlab'] },
  },
  {
    name: 'site',
    globs: ['apps/site/**'],
    effects: { bunTestDir: 'apps/site', deferred: ['test:e2e:site'] },
    note: 'The pages are proven only as served: `test:e2e:site` builds them and the static server, then reads the headers, the markup without script, the waitlist and the analytics proxy in a browser.',
  },
  {
    name: 'tui',
    globs: ['apps/tui/**'],
    effects: { rustLint: true, crates: ['merkur-tui'], deferred: ['test:e2e:transport'] },
    note: 'The terminal client is proven only against a real splice: `tui-headless` drives the built binary in the transport phase.',
  },
  ...TS_PACKAGES.map(
    (name): Rule => ({
      name: `package-${name}`,
      globs: [`packages/${name}/**`],
      effects: { bunTestDir: `packages/${name}` },
    }),
  ),
  ...RUST_PACKAGES.map(
    ([directory, crate]): Rule => ({
      name: `crate-${directory}`,
      globs: [`packages/${directory}/**`],
      effects: { rustLint: true, crates: [crate] },
    }),
  ),
  {
    name: 'transport-patch-crates',
    globs: [
      'packages/wtransport-patch/**',
      'packages/quinn-patch/**',
      'packages/quinn-proto-patch/**',
    ],
    effects: { rustLint: true, crates: ['merkur-edge', 'merkur-dataplane'] },
    note: "Patch targets, not workspace members: they resolve through their dependents, so their dependents' suites are the test surface.",
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
    effects: { cargoScripts: ['test:sim'] },
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
    name: 'term-wasm',
    globs: [
      'packages/term-wasm/**',
      'packages/term-wasm-pgo/**',
      'packages/fontdue-patch/**',
      'scripts/term-wasm-pgo.ts',
    ],
    effects: {
      builds: ['build:wasm', 'sync:wasm'],
      rustLint: true,
      crates: ['term-wasm'],
      bunTestDir: 'apps/web',
    },
    note: 'WASM artifacts are hash-pinned; the build precedes any test, and `check:protocol` is what rejects stale provenance.',
  },
  {
    name: 'e2e-wasm-cipher',
    globs: ['packages/merkur-e2e/**', 'packages/e2e-wasm/.cargo/**'],
    effects: { cargoScripts: [WASM_CIPHER_TESTS] },
    note: 'The browser transport cipher compiles only for wasm32, so a native `cargo test` never reaches it; its vectors and differential run inside wasm32 under Node.',
  },
  {
    name: 'e2e-wasm',
    globs: ['packages/e2e-wasm/**'],
    effects: {
      builds: ['build:e2e-wasm'],
      rustLint: true,
      bunTestFiles: ['packages/e2e-wasm/conformance.test.ts'],
    },
  },
  {
    name: 'graphics-wasm',
    globs: ['packages/graphics-wasm/**', 'packages/merkur-graphics/src/tile.rs'],
    effects: {
      builds: ['build:graphics-wasm'],
      rustLint: true,
      crates: ['graphics-wasm'],
      bunTestFiles: ['packages/graphics-wasm/conformance.test.ts'],
    },
  },
  {
    name: 'graphics-codec-probe',
    globs: ['packages/graphics-codec-probe/**'],
    effects: {
      builds: ['build:graphics-codec-probe'],
      rustLint: true,
      crates: ['graphics-codec-probe'],
    },
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
    effects: {
      builds: ['build:image-worker'],
      realHelper: true,
      deferred: ['test:graphics:long'],
    },
    note: 'Decoded images exist only in the sandboxed helper, which a dataplane test run does not build: the helper is built first, then the `real_helper` modules run against it. Those modules drive the display simulator through the connection, session, network and crate-root code as well as the graphics owner, so every dataplane change selects them. The 64-seed convergence runs spread their seeds across cores; the Kitty one is bound by the kernel launching sandboxed helpers.',
  },
  {
    name: 'scripts',
    globs: ['scripts/**'],
    exclude: ['scripts/natlab/**'],
    effects: { bunTestDir: 'scripts' },
    note: 'Selected tests whose import closure includes `scripts/perf/client-session-fixture.ts` prepare the source-and-binary SHA-256-pinned native session oracle once with `bun run scripts/prepare-client-session-oracle.ts` before the parallel Rust and Bun lanes; benchmark tests never invoke Cargo.',
  },
  {
    name: 'anti-slop-rules',
    globs: ['biome.slop.json', 'tools/biome/slop/**'],
    effects: { bunTestFiles: ['scripts/check-slop.test.ts'] },
    note: 'A rule is GritQL only Biome can judge: `tools/biome/slop/cases.json` holds what each rule reports, and the test runs every case through the invocation the gate uses.',
  },
  {
    name: 'rust-lint-ratchet',
    globs: [
      'scripts/rust-lint.ts',
      'scripts/lint-ratchet.ts',
      'lint-baselines/clippy.json',
      'clippy.toml',
    ],
    effects: {
      rustLint: true,
      bunTestFiles: ['scripts/rust-lint.test.ts', 'scripts/lint-ratchet.test.ts'],
    },
    note: "What `rust:lint` answers with besides the Rust sources: the script that sorts Clippy's findings into classes, the ratchet it holds them to, the baseline, and Clippy's configuration. The tests cover the sorting and the comparison; only a Clippy run proves the workspace still meets them.",
  },
  {
    name: 'tests',
    globs: ['tests/**'],
    exclude: ['tests/e2e/**/*.e2e.ts'],
    effects: { bunTestDir: 'tests' },
  },
  {
    name: 'e2e-specs',
    globs: ['tests/e2e/**/*.e2e.ts', 'playwright*.config.mjs'],
    effects: { e2e: true },
    note: 'Select the spec’s owning Playwright configuration, including calibrated rebind/reorder runs.',
  },
  {
    name: 'e2e-fixtures',
    globs: ['tests/e2e/**/*.ts'],
    exclude: ['tests/e2e/**/*.e2e.ts', '**/*.test.ts'],
    effects: {
      deferred: ['test:e2e', 'test:e2e:transport', 'test:e2e:rebind', 'test:e2e:transport:reorder'],
    },
    note: 'Shared fixture changes require their real browser consumers, as well as fixture unit tests.',
  },
  {
    name: 'verification-infrastructure',
    globs: [
      'bunfig.toml',
      'scripts/test-preload.ts',
      'scripts/test-inventory*.ts',
      'scripts/select-gates*.ts',
      'scripts/gate-policy*.ts',
      'scripts/verification-executor*.ts',
      'scripts/verification-cargo*.ts',
      'scripts/verification-junit*.ts',
      'scripts/verification-cache*.ts',
      'scripts/run-unit-tests.ts',
      'scripts/run-verify.ts',
      'scripts/run-rust-tests.ts',
      'scripts/check-current-protocol.ts',
      'scripts/protocol-gates.ts',
    ],
    effects: { allUnit: true },
    note: 'Runner, inventory and isolation changes must prove the complete source inventory.',
  },
  {
    name: 'bazel-infrastructure',
    globs: [
      '.bazelrc',
      '.bazelversion',
      '.bazelignore',
      'MODULE.bazel',
      'MODULE.bazel.lock',
      'REPO.bazel',
      '**/BUILD.bazel',
      'BUILD.bazel',
      '**/*.bzl',
      'tools/bazel/**',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ],
    effects: { allUnit: true, rustLint: true },
    note: 'Build graph, toolchain, package resolution and verification changes prove every source test and the complete Rust compilation scope.',
  },
  {
    name: 'dependencies',
    globs: ['package.json', '**/package.json', 'bun.lock'],
    effects: { audit: true },
  },
  {
    name: 'cargo-workspace',
    globs: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'],
    effects: { rustLint: true },
    note: 'A workspace manifest or lockfile change recompiles every crate; `rust:lint` is the gate that proves the workspace still builds with no warning outside its baseline.',
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
    effects: { protocol: true, deferred: ['test:e2e:transport'] },
    note: "Wire format, channel ids, IPC frames, crypto bootstrap and daemon config: every side of a contract, plus the daemon's IPC surface and config, which are protocol changes even when nothing under `packages/protocol` moved.",
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
