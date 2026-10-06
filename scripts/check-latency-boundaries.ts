import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const IMPORT_SCANNER = new Bun.Transpiler({ loader: 'ts' });
// Effect is intentionally retained for connection/session/device-list control
// flow and for structured logging. This list is narrower: code executed for
// every input, display frame, ring drain, prediction, or GPU submission must
// not acquire a direct Effect dependency.
export const DEFAULT_HOT_PATH_FILES = [
  'apps/web/src/terminal-worker.ts',
  'apps/web/src/transport-worker.ts',
  'apps/web/src/renderer-webgpu.ts',
  'apps/web/src/terminal/display-output-settle.ts',
  'apps/web/src/terminal/input-controller.ts',
  'apps/web/src/lib/key-record.ts',
  'apps/web/src/terminal/pointer-input.ts',
  'apps/web/src/terminal/prediction-admission-model.ts',
  'apps/web/src/terminal/prediction-fast-path.ts',
  'apps/web/src/terminal/prediction-gate.ts',
  'apps/web/src/terminal/prediction-input-barrier.ts',
  'apps/web/src/terminal/render-mailbox.ts',
  'apps/web/src/terminal/render-submission-state.ts',
  'apps/web/src/terminal/provisional-preview.ts',
  'apps/web/src/terminal/shared-ring.ts',
  'apps/web/src/transport/input-ring.ts',
  'apps/web/src/transport/input-sequence-domain.ts',
  'apps/web/src/transport/wire-frame-pool.ts',
  'apps/web/src/transport/prediction-admission.ts',
  'apps/web/src/perf/terminal-latency.ts',
  'apps/web/src/terminal/presented-prediction-sources.ts',
  'apps/web/src/perf/link-quality-aggregator.ts',
  'apps/web/src/perf/perf-ring.ts',
  'apps/web/src/perf/perf-event-codec.ts',
  'apps/web/src/perf/browser-display-io.ts',
  'apps/web/src/perf/browser-display-ingress.ts',
  'apps/web/src/transport/browser-client-session.ts',
  'apps/web/src/transport/client-carrier.ts',
  'apps/web/src/terminal/client-viewer-scene.ts',
  'apps/web/src/terminal/presentation-cadence.ts',
  'apps/web/src/terminal/prediction-capture.ts',
  'apps/web/src/perf/client-session-observation.ts',
] as const;
const FORBIDDEN_DATA_PLANE_IMPORT = /^effect(?:\/|$)/;

export interface ImportBoundaryViolation {
  readonly module: string;
  readonly chain: readonly string[];
}

/**
 * Report any listed module that *declares* a direct Effect dependency.
 *
 * # Why this is deliberately one level deep
 *
 * The worker adapters call the shared Rust owners and structured logging in
 * the same realm. Logging may import Effect above the hot path, so importing
 * it transitively is distinct from putting Effect into per-frame code.
 *
 * The rule this enforces is narrower and checkable: a module on the list must
 * not itself import Effect, because that is the signal that Effect has been
 * pulled *into* per-frame code rather than sitting above it. Whether Effect
 * loads somewhere in the worker realm is not the question — it does, by design.
 *
 * If you came here to "finish" the transitive traversal: run it first, read the
 * chains, and note that every one of them terminates in a session or logging
 * module the architecture puts there on purpose.
 */
export function findLatencyBoundaryViolations(
  files: readonly string[] = DEFAULT_HOT_PATH_FILES,
): ImportBoundaryViolation[] {
  const violations: ImportBoundaryViolation[] = [];

  for (const file of files) {
    const canonical = path.resolve(ROOT, file);
    const source = readFileSync(canonical, 'utf8');
    for (const imported of IMPORT_SCANNER.scanImports(source)) {
      const moduleName = imported.path;
      if (FORBIDDEN_DATA_PLANE_IMPORT.test(moduleName)) {
        violations.push({
          module: moduleName,
          chain: [relative(canonical), moduleName],
        });
      }
    }
  }

  return violations.sort((left, right) =>
    left.chain.join('\n').localeCompare(right.chain.join('\n')),
  );
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

if (import.meta.main) {
  const violations = findLatencyBoundaryViolations(
    process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_HOT_PATH_FILES,
  );
  if (violations.length === 0) {
    process.stdout.write(
      'latency boundary: pass (no direct Effect imports in browser data-plane hot paths)\n',
    );
  } else {
    process.stderr.write(
      `${violations
        .map(
          (violation) =>
            `latency boundary violation: ${violation.module}\n  ${violation.chain.join(' -> ')}`,
        )
        .join('\n')}\n`,
    );
    process.exitCode = 1;
  }
}
