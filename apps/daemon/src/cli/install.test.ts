import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildDaemonServiceProgramArguments,
  buildLaunchdPlist,
  buildSystemdUnit,
  resolveProgramArguments,
} from './install';

describe('buildSystemdUnit', () => {
  test('renders a user unit with the joined ExecStart command', () => {
    const unit = buildSystemdUnit(['/home/user/.merkur/current/merkur']);

    expect(unit).toBe(`[Unit]
Description=Merkur daemon
After=network-online.target

[Service]
ExecStart=/home/user/.merkur/current/merkur
Restart=always
RestartSec=2
KillMode=mixed
TimeoutStopSec=infinity

[Install]
WantedBy=default.target
`);
  });

  test('quotes arguments containing spaces or shell-special characters', () => {
    const unit = buildSystemdUnit([
      '/usr/bin/bun',
      'run',
      '--cwd',
      '/home/u/my repo/apps/daemon',
      'src/index.ts',
    ]);

    expect(unit).toContain(
      'ExecStart=/usr/bin/bun run --cwd "/home/u/my repo/apps/daemon" src/index.ts',
    );
  });
});

describe('CLI and daemon service dispatch', () => {
  test('launchd lets the daemon finish its owned child cleanup', () => {
    const plist = buildLaunchdPlist(['/home/user/merkur', 'daemon']);
    expect(plist).toContain('<key>ExitTimeOut</key>\n  <integer>0</integer>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
  });
  test('source CLI arguments leave the subcommand to their caller', () => {
    const program = resolveProgramArguments();
    expect(program.at(-1)).toBe('src/index.ts');
    const unit = buildSystemdUnit([...program, 'daemon']);
    expect(unit).toContain('src/index.ts daemon\n');
  });

  test('installed service arguments select the daemon explicitly', () => {
    const executable = '/home/u/my repo/current/merkur';
    expect(buildDaemonServiceProgramArguments(executable)).toEqual([executable, 'daemon']);
    expect(buildSystemdUnit(buildDaemonServiceProgramArguments(executable))).toContain(
      'ExecStart="/home/u/my repo/current/merkur" daemon\n',
    );
  });
});

test('encodes literal systemd specifiers in every executable argument', () => {
  const unit = buildSystemdUnit(['/srv/tenant%u/.merkur/current/merkur', '--label=%h', 'a%"b\\c']);
  expect(unit).toContain(
    'ExecStart="/srv/tenant%%u/.merkur/current/merkur" "--label=%%h" "a%%\\"b\\\\c"',
  );
});

test.skipIf(process.platform !== 'linux')(
  'systemd resolves a percent-bearing executable literally',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merkur-systemd-'));
    try {
      const directory = path.join(root, 'tenant%u');
      await mkdir(directory);
      const executable = path.join(directory, 'merkur');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const unitPath = path.join(root, 'merkur-test.service');
      await writeFile(unitPath, buildSystemdUnit([executable, 'daemon']));
      // Verify against the existing executable without starting a service or contacting a manager.
      const verify = Bun.spawn(['systemd-analyze', '--user', 'verify', unitPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const diagnostics = new Response(verify.stderr).text();
      expect(await verify.exited, await diagnostics).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
