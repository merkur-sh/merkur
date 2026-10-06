import { describe, expect, test } from 'bun:test';
import { type RequiredCheck, readBuildEvents } from './events';
import { sanitizeBuildEvents } from './sanitize';

const label = '//test:unit';
const configured = { label, configuration: { id: 'test-config' } };
const required: readonly RequiredCheck[] = [{ label, kind: 'test', fresh: false }];

function stream(
  options: {
    cache?: 'local' | 'remote';
    status?: string;
    truncate?: boolean;
    duration?: unknown;
  } = {},
): string {
  const result = {
    status: options.status ?? 'PASSED',
    cachedLocally: options.cache === 'local',
    executionInfo: { cachedRemotely: options.cache === 'remote' },
    ...(options.duration === undefined ? {} : { testAttemptDuration: options.duration }),
  };
  const events: Record<string, unknown>[] = [
    {
      id: { started: {} },
      started: { uuid: 'current-invocation', buildToolVersion: '9.2.0' },
      children: [{ buildFinished: {} }],
    },
    { id: { targetCompleted: configured }, completed: { success: true } },
    { id: { testResult: { ...configured, run: 1, shard: 1, attempt: 1 } }, testResult: result },
    {
      id: { testSummary: configured },
      testSummary: {
        overallStatus: result.status,
        totalRunCount: 1,
        totalNumCached: options.cache === undefined ? 0 : 1,
      },
    },
    {
      id: { buildFinished: {} },
      finished: { exitCode: { name: 'SUCCESS', code: 0 } },
      lastMessage: true,
    },
  ];
  if (options.truncate) events.pop();
  return events.map((event) => JSON.stringify(event)).join('\n');
}

describe('current-invocation build event evidence', () => {
  test('reports executed and local/remote cached results separately', () => {
    for (const [cache, expected] of [
      [undefined, 'executed'],
      ['local', 'local-cache'],
      ['remote', 'remote-cache'],
    ] as const) {
      const report = readBuildEvents(stream({ cache }), required);
      expect(report.complete).toBe(true);
      expect(report.invocation).toBe('current-invocation');
      expect(report.checks[0]).toMatchObject({ status: 'passed', origin: expected, attempts: 1 });
    }
  });

  test('a check reports what its attempts took, through the sanitizer', () => {
    for (const [duration, expected] of [
      ['12.345s', 12_345],
      ['3s', 3000],
      ['0.000600s', 1],
      [undefined, null],
      ['12.345', null],
      [12, null],
    ] as const) {
      const report = readBuildEvents(sanitizeBuildEvents(stream({ duration })), required);
      expect(report.complete).toBe(true);
      expect(report.checks[0]?.durationMs).toBe(expected);
    }
    // A cached attempt carries the duration of the execution it replays.
    const cached = readBuildEvents(stream({ cache: 'local', duration: '2.5s' }), required);
    expect(cached.checks[0]).toMatchObject({ origin: 'local-cache', durationMs: 2500 });
  });

  test('a fresh check rejects cached execution', () => {
    const report = readBuildEvents(stream({ cache: 'remote' }), [
      { label, kind: 'test', fresh: true },
    ]);
    expect(report.complete).toBe(false);
    expect(report.checks[0]?.status).toBe('pending');
  });

  test('truncation, malformed JSON and duplicate events fail report validation', () => {
    expect(readBuildEvents(stream({ truncate: true }), required).complete).toBe(false);
    expect(readBuildEvents(`${stream()}\n{`, required).complete).toBe(false);
    const first = stream().split('\n')[0];
    expect(readBuildEvents(`${first}\n${stream()}`, required).complete).toBe(false);
  });

  test('an absent required target never becomes green from a successful invocation', () => {
    const report = readBuildEvents(stream(), [
      { label: '//test:missing', kind: 'test', fresh: false },
    ]);
    expect(report.complete).toBe(false);
    expect(report.checks[0]?.status).toBe('pending');
  });

  test('a failed or flaky attempt cannot be aggregated as passed', () => {
    for (const status of ['FAILED', 'TIMEOUT', 'INCOMPLETE', 'FLAKY']) {
      const report = readBuildEvents(stream({ status }), required);
      expect(report.checks[0]?.status).toBe('failed');
    }
  });

  test('announced but omitted events make even a terminated stream incomplete', () => {
    const text = stream().replace('"children":[', '"children":[{"progress":{"opaqueCount":99}},');
    expect(readBuildEvents(text, required).complete).toBe(false);
  });

  test('summary run inventory must match actual attempts', () => {
    const text = stream().replace('"totalRunCount":1', '"totalRunCount":2');
    expect(readBuildEvents(text, required).complete).toBe(false);
  });

  test('attemptCount sums attempts across runs for each shard', () => {
    const events = stream()
      .split('\n')
      .map((line) => JSON.parse(line));
    const second = {
      id: { testResult: { ...configured, run: 2, shard: 1, attempt: 1 } },
      testResult: { status: 'PASSED', cachedLocally: false },
    };
    events.splice(3, 0, second);
    const summary = events.find((event) => event.testSummary)?.testSummary;
    Object.assign(summary, { totalRunCount: 2, runCount: 2, shardCount: 0, attemptCount: 2 });
    expect(
      readBuildEvents(events.map((event) => JSON.stringify(event)).join('\n'), required).complete,
    ).toBe(true);
  });

  test('fresh builds require an execution receipt', () => {
    const report = readBuildEvents(stream(), [{ label, kind: 'build', fresh: true }]);
    expect(report.complete).toBe(false);
    expect(report.checks[0]?.status).toBe('pending');
  });

  test('summary dimensions require every run and shard', () => {
    const text = stream().replace(
      '"totalRunCount":1',
      '"totalRunCount":1,"runCount":1,"shardCount":4',
    );
    expect(readBuildEvents(text, required).complete).toBe(false);
    const invalid = stream().replace(
      '"run":1,"shard":1,"attempt":1',
      '"run":9,"shard":8,"attempt":7',
    );
    expect(readBuildEvents(invalid, required).complete).toBe(false);
  });

  test('malformed cache flags cannot count as executed', () => {
    for (const text of [
      stream().replace('"cachedLocally":false', '"cachedLocally":"false"'),
      stream().replace('"cachedRemotely":false', '"cachedRemotely":"false"'),
      stream().replace('"executionInfo":{"cachedRemotely":false}', '"executionInfo":false'),
    ]) {
      expect(readBuildEvents(text, [{ label, kind: 'test', fresh: true }]).complete).toBe(false);
    }
  });

  test('summary cache count and attempt identities must reconcile', () => {
    const raw = stream({ cache: 'remote' });
    const missingFlag = raw.replace('"cachedRemotely":true', '"cachedRemotely":false');
    expect(readBuildEvents(missingFlag, [{ label, kind: 'test', fresh: true }]).complete).toBe(
      false,
    );
    expect(
      readBuildEvents(raw.replace('"totalNumCached":1', '"totalNumCached":-1'), required).complete,
    ).toBe(false);
    expect(
      readBuildEvents(raw.replace(',"run":1,"shard":1,"attempt":1', ''), required).complete,
    ).toBe(false);
  });
});
