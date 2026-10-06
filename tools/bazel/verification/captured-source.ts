import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type SourceManifest, validSourceManifest } from './snapshot';
import { publishCapturedSourceTree, sourceLayout } from './source-tree';

/** Original captured payload Files, never live source or generated replacement bytes. */
export async function publishCapturedSourceInputs(
  source: SourceManifest,
  inputs: Readonly<Record<string, string>>,
  output: string,
): Promise<void> {
  if (!validSourceManifest(source)) throw new Error('Captured source manifest is invalid');
  const files = [...sourceLayout(source).files.values()];
  const expected = files.map((input) => input.path).sort();
  if (JSON.stringify(Object.keys(inputs).sort()) !== JSON.stringify(expected))
    throw new Error('Complete original captured source File membership is required');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'captured-source-inputs-'));
  try {
    for (const input of files) {
      const original = inputs[input.path];
      if (original === undefined) throw new Error('Captured source File disappeared');
      const info = statSync(original);
      if (!info.isFile() || (info.mode & 0o777) !== input.mode)
        throw new Error('Captured original source File mode differs from its manifest');
      const target = path.join(scratch, input.path);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(original, target);
    }
    try {
      mkdirSync(output);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if (!lstatSync(output).isDirectory())
      throw new Error('Captured source output must be an ordinary engine-owned directory');
    await publishCapturedSourceTree({ tree: scratch, root: output, source });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [manifest, mapping, output] = process.argv.slice(2);
  if (manifest === undefined || mapping === undefined || output === undefined)
    throw new Error(
      'Captured source action requires its original manifest, File mapping and output',
    );
  const source: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const inputs: unknown = JSON.parse(readFileSync(mapping, 'utf8'));
  if (
    !validSourceManifest(source) ||
    inputs === null ||
    typeof inputs !== 'object' ||
    Array.isArray(inputs) ||
    !Object.values(inputs).every((input) => typeof input === 'string')
  )
    throw new Error('Captured source action inputs are malformed');
  await publishCapturedSourceInputs(source, inputs as Record<string, string>, output);
}
