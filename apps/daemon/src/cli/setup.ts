import { mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  currentReleasePlatform,
  merkurReleasePublicKey,
  merkurReleaseSequence,
  merkurVersion,
  normalizeUnknownError,
  RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE,
  RELEASE_MANIFEST_MAX_BYTES,
  RELEASE_SIGNATURE_MAX_BYTES,
} from '@merkur/shared';
import { releasePublicKeyFingerprint } from '@merkur/shared/release-signature';
import { Clock, Effect } from 'effect';

import { merkurInstallRootPath, readLoginShellEffect } from '../config';
import type { Logger } from '../logger';
import { installDaemonServiceForExecutableEffect } from './install';
import { runLinkCommandEffect } from './link';
import {
  installVerifiedReleaseEffect,
  persistReleaseTrustFloorEffect,
  readReleaseTrustFloorEffect,
  resolveVersionedDaemonExecutables,
  verifyReleaseCandidateEffect,
} from './update';

/** Marks the lines setup appends to a shell startup file, so a re-run adds nothing. */
export const PATH_BLOCK_MARKER = '# Added by the Merkur installer';

export interface SetupArguments {
  readonly artifactPath: string;
  readonly manifestPath: string;
  readonly signaturePath: string;
  /** `merkur link` arguments (origin first), or `null` to install without linking. */
  readonly linkArguments: readonly string[] | null;
}

/**
 * `merkur setup <artifact> <manifest> <signature> [--link <origin> [link flags]]`.
 *
 * Run by the installer script from the binary it just unpacked. The script is
 * the only thing that touches the network; this verifies what it fetched with
 * the same code an update uses, installs it into the versioned layout, and
 * makes `merkur` callable by name.
 *
 * Trust on first use: the binary checking its own release is only as trusted as
 * the HTTPS channel it arrived through. What it adds is that everything after
 * this — every update — is held to the ML-DSA-87 pin, and that it prints the
 * pin's fingerprint for comparison against a channel this download did not
 * come through.
 */
export function parseSetupArguments(args: readonly string[]): SetupArguments | null {
  const [artifactPath, manifestPath, signaturePath, ...rest] = args;
  if (artifactPath === undefined || manifestPath === undefined || signaturePath === undefined) {
    return null;
  }
  if (rest.length === 0) {
    return { artifactPath, manifestPath, signaturePath, linkArguments: null };
  }
  if (rest[0] !== '--link' || rest.length < 2) return null;
  return { artifactPath, manifestPath, signaturePath, linkArguments: rest.slice(1) };
}

export async function runSetupCommand(args: string[], logger: Logger): Promise<number> {
  return Effect.runPromise(runSetupCommandEffect(args, logger));
}

function runSetupCommandEffect(args: string[], logger: Logger): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const parsed = parseSetupArguments(args);
    if (parsed === null) {
      logger.error('daemon_setup_usage', {
        usage:
          'merkur setup <artifact.tar.gz> <merkur-release.json> <merkur-release.sig> [--link <origin> [--identity-backend software] [--replace-identity]]',
      });
      return 2;
    }

    const version = merkurVersion();
    const sequence = merkurReleaseSequence();
    const platform = currentReleasePlatform();
    if (version === 'dev' || sequence < RELEASE_BOOTSTRAP_MINIMUM_SEQUENCE) {
      logger.error('daemon_setup_unsupported', {
        reason: 'setup runs only from a signed release build',
      });
      return 1;
    }
    if (platform === null) {
      logger.error('daemon_setup_unsupported', {
        reason: `no release artifacts for ${process.platform}-${process.arch}`,
      });
      return 1;
    }

    const installRoot = merkurInstallRootPath();
    const [manifestBytes, signatureBytes] = yield* Effect.all([
      readBoundedFileEffect(parsed.manifestPath, RELEASE_MANIFEST_MAX_BYTES),
      readBoundedFileEffect(parsed.signaturePath, RELEASE_SIGNATURE_MAX_BYTES),
    ]);
    const now = yield* Clock.currentTimeMillis;
    const trustFloor = yield* readReleaseTrustFloorEffect(installRoot, sequence);
    // The manifest has to name this very binary's version: the installer
    // fetches `latest` three times, and a release published between those
    // requests would otherwise pair this binary with another release's
    // manifest. Refused here, and the installer is simply run again.
    const candidate = yield* verifyReleaseCandidateEffect({
      consumerSequence: sequence,
      consumerVersion: version,
      expectedVersion: version,
      manifestBytes,
      now,
      platform,
      publicKeyBase64url: merkurReleasePublicKey(),
      signatureBytes,
      trustFloor,
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          manifestBytes.fill(0);
          signatureBytes.fill(0);
        }),
      ),
    );

    const versionDirectory = path.join(installRoot, 'versions', version);
    const currentTarget = yield* readCurrentTargetEffect(installRoot);
    if (currentTarget !== null && path.resolve(installRoot, currentTarget) === versionDirectory) {
      yield* persistReleaseTrustFloorEffect(installRoot, {
        manifestSha512: candidate.manifestSha512,
        sequence: candidate.manifest.sequence,
      });
      logger.info('daemon_setup_already_installed', { version });
    } else {
      // A directory for this version that `current` does not point at is the
      // remains of an earlier attempt, not an install to preserve.
      yield* Effect.tryPromise({
        try: () => rm(versionDirectory, { recursive: true, force: true }),
        catch: normalizeUnknownError,
      });
      yield* installVerifiedReleaseEffect({
        logger,
        installRoot,
        candidate,
        artifactUrl: pathToFileURL(path.resolve(parsed.artifactPath)).href,
        previousVersion: currentTarget === null ? null : path.basename(currentTarget),
      });
      logger.info('daemon_setup_installed', { version, path: versionDirectory });
    }

    const binDirectory = path.join(installRoot, 'bin');
    yield* linkCommandIntoBinEffect(binDirectory);
    const home = path.dirname(installRoot);
    const updated = yield* ensurePathBlockEffect(home, binDirectory, yield* readLoginShellEffect());
    logger.info('daemon_setup_path', {
      bin: path.join(binDirectory, 'merkur'),
      startupFile: updated.file,
      changed: updated.changed,
    });
    logger.info('daemon_setup_release_key', {
      fingerprint: releasePublicKeyFingerprint(merkurReleasePublicKey()),
    });

    if (parsed.linkArguments === null) {
      logger.info('daemon_setup_next', {
        hint: 'Copy the link command from Merkur in your browser and run it to link this machine.',
      });
      return 0;
    }

    const linked = yield* runLinkCommandEffect([...parsed.linkArguments], logger);
    if (linked !== 0) return linked;
    // Installed only now: until a config exists the daemon has nothing to run
    // with, and a supervised unit would restart it in a loop.
    return yield* installDaemonServiceForExecutableEffect(
      logger,
      resolveVersionedDaemonExecutables(versionDirectory).daemon,
    );
  });
}

function readBoundedFileEffect(
  file: string,
  maximumBytes: number,
): Effect.Effect<Uint8Array, Error> {
  return Effect.tryPromise({
    try: async () => {
      const bytes = await Bun.file(file).bytes();
      if (bytes.byteLength > maximumBytes) {
        bytes.fill(0);
        throw new Error(`${file} exceeds ${maximumBytes} bytes`);
      }
      return bytes;
    },
    catch: normalizeUnknownError,
  });
}

function readCurrentTargetEffect(installRoot: string): Effect.Effect<string | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      try {
        return await readlink(path.join(installRoot, 'current'));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    catch: normalizeUnknownError,
  });
}

/**
 * `bin/merkur -> ../current/merkur`, relative so it follows every update
 * without being rewritten, and swapped in with one rename.
 */
function linkCommandIntoBinEffect(binDirectory: string): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(binDirectory, { recursive: true, mode: 0o755 });
      const link = path.join(binDirectory, 'merkur');
      const staging = path.join(binDirectory, '.merkur.new');
      await rm(staging, { force: true });
      await symlink(path.join('..', 'current', 'merkur'), staging);
      await rename(staging, link);
    },
    catch: normalizeUnknownError,
  });
}

/**
 * The startup file the account's login shell reads, and the line that puts
 * `binDirectory` first on its `PATH`.
 *
 * Only the user's own shell is touched. fish gets a file of its own under
 * `conf.d`, which is what that directory is for; the POSIX shells get one
 * marked block appended to the file an interactive shell of theirs reads.
 */
export function pathBlockFor(
  home: string,
  binDirectory: string,
  shell: string,
  platform: NodeJS.Platform,
): { readonly file: string; readonly block: string; readonly ownsFile: boolean } {
  const name = path.basename(shell);
  if (name === 'fish') {
    return {
      file: path.join(home, '.config', 'fish', 'conf.d', 'merkur.fish'),
      block: `${PATH_BLOCK_MARKER}\nfish_add_path --path --move ${quotePosix(binDirectory)}\n`,
      ownsFile: true,
    };
  }
  const exportLine = `export PATH=${quotePosix(binDirectory)}:"$PATH"`;
  const block = `\n${PATH_BLOCK_MARKER}\n${exportLine}\n`;
  if (name === 'zsh') return { file: path.join(home, '.zshrc'), block, ownsFile: false };
  if (name === 'bash') {
    // macOS Terminal opens login shells, which read .bash_profile, not .bashrc.
    const file = platform === 'darwin' ? '.bash_profile' : '.bashrc';
    return { file: path.join(home, file), block, ownsFile: false };
  }
  return { file: path.join(home, '.profile'), block, ownsFile: false };
}

function ensurePathBlockEffect(
  home: string,
  binDirectory: string,
  shell: string,
): Effect.Effect<{ readonly file: string; readonly changed: boolean }, Error> {
  return Effect.tryPromise({
    try: async () => {
      const target = pathBlockFor(home, binDirectory, shell, process.platform);
      let existing = '';
      try {
        existing = await readFile(target.file, 'utf8');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (existing.includes(PATH_BLOCK_MARKER)) return { file: target.file, changed: false };
      await mkdir(path.dirname(target.file), { recursive: true });
      await writeFile(target.file, target.ownsFile ? target.block : `${existing}${target.block}`, {
        encoding: 'utf8',
      });
      return { file: target.file, changed: true };
    },
    catch: normalizeUnknownError,
  });
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
