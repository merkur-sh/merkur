/**
 * drain-worker.ts — WebTransport drain worker for real-device acceptance.
 *
 * Runs in a dedicated Web Worker. Opens a NATIVE `WebTransport`, drains
 * `wt.datagrams.readable` in a tight loop, and bounces a display-sized burst
 * of sequence-numbered datagrams off the echo server. For every echoed
 * datagram it:
 *   - parses the 4-byte big-endian sequence number + 8-byte send-timestamp,
 *   - tracks received vs expected sequence numbers (gaps == burst-tail DROPS),
 *   - measures per-datagram round-trip latency, and
 *   - posts a rolling readout back to the main thread.
 *
 * It also counts how many times a timer is installed (setTimeout/setInterval)
 * from inside this worker. On the native path this count must stay flat. The
 * patched timer globals make the count reflect only this worker's own timer
 * pressure.
 */

// ---- Timer-install instrumentation -----------------------------------------

let timerInstallCount = 0;
const realSetTimeout = self.setTimeout.bind(self);
const realSetInterval = self.setInterval.bind(self);
// Wrap timer globals so we can observe install pressure inside the worker.
// We keep the real behavior; we only count installs.
(self as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
) => {
  timerInstallCount += 1;
  return realSetTimeout(handler as () => void, timeout, ...args);
}) as typeof setTimeout;
(self as unknown as { setInterval: typeof setInterval }).setInterval = ((
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
) => {
  timerInstallCount += 1;
  return realSetInterval(handler as () => void, timeout, ...args);
}) as typeof setInterval;

// ---- Message contract ------------------------------------------------------

interface StartMessage {
  type: 'start';
  url: string;
  /** base64 SHA-256 cert hash printed by wt-echo-server. */
  certHashB64: string;
  /** Number of datagrams in the burst. */
  burstCount: number;
  /** Bytes per datagram payload (display-sized). */
  datagramBytes: number;
  /** Number of bursts to fire (each separated by burstGapMs). */
  bursts: number;
  /** Gap between bursts, ms. */
  burstGapMs: number;
}

interface StopMessage {
  type: 'stop';
}

type InboundMessage = StartMessage | StopMessage;

interface Readout {
  type: 'readout';
  state: 'connecting' | 'running' | 'done' | 'error';
  sent: number;
  received: number;
  dropped: number;
  maxGap: number;
  p50: number;
  p95: number;
  timerInstallCount: number;
  note?: string;
}

// ---- State -----------------------------------------------------------------

let wt: WebTransport | null = null;
let running = false;
let sent = 0;
let received = 0;
const seen = new Set<number>();
let maxGap = 0;
let highestSeqSent = -1;
const latencies: number[] = [];

function post(msg: Readout): void {
  (self as unknown as Worker).postMessage(msg);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] ?? 0);
}

function computeDrops(): { dropped: number; maxGap: number } {
  // A "drop" is any sequence number that was sent but never came back, up to
  // the highest sequence number we DID receive (so the in-flight tail of the
  // last burst is not miscounted as dropped while the test is still running).
  let highestReceived = -1;
  for (const s of seen) {
    if (s > highestReceived) highestReceived = s;
  }
  let dropped = 0;
  let gapRun = 0;
  let worstGap = 0;
  for (let i = 0; i <= highestReceived; i++) {
    if (seen.has(i)) {
      gapRun = 0;
    } else {
      dropped += 1;
      gapRun += 1;
      if (gapRun > worstGap) worstGap = gapRun;
    }
  }
  return { dropped, maxGap: worstGap };
}

function snapshot(state: Readout['state'], note?: string): Readout {
  const sorted = [...latencies].sort((a, b) => a - b);
  const { dropped, maxGap: gap } = computeDrops();
  maxGap = gap;
  return {
    type: 'readout',
    state,
    sent,
    received,
    dropped,
    maxGap,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    timerInstallCount,
    note,
  };
}

// ---- Drain loop ------------------------------------------------------------

async function drainDatagrams(transport: WebTransport): Promise<void> {
  const reader = transport.datagrams.readable.getReader();
  // Tight loop: pull every available datagram with no awaits between reads
  // beyond the single read() that yields the next chunk.
  while (running) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      break;
    }
    if (result.done) break;
    const value = result.value;
    if (!value || value.byteLength < 12) continue;
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const seq = view.getUint32(0, false);
    const sentAtMs = Number(view.getBigUint64(4, false));
    const rttMs = performance.now() + performanceOriginOffset - sentAtMs;
    if (!seen.has(seq)) {
      seen.add(seq);
      received += 1;
      if (rttMs >= 0 && rttMs < 60_000) latencies.push(rttMs);
    }
  }
  try {
    reader.releaseLock();
  } catch {
    /* ignore */
  }
}

// performance.now() is relative to the worker's time origin; we add the
// origin offset so the timestamp baseline matches Date.now()-style epoch math
// used when writing the send timestamp. We capture both once at startup.
let performanceOriginOffset = 0;

// ---- Burst sender ----------------------------------------------------------

function nowEpochMs(): number {
  return performance.now() + performanceOriginOffset;
}

async function sendBurst(
  transport: WebTransport,
  burstCount: number,
  datagramBytes: number,
): Promise<void> {
  const writer = transport.datagrams.writable.getWriter();
  try {
    for (let i = 0; i < burstCount; i++) {
      const payload = new Uint8Array(Math.max(12, datagramBytes));
      const view = new DataView(payload.buffer);
      const seq = highestSeqSent + 1 + i;
      view.setUint32(0, seq, false);
      view.setBigUint64(4, BigInt(Math.round(nowEpochMs())), false);
      // Remaining bytes are zero-filled display-sized padding.
      await writer.write(payload);
      sent += 1;
    }
    highestSeqSent += burstCount;
  } finally {
    try {
      writer.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

// ---- Lifecycle -------------------------------------------------------------

async function start(msg: StartMessage): Promise<void> {
  if (running) return;
  // Reset state.
  sent = 0;
  received = 0;
  seen.clear();
  maxGap = 0;
  highestSeqSent = -1;
  latencies.length = 0;
  timerInstallCount = 0;
  performanceOriginOffset = Date.now() - performance.now();

  post(snapshot('connecting'));

  let certHash: ArrayBuffer;
  try {
    const raw = atob(msg.certHashB64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    certHash = bytes.buffer;
  } catch (e) {
    post(snapshot('error', `bad cert hash base64: ${String(e)}`));
    return;
  }

  try {
    wt = new WebTransport(msg.url, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: certHash }],
    });
    await wt.ready;
  } catch (e) {
    post(snapshot('error', `connect failed: ${String(e)}`));
    return;
  }

  running = true;
  const transport = wt;

  // Closed watcher.
  transport.closed
    .then(() => {
      running = false;
      post(snapshot('done', 'session closed by server'));
    })
    .catch((e) => {
      running = false;
      post(snapshot('error', `session error: ${String(e)}`));
    });

  // Start the drain loop (does not resolve until session ends).
  const drainPromise = drainDatagrams(transport);

  // Rolling readout while running.
  const readoutTimer = realSetInterval(() => {
    if (!running) return;
    post(snapshot('running'));
  }, 250);

  // Fire the bursts.
  for (let b = 0; b < msg.bursts && running; b++) {
    await sendBurst(transport, msg.burstCount, msg.datagramBytes);
    await new Promise((r) => realSetTimeout(r, msg.burstGapMs));
  }

  // Let the echo tail drain.
  await new Promise((r) => realSetTimeout(r, 1500));
  running = false;
  clearInterval(readoutTimer);

  post(snapshot('done', 'burst complete'));

  try {
    transport.close();
  } catch {
    /* ignore */
  }
  await drainPromise.catch(() => undefined);
}

function stop(): void {
  running = false;
  if (wt) {
    try {
      wt.close();
    } catch {
      /* ignore */
    }
    wt = null;
  }
  post(snapshot('done', 'stopped by user'));
}

self.onmessage = (ev: MessageEvent<InboundMessage>) => {
  const msg = ev.data;
  if (msg.type === 'start') {
    void start(msg);
  } else if (msg.type === 'stop') {
    stop();
  }
};
