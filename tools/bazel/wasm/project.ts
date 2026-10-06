import { promises as fs } from 'node:fs';
import path from 'node:path';

const [source, output] = process.argv.slice(2);
if (source === undefined || output === undefined) {
  throw new Error('WASM projection requires declared source and destination trees');
}
await fs.cp(path.resolve(source), path.resolve(output), {
  recursive: true,
  errorOnExist: true,
  dereference: true,
});
