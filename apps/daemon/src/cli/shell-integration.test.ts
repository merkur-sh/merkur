import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { linkTestExecutable } from '../../../../scripts/test-executables';
import { renderShellIntegrationSnippet } from './shell-integration';

const SHELL_TOOLS = ['fish', 'tmux', 'python', 'bash', 'zsh', 'sh', 'env', 'cat', 'touch'] as const;
type ShellTool = (typeof SHELL_TOOLS)[number];

// The original signed Fish engine clears incoming DYLD variables at launch.
// Its init command restores only this fixture's declared SDK loader path.
const FISH_ARGS = [
  '--no-config',
  '--init-command',
  'if set -q MERKUR_SHELL_TEST_DYLD_LIBRARY_PATH; set -gx DYLD_FALLBACK_LIBRARY_PATH "$MERKUR_SHELL_TEST_DYLD_LIBRARY_PATH"; end',
] as const;

/**
 * A declaring runner names every tool in `MERKUR_SHELL_TEST_*` and puts nothing else on PATH.
 * A source run declares none: the tools are the host's, found through its PATH.
 */
const DECLARED_TOOLS = SHELL_TOOLS.some(
  (name) => process.env[`MERKUR_SHELL_TEST_${name.toUpperCase()}`] !== undefined,
);
const HOST_PATH = process.env.PATH ?? '/usr/bin:/bin';

function shellTool(name: ShellTool): string | null {
  return DECLARED_TOOLS
    ? (process.env[`MERKUR_SHELL_TEST_${name.toUpperCase()}`] ?? null)
    : Bun.which(name === 'python' ? 'python3' : name);
}

/** A host without the tool has nothing to run; a declaring runner must supply all of them. */
function hostLacks(...names: ShellTool[]): boolean {
  return !DECLARED_TOOLS && names.some((name) => shellTool(name) === null);
}

function requiredShellTool(name: ShellTool): string {
  const value = shellTool(name);
  if (
    value === null ||
    !isAbsolute(value) ||
    !statSync(value).isFile() ||
    (statSync(value).mode & 0o111) === 0
  ) {
    throw new Error(`Missing executable declared shell test utility: ${name}`);
  }
  return value;
}

function shellEnvironment(bin: string, home: string): Record<string, string> {
  if (!DECLARED_TOOLS) {
    // The host's tools find their own terminfo, functions and libraries.
    const environment: Record<string, string> = {
      PATH: `${bin}:${HOST_PATH}`,
      HOME: home,
      TMPDIR: home,
      MERKUR_SHELL_TEST_HOST_PATH: HOST_PATH,
    };
    for (const name of SHELL_TOOLS) {
      const tool = shellTool(name);
      if (tool !== null) environment[`MERKUR_SHELL_TEST_${name.toUpperCase()}`] = tool;
    }
    return environment;
  }
  for (const name of SHELL_TOOLS) {
    if (name !== 'tmux')
      symlinkSync(requiredShellTool(name), join(bin, name === 'python' ? 'python3' : name));
  }
  const environment: Record<string, string> = {
    PATH: bin,
    HOME: home,
    TMPDIR: home,
    SHELL: requiredShellTool('bash'),
    MERKUR_TMUX_SHELL: requiredShellTool('sh'),
    TERMINFO: join(dirname(dirname(realpathSync(requiredShellTool('bash')))), 'share/terminfo'),
    TERMINFO_DIRS: join(
      dirname(dirname(realpathSync(requiredShellTool('bash')))),
      'share/terminfo',
    ),
    FPATH: join(
      dirname(dirname(realpathSync(requiredShellTool('zsh')))),
      'share/zsh/5.9/functions',
    ),
  };
  for (const name of SHELL_TOOLS)
    environment[`MERKUR_SHELL_TEST_${name.toUpperCase()}`] = requiredShellTool(name);
  const library = join(dirname(dirname(realpathSync(requiredShellTool('bash')))), 'lib');
  if (process.platform === 'darwin') {
    environment.DYLD_FALLBACK_LIBRARY_PATH = library;
    environment.MERKUR_SHELL_TEST_DYLD_LIBRARY_PATH = library;
  } else {
    environment.LD_LIBRARY_PATH = library;
  }
  return environment;
}

/** Await pipe drainage and the actual exit status on the event loop. */
async function run({ cmd, env }: { cmd: string[]; env: Record<string, string> }) {
  const child = Bun.spawn({ cmd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('fish merkur launcher', () => {
  test.skipIf(hostLacks('fish'))(
    'only interactive commands inside tmux use the popup, preserving failure status',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'merkur-fish-launcher-'));
      try {
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        const environment = shellEnvironment(bin, dir);
        for (const [name, status] of [
          ['tmux', 37],
          ['merkur', 23],
        ] as const) {
          linkTestExecutable(
            bin,
            name,
            `#!${requiredShellTool('sh')}\nprintf '${name}\\n'\nexit ${status}\n`,
          );
        }
        const snippet = join(dir, 'snippet.fish');
        // Launching the local client does not require a daemon prompt token.
        writeFileSync(snippet, renderShellIntegrationSnippet('fish', join(dir, 'absent-token')));
        for (const command of [
          '',
          'login',
          'connect',
          '--machine example',
          '--state-dir example',
        ]) {
          for (const inside of [true, false]) {
            const result = await run({
              cmd: [
                requiredShellTool('fish'),
                ...FISH_ARGS,
                '-c',
                `source "${snippet}"; merkur ${command}`,
              ],
              env: {
                ...environment,
                TMUX: inside ? 'fixture' : '',
                TMUX_PANE: '%0',
              },
            });
            expect(result.stderr.toString()).toBe('');
            expect(result.stdout.toString()).toBe(inside ? 'tmux\n' : 'merkur\n');
            expect(result.exitCode).toBe(inside ? 37 : 23);
          }
        }
        for (const command of [
          '--help',
          '-h',
          'connect example --help',
          '--version',
          'help',
          'version',
          'logout',
          'machines',
          'update',
          'shell-integration',
        ]) {
          const result = await run({
            cmd: [
              requiredShellTool('fish'),
              ...FISH_ARGS,
              '-c',
              `source "${snippet}"; merkur ${command}`,
            ],
            env: { ...environment, TMUX: 'fixture', TMUX_PANE: '%0' },
          });
          expect(result.stderr.toString()).toBe('');
          expect(result.stdout.toString()).toBe('merkur\n');
          expect(result.exitCode).toBe(23);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(hostLacks('fish', 'tmux', 'python'))(
    'outer prefix and root bindings reach the popup and return after exit, in a controlling PTY',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'merkur-fish-popup-snippet-'));
      try {
        const snippet = join(dir, 'snippet.fish');
        writeFileSync(snippet, renderShellIntegrationSnippet('fish', join(dir, 'absent-token')));
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        const result = await run({
          env: shellEnvironment(bin, dir),
          cmd: [
            requiredShellTool('python'),
            '-I',
            '-B',
            new URL('./shell-integration-tmux.fixture.py', import.meta.url).pathname,
            snippet,
          ],
        });
        expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
          exitCode: 0,
          stderr: '',
        });
        expect(result.stdout.toString().trim()).toBe(
          'popup input, host fence, arguments and restoration passed',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

/**
 * The passthrough block each shell must carry, verbatim.
 *
 * Asserted whole rather than by fragments because this is shell source: the
 * guard around the call is the part that matters, and a substring match on the
 * command proves nothing about what it is nested inside.
 */
const PASSTHROUGH_BLOCK = {
  bash: `  if [ -n "\${TMUX:-}" ] && [ "\${MERKUR_TMUX_PASSTHROUGH:-}" != "$TMUX xterm-256color:hyperlinks:extkeys:sync" ]; then
    tmux set -g allow-passthrough on >/dev/null 2>&1
    tmux set -s extended-keys on >/dev/null 2>&1
    case "$(tmux show -sv terminal-features 2>/dev/null)" in
      *xterm-256color:hyperlinks:extkeys:sync*) ;;
      *) tmux set -as terminal-features ',xterm-256color:hyperlinks:extkeys:sync' >/dev/null 2>&1 ;;
    esac
    export MERKUR_TMUX_PASSTHROUGH="$TMUX xterm-256color:hyperlinks:extkeys:sync"
  fi
`,
  zsh: `  if [[ -n "\${TMUX:-}" && "\${MERKUR_TMUX_PASSTHROUGH:-}" != "$TMUX xterm-256color:hyperlinks:extkeys:sync" ]]; then
    tmux set -g allow-passthrough on >/dev/null 2>&1
    tmux set -s extended-keys on >/dev/null 2>&1
    case "$(tmux show -sv terminal-features 2>/dev/null)" in
      *xterm-256color:hyperlinks:extkeys:sync*) ;;
      *) tmux set -as terminal-features ',xterm-256color:hyperlinks:extkeys:sync' >/dev/null 2>&1 ;;
    esac
    export MERKUR_TMUX_PASSTHROUGH="$TMUX xterm-256color:hyperlinks:extkeys:sync"
  fi
`,
  fish: `    if test -n "$TMUX" -a "$MERKUR_TMUX_PASSTHROUGH" != "$TMUX xterm-256color:hyperlinks:extkeys:sync"
        tmux set -g allow-passthrough on >/dev/null 2>&1
        tmux set -s extended-keys on >/dev/null 2>&1
        if not string match -q '*xterm-256color:hyperlinks:extkeys:sync*' -- (tmux show -sv terminal-features 2>/dev/null)
            tmux set -as terminal-features ',xterm-256color:hyperlinks:extkeys:sync' >/dev/null 2>&1
        end
        set -gx MERKUR_TMUX_PASSTHROUGH "$TMUX xterm-256color:hyperlinks:extkeys:sync"
    end
`,
} as const;

const SHELLS = ['bash', 'zsh', 'fish'] as const;
type Shell = (typeof SHELLS)[number];

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('renderShellIntegrationSnippet', () => {
  for (const shell of SHELLS) {
    test(`${shell} secures tmux passthrough, hyperlinks, extended keys and synchronized output, once per tmux server`, async () => {
      const snippet = renderShellIntegrationSnippet(shell, '/home/dev/.merkur/shell-token');

      // allow-passthrough belongs to the RUNNING tmux server, and a server
      // started with `-f` from another file — which is how the box's tmux
      // starts — never reads the user's ~/.tmux.conf. Every box session
      // therefore measured 0% prediction while the snippet only asked for it.
      expect(snippet).toContain(PASSTHROUGH_BLOCK[shell]);
      // Exactly once, and at rc level rather than inside a prompt hook: more
      // than one occurrence would mean it had leaked into the per-prompt path.
      expect(occurrences(snippet, 'tmux set -g allow-passthrough on')).toBe(1);
      expect(
        occurrences(
          snippet,
          "tmux set -as terminal-features ',xterm-256color:hyperlinks:extkeys:sync'",
        ),
      ).toBe(1);
      expect(occurrences(snippet, 'tmux set -s extended-keys on')).toBe(1);
      // The guard variable is exported and carries `$TMUX` and the entry
      // rather than a boolean, so shells of a server already handled cost
      // nothing while a second server started from inside the first, or a
      // server handled under another entry, is still converged.
      expect(occurrences(snippet, 'MERKUR_TMUX_PASSTHROUGH')).toBe(2);

      // The DCS wrapper this exists to make work is untouched.
      expect(snippet).toContain('\\033Ptmux;\\033\\033]133;%s\\a');

      // And the note stops telling the user to add the line by hand.
      expect(snippet).toContain('No ~/.tmux.conf line is needed.');
    });
  }

  test('the token is read from the given path and never embedded', () => {
    // An rc file is long-lived and often version-controlled, so a snippet
    // carrying the value would keep serving a token the daemon had replaced.
    const snippet = renderShellIntegrationSnippet('bash', '/home/dev/.merkur/shell-token');

    expect(snippet).toContain('/home/dev/.merkur/shell-token');
    expect(snippet).toContain('MERKUR_SHELL_TOKEN');
  });
});

/**
 * How each shell is run non-interactively with none of the user's own rc files.
 *
 * The snippet is sourced explicitly by the driver script, so a shell that also
 * read the real `~/.bashrc` would be measuring the developer's machine.
 */
const INTERPRETER_ARGS: Record<Shell, readonly string[]> = {
  bash: ['--noprofile', '--norc'],
  zsh: ['-f'],
  fish: FISH_ARGS,
};

/** Source `snippet` in a child interpreter that sees `$TMUX` as `tmux`. */
function sourceInChild(shell: Shell, snippet: string, tmux: string): string {
  const interpreter = [
    JSON.stringify(requiredShellTool(shell)),
    ...INTERPRETER_ARGS[shell].map((argument) => `'${argument.replaceAll("'", "'\\''")}'`),
  ].join(' ');
  return `${JSON.stringify(requiredShellTool('env'))} TMUX=${tmux} ${interpreter} -c 'source "${snippet}"'`;
}

/**
 * Run one shell against a fake `tmux`, and return what that tmux was asked for.
 *
 * The fake logs the `$TMUX` it was invoked under alongside its arguments, which
 * is the whole question here: the option belongs to the server named by that
 * value, so "was it set" is only answerable per server.
 */
async function tmuxCalls(
  shell: Shell,
  driver: (snippet: string) => readonly string[],
  initialFeatures = '',
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'merkur-shell-integration-'));
  const tokenPath = join(dir, 'shell-token');
  writeFileSync(tokenPath, 'f'.repeat(32));

  const snippet = join(dir, `snippet.${shell}`);
  writeFileSync(snippet, renderShellIntegrationSnippet(shell, tokenPath));

  const log = join(dir, 'tmux.log');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const environment = shellEnvironment(bin, dir);
  // It answers `show` from the features file, which starts empty and is
  // appended to by `set -as`, so the second shell of a server sees the entry
  // the first one added, as the real server would show it.
  const features = join(dir, 'terminal-features');
  linkTestExecutable(
    bin,
    'tmux',
    `#!${requiredShellTool('sh')}
printf '%s|%s\\n' "$TMUX" "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  show) cat "$FAKE_TMUX_FEATURES" ;;
  set) [ "$2" = -as ] && printf '%s\\n' "$4" >> "$FAKE_TMUX_FEATURES" ;;
esac
exit 0
`,
  );
  writeFileSync(log, '');
  writeFileSync(features, initialFeatures);

  const script = join(dir, 'driver');
  writeFileSync(script, `${driver(snippet).join('\n')}\n`);

  const result = await run({
    cmd: [requiredShellTool(shell), ...INTERPRETER_ARGS[shell], script],
    env: {
      ...environment,
      TMUX: 'first-server',
      TERM: 'xterm-256color',
      FAKE_TMUX_LOG: log,
      FAKE_TMUX_FEATURES: features,
    },
  });
  // A shell that failed to parse the snippet would otherwise read as "made no
  // tmux call", which is the assertion below passing for the wrong reason.
  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  }).toEqual({ exitCode: 0, stderr: '' });

  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('the tmux passthrough guard, as the shell actually runs it', () => {
  for (const shell of SHELLS) {
    test.skipIf(hostLacks(shell))(
      `${shell} sets passthrough once per server, and again for a nested server`,
      async () => {
        const calls = await tmuxCalls(shell, (snippet) => [
          `source "${snippet}"`,
          // Same shell, sourced twice: the guard now names this server and
          // entry, so nothing.
          `source "${snippet}"`,
          // A child of that shell, still inside the same server: it inherits
          // the exported guard, and the server it would set is already set.
          sourceInChild(shell, snippet, 'first-server'),
          // A shell inside a SECOND server started from the first
          // (`tmux -L other new-session`). It inherits the same guard, and
          // `$TMUX` is set, so a boolean flag left this server without the
          // option forever — the bug this keying exists to close.
          sourceInChild(shell, snippet, 'second-server'),
        ]);

        // The fake keeps one feature list for both "servers", so the second
        // finds the entry present; the real servers each start without it and
        // each run the append once.
        expect(calls).toEqual([
          'first-server|set -g allow-passthrough on',
          'first-server|set -s extended-keys on',
          'first-server|show -sv terminal-features',
          'first-server|set -as terminal-features ,xterm-256color:hyperlinks:extkeys:sync',
          'second-server|set -g allow-passthrough on',
          'second-server|set -s extended-keys on',
          'second-server|show -sv terminal-features',
        ]);
      },
    );

    test.skipIf(hostLacks(shell))(
      `${shell} gives a server holding the entry from before sync the longer one`,
      async () => {
        const calls = await tmuxCalls(
          shell,
          (snippet) => [`source "${snippet}"`],
          'xterm*:clipboard:ccolour:cstyle:focus:title\nxterm-256color:hyperlinks:extkeys\n',
        );

        expect(calls).toEqual([
          'first-server|set -g allow-passthrough on',
          'first-server|set -s extended-keys on',
          'first-server|show -sv terminal-features',
          'first-server|set -as terminal-features ,xterm-256color:hyperlinks:extkeys:sync',
        ]);
      },
    );

    test.skipIf(hostLacks(shell))(
      `${shell} runs again in a shell whose guard names the entry from before sync`,
      async () => {
        // A pane shell that sourced the earlier snippet exported the guard as
        // bare `$TMUX`; re-sourcing there, or a shell it starts, must still
        // reach the server, which holds only the shorter entry.
        const calls = await tmuxCalls(
          shell,
          (snippet) => [
            shell === 'fish'
              ? 'set -gx MERKUR_TMUX_PASSTHROUGH first-server'
              : 'export MERKUR_TMUX_PASSTHROUGH=first-server',
            `source "${snippet}"`,
            sourceInChild(shell, snippet, 'first-server'),
          ],
          'xterm*:clipboard:ccolour:cstyle:focus:title\nxterm-256color:hyperlinks:extkeys\n',
        );

        expect(calls).toEqual([
          'first-server|set -g allow-passthrough on',
          'first-server|set -s extended-keys on',
          'first-server|show -sv terminal-features',
          'first-server|set -as terminal-features ,xterm-256color:hyperlinks:extkeys:sync',
        ]);
      },
    );

    test.skipIf(hostLacks(shell))(
      `${shell} leaves a server that already has Merkur's features unchanged`,
      async () => {
        // A new pane's shell does not inherit the guard, so it runs the block
        // again against a server whose list already holds the entry.
        const calls = await tmuxCalls(
          shell,
          (snippet) => [`source "${snippet}"`],
          'xterm*:clipboard:ccolour:cstyle:focus:title\nxterm-256color:hyperlinks:extkeys:sync\n',
        );

        expect(calls).toEqual([
          'first-server|set -g allow-passthrough on',
          'first-server|set -s extended-keys on',
          'first-server|show -sv terminal-features',
        ]);
      },
    );
  }
});
