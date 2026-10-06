import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  collectWorkerCanvasCalls,
  correlateChildSurfacePresentation,
  correlateWorkerGpuFlushes,
  parseExactChromeTrace,
} from './analyze-terminal-gpu-trace';
import { runTestProcess } from './test-process';

function fixture() {
  return parseExactChromeTrace(`{"traceEvents":[
    {"name":"Graphics.Pipeline","ts":10,"pid":1,"tid":2,"args":{"chrome_graphics_pipeline":{"step":"STEP_RECEIVE_COMPOSITOR_FRAME","frame_sink_id":{"frame_sink_client_id":7,"frame_sink_id":2147483648},"surface_frame_trace_id":-4615428961945437190}}},
    {"name":"Graphics.Pipeline","ts":20,"pid":1,"tid":2,"args":{"chrome_graphics_pipeline":{"step":"STEP_SURFACE_AGGREGATION","aggregated_surface_frame_trace_ids":[-4615428961945437197],"display_trace_id":-4615428961945437201}}},
    {"name":"Graphics.Pipeline","ph":"X","ts":29,"dur":5,"pid":1,"tid":2,"args":{"chrome_graphics_pipeline":{"step":"STEP_DRAW_AND_SWAP","display_trace_id":-4615428961945437216}}},
    {"name":"Graphics.Pipeline","ts":30,"pid":1,"tid":2,"args":{"chrome_graphics_pipeline":{"step":"STEP_SURFACE_AGGREGATION","aggregated_surface_frame_trace_ids":[-4615428961945437190],"display_trace_id":-4615428961945437216}}},
    {"name":"Graphics.Pipeline.DrawAndSwap","cat":"viz,benchmark","ph":"b","ts":32,"pid":1,"tid":2,"id2":{"local":"0x3e"}},
    {"name":"Display::FrameDisplayed","ts":35,"pid":1,"tid":2},
    {"name":"Graphics.Pipeline.DrawAndSwap","cat":"viz,benchmark","ph":"e","ts":40,"pid":1,"tid":2,"id2":{"local":"0x3e"}},
    {"name":"Display::FrameDisplayed","ts":40,"pid":1,"tid":2}
  ]}`);
}

const sink = { client: 7, id: 2147483648 };

describe('exact boundary-owned worker GPU flush flows', () => {
  const begin = { name: 'begin', cat: 'blink.user_timing', pid: 5, tid: 7, ts: 10 };
  const end = { ...begin, name: 'end', ts: 100 };
  const source = {
    name: 'GpuChannel::Flush',
    cat: 'gpu,toplevel.flow',
    ph: 's',
    pid: 5,
    tid: 7,
    ts: 20,
    id: 123,
  };
  const receiver = { ...source, ph: 'f', pid: 9, tid: 11, ts: 40 };
  const correlate = (middle: Record<string, unknown>[], last = 90) =>
    correlateWorkerGpuFlushes([begin, ...middle, end], begin.name, end.name, 15, last);

  test('derives receiver ownership from exact ID and retains raw ordinals', () => {
    const result = correlate([source, { ...receiver, id: 124, ts: 21 }, receiver]);
    expect(result).toMatchObject({
      complete: true,
      selectedStartCount: 1,
      completedFlowCount: 1,
      worker: { pid: 5, tid: 7 },
      flows: [
        {
          id: '123',
          complete: true,
          source: { rawEventIndex: 1 },
          receiver: { rawEventIndex: 3, event: { pid: 9, tid: 11 } },
          dispatchToServiceMs: 0.02,
        },
      ],
    });
    expect(result.flows[0]?.source.event).toBe(source);
  });
  test('does not borrow another originating thread or guess an end', () => {
    expect(correlate([{ ...source, tid: 8 }, receiver])).toMatchObject({
      selectedStartCount: 0,
      flows: [],
    });
    expect(correlate([source, { ...receiver, id: 124 }])).toMatchObject({
      complete: false,
      completedFlowCount: 0,
      flows: [{ receiver: null, dispatchToServiceMs: null, receiverCandidates: [] }],
    });
  });
  test('rejects duplicate starts/ends and globally reused IDs even outside the interval', () => {
    for (const extra of [
      source,
      receiver,
      { ...source, ts: 1 },
      { ...source, pid: 8, ts: 95 },
      { ...receiver, ts: 101 },
    ]) {
      const result = correlate([source, receiver, extra]);
      expect(result.complete).toBe(false);
      expect(
        result.flows.every((flow) => flow.receiver === null && flow.dispatchToServiceMs === null),
      ).toBe(true);
    }
  });
  test('preserves backward and cutoff endpoints instead of silently discarding them', () => {
    for (const finish of [
      { ...receiver, ts: 19 },
      { ...receiver, ts: 91 },
    ]) {
      const result = correlate([source, finish]);
      expect(result.flows[0]).toMatchObject({
        complete: false,
        receiver: null,
        receiverCandidates: [{ event: finish }],
      });
    }
  });
  test('accepts timestamp ties and trace storage reordering without inventing temporal ordering', () => {
    expect(correlate([{ ...receiver, ts: 20 }, source])).toMatchObject({
      complete: true,
      flows: [
        { source: { rawEventIndex: 2 }, receiver: { rawEventIndex: 1 }, dispatchToServiceMs: 0 },
      ],
    });
  });
  test('preserves adjacent unsafe flow IDs without aliasing', () => {
    const parsed = parseExactChromeTrace(`{"traceEvents":[${JSON.stringify(begin)},
      {"name":"GpuChannel::Flush","cat":"gpu,toplevel.flow","ph":"s","pid":5,"tid":7,"ts":20,"id":9223372036854775806},
      {"name":"GpuChannel::Flush","cat":"gpu,toplevel.flow","ph":"f","pid":9,"tid":11,"ts":21,"id":9223372036854775807},
      {"name":"GpuChannel::Flush","cat":"gpu,toplevel.flow","ph":"f","pid":9,"tid":11,"ts":40,"id":9223372036854775806},${JSON.stringify(end)}]}`);
    expect(correlateWorkerGpuFlushes(parsed, 'begin', 'end', 15, 90)).toMatchObject({
      complete: true,
      flows: [
        { id: '9223372036854775806', receiver: { rawEventIndex: 3 }, dispatchToServiceMs: 0.02 },
      ],
    });
  });
  test('rejects invalid IDs, unsupported scope, malformed owners/categories and intermediate flows', () => {
    for (const change of [
      { id: undefined },
      { id: Number.MAX_SAFE_INTEGER + 1 },
      { id: '-0' },
      { id: 'junk' },
      { id2: { local: 123 } },
      { scope: 'other' },
      { cat: 'viz' },
    ]) {
      expect(correlate([{ ...source, ...change }, receiver]).complete).toBe(false);
    }
    for (const change of [{ pid: NaN }, { tid: -1 }, { ts: Infinity }, { cat: 'viz' }]) {
      expect(correlate([source, { ...receiver, ...change }]).complete).toBe(false);
    }
    expect(correlate([source, { ...receiver, ph: 't', ts: 30 }, receiver]).complete).toBe(false);
  });
  test('rejects malformed boundaries and escaped intervals', () => {
    for (const events of [
      [begin, source],
      [begin, begin, end],
      [begin, { ...end, tid: 9 }],
      [begin, { ...end, ts: 1 }],
    ]) {
      expect(() => correlateWorkerGpuFlushes(events, 'begin', 'end', 15, 90)).toThrow();
    }
    for (const interval of [
      [0, 90],
      [15, 101],
      [15, 15],
      [NaN, 90],
    ]) {
      const [from, to] = interval;
      if (from === undefined || to === undefined) throw new Error('fixture');
      expect(() =>
        correlateWorkerGpuFlushes([begin, source, receiver, end], 'begin', 'end', from, to),
      ).toThrow();
    }
  });
});

test('the CLI remains directly executable while Node Playwright can import its analysis functions', async () => {
  const projectRoot = resolve(__dirname, '..');
  const cli = await runTestProcess(
    [process.execPath, resolve(__dirname, 'analyze-terminal-gpu-trace.ts')],
    { cwd: projectRoot, timeout: 10_000 },
  );
  expect(cli.exitCode).toBe(1);
  expect(cli.stderr).toContain('usage: bun scripts/analyze-terminal-gpu-trace.ts');
  // Collection loads the real spec and its complete dependency graph under the
  // actual Playwright Node loader, without launching browsers or native services.
  const collection = await runTestProcess(
    [
      'node',
      require.resolve('@playwright/test/cli'),
      'test',
      '-c',
      'playwright.edge.config.mjs',
      'terminal-direct-latency.e2e.ts',
      '--list',
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        // Bun's worker identity is not a Playwright/Jest runner identity.
        JEST_WORKER_ID: undefined,
        PW_E2E_BROWSER: 'chromium',
        DIRECT_DIAGNOSTIC_WORKLOAD: 'typing',
        MERKUR_E2E_FINAL_TRANSPORT_CAPTURE: '1',
      },
      timeout: 30_000,
    },
  );
  expect(collection.stderr).toBe('');
  expect(collection.exitCode).toBe(0);
  expect(collection.stdout).toContain(
    'direct input cadences and fast redraws retain exact GPU-fence evidence',
  );
}, 40_000);

describe('boundary-owned native canvas census', () => {
  const begin = { name: 'worker-begin', cat: 'blink.user_timing', pid: 5, tid: 7, ts: 10 };
  const end = { ...begin, name: 'worker-end', ts: 100 };
  const call = {
    name: 'OffscreenCanvas::PushFrame',
    cat: 'blink',
    ph: 'X',
    pid: 5,
    tid: 7,
    ts: 20,
    dur: 3,
  };
  test('retains exact worker calls and raw ordinals without borrowing another thread', () => {
    const events = [
      begin,
      call,
      { ...call, tid: 8 },
      { ...call, pid: 6 },
      { ...call, ts: 101 },
      end,
    ];
    expect(collectWorkerCanvasCalls(events, begin.name, end.name)).toMatchObject({
      worker: { pid: 5, tid: 7 },
      counts: { pushFrame: 1, dispatchFrame: 0, prepareFrame: 0 },
      calls: [{ rawEventIndex: 1, name: call.name, startUs: 20, endUs: 23 }],
    });
  });
  test('keeps nested stages separate rather than counting each as a screen paint', () => {
    const events = [
      begin,
      call,
      { ...call, name: 'CanvasResourceDispatcher::DispatchFrame', ts: 21, dur: 2 },
      { ...call, name: 'CanvasResourceDispatcher::PrepareFrame', ts: 21, dur: 1 },
      end,
    ];
    expect(collectWorkerCanvasCalls(events, begin.name, end.name).counts).toEqual({
      pushFrame: 1,
      dispatchFrame: 1,
      prepareFrame: 1,
    });
  });
  test('an empty native census stays empty, not a nearest surface or guessed export', () => {
    expect(collectWorkerCanvasCalls([begin, end], begin.name, end.name).calls).toEqual([]);
  });
  test('rejects missing, duplicate, changed-owner or unordered boundary marks', () => {
    for (const events of [
      [begin, call],
      [begin, begin, end],
      [begin, { ...end, tid: 9 }],
      [begin, { ...end, ts: 9 }],
    ])
      expect(() => collectWorkerCanvasCalls(events, begin.name, end.name)).toThrow();
  });
  test('refuses incomplete and boundary-crossing spans instead of dropping them', () => {
    for (const change of [{ ph: 'B' }, { dur: -1 }, { dur: 81 }, { cat: 'viz' }])
      expect(() =>
        collectWorkerCanvasCalls([begin, { ...call, ...change }, end], begin.name, end.name),
      ).toThrow();
  });
});

describe('exact child-surface compositor correlation', () => {
  test('preserves adjacent unsafe IDs in scalars and arrays, ignoring an earlier unrelated display', () => {
    const [result] = correlateChildSurfacePresentation(fixture(), sink, 0, 100);
    expect(result).toMatchObject({
      complete: true,
      surfaceId: '-4615428961945437190',
      displayId: '-4615428961945437216',
      aggregationUs: 30,
      displayedUs: 40,
      swapLocalId: '0x3e',
      receiveToDisplayedMs: 0.03,
    });
  });
  test('does not substitute a root-surface receive', () => {
    expect(correlateChildSurfacePresentation(fixture(), { client: 7, id: 2 }, 0, 100)).toEqual([]);
  });
  test('missing and ambiguous async ends are incomplete, not a nearest-time match', () => {
    const events = fixture();
    const end = events.find((event) => event.ph === 'e');
    expect(end).toBeDefined();
    expect(
      correlateChildSurfacePresentation(
        events.filter((event) => event.ph !== 'e'),
        sink,
        0,
        100,
      )[0],
    ).toMatchObject({ complete: false, displayedUs: null });
    if (end === undefined) throw new Error('fixture');
    expect(
      correlateChildSurfacePresentation([...events, { ...end }], sink, 0, 100)[0],
    ).toMatchObject({ complete: false, displayedUs: null });
  });
  test('an async local ID is scoped to its process', () => {
    const events = fixture();
    const end = events.find((event) => event.ph === 'e');
    if (end === undefined) throw new Error('fixture');
    expect(
      correlateChildSurfacePresentation([...events, { ...end, pid: 9 }], sink, 0, 100)[0]?.complete,
    ).toBe(true);
  });
  test('containing a timestamp is insufficient without the exact display-ID draw', () => {
    const events = fixture().filter((event) => event.ts !== 29);
    events.push({ name: 'Display::DrawAndSwap', ph: 'X', ts: 29, dur: 5, pid: 1, tid: 2 });
    expect(correlateChildSurfacePresentation(events, sink, 0, 100)[0]).toMatchObject({
      complete: false,
      displayedUs: null,
    });
  });
  test('window cutoff cannot manufacture completion', () => {
    expect(correlateChildSurfacePresentation(fixture(), sink, 0, 38)[0]).toMatchObject({
      complete: false,
      displayedUs: null,
    });
    expect(() => correlateChildSurfacePresentation(fixture(), sink, 10, 0)).toThrow();
  });
  test('rejects local-ID reuse between the selected start and end', () => {
    const events = fixture();
    const start = events.find((event) => event.ph === 'b');
    if (start === undefined) throw new Error('fixture');
    expect(
      correlateChildSurfacePresentation([...events, { ...start, ts: 38 }], sink, 0, 100)[0],
    ).toMatchObject({ complete: false, displayedUs: null });
  });
  test('rejects malformed trace instead of filtering invalid events silently', () => {
    expect(() => parseExactChromeTrace('{"traceEvents":[null]}')).toThrow();
    expect(() => parseExactChromeTrace('{}')).toThrow();
  });
  test('rejects malformed surface IDs and refuses malformed display-ID completion', () => {
    for (const id of ['', 'foo', '0x3e', '-0', '01', '9223372036854775808']) {
      const events = JSON.stringify(fixture());
      const surface = parseExactChromeTrace(
        `{"traceEvents":${events.replaceAll('"-4615428961945437190"', JSON.stringify(id))}}`,
      );
      expect(() => correlateChildSurfacePresentation(surface, sink, 0, 100)).toThrow();
      const display = parseExactChromeTrace(
        `{"traceEvents":${events.replaceAll('"-4615428961945437216"', JSON.stringify(id))}}`,
      );
      expect(correlateChildSurfacePresentation(display, sink, 0, 100)[0]).toMatchObject({
        complete: false,
        displayedUs: null,
      });
    }
  });
});
