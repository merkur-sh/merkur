import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./terminal-worker.ts', import.meta.url), 'utf8');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  [
    'acceptClientGraphicsAsset',
    'consumeClientGraphicsAsset',
    'retryWaitingGraphicsAsset',
    'retireWaitingGraphicsAsset',
    'observeViewerPresentation',
  ]
    .map((name) => {
      const start = source.indexOf(`function ${name}(`);
      const asyncStart = source.lastIndexOf('async ', start);
      const actualStart = asyncStart === start - 6 ? asyncStart : start;
      const end = source.indexOf('\n}', start);
      if (start < 0 || end < start) throw new Error(`missing production callback ${name}`);
      return source.slice(actualStart, end + 2);
    })
    .join('\n'),
);

function harness() {
  let capacity = false,
    offers = 0,
    closes = 0,
    manifests = 0;
  const messages: {
    kind: string;
    lineage: number;
    frameFenceToken: number;
    key: string;
    taken: boolean;
  }[] = [];
  const context = {
    wasmTerminal: {
      viewer: {
        graphics_manifest: () => {
          manifests++;
        },
      },
    },
    renderer: {
      graphicsTileCapacity: () => capacity,
      offerGraphicsTile: () => {
        offers++;
        return true;
      },
    },
    activeSessionEpoch: 1,
    activeFrameFenceToken: 1,
    graphicsOfferSpaceReleased: false,
    graphicsPresentationDirty: false,
    graphicsResidents: new Set<string>(),
    displayEpoch: { generation: 1 },
    localPresentationPending: false,
    lastMouseMode: 0,
    observedViewerFrames: 0,
    observedPresentationRevision: 0,
    observedViewerPresentations: 0,
    perfEnabled: false,
    publishViewerLinks() {},
    graphicsEpoch: 1,
    waitingGraphicsAsset: null,
    ringWakePort: { postMessage: (message: (typeof messages)[number]) => messages.push(message) },
    Blob,
    nowMs: () => 0,
    viewerNowMs: () => 0,
    createImageBitmap: async () => ({
      close: () => {
        closes++;
      },
    }),
    drainViewerOutputs() {},
    wakeGraphics() {},
    armViewerDeadline() {},
  };
  Object.assign(context.wasmTerminal, { mouseMode: () => 0, presentationRevision: () => 0 });
  Object.assign(context.wasmTerminal.viewer, {
    generation: () => 1,
    applied_frames: () => 0,
    applied_presentations: () => 0,
  });
  runInNewContext(program, context);
  return {
    context,
    messages,
    async accept(asset = 0, lineage = 1, frameFenceToken = 1) {
      const bytes = new Uint8Array([1, 2, 3]);
      Object.assign(context, {
        asset: {
          kind: 'client_graphics_asset',
          lineage,
          frameFenceToken,
          epoch: lineage,
          key: 'key',
          asset,
          bytes,
        },
      });
      await runInNewContext('acceptClientGraphicsAsset(asset)', context);
      expect(bytes).toEqual(new Uint8Array(3));
    },
    retry() {
      runInNewContext('retryWaitingGraphicsAsset()', context);
    },
    observe() {
      runInNewContext('observeViewerPresentation()', context);
    },
    retire() {
      runInNewContext('retireWaitingGraphicsAsset()', context);
    },
    setCapacity(value: boolean) {
      capacity = value;
    },
    get offers() {
      return offers;
    },
    get closes() {
      return closes;
    },
    get manifests() {
      return manifests;
    },
  };
}

test('one decoded tile holds session credit until an actual renderer upload frees capacity', async () => {
  const host = harness();
  await host.accept();
  expect(host.offers).toBe(0);
  expect(host.messages).toEqual([]);
  expect(host.context.waitingGraphicsAsset).not.toBeNull();
  host.retry();
  expect(host.messages).toEqual([]);
  host.setCapacity(true);
  host.retry();
  expect(host.offers).toBe(1);
  expect(host.messages).toEqual([
    { kind: 'client_graphics_consumed', lineage: 1, frameFenceToken: 1, key: 'key', taken: true },
  ]);
  expect(host.context.waitingGraphicsAsset).toBeNull();
  host.retry();
  expect(host.offers).toBe(1);
});

test('a fence retires the waiting bitmap exactly once and releases its old credit', async () => {
  const host = harness();
  await host.accept();
  host.context.activeSessionEpoch = 2;
  host.retry();
  host.retire();
  expect(host.closes).toBe(1);
  expect(host.offers).toBe(0);
  // The credit returns for a tile no renderer took.
  expect(host.messages).toMatchObject([{ kind: 'client_graphics_consumed', taken: false }]);
});

test('stale assets and consumed manifests acknowledge once without decoding a bitmap', async () => {
  const host = harness();
  await host.accept(0, 0);
  await host.accept(1);
  expect(host.closes).toBe(0);
  expect(host.offers).toBe(0);
  expect(host.manifests).toBe(1);
  // The stale asset was dropped; the manifest went to the viewer.
  expect(host.messages).toMatchObject([{ taken: false }, { taken: true }]);
});

test('a scene replacement freeing queued upload space returns held delivery credit after the Rust borrow', async () => {
  const host = harness();
  await host.accept();
  host.setCapacity(true);
  host.context.graphicsOfferSpaceReleased = true;
  expect(host.messages).toEqual([]);
  host.observe();
  expect(host.offers).toBe(1);
  expect(host.messages).toHaveLength(1);
  expect(host.context.graphicsOfferSpaceReleased).toBe(false);
});

test('same-lineage assets from an old session instance cannot enter the replacement renderer', async () => {
  const host = harness();
  host.context.activeFrameFenceToken = 2;
  await host.accept(1, 1, 1);
  expect(host.manifests).toBe(0);
  expect(host.messages).toEqual([
    { kind: 'client_graphics_consumed', lineage: 1, frameFenceToken: 1, key: 'key', taken: false },
  ]);
  await host.accept(0, 1, 2);
  host.context.activeFrameFenceToken = 3;
  host.setCapacity(true);
  host.retry();
  expect(host.offers).toBe(0);
  expect(host.closes).toBe(1);
  expect(host.messages[1]?.frameFenceToken).toBe(2);
});
