export interface RequiredCheck {
  readonly label: string;
  readonly kind: 'test' | 'build';
  readonly fresh: boolean;
}

export interface CheckResult extends RequiredCheck {
  readonly configuration: string | null;
  readonly status: 'passed' | 'failed' | 'pending';
  readonly origin: 'executed' | 'local-cache' | 'remote-cache' | 'mixed' | 'unreported';
  readonly attempts: number;
  /**
   * What the check's attempts took to execute, summed. A cached attempt reports the execution
   * it replays, so this is the check's cost whenever its inputs change. `null` for a build, and
   * for a test with an attempt the engine gave no duration.
   */
  readonly durationMs: number | null;
}

export interface EventReport {
  readonly invocation: string | null;
  readonly buildToolVersion: string | null;
  readonly complete: boolean;
  readonly exitCode: number | null;
  readonly checks: readonly CheckResult[];
  readonly problems: readonly string[];
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function configuration(value: ObjectValue): string | null {
  return object(value.configuration) && typeof value.configuration.id === 'string'
    ? value.configuration.id
    : null;
}

function origin(attempts: readonly ObjectValue[]): CheckResult['origin'] {
  const origins = new Set(
    attempts.map((attempt) => {
      if (attempt.cachedLocally === true) return 'local-cache';
      if (object(attempt.executionInfo) && attempt.executionInfo.cachedRemotely === true) {
        return 'remote-cache';
      }
      return 'executed';
    }),
  );
  if (origins.size > 1) return 'mixed';
  return origins.values().next().value ?? 'unreported';
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The engine writes a duration as decimal seconds: `12.345s`. */
function duration(attempts: readonly ObjectValue[]): number | null {
  let total = 0;
  for (const attempt of attempts) {
    const match =
      typeof attempt.testAttemptDuration === 'string'
        ? /^(\d+)(?:\.(\d{1,9}))?s$/.exec(attempt.testAttemptDuration)
        : null;
    if (match === null) return null;
    total += Number(match[1]) * 1000 + Math.round(Number(`0.${match[2] ?? '0'}`) * 1000);
  }
  return attempts.length === 0 ? null : total;
}

function collectTargetEvents(
  event: ObjectValue & { id: ObjectValue },
  problems: string[],
  completed: Map<string, ObjectValue[]>,
  summaries: Map<string, ObjectValue[]>,
  attempts: Map<string, ObjectValue[]>,
): void {
  for (const [name, payload, collection] of [
    ['targetCompleted', 'completed', completed],
    ['testSummary', 'testSummary', summaries],
    ['testResult', 'testResult', attempts],
  ] as const) {
    const id = event.id[name];
    if (!object(id) || typeof id.label !== 'string') continue;
    // Aspect completions are separate from the requested target's build completion.
    if (name === 'targetCompleted' && typeof id.aspect === 'string' && id.aspect !== '') continue;
    if (
      name === 'testResult' &&
      ['run', 'shard', 'attempt'].some((field) => {
        const value = count(id[field]);
        return value === null || value === 0;
      })
    )
      problems.push(`${id.label}: missing or invalid test attempt identity`);
    const value = event[payload];
    const values = collection.get(id.label) ?? [];
    values.push({ configuration: configuration(id), identity: id, payload: value });
    collection.set(id.label, values);
  }
}

function cacheProblem(
  result: ObjectValue,
  runs: readonly ObjectValue[],
  runPayloads: readonly ObjectValue[],
): string | null {
  if (count(result.totalRunCount) !== runs.length || runPayloads.length !== runs.length) {
    return 'inconsistent test attempt inventory';
  }
  if (
    runPayloads.some(
      (run) =>
        (run.cachedLocally !== undefined && typeof run.cachedLocally !== 'boolean') ||
        (run.executionInfo !== undefined && !object(run.executionInfo)) ||
        (object(run.executionInfo) &&
          run.executionInfo.cachedRemotely !== undefined &&
          typeof run.executionInfo.cachedRemotely !== 'boolean'),
    )
  ) {
    return 'invalid test cache evidence';
  }
  const cached = count(result.totalNumCached ?? 0);
  const countedCached = runPayloads.filter(
    (run) =>
      run.cachedLocally === true ||
      (object(run.executionInfo) && run.executionInfo.cachedRemotely === true),
  ).length;
  if (cached === null || cached !== countedCached) {
    return 'inconsistent cached test attempt inventory';
  }
  return null;
}

function retryProblem(result: ObjectValue, runs: readonly ObjectValue[]): string | null {
  for (const field of ['runCount', 'attemptCount', 'shardCount']) {
    if (result[field] !== undefined && count(result[field]) === null) {
      return `invalid ${field}`;
    }
  }
  const runCount = count(result.runCount ?? 1);
  const shardCount = Math.max(count(result.shardCount ?? 0) ?? 0, 1);
  const attemptCount = count(result.attemptCount ?? 1);
  const groups = new Map<string, Set<number>>();
  const shardAttempts = new Map<number, number>();
  for (const run of runs) {
    const id = run.identity;
    if (!object(id)) return 'invalid test attempt identity';
    const runNumber = count(id.run);
    const shardNumber = count(id.shard);
    const attemptNumber = count(id.attempt);
    if (
      runCount === null ||
      attemptCount === null ||
      runNumber === null ||
      shardNumber === null ||
      attemptNumber === null ||
      runNumber < 1 ||
      runNumber > runCount ||
      shardNumber < 1 ||
      shardNumber > shardCount ||
      attemptNumber < 1 ||
      attemptNumber > attemptCount
    ) {
      return 'test identity exceeds summary dimensions';
    }
    const key = `${runNumber}:${shardNumber}`;
    const group = groups.get(key) ?? new Set<number>();
    group.add(attemptNumber);
    groups.set(key, group);
    shardAttempts.set(shardNumber, (shardAttempts.get(shardNumber) ?? 0) + 1);
  }
  if (
    runCount === null ||
    runCount < 1 ||
    groups.size !== runCount * shardCount ||
    Math.max(...shardAttempts.values()) !== attemptCount ||
    [...groups.values()].some((group) => [...group].some((attempt) => attempt > group.size))
  ) {
    return 'incomplete run, shard or retry inventory';
  }
  return null;
}

function announceChildren(
  event: ObjectValue,
  identity: string,
  announced: Set<string>,
  problems: string[],
): void {
  if (event.children !== undefined && !Array.isArray(event.children)) {
    problems.push(`Invalid BEP children: ${identity}`);
  }
  if (Array.isArray(event.children)) {
    for (const child of event.children) {
      if (!object(child) || Object.keys(child).length !== 1) {
        problems.push(`Invalid BEP child identity: ${identity}`);
      } else announced.add(canonical(child));
    }
  }
}

/** Parse the pinned Bazel BEP stream, checking the announced event graph to detect truncation. */
export function readBuildEvents(text: string, required: readonly RequiredCheck[]): EventReport {
  const problems: string[] = [];
  if (required.length === 0) problems.push('Verification inventory is empty');
  if (
    required.some(
      (check) =>
        !object(check) ||
        typeof check.label !== 'string' ||
        !/^(?:@@?[^/]+)?\/\/[^:\s]*:[^:\s]+$/.test(check.label) ||
        !['test', 'build'].includes(check.kind) ||
        typeof check.fresh !== 'boolean',
    )
  )
    problems.push('Verification inventory contains an invalid required check');
  if (new Set(required.map((check) => check.label)).size !== required.length)
    problems.push('Verification inventory contains duplicate targets');
  const seen = new Set<string>();
  const announced = new Set<string>();
  const completed = new Map<string, ObjectValue[]>();
  const summaries = new Map<string, ObjectValue[]>();
  const attempts = new Map<string, ObjectValue[]>();
  let invocation: string | null = null;
  let buildToolVersion: string | null = null;
  let exitCode: number | null = null;
  let closed = false;
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      problems.push(`Invalid BEP JSON at line ${index + 1}`);
      continue;
    }
    if (!object(event) || !object(event.id) || Object.keys(event.id).length !== 1) {
      problems.push(`Missing BEP event identity at line ${index + 1}`);
      continue;
    }
    if (closed) problems.push('BEP event after lastMessage');
    const identity = canonical(event.id);
    // A fetch is identified by its URL alone, and two repositories may download the same one.
    if (seen.has(identity) && !('fetch' in event.id))
      problems.push(`Duplicate BEP event: ${identity}`);
    seen.add(identity);
    announceChildren(event, identity, announced, problems);
    if (event.lastMessage === true) closed = true;
    if ('started' in event.id) {
      if (!object(event.started) || typeof event.started.uuid !== 'string') {
        problems.push('Missing BEP invocation UUID');
      } else invocation = event.started.uuid;
      if (object(event.started) && typeof event.started.buildToolVersion === 'string')
        buildToolVersion = event.started.buildToolVersion;
    }
    if ('buildFinished' in event.id) {
      if (!object(event.finished) || !object(event.finished.exitCode)) {
        problems.push('Missing BEP exit code');
      } else exitCode = count(event.finished.exitCode.code ?? 0);
    }
    collectTargetEvents({ ...event, id: event.id }, problems, completed, summaries, attempts);
  }
  if (invocation === null) problems.push('Missing BEP start event');
  if (buildToolVersion === null) problems.push('Missing BEP build tool identity');
  if (exitCode === null) problems.push('Missing BEP finished event');
  if (!closed) problems.push('Missing BEP lastMessage');
  for (const identity of announced) {
    if (!seen.has(identity)) problems.push(`Missing announced BEP event: ${identity}`);
  }
  const checks = required.map((check): CheckResult => {
    const builds = completed.get(check.label) ?? [];
    const summary = summaries.get(check.label) ?? [];
    const runs = attempts.get(check.label) ?? [];
    const configs = new Set([...builds, ...summary, ...runs].map((value) => value.configuration));
    const config = configs.size === 1 ? [...configs][0] : null;
    const pending: CheckResult = {
      ...check,
      configuration: typeof config === 'string' ? config : null,
      status: 'pending',
      origin: 'unreported',
      attempts: runs.length,
      durationMs: duration(runs.map((run) => run.payload).filter(object)),
    };
    if (builds.length !== 1 || config === null || typeof config !== 'string') {
      problems.push(`${check.label}: missing or ambiguous configured build result`);
      return pending;
    }
    const build = builds[0]?.payload;
    if (!object(build) || build.success !== true) return { ...pending, status: 'failed' };
    if (check.kind === 'build') {
      if (check.fresh) {
        problems.push(`${check.label}: missing fresh build execution receipt`);
        return pending;
      }
      return { ...pending, status: 'passed' };
    }
    const result = summary[0]?.payload;
    if (summary.length !== 1 || !object(result) || runs.length === 0) {
      problems.push(`${check.label}: missing or ambiguous test result`);
      return pending;
    }
    const runPayloads = runs.map((run) => run.payload).filter(object);
    const evidenceProblem = cacheProblem(result, runs, runPayloads) ?? retryProblem(result, runs);
    if (evidenceProblem !== null) {
      problems.push(`${check.label}: ${evidenceProblem}`);
      return pending;
    }
    const resultOrigin = origin(runPayloads);
    if (check.fresh && resultOrigin !== 'executed') {
      problems.push(`${check.label}: required fresh execution was cached`);
      return { ...pending, origin: resultOrigin };
    }
    const passed =
      result.overallStatus === 'PASSED' && runPayloads.every((run) => run.status === 'PASSED');
    return { ...pending, status: passed ? 'passed' : 'failed', origin: resultOrigin };
  });
  return {
    invocation,
    buildToolVersion,
    complete: problems.length === 0,
    exitCode,
    checks,
    problems,
  };
}
