# merkur-keyd

keyd holds the keys the application server uses but must not hold: the OPAQUE server setup,
the ML-DSA-87 key that signs session capabilities, and the web-push VAPID key. The server
parses untrusted input, so it reaches them only through keyd's Unix socket, as a fixed set of
operations. Taken over, the server can ask keyd for an operation; it cannot take a key away,
and every password guess it asks for spends the account's attempt budget.

## Operations

The socket protocol is `apps/keyd/src/wire.rs`, mirrored by
`apps/server/src/services/keyd-protocol.ts`; `key-service.keyd.test.ts` pins the two together
against the real binary.

| Operation | What keyd does |
| --- | --- |
| Public keys | Answers the OPAQUE server key, the capability verification key daemons pin, and the VAPID key, if any. |
| Auth start | Spends one attempt for the account, then answers OPAQUE's login response and registration response for the one sign-in-or-sign-up exchange. A missing record takes OPAQUE's fake-record path. |
| Registration response | Spends one attempt, then answers a password reset's registration response. |
| Login finish | Answers whether the password was right; a right one hands the account's attempt back. |
| Sign capability | Signs a session capability (`merkur-authorization`'s `parse_session_capability`, the payload the daemon verifies) whose issue time is within 30 seconds of keyd's clock, so a taken-over server cannot bank capabilities. |
| VAPID JWT | Signs an RFC 8292 JWT for one https push-service origin, valid 12 hours. |

## Attempt budget

Every OPRF evaluation under an account's key is a password guess to whoever holds the answer,
so keyd counts them itself, per account id: at most 10 in any minute and 20 not handed back in
any 24 hours. A verified sign-in hands its attempt back. A refusal carries how long until the
next attempt is allowed, which the server answers as `429 attempts_exhausted` with
`retry-after`.

The count is an append-only log in keyd's state directory, fsynced before each answer and
replayed at start, so neither a restart nor a crash resets it. A torn final record is
dropped; any other damage stops keyd from starting. It names accounts by a domain-separated
SHA-256 digest of their id, and
tracks at most 1,048,576 accounts at once: at that bound a new name is refused rather than an
old entry evicted, since eviction would hand a caller a way to reset an account's count.

## Running it

keyd takes no arguments. systemd hands it three things (`deploy/app/merkur-keyd.service`):

- `$CREDENTIALS_DIRECTORY`: `opaque-server-setup`, `session-token-mldsa87-seed` and, with web
  push, `web-push-vapid-private-key`, each canonical unpadded base64url, one trailing newline
  allowed;
- `$STATE_DIRECTORY`: the attempt log;
- `$MERKUR_KEYD_SOCKET`: the socket, which keyd makes mode 0660 for its group.

Before it reads a key, keyd disables core files and, on Linux, makes itself undumpable and
locks every page it holds (`mlockall`, so the unit raises `LimitMEMLOCK`). Logs go to stderr;
stdout carries one line, `keyd: listening`, once the socket accepts, which the installer and
the development scripts wait for.

`bun run dev` provisions development keys in `apps/server/data/keyd/` and starts keyd beside
the server (`scripts/keyd.ts`). The server's tests run the real binary through
`apps/server/src/services/keyd-test-support.ts`, one keyd per test with its own attempt log.

## Verifying

```bash
bazel test //apps/keyd:unit
bazel test //apps/server:src/services/key-service.keyd.test
```
