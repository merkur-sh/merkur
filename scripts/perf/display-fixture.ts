import path from 'node:path';
import { bazelTool } from '../bazel-tool';

/** The native MZ payload generator the display benchmarks compress with. */
export function displayFixtureExecutable(): string {
  return bazelTool(
    'display-fixture',
    '//packages/display-fixture',
    path.resolve(import.meta.dir, '../..'),
  );
}
