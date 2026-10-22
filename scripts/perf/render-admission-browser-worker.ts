// Test-only open-loop worker: production renderer/mailbox, injected observation
// delay AFTER genuine queue confirmation. Neither timestamp is physical paint.
import { WebGpuRenderer } from '../../apps/web/src/renderer-webgpu';
import {
  createRenderMailbox,
  type MailboxAction,
} from '../../apps/web/src/terminal/render-mailbox';
import { createCellGridFixture } from './cell-grid-fixture';

export interface RenderAdmissionBrowserRequest {
  canvas: OffscreenCanvas;
  arm: 'historical-two' | 'opportunity';
  dense: boolean;
  delayMs: number;
  offers: number;
  periodMs: number;
  burst: boolean;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
let retainedRenderer: WebGpuRenderer | null = null;
scope.onmessage = async (event: MessageEvent<RenderAdmissionBrowserRequest>) => {
  try {
    if (retainedRenderer !== null)
      throw new Error('one fixture owns this worker until termination');
    scope.postMessage(await run(event.data));
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};

async function run(request: RenderAdmissionBrowserRequest) {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('hardware WebGPU required');
  const identity = adapter.info;
  if (
    /swiftshader|software|llvmpipe/i.test(
      [identity.vendor, identity.architecture, identity.device, identity.description].join(' '),
    ) ||
    ('isFallbackAdapter' in adapter && adapter.isFallbackAdapter === true)
  )
    throw new Error('software GPU is not a terminal performance result');
  const probe = await adapter.requestDevice();
  const prototype = Object.getPrototypeOf(probe.queue);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'onSubmittedWorkDone');
  const original: GPUQueue['onSubmittedWorkDone'] = prototype.onSubmittedWorkDone;
  probe.destroy();
  if (descriptor === undefined) throw new Error('missing queue completion descriptor');
  let originalOutstanding = 0;
  let maxOriginalOutstanding = 0;
  let outstanding = 0;
  let maxOutstanding = 0;
  let pending = 0;
  let lastSubmitted = 0;
  let frame = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let offerTimer: ReturnType<typeof setTimeout> | undefined;
  // Reset timer nesting without polling so 1 ms burst offers are not silently
  // turned into 4 ms offers by the browser's recursive-timer clamp.
  const offerWake = new MessageChannel();
  const wakeOffer = () => offerWake.port2.postMessage(0);
  let active = true;
  let refreshingPeriod = 1000 / 60;
  let previousFrame = 0;
  const mailbox = createRenderMailbox();
  const offered: number[] = [];
  const due: number[] = [];
  const submitted: number[] = [];
  const gpuObserved: number[] = [];
  const callbackObserved: number[] = [];
  const cpu: number[] = [];
  const offerRevisionById: number[] = [];
  const grid = createCellGridFixture();
  function credit(values: number[], revision: number, at: number) {
    while (values.length < revision) values.push(at);
  }
  Object.defineProperty(prototype, 'onSubmittedWorkDone', {
    ...descriptor,
    value(this: GPUQueue) {
      const revision = pending;
      originalOutstanding++;
      maxOriginalOutstanding = Math.max(maxOriginalOutstanding, originalOutstanding);
      return original.call(this).then(() => {
        originalOutstanding--;
        credit(gpuObserved, revision, performance.now());
        if (request.delayMs === 0) return;
        return new Promise<void>((resolve) => setTimeout(resolve, request.delayMs));
      });
    },
  });
  let resolveDone: () => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const renderer = new WebGpuRenderer(
    undefined,
    undefined,
    (id) => {
      outstanding--;
      credit(callbackObserved, offerRevisionById[id] ?? 0, performance.now());
      if (!active) return;
      if (request.arm === 'opportunity') dispatch(mailbox.noteFrameComplete(id));
      else schedule();
      finish();
    },
    rejectDone,
  );
  retainedRenderer = renderer;
  function cancelWake() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  }
  function dispatch(action: MailboxAction) {
    if (!active) return;
    if (action.kind === 'render-now') {
      cancelWake();
      submit();
    } else if (action.kind === 'wait-frame') {
      if (!frame)
        frame = requestAnimationFrame((at) => {
          frame = 0;
          if (previousFrame && at - previousFrame < 35 && at - previousFrame > 4)
            refreshingPeriod = at - previousFrame;
          previousFrame = at;
          dispatch(mailbox.noteOpportunity(at));
        });
    } else if (action.kind === 'wait-fence') cancelWake();
  }
  function schedule() {
    if (!pending) return;
    if (request.arm === 'opportunity') dispatch(mailbox.noteDirty());
    else if (outstanding < 2) submit();
  }
  function submit() {
    if (!pending || !renderer.canSubmitFrame()) {
      if (request.arm === 'opportunity') mailbox.noteRenderAborted();
      return;
    }
    const revision = pending;
    grid.revise(revision, request.dense);
    const start = performance.now();
    const id = renderer.render(grid.memory.buffer, grid.state);
    const end = performance.now();
    cpu.push(end - start);
    offerRevisionById[id] = revision;
    credit(submitted, revision, end);
    pending = 0;
    lastSubmitted = revision;
    outstanding++;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    if (request.arm === 'opportunity') dispatch(mailbox.noteSubmitted(end, id));
  }
  function finish() {
    if (offered.length === request.offers && !pending && outstanding === 0) resolveDone();
  }
  const watchdog = setTimeout(() => rejectDone(new Error('admission experiment timed out')), 15000);
  try {
    await renderer.init(request.canvas, 8, 8);
    renderer.uploadAtlas(new Uint8Array(64).fill(255), [0, 0, 8, 8], [8, 8]);
    const start = performance.now();
    const offerOffset = (index: number) =>
      request.burst ? Math.floor(index / 6) * 100 + (index % 6) : index * request.periodMs;
    function offer() {
      const revision = offered.length + 1;
      offered.push(performance.now());
      due.push(start + offerOffset(revision - 1));
      pending = revision;
      schedule();
      if (revision < request.offers)
        offerTimer = setTimeout(
          wakeOffer,
          Math.max(0, start + offerOffset(revision) - performance.now()),
        );
    }
    offerWake.port1.onmessage = offer;
    offer();
    await done;
    // Queue completion is not OffscreenCanvas placeholder publication. Leave
    // a worker rendering opportunity before the runner's untimed pixel oracle;
    // cancelling the final idle wake here could leave its preceding image.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('final worker presentation opportunity missing')),
        1000,
      );
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return {
      arm: request.arm,
      dense: request.dense,
      injectedCallbackDelayMs: request.delayMs,
      identity: {
        vendor: identity.vendor,
        architecture: identity.architecture,
        description: identity.description,
      },
      offered,
      due,
      submitted,
      gpuObserved,
      callbackObserved,
      cpu,
      maxOriginalOutstanding,
      maxOutstanding,
      lastSubmitted,
      refreshPeriodMs: refreshingPeriod,
    };
  } finally {
    active = false;
    cancelWake();
    clearTimeout(offerTimer);
    offerWake.port1.close();
    offerWake.port2.close();
    clearTimeout(watchdog);
    Object.defineProperty(prototype, 'onSubmittedWorkDone', descriptor);
    // Keep the final canvas for the runner's untimed pixel oracle. The worker
    // lifetime bounds all GPU resources; runner terminates it after that check.
  }
}
