// Observation experiment only. Mapping an unrelated sentinel buffer does NOT
// prove completion of the renderer's queue prefix and never releases its owner.
import { WebGpuRenderer } from '../../apps/web/src/renderer-webgpu';

declare const GPUBufferUsage: {
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly MAP_READ: number;
};
declare const GPUMapMode: { readonly READ: number };

export interface CompletionObserverRequest {
  canvas: OffscreenCanvas;
  sentinel: boolean;
  dense: boolean;
  offers: number;
  periodMs: number;
}

interface Sample {
  revision: number;
  cpuMs: number;
  submittedAt: number;
  queueObservedAt: number;
  mapObservedAt: number | null;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<CompletionObserverRequest>) => {
  try {
    scope.postMessage(await run(event.data));
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};

async function run(request: CompletionObserverRequest) {
  const probe = await navigator.gpu.requestAdapter();
  if (!probe) throw new Error('WebGPU unavailable');
  const adapterPrototype = Object.getPrototypeOf(probe);
  const deviceDescriptor = Object.getOwnPropertyDescriptor(adapterPrototype, 'requestDevice');
  if (!deviceDescriptor) throw new Error('requestDevice descriptor unavailable');
  const requestDevice: GPUAdapter['requestDevice'] = adapterPrototype.requestDevice;
  let capturedDevice: GPUDevice | undefined;
  let identity: GPUAdapterInfo | undefined;
  Object.defineProperty(adapterPrototype, 'requestDevice', {
    ...deviceDescriptor,
    async value(this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
      identity = this.info;
      if (
        /swiftshader|software|llvmpipe/i.test(
          [identity.vendor, identity.architecture, identity.device, identity.description].join(' '),
        ) ||
        ('isFallbackAdapter' in this && this.isFallbackAdapter === true)
      )
        throw new Error('software GPU is not a hardware completion result');
      capturedDevice = await requestDevice.call(this, descriptor);
      return capturedDevice;
    },
  });
  let outstanding = 0;
  let pending = 0;
  let offered = 0;
  let activeSample: Sample | null = null;
  let activeSlot = -1;
  let active = true;
  let offerTimer: ReturnType<typeof setTimeout> | undefined;
  const samples: Sample[] = [];
  const busy = new Uint8Array(2);
  let resolveDone: () => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const renderer = new WebGpuRenderer(
    undefined,
    undefined,
    () => {
      outstanding--;
      schedule();
      finish();
    },
    rejectDone,
  );
  try {
    await renderer.init(request.canvas, 8, 8);
  } finally {
    Object.defineProperty(adapterPrototype, 'requestDevice', deviceDescriptor);
  }
  const device = capturedDevice;
  if (!device || !identity) throw new Error('actual renderer device was not captured');
  const source = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  new Uint32Array(source.getMappedRange())[0] = 0x13579bdf;
  source.unmap();
  const targets = Array.from({ length: 2 }, () =>
    device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
  );
  const encoderPrototype = Object.getPrototypeOf(device.createCommandEncoder());
  const finishDescriptor = Object.getOwnPropertyDescriptor(encoderPrototype, 'finish');
  const queuePrototype = Object.getPrototypeOf(device.queue);
  const submitDescriptor = Object.getOwnPropertyDescriptor(queuePrototype, 'submit');
  const completionDescriptor = Object.getOwnPropertyDescriptor(
    queuePrototype,
    'onSubmittedWorkDone',
  );
  if (!finishDescriptor || !submitDescriptor || !completionDescriptor)
    throw new Error('GPU descriptors missing');
  const encoderFinish: GPUCommandEncoder['finish'] = encoderPrototype.finish;
  const queueSubmit: GPUQueue['submit'] = queuePrototype.submit;
  const queueDone: GPUQueue['onSubmittedWorkDone'] = queuePrototype.onSubmittedWorkDone;
  Object.defineProperty(encoderPrototype, 'finish', {
    ...finishDescriptor,
    value(this: GPUCommandEncoder, descriptor?: GPUCommandBufferDescriptor) {
      if (request.sentinel && activeSample) {
        const target = targets[activeSlot];
        if (!target) throw new Error('sentinel has no bounded readback owner');
        // Appended to the exact terminal encoder, after its render pass.
        this.copyBufferToBuffer(source, 0, target, 0, 4);
      }
      return encoderFinish.call(this, descriptor);
    },
  });
  Object.defineProperty(queuePrototype, 'submit', {
    ...submitDescriptor,
    value(this: GPUQueue, commands: Iterable<GPUCommandBuffer>) {
      const sample = activeSample;
      const slot = activeSlot;
      queueSubmit.call(this, commands);
      if (!sample) return;
      sample.submittedAt = performance.now();
      if (!request.sentinel) return;
      const target = targets[slot];
      if (!target) throw new Error('missing map slot');
      void target
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          sample.mapObservedAt = performance.now();
          if (new Uint32Array(target.getMappedRange())[0] !== 0x13579bdf)
            throw new Error('sentinel readback mismatch');
          target.unmap();
          busy[slot] = 0;
          schedule();
          finish();
        })
        .catch(rejectDone);
    },
  });
  Object.defineProperty(queuePrototype, 'onSubmittedWorkDone', {
    ...completionDescriptor,
    value(this: GPUQueue) {
      const sample = activeSample;
      return queueDone.call(this).then(() => {
        if (sample) sample.queueObservedAt = performance.now();
      });
    },
  });
  const memory = new Float32Array(30 * 7 + 2400 * 14);
  const bg = { ptr: 0, count: 30 };
  const glyph = { ptr: 30 * 28, count: 2400 };
  const empty = { ptr: 0, count: 0 };
  const versions = {
    bg: 0,
    glyph: 0,
    deco: 0,
    cursor: 0,
    bgDirtyOffset: 0,
    bgDirtyCount: 30,
    glyphDirtyOffset: 0,
    glyphDirtyCount: 2400,
    decoDirtyOffset: 0,
    decoDirtyCount: 0,
    cursorDirtyOffset: 0,
    cursorDirtyCount: 0,
  };
  for (let row = 0; row < 30; row++) memory.set([0, row * 20, 800, 20, 0, 0.1, 0.2], row * 7);
  for (let cell = 0; cell < 2400; cell++)
    memory.set(
      [(cell % 80) * 10 + 3, Math.floor(cell / 80) * 20, 0, 0, 6, 16, 0, 0, 1, 1, 1, 1, 1, 1],
      210 + cell * 14,
    );
  function schedule() {
    if (!active || !pending || outstanding >= 2 || !renderer.canSubmitFrame()) return;
    const slot = busy.indexOf(0);
    if (request.sentinel && slot < 0) return;
    const revision = pending;
    pending = 0;
    const count = request.dense ? 30 : 1;
    for (let row = 0; row < count; row++) memory[row * 7 + 4] = (revision % 200) / 255;
    versions.bg = revision;
    versions.bgDirtyCount = count;
    versions.glyph = revision;
    versions.glyphDirtyCount = request.dense ? 2400 : 1;
    memory[220] = (revision % 200) / 255;
    const sample: Sample = {
      revision,
      cpuMs: 0,
      submittedAt: 0,
      queueObservedAt: 0,
      mapObservedAt: null,
    };
    samples.push(sample);
    activeSample = sample;
    activeSlot = slot;
    if (request.sentinel) busy[slot] = 1;
    const start = performance.now();
    renderer.render(memory.buffer, bg, glyph, empty, empty, [800, 600], versions);
    sample.cpuMs = performance.now() - start;
    activeSample = null;
    outstanding++;
  }
  function finish() {
    if (offered === request.offers && !pending && !outstanding && !busy.includes(1)) resolveDone();
  }
  const watchdog = setTimeout(
    () => rejectDone(new Error('completion observer experiment timed out')),
    15000,
  );
  try {
    renderer.uploadAtlas(new Uint8Array(64).fill(255), [0, 0, 8, 8], [8, 8]);
    const start = performance.now();
    function offer() {
      pending = ++offered;
      schedule();
      if (offered < request.offers)
        offerTimer = setTimeout(
          offer,
          Math.max(0, start + offered * request.periodMs - performance.now()),
        );
    }
    offer();
    await done;
    return {
      sentinel: request.sentinel,
      dense: request.dense,
      offered,
      samples,
      identity: {
        vendor: identity.vendor,
        architecture: identity.architecture,
        device: identity.device,
        description: identity.description,
      },
      interpretation:
        'Real callbacks, no injected delay. Sentinel mapping is buffer-only observation, not queue-prefix retirement or physical paint.',
    };
  } finally {
    active = false;
    clearTimeout(offerTimer);
    clearTimeout(watchdog);
    Object.defineProperty(encoderPrototype, 'finish', finishDescriptor);
    Object.defineProperty(queuePrototype, 'submit', submitDescriptor);
    Object.defineProperty(queuePrototype, 'onSubmittedWorkDone', completionDescriptor);
    renderer.destroy();
    source.destroy();
    for (const target of targets) target.destroy();
  }
}
