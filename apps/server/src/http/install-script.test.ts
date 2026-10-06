import { describe, expect, test } from 'bun:test';

import { renderInstallScript } from './install-script';

describe('install script', () => {
  const script = renderInstallScript('https://merkur.test');

  test('is a syntactically valid POSIX shell script', async () => {
    const proc = Bun.spawn(['sh', '-n'], { stdin: 'pipe', stderr: 'pipe' });
    proc.stdin.write(script);
    proc.stdin.end();
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('downloads from public GitHub releases and hands verification to merkur setup', () => {
    expect(script).toContain(
      'MERKUR_RELEASE_BASE:-https://github.com/merkur-sh/merkur/releases/latest/download}"',
    );
    expect(script).toContain('for file in "$artifact" merkur-release.json merkur-release.sig; do');
    expect(script).toContain('"$work/unpacked/merkur" setup \\');
    // The script itself verifies nothing: one verifier, the updater's, in the binary.
    expect(script).not.toContain('sha512');
    expect(script).toStartWith('#!/bin/sh\n# Merkur installer for https://merkur.test\n');
  });

  test('links to the serving origin only when the link command supplied a token', () => {
    expect(script).toContain('MERKUR_LINK_TOKEN:-}" ]; then');
    expect(script).toContain('set -- --link \'https://merkur.test\' "$@"');
    expect(renderInstallScript("https://it's.test")).toContain(
      `set -- --link 'https://it'\\''s.test' "$@"`,
    );
  });

  test('names exactly the platforms the release manifest carries', () => {
    expect(script).toContain('artifact="merkur-daemon-$os-$arch.tar.gz"');
    expect(script).toContain('Darwin) os=darwin ;;');
    expect(script).toContain('Linux) os=linux ;;');
    expect(script).toContain('arm64 | aarch64) arch=arm64 ;;');
    expect(script).toContain('x86_64 | amd64) arch=x64 ;;');
  });
});
