import { ensureShellTokenEffect, shellTokenPath } from '../config';
import type { Logger } from '../logger';

/**
 * Print the shell snippet that emits authenticated prompt boundaries.
 *
 * # What this buys
 *
 * Speculative local echo — the shadow terminal that paints a keystroke before
 * the round trip completes — is granted only inside a shell's line editor, and
 * the daemon needs evidence that it is there. Without shell integration the
 * only evidence available is bracketed-paste mode plus the kernel's view of the
 * PTY, and under a multiplexer the kernel's view describes the multiplexer.
 *
 * `OSC 133` is that evidence. The token makes it evidence rather than a claim:
 * a program writing to your terminal can print `OSC 133;B`, but it cannot read
 * a file in a 0700 directory to learn the token that has to accompany it.
 *
 * # Why the tmux wrapper
 *
 * tmux parses OSC sequences itself and does not forward `OSC 133` to the outer
 * terminal, so inside tmux the daemon would never see a boundary at all. The
 * DCS passthrough form (`ESC P tmux; ... ESC \`) is tmux's supported escape
 * hatch, and it requires `set -g allow-passthrough on`. Inner ESC bytes are
 * doubled, which is what the `\\033\\033` sequences below are.
 *
 * Each snippet sets that option itself, once per running tmux server, rather
 * than asking for a line in `~/.tmux.conf`. A config file is not where the precondition
 * actually lives: the option belongs to the running tmux server, and a server
 * started with `-f` from some other file — which is how the box's tmux starts,
 * and why every box session measured 0% prediction — never reads the user's
 * `.tmux.conf` at all. Setting it from the shell covers both, and covers a
 * server that was already running when the line was added.
 *
 * # Why only fish pays for that wrapper
 *
 * A prompt escape has to be exempt from the shell's column count, or the shell
 * places the cursor past the text it drew. bash and zsh are told: `\\[ \\]` and
 * `%{ %}` mark a run as zero width, so the wrapper's shape is irrelevant to
 * them. fish has no such marker — it measures the prompt with its own escape
 * scanner, and that scanner has no DCS state, so it reads `ESC P` as a
 * two-byte escape and counts the following literal `tmux;` as five printed
 * columns. The fish snippet therefore cancels the miscount explicitly; see the
 * comment on `__merkur_prompt_fixup`.
 */
export async function runShellIntegrationCommand(
  args: readonly string[],
  logger: Logger,
): Promise<number> {
  const requested = args[0];
  const shell = requested ?? detectShell();
  if (!isSupportedShell(shell)) {
    throw new Error(
      `Unsupported shell: ${shell}. Supported: ${SUPPORTED_SHELLS.join(', ')}. ` +
        'Pass one explicitly, for example: merkur shell-integration zsh',
    );
  }

  // Create the token now rather than at first daemon start, so the printed
  // snippet is usable immediately — including on a machine where the user is
  // setting up their rc file before ever running `merkur start`.
  const { Effect } = await import('effect');
  // The value is deliberately NOT embedded in the printed snippet. An rc file
  // is long-lived, frequently version-controlled, and would keep serving a
  // token the daemon had replaced. The snippet reads the file instead; this
  // call exists only to make sure there is a file to read.
  await Effect.runPromise(
    ensureShellTokenEffect().pipe(
      Effect.tapError((error) =>
        Effect.sync(() =>
          logger.warn('shell_token_unavailable', {
            error: String(error),
            path: shellTokenPath(),
          }),
        ),
      ),
    ),
  );

  process.stdout.write(renderShellIntegrationSnippet(shell, shellTokenPath()));
  return 0;
}

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

function isSupportedShell(value: string): value is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(value);
}

function detectShell(): string {
  const shell = process.env.SHELL;
  if (shell === undefined || shell.length === 0) return 'bash';
  const name = shell.slice(shell.lastIndexOf('/') + 1);
  return name.length === 0 ? 'bash' : name;
}

/**
 * Emit the boundary, wrapped for tmux when `$TMUX` is set.
 *
 * The token is read from the environment first and the file second. The
 * environment covers the ordinary case at zero cost; the file covers a pane in
 * a tmux server that was already running when Merkur started it, which never
 * received the variable and would otherwise silently lose local echo.
 */
/**
 * Install lines, one per shell.
 *
 * The snippet cannot be shell-agnostic: bash, zsh, and fish have three
 * unrelated prompt mechanisms and fish is not POSIX. This is the same shape
 * `starship`, `zoxide`, and `direnv` settled on, for the same reason.
 *
 * Each line NAMES its shell rather than relying on detection, even though
 * `detectShell()` exists for the interactive case. `$SHELL` is the account's
 * *login* shell, which is not necessarily the shell reading this rc file — fish
 * started from a bash login shell is the common case — so detection is a guess
 * that an rc file never has to make. It is also long-lived: a wrong guess bakes
 * a bash snippet into a fish config and the shell errors on every start instead
 * of emitting a boundary.
 *
 * Bracketed paste was measured as an alternative and does not work. fish emits
 * `?2004h` exactly once at startup and never `?2004l`, and inside tmux the
 * outer terminal sees only tmux's own single enable — so it is a one-shot
 * signal, not the per-prompt boundary a grant has to be revoked and re-earned
 * against.
 */
const INSTALL_LINES: Record<SupportedShell, string> = {
  bash: 'eval "$(merkur shell-integration bash)"   # add to ~/.bashrc',
  zsh: 'eval "$(merkur shell-integration zsh)"   # add to ~/.zshrc',
  fish: 'merkur shell-integration fish | source   # add to ~/.config/fish/config.fish',
};

function sharedNote(shell: SupportedShell): string {
  return `# Merkur shell integration.
#
# Emits OSC 133 prompt/command boundaries so Merkur can enable speculative
# local echo — the thing that makes typing feel local over a slow link.
#
# Install:
#   ${INSTALL_LINES[shell]}
#
# Inside tmux this also enables passthrough on the running server, once per
# server — without it tmux swallows these sequences and prediction stays off —
# lets the server forward OSC 8 hyperlinks to Merkur, which tmux otherwise
# strips, and turns on extended keys so programs inside tmux can tell keys like
# Ctrl+I and Tab apart. No ~/.tmux.conf line is needed.
`;
}

/**
 * Turn on tmux's DCS passthrough for the server this shell is attached to, let
 * it forward OSC 8 hyperlinks to Merkur's clients, and let it pass extended
 * keys through.
 *
 * `allow-passthrough` is what decides whether the wrapper below reaches the
 * outer terminal at all, and it is a property of the RUNNING SERVER rather than
 * of any file: a tmux started with `-f other.conf` never reads `~/.tmux.conf`,
 * and a server that was already running when the line was added never re-reads
 * it either. Both were true of the box host, where the result was 0 of 4,143
 * prediction-gate samples granted over a day.
 *
 * Once per tmux SERVER, not once per prompt and not once per shell tree: this
 * runs at rc time and the guard carries the value of `$TMUX`, which names the
 * server's socket and pid. A plain "already done" flag would be inherited by
 * the shells a *second* server spawns — `tmux -L other new-session` from
 * inside the first — and every one of them would see `$TMUX` set, skip the
 * call, and run without the option, because the option belongs to the server
 * and not to the process tree that asked for it. Comparing against `$TMUX`
 * instead means the nested server is converged on its first prompt while the
 * shells of a server already handled still cost nothing. The guard also carries
 * the feature entry it applied, so a shell that handled its server under a
 * different entry (an earlier snippet's) runs the block once more.
 *
 * tmux forwards an OSC 8 hyperlink only to a client whose terminal has the
 * `hyperlinks` feature, and it cannot learn that from Merkur: `xterm-256color`
 * (the `TERM` the dataplane gives every PTY) carries no such capability, and
 * tmux recognises a terminal by its version reply only for a fixed list of
 * names. Without the feature a link a program draws inside tmux (Claude Code's
 * sign-in URL, broken over several rows) reaches Merkur as plain text, where
 * only its first row matches as a URL. The feature is read when a client
 * attaches, so it reaches clients that attach after it is set. It is a server
 * option shared by every `xterm-256color` client, which suits any terminal of
 * that name: one without OSC 8 ignores the sequence. Shells of new panes do not
 * inherit the guard, so the entry is appended only when absent rather than once
 * per shell.
 *
 * Extended keys are the same kind of fact. tmux reads them from its outer
 * terminal only when `extended-keys` is on and the terminal has the `extkeys`
 * feature, which, like `hyperlinks`, it cannot learn from `xterm-256color`.
 * With both, tmux asks Merkur for XTerm's `modifyOtherKeys`, which the
 * dataplane honours, and hands the keys on to any program inside that asks for
 * them; `on` rather than `always` leaves every other program's keys as they
 * were.
 *
 * Synchronized output is the third. tmux brackets its writes in mode 2026 only
 * for a terminal with the `sync` feature; it never asks (3.3 to 3.6 send no
 * DECRQM query) and `xterm-256color` does not declare it. With it, tmux
 * brackets every update of a pane that is not the active one (a build or a log
 * streaming beside the pane being typed in), and of the active pane where its
 * own code asks, so each such screen is one the daemon can claim whole and the
 * browser shows it exactly instead of whatever a capture caught mid-write.
 * Plain writes to the active pane, such as a shell's echo, stay unbracketed.
 * The features share one entry, so a server gets them in one append; a server
 * holding the entry before `sync` joined it takes the longer one beside it.
 *
 * Failure is silent on purpose; a shell that cannot reach tmux is one where the
 * wrapper was never going to be read, and an error on every prompt would be
 * worse than no prediction.
 */
const TMUX_FEATURES = 'xterm-256color:hyperlinks:extkeys:sync';

const TMUX_PASSTHROUGH: Record<SupportedShell, string> = {
  bash: `  if [ -n "\${TMUX:-}" ] && [ "\${MERKUR_TMUX_PASSTHROUGH:-}" != "$TMUX ${TMUX_FEATURES}" ]; then
    tmux set -g allow-passthrough on >/dev/null 2>&1
    tmux set -s extended-keys on >/dev/null 2>&1
    case "$(tmux show -sv terminal-features 2>/dev/null)" in
      *${TMUX_FEATURES}*) ;;
      *) tmux set -as terminal-features ',${TMUX_FEATURES}' >/dev/null 2>&1 ;;
    esac
    export MERKUR_TMUX_PASSTHROUGH="$TMUX ${TMUX_FEATURES}"
  fi
`,
  zsh: `  if [[ -n "\${TMUX:-}" && "\${MERKUR_TMUX_PASSTHROUGH:-}" != "$TMUX ${TMUX_FEATURES}" ]]; then
    tmux set -g allow-passthrough on >/dev/null 2>&1
    tmux set -s extended-keys on >/dev/null 2>&1
    case "$(tmux show -sv terminal-features 2>/dev/null)" in
      *${TMUX_FEATURES}*) ;;
      *) tmux set -as terminal-features ',${TMUX_FEATURES}' >/dev/null 2>&1 ;;
    esac
    export MERKUR_TMUX_PASSTHROUGH="$TMUX ${TMUX_FEATURES}"
  fi
`,
  fish: `    if test -n "$TMUX" -a "$MERKUR_TMUX_PASSTHROUGH" != "$TMUX ${TMUX_FEATURES}"
        tmux set -g allow-passthrough on >/dev/null 2>&1
        tmux set -s extended-keys on >/dev/null 2>&1
        if not string match -q '*${TMUX_FEATURES}*' -- (tmux show -sv terminal-features 2>/dev/null)
            tmux set -as terminal-features ',${TMUX_FEATURES}' >/dev/null 2>&1
        end
        set -gx MERKUR_TMUX_PASSTHROUGH "$TMUX ${TMUX_FEATURES}"
    end
`,
};

/** tmux's client overlay owns key forwarding and clears itself on process exit. */
const FISH_TUI_LAUNCHER = `# Interactive Merkur owns this client's keyboard until it exits.
# A borderless popup leaves the outer session's prefixes and key tables intact.
function merkur --wraps merkur
    set -l interactive 0
    if not set -q argv[1]
        set interactive 1
    else
        switch $argv[1]
            case login connect '--*'
                set interactive 1
        end
        if contains -- --help $argv; or contains -- -h $argv; or test "$argv[1]" = --version
            set interactive 0
        end
    end
    if test -n "$TMUX" -a "$interactive" -eq 1
        set -l executable (command --search merkur)
        if test -z "$executable"
            printf 'merkur: command not found\\n' >&2
            return 127
        end
        command tmux display-popup -E -B -w 100% -h 100% -t "$TMUX_PANE" -d "$PWD" -- env "$executable" $argv
    else
        command merkur $argv
    end
end

`;

const SNIPPETS: Record<SupportedShell, (tokenPath: string) => string> = {
  bash: (tokenPath) => `${sharedNote('bash')}
if [ -n "\${MERKUR_SHELL_TOKEN:-}" ] || [ -r "${tokenPath}" ]; then
  : "\${MERKUR_SHELL_TOKEN:=$(cat "${tokenPath}" 2>/dev/null)}"
  export MERKUR_SHELL_TOKEN
${TMUX_PASSTHROUGH.bash}  __merkur_osc() {
    if [ -n "\${TMUX:-}" ]; then
      printf '\\033Ptmux;\\033\\033]133;%s\\a\\033\\\\' "$1"
    else
      printf '\\033]133;%s\\a' "$1"
    fi
  }
  __merkur_prompt_command() {
    __merkur_status=$?
    __merkur_osc "D;$__merkur_status"
    __merkur_osc 'A'
    return $__merkur_status
  }
  case "\${PROMPT_COMMAND:-}" in
    *__merkur_prompt_command*) ;;
    '') PROMPT_COMMAND='__merkur_prompt_command' ;;
    *)  PROMPT_COMMAND="__merkur_prompt_command;\${PROMPT_COMMAND}" ;;
  esac
  case "$PS0" in
    *__merkur_osc*) ;;
    *) PS0="\\[$(__merkur_osc 'C')\\]$PS0" ;;
  esac
  case "$PS1" in
    *__merkur_osc*) ;;
    *) PS1="$PS1\\[$(__merkur_osc "B;merkur=$MERKUR_SHELL_TOKEN")\\]" ;;
  esac
fi
`,

  zsh: (tokenPath) => `${sharedNote('zsh')}
if [[ -n "\${MERKUR_SHELL_TOKEN:-}" || -r "${tokenPath}" ]]; then
  : \${MERKUR_SHELL_TOKEN:=$(cat "${tokenPath}" 2>/dev/null)}
  export MERKUR_SHELL_TOKEN
${TMUX_PASSTHROUGH.zsh}  __merkur_osc() {
    if [[ -n "\${TMUX:-}" ]]; then
      printf '\\033Ptmux;\\033\\033]133;%s\\a\\033\\\\' "$1"
    else
      printf '\\033]133;%s\\a' "$1"
    fi
  }
  __merkur_precmd() {
    local __merkur_status=$?
    __merkur_osc "D;$__merkur_status"
    __merkur_osc 'A'
  }
  __merkur_preexec() { __merkur_osc 'C' }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __merkur_precmd
  add-zsh-hook preexec __merkur_preexec
  # Prompt end must land on the byte where the editable region starts, so it is
  # the LAST thing in PS1 rather than something a hook emits earlier.
  [[ "$PS1" == *__merkur_osc* ]] || PS1="$PS1%{$(__merkur_osc "B;merkur=$MERKUR_SHELL_TOKEN")%}"
fi
`,

  fish: (tokenPath) => `${sharedNote('fish')}
${FISH_TUI_LAUNCHER}if test -n "$MERKUR_SHELL_TOKEN" -o -r "${tokenPath}"
    if test -z "$MERKUR_SHELL_TOKEN"
        set -gx MERKUR_SHELL_TOKEN (cat "${tokenPath}" 2>/dev/null)
    end

${TMUX_PASSTHROUGH.fish}
    function __merkur_osc
        if test -n "$TMUX"
            printf '\\033Ptmux;\\033\\033]133;%s\\a\\033\\\\\\\\' $argv[1]
        else
            printf '\\033]133;%s\\a' $argv[1]
        end
    end

    # Cancel fish's mis-measurement of the boundary it is about to carry in the
    # prompt. fish has no zero-width marker to declare — it measures the prompt
    # with its own escape scanner, which knows no DCS, so under tmux it reads
    # ESC P as a two-byte escape and counts the wrapper's literal 'tmux;' as
    # five printed columns. The cursor then sits five columns right of the
    # prompt on every line.
    #
    # A backspace is the one thing that scanner models as negative width, so
    # exactly as many of them as it over-counts brings its column back to the
    # truth. They are wrapped in a CSI cursor save/restore, which the scanner
    # skips as zero width, so the real cursor returns to the prompt end however
    # the terminal treated them — a two-column prompt like starship's default
    # would otherwise clamp at column 0 and end up five columns too far right.
    #
    # Measured with fish's own accounting rather than hardcoded to five: it
    # measures 0 outside tmux, and on any fish whose scanner learns DCS, and
    # then emits nothing at all.
    set -l __merkur_slip (string length --visible -- (__merkur_osc "B;merkur=$MERKUR_SHELL_TOKEN" | string collect -N))
    set -g __merkur_prompt_fixup ''
    if test $__merkur_slip -gt 0
        set -g __merkur_prompt_fixup (printf '\\033[s')(string repeat -n $__merkur_slip (printf '\\b'))(printf '\\033[u')
    end

    # Prompt end has to land on the exact byte where the editable region begins,
    # so it is appended to fish_prompt's own output. The --on-event fish_prompt
    # hook fires BEFORE the prompt is drawn and would anchor a column too early.
    if not functions -q __merkur_inner_prompt
        functions --copy fish_prompt __merkur_inner_prompt
        function fish_prompt
            __merkur_inner_prompt
            __merkur_osc "B;merkur=$MERKUR_SHELL_TOKEN"
            printf '%s' $__merkur_prompt_fixup
        end
    end

    function __merkur_preexec --on-event fish_preexec
        __merkur_osc 'C'
    end
    function __merkur_postexec --on-event fish_postexec
        set -l __merkur_status $status
        __merkur_osc "D;$__merkur_status"
        __merkur_osc 'A'
    end
end
`,
};

/** The snippet a shell would source, given where the token file lives. */
export function renderShellIntegrationSnippet(shell: SupportedShell, tokenPath: string): string {
  return SNIPPETS[shell](tokenPath);
}
