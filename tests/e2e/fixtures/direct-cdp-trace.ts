import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page, TestInfo, Worker } from '@playwright/test';

const NATIVE_TRACE_BUFFER_BYTES = 64 * 1024 * 1024;
// ReturnAsStream expands Chromium's native trace records into JSON. Bound the
// two representations separately; draining begins only after the end clock mark.
const MAX_SERIALIZED_TRACE_BYTES = 256 * 1024 * 1024;
const READ_BYTES = 1024 * 1024;
const COMMAND_DEADLINE_MS = 15_000;

// Diagnostic only: no screenshots, stack sampling, memory dumps or synchronous
// GPU queries. This capture must NEVER be pooled with acceptance timing runs.
export const DIRECT_GPU_TRACE_CATEGORIES = [
  // Pinned Chromium emits OffscreenCanvas::PushFrame and
  // CanvasResourceDispatcher::{PrepareFrame,DispatchFrame} in broad `blink`.
  // They expose the native export boundary, NOT a renderSeq/surface identity.
  'blink',
  'blink.user_timing',
  'toplevel',
  'toplevel.flow',
  'gpu',
  // Chromium DawnPlatform routes native WebGPU events here, not broad `gpu`.
  // Metal completion-handler observations are not hardware execution timestamps.
  'disabled-by-default-gpu.dawn',
  'viz',
  'graphics.pipeline',
] as const;

interface TraceCompletion {
  readonly dataLossOccurred: boolean;
  readonly stream?: string;
}

export interface DirectTraceDriver {
  start(): Promise<unknown>;
  end(): Promise<unknown>;
  onComplete(callback: (completion: TraceCompletion) => void): () => void;
  onBufferUsage(callback: (usedFraction: number) => void): () => void;
  read(
    handle: string,
    size: number,
  ): Promise<{
    readonly data: string;
    readonly base64Encoded?: boolean;
    readonly eof: boolean;
  }>;
  close(handle: string): Promise<unknown>;
  detach(): Promise<unknown>;
}

/** The bounded stream owner is separately executable against a deterministic driver. */
export async function startDirectTraceCollector(driver: DirectTraceDriver) {
  let usageObservations = 0;
  let maximumBufferUsage = 0;
  let invalidUsage = false;
  const removeUsage = driver.onBufferUsage((fraction) => {
    usageObservations += 1;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) invalidUsage = true;
    else maximumBufferUsage = Math.max(maximumBufferUsage, fraction);
  });
  try {
    await bounded(driver.start());
  } catch (error) {
    removeUsage();
    await bounded(driver.detach()).catch(() => {});
    throw error;
  }
  let stopped: Promise<Awaited<ReturnType<typeof finish>>> | null = null;
  async function finish() {
    const readDeadline = performance.now() + 30_000;
    const chunks: Buffer[] = [];
    const errors: string[] = [];
    let bytes = 0;
    let handle: string | null = null;
    let removeListener = () => {};
    let eof = false;
    try {
      const completion = new Promise<TraceCompletion>((resolve) => {
        removeListener = driver.onComplete(resolve);
      });
      // Subscribe before end: an empty trace may finish synchronously.
      await bounded(driver.end());
      const result = await bounded(completion);
      if (result.dataLossOccurred) errors.push('Chromium reported trace data loss');
      if (result.stream === undefined || result.stream.length === 0) {
        throw new Error('Chromium returned no trace stream');
      }
      handle = result.stream;
      // Each read is bounded, as are total bytes and iterations. Empty non-EOF
      // replies cannot spin forever or manufacture a complete artifact.
      for (let reads = 0; reads < 4096; reads += 1) {
        const remainingMs = readDeadline - performance.now();
        if (remainingMs <= 0) throw new Error('trace stream exceeded its total drain deadline');
        const part = await bounded(driver.read(handle, READ_BYTES), remainingMs);
        const chunk = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
        if (chunk.length > MAX_SERIALIZED_TRACE_BYTES - bytes) {
          errors.push('serialized trace exceeded the 256MiB diagnostic bound');
          break;
        }
        chunks.push(chunk);
        bytes += chunk.length;
        if (part.eof) {
          eof = true;
          break;
        }
        if (chunk.length === 0) throw new Error('trace stream made no progress');
      }
      if (!eof) errors.push('trace stream did not reach EOF');
      if (bytes === 0) errors.push('trace stream is empty');
      if (usageObservations === 0 || invalidUsage)
        errors.push('missing or invalid trace buffer usage');
      if (maximumBufferUsage >= 1) errors.push('trace buffer reached capacity');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      removeListener();
      removeUsage();
      if (handle !== null) {
        await bounded(driver.close(handle)).catch((error: unknown) => {
          errors.push(`trace close failed: ${String(error)}`);
        });
      }
      await bounded(driver.detach()).catch((error: unknown) => {
        errors.push(`trace detach failed: ${String(error)}`);
      });
    }
    const body = Buffer.concat(chunks, bytes);
    return {
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
      byteLength: body.length,
      complete: eof && errors.length === 0,
      usageObservations,
      maximumBufferUsage,
      nativeBufferByteLimit: NATIVE_TRACE_BUFFER_BYTES,
      serializedByteLimit: MAX_SERIALIZED_TRACE_BYTES,
      errors,
      interpretation: 'diagnostic Chrome trace; excluded from latency acceptance' as const,
    };
  }
  return {
    stop() {
      stopped ??= finish();
      return stopped;
    },
  };
}

export async function startDirectCdpTrace(browser: Browser) {
  const session = await browser.newBrowserCDPSession();
  return startDirectTraceCollector({
    start: () =>
      session.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        streamCompression: 'none',
        bufferUsageReportingInterval: 1000,
        traceConfig: {
          recordMode: 'recordUntilFull',
          traceBufferSizeInKb: NATIVE_TRACE_BUFFER_BYTES / 1024,
          enableSampling: false,
          enableSystrace: false,
          includedCategories: [...DIRECT_GPU_TRACE_CATEGORIES],
          excludedCategories: ['disabled-by-default-devtools.screenshot'],
        },
      }),
    end: () => session.send('Tracing.end'),
    onComplete: (callback) => {
      session.on('Tracing.tracingComplete', callback);
      return () => session.off('Tracing.tracingComplete', callback);
    },
    onBufferUsage: (callback) => {
      const listener = (event: { percentFull?: number; value?: number }) => {
        for (const value of [event.percentFull, event.value]) {
          if (value !== undefined) callback(value);
        }
      };
      session.on('Tracing.bufferUsage', listener);
      return () => session.off('Tracing.bufferUsage', listener);
    },
    read: (handle, size) => session.send('IO.read', { handle, size }),
    close: (handle) => session.send('IO.close', { handle }),
    detach: () => session.detach(),
  });
}

/** Same bounded collector for the relay typing reproduction, never timing acceptance. */
export async function startTerminalGpuTraceWindow(browser: Browser, page: Page, info: TestInfo) {
  const worker = await createDirectTraceWorkerClock(page);
  let collector: Awaited<ReturnType<typeof startDirectCdpTrace>>;
  let begin: Awaited<ReturnType<typeof markDirectTraceClock>>;
  let workerBegin: Awaited<ReturnType<typeof worker.mark>>;
  try {
    collector = await startDirectCdpTrace(browser);
    try {
      begin = await markDirectTraceClock(page, 'begin');
      workerBegin = await worker.mark('begin');
    } catch (error) {
      await collector.stop();
      throw error;
    }
  } catch (error) {
    worker.dispose();
    throw error;
  }
  let stopped: Promise<void> | null = null;
  const finish = async () => {
    let end: typeof begin | null = null;
    let workerEnd: typeof workerBegin | null = null;
    const errors: string[] = [];
    try {
      workerEnd = await worker.mark('end');
      end = await markDirectTraceClock(page, 'end');
    } catch (error) {
      errors.push(String(error));
    } finally {
      worker.dispose();
    }
    const result = await collector.stop();
    await persistTerminalGpuTraceArtifact(info, 'terminal-gpu-trace.json', result.body);
    let pageClock = null;
    let workerClock = null;
    try {
      if (end !== null) pageClock = validateDirectTraceClockCoverage(result.body, begin, end);
      if (workerEnd !== null)
        workerClock = validateDirectTraceClockCoverage(result.body, workerBegin, workerEnd);
    } catch (error) {
      errors.push(String(error));
    }
    errors.push(...result.errors, ...(pageClock?.errors ?? []), ...(workerClock?.errors ?? []));
    if (pageClock === null || workerClock === null) errors.push('missing trace clock coverage');
    if ((workerClock?.categories['disabled-by-default-gpu.dawn'] ?? 0) === 0)
      errors.push('no native Dawn events inside the exact worker trace window');
    if (
      pageClock?.epochOffsetMs !== null &&
      pageClock?.epochOffsetMs !== undefined &&
      workerClock?.epochOffsetMs !== null &&
      workerClock?.epochOffsetMs !== undefined &&
      Math.abs(pageClock.epochOffsetMs - workerClock.epochOffsetMs) > 1
    )
      errors.push('page and worker trace clocks disagree');
    const { body: _body, ...capture } = result;
    await persistTerminalGpuTraceArtifact(
      info,
      'terminal-gpu-trace-metadata.json',
      JSON.stringify({
        ...capture,
        complete: result.complete && errors.length === 0,
        errors,
        browserVersion: browser.version(),
        categories: DIRECT_GPU_TRACE_CATEGORIES,
        timingAcceptanceEligible: false,
        begin,
        end,
        workerBegin,
        workerEnd,
        workerAssetUrl: worker.assetUrl,
        workerAssetSha256: worker.assetSha256,
        pageClock,
        workerClock,
        nativeCompletionMeaning:
          'Metal completed-handler observation, not a hardware timestamp or Merkur render identity',
      }),
    );
    if (!result.complete || errors.length > 0)
      throw new Error(`incomplete diagnostic GPU trace: ${errors.join('; ')}`);
  };
  return {
    stop() {
      stopped ??= finish();
      return stopped;
    },
  };
}

/** Body-only attachments may live only in a reporter; preserve passing diagnostic runs on disk. */
export async function persistTerminalGpuTraceArtifact(
  info: Pick<TestInfo, 'outputPath' | 'attach'>,
  name: string,
  body: string | Uint8Array,
): Promise<void> {
  const artifactPath = info.outputPath(name);
  await writeFile(artifactPath, body);
  await info.attach(name, { path: artifactPath, contentType: 'application/json' });
}

/** One page-clock mapping per trace boundary, never a command per render/input. */
export function markDirectTraceClock(page: Pick<Page, 'evaluate'>, phase: 'begin' | 'end') {
  return bounded(
    page.evaluate((boundaryPhase) => {
      const name = `merkur-direct-gpu-trace-${boundaryPhase}`;
      const localMs = performance.now();
      performance.mark(name, { startTime: localMs });
      return {
        name,
        localMs,
        timeOriginMs: performance.timeOrigin,
        epochMs: performance.timeOrigin + localMs,
      };
    }, phase),
  );
}

/** Match the exact served artifact, never the nearest thread or a URL substring. */
export function selectDirectTraceWorker<T extends { url(): string }>(
  workers: readonly T[],
  assetUrl: string,
): T {
  const matches = workers.filter((worker) => worker.url() === assetUrl);
  const worker = matches[0];
  if (matches.length !== 1 || worker === undefined)
    throw new Error('trace requires exactly one worker for the retained terminal asset');
  return worker;
}

/**
 * Diagnostic-only worker identity. Two boundary evaluations, none per render.
 * This establishes a trace thread, not a renderSeq-to-compositor-surface join.
 */
export async function createDirectTraceWorkerClock(page: Page) {
  const assetsDirectory = path.resolve('apps/web/dist/assets');
  const assets = readdirSync(assetsDirectory).filter((name) =>
    /^terminal-worker-[A-Za-z0-9_-]+\.js$/.test(name),
  );
  const assetName = assets[0];
  if (assets.length !== 1 || assetName === undefined)
    throw new Error('trace requires exactly one built terminal-worker asset');
  const assetPath = path.join(assetsDirectory, assetName);
  const assetUrl = new URL(`/assets/${assetName}`, page.url()).href;
  const assetSha256 = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
  const response = await bounded(page.request.get(assetUrl, { timeout: COMMAND_DEADLINE_MS }));
  try {
    if (!response.ok()) throw new Error('trace terminal-worker asset request failed');
    if (
      createHash('sha256')
        .update(await bounded(response.body()))
        .digest('hex') !== assetSha256
    )
      throw new Error('served terminal-worker bytes differ from retained build');
  } finally {
    await bounded(response.dispose());
  }
  const worker = selectDirectTraceWorker(page.workers(), assetUrl);
  let closed = false;
  let replaced = false;
  let disposed = false;
  let markedBegin = false;
  let markedEnd = false;
  const onClose = () => {
    closed = true;
  };
  const onWorker = (created: Worker) => {
    if (created !== worker && created.url() === assetUrl) replaced = true;
  };
  worker.on('close', onClose);
  page.on('worker', onWorker);
  const nonce = randomUUID();
  return {
    assetUrl,
    assetSha256,
    async mark(phase: 'begin' | 'end') {
      if (
        closed ||
        replaced ||
        disposed ||
        selectDirectTraceWorker(page.workers(), assetUrl) !== worker
      )
        throw new Error('terminal worker changed during trace');
      if (phase === 'begin' ? markedBegin : !markedBegin || markedEnd)
        throw new Error('invalid worker trace boundary order');
      if (phase === 'begin') markedBegin = true;
      else markedEnd = true;
      const requestedAtEpochMs = performance.timeOrigin + performance.now();
      const mark = await bounded(
        worker.evaluate((name) => {
          const localMs = performance.now();
          performance.mark(name, { startTime: localMs });
          return {
            name,
            localMs,
            timeOriginMs: performance.timeOrigin,
            epochMs: performance.timeOrigin + localMs,
            workerUrl: globalThis.location.href,
          };
        }, `merkur-direct-terminal-worker-${nonce}-${phase}`),
      );
      const completedAtEpochMs = performance.timeOrigin + performance.now();
      if (
        closed ||
        replaced ||
        disposed ||
        mark.workerUrl !== assetUrl ||
        selectDirectTraceWorker(page.workers(), assetUrl) !== worker
      )
        throw new Error('terminal worker changed while marking trace');
      return { ...mark, requestedAtEpochMs, completedAtEpochMs };
    },
    dispose() {
      disposed = true;
      worker.off('close', onClose);
      page.off('worker', onWorker);
    },
  };
}

/** Validate the captured interval before interpreting cross-process trace timings. */
export function validateDirectTraceClockCoverage(
  body: Uint8Array,
  begin: Awaited<ReturnType<typeof markDirectTraceClock>>,
  end: Awaited<ReturnType<typeof markDirectTraceClock>>,
) {
  const errors: string[] = [];
  const marks: { name: string; ts: number; pid: number; tid: number }[] = [];
  const categories: Record<string, number> = {};
  const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
  if (!record(parsed) || !Array.isArray(parsed.traceEvents)) {
    throw new Error('Chrome trace has no event array');
  }
  for (const event of parsed.traceEvents) {
    if (!record(event) || typeof event.cat !== 'string') continue;
    if (
      (event.name === begin.name || event.name === end.name) &&
      event.cat.split(',').includes('blink.user_timing') &&
      typeof event.ts === 'number' &&
      Number.isFinite(event.ts) &&
      typeof event.pid === 'number' &&
      typeof event.tid === 'number'
    ) {
      marks.push({ name: event.name, ts: event.ts, pid: event.pid, tid: event.tid });
    }
  }
  const starts = marks.filter((mark) => mark.name === begin.name);
  const ends = marks.filter((mark) => mark.name === end.name);
  const start = starts[0];
  const finish = ends[0];
  let epochOffsetMs: number | null = null;
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || finish === undefined) {
    errors.push('trace requires exactly one begin/end clock mark');
  } else {
    const startOffset = begin.epochMs - start.ts / 1000;
    const endOffset = end.epochMs - finish.ts / 1000;
    if (
      !Number.isFinite(begin.epochMs) ||
      !Number.isFinite(end.epochMs) ||
      begin.timeOriginMs !== end.timeOriginMs ||
      !(end.epochMs > begin.epochMs) ||
      !(finish.ts > start.ts) ||
      start.pid !== finish.pid ||
      start.tid !== finish.tid ||
      Math.abs(startOffset - endOffset) > 1
    ) {
      errors.push('trace clock interval is inconsistent or changed owner');
    } else {
      epochOffsetMs = startOffset;
      for (const event of parsed.traceEvents) {
        if (
          !record(event) ||
          typeof event.cat !== 'string' ||
          typeof event.ts !== 'number' ||
          event.ts < start.ts ||
          event.ts > finish.ts
        )
          continue;
        for (const category of event.cat.split(',')) {
          categories[category] = (categories[category] ?? 0) + 1;
        }
      }
      for (const category of ['toplevel', 'toplevel.flow', 'gpu', 'viz', 'graphics.pipeline']) {
        if ((categories[category] ?? 0) === 0)
          errors.push(`no ${category} events inside trace marks`);
      }
    }
  }
  return { complete: errors.length === 0, errors, marks, epochOffsetMs, categories };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function bounded<T>(operation: Promise<T>, remainingMs = COMMAND_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Chrome trace command timed out')),
          Math.min(COMMAND_DEADLINE_MS, remainingMs),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
