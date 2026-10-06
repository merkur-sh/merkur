import { describe, expect, test } from 'bun:test';

import { createCliLogger, renderCliLine } from './cli-output';

function capture(): { out: string[]; err: string[]; logger: ReturnType<typeof createCliLogger> } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    logger: createCliLogger(
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      { stdout: false, stderr: false },
    ),
  };
}

describe('CLI output', () => {
  test('prints the approval address on a line of its own', () => {
    const { out, logger } = capture();
    logger.info('daemon_link_code', {
      code: 'claim.secret',
      url: 'https://merkur.test/link#claim.secret',
      expiresAt: 1,
    });
    expect(out.join('')).toContain('\n  https://merkur.test/link#claim.secret\n');
    // The code alone never appears apart from the address it belongs to.
    expect(out.join('')).not.toContain('"code"');
  });

  test('prefixes failures on stderr so a reader and a box host can both tell them apart', () => {
    const { out, err, logger } = capture();
    logger.error('daemon_link_invalid_token');
    logger.warn('daemon_install_linger_failed', {
      user: 'ada',
      error: 'Access denied',
      hint: 'sudo loginctl enable-linger ada',
    });
    expect(out).toEqual([]);
    expect(err[0]).toStartWith('error: MERKUR_LINK_TOKEN is missing');
    expect(err[1]).toBe(
      'warning: could not enable lingering (Access denied). Run `sudo loginctl enable-linger ada` so Merkur keeps running after you log out.\n',
    );
  });

  test('stays quiet about expected steps and still words an unmapped event', () => {
    expect(renderCliLine('daemon_install_launchctl_ignored', { args: 'bootout' })).toBeNull();
    expect(renderCliLine('daemon_stop_killed', { pid: 42 })).toBe('stop killed: pid=42');
  });

  test('a stopped service gives the reader a concrete next step', () => {
    const { out, logger } = capture();
    logger.info('daemon_stop_launchctl_ignored', { args: 'bootout' });
    logger.info('daemon_stop_success', { lockPid: 42 });
    expect(out).toEqual(['Merkur stopped. Run `merkur start` to start it again.\n']);
  });

  test('untrusted error text cannot inject terminal control sequences', () => {
    const { err, logger } = capture();
    logger.error('daemon_command_failed', { error: 'bad\x1b[2J\x07\u009bcommand' });
    expect(err).toEqual(['error: bad[2Jcommand\n']);
  });

  test('styling is per stream and plain diagnostics keep their labels', () => {
    const out: string[] = [];
    const err: string[] = [];
    const logger = createCliLogger(
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      { stdout: true, stderr: false },
    );
    logger.info('daemon_stop_success');
    logger.error('daemon_command_failed', { error: 'Run `merkur help`.' });
    expect(out[0]).toContain('\x1b[1;36mmerkur start\x1b[0m');
    expect(err).toEqual(['error: Run `merkur help`.\n']);
  });
});
