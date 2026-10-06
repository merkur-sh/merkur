import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCriterionMetrics } from './perf/criterion';
import {
  aggregateMetrics,
  compareProfileReports,
  findVarianceViolations,
  isProfileReport,
  type MetricComparison,
  type MetricSummary,
  PERF_REPORT_SCHEMA_VERSION,
  type ProcessMetricPolicy,
  type ProfileReport,
  type ProfileRun,
  runProfileCommand,
  summarizeSamples,
  type WorkloadFidelity,
  type WorkloadReport,
} from './perf/harness';
import {
  assertDistinctReportFiles,
  atomicWriteText,
  prepareProfilerArtifacts,
  validateProfilerArtifacts,
} from './perf/report-io';

export type ProfileMode = 'micro' | 'services' | 'full' | 'soak';
export type WorkloadKind = 'benchmark' | 'verification';
export type WorkloadMetricParser = 'criterion';

export interface WorkloadSpec {
  readonly service: string;
  readonly name: string;
  readonly fidelity: WorkloadFidelity;
  readonly processMetrics?: ProcessMetricPolicy;
  readonly kind: WorkloadKind;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly quickEnv?: Readonly<Record<string, string>>;
  readonly requireMetrics?: boolean;
  readonly repetitions?: number;
  readonly warmups?: number;
  readonly metricParser?: WorkloadMetricParser;
}

export interface ProfileOptions {
  readonly mode: ProfileMode;
  readonly workloadSelectors: readonly string[];
  readonly repetitions: number;
  readonly warmups: number;
  readonly verificationRepetitions: number;
  readonly outputPath: string;
  readonly baselinePath: string | null;
  readonly allowedRegressionRatio: number;
  readonly varianceLimit: number;
  readonly strictVariance: boolean;
  readonly cpuProfile: boolean;
  readonly heapProfile: boolean;
  readonly list: boolean;
}

const ROOT = path.resolve(import.meta.dir, '..');
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'test-results', 'profile', 'latest.json');
const BENCHMARK_OUTPUT_LIMIT_BYTES = 512 * 1024;
const VERIFICATION_OUTPUT_LIMIT_BYTES = 256 * 1024;
const SANITIZED_ENVIRONMENT_POLICY = 'sanitized-v1' as const;
const SANITIZED_PERFORMANCE_ENVIRONMENT_KEYS = new Set([
  'CC',
  'CFLAGS',
  'CXX',
  'CXXFLAGS',
  'CARGO_ENCODED_RUSTFLAGS',
  'LDFLAGS',
  'LLVM_PROFILE_FILE',
  'MALLOC_ARENA_MAX',
  'MALLOC_CONF',
  'MACOSX_DEPLOYMENT_TARGET',
  'NODE_OPTIONS',
  'RAYON_NUM_THREADS',
  'RUSTC_WRAPPER',
  'RUSTC_WORKSPACE_WRAPPER',
  'RUSTDOCFLAGS',
  'RUSTFLAGS',
  'RUST_MIN_STACK',
  'RUSTUP_TOOLCHAIN',
  'TOKIO_WORKER_THREADS',
]);
const SANITIZED_PERFORMANCE_ENVIRONMENT_PREFIXES = [
  'BENCH_',
  'BUN_JSC_',
  'CARGO_BUILD_',
  'CARGO_INCREMENTAL',
  'CARGO_PROFILE_',
  'CARGO_TARGET_',
] as const;

const BENCHMARKS: readonly WorkloadSpec[] = [
  {
    service: 'server',
    name: 'user-agent',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-user-agent.ts'],
    timeoutMs: 30_000,
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'session-crypto-startup',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-session-crypto-startup.ts'],
    timeoutMs: 30_000,
    quickEnv: { BENCH_SAMPLES: '100' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'startup-font-assets',
    fidelity: 'production',
    processMetrics: 'diagnostic',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-web-startup-assets.ts'],
    timeoutMs: 60_000,
    repetitions: 1,
    warmups: 0,
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'wasm-font-initialization',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-wasm-font-init.ts'],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '100' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'wasm-font-style-upgrade',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-wasm-font-style-upgrade.ts'],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '20', BENCH_WARMUPS: '2' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'shadow-terminal-prediction',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-shadow-terminal.ts'],
    timeoutMs: 120_000,
    quickEnv: {
      BENCH_SAMPLES: '100',
      BENCH_ACTIONS_PER_SAMPLE: '100',
      BENCH_PROJECTIONS_PER_SAMPLE: '20',
      BENCH_UNCHANGED_BUILDS_PER_SAMPLE: '500',
    },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'webgpu-renderer-initialization',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-webgpu-renderer-init.ts'],
    timeoutMs: 150_000,
    quickEnv: { BENCH_SAMPLES: '10', BENCH_WARMUPS: '2', BENCH_INITS_PER_SAMPLE: '1' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'retained-wire-payload-pool',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-retained-wire-payload-pool.ts'],
    timeoutMs: 60_000,
    quickEnv: {
      BENCH_SAMPLES: '20',
      BENCH_WARMUPS: '5',
      BENCH_ITERATIONS: '20000',
    },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'webgpu-renderer-render',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-webgpu-renderer-render.ts'],
    timeoutMs: 150_000,
    quickEnv: { BENCH_SAMPLES: '10', BENCH_WARMUPS: '2', BENCH_FRAMES_PER_SAMPLE: '10' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'terminal-row-layout-component',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-terminal-row-layout.ts'],
    timeoutMs: 180_000,
    quickEnv: { ROW_LAYOUT_SAMPLES: '12' },
    repetitions: 1,
    warmups: 0,
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'webgpu-terminal-component',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-webgpu-terminal.ts'],
    timeoutMs: 480_000,
    quickEnv: { GPU_EXPERIMENT_DURATION_MS: '1000' },
    repetitions: 1,
    warmups: 0,
    requireMetrics: true,
  },
  {
    service: 'server',
    name: 'session-issuance-redis-transitions',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/run-session-issuance-benchmark.ts'],
    timeoutMs: 120_000,
    quickEnv: {
      BENCH_ITERATIONS: '500',
      BENCH_WARMUP_ITERATIONS: '50',
    },
    repetitions: 3,
    warmups: 0,
    requireMetrics: true,
  },
  {
    service: 'server',
    name: 'auth-continue-rate-limit',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/run-auth-continue-rate-limit-benchmark.ts'],
    timeoutMs: 120_000,
    quickEnv: {
      BENCH_ITERATIONS: '500',
      BENCH_WARMUP_ITERATIONS: '50',
    },
    repetitions: 3,
    warmups: 0,
    requireMetrics: true,
  },
  {
    service: 'server',
    name: 'session-start-acknowledged-dispatch',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/run-session-start-benchmark.ts'],
    timeoutMs: 120_000,
    quickEnv: {
      BENCH_ITERATIONS: '500',
      BENCH_WARMUP_ITERATIONS: '50',
    },
    // Each run emits hundreds of acknowledged dispatch samples. Independent
    // containers expose lifecycle/readiness variance without conflating it
    // with the structured local-owner control-path latency metrics.
    repetitions: 3,
    warmups: 0,
    requireMetrics: true,
  },
  {
    service: 'daemon',
    name: 'update-download-memory',
    fidelity: 'production',
    processMetrics: 'diagnostic',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-daemon-update-download.ts', 'memory'],
    timeoutMs: 120_000,
    quickEnv: { BENCH_UPDATE_BYTES: '16777216' },
    repetitions: 3,
    warmups: 1,
    requireMetrics: true,
  },
  {
    service: 'daemon',
    name: 'update-download-stream',
    fidelity: 'production',
    processMetrics: 'diagnostic',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-daemon-update-download.ts', 'stream'],
    timeoutMs: 120_000,
    quickEnv: { BENCH_UPDATE_BYTES: '16777216' },
    repetitions: 3,
    warmups: 1,
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'display-production-pipeline',
    fidelity: 'production',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'display::send::tests::production_display_pipeline_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '30' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'display-single-pass-row-encoding',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'display::send::tests::production_single_pass_row_encoding_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '100' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'display-compression-planner-surface',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'display::compressor::tests::production_compression_planner_surface_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '100' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'display-peer-map-access',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'display::send::tests::production_peer_map_access_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '30', BENCH_BATCH_SIZE: '256' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'reliable-stream-reader',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'network::peer::tests::production_reliable_stream_reader_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '30', BENCH_BATCH_SIZE: '128' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'inbound-terminal-open',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'connection::tests::production_inbound_open_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '20', BENCH_BATCH_SIZE: '128' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'session-auth-owner-loop',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'session::auth_flow::tests::production_session_auth_owner_loop_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '20' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    // Offer construction runs inline on the owner loop, so it is charged to
    // every attached peer's keystroke-to-paint. Swept by candidate count
    // because the thing that grows here is the candidate set, not the code.
    name: 'webtransport-offer-build',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'webtransport::lifecycle_tests::production_webtransport_offer_build_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '20' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'edge-reliable-ingress',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'edge_tunnel::tests::production_reliable_ingress_staging_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '200' },
    requireMetrics: true,
  },
  {
    service: 'dataplane',
    name: 'edge-reliable-writer',
    fidelity: 'component',
    kind: 'benchmark',
    command: [
      'cargo',
      'test',
      '--release',
      '--locked',
      '-p',
      'merkur-dataplane',
      'edge_tunnel::tests::production_reliable_writer_benchmark',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '50', BENCH_BATCH_SIZE: '256' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'worker-display-row-scan',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-worker-apply.ts'],
    timeoutMs: 30_000,
    quickEnv: { BENCH_SAMPLES: '1000', BENCH_BATCH_SIZE: '250' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'browser-display-production-pipeline',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-browser-display-pipeline.ts'],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '100', BENCH_WARMUPS: '20' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'browser-display-zstd-one-row',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-browser-display-pipeline.ts', 'compressed-one-row'],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '100', BENCH_WARMUPS: '20' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'terminal-render-readers',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-terminal-render-readers.ts'],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '10', BENCH_WARMUPS: '2', BENCH_ITERATIONS: '10000' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'terminal-wasm-multichunk-apply',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-term-wasm-multichunk.ts'],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '20', BENCH_WARMUPS: '5', BENCH_CHUNKS: '4' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'input-ring-outbox',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-input-ring.ts'],
    timeoutMs: 30_000,
    quickEnv: { BENCH_SAMPLES: '1000', BENCH_BATCH_SIZE: '128', BENCH_WARMUPS: '100' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'input-send-path',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-input-send-path.ts'],
    timeoutMs: 60_000,
    quickEnv: { BENCH_KEYSTROKES: '128', BENCH_SAMPLES: '5', BENCH_WARMUPS: '2' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'virtual-keyboard-input',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-keyboard.ts'],
    timeoutMs: 30_000,
    quickEnv: {
      BENCH_SAMPLES: '100',
      BENCH_BATCH_SIZE: '512',
      BENCH_WARMUPS: '20',
      BENCH_GEOMETRY_SAMPLES: '20',
      BENCH_GEOMETRIES_PER_SAMPLE: '4',
    },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'display-ack-ring',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-display-ack-drain.ts'],
    timeoutMs: 30_000,
    quickEnv: { BENCH_SAMPLES: '1000', BENCH_BATCH_SIZE: '64', BENCH_WARMUPS: '100' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'owned-scheduled-callback',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-web-display-owned-callback.ts'],
    timeoutMs: 60_000,
    quickEnv: { BENCH_TIMING_SAMPLES: '20', BENCH_TIMING_OPS: '5000', BENCH_WARMUPS: '10' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'refresh-estimator-reads',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-web-display-refresh-estimator.ts'],
    timeoutMs: 60_000,
    quickEnv: { BENCH_TIMING_SAMPLES: '20', BENCH_TIMING_OPS: '2000', BENCH_WARMUPS: '5' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'perf-ring-drain',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-web-display-perf-ring-drain.ts'],
    timeoutMs: 120_000,
    quickEnv: { BENCH_TIMING_SAMPLES: '20', BENCH_ALLOCATION_SAMPLES: '5', BENCH_WARMUPS: '5' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'link-hover-resolution',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-web-display-link-hover.ts'],
    timeoutMs: 120_000,
    quickEnv: { BENCH_TIMING_SAMPLES: '20', BENCH_TIMING_SWEEPS: '10', BENCH_WARMUPS: '5' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'periodic-display-paths',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-web-display-periodic-paths.ts'],
    timeoutMs: 60_000,
    quickEnv: { BENCH_TIMING_SAMPLES: '20', BENCH_TIMING_OPS: '500', BENCH_WARMUPS: '5' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'display-resume-store-browser',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-web-display-resume-store.ts'],
    timeoutMs: 300_000,
    quickEnv: { BENCH_SAMPLES: '5', BENCH_WARMUPS: '1' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'terminal-latency-report',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-terminal-latency-report.ts'],
    timeoutMs: 30_000,
    quickEnv: { BENCH_INPUTS: '5000', BENCH_SAMPLES: '5', BENCH_WARMUPS: '1' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'sse-incremental-parser',
    fidelity: 'production',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-sse-parser.ts'],
    timeoutMs: 30_000,
    quickEnv: {
      BENCH_SAMPLES: '100',
      BENCH_EVENTS_PER_SAMPLE: '8',
      BENCH_PAYLOAD_CHARS: '4096',
      BENCH_CHUNK_CHARS: '32',
      BENCH_WARMUPS: '10',
    },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'fec-retention-admission',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-fec-decoder.ts'],
    timeoutMs: 30_000,
    quickEnv: { BENCH_FRAMES: '100000' },
    requireMetrics: true,
  },
  {
    service: 'web',
    name: 'display-encoding-wasm',
    fidelity: 'component',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-display-encoding.ts'],
    timeoutMs: 120_000,
    quickEnv: {
      BENCH_TARGET_BYTES: String(8 * 1024 * 1024),
      BENCH_DISPLAY_SIZES: '512,4096,65535',
      BENCH_DISPLAY_PATTERNS: 'terminal,random',
    },
    requireMetrics: true,
  },
  {
    service: 'daemon',
    name: 'multicast-hash-gate',
    fidelity: 'model',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-daemon-multicast.ts'],
    timeoutMs: 30_000,
    quickEnv: { BENCH_ITERATIONS: '100000' },
    requireMetrics: true,
  },
  {
    service: 'whole-transport',
    name: 'transport-story-lower-bound',
    fidelity: 'model',
    kind: 'benchmark',
    command: ['bun', 'run', 'scripts/bench-transport-story.ts'],
    timeoutMs: 60_000,
    quickEnv: { BENCH_ITERATIONS: '10000' },
    requireMetrics: true,
  },
];

const VERIFICATIONS: readonly WorkloadSpec[] = [
  {
    service: 'system',
    name: 'terminal-startup-e2e',
    fidelity: 'production',
    kind: 'verification',
    command: ['bun', 'run', 'scripts/run-edge-harness.ts', 'startup-latency.e2e.ts', '--workers=1'],
    timeoutMs: 600_000,
    repetitions: 1,
    warmups: 0,
    requireMetrics: true,
  },
  {
    service: 'tooling',
    name: 'performance-harness-tests',
    fidelity: 'verification',
    kind: 'verification',
    command: ['bun', 'test', 'scripts'],
    timeoutMs: 120_000,
  },
  {
    service: 'packages',
    name: 'typescript-tests',
    fidelity: 'verification',
    kind: 'verification',
    command: ['bun', 'test', 'packages'],
    timeoutMs: 120_000,
  },
  {
    service: 'web',
    name: 'unit-tests',
    fidelity: 'verification',
    kind: 'verification',
    command: ['bun', 'test', 'apps/web/src'],
    timeoutMs: 120_000,
  },
  {
    service: 'server',
    name: 'unit-tests',
    fidelity: 'verification',
    kind: 'verification',
    command: ['bun', 'test', 'apps/server/src'],
    timeoutMs: 120_000,
  },
  {
    service: 'daemon',
    name: 'unit-tests',
    fidelity: 'verification',
    kind: 'verification',
    command: ['bun', 'test', 'apps/daemon/src'],
    timeoutMs: 120_000,
  },
  {
    service: 'dataplane',
    name: 'rust-tests',
    fidelity: 'verification',
    kind: 'verification',
    command: ['cargo', 'test', '--locked', '-p', 'merkur-dataplane'],
    timeoutMs: 300_000,
  },
  {
    service: 'edge',
    name: 'rust-tests',
    fidelity: 'verification',
    kind: 'verification',
    command: ['cargo', 'test', '--locked', '-p', 'merkur-edge'],
    timeoutMs: 300_000,
  },
  {
    service: 'rust-libraries',
    name: 'tests',
    fidelity: 'verification',
    kind: 'verification',
    command: [
      'cargo',
      'test',
      '--locked',
      '-p',
      'merkur-codec',
      '-p',
      'merkur-fec',
      '-p',
      'term-wasm',
      '-p',
      'alacritty_terminal',
    ],
    timeoutMs: 300_000,
  },
];

const RUST_BENCHMARKS: readonly WorkloadSpec[] = [
  {
    service: 'dataplane',
    name: 'display-zstd',
    fidelity: 'production',
    kind: 'benchmark',
    command: [
      'cargo',
      'bench',
      '--locked',
      '-p',
      'merkur-dataplane',
      '--bench',
      'zstd',
      '--',
      '--noplot',
      '--sample-size',
      '20',
      '--warm-up-time',
      '1',
      '--measurement-time',
      '2',
    ],
    timeoutMs: 300_000,
    repetitions: 1,
    warmups: 0,
    requireMetrics: true,
    metricParser: 'criterion',
  },
  {
    service: 'dataplane',
    name: 'display-fec',
    fidelity: 'production',
    kind: 'benchmark',
    command: [
      'cargo',
      'bench',
      '--locked',
      '-p',
      'merkur-dataplane',
      '--bench',
      'fec',
      '--',
      '--noplot',
      '--sample-size',
      '20',
      '--warm-up-time',
      '1',
      '--measurement-time',
      '2',
    ],
    timeoutMs: 300_000,
    repetitions: 1,
    warmups: 0,
    requireMetrics: true,
    metricParser: 'criterion',
  },
  {
    service: 'rust-libraries',
    name: 'terminal-codec',
    fidelity: 'production',
    kind: 'benchmark',
    command: [
      'cargo',
      'bench',
      '--locked',
      '-p',
      'merkur-codec',
      '--bench',
      'codec',
      '--',
      '--noplot',
      '--sample-size',
      '20',
      '--warm-up-time',
      '1',
      '--measurement-time',
      '2',
    ],
    timeoutMs: 300_000,
    repetitions: 1,
    warmups: 0,
    requireMetrics: true,
    metricParser: 'criterion',
  },
];

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`[profile] fatal: ${errorMessage(error)}\n`);
    return 1;
  });
}

export async function main(args: readonly string[]): Promise<number> {
  const options = parseOptions(args);
  validateWorkloadSpecs([...BENCHMARKS, ...RUST_BENCHMARKS, ...VERIFICATIONS]);
  const specs = selectWorkloads(options.mode, options.workloadSelectors);
  if (options.list) {
    for (const spec of specs) {
      const { repetitions, warmups } = samplingFor(spec, options);
      process.stdout.write(
        `${spec.service}/${spec.name}\t${spec.kind}\t${spec.metricParser ?? 'framed-or-none'}` +
          `\trepetitions=${repetitions}\twarmups=${warmups}\n`,
      );
    }
    return 0;
  }

  // Resolve both filesystem identity and canonical paths before reading the
  // baseline or executing work. This protects symlink and hard-link aliases.
  if (options.baselinePath !== null) {
    await assertDistinctReportFiles(options.baselinePath, options.outputPath);
  }
  const baselineReport =
    options.baselinePath === null ? null : await readBaseline(options.baselinePath);
  const reports = await profileWorkloads(specs, options);

  const report = createProfileReport(options, reports);
  await atomicWriteText(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);

  let comparisonError: string | null = null;
  let comparisons: MetricComparison[] = [];
  if (baselineReport !== null && reports.every((workload) => workload.passed)) {
    try {
      comparisons = compareProfileReports(report, baselineReport, options.allowedRegressionRatio);
    } catch (error) {
      comparisonError = errorMessage(error);
      process.stderr.write(`[profile] baseline comparison failed: ${comparisonError}\n`);
    }
  }
  const varianceViolations = findVarianceViolations(report, options.varianceLimit);
  printSummary(report, comparisons, varianceViolations, options);

  const commandFailure = reports.some((workload) => !workload.passed);
  const regression = comparisons.some((comparison) => comparison.regression);
  const noisy = options.strictVariance && varianceViolations.length > 0;
  return commandFailure || regression || noisy || comparisonError !== null ? 1 : 0;
}

export async function profileWorkloads(
  specs: readonly WorkloadSpec[],
  profileOptions: ProfileOptions,
): Promise<WorkloadReport[]> {
  const reports: WorkloadReport[] = [];
  for (const spec of specs) {
    reports.push(await profileWorkload(spec, profileOptions));
  }
  return reports;
}

export async function profileWorkload(
  spec: WorkloadSpec,
  profileOptions: ProfileOptions,
): Promise<WorkloadReport> {
  const { repetitions, warmups } = samplingFor(spec, profileOptions);
  // Only the fast micro mode applies reduced benchmark sizes. Full and soak
  // profiles execute script defaults after inherited BENCH_*/compiler tuning
  // knobs have been removed.
  const environmentOverrides = profileOptions.mode === 'micro' ? (spec.quickEnv ?? {}) : {};
  const childEnvironment = createSanitizedProfileEnvironment(environmentOverrides);
  const errors: string[] = [];

  for (let index = 0; index < warmups; index += 1) {
    status(spec, `warmup ${index + 1}/${warmups}`);
    const warmup = await executeProfileRun({
      command: spec.command,
      cwd: ROOT,
      env: childEnvironment,
      replaceEnvironment: true,
      timeoutMs: spec.timeoutMs,
      outputLimitBytes: BENCHMARK_OUTPUT_LIMIT_BYTES,
    });
    if (!runPassed(warmup)) {
      printFailure(spec, warmup);
      errors.push(`warmup ${index + 1}/${warmups} failed: ${describeRunFailure(warmup)}`);
    }
  }

  const runs: ProfileRun[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    status(spec, `run ${index + 1}/${repetitions}`);
    const rawRun = await executeProfileRun({
      command: spec.command,
      cwd: ROOT,
      env: childEnvironment,
      replaceEnvironment: true,
      timeoutMs: spec.timeoutMs,
      outputLimitBytes:
        spec.kind === 'benchmark' ? BENCHMARK_OUTPUT_LIMIT_BYTES : VERIFICATION_OUTPUT_LIMIT_BYTES,
    });
    let run = rawRun;
    if (spec.metricParser === 'criterion' && rawRun.error === null) {
      try {
        run = {
          ...rawRun,
          metrics: parseCriterionMetrics(rawRun.stdout, criterionSampleSize(spec.command)),
        };
      } catch (error) {
        run = {
          ...rawRun,
          metrics: [],
          error: `Criterion parser failed: ${errorMessage(error)}`,
        };
      }
    }
    runs.push(run);
    if (!runPassed(run)) {
      printFailure(spec, run);
      errors.push(`run ${index + 1}/${repetitions} failed: ${describeRunFailure(run)}`);
    }
    if (spec.requireMetrics === true && run.metrics.length === 0) {
      errors.push(`run ${index + 1}/${repetitions} emitted no structured metrics`);
    }
  }

  if (
    spec.kind === 'benchmark' &&
    runs.every(runPassed) &&
    errors.length === 0 &&
    (profileOptions.cpuProfile || profileOptions.heapProfile) &&
    spec.command[0] === 'bun'
  ) {
    try {
      await captureBunProfile(spec, childEnvironment, profileOptions);
    } catch (error) {
      const message = `profiler capture failed: ${errorMessage(error)}`;
      errors.push(message);
      process.stderr.write(`[profile] ${spec.service}/${spec.name}: ${message}\n`);
    }
  }

  const wallSamples = runs.map((run) => run.wallMs);
  const cpuSamples = runs.map((run) => run.cpuUserMs + run.cpuSystemMs);
  const rssSamples = runs.map((run) => run.maxRssBytes);
  let metrics: MetricSummary[] = [];
  try {
    metrics = aggregateMetrics(runs);
  } catch (error) {
    errors.push(`metric aggregation failed: ${errorMessage(error)}`);
  }
  return {
    service: spec.service,
    name: spec.name,
    fidelity: spec.fidelity,
    processMetrics: spec.processMetrics ?? 'gated',
    command: spec.command,
    environmentOverrides,
    repetitions,
    warmups,
    timeoutMs: spec.timeoutMs,
    runs,
    wallMs: summarizeSamples(wallSamples),
    cpuMs: summarizeSamples(cpuSamples),
    maxRssBytes: summarizeSamples(rssSamples),
    metrics,
    errors,
    passed: errors.length === 0 && runs.every(runPassed),
  };
}

function createProfileReport(
  profileOptions: ProfileOptions,
  workloads: readonly WorkloadReport[],
): ProfileReport {
  const rustVerbose = toolOutput(['rustc', '-Vv']);
  return {
    schemaVersion: PERF_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: profileOptions.mode,
    revision: gitOutput(['rev-parse', 'HEAD']),
    dirty: gitDirty(),
    environmentPolicy: SANITIZED_ENVIRONMENT_POLICY,
    platform: {
      os: process.platform,
      osRelease: os.release(),
      osVersion: os.version(),
      arch: process.arch,
      bun: Bun.version,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: Math.max(1, os.cpus().length),
      totalMemoryBytes: os.totalmem(),
      rustc: firstLine(rustVerbose),
      cargo: toolOutput(['cargo', '--version']),
      llvm: verboseField(rustVerbose, 'LLVM version'),
      rustHost: verboseField(rustVerbose, 'host'),
    },
    workloads,
  };
}

function samplingFor(
  spec: WorkloadSpec,
  profileOptions: ProfileOptions,
): { readonly repetitions: number; readonly warmups: number } {
  const soakCriterion = profileOptions.mode === 'soak' && spec.metricParser === 'criterion';
  return {
    repetitions: soakCriterion
      ? profileOptions.repetitions
      : (spec.repetitions ??
        (spec.kind === 'benchmark'
          ? profileOptions.repetitions
          : profileOptions.verificationRepetitions)),
    warmups: spec.warmups ?? (spec.kind === 'benchmark' ? profileOptions.warmups : 0),
  };
}

export function createSanitizedProfileEnvironment(
  overrides: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isSanitizedPerformanceKey(key)) continue;
    environment[key] = value;
  }
  const cargoHome = source.CARGO_HOME ?? path.join(os.homedir(), '.cargo');
  const cargoBin = path.join(cargoHome, 'bin');
  const cargoProxy = path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  if (existsSync(cargoProxy)) {
    environment.PATH = [cargoBin, environment.PATH ?? ''].join(path.delimiter);
  }
  return { ...environment, ...overrides };
}

function isSanitizedPerformanceKey(key: string): boolean {
  return (
    SANITIZED_PERFORMANCE_ENVIRONMENT_KEYS.has(key) ||
    SANITIZED_PERFORMANCE_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

async function executeProfileRun(
  options: Parameters<typeof runProfileCommand>[0],
): Promise<ProfileRun> {
  const startedAt = performance.now();
  try {
    return await runProfileCommand(options);
  } catch (error) {
    return {
      wallMs: performance.now() - startedAt,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      maxRssBytes: 0,
      exitCode: -1,
      signalCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      metrics: [],
      error: `harness failed to execute command: ${errorMessage(error)}`,
    };
  }
}

function criterionSampleSize(command: readonly string[]): number {
  const optionIndex = command.indexOf('--sample-size');
  const raw = optionIndex === -1 ? undefined : command[optionIndex + 1];
  if (raw === undefined) {
    throw new Error('Criterion workload must declare --sample-size');
  }
  return positiveInteger('sample-size', raw, 0);
}

async function captureBunProfile(
  spec: WorkloadSpec,
  environment: Readonly<Record<string, string>>,
  profileOptions: ProfileOptions,
): Promise<void> {
  const plan = createBunProfileCapturePlan(
    spec.service,
    spec.name,
    profileOptions.outputPath,
    profileOptions.cpuProfile,
    profileOptions.heapProfile,
  );
  const profileDirectory = path.dirname(plan.expectedArtifactPaths[0] ?? profileOptions.outputPath);
  await mkdir(profileDirectory, { recursive: true });
  const command = ['bun', ...plan.flags, ...spec.command.slice(1)];
  const captureStartedAtMs = await prepareProfilerArtifacts(plan.cleanupArtifactPaths);
  status(spec, 'capturing profiler artifact');
  const profileRun = await executeProfileRun({
    command,
    cwd: ROOT,
    env: environment,
    replaceEnvironment: true,
    timeoutMs: spec.timeoutMs,
    outputLimitBytes: BENCHMARK_OUTPUT_LIMIT_BYTES,
  });
  if (!runPassed(profileRun)) {
    printFailure(spec, profileRun);
    throw new Error(`${spec.service}/${spec.name} profiler capture failed`);
  }
  await validateProfilerArtifacts(plan.expectedArtifactPaths, captureStartedAtMs);
}

export function createBunProfileCapturePlan(
  service: string,
  workload: string,
  reportPath: string,
  cpuProfile: boolean,
  heapProfile: boolean,
): {
  readonly flags: readonly string[];
  readonly expectedArtifactPaths: readonly string[];
  readonly cleanupArtifactPaths: readonly string[];
  readonly directoryArgument: string;
} {
  const profileDirectory = path.resolve(path.dirname(reportPath), 'profiles');
  // Bun's heap profiler treats absolute --*-prof-dir values as cwd-relative,
  // producing paths such as ROOT/Users/... . Always give it one normalized
  // relative directory for both profilers.
  const directoryArgument = path.normalize(path.relative(ROOT, profileDirectory) || '.');
  if (path.isAbsolute(directoryArgument)) {
    throw new Error(`Bun profiler directory must be cwd-relative: ${directoryArgument}`);
  }
  const safeName = bunProfileArtifactStem(service, workload);
  const flags: string[] = [];
  const artifactNames: string[] = [];
  if (cpuProfile) {
    // Bun appends ".cpuprofile" itself. Supplying that suffix here creates
    // "*.cpuprofile.cpuprofile", so the logical name must remain extensionless.
    flags.push(
      '--cpu-prof',
      '--cpu-prof-md',
      `--cpu-prof-name=${safeName}`,
      `--cpu-prof-dir=${directoryArgument}`,
    );
    artifactNames.push(`${safeName}.cpuprofile`, `${safeName}.md`);
  }
  if (heapProfile) {
    // Unlike the CPU profiler, Bun uses the heap filename verbatim.
    flags.push(
      '--heap-prof',
      `--heap-prof-name=${safeName}.heapsnapshot`,
      `--heap-prof-dir=${directoryArgument}`,
    );
    artifactNames.push(`${safeName}.heapsnapshot`);
  }
  return {
    flags,
    expectedArtifactPaths: artifactNames.map((name) => path.join(profileDirectory, name)),
    cleanupArtifactPaths: artifactNames.map((name) => path.join(profileDirectory, name)),
    directoryArgument,
  };
}

function selectWorkloads(
  mode: ProfileMode,
  workloadSelectors: readonly string[],
): readonly WorkloadSpec[] {
  const modeWorkloads =
    mode === 'micro'
      ? BENCHMARKS
      : mode === 'services'
        ? VERIFICATIONS
        : [...BENCHMARKS, ...RUST_BENCHMARKS, ...VERIFICATIONS];
  if (workloadSelectors.length === 0) return modeWorkloads;

  const selectedIdentities = new Set(workloadSelectors);
  const selected = modeWorkloads.filter((spec) =>
    selectedIdentities.has(`${spec.service}/${spec.name}`),
  );
  const foundIdentities = new Set(selected.map((spec) => `${spec.service}/${spec.name}`));
  const missing = workloadSelectors.filter((identity) => !foundIdentities.has(identity));
  if (missing.length > 0) {
    throw new Error(
      `profile workload selector(s) unavailable in ${mode} mode: ${missing.join(', ')}`,
    );
  }
  return selected;
}

function parseOptions(args: readonly string[]): ProfileOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const workloadSelectors: string[] = [];
  for (const argument of args) {
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const separator = argument.indexOf('=');
    if (separator === -1) switches.add(argument.slice(2));
    else {
      const name = argument.slice(2, separator);
      const value = argument.slice(separator + 1);
      if (name === 'workload') workloadSelectors.push(value);
      else values.set(name, value);
    }
  }

  const knownValues = new Set([
    'mode',
    'repetitions',
    'warmups',
    'verification-repetitions',
    'output',
    'baseline',
    'regression-percent',
    'variance-percent',
  ]);
  const knownSwitches = new Set(['strict-variance', 'cpu-profile', 'heap-profile', 'list']);
  for (const name of values.keys()) {
    if (!knownValues.has(name)) throw new Error(`unknown profile option: --${name}`);
  }
  for (const name of switches) {
    if (!knownSwitches.has(name)) throw new Error(`unknown profile option: --${name}`);
  }

  const mode = parseMode(values.get('mode') ?? 'micro');
  validateWorkloadSelectors(workloadSelectors);
  const outputPath = path.resolve(ROOT, values.get('output') ?? DEFAULT_OUTPUT_PATH);
  const baselinePath =
    values.get('baseline') === undefined ? null : path.resolve(ROOT, values.get('baseline') ?? '');
  if (baselinePath !== null && baselinePath === outputPath) {
    throw new Error('--baseline and --output must resolve to different files');
  }
  return {
    mode,
    workloadSelectors,
    repetitions: positiveInteger(
      'repetitions',
      values.get('repetitions'),
      mode === 'soak' ? 20 : 5,
    ),
    warmups: nonNegativeInteger('warmups', values.get('warmups'), mode === 'soak' ? 2 : 1),
    verificationRepetitions: positiveInteger(
      'verification-repetitions',
      values.get('verification-repetitions'),
      mode === 'soak' ? 3 : 1,
    ),
    outputPath,
    baselinePath,
    allowedRegressionRatio:
      nonNegativeNumber('regression-percent', values.get('regression-percent'), 10) / 100,
    varianceLimit: nonNegativeNumber('variance-percent', values.get('variance-percent'), 15) / 100,
    strictVariance: switches.has('strict-variance'),
    cpuProfile: switches.has('cpu-profile'),
    heapProfile: switches.has('heap-profile'),
    list: switches.has('list'),
  };
}

function validateWorkloadSelectors(workloadSelectors: readonly string[]): void {
  const identities = new Set<string>();
  for (const identity of workloadSelectors) {
    const separator = identity.indexOf('/');
    if (
      separator <= 0 ||
      separator === identity.length - 1 ||
      identity.indexOf('/', separator + 1) !== -1
    ) {
      throw new Error(`invalid profile workload selector: ${JSON.stringify(identity)}`);
    }
    if (identities.has(identity)) {
      throw new Error(`duplicate profile workload selector: ${identity}`);
    }
    identities.add(identity);
  }
}

export function validateWorkloadSpecs(specs: readonly WorkloadSpec[]): void {
  const identities = new Set<string>();
  const profilerArtifactOwners = new Map<string, string>();
  for (const spec of specs) {
    validateWorkloadSpecShape(spec);
    const identity = `${spec.service}\u0000${spec.name}`;
    if (identities.has(identity)) {
      throw new Error(`duplicate profile workload identity: ${spec.service}/${spec.name}`);
    }
    identities.add(identity);

    const isCriterionCommand =
      spec.command[0] === 'cargo' && cargoSubcommand(spec.command) === 'bench';
    if (spec.metricParser === 'criterion' && !isCriterionCommand) {
      throw new Error(
        `Criterion parser assigned to a non-benchmark workload: ${spec.service}/${spec.name}`,
      );
    }
    if (isCriterionCommand && spec.metricParser !== 'criterion') {
      throw new Error(
        `Criterion workload is missing its metric parser: ${spec.service}/${spec.name}`,
      );
    }
    if (spec.metricParser === 'criterion' && spec.requireMetrics !== true) {
      throw new Error(
        `Criterion workload must require parsed metrics: ${spec.service}/${spec.name}`,
      );
    }
    if (spec.metricParser === 'criterion') criterionSampleSize(spec.command);
    validateCargoPackageSelectors(spec);
    validateBunScript(spec);

    if (spec.kind === 'benchmark' && spec.command[0] === 'bun') {
      const stem = bunProfileArtifactStem(spec.service, spec.name);
      const owner = profilerArtifactOwners.get(stem);
      if (owner !== undefined) {
        throw new Error(
          `Bun profiler artifact name collision: ${owner} and ${spec.service}/${spec.name}`,
        );
      }
      profilerArtifactOwners.set(stem, `${spec.service}/${spec.name}`);
    }
  }
}

/** A deleted benchmark script fails the registry, not the run that reaches it. */
function validateBunScript(spec: WorkloadSpec): void {
  const [executable, subcommand, script] = spec.command;
  if (executable !== 'bun' || subcommand !== 'run' || script?.endsWith('.ts') !== true) return;
  if (!existsSync(path.join(ROOT, script))) {
    throw new Error(`profile workload script is missing: ${spec.service}/${spec.name} (${script})`);
  }
}

function validateWorkloadSpecShape(spec: WorkloadSpec): void {
  const identity = `${spec.service}/${spec.name}`;
  if (
    spec.service.trim().length === 0 ||
    spec.name.trim().length === 0 ||
    spec.service.includes('\u0000') ||
    spec.name.includes('\u0000')
  ) {
    throw new Error(`profile workload has an invalid identity: ${JSON.stringify(identity)}`);
  }
  if (
    spec.processMetrics !== undefined &&
    spec.processMetrics !== 'gated' &&
    spec.processMetrics !== 'diagnostic'
  ) {
    throw new Error(`profile workload has an invalid process metric policy: ${identity}`);
  }
  if (spec.command.length === 0 || spec.command[0]?.trim().length === 0) {
    throw new Error(`profile workload has an empty command executable: ${identity}`);
  }
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new Error(`profile workload has an invalid timeout: ${identity}`);
  }
  if (
    spec.repetitions !== undefined &&
    (!Number.isSafeInteger(spec.repetitions) || spec.repetitions <= 0)
  ) {
    throw new Error(`profile workload has invalid repetitions: ${identity}`);
  }
  if (spec.warmups !== undefined && (!Number.isSafeInteger(spec.warmups) || spec.warmups < 0)) {
    throw new Error(`profile workload has invalid warmups: ${identity}`);
  }
  if (
    spec.quickEnv !== undefined &&
    Object.entries(spec.quickEnv).some(
      ([key, value]) => key.length === 0 || key.includes('=') || typeof value !== 'string',
    )
  ) {
    throw new Error(`profile workload has invalid environment overrides: ${identity}`);
  }
}

function validateCargoPackageSelectors(spec: WorkloadSpec): void {
  if (spec.command[0] !== 'cargo') return;

  const optionsEnd = spec.command.indexOf('--');
  const end = optionsEnd === -1 ? spec.command.length : optionsEnd;
  for (let index = 1; index < end; index += 1) {
    const argument = spec.command[index];
    if (argument?.startsWith('--package=')) {
      if (argument.slice('--package='.length).length === 0) {
        throw new Error(
          `Cargo package selector is missing its value: ${spec.service}/${spec.name}`,
        );
      }
      continue;
    }
    if (argument !== '-p' && argument !== '--package') continue;

    const packageName = spec.command[index + 1];
    if (
      index + 1 >= end ||
      packageName === undefined ||
      packageName.length === 0 ||
      packageName.startsWith('-')
    ) {
      throw new Error(`Cargo package selector is missing its value: ${spec.service}/${spec.name}`);
    }
    index += 1;
  }
}

function cargoSubcommand(command: readonly string[]): string | null {
  let index = command[1]?.startsWith('+') ? 2 : 1;
  while (index < command.length) {
    const argument = command[index];
    if (argument === undefined || argument === '--') return null;
    if (
      argument === '-v' ||
      argument === '--verbose' ||
      argument === '-q' ||
      argument === '--quiet' ||
      argument === '--frozen' ||
      argument === '--locked' ||
      argument === '--offline'
    ) {
      index += 1;
      continue;
    }
    if (argument === '--color' || argument === '--config' || argument === '-Z') {
      index += 2;
      continue;
    }
    if (
      argument.startsWith('--color=') ||
      argument.startsWith('--config=') ||
      argument.startsWith('-Z')
    ) {
      index += 1;
      continue;
    }
    return argument.startsWith('-') ? null : argument;
  }
  return null;
}

function bunProfileArtifactStem(service: string, workload: string): string {
  return `${service}-${workload}`.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
}

function parseMode(value: string): ProfileMode {
  if (value === 'micro' || value === 'services' || value === 'full' || value === 'soak') {
    return value;
  }
  throw new Error(`invalid profile mode: ${value}`);
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegativeNumber(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative finite number`);
  }
  return value;
}

function runPassed(run: ProfileRun): boolean {
  return run.exitCode === 0 && run.signalCode === null && !run.timedOut && run.error === null;
}

function status(spec: WorkloadSpec, message: string): void {
  process.stdout.write(`[profile] ${spec.service}/${spec.name}: ${message}\n`);
}

function printFailure(spec: WorkloadSpec, run: ProfileRun): void {
  process.stderr.write(
    `[profile] ${spec.service}/${spec.name} failed exit=${run.exitCode} signal=${run.signalCode ?? 'none'} timeout=${run.timedOut}\n`,
  );
  if (run.error !== null) process.stderr.write(`[profile] ${run.error}\n`);
  if (run.stdout.length > 0) process.stderr.write(`${run.stdout}\n`);
  if (run.stderr.length > 0) process.stderr.write(`${run.stderr}\n`);
}

function printSummary(
  report: ProfileReport,
  comparisons: readonly MetricComparison[],
  varianceViolations: ReturnType<typeof findVarianceViolations>,
  profileOptions: ProfileOptions,
): void {
  process.stdout.write(`\nMerkur profile (${report.mode})\n`);
  for (const workload of report.workloads) {
    const statusLabel = workload.passed ? 'pass' : 'FAIL';
    const processLabel = workload.processMetrics === 'diagnostic' ? ' (diagnostic)' : '';
    process.stdout.write(
      `${statusLabel.padEnd(4)} ${workload.service}/${workload.name} [${workload.fidelity}] wall${processLabel} p50=${formatMs(workload.wallMs.median)} p95=${formatMs(workload.wallMs.p95)} rss=${formatBytes(workload.maxRssBytes.max)}\n`,
    );
    for (const error of workload.errors) {
      process.stdout.write(`     error: ${error}\n`);
    }
    for (const metric of workload.metrics) {
      const percentile =
        metric.percentile === undefined ? '' : ` p${Math.round(metric.percentile * 100)}`;
      const noisy =
        metric.samples.length > 1 &&
        metric.summary.coefficientOfVariation > profileOptions.varianceLimit
          ? ` noisy(cv=${(metric.summary.coefficientOfVariation * 100).toFixed(1)}%)`
          : '';
      process.stdout.write(
        `     ${metric.name}${percentile}: ${formatNumber(metric.summary.median)} ${metric.unit}${noisy}\n`,
      );
    }
  }
  if (profileOptions.strictVariance) {
    for (const violation of varianceViolations) {
      process.stdout.write(
        `NOISY ${violation.service}/${violation.workload}/${violation.metric}: ` +
          `cv=${(violation.coefficientOfVariation * 100).toFixed(1)}%\n`,
      );
    }
  }
  for (const comparison of comparisons) {
    const marker = comparison.regression ? 'REGRESSION' : 'baseline';
    const percentile =
      comparison.percentile === undefined ? '' : ` p${Math.round(comparison.percentile * 100)}`;
    process.stdout.write(
      `${marker} ${comparison.service}/${comparison.workload}/${comparison.metric}${percentile}: ${formatSignedPercent(comparison.changeRatio)}\n`,
    );
  }
  process.stdout.write(`report: ${path.relative(ROOT, profileOptions.outputPath)}\n`);
}

async function readBaseline(filePath: string): Promise<ProfileReport> {
  const value: unknown = await Bun.file(filePath).json();
  if (!isProfileReport(value)) throw new Error(`invalid profile baseline: ${filePath}`);
  return value;
}

function gitOutput(args: readonly string[]): string | null {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return null;
  const value = new TextDecoder().decode(result.stdout).trim();
  return value.length === 0 ? null : value;
}

function gitDirty(): boolean | null {
  const result = Bun.spawnSync(['git', 'status', '--porcelain'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim().length > 0;
}

function toolOutput(command: readonly string[]): string {
  const result = Bun.spawnSync([...command], {
    cwd: ROOT,
    env: createSanitizedProfileEnvironment({}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return 'unavailable';
  const value = new TextDecoder().decode(result.stdout).trim();
  return value.length === 0 ? 'unavailable' : value;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? 'unavailable';
}

function verboseField(value: string, name: string): string {
  const prefix = `${name}:`;
  const line = value.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim() || 'unavailable';
}

function describeRunFailure(run: ProfileRun): string {
  if (run.error !== null) return run.error;
  if (run.timedOut) return `timed out (exit=${run.exitCode})`;
  if (run.signalCode !== null) return `signal=${run.signalCode} exit=${run.exitCode}`;
  return `exit=${run.exitCode}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMs(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 1)}ms`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KiB`;
  return `${(value / 1024 / 1024).toFixed(1)}MiB`;
}

function formatNumber(value: number): string {
  if (Math.abs(value) >= 1_000) return Math.round(value).toLocaleString('en-US');
  if (Math.abs(value) >= 1) return value.toFixed(3);
  return value.toPrecision(4);
}

function formatSignedPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return ratio > 0 ? '+inf' : '-inf';
  const percent = ratio * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}
