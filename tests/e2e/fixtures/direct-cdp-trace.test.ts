import { describe, expect, jest, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DIRECT_GPU_TRACE_CATEGORIES,
  type DirectTraceDriver,
  markDirectTraceClock,
  persistTerminalGpuTraceArtifact,
  selectDirectTraceWorker,
  startDirectTraceCollector,
  validateDirectTraceClockCoverage,
} from './direct-cdp-trace';

test('diagnostic bytes persist before path attachment even with a body-discarding reporter', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'merkur-trace-artifact-'));
  const artifact = path.join(directory, 'trace.json');
  try {
    let attached = false;
    await persistTerminalGpuTraceArtifact(
      {
        outputPath: (name) => path.join(directory, name),
        async attach(name, options) {
          if (options === undefined) throw new Error('missing artifact attachment options');
          expect(name).toBe('trace.json');
          expect(options.path).toBe(artifact);
          expect(options.body).toBeUndefined();
          expect(readFileSync(artifact, 'utf8')).toBe('{"traceEvents":[]}');
          attached = true;
        },
      },
      'trace.json',
      Buffer.from('{"traceEvents":[]}'),
    );
    expect(attached).toBe(true);
    expect(readFileSync(artifact, 'utf8')).toBe('{"traceEvents":[]}');
  } finally {
    rmSync(artifact, { force: true });
    rmdirSync(directory);
  }
});

test('a frozen page clock mark rejects at the existing command deadline', async () => {
  // Virtual time: the 15-second command deadline elapses without the wall clock.
  jest.useFakeTimers();
  try {
    let evaluations = 0;
    let rejection: unknown;
    const mark = markDirectTraceClock(
      {
        evaluate: () => {
          evaluations += 1;
          return new Promise<never>(() => {});
        },
      },
      'begin',
    ).catch((error: unknown) => {
      rejection = error;
    });
    jest.advanceTimersByTime(14_999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejection).toBeUndefined();
    jest.advanceTimersByTime(1);
    await mark;
    if (!(rejection instanceof Error)) throw new Error('the frozen mark did not reject');
    expect(rejection.message).toBe('Chrome trace command timed out');
    expect(evaluations).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});

function driver(
  options: {
    loss?: boolean;
    noStream?: boolean;
    failRead?: boolean;
    empty?: boolean;
    failStart?: boolean;
    full?: boolean;
    expandedJson?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let listener: Parameters<DirectTraceDriver['onComplete']>[0] | undefined;
  let ordinal = 0;
  let usage: ((fraction: number) => void) | undefined;
  const expandedChunk = options.expandedJson ? ' '.repeat(1024 * 1024) : '';
  const value: DirectTraceDriver = {
    async start() {
      calls.push('start');
      usage?.(options.full ? 1 : 0.1);
      if (options.failStart) throw new Error('start refused');
    },
    async end() {
      calls.push('end');
      listener?.({
        dataLossOccurred: options.loss ?? false,
        ...(options.noStream ? {} : { stream: 'trace' }),
      });
    },
    onComplete(callback) {
      calls.push('subscribe');
      listener = callback;
      return () => {
        calls.push('unsubscribe');
        listener = undefined;
      };
    },
    onBufferUsage(callback) {
      usage = callback;
      return () => {
        usage = undefined;
      };
    },
    async read(handle, size) {
      expect(handle).toBe('trace');
      expect(size).toBe(1024 * 1024);
      calls.push('read');
      if (options.failRead) throw new Error('read failed');
      if (options.empty) return { data: '', eof: false };
      ordinal += 1;
      if (options.expandedJson) return { data: expandedChunk, eof: ordinal === 65 };
      return ordinal === 1
        ? { data: '{"traceEvents":', eof: false }
        : { data: Buffer.from('[]}').toString('base64'), base64Encoded: true, eof: true };
    },
    async close(handle) {
      expect(handle).toBe('trace');
      calls.push('close');
    },
    async detach() {
      calls.push('detach');
    },
  };
  return { value, calls };
}

describe('bounded diagnostic Chrome trace ownership', () => {
  test('subscribes before end, reads both encodings, and closes/detaches exactly once', async () => {
    const mock = driver();
    const collector = await startDirectTraceCollector(mock.value);
    const first = collector.stop();
    const second = collector.stop();
    expect(second).toBe(first);
    const result = await first;
    expect(result.complete).toBe(true);
    expect(result.body.toString()).toBe('{"traceEvents":[]}');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mock.calls).toEqual([
      'start',
      'subscribe',
      'end',
      'read',
      'read',
      'unsubscribe',
      'close',
      'detach',
    ]);
  });

  test('retains a lossy artifact but never labels it complete', async () => {
    const mock = driver({ loss: true });
    const result = await (await startDirectTraceCollector(mock.value)).stop();
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.complete).toBe(false);
    expect(result.errors).toContain('Chromium reported trace data loss');
  });

  test('record-until-full truncation fails even without a data-loss flag', async () => {
    const result = await (await startDirectTraceCollector(driver({ full: true }).value)).stop();
    expect(result.complete).toBe(false);
    expect(result.errors).toContain('trace buffer reached capacity');
  });

  test('serialized output can exceed native capacity without claiming native loss', async () => {
    // The collector owns opaque stream bytes; clock coverage separately validates JSON.
    const result = await (
      await startDirectTraceCollector(driver({ expandedJson: true }).value)
    ).stop();
    expect(result.complete).toBe(true);
    expect(result.byteLength).toBe(65 * 1024 * 1024);
    expect(result.nativeBufferByteLimit).toBe(64 * 1024 * 1024);
    expect(result.serializedByteLimit).toBe(256 * 1024 * 1024);
    expect(result.maximumBufferUsage).toBe(0.1);
  });

  test('missing stream does not skip listener and session cleanup', async () => {
    const mock = driver({ noStream: true });
    const result = await (await startDirectTraceCollector(mock.value)).stop();
    expect(result.complete).toBe(false);
    expect(result.errors).toContain('Chromium returned no trace stream');
    expect(mock.calls).toEqual(['start', 'subscribe', 'end', 'unsubscribe', 'detach']);
  });

  test('read failure and empty progress close the owned handle', async () => {
    for (const options of [{ failRead: true }, { empty: true }]) {
      const mock = driver(options);
      const result = await (await startDirectTraceCollector(mock.value)).stop();
      expect(result.complete).toBe(false);
      expect(mock.calls.slice(-3)).toEqual(['unsubscribe', 'close', 'detach']);
      expect(mock.calls.filter((call) => call === 'read')).toHaveLength(1);
    }
  });

  test('startup failure detaches without manufacturing a trace', async () => {
    const mock = driver({ failStart: true });
    await expect(startDirectTraceCollector(mock.value)).rejects.toThrow('start refused');
    expect(mock.calls).toEqual(['start', 'detach']);
  });

  test('categories do not enable screenshots, sampling or memory dumps', () => {
    expect(DIRECT_GPU_TRACE_CATEGORIES).toContain('blink');
    expect(DIRECT_GPU_TRACE_CATEGORIES).toContain('blink.user_timing');
    expect(DIRECT_GPU_TRACE_CATEGORIES).not.toContain('cc');
    expect(DIRECT_GPU_TRACE_CATEGORIES).toContain('graphics.pipeline');
    expect(DIRECT_GPU_TRACE_CATEGORIES).toContain('disabled-by-default-gpu.dawn');
    expect(
      DIRECT_GPU_TRACE_CATEGORIES.some((name) => /screenshot|memory|sampling/.test(name)),
    ).toBe(false);
  });

  test('worker identity requires one exact served asset URL, not a substring', () => {
    const url = 'http://127.0.0.1:4000/assets/terminal-worker-abcdef.js';
    const worker = { url: () => url };
    const unrelated = { url: () => `${url}?other-owner` };
    expect(selectDirectTraceWorker([unrelated, worker], url)).toBe(worker);
    expect(() => selectDirectTraceWorker([unrelated], url)).toThrow('exactly one worker');
    expect(() => selectDirectTraceWorker([worker, { url: () => url }], url)).toThrow(
      'exactly one worker',
    );
    expect(() => selectDirectTraceWorker([], url)).toThrow('exactly one worker');
  });

  test('clock marks bind one page owner and bracket actual GPU/Viz work', () => {
    const begin = { name: 'begin', localMs: 10, timeOriginMs: 1000, epochMs: 1010 };
    const end = { name: 'end', localMs: 20, timeOriginMs: 1000, epochMs: 1020 };
    const events = [
      { cat: 'blink.user_timing', name: 'begin', ts: 10000, pid: 1, tid: 2 },
      {
        cat: 'toplevel,toplevel.flow,gpu,viz,graphics.pipeline',
        name: 'draw',
        ts: 15000,
        pid: 3,
        tid: 4,
      },
      { cat: 'blink.user_timing', name: 'end', ts: 20000, pid: 1, tid: 2 },
    ];
    const body = (traceEvents: typeof events) => Buffer.from(JSON.stringify({ traceEvents }));
    expect(validateDirectTraceClockCoverage(body(events), begin, end)).toMatchObject({
      complete: true,
      epochOffsetMs: 1000,
    });
    for (const missingCategory of ['toplevel.flow', 'graphics.pipeline']) {
      const incomplete = events.map((event) => ({
        ...event,
        cat: event.cat
          .split(',')
          .filter((category) => category !== missingCategory)
          .join(','),
      }));
      expect(validateDirectTraceClockCoverage(body(incomplete), begin, end)).toMatchObject({
        complete: false,
        errors: [`no ${missingCategory} events inside trace marks`],
      });
    }
    expect(validateDirectTraceClockCoverage(body(events.slice(0, 2)), begin, end).complete).toBe(
      false,
    );
    const first = events[0];
    if (first === undefined) throw new Error('missing test begin mark');
    expect(validateDirectTraceClockCoverage(body([...events, first]), begin, end).complete).toBe(
      false,
    );
    expect(
      validateDirectTraceClockCoverage(body(events), begin, { ...end, epochMs: 1022 }).complete,
    ).toBe(false);
    expect(
      validateDirectTraceClockCoverage(
        body(events.filter((event) => event.name !== 'draw')),
        begin,
        end,
      ).complete,
    ).toBe(false);
  });
});
