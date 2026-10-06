import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DirectArtifactTestInfo {
  outputPath(...pathSegments: string[]): string;
  attach(
    name: string,
    options: { readonly path: string; readonly contentType: string },
  ): Promise<void>;
}

/**
 * Persist Direct evidence independently of the active Playwright reporter.
 *
 * Body attachments may remain reporter-owned in memory. Writing into the
 * test's preserved output directory first keeps the exact evidence available
 * when trace/video are deliberately disabled, including when attachment or a
 * later acceptance check fails.
 */
export async function attachDirectArtifact(
  testInfo: DirectArtifactTestInfo,
  name: string,
  options: { readonly body: string | Uint8Array; readonly contentType: string },
): Promise<string> {
  const artifactPath = testInfo.outputPath(name);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, options.body);
  await testInfo.attach(name, { path: artifactPath, contentType: options.contentType });
  return artifactPath;
}
