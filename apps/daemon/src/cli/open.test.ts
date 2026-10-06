import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { linkTestExecutable } from '../../../../scripts/test-executables';
import { resolveProgramArguments } from './install';
import { encodeOpenUrlSequence, openableUrl, openUrlCommandScripts } from './open';

function fixtureShell(): string {
  const shell = Bun.which('sh');
  if (shell === null) throw new Error('Open helper qualification requires its declared shell');
  return shell;
}

function fixtureEnvironment(searchPath: string): Record<string, string> {
  const environment: Record<string, string> = { PATH: searchPath };
  for (const name of [
    'TEST_SRCDIR',
    'RUNFILES_DIR',
    'TEST_TMPDIR',
    'MERKUR_BAZEL_RUNFILES_ROOT',
    'MERKUR_BAZEL_SCRATCH_ROOT',
    'DYLD_LIBRARY_PATH',
    'DYLD_FALLBACK_LIBRARY_PATH',
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/** An opener stand-in that records which one ran, and for what, in `$STAND_IN_LOG`. */
const STAND_IN = (label: string) => `#!${fixtureShell()}\necho "${label} $1" >> "$STAND_IN_LOG"\n`;

/** A child's exit status, awaited on the event loop: a synchronous spawn can lose it (oven-sh/bun#34069). */
function exitStatus(
  file: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
) {
  return Bun.spawn([file, ...args], { env, stdout: 'ignore', stderr: 'ignore' }).exited;
}

describe('merkur open', () => {
  test('writes the sequence the daemon verifies, BEL-terminated', () => {
    expect(encodeOpenUrlSequence('0123abcd', 'https://a.example/x;y', false)).toBe(
      '\x1b]7780;merkur=0123abcd;https://a.example/x;y\x07',
    );
  });

  test('inside tmux the sequence is DCS-wrapped with every ESC doubled', () => {
    expect(encodeOpenUrlSequence('0123abcd', 'https://a.example/', true)).toBe(
      '\x1bPtmux;\x1b\x1b]7780;merkur=0123abcd;https://a.example/\x07\x1b\\',
    );
  });

  test('only http and https URLs are accepted', () => {
    expect(openableUrl('https://github.com/login/device')).toBe('https://github.com/login/device');
    expect(openableUrl('HTTP://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    for (const refused of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c', 'nope']) {
      expect(openableUrl(refused)).toBeNull();
    }
  });
});

describe('open-url helper scripts', () => {
  test('the generated source helper dispatches open instead of the daemon subcommand', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'merkur-open-dispatch-'));
    try {
      const helper = path.join(root, 'merkur-open');
      const script = openUrlCommandScripts(resolveProgramArguments(), root, process.platform).get(
        'merkur-open',
      );
      if (script === undefined) throw new Error('open helper missing');
      writeFileSync(helper, script, { mode: 0o700 });
      const result = await new Promise<{ stderr: string; status: number | null }>(
        (resolve, reject) => {
          const child = spawn(fixtureShell(), [helper, 'https://links.e2e.invalid/browser'], {
            detached: true,
            env: { ...process.env, MERKUR_SHELL_TOKEN: 'test-shell-token', TMUX: '' },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
          });
          child.on('error', reject);
          child.on('close', (status) => resolve({ stderr, status }));
        },
      );
      expect(result.stderr).not.toContain('merkur daemon takes no arguments');
      expect(result.stderr).toContain('merkur open: needs the terminal it was started from');
      expect(result.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the macOS open stand-in forwards only a lone web URL', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'merkur-open-mac-'));
    const binDir = path.join(root, 'terminal-bin');
    const log = path.join(root, 'log');
    mkdirSync(binDir, { recursive: true });
    const echo = Bun.which('echo');
    if (echo === null) throw new Error('Open helper qualification requires its declared echo');
    const scripts = openUrlCommandScripts([echo], binDir, 'darwin');
    expect([...scripts.keys()]).toEqual(['merkur-open', 'open']);
    const open = scripts.get('open') ?? '';
    writeFileSync(path.join(binDir, 'open'), open);
    chmodSync(path.join(binDir, 'open'), 0o700);
    linkTestExecutable(binDir, 'merkur-open', STAND_IN('merkur'));

    const status = await exitStatus(
      fixtureShell(),
      [path.join(binDir, 'open'), 'HTTPS://example.com/a'],
      {
        ...fixtureEnvironment(`${binDir}:${process.env.PATH ?? ''}`),
        STAND_IN_LOG: log,
      },
    );
    expect(status).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('merkur HTTPS://example.com/a\n');
    // Files, folders, apps and flagged URLs never reach the helper; running the
    // real opener here would open them, so the hand-off is asserted as written.
    expect(open).toContain('if [ "$#" -eq 1 ]; then');
    expect(open.trimEnd().endsWith('exec /usr/bin/open "$@"')).toBe(true);
  });

  test('a compiled CLI helper preserves executable and URL quoting when executed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), "merkur-open-compiled it's-"));
    try {
      const helper = path.join(root, 'merkur-open');
      const log = path.join(root, 'arguments');
      const executable = linkTestExecutable(
        root,
        'merkur cli',
        `#!${fixtureShell()}\nprintf "%s\\n" "$@" > "$ARGUMENT_LOG"\n`,
      );
      const script = openUrlCommandScripts([executable], root, process.platform).get('merkur-open');
      if (script === undefined) throw new Error('open helper missing');
      writeFileSync(helper, script, { mode: 0o700 });
      const url = "https://links.e2e.invalid/a?value=it's here&next=1";
      expect(
        await exitStatus(fixtureShell(), [helper, url], { ...process.env, ARGUMENT_LOG: log }),
      ).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe(`open\n${url}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('merkur-open execs the CLI with the URL, shell-quoted', () => {
    const scripts = openUrlCommandScripts(
      ["/opt/it's/merkur"],
      '/home/u/.merkur/terminal-bin',
      'darwin',
    );
    expect(scripts.get('merkur-open')).toContain(`exec '/opt/it'\\''s/merkur' open "$@"`);
  });

  test('the Linux xdg-open stand-in sends web URLs to the helper and the rest to the system', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'merkur-open-'));
    const binDir = path.join(root, 'terminal-bin');
    const systemDir = path.join(root, 'system');
    const log = path.join(root, 'log');
    for (const dir of [binDir, systemDir]) mkdirSync(dir, { recursive: true });
    const echo = Bun.which('echo');
    if (echo === null) throw new Error('Open helper qualification requires its declared echo');
    const scripts = openUrlCommandScripts([echo], binDir, 'linux');
    for (const [name, body] of scripts) {
      // The helper is replaced by a stand-in below; only the opener runs as generated.
      if (name === 'merkur-open') continue;
      writeFileSync(path.join(binDir, name), body);
      chmodSync(path.join(binDir, name), 0o700);
    }
    // Stand-ins that record which opener ran.
    linkTestExecutable(binDir, 'merkur-open', STAND_IN('merkur'));
    linkTestExecutable(systemDir, 'xdg-open', STAND_IN('system'));

    const env = { ...fixtureEnvironment(`${binDir}:${systemDir}`), STAND_IN_LOG: log };
    for (const target of ['HTTPS://example.com/a', 'notes.txt', 'mailto:a@b.c']) {
      expect(await exitStatus(fixtureShell(), [path.join(binDir, 'xdg-open'), target], env)).toBe(
        0,
      );
    }
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toEqual([
      'merkur HTTPS://example.com/a',
      'system notes.txt',
      'system mailto:a@b.c',
    ]);

    const noSystem = await exitStatus(
      fixtureShell(),
      [path.join(binDir, 'xdg-open'), 'notes.txt'],
      {
        ...fixtureEnvironment(binDir),
        STAND_IN_LOG: log,
      },
    );
    expect(noSystem).toBe(3);
  });
});
