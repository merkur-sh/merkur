// The instantiated `merkur-e2e` WebAssembly bindings for this realm.
//
// Authorization records (`user-authorization`, `build-identity`,
// `release-signature`, `@merkur/auth`) sign, verify and hash through the same
// libcrux code the daemon links. They do not import the wasm-bindgen glue
// themselves: the glue is an ES module that reads `import.meta`, so any import
// graph that merely parses these records (Playwright fixtures loading
// `@merkur/config` under Node, for one) would have to load it. Instead each
// realm's loader hands its bindings over here:
//
// - Bun (server, daemon CLI, scripts, tests): `@merkur/shared/e2e-wasm-bun`
//   provides a synchronous instantiator, run on the first call that needs it. A
//   CLI command that never signs or verifies (`merkur version`, `start`) never
//   compiles the module, and never needs WebAssembly SIMD from its host.
// - Browser main thread and transport worker: `apps/web/src/lib/e2e-wasm-module.ts`
//   instantiates asynchronously and installs the result.
//
// Reaching for the bindings in a realm that provided neither is a programming
// error and says so.

import type * as E2eWasmBindings from '../../e2e-wasm/pkg/e2e_wasm.js';

export type E2eWasm = typeof E2eWasmBindings;

let installed: E2eWasm | null = null;
let instantiate: (() => E2eWasm) | null = null;

/** Bindings already instantiated by the realm (the browser's async path). */
export function installE2eWasm(bindings: E2eWasm): void {
  installed = bindings;
}

/** A synchronous instantiator, run once on first use (the Bun path). */
export function provideE2eWasm(instantiator: () => E2eWasm): void {
  instantiate = instantiator;
}

export function e2eWasm(): E2eWasm {
  if (installed !== null) return installed;
  if (instantiate === null) {
    throw new Error('merkur-e2e WebAssembly is not instantiated in this realm');
  }
  installed = instantiate();
  return installed;
}
