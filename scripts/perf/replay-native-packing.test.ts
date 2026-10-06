import { expect, test } from 'bun:test';
import {
  combineNativePackingReplicates,
  NATIVE_PACKING_CONTRACT,
  NATIVE_PACKING_SUMMARIES,
  replayNativePacking,
} from './replay-native-packing';

test('replication retains failed initial gates with an explicit inconclusive combined verdict', () => {
  const initial = replayNativePacking(
    owner,
    resummarize(full.replace('capture_us=100', 'capture_us=300')),
  );
  const failed = {
    population: 'full' as const,
    caseKey: '50/384/256/true/false',
    order: 0,
    metric: 'capture_us',
    gate: 'p99-noninferiority',
  };
  initial.failures.push(failed);
  const repeat = replayNativePacking(owner, `${full}\n`);
  const combined = combineNativePackingReplicates(initial, repeat, {
    senderSourceSha256: 'a'.repeat(64),
    testBinarySha256: 'b'.repeat(64),
  });
  expect(combined.originalFailuresRetained).toContainEqual(failed);
  expect(combined.replicate1.localReplayPassed).toBe(true);
  expect(combined.predeclaredCrossRunResolutionRule).toBeNull();
  expect(combined.combinedVerdict).toBe('discordant-or-failed-native-evidence-inconclusive');
  expect(combined.advanceToRealDeliveryValidation).toBe(false);
  expect(combined.productionAccepted).toBe(false);
  expect(combined.measuredOwnerRuns).toBe(1);
});

function resummarize(text: string): string {
  const lines = text
    .split('\n')
    .filter((line) => !/^(OWNER_INTERFERENCE|FULL_PREPARE) /.test(line));
  const groups = new Map<
    string,
    { population: 'owner' | 'full'; metadata: string; n: number; values: Map<string, number[]> }
  >();
  for (const line of lines) {
    const match = /^(OWNER_INTERFERENCE|FULL_PREPARE)_SAMPLE (.+) sample=\d+ (.+)$/.exec(line);
    if (match === null) continue;
    const [, prefix, metadata, values] = match;
    if (metadata === undefined || values === undefined) throw new Error('Malformed fixture');
    const key = `${prefix}/${metadata}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        population: prefix === 'OWNER_INTERFERENCE' ? 'owner' : 'full',
        metadata,
        n: 0,
        values: new Map(),
      };
      groups.set(key, group);
    }
    group.n++;
    for (const field of values.split(' ')) {
      const [metric, value] = field.split('=');
      if (metric === undefined) throw new Error('Malformed fixture metric');
      const population = group.values.get(metric) ?? [];
      population.push(Number(value));
      group.values.set(metric, population);
    }
  }
  for (const group of groups.values())
    for (const [stage, [metric, unit]] of Object.entries(
      NATIVE_PACKING_SUMMARIES[group.population],
    )) {
      const values =
        metric === null
          ? Array(group.n).fill(group.metadata.includes('arm=adaptive ') ? 100 : 50)
          : group.values.get(metric);
      if (values === undefined) throw new Error('Missing fixture summary input');
      values.sort((a, b) => a - b);
      const suffix = group.population === 'full' ? `_${unit}` : '';
      const quantiles = [
        ['p50', 0.5],
        ['p95', 0.95],
        ['p99', 0.99],
        ['max', 1],
      ] as const;
      lines.push(
        `${group.population === 'owner' ? 'OWNER_INTERFERENCE' : 'FULL_PREPARE'} ${group.metadata} samples=${group.n} stage=${stage} ${quantiles.map(([key, p]) => `${key}${suffix}=${values[Math.ceil(p * group.n) - 1]}`).join(' ')} ${group.population === 'owner' ? `ready_at_input=100 unit=${unit}` : 'bulk_completed_first=100'}`,
      );
    }
  return lines.join('\n');
}

function fixture(owner: boolean): string {
  const lines = [`WHOLE_SPAN_COMPARISON_CONTRACT ${NATIVE_PACKING_CONTRACT}`];
  const metrics = owner
    ? 'owner_capture_us input_effect_us token_wait_us complete_admission_us bulk_cpu_us followup_arm_us owner_wakes admitted_records admitted_sealed_bytes first_original_admission_us last_original_admission_us original_admission_count'
    : 'capture_us capture_allocations capture_allocated_bytes bulk_us bulk_allocations bulk_allocated_bytes partition_us first_partition_us compression_us partition_calls records fec_bytes primary_wire_bytes primary_datagrams primary_reliable_records interactive_queue_us interactive_cpu_us';
  const shapes = [
    [120, 40, false],
    [384, 256, false],
    [384, 256, true],
  ];
  if (!owner) shapes.push([512, 192, true]);
  for (const rtt of [50, 120, 200])
    for (const [cols, rows, entropy] of shapes) {
      for (const learned of [false, true])
        for (const header of owner ? [false, true] : [false]) {
          for (const order of [0, 1])
            for (const arm of ['adaptive', 'whole-span']) {
              for (let sample = 0; sample < 100; sample++) {
                const values = metrics
                  .split(' ')
                  .map((metric) => `${metric}=${arm === 'adaptive' ? 100 : 50}`);
                lines.push(
                  `${owner ? 'OWNER_INTERFERENCE_SAMPLE' : 'FULL_PREPARE_SAMPLE'} arm=${arm} order_pass=${order} quote_rtt_ms=${rtt} cols=${cols} rows=${rows} entropy=${entropy} learned_peer=${learned}${owner ? ` header_only=${header}` : ''} sample=${sample} ${values.join(' ')}`,
                );
              }
            }
        }
    }
  lines.push('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured;');
  return resummarize(lines.join('\n'));
}

const owner = fixture(true);
const full = fixture(false);

test('replays every case, order and exact ordinal with nearest-rank summaries', () => {
  const report = replayNativePacking(owner, full);
  expect(report.populationCounts).toEqual({ owner: 14_400, full: 9_600 });
  expect(report.matchedOwnerSamples).toBe(7_200);
  expect(report.comparisons).toHaveLength(120);
  expect(report.failures).toEqual([]);
  expect(report.advanceToRealDeliveryValidation).toBe(true);
  expect(report.productionAccepted).toBe(false);
  expect(report.comparisons[0]?.metrics.complete_admission_us?.wholeSpan).toEqual({
    n: 100,
    p50: 50,
    p95: 50,
    p99: 50,
    max: 50,
  });
  expect(report.hashes.owner).toMatch(/^[0-9a-f]{64}$/);
});

test('retains an order-specific p99 failure that pooling would hide', () => {
  const modified = owner
    .split('\n')
    .map((line) => {
      if (
        line.includes(
          'arm=whole-span order_pass=0 quote_rtt_ms=50 cols=120 rows=40 entropy=false learned_peer=false header_only=false',
        ) &&
        / sample=9[89] /.test(line)
      )
        return line.replace('complete_admission_us=50', 'complete_admission_us=1000');
      return line;
    })
    .join('\n');
  const report = replayNativePacking(resummarize(modified), full);
  expect(report.failures).toContainEqual({
    population: 'owner',
    caseKey: '50/120/40/false/false/false',
    order: 0,
    metric: 'complete_admission_us',
    gate: 'p99-noninferiority',
  });
  expect(report.failures.some((failure) => failure.gate === 'p95-noninferiority')).toBe(false);
  expect(report.advanceToRealDeliveryValidation).toBe(false);
});

test('one physical ordinal increase fails despite lower medians', () => {
  const marker =
    'OWNER_INTERFERENCE_SAMPLE arm=whole-span order_pass=0 quote_rtt_ms=50 cols=120 rows=40 entropy=false learned_peer=false header_only=false sample=0 ';
  const modified = owner
    .split('\n')
    .map((line) =>
      line.startsWith(marker)
        ? line.replace('admitted_sealed_bytes=50', 'admitted_sealed_bytes=101')
        : line,
    )
    .join('\n');
  const report = replayNativePacking(resummarize(modified), full);
  expect(report.failures).toContainEqual({
    population: 'owner',
    caseKey: '50/120/40/false/false/false',
    order: 0,
    metric: 'admitted_sealed_bytes',
    gate: 'exact-physical-noninferiority',
    sample: 0,
  });
});

test('common pre-policy capture p99 violations are not narrowed out after timing', () => {
  const modified = full
    .split('\n')
    .map((line) => {
      if (
        line.includes(
          'arm=whole-span order_pass=0 quote_rtt_ms=50 cols=384 rows=256 entropy=true learned_peer=false',
        ) &&
        / sample=9[89] /.test(line)
      )
        return line.replace('capture_us=50', 'capture_us=1000');
      return line;
    })
    .join('\n');
  const report = replayNativePacking(owner, resummarize(modified));
  expect(report.failures).toContainEqual({
    population: 'full',
    caseKey: '50/384/256/true/false',
    order: 0,
    metric: 'capture_us',
    gate: 'p99-noninferiority',
  });
  expect(report.advanceToRealDeliveryValidation).toBe(false);
  expect(report.ownerEvidenceSupportsDeliveryExperiment).toBe(true);
});

test('missing, duplicated and nonfinite samples fail closed', () => {
  const first = owner.split('\n')[1];
  if (first === undefined) throw new Error('fixture missing sample');
  expect(() => replayNativePacking(owner.replace(`${first}\n`, ''), full)).toThrow(
    'Unequal or undersized',
  );
  expect(() => replayNativePacking(`${owner}\n${first}`, full)).toThrow('Duplicate or invalid');
  expect(() =>
    replayNativePacking(owner.replace('owner_capture_us=100', 'owner_capture_us=NaN'), full),
  ).toThrow('Invalid numeric');
});

test('unknown metrics and inconsistent printed summaries fail closed', () => {
  expect(() =>
    replayNativePacking(
      owner.replace('owner_capture_us=100', 'unknown_us=1 owner_capture_us=100'),
      full,
    ),
  ).toThrow('Unknown or missing');
  expect(() =>
    replayNativePacking(
      owner.replace(
        'stage=owner-selection-capture p50=100',
        'stage=owner-selection-capture p50=99',
      ),
      full,
    ),
  ).toThrow('Summary/raw mismatch');
});

test.each([
  'primary_wire_bytes',
  'primary_datagrams',
  'primary_reliable_records',
  'records',
  'fec_bytes',
])('full-only %s regressions cannot evade the physical gate', (metric) => {
  const marker =
    'FULL_PREPARE_SAMPLE arm=whole-span order_pass=0 quote_rtt_ms=200 cols=512 rows=192 entropy=true learned_peer=true sample=0 ';
  const changed = full
    .split('\n')
    .map((line) => (line.startsWith(marker) ? line.replace(`${metric}=50`, `${metric}=101`) : line))
    .join('\n');
  const result = replayNativePacking(owner, resummarize(changed));
  expect(result.failures).toContainEqual({
    population: 'full',
    caseKey: '200/512/192/true/true',
    order: 0,
    metric,
    gate: 'exact-prepared-primary-noninferiority',
    sample: 0,
  });
});

test('summary-only timed stages are required and keep their p99 guard', () => {
  const marker =
    'FULL_PREPARE arm=whole-span order_pass=0 quote_rtt_ms=50 cols=120 rows=40 entropy=false learned_peer=false samples=100 stage=partition-largest ';
  const changed = full
    .split('\n')
    .map((line) =>
      line.startsWith(marker)
        ? line.replace('p99_us=50 max_us=50', 'p99_us=1000 max_us=1000')
        : line,
    )
    .join('\n');
  expect(replayNativePacking(owner, changed).failures).toContainEqual({
    population: 'full',
    caseKey: '50/120/40/false/false',
    order: 0,
    metric: 'summary:partition-largest',
    gate: 'p99-noninferiority',
  });
  expect(() =>
    replayNativePacking(
      owner,
      full
        .split('\n')
        .filter((line) => !line.startsWith(marker))
        .join('\n'),
    ),
  ).toThrow('Incomplete summary-stage');
});

test('requires the exact predeclared contract and a successful benchmark footer', () => {
  expect(() =>
    replayNativePacking(
      owner.replace(
        'primary-p95-required-reduction=25-percent',
        'primary-p95-required-reduction=5-percent',
      ),
      full,
    ),
  ).toThrow('Missing exact');
  expect(() =>
    replayNativePacking(owner.replace('test result: ok.', 'test result: FAILED.'), full),
  ).toThrow('did not finish');
});

test('accepts only the exact single-thread libtest contract prefix', () => {
  const prefixedOwner = owner.replace(
    'WHOLE_SPAN_COMPARISON_CONTRACT',
    'test display::send::tests::whole_span_candidate_owner_loop_benchmark ... WHOLE_SPAN_COMPARISON_CONTRACT',
  );
  const prefixedFull = full.replace(
    'WHOLE_SPAN_COMPARISON_CONTRACT',
    'test display::send::tests::whole_span_candidate_full_job_benchmark ... WHOLE_SPAN_COMPARISON_CONTRACT',
  );
  expect(replayNativePacking(prefixedOwner, prefixedFull).failures).toHaveLength(0);
  expect(() =>
    replayNativePacking(
      prefixedOwner.replace('owner_loop_benchmark', 'unrelated_benchmark'),
      prefixedFull,
    ),
  ).toThrow('Missing exact predeclared contract');
});
