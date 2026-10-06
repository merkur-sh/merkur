// Provides the `merkur-e2e` WebAssembly build to every Bun process: the server,
// the daemon CLI, scripts and tests.
//
// The authorization code in this package (`user-authorization`,
// `release-signature`, `build-identity`) and in `@merkur/auth` signs, verifies
// and hashes through that module, the same code the daemon links natively.
// Importing this registers a synchronous instantiator with `./e2e-wasm-runtime`;
// the module is compiled on the first call that signs, verifies or hashes, so a
// command that does none pays nothing. Entry points import this first: the
// server and daemon CLI `index.ts`, the test preload, and each Bun script that
// signs or verifies. Browser realms instantiate it themselves; see
// `apps/web/src/lib/e2e-wasm-module.ts`.
//
// The `file` import is what makes `bun build --compile` embed the module in the
// server and daemon executables, which have no repository to read it from. At
// runtime the binding is the file's path; the type checker sees the module's
// generated declarations instead, hence the guard.

import { readFileSync } from 'node:fs';
import * as bindings from '../../e2e-wasm/pkg/e2e_wasm.js';
import wasmPath from '../../e2e-wasm/pkg/e2e_wasm_bg.wasm' with { type: 'file' };
import { provideE2eWasm } from './e2e-wasm-runtime';

provideE2eWasm(() => {
  const path: unknown = wasmPath;
  if (typeof path !== 'string') throw new Error('e2e-wasm module path did not resolve to a file');
  bindings.initSync({ module: new Uint8Array(readFileSync(path)) });
  return bindings;
});
