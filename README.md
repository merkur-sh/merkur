# Merkur

Merkur is a terminal for your remote machines that runs in the browser. Link a workstation or a
server once, then open it from any laptop or phone and work in Neovim, tmux, Claude Code or Codex
as you would at the desk.

[Try Merkur](https://app.merkur.sh) · [Website](https://merkur.sh) · [Quickstart](#quickstart) ·
[How it's different](#how-merkur-is-different) · [How it works](#how-it-works) ·
[Documentation](#documentation)

[![CI](https://github.com/merkur-sh/merkur/actions/workflows/ci.yml/badge.svg)](https://github.com/merkur-sh/merkur/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/merkur-sh/merkur?label=release)](https://github.com/merkur-sh/merkur/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

<a href="docs/assets/cover.png"><img src="docs/assets/cover.png" alt="A desktop browser showing tmux on a remote Linux machine with Claude Code in the left pane and a Neovim file explorer of the project in the right pane. A phone in the corner shows a fresh Claude Code session on the same machine above Merkur's touch keyboard."></a>

Claude Code and Neovim in tmux on a remote Linux machine, from a desktop browser and from a phone.

Created and maintained by [@ph1losof](https://github.com/ph1losof).

## Quickstart

You need a Mac or Linux machine to reach and a [supported browser](#requirements).

1. **[Open Merkur](https://app.merkur.sh)**, create an account, and choose **Add a machine**.
2. **Paste the command it shows** into a shell on that machine. It installs the daemon and prints
   an approval link and a QR code.

   ```sh
   curl -fsSL https://app.merkur.sh/install | MERKUR_LINK_TOKEN=<token> sh
   ```

3. **Approve it** by opening the link, or scanning the code with a signed-in phone, and entering
   your password. The daemon starts as a user service and the machine appears in your list. Open
   it.

To have typing show up at the prompt before the machine answers, add the
[shell integration](docs/daemon.md#shell-integration) to the end of your shell's startup file:

```sh
eval "$(merkur shell-integration bash)"   # ~/.bashrc
eval "$(merkur shell-integration zsh)"    # ~/.zshrc
merkur shell-integration fish | source    # ~/.config/fish/config.fish
```

<details>
<summary>Verify the installation key</summary>

The first install trusts HTTPS to the server for the script, the binary and the release key
compiled into it. Every later update is verified against that key. Compare the fingerprint the
installer prints, or `merkur release-key` prints later, with:

```text
733e336c becc7559 82591288 a138b3e3 6f74e40e ac916431 cf355b10 c234f059
```

If it differs, do not link the machine. See the [security policy](SECURITY.md#release-key).

</details>

## How Merkur is different

- It renders like a native terminal. Text, Nerd Font icons and box drawing come out sharp at
  your screen's resolution, so Neovim, tmux and your agents look the way they do at the desk.
- It runs in the browser. Any laptop or phone works, a borrowed one included, and installed on
  a phone it adds a keyboard with Esc, Ctrl, Tab and arrows.
- It holds up on bad networks. Like Mosh, it stays usable over high latency and packet loss, and
  your session survives a switch from Wi-Fi to cellular.
- You sign in with a password. There are no SSH keys to carry, and the machine needs no open
  port because it connects out.
- Images and links work. Kitty graphics render inline, links are clickable, and `merkur open`
  sends a URL from the remote shell to the browser you're using.
- It replaces a stack of services. Tailscale to reach the machine, Termius or Blink on each
  device and Mosh on the server become one sign-in, encrypted end to end.
- You can work from anywhere. A terminal bell on any of your machines reaches your phone as a
  notification, and `merkur` opens the same machines in your own terminal on a computer.

Against the setups people use for this today, with the usual clients:
[Termius](https://termius.com/) and [Blink Shell](https://blink.sh/) for SSH and
[Mosh](https://mosh.org/), and the Claude app for
[Claude Code Remote Control](https://docs.claude.com/en/docs/claude-code/remote-control).

|                                                | Merkur                       | Tailscale + SSH + tmux                    | Mosh + tmux                          | Claude Code Remote Control |
| ---------------------------------------------- | ---------------------------- | ----------------------------------------- | ------------------------------------ | -------------------------- |
| Runs in a browser, nothing to install          | Yes                          | No                                        | No                                   | Yes                        |
| Works from a borrowed device without your keys | Yes                          | No                                        | No                                   | Yes                        |
| Survives a Wi-Fi to cellular handoff           | Yes                          | No, you reattach tmux                     | Yes                                  | Yes                        |
| Behavior under packet loss                     | One extra round trip at most | Stalls on every loss                      | Waits on a retransmit timer          | Not a terminal             |
| Full terminal: Neovim, tmux, any agent         | Yes                          | Yes                                       | Yes                                  | No, one Claude Code chat   |
| Inline images                                  | Yes, Kitty graphics          | Depends on the client                     | No                                   | No                         |
| Host needs only outbound connections           | Yes                          | No, inbound SSH or Tailscale on both ends | No, mosh-server and a UDP port range | Yes                        |
| Terminal bytes readable by a middlebox         | No, keyed end to end         | No, there is none                         | No, there is none                    | Yes, the vendor's service  |

[herdr](https://herdr.dev/) and tmux run inside Merkur, so they are not on the list.
[code-server](https://coder.com/docs/code-server) and
[GitHub Codespaces](https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces)
give you a graphical IDE rather than a terminal.

## How it works

```mermaid
flowchart LR
  Client[Browser or merkur client]
  Server[Application server]
  Edge[Blind WebTransport relay]
  Daemon[Daemon on your machine]
  Shell[Shell / PTY]

  Client <-->|Encrypted terminal traffic| Edge
  Edge <-->|Encrypted terminal traffic| Daemon
  Client <-.->|Direct encrypted path when reachable| Daemon
  Client <-->|Account and session setup| Server
  Daemon <-->|Presence and session commands| Server
  Daemon <--> Shell
```

The application server handles accounts, machine linking and session authorization. **It never
carries terminal input or display updates.** A session starts through a relay that sees only
ciphertext. The daemon only dials out; when the client and the daemon can reach each other, the
session moves to a direct WebTransport connection punched through NAT and the relay drops out.

SSH and most browser terminals send a byte stream over TCP, so one lost packet holds up
everything behind it. Merkur syncs the screen instead. The daemon's Rust dataplane runs a terminal
emulator that owns the grid and sends changed cells, encoded with MZ, a codec built for terminal
screens, as QUIC datagrams. Each datagram is a complete update to the rows it carries, so a loss
costs those rows until replay or forward error correction repairs them, and nothing queues behind
it. The daemon keeps the session through a network gap, and the client rejoins it.

In the browser, a WebAssembly build of the same terminal emulator decodes the updates and a WebGPU
renderer draws them, both in workers, so the UI thread handles only input. Glyphs rasterize at the
device's pixel density from a bundled Nerd Font. The [transport design](docs/transport.md),
[display invariants](docs/display-invariants.md) and
[performance methodology](docs/performance.md) cover the implementation and its tradeoffs.

## Requirements

| Where   | What you need                                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser | WebGPU, WebTransport with certificate-hash pinning, WebAssembly SIMD, and cross-origin-isolated SharedArrayBuffer support. GPU and driver support matter; see the [browser requirements](docs/requirements.md#browser). |
| Mac     | macOS 13 or newer, Apple Silicon or Intel with AVX2.                                                                                                                                                                    |
| Linux   | glibc 2.36 or newer, kernel 5.1 or newer, a systemd user session, and arm64 or x86-64 with AVX2.                                                                                                                        |
| Network | Outbound HTTPS/WSS and UDP for QUIC.                                                                                                                                                                                    |

Hardware identity uses Secure Enclave or TPM 2.0 where available; software custody requires
explicit opt-in. The [full requirements](docs/requirements.md) list browser versions, hardware
identity prerequisites, and platform checks.

## Security model

Your password never leaves the browser: Merkur signs you in with OPAQUE. Each machine's identity
lives in its Secure Enclave or TPM and is approved once from a signed-in device, and each browser
holds a delegation you can revoke. Every terminal session starts with a fresh ML-KEM-1024
handshake and runs under Noise. Daemon releases ship as signed manifests with rollback protection.

The encryption protects terminal contents on the relay and on the direct path. It does **not**
hide traffic timing or sizes, protect a compromised endpoint, or remove trust in the JavaScript
the application origin serves. Account and management traffic rely on TLS. The
[threat model](docs/security.md) covers the post-quantum design and its limits.

Report vulnerabilities privately through the [security policy](SECURITY.md).

## Development

Use Bazelisk (it runs the Bazel release in [`.bazelversion`](.bazelversion)), pnpm, the Bun
release in [`.bun-version`](.bun-version), the pinned [Rust toolchain](rust-toolchain.toml), and
Docker with Compose. Run these commands from the repository root:

```sh
pnpm install
bun run infra:up  # Start local Redis
bun run setup    # Configure local env, hooks, and Rust/WASM artifacts
bun run dev      # Start the edge, server, and browser app
```

Open the local URL printed by the development server. Link a local daemon to use a terminal;
`bun run dev:full` also runs that daemon once it is linked. `bun run dev:doctor` diagnoses missing
services, tools, and artifacts.

See the [development guide](docs/development.md) for daemon development, build commands, tests,
and deployment prerequisites. [CONTRIBUTING.md](CONTRIBUTING.md) covers contributions and the CLA.

Built by one developer, with AI coding agents (Claude Code, Codex) writing most of the code. The
design is mine, and a few choices were made just because the technology was shiny, like WebTransport and
WebGPU. They work, so they stayed.

PRs welcome, including AI-assisted ones, if you've reviewed and tested the change.

Pull requests and pushes to `main` run [CI](.github/workflows/ci.yml). Version tags trigger the
[release workflow](.github/workflows/release.yml): building, signing, service deployment, and
publication. See [CI operations](docs/ci.md) and [releases](docs/releases.md).

## Documentation

| Start here                | Read more                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Using Merkur              | [Requirements](docs/requirements.md) · [Daemon commands and shell integration](docs/daemon.md) · [Native image submission](docs/native-images.md)                                                                  |
| Building and contributing | [Development](docs/development.md) · [Contributing](CONTRIBUTING.md)                                                                                                                                               |
| Understanding the design  | [Architecture](docs/architecture.md) · [Processes](docs/processes.md) · [Transport](docs/transport.md) · [Display](docs/display-invariants.md) · [Graphics](docs/graphics.md) · [Performance](docs/performance.md) |
| Operating a deployment    | [Configuration](#configuration) · [Observability](docs/observability.md) · [CI](docs/ci.md) · [Releases](docs/releases.md)                                                                                         |
| Evaluating security       | [Threat model](docs/security.md) · [Reporting vulnerabilities](SECURITY.md)                                                                                                                                        |

## License

Merkur is licensed under the [GNU AGPL v3.0](LICENSE). One component has separate terms: the
shared logger, [`packages/logger`](packages/logger), uses Apache 2.0.

See [NOTICE](NOTICE) for details and run `merkur licenses` for bundled dependency notices and the
corresponding-source offer. Contributions require the [Contributor License Agreement](CLA.md).

Rights beyond the public licenses, such as proprietary modification, OEM use, or a hosted
service, are available under a separate agreement; see [commercial licensing](COMMERCIAL-LICENSING.md).
The licenses do not cover the Merkur name or logo; see the [trademark policy](TRADEMARK.md).

## Workspace Layout

Bun and TypeScript handle the application and orchestration; Rust owns the terminal data path.

<details>
<summary>Applications, packages, and maintained harnesses</summary>

| Path                                | Role                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `apps/web`                          | Browser app: SolidJS, workers, WebGPU, and WASM.                             |
| `apps/server`                       | Accounts, device linking, presence, session issuance, and web serving.       |
| `apps/edge`                         | Blind WebTransport relay.                                                    |
| `apps/daemon`                       | Local CLI, service lifecycle, signed updates, and server control connection. |
| `apps/daemon/dataplane`             | Rust PTY, authentication, transport, input, and display synchronization.     |
| `apps/stun`                         | Authenticated STUN observations and direct-path verification.                |
| `apps/site`                         | Website: static pages, their build checks, and the static server.            |
| `apps/tui`                          | Native terminal client (`merkur-tui`): interactive and headless sessions.    |
| `packages/auth`                     | OPAQUE account authentication, tokens, and session authorization.            |
| `packages/config`                   | Server and daemon configuration.                                             |
| `packages/logger`                   | Structured logging and Effect integration.                                   |
| `packages/protocol`                 | Binary terminal protocol.                                                    |
| `packages/shared`                   | Shared contracts, crypto helpers, transport utilities, and IPC framing.      |
| `packages/daemon-control-protocol`  | Server–daemon control messages.                                              |
| `packages/keyboard`                 | Configurable touch terminal keyboard.                                        |
| `packages/quicksilver`              | Quicksilver design system: tokens, UnoCSS preset, UI faces, Vite plugins.    |
| `packages/user-agent`               | Bounded browser and OS identification.                                       |
| `packages/profile`                  | Native trace capture reader for profiling and the e2e oracles.               |
| `packages/term-wasm`                | Browser terminal state, display decoding, fonts, and rendering data.         |
| `packages/merkur-authorization`     | Delegations, daemon bindings, revocations, link approval, root envelope.     |
| `packages/merkur-client`            | Sans-IO client core: issuance, authentication, lanes, input.                 |
| `packages/merkur-identity-seal`     | Native identity custody: Secure Enclave, TPM, explicit software storage.     |
| `packages/merkur-client-native`     | Native driver for the client core: account API, WebTransport, tokio.         |
| `packages/merkur-codec`             | Shared display codec.                                                        |
| `packages/merkur-e2e`               | Native and browser session bootstrap, Noise, and replay protection.          |
| `packages/merkur-edge-protocol`     | Edge routing preface and splice-control events.                              |
| `packages/merkur-stun-protocol`     | Shared authenticated STUN codec and observation receipts.                    |
| `packages/merkur-traversal`         | Native UDP discovery, peer checks and router mappings.                       |
| `packages/merkur-wire`              | Client–dataplane wire: channels, frames, input records, signaling.           |
| `packages/e2e-wasm`                 | Browser bindings for session encryption.                                     |
| `packages/graphics-wasm`            | Browser graphics verification.                                               |
| `packages/graphics-codec-probe`     | Benchmark-only graphics decoder.                                             |
| `packages/merkur-fec`               | Display forward error correction.                                            |
| `packages/merkur-trace`             | Bounded native trace recorder: spans, boundary evidence, capture files.      |
| `packages/merkur-graphics`          | Kitty graphics ingestion, placement, and resource ownership.                 |
| `packages/merkur-image-worker`      | Isolated image decoding and tile encoding.                                   |
| `packages/display-fixture`          | Native MZ fixtures for browser compression benchmarks and calibration.       |
| `packages/alacritty-terminal-patch` | Patched authoritative terminal grid.                                         |
| `packages/vte-patch`                | Patched terminal escape-sequence parser.                                     |
| `packages/wtransport-patch`         | Patched WebTransport implementation.                                         |
| `packages/quinn-patch`              | Patched asynchronous QUIC transport.                                         |
| `packages/quinn-proto-patch`        | Patched QUIC protocol and congestion accounting.                             |
| `packages/fontdue-patch`            | Patched font rasterizer.                                                     |
| `spikes/webtransport-ios`           | Real-device WebTransport acceptance harness.                                 |

</details>

## Configuration

For local development, `bun run setup` creates the server environment. For deployments, start
with [`apps/server/.env.example`](apps/server/.env.example) and the
[deployment guide](docs/development.md#infrastructure-and-deployment).

<details>
<summary>Server environment variables</summary>

Loaded by `packages/config/src/server-config.ts`.

<!-- generated:server-environment -->
| Variable | Required | Notes |
| --- | --- | --- |
| `HOST` | No | HTTP server bind address. Default: `0.0.0.0`. |
| `PORT` | No | HTTP server listen port. Default: `3000`. |
| `PUBLIC_ORIGIN` | No | Canonical origin browsers reach Merkur at. Set explicitly for deployments. Local setup uses http://127.0.0.1:3000. It is checked against signed browser delegations and used as the daemon linking target. Default: `https://localhost:3000`. |
| `DB_URL` | No | Defaults to `file:./data/merkur.db`. `file:` opens a local database in-process; `http(s)://` or `libsql://` reach a libSQL server, which is what production runs so more than one process can share one database. The compiled server carries only the network client, so a `file:` URL is refused there. Default: `file:./data/merkur.db`. |
| `DB_AUTH_TOKEN` | No | Bearer credential for a remote database; unset for a local one. |
| `REDIS_URL` | Yes | Redis or Dragonfly URL. |
| `ACCESS_TOKEN_HMAC_KEY` | Yes | Canonical unpadded base64url for exactly 64 random bytes. It authenticates the single fixed access-token format; there is no key id or algorithm negotiation. |
| `JWT_ISSUER` | No | Access-token issuer. Default: `merkur`. |
| `JWT_AUDIENCE` | No | Access-token audience. Default: `merkur-clients`. |
| `TOKEN_HMAC_SECRET` | Yes | Canonical unpadded base64url for exactly 64 random bytes; domain-separated HMAC-SHA-512 hashes refresh and link tokens, and derives deterministic synthetic absent-account auth-start material. Rotation changes future provisional values; already-created Redis auth flows retain their recorded material until consumed or expired. |
| `AUTH_ALLOW_REGISTRATION` | Yes | Explicit account-creation policy. The combined OPAQUE start remains available in either state. When `false`, every registration finish answers `403 registration_closed`, whether the username is new or belongs to an account whose password was mistyped, so the refusal does not enumerate usernames; existing-account login is unchanged. When `true`, account creation is limited to five per source address per hour. |
| `AUTH_IDENTITY` | Yes | What accounts are named by: `username` or `email`. Username mode accepts any 3-254 character name and sends no mail; use it for self-hosting. Email mode accepts only an address and creates an account only after a six-digit code mailed to it is entered; an address that already has an account is mailed a notice instead of a code, so sign-up still does not enumerate accounts. |
| `RESEND_API_KEY` | With `AUTH_IDENTITY=email` | Resend API key that sends sign-up and password-reset codes. Refused in username mode. |
| `EMAIL_FROM` | With `AUTH_IDENTITY=email` | Sender header, e.g. `Merkur <signin@merkur.sh>`; its domain must be verified in Resend. Refused in username mode. |
| `RESEND_API_URL` | No | Resend API base URL; defaults to `https://api.resend.com`. Only valid in email mode. |
| `SITE_ORIGIN` | No | Origin of the public website. Set it to take Boxes waitlist addresses from that site: the waitlist route exists only when it is set, accepts a post from this origin alone, and names only it in `Access-Control-Allow-Origin`. |
| `RYBBIT_HOST` | With `RYBBIT_SITE_ID` and `RYBBIT_API_KEY` | Rybbit origin the server reports a new waitlist address to; `/api/track` is appended. The three Rybbit variables are set together or not at all, and need `SITE_ORIGIN`. |
| `RYBBIT_SITE_ID` | With `RYBBIT_HOST` and `RYBBIT_API_KEY` | Rybbit site the website reports to, so both kinds of event land on one site. |
| `RYBBIT_API_KEY` | With `RYBBIT_HOST` and `RYBBIT_SITE_ID` | Rybbit API key, sent as `Authorization: Bearer`. It marks the event as ingestion from this server and never reaches the website. |
| `OPAQUE_SERVER_SETUP` | Yes | Stable canonical OPAQUE server setup. Replacing it invalidates every OPAQUE registration record. Keep it secret and durable. |
| `OPAQUE_SERVER_PUBLIC_KEY` | Yes | Canonical public key derived from `OPAQUE_SERVER_SETUP`; startup fails if they do not match. |
| `VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY` | Build + standalone startup | Must equal `OPAQUE_SERVER_PUBLIC_KEY`. The browser pins this value; the deployment build validates it and compiles it into the server for a pre-migration startup comparison. |
| `TRUSTED_PROXY_HOPS` | Yes | Number of reverse proxies in front of the server that append to `X-Forwarded-For`. `0` ignores the header and keys rate limits on the socket address; production is `1`, behind Caddy. Wrong values either let a client forge its own rate-limit key or collapse every client into one bucket, so there is no default. |
| `SESSION_TOKEN_MLDSA87_SEED` | Yes | Canonical unpadded base64url for exactly 32 random bytes used to derive the fixed ML-DSA-87 session-authorization keypair. Existing daemons must relink after an intentional hard-cut key replacement. |
| `SESSION_TOKEN_TTL_MS` | No | Session-capability lifetime from 2000 through 300000 milliseconds. Reconnects request fresh capabilities. Server and daemon clocks must be synchronized. Default: `60000`. |
| `BOX_HOST_URL` | No | Canonical HTTP(S) origin of the box host. Configure together with `BOX_HOST_TOKEN`; both absent disables hosted-box provisioning. Credentials, paths, queries, fragments, and trailing slashes are refused. |
| `BOX_HOST_TOKEN` | With `BOX_HOST_URL` | Bearer token the box host authorizes with. |
| `BOX_HOST_TIMEOUT_MS` | No | Positive integer request timeout in milliseconds, no greater than 2147483647. Default: `120000`. |
| `EDGE_REGISTRATION_KEYS_JSON` | Yes | Canonical minified JSON mapping each edge id to its distinct canonical base64url 64-byte HMAC-SHA-512 key. The server refuses to boot on an empty, reused, malformed, or noncanonical map. |
| `EDGE_ATTACH_TICKET_KEY` | Yes | Canonical unpadded base64url for exactly 64 random bytes. The deployment secret every edge verifies attach tickets with: the server mints one per daemon on each control lease and one per browser session, and an edge closes any peer without a valid ticket. Set the same value as `MERKUR_EDGE_ATTACH_TICKET_KEY` on every edge. |
| `STUN_TICKET_KEY` | Yes | Canonical unpadded base64url for exactly 64 random bytes. The deployment secret every `merkur-stun` responder derives per-ticket MESSAGE-INTEGRITY-SHA256 keys from; the server mints short-lived tickets over the daemon control connection and the daemon never sees this value. Set the same value as `MERKUR_STUN_TICKET_KEY` on the responder. |
| `STUN_SERVERS` | Yes | At least two distinct comma-separated `host:port` vantage points, with ports from 1 through 65535. Use independent addresses in production; two ports of one address establish only port dependence. Local development uses blackholed TEST-NET-1 addresses. |
| `BOX_HOST_STUN_OBSERVERS` | No | The `STUN_SERVERS` entries that run on the box host, spelled exactly as there. Left out of a box daemon's list, because a box reaches its own host without crossing its NAT and would classify it from a private address. Empty by default. |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | Optional group | Canonical unpadded base64url P-256 public key. Configure together with `WEB_PUSH_VAPID_PRIVATE_KEY` and `WEB_PUSH_CONTACT`; partial or mismatched groups fail startup. |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | Optional group | Canonical unpadded base64url P-256 private key matching the public key. Configure the complete web-push group. |
| `WEB_PUSH_CONTACT` | Optional group | Web-push contact: a `mailto:` address or an HTTPS URL. Required with the VAPID keypair. |
| `AXIOM_TOKEN` | Optional group | Axiom API token. Supplying it enables OTLP export of traces, Effect-native logs, and metrics; supply all four Axiom variables or none. Unset, spans are printed to stdout as a tree instead of exported. |
| `AXIOM_DATASET` | Optional group | Dataset receiving traces and logs (`x-axiom-dataset`). |
| `AXIOM_METRICS_DATASET` | Optional group | Dataset receiving metrics (`x-axiom-metrics-dataset`). Separate from traces and logs because Axiom's metrics intake uses a different header and accepts only protobuf. |
| `AXIOM_PERF_DATASET` | Optional group | Dataset receiving browser profiling rows, written through Axiom's native `/v1/ingest/{dataset}` API rather than OTLP. Without it, profiling batches are accepted and discarded as unconfigured. On the free tier this is the third and last dataset allowed. |
| `AXIOM_ENDPOINT` | No | Axiom intake base URL without credentials, query, or fragment. Datasets outside the default region require their own edge deployment URL, which is not api.<region>.axiom.co; read edgeDeploymentUrl from the dataset API. Default: `https://api.axiom.co`. |
| `TELEMETRY_ENVIRONMENT` | No | Value of the deployment.environment.name resource attribute. Set to production on the deployed server. Default: `development`. |
| `TRACE_LEVEL` | No | Minimum sampled span level: All, Fatal, Error, Warn, Info, Debug, Trace, or None. Applies equally to stdout and OTLP export; Debug enables Redis operation and health-poll spans. Default: `Info`. |
| `TRACE_SAMPLE_RATIO` | No | Share of unremarkable traces retained, from 0 to 1. Failures, slow traces, and traces reaching a daemon are always retained. Default: `1`. |
| `TRACE_SLOW_THRESHOLD_MS` | No | Root-span duration in milliseconds at or above which a trace is always retained. Default: `1000`. |
| `LOG_LEVEL` | No | Shared JSON-log threshold: info, warn, error, or silent. Unset or unrecognized values emit all supported levels. |
<!-- /generated:server-environment -->

Edge replicas are configured through `MERKUR_EDGE_*` variables documented in
[`apps/edge/README.md`](apps/edge/README.md); each replica's registration key is the exact per-id
entry from `EDGE_REGISTRATION_KEYS_JSON` and is never sent, and every replica verifies attach tickets
with the one deployment-wide `EDGE_ATTACH_TICKET_KEY`. STUN responders are configured through
`MERKUR_STUN_*` variables documented in [`apps/stun/README.md`](apps/stun/README.md), including the
two-address topology that direct-path verification needs. The daemon's `~/.merkur/config.json`
schema and its hardware identity custody (Secure Enclave on macOS, TPM 2.0 on Linux, or
`--identity-backend software`) are in
[`docs/security.md`](docs/security.md#sensitive-local-state-and-hard-cutover).

</details>
