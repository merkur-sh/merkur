import type { CoverageCatalog, CoveragePlan } from './coverage';
import type { RequiredCheck } from './events';
import { BAZEL_STATIC_GATES } from './static-gates';

export type AssuranceLane =
  | 'parser-smoke'
  | 'ownership'
  | 'bounded-proofs'
  | 'kernel-tool'
  | 'simulation'
  | 'fuzz-campaign';

/** Original workflow commands; configured producers own their budgets, locks and source inputs. */
export const ASSURANCE_OPERATIONS: Readonly<Record<AssuranceLane, readonly string[]>> = {
  'parser-smoke': ['test:fuzz:instrumentation', 'test:fuzz:smoke'],
  ownership: [
    'test:ownership',
    'rust:lint:ownership',
    'test:ownership:kani',
    'test:ownership:negative',
  ],
  'bounded-proofs': ['test:fuzz:kani'],
  'kernel-tool': ['rust:lint:kernel-tool', 'test:kernel-tool', 'test:kernel-tool:completed-work'],
  simulation: ['test:sim'],
  'fuzz-campaign': ['test:fuzz:campaign'],
};

export interface AssuranceWorkflowSelection {
  readonly lanes: readonly AssuranceLane[];
  readonly operations: readonly string[];
  readonly coverage: CoveragePlan;
}

/** One complete controller batch: overlapping lanes must never reserve separate forced epochs. */
export function assuranceWorkflowSelection(
  event: string,
  catalog: CoverageCatalog,
): AssuranceWorkflowSelection {
  if (!['pull_request', 'push', 'schedule', 'workflow_dispatch'].includes(event))
    throw new Error(`Unsupported assurance workflow event: ${event}`);
  const lanes: AssuranceLane[] = [
    'parser-smoke',
    'ownership',
    'bounded-proofs',
    'kernel-tool',
    'simulation',
  ];
  const scheduled = event === 'schedule' || event === 'workflow_dispatch';
  if (scheduled) lanes.push('fuzz-campaign');
  const operations = [
    ...BAZEL_STATIC_GATES,
    ...lanes.flatMap((lane) => ASSURANCE_OPERATIONS[lane]),
  ];
  if (scheduled) operations.push('test:sim:sweep');
  return { lanes, operations, coverage: workflowCoverage(operations, catalog, 'assurance') };
}

export const EXTENDED_SUITES: readonly string[] = [
  'test:natlab',
  'test:tpm-sim',
  'test:graphics:long',
  'test:e2e:transport:impaired:functional',
  'test:e2e:edge-topology',
];

export function extendedWorkflowSelection(suite: string, catalog: CoverageCatalog): CoveragePlan {
  if (!EXTENDED_SUITES.includes(suite)) throw new Error(`Unsupported extended suite: ${suite}`);
  return workflowCoverage([...BAZEL_STATIC_GATES, suite], catalog, 'extended');
}

/** Reserve the extended matrix's overlapping tests once, before any suite executes. */
export function extendedWorkflowsSelection(catalog: CoverageCatalog): CoveragePlan {
  return workflowCoverage([...BAZEL_STATIC_GATES, ...EXTENDED_SUITES], catalog, 'extended');
}

function workflowCoverage(
  operations: readonly string[],
  catalog: CoverageCatalog,
  workflow: 'assurance' | 'extended',
): CoveragePlan {
  const required = new Map<string, RequiredCheck>();
  const selected = new Map<string, readonly RequiredCheck[]>();
  const reasons: string[] = [];
  for (const name of operations) {
    const checks = catalog.operations.get(name);
    if (checks === undefined || checks.length === 0)
      throw new Error(
        `${workflow === 'assurance' ? 'Assurance workflow' : 'Extended suite'} requires a configured producer for ${name}`,
      );
    const labels = new Set<string>();
    for (const check of checks) {
      if (
        !/^\/\/[^:\s]*:[^:\s]+$/.test(check.label) ||
        check.kind !== 'test' ||
        typeof check.fresh !== 'boolean' ||
        labels.has(check.label)
      )
        throw new Error(`Invalid ${workflow} workflow test binding: ${name}`);
      labels.add(check.label);
      const previous = required.get(check.label);
      required.set(check.label, { ...check, fresh: check.fresh || previous?.fresh === true });
      reasons.push(`${check.label} ← ${workflow} ${name}`);
    }
    selected.set(
      name,
      checks.map((check) => ({ ...check })),
    );
  }

  return {
    files: [],
    docsOnly: false,
    required: [...required.values()].sort((left, right) =>
      left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
    ),
    deferred: [],
    pendingDeferred: [],
    reasons: reasons.sort(),
    staticOperations: BAZEL_STATIC_GATES.map((name) => ({
      name,
      checks: selected.get(name) ?? [],
    })),
  };
}
