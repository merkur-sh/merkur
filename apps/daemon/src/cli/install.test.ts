import { describe, expect, test } from 'bun:test';

import {
  buildDaemonServiceProgramArguments,
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
