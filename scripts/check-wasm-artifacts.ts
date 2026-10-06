import path from 'node:path';
import { assertRepositoryTermWasmArtifactsCurrent } from './term-wasm-provenance';

await assertRepositoryTermWasmArtifactsCurrent(path.resolve(import.meta.dir, '..'));
process.stdout.write('WASM artifact provenance: pass\n');
