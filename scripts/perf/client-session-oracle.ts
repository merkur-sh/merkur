import { bazelTool } from '../bazel-tool';

/**
 * The native daemon side of the authenticated Session fixture (`merkur-client`'s
 * `browser_session_oracle`). A benchmark consumes it built; it never compiles in a timed test.
 */
export function clientSessionOracleExecutable(root: string): string {
  return bazelTool(
    'browser_session_oracle',
    '//packages/merkur-client:browser_session_oracle',
    root,
  );
}
