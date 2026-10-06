import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateDirectTraceClockCoverage } from '../tests/e2e/fixtures/direct-cdp-trace';

type TraceEvent = Record<string, unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Chromium emits signed 64-bit surface IDs as JSON numbers, including in arrays. */
export function parseExactChromeTrace(body: string): TraceEvent[] {
  const parsed: unknown = JSON.parse(
    body,
    (_key: string, value: unknown, context?: { source: string }) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || Number.isSafeInteger(value))
        return value;
      if (context === undefined || !/^-?\d+$/.test(context.source))
        throw new Error('trace parser cannot preserve an unsafe integer exactly');
      return context.source;
    },
  );
  if (!record(parsed) || !Array.isArray(parsed.traceEvents))
    throw new Error('Chrome trace has no event array');
  if (!parsed.traceEvents.every(record)) throw new Error('invalid Chrome trace event');
  return parsed.traceEvents;
}

function pipeline(event: TraceEvent): Record<string, unknown> | null {
  return record(event.args) && record(event.args.chrome_graphics_pipeline)
    ? event.args.chrome_graphics_pipeline
    : null;
}

function exactId(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'string' || value === '-0' || !/^-?(?:0|[1-9]\d{0,18})$/.test(value))
    return false;
  const integer = BigInt(value);
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
}

function exactAsyncId(value: unknown): value is string | number {
  return exactId(value) || (typeof value === 'string' && /^0x[0-9a-f]{1,16}$/.test(value));
}

function timestamp(event: TraceEvent): number {
  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts))
    throw new Error('invalid trace timestamp');
  return event.ts;
}

/**
 * Census native canvas call spans on a boundary-marked worker. A call span is
 * not proof of an exported resource, a particular render, or visible pixels.
 * The caller must first validate the complete trace and both clock mappings.
 */
export function collectWorkerCanvasCalls(
  events: readonly TraceEvent[],
  beginMarkName: string,
  endMarkName: string,
) {
  if (beginMarkName.length === 0 || endMarkName.length === 0 || beginMarkName === endMarkName)
    throw new Error('invalid worker canvas boundary names');
  const markEvents = events.filter(
    (event) =>
      (event.name === beginMarkName || event.name === endMarkName) &&
      typeof event.cat === 'string' &&
      event.cat.split(',').includes('blink.user_timing'),
  );
  const starts = markEvents.filter((event) => event.name === beginMarkName);
  const ends = markEvents.filter((event) => event.name === endMarkName);
  const begin = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined)
    throw new Error('worker canvas census requires unique boundary marks');
  if (
    !Number.isSafeInteger(begin.pid) ||
    !Number.isSafeInteger(begin.tid) ||
    begin.pid !== end.pid ||
    begin.tid !== end.tid ||
    timestamp(begin) >= timestamp(end)
  )
    throw new Error('worker canvas boundary changed owner or order');
  const names = [
    'OffscreenCanvas::PushFrame',
    'CanvasResourceDispatcher::DispatchFrame',
    'CanvasResourceDispatcher::PrepareFrame',
  ] as const;
  type CallName = (typeof names)[number];
  const calls: { rawEventIndex: number; name: CallName; startUs: number; endUs: number }[] = [];
  const counts = { pushFrame: 0, dispatchFrame: 0, prepareFrame: 0 };
  for (let rawEventIndex = 0; rawEventIndex < events.length; rawEventIndex++) {
    const event = events[rawEventIndex];
    if (event === undefined || event.pid !== begin.pid || event.tid !== begin.tid) continue;
    const name = names.find((name) => name === event.name);
    if (name === undefined) continue;
    const startUs = timestamp(event);
    if (startUs < timestamp(begin) || startUs > timestamp(end)) continue;
    if (typeof event.cat !== 'string' || !event.cat.split(',').includes('blink'))
      throw new Error('worker canvas call has unexpected category');
    if (
      event.ph !== 'X' ||
      typeof event.dur !== 'number' ||
      !Number.isFinite(event.dur) ||
      event.dur < 0
    )
      throw new Error('worker canvas call lacks a complete native span');
    const endUs = startUs + event.dur;
    if (!Number.isFinite(endUs) || endUs > timestamp(end))
      throw new Error('worker canvas call extends beyond end mark');
    calls.push({ rawEventIndex, name, startUs, endUs });
    if (name === names[0]) counts.pushFrame++;
    else if (name === names[1]) counts.dispatchFrame++;
    else counts.prepareFrame++;
  }
  return {
    worker: { pid: begin.pid, tid: begin.tid },
    beginUs: timestamp(begin),
    endUs: timestamp(end),
    counts,
    calls,
    interpretation:
      'Native canvas call spans only; no renderSeq/surface association or pixel evidence.' as const,
  };
}

/**
 * Cold exact-flow diagnostic. Boundary marks identify the originating worker;
 * global flow IDs identify the receiving thread, never proximity or a surface.
 * A flush reaching native service is NOT GPU completion or frame presentation.
 * Callers must validate the original trace's completeness/hash/clock mapping.
 */
export function correlateWorkerGpuFlushes(
  events: readonly TraceEvent[],
  beginMarkName: string,
  endMarkName: string,
  beginUs: number,
  endUs: number,
) {
  if (!beginMarkName || !endMarkName || beginMarkName === endMarkName)
    throw new Error('invalid worker flush boundary names');
  type Endpoint = { rawEventIndex: number; event: TraceEvent };
  const marks: Endpoint[] = [];
  for (let rawEventIndex = 0; rawEventIndex < events.length; rawEventIndex++) {
    const event = events[rawEventIndex];
    if (
      event !== undefined &&
      (event.name === beginMarkName || event.name === endMarkName) &&
      typeof event.cat === 'string' &&
      event.cat.split(',').includes('blink.user_timing')
    )
      marks.push({ event, rawEventIndex });
  }
  const starts = marks.filter(({ event }) => event.name === beginMarkName);
  const ends = marks.filter(({ event }) => event.name === endMarkName);
  const begin = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined)
    throw new Error('worker flush correlation requires unique boundary marks');
  const { pid, tid } = begin.event;
  if (
    typeof pid !== 'number' ||
    typeof tid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(tid) ||
    pid < 0 ||
    tid < 0 ||
    end.event.pid !== pid ||
    end.event.tid !== tid ||
    timestamp(begin.event) >= timestamp(end.event)
  )
    throw new Error('worker flush boundary changed owner or order');
  if (
    !Number.isFinite(beginUs) ||
    !Number.isFinite(endUs) ||
    beginUs >= endUs ||
    beginUs < timestamp(begin.event) ||
    endUs > timestamp(end.event)
  )
    throw new Error('flush interval escapes worker boundaries');
  const selected: Endpoint[] = [];
  const identities = new Map<string, Endpoint[]>();
  const flowId = (event: TraceEvent): string | null =>
    exactAsyncId(event.id) ? BigInt(event.id).toString() : null;
  for (let rawEventIndex = 0; rawEventIndex < events.length; rawEventIndex++) {
    const event = events[rawEventIndex];
    if (
      event === undefined ||
      event.name !== 'GpuChannel::Flush' ||
      event.ph !== 's' ||
      event.pid !== pid ||
      event.tid !== tid
    )
      continue;
    const atUs = timestamp(event);
    if (atUs < beginUs || atUs > endUs) continue;
    selected.push({ rawEventIndex, event });
    const id = flowId(event);
    if (id !== null) identities.set(id, []);
  }
  // Scan the whole retained trace for reuse, including outside the requested
  // interval. Never choose the first/nearest endpoint from an ambiguous ID.
  for (let rawEventIndex = 0; rawEventIndex < events.length; rawEventIndex++) {
    const event = events[rawEventIndex];
    if (
      event === undefined ||
      event.name !== 'GpuChannel::Flush' ||
      !['s', 't', 'f'].includes(String(event.ph))
    )
      continue;
    const id = flowId(event);
    if (id !== null) identities.get(id)?.push({ rawEventIndex, event });
  }
  const flows = selected.map((source) => {
    const errors: string[] = [];
    const id = flowId(source.event);
    const endpoints = id === null ? [source] : (identities.get(id) ?? []);
    const sourceCandidates = endpoints.filter(({ event }) => event.ph === 's');
    const receiverCandidates = endpoints.filter(({ event }) => event.ph === 'f');
    if (id === null) errors.push('missing or invalid exact global flow ID');
    if (sourceCandidates.length !== 1) errors.push('duplicate or reused global flow start');
    if (receiverCandidates.length !== 1) errors.push('missing or ambiguous global flow end');
    if (endpoints.some(({ event }) => event.ph === 't'))
      errors.push('unexpected intermediate flow');
    for (const { event, rawEventIndex } of endpoints) {
      if (
        typeof event.cat !== 'string' ||
        !event.cat.split(',').includes('gpu') ||
        !event.cat.split(',').includes('toplevel.flow') ||
        event.id2 !== undefined ||
        event.scope !== undefined ||
        typeof event.pid !== 'number' ||
        typeof event.tid !== 'number' ||
        !Number.isSafeInteger(event.pid) ||
        !Number.isSafeInteger(event.tid) ||
        event.pid < 0 ||
        event.tid < 0 ||
        typeof event.ts !== 'number' ||
        !Number.isFinite(event.ts)
      )
        errors.push(`invalid global flow endpoint at ordinal ${rawEventIndex}`);
    }
    const receiver = receiverCandidates.length === 1 ? receiverCandidates[0] : undefined;
    if (receiver !== undefined) {
      const atUs = receiver.event.ts;
      if (
        typeof atUs !== 'number' ||
        !Number.isFinite(atUs) ||
        atUs < timestamp(source.event) ||
        atUs > endUs
      )
        errors.push('flow end is backward or outside the requested interval');
    }
    const complete = errors.length === 0;
    return {
      id,
      complete,
      errors,
      source,
      sourceCandidates,
      receiverCandidates,
      receiver: complete && receiver !== undefined ? receiver : null,
      dispatchToServiceMs:
        complete && receiver !== undefined
          ? (timestamp(receiver.event) - timestamp(source.event)) / 1000
          : null,
    };
  });
  return {
    complete: flows.every((flow) => flow.complete),
    errors: flows.flatMap((flow) =>
      flow.errors.map((error) => `ordinal ${flow.source.rawEventIndex}: ${error}`),
    ),
    worker: { pid, tid },
    boundary: { begin, end },
    beginUs,
    endUs,
    selectedStartCount: selected.length,
    completedFlowCount: flows.filter((flow) => flow.complete).length,
    flows,
    interpretation:
      'Exact worker-originating flush flow to native service; no render/fence/surface association, physical GPU completion or photons.' as const,
  };
}

/**
 * Join a caller-identified child surface to its first aggregation and async swap.
 * Never select the nearest FrameDisplayed event: that may belong to an older frame.
 * This is a software compositor proxy, not a scan-out or physical GPU measurement.
 */
export function correlateChildSurfacePresentation(
  events: readonly TraceEvent[],
  sink: { client: number; id: number },
  beginUs: number,
  endUs: number,
) {
  if (!Number.isFinite(beginUs) || !Number.isFinite(endUs) || endUs <= beginUs)
    throw new Error('invalid correlation interval');
  const ordered = events
    .filter((event) => typeof event.ts === 'number' && event.ts >= beginUs && event.ts <= endUs)
    .sort((a, b) => timestamp(a) - timestamp(b));
  const receives = ordered.filter((event) => {
    const data = pipeline(event);
    return (
      data?.step === 'STEP_RECEIVE_COMPOSITOR_FRAME' &&
      record(data.frame_sink_id) &&
      data.frame_sink_id.frame_sink_client_id === sink.client &&
      data.frame_sink_id.frame_sink_id === sink.id
    );
  });
  return receives.map((receive) => {
    const errors: string[] = [];
    const surfaceId = pipeline(receive)?.surface_frame_trace_id;
    if (!exactId(surfaceId)) throw new Error('child receive has no exact surface ID');
    const aggregation = ordered.find((event) => {
      const data = pipeline(event);
      return (
        timestamp(event) >= timestamp(receive) &&
        data?.step === 'STEP_SURFACE_AGGREGATION' &&
        Array.isArray(data.aggregated_surface_frame_trace_ids) &&
        data.aggregated_surface_frame_trace_ids.includes(surfaceId)
      );
    });
    const displayId = aggregation === undefined ? null : pipeline(aggregation)?.display_trace_id;
    const draws =
      aggregation === undefined || !exactId(displayId)
        ? []
        : ordered.filter(
            (event) =>
              pipeline(event)?.step === 'STEP_DRAW_AND_SWAP' &&
              pipeline(event)?.display_trace_id === displayId &&
              event.ph === 'X' &&
              event.pid === aggregation.pid &&
              event.tid === aggregation.tid &&
              typeof event.dur === 'number' &&
              timestamp(event) <= timestamp(aggregation) &&
              timestamp(event) + event.dur >= timestamp(aggregation),
          );
    const draw = draws.length === 1 ? draws[0] : undefined;
    const starts =
      draw === undefined
        ? []
        : ordered.filter(
            (event) =>
              event.name === 'Graphics.Pipeline.DrawAndSwap' &&
              event.ph === 'b' &&
              event.pid === draw.pid &&
              event.tid === draw.tid &&
              typeof draw.dur === 'number' &&
              timestamp(event) >= timestamp(draw) &&
              timestamp(event) <= timestamp(draw) + draw.dur,
          );
    const start = starts.length === 1 ? starts[0] : undefined;
    const asyncId = start !== undefined && record(start.id2) ? start.id2.local : undefined;
    const finishes =
      start === undefined || !exactAsyncId(asyncId)
        ? []
        : ordered.filter(
            (event) =>
              event.name === start.name &&
              event.cat === start.cat &&
              event.ph === 'e' &&
              event.pid === start.pid &&
              record(event.id2) &&
              event.id2.local === asyncId &&
              timestamp(event) >= timestamp(start),
          );
    const finish = finishes.length === 1 ? finishes[0] : undefined;
    const reusedStarts =
      start === undefined || finish === undefined
        ? []
        : ordered.filter(
            (event) =>
              event.name === start.name &&
              event.cat === start.cat &&
              event.ph === 'b' &&
              event.pid === start.pid &&
              record(event.id2) &&
              event.id2.local === asyncId &&
              timestamp(event) >= timestamp(start) &&
              timestamp(event) <= timestamp(finish),
          );
    const displayed =
      finish === undefined
        ? []
        : ordered.filter(
            (event) =>
              event.name === 'Display::FrameDisplayed' &&
              event.pid === finish.pid &&
              event.tid === finish.tid &&
              timestamp(event) === timestamp(finish),
          );
    if (aggregation === undefined || !exactId(displayId))
      errors.push('no exact surface aggregation');
    if (draw === undefined) errors.push('missing or ambiguous exact display-ID draw');
    if (start === undefined || !exactAsyncId(asyncId))
      errors.push('missing or ambiguous async swap start');
    if (finish === undefined || displayed.length !== 1)
      errors.push('missing or ambiguous displayed swap end');
    if (finish !== undefined && reusedStarts.length !== 1)
      errors.push('async swap ID reused before its selected end');
    return {
      complete: errors.length === 0,
      errors,
      surfaceId,
      displayId: exactId(displayId) ? displayId : null,
      swapLocalId: exactAsyncId(asyncId) ? asyncId : null,
      receiveUs: timestamp(receive),
      aggregationUs: aggregation === undefined ? null : timestamp(aggregation),
      displayedUs: errors.length === 0 && finish !== undefined ? timestamp(finish) : null,
      receiveToDisplayedMs:
        errors.length === 0 && finish !== undefined
          ? (timestamp(finish) - timestamp(receive)) / 1000
          : null,
      evidence: { receive, aggregation, draw, start, finish, displayed },
    };
  });
}

function clockMark(value: unknown) {
  if (
    !record(value) ||
    typeof value.name !== 'string' ||
    typeof value.localMs !== 'number' ||
    typeof value.timeOriginMs !== 'number' ||
    typeof value.epochMs !== 'number'
  )
    throw new Error('missing trace clock mark');
  return {
    name: value.name,
    localMs: value.localMs,
    timeOriginMs: value.timeOriginMs,
    epochMs: value.epochMs,
  };
}

// Playwright imports this analysis module through its Node/CommonJS transform.
// Keep the CLI guard parseable there; Bun also exposes the same main-module identity.
if (require.main === module) {
  const [tracePath, metadataPath, clientText, sinkText, epochText, durationText] =
    process.argv.slice(2);
  if (tracePath === undefined || metadataPath === undefined || durationText === undefined)
    throw new Error(
      'usage: bun scripts/analyze-terminal-gpu-trace.ts TRACE METADATA CLIENT SINK RENDER_END_EPOCH_MS WINDOW_MS',
    );
  const client = Number(clientText);
  const id = Number(sinkText);
  const epochMs = Number(epochText);
  const durationMs = Number(durationText);
  if (
    ![client, id].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isFinite(epochMs) ||
    !(durationMs > 0 && durationMs <= 1000)
  )
    throw new Error('invalid sink, epoch, or bounded window (maximum 1000ms)');
  const body = readFileSync(tracePath);
  if (body.byteLength > 256 * 1024 * 1024) throw new Error('trace exceeds diagnostic byte bound');
  const metadataBody = readFileSync(metadataPath);
  const metadata: unknown = JSON.parse(metadataBody.toString('utf8'));
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (
    !record(metadata) ||
    metadata.complete !== true ||
    metadata.sha256 !== sha256 ||
    metadata.byteLength !== body.byteLength ||
    !Array.isArray(metadata.errors) ||
    metadata.errors.length !== 0
  )
    throw new Error('trace metadata is incomplete or does not match exact trace bytes');
  const coverage = validateDirectTraceClockCoverage(
    body,
    clockMark(metadata.traceBegin),
    clockMark(metadata.traceEnd),
  );
  if (!coverage.complete || coverage.epochOffsetMs === null)
    throw new Error('invalid trace clock coverage');
  const beginUs = (epochMs - coverage.epochOffsetMs) * 1000;
  const endUs = beginUs + durationMs * 1000;
  if (
    epochMs < clockMark(metadata.traceBegin).epochMs ||
    epochMs + durationMs > clockMark(metadata.traceEnd).epochMs
  )
    throw new Error('correlation window lies outside verified trace interval');
  const results = correlateChildSurfacePresentation(
    parseExactChromeTrace(body.toString('utf8')),
    { client, id },
    beginUs,
    endUs,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        traceSha256: sha256,
        metadataSha256: createHash('sha256').update(metadataBody).digest('hex'),
        timingAcceptanceEligible: false,
        interpretation:
          'Caller-selected child surface; exact aggregation/async-swap software proxy. Does not prove worker ownership, physical GPU completion or photons.',
        sink: { client, id },
        beginUs,
        endUs,
        complete: results.length > 0 && results.every((result) => result.complete),
        results,
      },
      null,
      2,
    )}\n`,
  );
}
