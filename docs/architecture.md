# Architecture

The shape of Merkur in one page, for readers who want the whole picture before the detail.
Every section ends with the reference doc that holds the detail.

## The one invariant

The application server coordinates accounts, devices, presence, and short-lived session
issuance. It is never in the terminal hot path. Once a session exists, keystrokes and screen
updates flow between the client and the daemon on the user's machine; the server sees
neither. Everything else in the design follows from keeping that boundary intact.

## Components

| Component | Where | What it owns |
| --- | --- | --- |
| Browser app | `apps/web` | The SolidJS interface. The main thread owns UI and input; dedicated workers own transport, the terminal, and telemetry. |
| Terminal client | `apps/tui` | `merkur-tui`, opened by bare `merkur`. The UI reactor owns input, presentation and ANSI composition; each tab has a transport reactor for the shared Rust session, with a lazy graphics worker for host rasters. |
| Application server | `apps/server` | OPAQUE authentication, device links, presence, session issuance, push, installer delivery, box hosts, STUN tickets, and telemetry relay. Bun, Elysia, Effect, libSQL, Redis. |
| Daemon CLI | `apps/daemon` | Dispatches terminal-client commands and daemon management. `merkur daemon` supervises the dataplane and keeps the control link to the server. |
| Dataplane | `apps/daemon/dataplane` | The Rust process that owns the PTY, WebTransport, peer authentication, display encoding, acknowledgement and resync, forward error correction, input decoding, and NAT traversal. |
| Edge | `apps/edge` | A blind Rust WebTransport relay. It forwards sealed frames between a client and a daemon and cannot read them. |
| STUN responder | `apps/stun` | A ticketed reflexive-address responder used for the direct path. Every rejection is silence. |
| Box host | `apps/server/src/services/box-host-service.ts` (client) | An external service at `BOX_HOST_URL` that owns container lifecycle. A box is the same daemon inside a container; it adds no transport, auth path, or data plane. |

`packages/merkur-client` is the sans-IO Rust session and viewer core: events go in,
actions come out, and the host supplies time, randomness and I/O. The native adapter
(`packages/merkur-client-native`) owns WebTransport, HTTPS, account events and OS path hints.
The shared Rust packages own authorization, identity custody, wire records, ML-KEM and Noise,
the terminal model, display codec, error correction and graphics. TypeScript owns the app,
browser adapters, server contracts, daemon coordination and on-screen keyboard. The README's
workspace layout lists each package.

## A session, end to end

1. **Sign in.** A browser or terminal client authenticates with OPAQUE, so the server never
   holds a password or a password-equivalent. Each client receives its own root-signed
   delegation and keeps it locally. Account registration stays in the browser.
2. **Link a machine.** The daemon registers once and then keeps a persistent authenticated
   WebSocket to the server. That link carries registration, heartbeat, and session commands
   only.
3. **Open a terminal.** The server issues a short-lived session capability signed with
   ML-DSA-87 and hands both sides the same edge address. Its part is now over.
4. **Meet at the edge.** Client and daemon each open a WebTransport connection to the edge.
   They run an ML-KEM and Noise handshake through it, so the keys that protect the session
   exist only in the client and the daemon. The edge splices two sealed streams together.
5. **Try the direct path.** Both sides gather candidates through the ticketed STUN
   responder and attempt a direct WebTransport connection. If it wins, traffic leaves the
   edge; if not, the relay stays, and either way the server is not involved.
6. **Type and see.** The client sends input records; the daemon encodes them for the
   terminal. The dataplane encodes screen changes as row-level display frames, tracks
   which rows the client has acknowledged, repairs loss with selective retransmission and
   forward error correction, and never coalesces against a clock. The browser presents through
   WebGPU; the terminal client composes the presented cells through the host terminal's ANSI
   and Kitty graphics protocols. Display grants follow the host's presentation signal.
7. **Feel local.** With shell integration installed, the daemon grants speculative echo at
   the prompt boundary, so typed characters appear before the round trip completes and
   are reconciled against the authoritative screen when it arrives.

## Where the detail is

| Question | Doc |
| --- | --- |
| Which processes run where, who supervises them, how they talk | [Processes](processes.md) |
| The control link, session establishment, the edge, the direct path, the wire | [Transport](transport.md) |
| The rules the display path must keep | [Display invariants](display-invariants.md) |
| Inline images and the graphics protocol | [Graphics](graphics.md) |
| Trust boundaries, key custody, and what an attacker at each position can do | [Security](security.md) |
| How the hot path is designed and how its claims are measured | [Performance](performance.md) |
| Logs, spans, metrics, and health | [Observability](observability.md) |
| Building, testing, and running the stack locally | [Development](development.md) |
| Signing, releases, and rollout | [Releases](releases.md) and [CI](ci.md) |
