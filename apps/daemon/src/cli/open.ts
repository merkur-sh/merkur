import { spawnSync } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { merkurInstallRootPath, shellTokenPath } from '../config';
import { resolveProgramArguments } from './install';

/**
 * `merkur open <url>`: open a URL in the browser that is showing this terminal.
 *
 * Programs that want a browser — `gh auth login`, `gcloud auth login`, Python's
 * `webbrowser` — run on the daemon's machine, where a browser either does not
 * exist (a box) or is not the one the user is looking at. The daemon names this
 * command as `$BROWSER` inside every terminal it starts, so those programs hand
 * the URL here instead.
 *
 * The request travels the only channel that reaches the right browser without a
 * lookup: the terminal itself. `OSC 7780 ; merkur=<token> ; <url>` goes to
 * `/dev/tty`, the daemon's emulator checks the token exactly as it checks an
 * authenticated prompt boundary, and the connected browser offers the URL behind
 * a click. The token is what separates this command from a file being `cat`ed:
 * output cannot read `~/.merkur/shell-token`.
 */
export async function runOpenCommand(args: readonly string[]): Promise<number> {
  const [candidate, ...extra] = args;
  if (candidate === undefined || extra.length > 0) {
    process.stderr.write('usage: merkur open <http(s)-url>\n');
    return 2;
  }
  const url = openableUrl(candidate);
  if (url === null) {
    process.stderr.write(`merkur open: only http and https URLs open: ${candidate}\n`);
    return 2;
  }
  const token = await readOpenToken();
  if (token === null) {
    process.stderr.write('merkur open: no shell token; start the Merkur daemon first\n');
    return 1;
  }

  const tmux = process.env.TMUX;
  const insideTmux = tmux !== undefined && tmux.length > 0;
  if (insideTmux && process.env.MERKUR_TMUX_PASSTHROUGH !== tmux) {
    // The option belongs to the running tmux server, not to any file; see the
    // shell-integration snippet, which sets it the same way for the same reason.
    spawnSync('tmux', ['set', '-g', 'allow-passthrough', 'on'], { stdio: 'ignore' });
  }

  let tty: number;
  try {
    tty = openSync('/dev/tty', 'w');
  } catch {
    process.stderr.write('merkur open: needs the terminal it was started from\n');
    return 1;
  }
  try {
    writeSync(tty, encodeOpenUrlSequence(token, url, insideTmux));
  } finally {
    closeSync(tty);
  }
  process.stderr.write(`Opening ${url} in your Merkur browser\n`);
  return 0;
}

/** An `http:` or `https:` URL in canonical form, or null. */
export function openableUrl(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
}

/**
 * The escape sequence the daemon verifies. BEL-terminated, and inside tmux
 * wrapped in DCS passthrough with its ESC doubled — tmux parses OSC itself and
 * would otherwise swallow it.
 */
export function encodeOpenUrlSequence(token: string, url: string, insideTmux: boolean): string {
  const osc = `\x1b]7780;merkur=${token};${url}\x07`;
  return insideTmux ? `\x1bPtmux;${osc.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : osc;
}

async function readOpenToken(): Promise<string | null> {
  const fromEnvironment = process.env.MERKUR_SHELL_TOKEN;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  try {
    const token = (await readFile(shellTokenPath(), 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Where the terminal's `$BROWSER` helper lives. Not `~/.merkur/bin`: that one
 * is on the user's PATH everywhere, and the `open`/`xdg-open` stand-ins must
 * shadow the system openers only inside terminals the daemon started.
 */
export function openUrlBinDir(): string {
  return path.join(merkurInstallRootPath(), 'terminal-bin');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Script bodies, by file name, for the helper directory. */
export function openUrlCommandScripts(
  programArguments: readonly string[],
  binDir: string,
  platform: NodeJS.Platform,
): ReadonlyMap<string, string> {
  const scripts = new Map<string, string>();
  scripts.set(
    'merkur-open',
    `#!/bin/sh
# Written by the Merkur daemon: $BROWSER inside Merkur terminals.
exec ${programArguments.map(shellQuote).join(' ')} open "$@"
`,
  );
  if (platform === 'linux') {
    // Many Linux tools call xdg-open directly instead of reading $BROWSER. A web
    // URL goes to the browser viewing the terminal; anything else — a file, a
    // directory, a mailto: — is still the system opener's job.
    scripts.set(
      'xdg-open',
      `#!/bin/sh
# Written by the Merkur daemon: web URLs open in the browser viewing this terminal.
case "$1" in
  [Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*) exec ${shellQuote(path.join(binDir, 'merkur-open'))} "$1" ;;
esac
self=${shellQuote(binDir)}
IFS=:
for dir in $PATH; do
  [ "$dir" = "$self" ] && continue
  [ -x "$dir/xdg-open" ] && exec "$dir/xdg-open" "$@"
done
echo "xdg-open: no system xdg-open to open $1" >&2
exit 3
`,
    );
  }
  if (platform === 'darwin') {
    // Node's `open` package, Go's pkg/browser and many other CLIs run `open
    // <url>` instead of reading $BROWSER. A single web URL goes to the browser
    // viewing the terminal. Anything else — a file, a folder, `-a Xcode`, a URL
    // with flags — is `/usr/bin/open`'s job, and it is always at that path.
    scripts.set(
      'open',
      `#!/bin/sh
# Written by the Merkur daemon: a lone web URL opens in the browser viewing this terminal.
if [ "$#" -eq 1 ]; then
  case "$1" in
    [Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*) exec ${shellQuote(path.join(binDir, 'merkur-open'))} "$1" ;;
  esac
fi
exec /usr/bin/open "$@"
`,
    );
  }
  return scripts;
}

/**
 * Write the helper directory for this daemon's executable and return its path.
 * Rewritten at every start, so a moved or updated binary is always the one the
 * helper runs. Each script lands through a rename, so a terminal never executes
 * a half-written one.
 */
export function ensureOpenUrlCommandsEffect(): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async () => {
      const binDir = openUrlBinDir();
      await mkdir(binDir, { recursive: true, mode: 0o700 });
      const scripts = openUrlCommandScripts(resolveProgramArguments(), binDir, process.platform);
      for (const [name, body] of scripts) {
        const target = path.join(binDir, name);
        const temporary = `${target}.tmp-${process.pid}`;
        await writeFile(temporary, body, { mode: 0o700 });
        await chmod(temporary, 0o700);
        await rename(temporary, target);
      }
      return binDir;
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}
