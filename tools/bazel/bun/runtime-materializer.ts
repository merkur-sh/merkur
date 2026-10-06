import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { cp, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';

export interface BunRuntimeManifest {
  readonly files: Readonly<Record<string, { readonly runfile: string; readonly link: boolean }>>;
  readonly cwd: string;
  readonly config: string;
}

export function runtimeMember(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split('/').some((part) => part === '..'))
    throw new Error(`Runtime input escaped declared root: ${relative}`);
  return path.join(root, relative);
}

/** Shared declared File/Tree materialization for tests and the development runner. */
export async function materializeBunRuntime(
  manifest: BunRuntimeManifest,
  runfilesRoot: string,
  runtimeRoot: string,
  workspacePackages: Readonly<Record<string, string>> = {},
  configuredInputs?: { readonly root: string; readonly files: Readonly<Record<string, string>> },
): Promise<void> {
  const workspaceLinks: [string, string][] = [];
  const directories = new Set<string>();
  for (const [relative, entry] of Object.entries(manifest.files)) {
    const destination = runtimeMember(runtimeRoot, relative);
    const workspacePackage = workspacePackages[entry.runfile];
    const input = configuredInputs?.files[entry.runfile];
    if (configuredInputs !== undefined && input === undefined)
      throw new Error('Runtime mapping lost its configured input File');
    const source =
      workspacePackage !== undefined
        ? runtimeMember(runtimeRoot, workspacePackage)
        : runtimeMember(configuredInputs?.root ?? runfilesRoot, input ?? entry.runfile);
    const parent = path.dirname(destination);
    if (!directories.has(parent)) {
      mkdirSync(parent, { recursive: true });
      directories.add(parent);
    }
    if (workspacePackage !== undefined) workspaceLinks.push([source, destination]);
    else if (entry.link) await symlink(await realpath(source), destination);
    // A declared File is one copy of the bytes its carrier names, which the platform makes
    // without reading them where it can; only a declared Tree is walked.
    else if (statSync(source).isDirectory())
      await cp(source, destination, { recursive: true, dereference: true });
    else copyFileSync(source, destination);
  }
  for (const [source, destination] of workspaceLinks)
    await symlink(await realpath(source), destination);
}
