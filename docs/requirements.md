# Requirements

Merkur runs on current browser and OS releases. A session needs WebGPU, WebTransport,
SharedArrayBuffer, and WebAssembly SIMD in the browser: there is no software renderer, no
WebSocket fallback, and no scalar WASM build behind them.

## Browser

| Browser | Minimum version | Notes |
| --- | --- | --- |
| Chrome, Edge | 113 | Windows, macOS, and ChromeOS. On Linux, WebGPU depends on the GPU driver; `chrome://gpu` reports whether it is enabled. |
| Chrome on Android | 121 | Android 12 or newer on a Qualcomm or ARM GPU, the set Chrome enables WebGPU for. |
| Safari on macOS, iOS, iPadOS | 26.4 | WebGPU shipped in 26, WebTransport in 26.4. On macOS that is Tahoe 26.4 or newer. |
| Firefox on Windows | 141 | |
| Firefox on macOS | 145 | Apple Silicon on macOS 26. Firefox has no WebGPU on Linux or Android yet. |

Chromium is the browser the end-to-end suite gates; the others meet the feature floor below. A
version number alone cannot prove WebGPU, because a browser can expose the API and still refuse a
device on a blocklisted GPU or driver.

| Required feature | What depends on it |
| --- | --- |
| Secure context and cross-origin isolation | The server's COOP and COEP headers, without which `SharedArrayBuffer` is unavailable. |
| `WebTransport` with `serverCertificateHashes` | Both terminal paths: the edge relay and the direct daemon connection pin self-signed certificates by hash. |
| WebGPU on an `OffscreenCanvas` in a worker | The terminal renderer. Unsupported WebGPU fails explicitly; there is no second renderer. |
| `SharedArrayBuffer` and `Atomics` | The fixed rings between the main thread, the transport worker, and the terminal worker. |
| WebAssembly SIMD (`simd128`) | `term-wasm` and `e2e-wasm`, which ship one SIMD lane with no scalar dispatch. |
| Module workers | The transport worker and the terminal worker. |
| WebCrypto HMAC-SHA-512 and `crypto.getRandomValues` | Upgrade proofs and browser key material. |
| `navigator.locks` | Token refresh shared across tabs. |

EditContext (Chrome 121 and newer), WebTransport datagrams, and push notifications in an installed
PWA are optional. Without them a session uses a `<textarea>` editing surface, reliable streams, and
no terminal-bell notification.

## Machine running the daemon

| Requirement | Value |
| --- | --- |
| macOS | 13 (Ventura) or newer, Apple Silicon or Intel. |
| Linux | glibc 2.36 or newer and kernel 5.1 or newer, 5.6 recommended. Debian 12, Ubuntu 24.04, and Fedora 37 clear that floor; Ubuntu 22.04 (2.35), RHEL 9 and Amazon Linux 2023 (2.34), and musl distributions such as Alpine do not. |
| CPU | Apple Silicon, arm64, or an x86-64 with AVX2: Intel Haswell (2013) or AMD Excavator and newer. The Rust dataplane's own floor is SSSE3; AVX2 is what the compiled Bun CLI requires. |
| Service manager | launchd on macOS, or a systemd user session on Linux, where the installer enables lingering so the daemon survives logout. |
| Network | Outbound HTTPS and WSS to the server, and outbound UDP for QUIC. Terminal traffic never falls back to TCP. |
| Hardware-bound identity | A Secure Enclave on macOS 14 or newer, or a TPM 2.0 at `/dev/tpmrm0`. Without either, `merkur link --identity-backend software` accepts software custody explicitly. On macOS 26 and newer the enclave also holds the ML-DSA-87 key. |

Windows is not supported and the installer refuses it. To check a Linux machine before installing:

```sh
ldd --version | head -1                      # glibc 2.36 or newer
uname -r                                     # 5.1 or newer
grep -qw avx2 /proc/cpuinfo && echo 'avx2'   # x86-64 only
```

On an Intel Mac, `sysctl -n machdep.cpu.leaf7_features` must list `AVX2`.

[Install and link a machine](../README.md#quickstart).
