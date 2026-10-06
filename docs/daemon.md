# Daemon guide

The daemon is the Merkur agent on the user's machine. It is one executable, `merkur`, with
a terminal client and commands for installing, linking, and maintaining the daemon.
Bare `merkur` opens the terminal client. Every service unit starts `merkur daemon`, which holds the authenticated WebSocket to the
application server and supervises the Rust dataplane that owns every latency-sensitive terminal path. This guide covers installing the
daemon, the commands, shell integration, and how updates stay trustworthy.

## Install

Installing is one command. The application server serves a shell script that downloads the
signed release for the machine's platform and hands the unpacked binary the job of verifying
and installing itself.

```sh
curl -fsSL <origin>/install | sh
```

The first install is trust on first use: the script, the binary, and the release key
compiled into it all arrive over HTTPS. Compare the release-key fingerprint the installer
prints with the published one; `merkur release-key` prints it again later. Every later
update is verified against that ML-DSA-87 key, as described in
[`docs/releases.md`](../docs/releases.md#first-install-trust-on-first-use).

The install is versioned. Each release lives in `~/.merkur/versions/<version>`,
`~/.merkur/current` points at the active one, `~/.merkur/bin/merkur` links into it, and the
installer adds one marked `PATH` block to the startup file of the account's login shell.
`merkur link` records that same shell as the one every terminal opens. Both read it from the
password database (`id -P` on macOS, `getent passwd` on Linux), never from `$SHELL`, which
names whatever shell ran the command: a coding agent's tool shell, or one `runuser -s` forced.

## Commands

Every command prints plain sentences for a person, with failures on stderr prefixed
`error:`. `merkur help` (or `--help` anywhere) lists the commands; an unknown command prints
that list and exits 2. `merkur daemon` writes structured JSON logs. Bare `merkur` opens the terminal client.

| Command | What it does |
| --- | --- |
| `merkur` | Opens the terminal client with saved account credentials, or prompts to sign in. Ctrl-\\ is the command prefix. |
| `merkur login` | Signs in and stores a local account delegation. |
| `merkur logout` | Revokes this client delegation and removes its saved credentials. |
| `merkur machines` | Lists account machines from the server’s live snapshot. |
| `merkur connect <machine>` | Opens a machine by exact ID or unambiguous exact name. |
| `merkur daemon` | Runs the background daemon for its supervisor. |
| `merkur setup <archive> <manifest> <signature> [--link <origin> [link flags]]` | Run by the install script from the binary it unpacked. Verifies that the signed manifest names this binary's version, installs the archive into the versioned layout, makes `merkur` callable by name, and prints the release-key fingerprint. With `--link` it then runs `merkur link` with the remaining arguments, which is how the one-command install from the browser links the machine in the same step. |
| `MERKUR_LINK_TOKEN=<token> merkur link <origin> [--identity-backend software] [--replace-identity]` | Links this machine to an account. Creates or reopens the daemon's composite identity through the dataplane, consumes the account-issued link token from the environment to open a pending claim, prints an approval code as an `<origin>/link#<code>` address (and a QR code of it on a terminal) for the browser to open, verifies the browser's approval, and writes the identity, root binding, server verification key, and linked coordinates to `~/.merkur/config.json`. `--identity-backend software` accepts software key custody on a machine without a Secure Enclave or TPM. |
| `merkur install` | Installs and starts the background service: a LaunchAgent at `~/Library/LaunchAgents/dev.merkur.daemon.plist` on macOS, or a systemd user unit at `~/.config/systemd/user/merkur-daemon.service` on Linux. On Linux it also enables lingering (`loginctl enable-linger`) so the daemon survives logout, and names the `sudo` command when policy refuses it. |
| `merkur start` | Restores a daemon that `merkur stop` took down: bootstraps the LaunchAgent back into the user domain and kickstarts it, or re-enables and starts the systemd unit. Needs an existing service definition, so run `merkur install` first on a fresh machine. Leaves a running daemon and its sessions untouched. |
| `merkur stop` | Stops the service, and kills a process holding the single-instance lock only after verifying it looks like Merkur. On macOS this boots the job out of the user domain, so the daemon stays down until `merkur start`. |
| `merkur update` | Reads the newest version from the latest signed manifest on the public GitHub release, treating GitHub as untrusted transport. Verifies the ML-DSA-87 signature over the canonical manifest, expiry, prerequisites, SHA-512 artifact integrity, and a durable monotonic rollback floor (`release-trust.json`), then activates atomically and rolls back a failed service activation. |
| `merkur version` | Prints the build version, `dev` when running from source. |
| `merkur release-key` | Prints the fingerprint of the ML-DSA-87 release key compiled into this build, for comparison with the published one. A build from source has no key: it says so on stderr and exits 1. |
| `merkur licenses` | Prints Merkur's own license and the notices for every dependency compiled into the shipped executables. The text is generated by `scripts/generate-third-party-notices.ts` and compiled in, because the release archive carries four executables and nothing else. |
| `merkur open <url>` | Asks a connected client to open an `http(s)` URL. See [Opening URLs](#opening-urls-from-the-terminal). |
| `merkur shell-integration [bash\|zsh\|fish]` | Prints the rc snippet that enables speculative echo. See [Shell integration](#shell-integration). |

`merkur daemon` loads the config, takes a per-daemon single-instance lock, starts the Rust
dataplane, and keeps the registration and heartbeat state machine to the server. It forwards
exact controls such as `session_start` and `delegation_revoke` to the dataplane over IPC and
reports lifecycle events back. Browser-facing WebTransport signaling and direct-path upgrades
never leave the dataplane. The supervision model is in [`docs/processes.md`](processes.md).

## Terminal client

The client runs in the host terminal's alternate screen. It keeps passwords out of argv and
stores an account delegation separately from the machine's daemon identity. Sign out with
`merkur logout` to revoke that delegation and remove its credentials. Hardware key custody
uses Secure Enclave on macOS or TPM on Linux; software custody requires an explicit choice.

Ctrl-\ is the command prefix. Its command row switches between machines and open tabs,
closes tabs, approves machine links, renames or unlinks machines, and reviews account
sessions. A machine's terminal takes the size of the client's window when its tab connects
or gains focus. While another client holds that size the tab shows its screen cropped, and
Ctrl-\ followed by `f` fits it to this window again. Sending the prefix twice forwards one Ctrl-\ to the remote program. Each open
tab owns its input, so switching while a key is held keeps its repeats and release with the
original tab. Ctrl-\ followed by `o` reviews that tab’s pending program URLs; Enter opens
the inspected address in the local browser, `d` dismisses it, and Esc returns without handling it.
Machine mutations require a fresh password unlock of the account root.
Opening a machine whose tab has ended starts a fresh session in that tab's position.
An incorrect sign-in password can be retried. Account revocation ends every session,
removes the saved credentials and returns to password entry.

The terminal renderer uses the host's default colours, draws only changed cells, and
carries OSC 8 links with the cells that name them. Images use the host's Kitty graphics
protocol. Cropped tiles are prepared at the exact host pixel geometry, and every upload
must be acknowledged before a complete replacement scene is placed. Hidden tabs remove
their placements and suspend animation deadlines. The transport reactor continues input,
authentication and display acknowledgements while host output is backpressured.

The selected tab supplies the host window title; leaving Merkur restores the previous title.
Bells and OSC 9/777 notifications are typed events from the daemon's terminal parser and use
the host's bell and fixed OSC 777 notification forms. OSC 52 writes copy to the local host
only while the originating tab is selected and focused with no management dialog. Clipboard
reads are not sent to the remote program.

## Shell integration

Speculative local echo is the largest felt-latency win Merkur has, and it stays **off**
until the shell emits authenticated prompt boundaries. Nothing else supplies that evidence.
Without them the daemon has only bracketed-paste mode plus the kernel's view of the PTY, and
under a multiplexer that view describes the multiplexer rather than the shell the user is
typing into. A machine that skips this step works correctly and pays a full network round
trip for every keystroke.

The snippet wraps the prompt so that it emits `OSC 133` prompt and command boundaries
authenticated with the token in `~/.merkur/shell-token`. The command creates that file if it
does not exist, so the snippet works before the daemon has ever run. The token is never
embedded in the printed text: an rc file is long-lived and often version-controlled, and the
snippet reads the file instead.

Install once per machine, at the **end** of the rc file:

```bash
eval "$(merkur shell-integration bash)"   # ~/.bashrc
eval "$(merkur shell-integration zsh)"    # ~/.zshrc
```

```fish
merkur shell-integration fish | source    # ~/.config/fish/config.fish
```

The fish snippet also wraps the interactive `merkur` launches that open the terminal client
(bare `merkur`, `login`, `connect` and client flags) inside local tmux in a borderless
popup, full size when opened. While Merkur runs, the popup receives the client's keys
before the outer tmux bindings; Ctrl-B reaches remote tmux without doubling it. On exit,
the popup closes and fish receives Merkur's exit status. Other attached clients and tmux
key tables are unchanged. Help, version and every other command execute directly, as do
all launches outside tmux. This launcher works independently of the prompt token. Reload
the snippet in an existing fish shell to activate it there.

The shell argument is optional. Without it the command detects the shell from the basename
of `$SHELL`, falling back to `bash`, and the daemon sets `SHELL` on every PTY it opens so
that detection is right inside a Merkur terminal. Name the shell explicitly when the shell
reading the rc file is not the login shell, for example a fish `config.fish` on an account
whose login shell is zsh.

Position is load-bearing. The boundary has to land on the exact byte where the editable
region begins, so anything that redefines the prompt (starship, a theme) has to run before
the snippet. In fish that also rules out a `conf.d` drop-in, which is sourced before
`config.fish` and would capture fish's default prompt instead of the real one.

Inside tmux the snippet emits the DCS-wrapped form and turns on `allow-passthrough` on the
running tmux server itself, because tmux parses `OSC 133` and does not forward it. It also
turns on `extended-keys` and adds `xterm-256color:hyperlinks:extkeys:sync` to
`terminal-features`, once per running server, so OSC 8 links and extended key reporting
survive tmux and tmux brackets its updates of every pane but the active one (and the active
pane's where its own code asks) in synchronized output, which the browser then shows only
whole. A client attached before that needs one detach and re-attach. No
`~/.tmux.conf` line is required.

A box host installs the snippet in each box at create time and again while the box runs. To
confirm prediction is live on any machine, read the browser's `prediction_gate` telemetry
rows. The token, the multiplexer case, and the gate's fields are in
[`docs/security.md`](../docs/security.md#speculative-echo-and-the-prompt-boundary) and
[`docs/observability.md`](../docs/observability.md).

## Opening URLs from the terminal

A CLI that wants to open a browser (`gh auth login`, `gcloud auth login`, Python's
`webbrowser`) runs on the remote machine, but the browser the user is looking at is local.
`merkur open <url>` bridges that. It writes an authenticated `OSC 7780` to `/dev/tty`
(DCS-wrapped inside tmux), which the daemon verifies against `~/.merkur/shell-token` and
forwards to connected clients. The browser opens the URL at once when the page has a recent
user activation, and otherwise offers it behind an Open button. The terminal client keeps
the request in its originating tab and opens it only after an explicit review and Enter.

The daemon names `merkur-open` as `$BROWSER` in every terminal it starts, and puts an opener
stand-in first on `PATH`: `open` on macOS and `xdg-open` on Linux. The stand-in forwards a
web URL to the browser and passes files, folders, apps, and flags to the system opener, so
tools that shell out to the platform opener reach the right browser without configuration.

## Updates and trust

The release archive carries four executables: `merkur`, `merkur-tui`, the dataplane, and
the image worker. Every update fetches the newest signed manifest from the public GitHub release and
verifies it against the ML-DSA-87 key compiled into the running binary, so GitHub is only
transport. The manifest's sequence number is written to `release-trust.json` and acts as a
durable rollback floor: a later manifest with a lower sequence is refused even if its
signature is valid. Activation switches the `current` symlink atomically, restarts the
service, and rolls back to the previous version if the new service fails to come up. The
signing key, manifest format, and release pipeline are in
[`docs/releases.md`](../docs/releases.md).

[Back to Merkur](../README.md).
