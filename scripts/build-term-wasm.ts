import path from 'node:path';
import { hardCutGeneratedTermWasmGlue } from './term-wasm-current-glue';
import { trainTermWasmProfile } from './term-wasm-pgo';
import { writeTermWasmBuildManifest } from './term-wasm-provenance';
import { buildWasmCrate, REPO_ROOT } from './wasm-toolchain';

// The shipped artifact is profile-guided; `--config` joins the profile to the
// crate's own wasm32 rustflags rather than replacing them.
const profile = await trainTermWasmProfile();
await buildWasmCrate('packages/term-wasm', [
  '--config',
  `target.wasm32-unknown-unknown.rustflags=${JSON.stringify([`-Cprofile-use=${profile}`])}`,
]);

const artifactDirectory = path.join(REPO_ROOT, 'packages/term-wasm/pkg');
await hardCutGeneratedTermWasmGlue(artifactDirectory);
await writeTermWasmBuildManifest(REPO_ROOT, artifactDirectory);
