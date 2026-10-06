import { promises as fs } from 'node:fs';
import path from 'node:path';

const [manifest, output] = process.argv.slice(2);
if (manifest === undefined || output === undefined) {
  throw new Error('Repository input tree requires its declared manifest and output');
}
const parsed: unknown = JSON.parse(await fs.readFile(manifest, 'utf8'));
if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
  throw new Error('Repository input tree manifest must map repository paths to action inputs');
}
for (const [relative, input] of Object.entries(parsed)) {
  if (
    typeof input !== 'string' ||
    path.isAbsolute(relative) ||
    relative.split('/').some((component) => component === '..' || component === '')
  ) {
    throw new Error(`Invalid declared repository input: ${relative}`);
  }
  const destination = path.join(output, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const source = await fs.stat(input);
  if (!source.isFile()) throw new Error(`Repository input is not a regular file: ${relative}`);
  await fs.copyFile(input, destination);
  await fs.chmod(destination, source.mode & 0o777);
}
