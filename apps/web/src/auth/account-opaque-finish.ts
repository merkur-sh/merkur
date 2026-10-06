export type OpaqueFinishRequest =
  | {
      readonly operation: 'registration';
      readonly parameters: {
        readonly password: string;
        readonly clientRegistrationState: string;
        readonly registrationResponse: string;
        readonly identifiers: { readonly client: string; readonly server: string };
      };
    }
  | {
      readonly operation: 'login';
      readonly parameters: {
        readonly password: string;
        readonly clientLoginState: string;
        readonly loginResponse: string;
        readonly identifiers: { readonly client: string; readonly server: string };
      };
    };

export interface OpaqueFinishResult {
  readonly proof: string;
  readonly exportKey: Uint8Array;
  readonly serverPublicKey: string;
}

function wipeReceivedExportKey(data: unknown): void {
  if (
    typeof data === 'object' &&
    data !== null &&
    'result' in data &&
    typeof data.result === 'object' &&
    data.result !== null &&
    'exportKey' in data.result &&
    data.result.exportKey instanceof Uint8Array
  )
    data.result.exportKey.fill(0);
}

export async function finishOpaqueInWorker(
  request: OpaqueFinishRequest,
  signal?: AbortSignal,
): Promise<OpaqueFinishResult | null> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./account-opaque-worker.ts', import.meta.url), {
    type: 'module',
    name: 'account-password-stretching',
  });
  let abortListener: (() => void) | undefined;
  let settled = false;
  try {
    return await new Promise<OpaqueFinishResult | null>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (settled) {
          wipeReceivedExportKey(data);
          return;
        }
        settled = true;
        if (typeof data !== 'object' || data === null || !('ok' in data) || data.ok !== true) {
          wipeReceivedExportKey(data);
          reject(new Error('Account authentication failed'));
          return;
        }
        if (!('result' in data)) {
          reject(new Error('Invalid account authentication response'));
          return;
        }
        if (data.result === null) {
          resolve(null);
          return;
        }
        const result = data.result;
        if (
          typeof result !== 'object' ||
          result === null ||
          !('proof' in result) ||
          typeof result.proof !== 'string' ||
          !('exportKey' in result) ||
          !(result.exportKey instanceof Uint8Array) ||
          result.exportKey.byteLength !== 64 ||
          !('serverPublicKey' in result) ||
          typeof result.serverPublicKey !== 'string'
        ) {
          if (
            typeof result === 'object' &&
            result !== null &&
            'exportKey' in result &&
            result.exportKey instanceof Uint8Array
          ) {
            result.exportKey.fill(0);
          }
          reject(new Error('Invalid account authentication response'));
          return;
        }
        resolve({
          proof: result.proof,
          exportKey: result.exportKey,
          serverPublicKey: result.serverPublicKey,
        });
      };
      worker.onerror = () => {
        settled = true;
        reject(new Error('Account authentication worker failed'));
      };
      worker.onmessageerror = () => {
        settled = true;
        reject(new Error('Invalid account authentication response'));
      };
      abortListener = () => {
        settled = true;
        worker.terminate();
        reject(signal?.reason ?? new DOMException('Account authentication aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abortListener, { once: true });
      worker.postMessage(request);
    });
  } finally {
    settled = true;
    if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener);
    worker.terminate();
  }
}
