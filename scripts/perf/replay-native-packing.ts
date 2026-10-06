import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

type Population = 'owner' | 'full';
type Arm = 'adaptive' | 'whole-span';
type Summary = { n: number; p50: number; p95: number; p99: number; max: number };
type Group = {
  population: Population;
  caseKey: string;
  order: number;
  arm: Arm;
  samples: Map<number, Record<string, number>>;
  summaries: Map<string, Summary>;
};

export const NATIVE_PACKING_SUMMARIES: Record<
  Population,
  Record<string, readonly [string | null, 'us' | 'count' | 'bytes']>
> = {
  owner: {
    'owner-selection-capture': ['owner_capture_us', 'us'],
    'injected-pty-effect': ['input_effect_us', 'us'],
    'input-to-bulk-completion': ['token_wait_us', 'us'],
    'input-to-complete-admission': ['complete_admission_us', 'us'],
    'owner-start-to-first-original-admission': ['first_original_admission_us', 'us'],
    'owner-start-to-last-original-admission': ['last_original_admission_us', 'us'],
    'original-admission-count': ['original_admission_count', 'count'],
    'bulk-worker-cpu': ['bulk_cpu_us', 'us'],
    'maximum-followup-arm': ['followup_arm_us', 'us'],
    'owner-wake-count': ['owner_wakes', 'count'],
    'admitted-record-count': ['admitted_records', 'count'],
    'admitted-sealed-bytes': ['admitted_sealed_bytes', 'bytes'],
  },
  full: {
    'owner-capture': ['capture_us', 'us'],
    'owner-capture-allocation-count': ['capture_allocations', 'count'],
    'owner-capture-allocated-bytes': ['capture_allocated_bytes', 'bytes'],
    'bulk-job': ['bulk_us', 'us'],
    'bulk-job-allocation-count': ['bulk_allocations', 'count'],
    'bulk-job-allocated-bytes': ['bulk_allocated_bytes', 'bytes'],
    'partition-job': ['partition_us', 'us'],
    'partition-first': ['first_partition_us', 'us'],
    'partition-largest': [null, 'us'],
    'compression-job': ['compression_us', 'us'],
    'partition-count': ['partition_calls', 'count'],
    'partition-first-modeled-refinement-gain': [null, 'us'],
    'partition-first-relaxed-gap': [null, 'us'],
    'record-count': ['records', 'count'],
    'fec-bytes': ['fec_bytes', 'bytes'],
    'prepared-primary-wire-bytes': ['primary_wire_bytes', 'bytes'],
    'prepared-primary-datagram-count': ['primary_datagrams', 'count'],
    'prepared-primary-reliable-record-count': ['primary_reliable_records', 'count'],
    'interactive-queue': ['interactive_queue_us', 'us'],
    'interactive-job': ['interactive_cpu_us', 'us'],
    'snapshot-job': [null, 'us'],
    'snapshot-job-allocation-count': [null, 'count'],
    'snapshot-job-allocated-bytes': [null, 'bytes'],
  },
};

const OWNER_METRICS = [
  'owner_capture_us',
  'input_effect_us',
  'token_wait_us',
  'complete_admission_us',
  'bulk_cpu_us',
  'followup_arm_us',
  'owner_wakes',
  'admitted_records',
  'admitted_sealed_bytes',
  'first_original_admission_us',
  'last_original_admission_us',
  'original_admission_count',
] as const;
const FULL_METRICS = [
  'capture_us',
  'capture_allocations',
  'capture_allocated_bytes',
  'bulk_us',
  'bulk_allocations',
  'bulk_allocated_bytes',
  'partition_us',
  'first_partition_us',
  'compression_us',
  'partition_calls',
  'records',
  'fec_bytes',
  'primary_wire_bytes',
  'primary_datagrams',
  'primary_reliable_records',
  'interactive_queue_us',
  'interactive_cpu_us',
] as const;
const OWNER_LATENCY = [
  'complete_admission_us',
  'token_wait_us',
  'first_original_admission_us',
  'last_original_admission_us',
];
const FULL_LATENCY = ['bulk_us', 'interactive_queue_us', 'interactive_cpu_us'];
export const NATIVE_PACKING_CONTRACT = [
  'coverage=plain-dictionary,single-edge,clean-loss',
  'cold=cold-planning-model,warmed-worker-and-compressor',
  'learned=arm-specific-emitted-online-trajectory',
  'snapshot-stage=identical-thermal-control-not-candidate-evidence',
  'primary=input-to-complete-admission,cold-model,384x256,50ms',
  'primary-p95-required-reduction=25-percent',
  'ordinary-and-learned-p95-regression-guard=max(5-percent,25us)',
  'bulk-completion-and-first-last-original-admission-p95-regression-guard=max(5-percent,25us)',
  'all-case-p99-regression-guard-each-AB-BA-stratum=max(10-percent,100us)',
  'max=diagnostic',
  'physical-bytes-and-records=exact-no-increase-for-unqualified-advancement',
  'promotion-requires=real-reliable-backlog,loss,jitter,first-and-completed-pixel-noninferiority',
].join(' ');

function fields(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of line.split(' ').slice(1)) {
    const delimiter = field.indexOf('=');
    if (delimiter <= 0) throw new Error(`Malformed sample field: ${field}`);
    const key = field.slice(0, delimiter);
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate field: ${key}`);
    result[key] = field.slice(delimiter + 1);
  }
  return result;
}

function numberField(row: Record<string, string>, key: string): number {
  const source = row[key];
  const value = source === undefined || source.length === 0 ? Number.NaN : Number(source);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid numeric field: ${key}`);
  return value;
}

function exactKeys(row: Record<string, string>, allowed: readonly string[]): void {
  if (Object.keys(row).length !== allowed.length || allowed.some((key) => !Object.hasOwn(row, key)))
    throw new Error('Unknown or missing sample/summary field');
}

function cases(population: Population): Set<string> {
  const result = new Set<string>();
  const shapes = [
    [120, 40, false],
    [384, 256, false],
    [384, 256, true],
  ];
  if (population === 'full') shapes.push([512, 192, true]);
  for (const rtt of [50, 120, 200])
    for (const shape of shapes)
      for (const learned of [false, true]) {
        const base = [rtt, ...shape, learned].join('/');
        if (population === 'owner')
          for (const header of [false, true]) result.add(`${base}/${header}`);
        else result.add(base);
      }
  return result;
}

function parse(text: string, population: Population): Map<string, Group> {
  const lines = text.split('\n');
  const contract = `WHOLE_SPAN_COMPARISON_CONTRACT ${NATIVE_PACKING_CONTRACT}`;
  const testName = population === 'owner' ? 'owner_loop' : 'full_job';
  // Single-thread libtest prints its test label without a newline before the
  // first uncaptured record. Accept only this exact known harness prefix;
  // the contract itself and every sample/summary key remain exact.
  const libtestContract = `test display::send::tests::whole_span_candidate_${testName}_benchmark ... ${contract}`;
  if (!lines.includes(contract) && !lines.includes(libtestContract))
    throw new Error('Missing exact predeclared contract');
  if (!/test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(text))
    throw new Error('Benchmark did not finish successfully');
  const prefix = population === 'owner' ? 'OWNER_INTERFERENCE_SAMPLE ' : 'FULL_PREPARE_SAMPLE ';
  const groups = new Map<string, Group>();
  const expectedCases = cases(population);
  const caseFields = ['quote_rtt_ms', 'cols', 'rows', 'entropy', 'learned_peer'];
  if (population === 'owner') caseFields.push('header_only');
  const baseFields = ['arm', 'order_pass', ...caseFields];
  const rawMetrics = population === 'owner' ? OWNER_METRICS : FULL_METRICS;
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    const row = fields(line);
    exactKeys(row, [...baseFields, 'sample', ...rawMetrics]);
    const arm = row.arm;
    if (arm !== 'adaptive' && arm !== 'whole-span') throw new Error('Unexpected arm');
    const order = numberField(row, 'order_pass');
    if (order !== 0 && order !== 1) throw new Error('Unexpected AB/BA pass');
    const caseKey = caseFields.map((key) => row[key]).join('/');
    if (!expectedCases.has(caseKey)) throw new Error(`Unexpected case: ${caseKey}`);
    const key = `${caseKey}/${order}/${arm}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { population, caseKey, order, arm, samples: new Map(), summaries: new Map() };
      groups.set(key, group);
    }
    const sample = numberField(row, 'sample');
    if (!Number.isInteger(sample) || sample >= 10_000 || group.samples.has(sample))
      throw new Error('Duplicate or invalid sample ordinal');
    const values: Record<string, number> = {};
    for (const metric of rawMetrics) {
      values[metric] = numberField(row, metric);
      if (!metric.endsWith('_us') && !Number.isInteger(values[metric]))
        throw new Error('Fractional count/byte metric');
    }
    group.samples.set(sample, values);
  }
  if (groups.size !== expectedCases.size * 4)
    throw new Error(`Incomplete ${population} case/arm/order population`);
  let populationSize: number | undefined;
  for (const group of groups.values()) {
    const n = group.samples.size;
    if (n < 100 || (populationSize !== undefined && n !== populationSize))
      throw new Error('Unequal or undersized sample population');
    populationSize = n;
    for (let index = 0; index < n; index++)
      if (!group.samples.has(index)) throw new Error('Noncontiguous sample population');
  }
  const summaryPrefix = population === 'owner' ? 'OWNER_INTERFERENCE ' : 'FULL_PREPARE ';
  const schema = NATIVE_PACKING_SUMMARIES[population];
  for (const line of lines) {
    if (!line.startsWith(summaryPrefix)) continue;
    const row = fields(line);
    const stage = row.stage;
    const spec = stage === undefined ? undefined : schema[stage];
    if (stage === undefined || spec === undefined) throw new Error('Unexpected summary stage');
    const [rawMetric, unit] = spec;
    const suffix = population === 'full' ? `_${unit}` : '';
    exactKeys(row, [
      ...baseFields,
      'samples',
      'stage',
      ...['p50', 'p95', 'p99', 'max'].map((key) => `${key}${suffix}`),
      ...(population === 'owner' ? ['ready_at_input', 'unit'] : ['bulk_completed_first']),
    ]);
    const group = groups.get(
      `${caseFields.map((key) => row[key]).join('/')}/${row.order_pass}/${row.arm}`,
    );
    if (group === undefined || group.summaries.has(stage))
      throw new Error('Unknown or duplicate summary population');
    const observed: Summary = {
      n: numberField(row, 'samples'),
      p50: numberField(row, `p50${suffix}`),
      p95: numberField(row, `p95${suffix}`),
      p99: numberField(row, `p99${suffix}`),
      max: numberField(row, `max${suffix}`),
    };
    if (
      observed.n !== group.samples.size ||
      observed.p50 > observed.p95 ||
      observed.p95 > observed.p99 ||
      observed.p99 > observed.max
    )
      throw new Error('Invalid summary population/order');
    const ready = numberField(
      row,
      population === 'owner' ? 'ready_at_input' : 'bulk_completed_first',
    );
    if (
      !Number.isInteger(ready) ||
      ready > observed.n ||
      (population === 'owner' && row.unit !== unit)
    )
      throw new Error('Invalid summary control metadata');
    if (rawMetric !== null) {
      const exact = summary(group, rawMetric);
      for (const key of ['p50', 'p95', 'p99', 'max'] as const)
        if (Math.abs(exact[key] - observed[key]) > 0.000501)
          throw new Error(`Summary/raw mismatch: ${stage}/${key}`);
    }
    group.summaries.set(stage, observed);
  }
  for (const group of groups.values())
    if (group.summaries.size !== Object.keys(schema).length)
      throw new Error('Incomplete summary-stage population');
  return groups;
}

function summary(group: Group, metric: string): Summary {
  const sorted = [...group.samples.values()]
    .map((row) => {
      const value = row[metric];
      if (value === undefined) throw new Error(`Missing metric ${metric}`);
      return value;
    })
    .sort((a, b) => a - b);
  const at = (p: number): number => {
    const value = sorted[Math.ceil(p * sorted.length) - 1];
    if (value === undefined) throw new Error('Empty percentile population');
    return value;
  };
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

export function replayNativePacking(ownerText: string, fullText: string) {
  const failures: Array<{
    population: Population;
    caseKey: string;
    order: number;
    metric: string;
    gate: string;
    sample?: number;
  }> = [];
  const comparisons: Array<{
    population: Population;
    caseKey: string;
    order: number;
    metrics: Record<string, { adaptive: Summary; wholeSpan: Summary }>;
  }> = [];
  const populationCounts: Record<Population, number> = { owner: 0, full: 0 };
  let matchedOwnerSamples = 0;
  let sampleCount: number | undefined;
  for (const [population, text] of [
    ['owner', ownerText],
    ['full', fullText],
  ] as const) {
    const groups = parse(text, population);
    for (const group of groups.values()) {
      populationCounts[population] += group.samples.size;
      if (sampleCount !== undefined && group.samples.size !== sampleCount)
        throw new Error('Owner/full sample populations differ');
      sampleCount = group.samples.size;
      if (group.arm !== 'adaptive') continue;
      const other = groups.get(`${group.caseKey}/${group.order}/whole-span`);
      if (other === undefined) throw new Error('Missing paired arm');
      const metrics: Record<string, { adaptive: Summary; wholeSpan: Summary }> = {};
      for (const metric of population === 'owner' ? OWNER_METRICS : FULL_METRICS) {
        const adaptive = summary(group, metric);
        const wholeSpan = summary(other, metric);
        metrics[metric] = { adaptive, wholeSpan };
        const latency = population === 'owner' ? OWNER_LATENCY : FULL_LATENCY;
        if (latency.includes(metric)) {
          if (wholeSpan.p95 - adaptive.p95 > Math.max(0.05 * adaptive.p95, 25))
            failures.push({
              population,
              caseKey: group.caseKey,
              order: group.order,
              metric,
              gate: 'p95-noninferiority',
            });
        }
        // The printed preregistration says all-case p99. Include common
        // capture and component CPU stages, even when a policy starts later;
        // a possible order/host effect is not permission to erase a violation.
        if (
          metric.endsWith('_us') &&
          wholeSpan.p99 - adaptive.p99 > Math.max(0.1 * adaptive.p99, 100)
        )
          failures.push({
            population,
            caseKey: group.caseKey,
            order: group.order,
            metric,
            gate: 'p99-noninferiority',
          });
        if (
          population === 'owner' &&
          metric === 'complete_admission_us' &&
          group.caseKey.startsWith('50/384/256/false/false/') &&
          wholeSpan.p95 > adaptive.p95 * 0.75
        )
          failures.push({
            population,
            caseKey: group.caseKey,
            order: group.order,
            metric,
            gate: 'primary-25-percent-p95-reduction',
          });
      }
      for (const [stage, [rawMetric, unit]] of Object.entries(
        NATIVE_PACKING_SUMMARIES[population],
      )) {
        if (rawMetric !== null) continue;
        const adaptive = group.summaries.get(stage);
        const wholeSpan = other.summaries.get(stage);
        if (adaptive === undefined || wholeSpan === undefined)
          throw new Error('Missing paired summary-only stage');
        metrics[`summary:${stage}`] = { adaptive, wholeSpan };
        if (unit === 'us' && wholeSpan.p99 - adaptive.p99 > Math.max(0.1 * adaptive.p99, 100))
          failures.push({
            population,
            caseKey: group.caseKey,
            order: group.order,
            metric: `summary:${stage}`,
            gate: 'p99-noninferiority',
          });
      }
      for (const [sample, baseline] of group.samples) {
        const candidate = other.samples.get(sample);
        if (candidate === undefined) throw new Error('Missing paired ordinal');
        if (population === 'owner') matchedOwnerSamples++;
        for (const metric of population === 'owner'
          ? ['admitted_records', 'admitted_sealed_bytes']
          : [
              'primary_wire_bytes',
              'primary_datagrams',
              'primary_reliable_records',
              'records',
              'fec_bytes',
            ]) {
          const before = baseline[metric];
          const after = candidate[metric];
          if (before === undefined || after === undefined)
            throw new Error('Missing physical metric');
          if (after > before)
            failures.push({
              population,
              caseKey: group.caseKey,
              order: group.order,
              metric,
              gate:
                population === 'owner'
                  ? 'exact-physical-noninferiority'
                  : 'exact-prepared-primary-noninferiority',
              sample,
            });
        }
      }
      comparisons.push({ population, caseKey: group.caseKey, order: group.order, metrics });
    }
  }
  return {
    scope: 'CPU and carrier submission only; not network delivery, GPU completion or photons',
    byteAccounting:
      'Owner counts actual sealed carrier submissions; full-job counts prepared originals plus parity, excluding replicas, probes and carrier packetization',
    contract: NATIVE_PACKING_CONTRACT,
    hashes: {
      owner: createHash('sha256').update(ownerText).digest('hex'),
      full: createHash('sha256').update(fullText).digest('hex'),
    },
    populationCounts,
    sampleCount,
    matchedOwnerSamples,
    advanceToRealDeliveryValidation: failures.length === 0,
    ownerEvidenceSupportsDeliveryExperiment: !failures.some(
      (failure) => failure.population === 'owner',
    ),
    commonCaptureAttribution:
      'Unresolved: policy begins after capture, but preceding work, cache/allocator state or host conditions may affect it; guard violations remain failures',
    productionAccepted: false,
    failures,
    comparisons,
  };
}

export function combineNativePackingReplicates(
  initial: ReturnType<typeof replayNativePacking>,
  replicate: ReturnType<typeof replayNativePacking>,
  build: { senderSourceSha256: string; testBinarySha256: string },
) {
  if (
    initial.hashes.owner !== replicate.hashes.owner ||
    initial.hashes.full === replicate.hashes.full
  )
    throw new Error('replication requires the same original owner run and distinct full-job runs');
  if (
    ![build.senderSourceSha256, build.testBinarySha256].every((value) =>
      /^[a-f0-9]{64}$/u.test(value),
    )
  )
    throw new Error('replication requires exact build hashes');
  const record = (report: ReturnType<typeof replayNativePacking>) => ({
    rawHashes: report.hashes,
    reportSha256: createHash('sha256')
      .update(`${JSON.stringify(report, null, 2)}\n`)
      .digest('hex'),
    populationCounts: report.populationCounts,
    failures: report.failures,
    localReplayPassed: report.failures.length === 0,
  });
  return {
    scope: 'Full-job replication; the owner artifact is reused, NOT remeasured',
    build: {
      ...build,
      attribution:
        'Supplied build files rehashed at replication replay; original benchmark raw did not embed build attribution',
    },
    initial: record(initial),
    replicate1: record(replicate),
    measuredOwnerRuns: 1,
    measuredFullJobRuns: 2,
    predeclaredCrossRunResolutionRule: null,
    combinedVerdict:
      initial.failures.length === 0 && replicate.failures.length === 0
        ? 'no-observed-native-guard-violations-delivery-unvalidated'
        : 'discordant-or-failed-native-evidence-inconclusive',
    originalFailuresRetained: initial.failures,
    advanceToRealDeliveryValidation: false,
    ownerEvidenceSupportsAuthorizedDeliveryDiagnostic:
      initial.ownerEvidenceSupportsDeliveryExperiment,
    productionAccepted: false,
  };
}

if (import.meta.main) {
  const [ownerPath, fullPath, replicatePath, senderPath, binaryPath, extra] = process.argv.slice(2);
  if (
    ownerPath === undefined ||
    fullPath === undefined ||
    extra !== undefined ||
    (replicatePath === undefined
      ? senderPath !== undefined || binaryPath !== undefined
      : senderPath === undefined || binaryPath === undefined)
  )
    throw new Error(
      'Usage: bun run bench:packing:replay <owner.log> <full-job.log> [<replicate-full.log> <sender.rs> <test-binary>]',
    );
  const owner = readFileSync(ownerPath, 'utf8');
  const initial = replayNativePacking(owner, readFileSync(fullPath, 'utf8'));
  const report =
    replicatePath !== undefined && senderPath !== undefined && binaryPath !== undefined
      ? combineNativePackingReplicates(
          initial,
          replayNativePacking(owner, readFileSync(replicatePath, 'utf8')),
          {
            senderSourceSha256: createHash('sha256').update(readFileSync(senderPath)).digest('hex'),
            testBinarySha256: createHash('sha256').update(readFileSync(binaryPath)).digest('hex'),
          },
        )
      : initial;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.advanceToRealDeliveryValidation) process.exitCode = 1;
}
