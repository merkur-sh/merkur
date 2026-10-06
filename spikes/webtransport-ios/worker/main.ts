/**
 * main.ts — real-device acceptance harness UI and controller.
 *
 * Opens the drain worker, lets you pick a direct vs relay URL + cert hash,
 * starts the burst test, HAMMERS the main thread with synthetic layout + CPU
 * load (to exercise the iOS failure mode where main-thread work starves the WT
 * datagram drain), and renders the rolling drop/timer/latency readout.
 *
 * This maintained device harness is isolated from apps/web's build. It uses
 * native ESM and imports the drain as a module worker.
 */

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

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
};

const urlInput = $('url') as HTMLInputElement;
const certInput = $('cert') as HTMLInputElement;
const burstCountInput = $('burstCount') as HTMLInputElement;
const datagramBytesInput = $('datagramBytes') as HTMLInputElement;
const burstsInput = $('bursts') as HTMLInputElement;
const burstGapInput = $('burstGap') as HTMLInputElement;
const loadToggle = $('loadToggle') as HTMLInputElement;
const startBtn = $('start') as HTMLButtonElement;
const stopBtn = $('stop') as HTMLButtonElement;

const out = {
  state: $('o-state'),
  sent: $('o-sent'),
  received: $('o-received'),
  dropped: $('o-dropped'),
  maxGap: $('o-maxgap'),
  p50: $('o-p50'),
  p95: $('o-p95'),
  timers: $('o-timers'),
  note: $('o-note'),
};

// ---- Worker wiring ---------------------------------------------------------

let worker: Worker | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  // Module worker; the dev server transpiles drain-worker.ts → JS.
  worker = new Worker(new URL('./drain-worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (ev: MessageEvent<Readout>) => render(ev.data);
  worker.onerror = (e) => {
    out.state.textContent = 'worker error';
    out.note.textContent = e.message;
  };
  return worker;
}

function render(r: Readout): void {
  out.state.textContent = r.state;
  out.sent.textContent = String(r.sent);
  out.received.textContent = String(r.received);
  out.dropped.textContent = String(r.dropped);
  out.maxGap.textContent = String(r.maxGap);
  out.p50.textContent = `${r.p50} ms`;
  out.p95.textContent = `${r.p95} ms`;
  out.timers.textContent = String(r.timerInstallCount);
  out.note.textContent = r.note ?? '';

  // Color the drop cell: green at 0, red otherwise.
  out.dropped.style.color = r.dropped === 0 ? '#19c37d' : '#ff5c5c';
  out.maxGap.style.color = r.maxGap === 0 ? '#19c37d' : '#ff5c5c';
}

// ---- Main-thread load hammer ----------------------------------------------
//
// Exercises the target failure condition: a busy main thread that can starve a
// WebTransport datagram drain. The dedicated worker should isolate the drain
// from both pressures:
//   1) CPU: a busy arithmetic loop on a rAF cadence.
//   2) Layout: forced synchronous reflow by reading offsetHeight after mutating
//      a large DOM subtree.

let loadRaf = 0;
const churn = $('churn');

function hammer(): void {
  if (!loadToggle.checked) {
    loadRaf = requestAnimationFrame(hammer);
    return;
  }
  // CPU burn (~several ms).
  let acc = 0;
  const end = performance.now() + 6;
  while (performance.now() < end) {
    acc += Math.sqrt(acc + Math.random() * 1000) * Math.sin(acc);
  }
  // Layout thrash: mutate then force reflow.
  const n = 200;
  let html = '';
  for (let i = 0; i < n; i++) {
    html += `<div style="height:${1 + (i % 7)}px">${acc.toFixed(2)}-${i}</div>`;
  }
  churn.innerHTML = html;
  // Force synchronous layout.
  void churn.offsetHeight;
  loadRaf = requestAnimationFrame(hammer);
}

// ---- Controls --------------------------------------------------------------

startBtn.addEventListener('click', () => {
  const w = ensureWorker();
  startBtn.disabled = true;
  stopBtn.disabled = false;
  out.note.textContent = '';
  w.postMessage({
    type: 'start',
    url: urlInput.value.trim(),
    certHashB64: certInput.value.trim(),
    burstCount: Number(burstCountInput.value) || 1000,
    datagramBytes: Number(datagramBytesInput.value) || 800,
    bursts: Number(burstsInput.value) || 20,
    burstGapMs: Number(burstGapInput.value) || 100,
  });
});

stopBtn.addEventListener('click', () => {
  worker?.postMessage({ type: 'stop' });
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

stopBtn.disabled = true;

// Kick the load loop (gated by the checkbox).
loadRaf = requestAnimationFrame(hammer);

// Expose for debugging in the console.
(window as unknown as { __stopHammer: () => void }).__stopHammer = () =>
  cancelAnimationFrame(loadRaf);
