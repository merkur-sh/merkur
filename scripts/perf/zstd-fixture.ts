import path from 'node:path';
import { bazelTool } from '../bazel-tool';

/** The native zstd frame and dictionary generator the display benchmarks compress with. */
export function zstdFixtureExecutable(): string {
  return bazelTool(
    'zstd-fixture',
    '//packages/zstd-fixture',
    path.resolve(import.meta.dir, '../..'),
  );
}
