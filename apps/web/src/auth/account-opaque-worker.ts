import { OPAQUE_PASSWORD_STRETCHING } from '@merkur/shared/opaque-password-policy';
import * as opaque from '@serenity-kit/opaque';

import type { OpaqueFinishRequest } from './account-opaque-finish';
import { decodeBase64UrlExact } from './encoding';

// One finish per realm. The caller terminates this worker on success or failure,
// retiring the library's password/export-key strings and Argon2 workspace.
self.onmessage = async (event: MessageEvent<OpaqueFinishRequest>) => {
  try {
    await opaque.ready;
    const request = event.data;
    const result =
      request.operation === 'registration'
        ? opaque.client.finishRegistration({
            ...request.parameters,
            keyStretching: OPAQUE_PASSWORD_STRETCHING,
          })
        : opaque.client.finishLogin({
            ...request.parameters,
            keyStretching: OPAQUE_PASSWORD_STRETCHING,
          });
    if (result === undefined) {
      self.postMessage({ ok: true, result: null });
      return;
    }
    const exportKey = decodeBase64UrlExact(result.exportKey, 64, 'OPAQUE export key');
    const proof =
      'registrationRecord' in result ? result.registrationRecord : result.finishLoginRequest;
    self.postMessage(
      { ok: true, result: { proof, exportKey, serverPublicKey: result.serverStaticPublicKey } },
      { transfer: [exportKey.buffer] },
    );
  } catch {
    self.postMessage({ ok: false });
  }
};
