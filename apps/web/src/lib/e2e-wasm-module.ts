// The one instantiation of the `merkur-e2e` WebAssembly module per browser
// realm (main thread, transport worker).
//
// wasm-bindgen's glue keeps the instance in a module-level binding and only
// skips instantiation once a previous call has *finished*; two first calls in
// flight at once would each instantiate, and the second would swap the memory
// out from under objects created by the first. So every caller in the realm
// goes through this memo: the transport loader (Noise, ML-KEM bootstrap) and
// the authorization workflows (`@merkur/shared/user-authorization`,
// `build-identity`: ML-DSA-87, SHA-2, HMAC). Worker and main thread fetch the
// same hashed asset, so the second realm reads it from cache.
//
// Nothing loads it at startup. The sign-in page pays for it only when a
// credential is derived or checked, alongside the OPAQUE round trip.
// Terminal startup also awaits this memo before its Rust capture owner admits input.

import { installE2eWasm } from '@merkur/shared/e2e-wasm-runtime';
import * as bindings from '../../../../packages/e2e-wasm/pkg/e2e_wasm.js';

let instance: Promise<bindings.InitOutput> | null = null;

export function loadE2eWasmModule(): Promise<bindings.InitOutput> {
  instance ??= bindings.default().then(
    (output) => {
      // The shared authorization modules reach the bindings through this.
      installE2eWasm(bindings);
      return output;
    },
    (error: unknown) => {
      // A failed fetch must not poison every later attempt in this realm.
      instance = null;
      throw error;
    },
  );
  return instance;
}
