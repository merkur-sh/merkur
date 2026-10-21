/**
 * The two pinned tools a profile needs, installed once per machine into
 * `~/.cache/merkur/profile-tools` (`MERKUR_PROFILE_TOOLS` moves it): Perfetto's
 * `trace_processor_shell`, from its release archive by checksum, and samply, built from the
 * pinned commit, the first whose profiles state their anchor-clock zero.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const PERFETTO_VERSION = 'v58.2';

/** Release archive checksums, by Perfetto's platform directory names. */
const PERFETTO_ARCHIVES = new Map([
  ['mac-arm64', '9dbd484a32c9833c95cf58ca5ef86d2c9ad4767149054ad4eaa52bdf027d1507'],
  ['linux-amd64', '32c739f71b2d39721afd294c0b038f2499a44a71b5b6bcdd85b83faca0b240b9'],
  ['linux-arm64', 'a82bf4111a340a7ea8577bcfd62e014e8e81b9e6a35a3190f5415fb800051ab0'],
]);

export const SAMPLY_REPOSITORY = 'https://github.com/mstange/samply.git';
export const SAMPLY_REVISION = '247df8fe0fa259ddb5e671bfe3121728e0d6119d';

export function toolsDirectory(): string {
  return (
    process.env.MERKUR_PROFILE_TOOLS ?? path.join(homedir(), '.cache', 'merkur', 'profile-tools')
  );
}

export function traceProcessorPath(): string {
  return path.join(toolsDirectory(), `trace_processor_shell-${PERFETTO_VERSION}`);
}

export function samplyPath(): string {
  return path.join(toolsDirectory(), 'bin', 'samply');
}

function perfettoPlatform(): string {
  const os = process.platform === 'darwin' ? 'mac' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `${os}-${arch}`;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function run(command: readonly string[], what: string): Promise<void> {
  const child = Bun.spawn([...command], { stdout: 'inherit', stderr: 'inherit' });
  if ((await child.exited) !== 0) throw new Error(`${what} failed: ${command.join(' ')}`);
}

/** Installs whichever pinned tool is missing; a present one is kept as it is. */
export async function setupTools(): Promise<void> {
  const directory = toolsDirectory();
  await mkdir(directory, { recursive: true });
  if (!(await exists(traceProcessorPath()))) {
    const platform = perfettoPlatform();
    const checksum = PERFETTO_ARCHIVES.get(platform);
    if (checksum === undefined) throw new Error(`no pinned trace_processor for ${platform}`);
    const url = `https://github.com/google/perfetto/releases/download/${PERFETTO_VERSION}/${platform}.zip`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const archive = new Uint8Array(await response.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== checksum) throw new Error(`${url}: sha256 ${digest}, pinned ${checksum}`);
    const staging = path.join(directory, `perfetto-${PERFETTO_VERSION}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging);
    await Bun.write(path.join(staging, 'archive.zip'), archive);
    await run(
      [
        'unzip',
        '-q',
        '-j',
        path.join(staging, 'archive.zip'),
        `${platform}/trace_processor_shell`,
        '-d',
        staging,
      ],
      'unzip',
    );
    await chmod(path.join(staging, 'trace_processor_shell'), 0o755);
    await rename(path.join(staging, 'trace_processor_shell'), traceProcessorPath());
    await rm(staging, { recursive: true, force: true });
  }
  if (!(await exists(samplyPath()))) {
    await run(
      [
        'cargo',
        'install',
        '--locked',
        '--root',
        directory,
        '--git',
        SAMPLY_REPOSITORY,
        '--rev',
        SAMPLY_REVISION,
        'samply',
      ],
      'building samply',
    );
    // macOS lets a profiler attach to a running process only once it is code-signed for it.
    if (process.platform === 'darwin') await run([samplyPath(), 'setup', '-y'], 'samply setup');
  }
}
