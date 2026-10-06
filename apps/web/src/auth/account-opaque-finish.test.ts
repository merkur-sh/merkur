import { afterEach, describe, expect, mock, test } from 'bun:test';

import { finishOpaqueInWorker, type OpaqueFinishRequest } from './account-opaque-finish';

const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
const request: OpaqueFinishRequest = {
  operation: 'login',
  parameters: {
    password: 'synthetic password',
    clientLoginState: 'synthetic state',
    loginResponse: 'synthetic answer',
    identifiers: { client: 'user', server: 'https://example.invalid' },
  },
};

class ControlledWorker {
  static readonly instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly postMessage = mock(() => undefined);
  readonly terminate = mock(() => undefined);

  constructor() {
    ControlledWorker.instances.push(this);
  }

  answer(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

afterEach(() => {
  ControlledWorker.instances.length = 0;
  if (originalWorker === undefined) Reflect.deleteProperty(globalThis, 'Worker');
  else Object.defineProperty(globalThis, 'Worker', originalWorker);
});

function installWorker(): void {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
}

function worker(): ControlledWorker {
  const instance = ControlledWorker.instances[0];
  if (instance === undefined) throw new Error('Worker was not created');
  return instance;
}

function response(exportKey: Uint8Array) {
  return { ok: true, result: { exportKey, proof: 'proof', serverPublicKey: 'public key' } };
}

describe('OPAQUE finish worker custody', () => {
  test('an already aborted operation creates no worker', async () => {
    installWorker();
    await expect(finishOpaqueInWorker(request, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  test('abort retires the worker and wipes a result already queued for delivery', async () => {
    installWorker();
    const controller = new AbortController();
    const pending = finishOpaqueInWorker(request, controller.signal);
    controller.abort();
    expect(worker().terminate).toHaveBeenCalled();
    const key = new Uint8Array(64).fill(42);
    worker().answer(response(key));
    await expect(pending).rejects.toThrow();
    expect(key.every((byte) => byte === 0)).toBe(true);
  });

  for (const failure of ['onerror', 'onmessageerror'] as const) {
    test(`${failure} wipes an immediately delivered late result`, async () => {
      installWorker();
      const pending = finishOpaqueInWorker(request);
      worker()[failure]?.();
      const key = new Uint8Array(64).fill(42);
      worker().answer(response(key));
      await expect(pending).rejects.toThrow();
      expect(key.every((byte) => byte === 0)).toBe(true);
      expect(worker().terminate).toHaveBeenCalled();
    });
  }

  test('a rejected response wipes any transferred export key', async () => {
    installWorker();
    const pending = finishOpaqueInWorker(request);
    const key = new Uint8Array(64).fill(42);
    worker().answer({ ...response(key), ok: false });
    await expect(pending).rejects.toThrow();
    expect(key.every((byte) => byte === 0)).toBe(true);
    expect(worker().terminate).toHaveBeenCalled();
  });
});
