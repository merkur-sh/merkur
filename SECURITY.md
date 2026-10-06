# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/merkur-sh/merkur/security/advisories/new)
("Report a vulnerability" on the Security tab). Do not open a public issue.

Include what you found, how to reproduce it, and the version (`merkur version`, or the web
build shown in Settings). You will get an acknowledgement within a few days; fixes ship as a
normal signed release, and the advisory is published once that release is out.

## Supported versions

Only the latest release is supported. Merkur has a single version with no compatibility
window: daemons update through the signed updater, and the hosted server and web app are always
the current build.

## Scope

In scope: the web app, server, daemon and its Rust dataplane, the WebTransport edge, the STUN
responder, the installer, and the release and deployment signing chain in this repository.

Out of scope, by design (see [Security Non-Goals](docs/security.md#security-non-goals)):
a compromised browser profile, daemon host, or local shell; a daemon host the attacker controls
and the account owner linked; traffic analysis and denial of service by infrastructure on the
path; and account takeover through an already exposed password, refresh cookie, or live browser
delegation.

## Threat model in brief

- **Terminal contents are end to end.** Browser and daemon run a one-use ML-KEM-1024 bootstrap
  and then ChaCha20-Poly1305 through Noise. The server issues short-lived ML-DSA-87 session
  capabilities but never sees terminal keys or plaintext, and the WebTransport edge splices
  sealed frames blindly.
- **The password never leaves the browser.** Accounts use OPAQUE. The OPAQUE export key unlocks
  an ML-DSA-87 user root generated in the browser, only long enough to create a browser
  delegation or approve a daemon link.
- **The server cannot substitute a machine.** Linking needs a one-use account token (the copied
  command) and a secret the daemon prints as a link or QR code, which reaches the browser without
  passing through the server. The browser verifies the daemon's claim against that secret before
  the user root signs the binding.
- **Daemon identity is hardware-bound where the host allows it:** Secure Enclave on macOS, TPM on
  Linux, paired with an ML-DSA-87 key.
- **Releases are signed by protected CI.** Every daemon artifact is covered by an ML-DSA-87 manifest
  with a monotonic sequence and a durable rollback floor.

The full model, including trust boundaries and what each component can observe, is
[docs/security.md](docs/security.md).

## Release key

The first install is trust on first use: it trusts HTTPS to the server and to GitHub for the
initial binary and its compiled-in release public key. Every update after that is verified
against the key. Compare the fingerprint the installer prints (or `merkur release-key`) with:

```
733e336c becc7559 82591288 a138b3e3 6f74e40e ac916431 cf355b10 c234f059
```

This is the SHA-256 of the 2,592-byte ML-DSA-87 public key. If they differ, do not link the
machine, and report it.
