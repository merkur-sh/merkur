import { describe, expect, test } from 'bun:test';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import { acquireReleaseOwnershipEffect, activateReleaseEffect } from '../services/daemon-release';

import { PATH_BLOCK_MARKER, parseSetupArguments, pathBlockFor } from './setup';

describe('merkur setup arguments', () => {
  test('takes the three fetched files and nothing else when not linking', () => {
    expect(parseSetupArguments(['a.tar.gz', 'm.json', 'm.sig'])).toEqual({
      artifactPath: 'a.tar.gz',
      manifestPath: 'm.json',
      signaturePath: 'm.sig',
      linkArguments: null,
    });
  });

  test('passes everything after --link to merkur link, origin first', () => {
    expect(
      parseSetupArguments([
        'a.tar.gz',
        'm.json',
        'm.sig',
        '--link',
        'https://merkur.test',
        '--identity-backend',
        'software',
      ])?.linkArguments,
    ).toEqual(['https://merkur.test', '--identity-backend', 'software']);
  });

  test('refuses missing files, a bare --link, and unknown trailing arguments', () => {
    expect(parseSetupArguments(['a.tar.gz', 'm.json'])).toBeNull();
    expect(parseSetupArguments(['a.tar.gz', 'm.json', 'm.sig', '--link'])).toBeNull();
    expect(parseSetupArguments(['a.tar.gz', 'm.json', 'm.sig', '--force'])).toBeNull();
  });
});

describe('PATH startup block', () => {
  const home = '/home/ada';
  const bin = '/home/ada/.merkur/bin';

  test('appends one marked export to the file an interactive zsh reads', () => {
    const block = pathBlockFor(home, bin, '/bin/zsh', 'linux');
    expect(block.file).toBe('/home/ada/.zshrc');
    expect(block.ownsFile).toBe(false);
    expect(block.block).toBe(
      `\n${PATH_BLOCK_MARKER}\nexport PATH='/home/ada/.merkur/bin':"$PATH"\n`,
    );
  });

  test('uses .bash_profile on macOS, where Terminal starts login shells', () => {
    expect(pathBlockFor(home, bin, '/bin/bash', 'darwin').file).toBe('/home/ada/.bash_profile');
    expect(pathBlockFor(home, bin, '/usr/bin/bash', 'linux').file).toBe('/home/ada/.bashrc');
  });

  test('gives fish a conf.d file of its own', () => {
    const block = pathBlockFor(home, bin, '/opt/homebrew/bin/fish', 'darwin');
    expect(block.file).toBe('/home/ada/.config/fish/conf.d/merkur.fish');
    expect(block.ownsFile).toBe(true);
    expect(block.block).toContain("fish_add_path --path --move '/home/ada/.merkur/bin'");
  });

  test('falls to .profile for any other shell', () => {
    expect(pathBlockFor(home, bin, '/bin/dash', 'linux').file).toBe('/home/ada/.profile');
    expect(pathBlockFor(home, bin, '', 'linux').file).toBe('/home/ada/.profile');
  });

  test('quotes a home directory the shell would otherwise split', () => {
    const block = pathBlockFor("/home/o'neil", "/home/o'neil/.merkur/bin", '/bin/zsh', 'linux');
    expect(block.block).toContain(`export PATH='/home/o'\\''neil/.merkur/bin':"$PATH"`);
  });
});

test('setup of B and C preserves the helper of a release A that still has an owner', async () => {
  const installRoot = await mkdtemp(path.join(os.tmpdir(), 'merkur-live-release-'));
  const logger = { info() {}, warn() {}, error() {} };
  const versions = path.join(installRoot, 'versions');
  const a = path.join(versions, 'v1.0.0');
  const b = path.join(versions, 'v1.1.0');
  const c = path.join(versions, 'v1.2.0');
  const scope = await Effect.runPromise(Scope.make());
  try {
    for (const directory of [a, b]) {
      await mkdir(directory, { recursive: true });
      for (const name of ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui']) {
        const executable = path.join(directory, name);
        await writeFile(executable, '#!/bin/sh\nexit 0\n');
        await chmod(executable, 0o700);
      }
      await writeFile(
        path.join(directory, 'release-trust.json'),
        `${JSON.stringify({ manifestSha512: 'ab'.repeat(64), sequence: 3 })}\n`,
      );
    }
    await symlink(a, path.join(installRoot, 'current'));
    await Effect.runPromise(
      acquireReleaseOwnershipEffect(installRoot, path.join(a, 'merkur')).pipe(Scope.provide(scope)),
    );
    try {
      await Effect.runPromise(activateReleaseEffect({ logger, installRoot, versionDirectory: b }));
      // C becomes staged only after B's setup has pruned unowned directories.
      await mkdir(c, { recursive: true });
      for (const name of ['merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui']) {
        const executable = path.join(c, name);
        await writeFile(executable, '#!/bin/sh\nexit 0\n');
        await chmod(executable, 0o700);
      }
      await writeFile(
        path.join(c, 'release-trust.json'),
        `${JSON.stringify({ manifestSha512: 'ab'.repeat(64), sequence: 3 })}\n`,
      );
      await Effect.runPromise(activateReleaseEffect({ logger, installRoot, versionDirectory: c }));
      await expect(
        access(path.join(a, 'merkur-image-worker'), constants.X_OK).then(() => true),
      ).resolves.toBe(true);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    await Effect.runPromise(activateReleaseEffect({ logger, installRoot, versionDirectory: c }));
    expect(await Bun.file(path.join(a, 'merkur-image-worker')).exists()).toBe(false);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(installRoot, { recursive: true, force: true });
  }
});
