# WebTransport iOS real-device harness

An isolated device harness that measures whether a native `WebTransport` session drained
inside a Web Worker drops burst-tail datagrams on a real iPhone. It exercises a direct path
and a single dumb UDP relay while the JavaScript main thread is under synthetic CPU and
layout load, the condition behind the iOS stale-character failure mode that
`docs/transport.md` describes. Desktop automation cannot establish Safari's real-device
datagram drain behaviour, so this page is run by hand on a phone.

The harness is not wired into any app build. The echo server is a standalone cargo crate
with its own empty `[workspace]`, so it never joins the Merkur workspace and
`bun run rust:check` does not see it. The `worker/*.ts` files are checked by Biome and
`bun run check:files`.

## Layout

```
spikes/webtransport-ios/
  echo-server/        standalone Rust crate `wt-echo-server`
    Cargo.toml        own [workspace], isolated from the repo workspace
    src/main.rs       wtransport 0.7 echo server; prints its base64 cert hash
  worker/             dependency-free browser harness (native ESM)
    drain-worker.ts   Web Worker: opens WebTransport, drains datagrams, counts drops
    main.ts           UI controller and main-thread load hammer
    index.html        on-screen readout
    serve.ts          Bun dev server; transpiles .ts on request, optional HTTPS
```

## Prerequisites

- The Mac and the iPhone on the same Wi-Fi LAN. `ipconfig getifaddr en0` prints the Mac's
  LAN IP; the examples below use `192.168.1.42`.
- Bun and a Rust toolchain on the Mac.
- An iOS Safari build that exposes `WebTransport` in a secure context. Check
  `typeof WebTransport === 'function'` on the device.
- A secure context for the page. `http://localhost` counts on the Mac; the iPhone needs the
  page over HTTPS.

## Run the echo server

```sh
bun run spike:ios:server
```

It binds UDP port `4433` (override with `WT_ECHO_PORT`) and prints a base64 SHA-256
certificate hash. That hash is the `serverCertificateHashes` value the browser pins. The
certificate is self-signed and regenerated on every restart, so copy the hash again after
each restart. The server echoes every datagram and every bidirectional-stream frame
straight back, so the worker can compare received against expected sequence numbers and
measure round-trip latency.

## Serve the page

On the Mac, for a first check over plain HTTP:

```sh
bun run spike:ios:web
# -> http://localhost:8088/
```

Open the page, paste the cert hash, set the URL to `https://127.0.0.1:4433/` and start.

For the iPhone, generate a certificate for the Mac's LAN IP and serve with it. `serve.ts`
reads `WT_PAGE_TLS_CERT`, `WT_PAGE_TLS_KEY` and `WT_PAGE_PORT` (default `8088`):

```sh
mkcert 192.168.1.42        # after `brew install mkcert` and `mkcert -install`

WT_PAGE_TLS_CERT=192.168.1.42.pem \
WT_PAGE_TLS_KEY=192.168.1.42-key.pem \
WT_PAGE_PORT=8088 \
bun run spike:ios:web
```

Trust the mkcert root CA on the iPhone (install `rootCA.pem` from `mkcert -CAROOT` as a
profile under Settings, General, VPN & Device Management, then enable it under Settings,
General, About, Certificate Trust Settings). Only the page load needs a trusted CA; the
WebTransport session is pinned by hash. Open `https://192.168.1.42:8088/` in Safari on the
phone.

## Scenario A: direct

The phone connects straight to the echo server on the Mac. In the harness set the WT URL to
`https://192.168.1.42:4433/`, paste the echo server's hash, leave **Hammer main thread**
checked and start the burst test. A clean run shows `dropped = 0`, `max gap = 0` and low
p50/p95.

## Scenario B: dumb UDP relay

A trivial UDP pass-through sits between the phone and the echo server. It does not
terminate QUIC or TLS; it forwards UDP payloads and keeps a per-client return mapping, so
the browser still pins the echo server's hash. This is not Merkur's edge topology: the
edge, Merkur's blind relay, terminates two separate WebTransport sessions and splices
opaque application frames between them. The scenario only measures whether the worker
drain survives an extra opaque UDP hop and any impairment configured on it.

Run the forwarder on a second machine, or on the same Mac on another port:

```sh
# Relay host: forward UDP :5533 -> echo server at 192.168.1.42:4433
socat -T120 \
  UDP4-RECVFROM:5533,fork,reuseaddr \
  UDP4-SENDTO:192.168.1.42:4433
```

In the harness set the WT URL to `https://<relay-host-ip>:5533/` and keep the echo
server's hash. A relay on a real network hop, or one with injected loss (`dnctl`/`pfctl`
on macOS, `tc netem` on Linux), makes the comparison meaningful; loopback does not.

## Reading the readout

| Field | Meaning |
| --- | --- |
| `state` | connecting, running, done or error |
| `sent` | datagrams the worker has sent |
| `received` | distinct echoed datagrams seen, by sequence number |
| `dropped` | missing sequence numbers from zero through the highest received sequence |
| `max gap` | longest missing run in that same range |
| `p50` / `p95` | round-trip datagram latency percentiles |
| `timer installs` | calls through the worker's patched JavaScript timer globals; harness scheduling uses saved unpatched functions, and browser-internal WebTransport timers are not visible |
| note | last status or error string |

`dropped` and `max gap` turn green at 0 and red otherwise. The **Hammer main thread**
checkbox drives a synthetic CPU burn and a forced layout reflow on every animation frame;
toggling it should not change loss. The harness does not exercise Merkur's reliable
display path or the edge's application-level splice.

## Known limitation

`computeDrops()` in `worker/drain-worker.ts` scores only sequence numbers up to the highest
one received, so a trailing burst that never returns is not counted as dropped, even in the
final snapshot.
