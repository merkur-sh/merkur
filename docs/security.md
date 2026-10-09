# Merkur Security Model

Merkur protects the contents of a terminal between an authorized client and a daemon
linked to the account. This document is the threat model: who is trusted with what, how each
credential is made and revoked, and what the design deliberately does not cover. The trust split
is this. The application server runs the account, the device list, presence, and short-lived
session issuance. It never holds a password, a user-root seed, a client delegate seed, a daemon
identity seed, or a terminal key, so a compromised server database or session signer cannot forge
a user signature, impersonate a daemon, or decrypt a terminal. The edge (Merkur's blind relay)
splices ciphertext it cannot read. Only the browser profile or native terminal client and the daemon
see terminal plaintext.

The account owns an ML-DSA-87 user root generated in the browser. Password authentication uses
OPAQUE, and the OPAQUE export key unlocks an encrypted copy of that root only long enough to create
a browser delegation or approve a permanent daemon link. Normal browser use relies on a
fixed, 30-day ML-DSA-87 delegation stored in that browser profile; it does not ask for the password
again after a reload or phone restart. Each terminal connection runs a fresh, one-use ML-KEM-1024
bootstrap, and terminal traffic is ChaCha20-Poly1305 through Noise. Post-quantum work happens at
setup, never in the per-frame input, display, ACK, FEC, or render path. This is a scoped
terminal-session construction, not a claim that the whole web product is quantum proof.

Contents:

- [Trust Boundaries](#trust-boundaries)
- [Accounts: OPAQUE And The User Root](#accounts-opaque-and-the-user-root)
- [Browser Delegations](#browser-delegations)
- [Logout, Revocation, And Presence](#logout-revocation-and-presence)
- [Linking A Daemon](#linking-a-daemon)
- [Hardware-Bound Daemon Identity](#hardware-bound-daemon-identity)
- [Native Client Credentials](#native-client-credentials)
- [Daemon Management Proofs](#daemon-management-proofs)
- [Session Establishment](#session-establishment)
- [Carrier Rebind](#carrier-rebind)
- [Post-Quantum Claim And Limits](#post-quantum-claim-and-limits)
- [Rate Limiting And Trusted Proxies](#rate-limiting-and-trusted-proxies)
- [Sensitive Local State And Hard Cutover](#sensitive-local-state-and-hard-cutover)
- [Speculative Echo And The Prompt Boundary](#speculative-echo-and-the-prompt-boundary)
- [Links And Opening URLs](#links-and-opening-urls)
- [Terminal Effects](#terminal-effects)
- [Metadata And Telemetry](#metadata-and-telemetry)
- [Release Trust](#release-trust)
- [Repository And Dependency Protection](#repository-and-dependency-protection)
- [Repository Secret Scanning](#repository-secret-scanning)
- [Security Non-Goals](#security-non-goals)

## Trust Boundaries

Every component is trusted for one job. The table says what each can observe or retain if it is
compromised.

| Component | Trusted for | Can observe or retain |
| --- | --- | --- |
| Application server | OPAQUE execution, account policy, delegation checks, refresh rotation, device ownership, presence, session allocation, capability signing, revocation delivery | OPAQUE records; the public user root and its encrypted envelope; delegation certificates and revocations; daemon public identity and binding; account, IP, timing, and bootstrap metadata. Never a password, seed, or terminal key. |
| Browser origin and profile | Password entry, OPAQUE client work, root unlock, delegation storage, one-use ML-KEM state, terminal decryption, rendering, input | The selected account and terminal. A profile with a live delegation is a trusted device until its fixed expiry unless revoked. |
| Native terminal client | Password entry, OPAQUE client work, root unlock, sealed delegation storage, one-use ML-KEM state, terminal decryption, ANSI rendering and input | Its selected account and terminal. The local OS and host terminal are trusted with input and output; its delegation has the same fixed expiry and revocation rules as a browser's. |
| Daemon control service | Authenticating the daemon's persistent WSS connection and delivering session and revocation commands | Daemon identity, command contents, timing. Never terminal frames or delegate secrets. |
| WebTransport edge | Admitting only server-ticketed carriers, matching browser and daemon carriers, and splicing bounded frames | The deployment attach-ticket key; rendezvous id, role, daemon id, sizes, timing, and the plaintext capability, ML-KEM, and Noise signaling. Never terminal plaintext or keys. |
| Daemon and Rust dataplane | Permanent identity, user-root binding, delegation tombstones, bootstrap and Noise state, PTY contents, local shell access | The attached terminal and the authorization objects needed to admit it. |
| Image worker | Untrusted image decoding, with no publication authority | One job's encoded input and decoded pixels. A separate executable under Linux seccomp or macOS Seatbelt with a fixed memory arena and bounded pipes; no keys, identity, paths, or unrelated descriptors ([native image API](native-images.md)). |
| STUN responder | Authenticated NAT mapping observations. It keeps no per-source state and originates no connection | The deployment ticket key, daemon endpoints, and probe timing. No account, delegation, session, Noise, or terminal material. |

"Blind" describes the edge's relation to terminal content, not to identity or activity. The
signaling it forwards names the account, delegation, daemon, and session, and its timing
observations are the traffic-analysis surface disclaimed under
[Security Non-Goals](#security-non-goals). Nothing it sees lets it authorize, substitute, or decrypt.

The edge does check admission. Every routing preface carries a server-signed attach ticket, and
an unticketed or forged peer is closed before it holds a splice slot, so the relay carries only
sessions the server issued for a machine still linked to an account. A daemon's ticket names its
daemon and expires 90 s after issue; one rides every control lease, so an unlinked daemon, or one
whose control connection is down, stops being admitted within a lifetime. A browser's ticket
names its session and daemon and never expires, because renewal and rebind reach the edge
without the server; it admits nothing without a live daemon ticket for the same daemon. A ticket
is admission, not authority: it grants no session and replaces none of the checks above. A
leaked deployment key would let its holder relay through the edge, and nothing more.

The server also serves the browser application. A compromised database or signer alone cannot forge
a user-root signature or a delegate proof. Malicious same-origin JavaScript can: it can capture a
password as typed, ask the stored non-extractable key to decrypt the delegate, and read terminal
plaintext after the client decrypts it. First-load origin integrity is therefore a decisive
boundary; [Release Trust](#release-trust) narrows it without removing it. Display presentation
hints inside the display ciphertext can postpone a GPU submission by at most one frame interval and
cannot suppress a row, advance an ACK, authorize a repair, or extend speculative echo.

## Accounts: OPAQUE And The User Root

The password unlocks the account root. It is never a terminal key, and the server never learns it.

Login and registration are distinct two-phase OPAQUE ceremonies behind one form. The browser sends
both client-start messages to `/api/auth/start`; the server answers both branches with one flow id
and the same response shape, using the OPAQUE fake-record path and secret-HMAC-derived synthetic
material for an unknown username, so repeated starts cannot reveal whether an account exists. A
valid OPAQUE login result selects `/api/auth/login/finish`; only the client's explicit no-login
result selects `/api/auth/register/finish`, and no error switches ceremonies. The flow is consumed
atomically on the first finish. With `AUTH_ALLOW_REGISTRATION` off, every registration finish
answers `registration_closed` without consulting account existence, because a wrong password on an
existing account also reaches that finish and an existence-dependent refusal would enumerate
usernames.

`AUTH_IDENTITY` names what an account is keyed by; the `users.username` column holds either. Under
`username` it is any 3-254 character name, trimmed and lowercased. Under `email` it is an address,
syntax-checked, lowercased, its domain in ASCII form, and no account exists until the address has
proved it receives mail. The browser learns the mode from `GET /api/auth/policy` before it shows the
form. On the registration branch the browser seals the root envelope, then calls
`/api/auth/register/code` with the flow id. The server extends the flow to ten minutes and records a
six-digit code as `HMAC-SHA-256(TOKEN_HMAC_SECRET, "merkur-email-code" ‖ flowId ‖ code)`, so a
Redis read yields nothing that finishes a registration and a code is worthless outside its flow. A
new address is mailed the code through Resend; an address that already has an account is mailed a
notice that its password was wrong, and its flow records a code nobody was sent. The two answers
are the same response, one send each, so the code step does not enumerate addresses either.
`/api/auth/register/finish` then carries `emailCode`: attempts are counted before comparison, the
sixth destroys the flow, and a wrong code is `invalid_email_code` while the flow stays open.
Nothing beyond syntax is checked before the send: whether the mailbox exists is settled by the code.

Client registration and login use Argon2id with 64 MiB, six iterations, four lanes, and
the OPAQUE library's fixed salt (`OPAQUE_PASSWORD_STRETCHING`). Every stored registration
record and root envelope is derived through it, so changing it is a hard cutover of every
account: each record is re-registered and its root rewrapped with the owner's password, or
the account is wiped. Browser password stretching runs in a separate worker per finish;
success, failure, or cancellation terminates that realm. The transferable export
key has one mutable owner. Native stretching owns and wipes the Argon2 workspace and its
input buffer. These account operations never run on the terminal frame path. Worker
termination and buffer wipes do not guarantee erasure of every browser-private copy or
immutable password string.

The server stores an OPAQUE registration record bound to the user id and server origin, not a
password hash. The record plus the server setup are still offline-guessing material, so password
strength matters. The browser pins the server public key as `VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY`;
startup requires `OPAQUE_SERVER_SETUP` with its matching `OPAQUE_SERVER_PUBLIC_KEY` and compares
the compiled pin with the setup before migrations, so a stale image fails closed.

The composition root supplies that immutable artifact pin separately from the Effect
configuration provider; runtime `VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY` overrides cannot
replace a pin compiled into the executable. Text credentials and credential-bearing Redis
URLs remain Effect `Redacted` values in typed server configuration and are revealed when
constructing the IO or cryptographic adapter. Local supervisors give Vite only public
build inputs and its explicit proxy destination. Configuration source diagnostics contain
key names and ownership only. Local setup preserves durable identity and atomically
persists a validated environment with mode `0600`.

At registration the browser also:

1. generates a random 32-byte ML-DSA-87 user-root seed;
2. derives its public key and the commitment `SHA-512("merkur-user-root-key\0" || rootPublicKey)`;
3. derives a non-extractable AES-256-GCM envelope key from the 64-byte OPAQUE export key with
   HKDF-SHA-512, bound to the user id and server origin; and
4. uploads only the root public key and the AES-GCM root envelope.

A password login reuses a valid local delegation bound to the same user root and epoch
without decrypting the root envelope. Creating a fresh delegation wipes the export key
after envelope opening and the root seed immediately after signing, before vault writes or
subsequent network waits. Registration wipes both after sealing the envelope; a password change
wipes them after resealing it, before session enumeration or the mutation request.

The password is required to create a client delegation and approve a daemon link. Native account
management also requires a fresh root unlock before rename, unlink or session revocation.
A password change (Settings, Account) requires the current password and an active
local delegation; one combined OPAQUE exchange authenticates the old password and registers the new
one, and the browser rewraps the same root seed under the new export key. The authenticated
`/api/auth/password` finish atomically replaces the record and envelope, revokes every other active
browser, queues daemon revocation delivery, and replaces all refresh credentials with one for the
current browser. Auth-start flows are one-use, expire after two minutes, and carry a fingerprint of
the OPAQUE record that completions recheck, so a password change also invalidates logins started
against the old credential.

There is no server-side root recovery: a root seed whose password is lost stays sealed. Changing a
leaked password stops further logins and revokes other browsers, but cannot recover a root seed an
attacker already extracted through a successful login. A lost password and a compromised root have
the same remedy, destructive reprovisioning: a new root, new browser state, and new daemon links.
[Password Reset](#password-reset) is that reprovisioning.

### Password Reset

A password reset gives the holder of the account's mailbox the account under a new password and a
new user root, and nothing the old root authorized. It exists only under `AUTH_IDENTITY=email`:
a `username` server has proved no mailbox, so its four reset routes answer `invalid_request` and
its form offers no reset.

The mailbox cannot reach a terminal. Every daemon binding and browser delegation is signed by the
root being discarded, and the reset destroys them rather than carrying them over. What it can do is
bounded and named to the user before it happens: sign out every browser, unlink every machine, and
delete every hosted box with its files. A machine's shells keep running and it is linked again
under the new root; a box has no other way in, so it is not kept.

1. `POST /api/auth/reset/code` takes the address and opens a ten-minute flow. An address with an
   account is mailed a six-digit code, stored as
   `HMAC-SHA-256(TOKEN_HMAC_SECRET, "merkur-password-reset-code" ‖ flowId ‖ code)`; an address
   without one is mailed a notice and its flow records a code nobody was sent. The response is a
   flow id either way, one send each, so the form does not enumerate addresses.
2. `POST /api/auth/reset/verify` counts the attempt before comparing, and the sixth destroys the
   flow. A match consumes the mailed-code flow and returns a new flow id, which names the proven
   reset, with the machines and boxes the reset will destroy. Only a proven mailbox sees that list.
3. `POST /api/auth/reset/start` answers the OPAQUE registration for the new password with the
   epoch the new root's first delegation must name, the stored `root_epoch` plus one, and the
   delegation's fixed validity.
4. `POST /api/auth/reset/finish` consumes the proven flow and applies the reset in one transaction.

The flow records the account's OPAQUE record fingerprint and root epoch when the code is requested,
and the transaction replaces the credential only on a row that still matches both, so a password
change or another reset in between leaves the flow with no authority. It then replaces the record,
root public key, commitment and envelope and increments `root_epoch`; deletes every browser
delegation, refresh token, revocation record, linked daemon, pending link claim, link token and
push subscription; and records the account's boxes in `box_removals`, from which the server
destroys them. A box another account's device also names is left alone. The account row,
`box_access`, `keyboard_settings` and `users.privileged_at` are kept. The session issued for the new
delegation refuses a suspended account, which rolls the whole reset back, and calls off a scheduled
erasure.

After the commit, open browsers receive `browser-session-ended`, the account's revocation
generation is incremented so connected daemons evict their live peers, and the address is mailed a
notice. A daemon that is offline keeps no way back in: its row is gone, so its control proof fails
and no session can be issued for it.

Sign-in, sign-up and reset flows share one key space and each names its kind; a finish consumes the
id it is offered and accepts only its own kind, so a reset flow id completes no sign-in and the
reverse.

## Browser Delegations

A delegation is what lets a browser profile act for the account without the password: a delegate
key the browser generates locally plus a certificate the user root signs over it.

```text
{userId,rootKeyCommitment,delegationId,delegatePublicKey,
 scopes:["terminal-session","session-revoke"],serverOrigin,
 rootEpoch,issuedAt,expiresAt,signature}
```

The signature uses the FIPS 204 context `merkur-browser-delegation`. Validity is exactly 30 days
(`USER_DELEGATION_LIFETIME_MS` in `packages/shared/src/user-authorization.ts`) and does not slide:
refreshing a token, reloading, or restarting a phone does not extend it. The server permits at most
32 active delegations per account.

| Credential | Lifetime | Bound to |
| --- | --- | --- |
| Delegation certificate | 30 days, fixed | User root, delegate key, server origin |
| Access token (HMAC-SHA-512) | 15 minutes | Delegation id |
| Refresh cookie family (HttpOnly, rotating) | Until the certificate expires | Delegation id |

The browser stores one active delegation in the `merkur-auth` IndexedDB database, the 32-byte
delegate seed AES-256-GCM encrypted under a non-extractable `CryptoKey` in the same profile. The
refresh family's absolute expiry is the certificate expiry, so rotation cannot slide the 30-day trust window.

The trust is scoped to a browser origin and profile, not to a PWA installation, a handset, or a
hardware key. Clearing site data removes the delegation and requires the password again.
`CryptoKey.extractable === false` stops ordinary export, but code running with the origin's
authority can call `decrypt`; the envelope protects against database-file inspection, not XSS.

## Logout, Revocation, And Presence

Revocation exists so a lost browser can be cut off from any other browser, and so the daemon can
enforce that cut without trusting the server to keep enforcing it.

The Sessions tab lists the account's unexpired delegations and can revoke one or all others. Each
row is named from the issuing request's user agent by `@merkur/user-agent`; the name is written once
and carries no authority. "Active" means an authenticated event connection is open, not that someone
is typing; presence never extends a delegation or authorizes access.

The current delegate signs a canonical statement under `merkur-delegation-revocation`:

```text
{userId,rootKeyCommitment,actorDelegationId,
 targets:[{delegationId,expiresAt},...],issuedAt,nonce,signature}
```

The server verifies the actor certificate, signature, exact target set, and replay nonce in one
transaction, marks the targets revoked, removes their refresh families, and appends one durable
outbox item per linked daemon and a browser-notification intent. Redis publication follows the
commit through a scoped worker; pending intents survive interruption, Redis failure and account
erasure. Repeated notifications invalidate exact delegation IDs and are safe to replay.
Access-token verification consults the delegation row, so an
unexpired bearer stops working at once. Every replica sends `browser-session-ended` to the affected
connections and closes them; the account's other browsers receive `browser-sessions-changed`. A
browser receiving that event or a definitive refresh rejection tears down its terminal, clears that
one delegation, and returns to login with a "Session ended" dialog. Network failures do not.

Explicit logout is self-revocation. The browser signs its own target, keeps only the public
certificate and signed statement as an offline tombstone, deletes the usable delegate before network
delivery, and retries the tombstone before any later refresh or login.

The daemon receives each statement as a `delegation_revoke` control command. The Rust dataplane
verifies the actor certificate and statement, records the tombstone, and evicts affected live,
dialing, and parked peers; the Bun daemon persists the merged set in `~/.merkur/config.json` before
acknowledging. The server replays pending outbox entries when a daemon reconnects, before it becomes
session-ready, and backfills a newly linked daemon with every statement that still has a live
target.

Revocation is not instantaneous when the daemon is offline, and a malicious server can delay or
suppress delivery: an already active direct terminal can continue until its daemon receives the
statement. Once persisted, a tombstone rejects that delegation's proofs even if a hostile server
later replays old session material. Merkur claims no revocation channel independent of the server.

## Linking A Daemon

Linking establishes the permanent trust between an account and a machine. The daemon proves it
holds a fresh identity, and the browser, holding the unlocked root, signs a binding to exactly that
identity. The server brokers the exchange and cannot substitute a different daemon.

The browser offers one command, `curl -fsSL <origin>/install | MERKUR_LINK_TOKEN=<token> sh`,
which installs the daemon and runs `merkur link <origin>`. The five-minute, one-use link token rides
in the environment so `ps` cannot show it. It only lets the daemon open a pending claim, which is
what keeps device-code phishing out: a stranger's daemon cannot open a claim against an account
whose token it was never given.

1. The dataplane generates or reopens its permanent identity and commits to the public claim
   `{linkClaimId,daemonId,daemonIdentityPublicKey,daemonIdentityP256PublicKey,daemonIdentityKeyCommitment,name,platform,identitySealBackend}`
   with a fresh 32-byte link secret.
2. The daemon spends the link token to create a ten-minute server claim and prints the 256-bit
   out-of-band code `<linkClaimId>.<linkSecretBase64url>` as `<origin>/link#<code>`, and as a QR
   code. The fragment never reaches a server.
3. An authenticated browser opens that address, recomputes the commitment locally, and names the
   machine from the verified claim before asking for the password. A malicious server cannot swap
   in another identity without failing this check.
4. The OPAQUE root unlock signs a permanent binding under `merkur-daemon-binding` over the user,
   root commitment, daemon id, identity commitment, server origin, claim id, and issue time, and
   MACs the approval under the out-of-band secret.
5. The daemon polls, verifies the MAC, the root public key, the binding, and its exact local
   identity, writes its configuration, and completes the claim (`pending`, `approved`, `completed`).

The server never receives the raw link secret. It can refuse or delay a link but cannot replace the
identity the browser authenticated. Relinking the same lineage keeps the identity and tombstones.
No daemon API key exists.

An account links at most three machines of its own (`MAX_LINKED_MACHINES`). The server refuses the
approval of a fourth with `machine_limit_reached`, in the same statement that moves the claim to
`approved`, so two approvals racing at the limit cannot both pass. A machine counts once linked, or
while its approved claim can still complete; relinking a machine already on the account adds
nothing; a hosted box never counts. Machines linked before the limit existed stay linked. An account
with `users.privileged_at` set has no machine limit and is approved for hosted boxes without the
waitlist; an operator sets that column directly in the database, as with `suspended_at`, and no route
grants it.

The machine list shows the account's used slots and limit (or unlimited access), using
the same count as approval enforcement. At capacity the server returns no install/link
command; unlinking a machine refreshes the count and command in open machine lists.
Approved reservations count until they complete or expire. Hosted boxes are excluded.
The CLI reports account usage before displaying its approval link and QR code, and stops
with unlinking instructions when a new machine cannot fit. Relinking an existing machine
and linking a hosted box remain allowed by the claim flow at capacity.

## Hardware-Bound Daemon Identity

The daemon identity is what browsers and the server verify every time the machine speaks. Binding
half of it to hardware means a copied disk or a stolen seed file is not, on its own, the machine.

The identity is one fixed pair: a 2,592-byte ML-DSA-87 public key and a 65-byte uncompressed SEC1
P-256 public key, committed as
`SHA-512("merkur-daemon-identity-key\0" || mldsaPublicKey || p256PublicKey)`. Every identity proof
carries both signatures over the same transcript `T` and context `ctx`: ML-DSA with its FIPS 204
context and hedging entropy, P-256 over the prehash `SHA-256(ctx || u64le(byteLength(T)) || T)`
as canonical low-S `r || s`. The custody label is bound by the link-claim commitment; it is
self-reported metadata, not remote attestation.

Custody is one primitive, `KeyCustody` in `packages/merkur-identity-seal`, with the same shape on
every platform. Every custody holds the composite pair; a native client's delegate key uses the
same primitive and ignores its P-256 half. The stored label is `hardware` or `software`.

| Label | Selected when | Where the keys live |
| --- | --- | --- |
| `hardware` | A key chip answers: the Secure Enclave on macOS 14 and newer, a TPM 2.0 at `/dev/tpmrm0` on Linux | P-256 always in the chip. ML-DSA-87 in the chip when it can hold one (*resident*: the Secure Enclave from macOS 26); otherwise the chip seals a fresh 32-byte seed, bound to the P-256 public key, and the expanded key lives in locked memory (*sealed seed*: the Secure Enclave on macOS 14–25 with HPKE `P256_SHA256_AES_GCM_256`, info `merkur-key-custody-seal\0`; a TPM KEYEDHASH object under a deterministic owner-hierarchy primary, with no persistent or NV handles). |
| `software` | Only by explicit `merkur link <origin> --identity-backend software`; boxes always | The 32-byte seed; P-256 derives from it with HKDF-SHA-512 (info `merkur-daemon-identity-p256\0 || u32be(counter)`). Copying the material copies the identity. |

The chip's own answer at creation decides the variant, never an OS version, and the material pins
it: `chip || variant || field(P-256 key) || field(ML-DSA key or sealed seed) || SHA-256(all
before)`. The digest is checked before any chip parses a blob. CryptoKit traps on some corrupted
enclave ML-DSA blobs instead of throwing, and corrupted enclave blobs abort the per-user `ctkd`
agent; the digest turns corruption into a refusal. It is not authentication: a writer of the stored
material can already stop the daemon. Windows maps onto the same five chip operations through the
CNG Platform Crypto Provider and is not built.

The dataplane owns the identity CLI and its bounded signing worker; opening a stored identity uses
its pinned label and variant without probing or switching. A chip's signature of either half is
verified before it is returned, so a chip fault fails closed.

A failed or declined sudo and a non-interactive run are not consent to downgrade. Boxes select
`software` because an Incus software TPM is not host hardware isolation. The stored label is pinned:
startup never probes for an alternative, and failure to open it exits the dataplane with code 3 and
stops automatic restart. If the material is lost, `--replace-identity` creates a fresh daemon id and
requires a new root approval.

Hardware custody adds an independent possession requirement. A resident pair keeps both secrets
in the chip, so stealing either needs the chip. A sealed-seed pair does not make P-256 or the
sealing post-quantum: ML-DSA carries the proof's post-quantum unforgeability while its secret is
confidential, and after that secret is stolen the remaining hardware barrier is classical. Expanded
keys live in private `mlock` mappings, wiped before release, and the dataplane sets
`RLIMIT_CORE=0` before processing input. A single bounded signing worker keeps chip latency (an
enclave ML-DSA-87 signature measured 11.7 ms p50, 32.6 ms p99) off the terminal owner loop. The
`tpm-sim` build feature enables a raw TCP `swtpm` transport for test builds only. No custody
protects against active local compromise.

## Native Client Credentials

The native terminal client keeps its account in `~/.merkur-tui`, a directory owned by
its user with mode 0700. Its public record has mode 0600 and contains the origin,
OPAQUE server key pin, username, root public key, signed delegation and the delegate key's
custody (the same `KeyCustody` as a daemon identity). Sign-in creates that key in its custody
before the root certifies it, so no secret of it exists outside custody. Opening verifies the
certificate and that the custody holds the key it delegates to. Hardware failure never changes
the stored label; software custody requires an explicit choice. The client core holds no
delegate key: it asks the host to sign each session and renewal proof and verifies the answer
under the certificate before using it, and the native host signs on a blocking thread while the
session dials. Password entry disables echo and wipes the input buffers, and the
native executable disables core dumps before handling credentials. Growing password or input
buffers wipes the entire replaced allocation before it is freed; consumed input tails and
transient decoded text are also wiped. Headless password entry reads exactly through its line,
so the command stream after that line is not retained in a credential reader. Registration remains
in the browser; native sign-in creates a distinct, fixed-expiry account delegation.

On macOS, access and rotating refresh credentials live in a nonsynchronizing generic
password item in the user's login Keychain, named by the account directory's canonical path,
so removing an account never parses its record.
On Linux, those credentials are AES-256-GCM ciphertext in the account record, with a
key derived from the custody's sealed secret and the profile authenticated as additional
data. A descriptor lock serializes every process through refresh and durable publication;
record updates use a synced temporary file, atomic rename and directory sync. A waiter
reloads the successor instead of spending a rotating credential twice. Account replacement
or removal invalidates an older process's store. Logout signs the TUI's own revocation,
completes it on the server, then removes that account record and its Keychain item.
A record the client cannot parse or verify, or whose credentials or custody material are
missing or invalid, is removed with its credentials and reads as signed out, so the next
sign-in replaces it. Nothing local can use that delegation again; it stays listed until it
expires or a browser revokes it.
An authenticated account-revocation event retires all native transports and waits for
committed account operations before removing credentials and returning to sign-in.

Management reviews the exact machine identity or delegation before asking for a masked
password. OPAQUE unlocks only the stored account's pinned root and epoch; the root is held
only for that operation. Link approval signs the verified claim with it. Rename, unlink
and revocation require the same fresh unlock; session revocation then uses the current
delegation's signed revocation statement. Submitted account mutations complete through
their response even if their dialog closes.

## Daemon Management Proofs

Management traffic is how the daemon registers, heartbeats, and receives session commands. Every
request is signed by the linked identity, so a captured request never grants reusable authority.
Signing runs on the dataplane's blocking worker; Bun requests proofs over IPC and never expands an
identity key. HTTP and control signatures use distinct contexts, `merkur-daemon-http` and
`merkur-daemon-control`.

For the WSS control link, the server sends `{type:"auth_challenge",nonce}` with a fresh 32-byte
nonce owned by that socket; the daemon answers once with
`{type:"auth_proof",signature,p256_signature}` over the daemon id, configured public control URL,
build identification, resume presence id, and nonce. No presence claim, STUN credential, command,
or `registered` response is issued before verification, and registration waits for pending
revocation acknowledgements before the daemon becomes session-ready.

Each management POST signs the daemon id, method, complete public URL, content type, SHA-512 digest
of the exact body, millisecond timestamp, and fresh 32-byte nonce, carried in `x-merkur-daemon-id`,
`x-merkur-timestamp`, `x-merkur-nonce`, `x-merkur-signature`, and `x-merkur-signature-p256`. The
server hashes the bounded raw body before JSON parsing, derives the audience from its configured
public origin rather than forwarded host headers, verifies both signatures, and spends the nonce
atomically with Redis `SET NX PX` shared by all replicas. Redis errors fail closed.

| Limit | Value |
| --- | --- |
| WSS authentication deadline, including registration | 5 seconds |
| Pending WSS authentications per replica | 1,024 |
| WSS attempts per source IP / per daemon, per minute | 60 / 30 |
| Management body size | 4 MiB, no content encoding |
| Proof validity / permitted future skew | 60 seconds / 30 seconds |
| Nonce retention | 121 seconds |
| Management attempts per daemon per minute | 120 |

After replay-state loss, keep management HTTP closed for the retention window. On hardware hosts,
no key extracted from disk permits impersonation: a resident pair has neither secret outside the
chip, and a sealed-seed pair's P-256 proof still needs it. TLS remains necessary for server
authentication and confidentiality.

## Session Establishment

A bootstrap turns four independent authorizations into one terminal key: the server authorizes the
pairing, the browser proves its delegation, the user root vouches for the daemon, and the daemon
proves its identity. All four sign the same transcript, so neither the edge nor the server can
substitute any part.

Every connection starts with a fresh 32-byte browser nonce and a one-use ML-KEM-1024 keypair. The
server checks the delegation, daemon ownership, root binding, and presence, then sends the offer
over the authenticated control link with a short-lived ML-DSA-87 capability, payload
`{u,g,b,d,s,k,q,iat,e}`:

| Field | Meaning |
| --- | --- |
| `u`, `g`, `b`, `d`, `s` | User, browser delegation, browser node, daemon, session |
| `k` | SHA-512 commitment to the linked daemon identity |
| `q` | SHA-512 commitment to the exact browser nonce and ML-KEM public key |
| `iat`, `e` | Issue and expiry times |

No browser address is in the capability or the request transcript. The daemon aims NAT-pinhole
datagrams only at the address our edge validated on the browser's committed signaling
connection, so neither the browser nor the server chooses where it sends.
The signature uses `merkur-session-authorization`. The lifetime defaults to 60 seconds and is
bounded from two seconds through five minutes. There is no algorithm negotiation, key id, or compatibility reader.

Before encapsulating, the dataplane requires all of:

1. an exact match between `session_auth` and the authenticated control offer;
2. a valid server capability whose `g`, identity commitment, and KEM commitment match;
3. a valid user-root daemon binding for this permanent daemon identity;
4. a valid, unexpired, non-revoked 30-day user-root delegation certificate; and
5. an ML-DSA-87 delegate signature under `merkur-session-delegation` over the complete request
   transcript plus the SHA-512 digest of the canonical certificate.

The daemon prepares the empty Noise message 2 before signing. Its response transcript binds
that exact message, including the responder ephemeral and encrypted static key, together
with the digest of the browser proof, daemon nonce, KEM ciphertext and input resync point.
Both permanent identity signatures authenticate this transcript under `merkur-session-ready`.
The browser verifies the binding and both signatures before decapsulation. Substituting a
Noise responder fails even if the bootstrap PSK is disclosed.

HKDF-SHA-512 combines the ML-KEM shared secret and signed transcript into the bootstrap
Noise PSK. Direct-upgrade and rebind secrets additionally require a private, role-independent
Noise checkpoint after message 2: both `ee` and `es` have entered its chaining key, while
`psk3` has not. A consuming Rust bootstrap owner mixes purpose-separated KEM seeds with
that checkpoint's two private HKDF outputs and binds the checkpoint hash and response
transcript. No checkpoint bytes cross the WASM boundary. This preserves the existing
flights and avoids a signature-to-PSK dependency cycle. Both ends complete
`Noise_XXpsk3_25519_ChaChaPoly_SHA512`. The prologue (`derive_prologue` in
`packages/merkur-e2e/src/lib.rs`) binds the session id, the daemon id, and the hash of the request
preamble. It binds the request rather than the response because the browser writes Noise message 1
in the same flight as its request, before any response exists; the response is bound anyway, because
the PSK is derived over the signed response transcript and `XXpsk3` mixes it before the transport
keys split. Terminal channels open only after Noise succeeds.

Merkur owns the record envelope and admits ciphertext records up to 8 MiB including the 8-byte
counter and 16-byte tag; the display codec separately limits frames to 2 MiB. Records are
ChaCha20-Poly1305 under Noise's Split keys and nonce encoding: natively through ring, in the
browser through `wasm_chacha` in `packages/merkur-e2e` (a four-block wasm simd128 ChaCha20 with
the audited `poly1305` crate and a constant-time tag compare). `bun run test:wasm-cipher` pins
it to the RFC 8439 vectors, all Wycheproof vectors accepted by its fixed 12-byte nonce
API, and byte-for-byte to the RustCrypto AEAD reference. Streams and datagrams
use disjoint per-lane nonce spaces with 56-bit counters and replay windows, and counters never wrap.
Traffic keys last for the committed Noise generation; authorization renewal does not evolve
them. A carrier rebind performs fresh key agreement. Merkur claims no recovery from a live
generation's traffic-key disclosure without fresh agreement, and no complete erasure of
historical process memory: owned buffers are wiped where supported, while Snow, provider
internals, compiler copies and browser-private storage can retain secret material.
An unfinished KEM-bound issuance is never renewed. Recovering after its expiry creates a new
issuance, nonce, keypair, proof and handshake; terminal authorization denial closes the session.
An established lineage instead renews its carrier authorization as described below. The in-session direct WebTransport upgrade proves the
separately derived upgrade key and reuses established Noise.

## Carrier Rebind

Rebind lets a browser survive a carrier change (a phone switching networks or a carrier closing)
without the full server round trip, while still proving it is the same authorized peer.

The session combiner emits a third output beside the Noise PSK and upgrade secret: a 64-byte
chaining secret, `RS`, the only secret allowed to authorize a successor without the server. Within
the rebind window the browser re-attaches to the daemon tunnel the edge still holds. The exchange is
two flights, each authenticated by HMAC-SHA-512 under a use-separated subkey of `RS`: the browser
sends a fresh nonce and a one-use ML-KEM-1024 encapsulation key; the daemon answers with its nonce,
the ciphertext, and the keystroke resync point. Both sides run `RS || ml_kem_shared_secret` through
the bootstrap combiner to produce a new PSK and purpose-separated seeds. The private
message-2 Noise checkpoint then mixes the classical contribution into the new upgrade
secret and `RS'`, just as in genesis. The ordinary `XXpsk3`
handshake runs against that PSK with the prologue bound to the rebind request preamble, pipelined
into the same flights. The final carries an ordered reconciliation query; a fourth flight
authenticates the committed successor before browser publication.

- **The daemon is authenticated by the flight-2 MAC, not by Noise.** Its static X25519 key is
  process-ephemeral and unpinned. A domain-separated answer MAC covers the response transcript
  and Noise message 2. It is verified before the browser publishes the candidate or consumes its
  one-use bootstrap; invalid answers leave the pending attempt unchanged.
- **`RS` is spent only when the successor handshake completes**, never on a valid proof. The edge is
  on-path: if a proof alone spent the secret, replaying a captured request would lock the browser
  out of rebind with one packet. The browser keeps `RS'` and the staged Noise transport tentative
  until the exact-attempt successor commit acknowledgement verifies.
- **Flight 2 is re-emitted byte for byte** on a repeated flight 1, including the resync point, so a
  retransmission cannot authenticate a different transcript.

Noise message 2 carries no `Psk` token, so both ends send it empty. The daemon retains the incumbent
Noise state through failed successor handshakes and cuts keys only after message 3 authenticates;
`rebind_final` additionally proves the exact message and attempt digest under the tentative
successor secret before the daemon consumes its pending responder. Invalid final proofs leave
that responder intact. Attempt expiry clears both the responder and its held successor secrets.

If the final flight or subsequent daemon traffic is lost, the browser retains both possible
chaining secrets. On its next carrier it sends `session_rebind_reconcile`, binding a fresh nonce,
identities, lineage, predecessor generation and exact attempt digest, with separate possession
proofs under both possible secrets. The daemon keeps only its committed secret. A predecessor
answer cancels that exact pending responder before acknowledging; a successor answer proves it
already committed. A captured query cannot cancel a different pending attempt. The browser
changes its generation only after verifying the matching `session_rebind_reconciled` answer.
An authenticated answer for a different attempt cannot cancel or promote the current
pending attempt, even when both attempts share an incumbent generation and secret.
The final and its query share one FIFO proof stream, so commit acknowledgement adds no separate
query round trip. A later candidate reconciles an uncertain prior cut before preparing a new one.

A rebind reaches no server, so every server check has a local counterpart that fails closed to full
authentication:

| Server check | Local replacement |
| --- | --- |
| Revocation | Tombstones pushed over the control link. A rebind is admitted only while that link was proven current within `REBIND_CONTROL_FRESHNESS_MS` (45 seconds), a little over two renewals of the daemon-control Redis lease (`DAEMON_CONTROL_LEASE_RENEWAL_MS`, 20 seconds). |
| Freshness | An exact generation counter: a lower generation is a replay, a higher one a forgery. |
| Bounded authorization | One gap is bounded by `REBIND_WINDOW_MS` (60 seconds). Each authorization epoch ends at the earlier of its actual signed capability expiry and delegation expiry, and permits `MAX_REBIND_GENERATIONS` (8) carrier commits. |

The constants live in `apps/daemon/dataplane/src/session/policy.rs`. A request that does not
prove possession of the retained chaining secret receives no response. After verifying that
proof, a policy refusal is answered with `session_rebind_refused { reason, mac }`. Its separate
MAC domain binds the reason and the digest of the exact request, including the generation,
identities, nonce, KEM key and Noise message 1. The browser verifies it against its locally
retained request before acting; forged, stale or malformed refusals are
ignored. A generic unsigned `auth_failed` cannot terminate a rebind carrier, including after
its answer is accepted, or an already authenticated issuance carrier. A refused request therefore
need not wait for the authentication watchdog while its daemon is responsive.

Candidate routing is separate from session authority. The routing nonce in a candidate preface
must equal the client nonce covered by its request MAC. The daemon holds one tentative responder
beside incumbent Noise, binds it to the exact candidate reply owner, and refuses a final from any
other owner. Closing that stream revokes its owner even if its task is aborted. An incumbent proof
can cancel the candidate before the final while incumbent signaling remains live; after the final,
the browser must resolve the possible commit. Data traffic cannot restore closed incumbent signaling.
The edge selects only on the daemon's committed reply stream and only while its exact daemon
attachment still exists. The browser additionally requires the end-to-end commit MAC: the blind
edge has no key-cut authority. Input sequence numbers survive this cut unchanged.

### Renewing carrier authorization

An established lineage can obtain a fresh bounded epoch without a new session or key cut. The
worker creates an intent bound to the session, browser, daemon, genesis lineage and fresh nonce.
`POST /api/sessions/renew` authenticates the account/delegation and current daemon ownership, and
signs the intent commitment into a new capability. It allocates no issuance and sends no daemon
control command. The browser delegate signs the capability, intent and canonical certificate;
the current chaining secret then authenticates that signed request and current generation.

The daemon verifies possession before public-key work, then the server capability, daemon identity,
delegation signature, certificate validity, revocation and control-link freshness. Both its wall
clock and a monotonic deadline enforce expiry; wall-clock rollback cannot extend an accepted
epoch. Only a strictly newer server-signed capability expiry installs a new epoch and generation base.
The effective deadline is still clamped to the delegation expiry, including renewals near that
deadline; a fresh grant can replenish carrier changes without extending the certificate.
Replaying the same capability acknowledges its original base without replenishing the allowance.
The cryptographic generation never resets. A MAC-authenticated `session_renewed` binds the exact
request, decision, expiry and generation base. A lost acknowledgement can be retried using the
same signed intent under the current secret after a concurrent key cut.

Browser renewal timers are scheduling aids, never authorization. A verified expiry or generation
refusal triggers renewal and a fresh KEM key on the held candidate. Its routing nonce remains
bound to that candidate; the new KEM key changes the authenticated request transcript. A failed renewal does not
terminate already-live terminal traffic; existing revocation policy remains authoritative. It
cannot extend permission to change carriers. Invalid possession proofs never destroy a lineage,
and exact rebind retransmissions reuse the bounded held attempt without consuming a retry budget.

## Post-Quantum Claim And Limits

The claim is harvest-now, decrypt-later resistance for terminal contents. ML-KEM-1024 (FIPS 203
category 5) protects every session key, with X25519 inside Noise as classical defense in depth.
ML-DSA-87 protects the delegation and binding chain, the server capability, the browser's session
proof, and the daemon's response. Browser, server, and daemon share one implementation, libcrux
through `packages/merkur-e2e`: native in the dataplane, and the `packages/e2e-wasm` build in the
browser and in every Bun process (server, daemon CLI, release tooling).
Merkur is not a FIPS 140 validated module and has had no independent audit. "Post-quantum hardened
terminal sessions" is the intended claim; "provably quantum proof" is not.

Several boundaries remain classical:

- account APIs, browser code delivery, daemon control, and edge transport rely on deployed TLS;
- Web Push is fixed by its standards to P-256 and ES256;
- first-load browser code has no independently pinned post-quantum signature; and
- the first daemon install trusts HTTPS to the origin and GitHub; the printed release-key
  fingerprint is the out-of-band check ([first install](releases.md#first-install-trust-on-first-use)).

A maximum-assurance deployment uses independently provisioned client and daemon images, disables
Web Push and remote OTLP, and provisions the release trust root through offline media.

## Rate Limiting And Trusted Proxies

Rate limits protect the OPAQUE endpoints from online guessing. They are fail-closed Redis limits, so
a Redis outage refuses authentication rather than opening it. Each auth phase is limited per source
address on a 60-second window, the combined start also per normalized username, and account
creation to five per address per hour (a finish that creates no account hands its slot back). Under
email identity, code mail is limited to twenty requests per source address and five messages per
recipient per hour, so the form cannot be used to flood a stranger's inbox. Sign-up codes and
password-reset codes spend the same two budgets.

A source address is an IPv4 address or an IPv6 /64 (`resolveRateLimitSource`). A host chooses the
low 64 bits of its own IPv6 address, so a key on the whole address would give one subscriber an
unbounded number of budgets. An IPv4-mapped IPv6 address counts as its IPv4 address. A subscriber
routed a shorter prefix holds one budget per /64 in it, as the holder of an IPv4 block holds one
per address. Both Boxes waitlist routes, the website form and the signed-in join, admit five
requests per source per ten minutes; these two limits are fail-open.

A password-reset code is six digits, and a new flow costs only a mailed code, so its guesses are
budgeted per account as well as per flow: five wrong codes per account per 24 hours across every
flow (`RESET_GUESS_LIMIT`), consumed before the code is compared and handed back on a match. With
that, continuous guessing succeeds less than once in five hundred account-years, and each day of it
mails the owner. Someone who spends the budget keeps that account's reset form locked; signing in
with the password is unaffected.

Hosted-box creation is gated per account: `POST /api/boxes` refuses with `box_access_required`
unless the account's `box_access` row is `approved`. No account can approve one: the server has no
operator route or operator role, so approval, like suspending an account through
`users.suspended_at`, is an update an operator makes in the database. Nothing else has to follow the
write: sign-in refuses a suspended account, and the active-delegation lookup behind every bearer
check, refresh, and session issuance matches no delegation of it, so the account's next request
fails. Clearing `suspended_at` lets unexpired delegations work again, except that a browser which
tried to refresh while suspended has lost its refresh token and signs in again.

The server runs database retention immediately after migrations and every 24 hours thereafter.
`box_waitlist.created_at` expires after 12 UTC calendar months. Suspended accounts are erased,
including their identifiers and account-owned rows, after 24 months from `suspended_at`.
Every successful authentication that issues a browser session records `users.last_sign_in_at`
and clears `inactivity_notice_sent_at`; refreshes do neither. Under email identity, 12 months
without sign-in sends an inactivity notice. The database records provider acceptance before
starting the 30-day notice period; a failed send leaves the account unscheduled. A sign-in
during delivery prevents that notice from starting a countdown. Username identity has no
verified mailbox, so it never deletes accounts for inactivity.

Retention expiry reads eligibility, records owned hosted boxes in `box_removals`, and erases
the account in one transaction. Cascades delete account-owned rows; box removals remain durable
until the host confirms destruction. A contested box is not queued. No email address is retained
as a suspension tombstone after account erasure. Abuse reports arrive at the contact mailbox,
outside this database; their 12-month retention requires deletion there. Logs, relay data and
performance reports are stored in Axiom; their 30-day retention is a dataset or organization
setting, independent of the database sweep.

`TRUSTED_PROXY_HOPS` has no default. It is the number of trusted proxies that append to
`X-Forwarded-For`; use `0` for a directly reachable server. Overstating it trusts an
attacker-controlled entry; understating it turns the limiter into a denial of service.

Edge registration uses a distinct 64-byte key per edge, canonical HMAC-SHA-512 request
authentication, a timestamp, a nonce, and a Redis replay fence. The key is never transmitted.

## Sensitive Local State And Hard Cutover

`~/.merkur/config.json` is written atomically as mode `0600` inside a mode-`0700` directory. It
contains `daemon_identity_seal: {backend, material}`, the daemon id, server origin, server
session-token verification key, user-root public key and epoch, root-signed daemon binding,
delegation tombstones, shell, and WebTransport port. Protect backups with equivalent permissions.

The schema is declared once, in a single migration, and changed by hard cut: a change that replaces
an authority drops the superseded rows rather than converting them, with no dual reader, no mixed
authentication mode, and no downgrade. Take a database backup with
`bun run --cwd apps/server db:dump --url <DB_URL> --out <file>` and retain the OPAQUE setup before
starting a new image, deploy server, daemon, and browser build together, relink physical hosts, and reprovision
boxes. The config reader accepts only the sealed identity shape: a config carrying `api_key` or a
single-signature proof is rejected without conversion.

## Speculative Echo And The Prompt Boundary

Speculative local echo paints a keystroke before the round trip completes. It is granted only where
the shell is genuinely reading a line, because painting a character the remote never echoes is a
correctness problem, and painting one during a password prompt is a disclosure problem.

Three gates decide it, and all three must hold:

1. **An open shell-editor boundary.** `OSC 133;B` (prompt end) or bracketed-paste enable opens it;
   `OSC 133;C` (command start), bracketed-paste disable, and `RIS` close it. Any keystroke the
   prediction model does not cover revokes the grant, and closes the boundary itself when its legacy
   encoding contains a byte that can leave the line editor (`\r`, `\n`, `0x03`, `0x04`, `0x1a`,
   `0x1b`), whatever keyboard mode the application enabled. Evidence comes from the VTE parser's
   own callbacks at terminal application, below its synchronized-output buffer; while synchronized
   bytes remain unapplied, old evidence is not current enough to grant.
2. **Kernel PTY state.** A canonical read with `ECHO` off fails closed unconditionally.
3. **The foreground process group equals the spawned shell**, so a program the shell launched
   cannot inherit the grant.

Enter is excluded from prediction on purpose, and the daemon honours the "modelled" bit only on a
record the model can produce: one printable under at most Shift, or Backspace, Delete, Left, or
Right alone. No terminal mode is a fourth gate: the alternate screen and mouse tracking say nothing
about whether a line editor is at the cursor (tmux holds both for its whole lifetime). The decision
lives in exactly two places, `prediction_mode_is_unsafe` in `packages/term-wasm/src/lib.rs` and
`terminalModePredictionRefusal` in `packages/shared/src/terminal-mode.ts`, pinned to each other by
tests; a mode test on the input path would send the key unmodelled and manufacture its own
revocation.

Retracting what is already painted has three causes: an exact-cell contradiction, the 500 ms
prediction lifetime, and the grant clearing. When a grant clears under a program another peer
started, the browser drops the model as soon as the unsafe header arrives, so exposure after a
silent read begins is one network leg. When it clears in answer to this browser's own Enter, the
line is already sealed against further keys, and glyphs typed while echo was on stay until their
echo confirms them or the lifetime retires them; a `read -s` started by that Enter is never painted
into.

### The token, and what it is for

A bare `OSC 133;B` is a claim, not evidence: any program with a descriptor on the PTY can print one.
So the grant that relaxes anything is authenticated. `merkur shell-integration` emits
`OSC 133;B;merkur=<token>`, where the token is a 128-bit value the daemon persists at
`~/.merkur/shell-token` (mode `0600`) and exports as `MERKUR_SHELL_TOKEN` into the shell it spawns.
The comparison is constant-time. The threat this defeats is a remote program forging a prompt
boundary on its own stdout, which cannot read a local file. The token is deliberately not a secret
against other local processes of the same user, which can already write to the PTY. It is stable
rather than rotated, because a rotated token would silently stop matching in every running
multiplexer pane.

### The layer a multiplexer removes

Under tmux, gate 3 (and in practice gate 2) describes the multiplexer, not the shell: the daemon
owns the outer PTY, whose foreground group is tmux's and whose termios is tmux's raw mode. An
authenticated boundary therefore skips gate 3. What still holds: the token proves the boundary came
from a shell Merkur started, command start closes it before anything the shell launches runs, and
every unmodelled keystroke closes it. What is gone: the kernel-side confirmation that the shell,
rather than something it launched, is the current reader. An unauthenticated boundary still
requires all three gates, and the token never overrides a closed boundary or a canonical silent read.

### tmux passthrough

Inside tmux the shell-integration snippet (`apps/daemon/src/cli/shell-integration.ts`) emits the
DCS-wrapped form and configures the running tmux server once per `$TMUX` value, guarded by
`MERKUR_TMUX_PASSTHROUGH`:

| Command | Why |
| --- | --- |
| `tmux set -g allow-passthrough on` | tmux parses `OSC 133` itself and does not forward it; without passthrough the daemon never sees a boundary. |
| `tmux set -s extended-keys on` | tmux reads extended key encodings from its outer terminal only with this on; it then asks Merkur for `modifyOtherKeys` and forwards the keys to programs that request them. |
| `tmux set -as terminal-features ',xterm-256color:hyperlinks:extkeys:sync'` | tmux forwards OSC 8 links and extended keys, and brackets its pane updates in synchronized output, only for a client whose terminal declares the feature, and `xterm-256color` does not. |

The features are read when a client attaches, so a client attached before the entry existed keeps
stripping links until it re-attaches.

## Links And Opening URLs

Terminal output is untrusted, and an OSC 8 hyperlink can show one address and carry another. A link
opens only under three rules.

- **Only `http:` and `https:` open.** The browser parses every target with `URL` first, whether it
  came from OSC 8, a matched URL in the text, or `merkur open`. `javascript:`, `data:`, and `file:`
  targets are inert.
- **A user gesture opens a link, never output.** A hovered link opens on Cmd or Ctrl click, from
  inside that click's handler, with the real target shown beside the link while the modifier is
  held. A matched URL spans rows only where the terminal wrapped it.
- **Programs ask; the user's activation opens.** `merkur open <url>`, named as `$BROWSER` in every
  PTY the daemon spawns, writes `OSC 7780;merkur=<token>;<url>` to `/dev/tty`. The daemon accepts
  it only with the shell token above and only for printable-ASCII `http(s)` URLs up to 2 MiB;
  anything else is dropped silently. A browser with transient user activation opens the URL at
  once; one without it shows a toast whose Open button is the gesture. Requests stay queued in the
  daemon (at most 16) until a client acknowledges retaining one. The terminal client retains
  at most 16 per tab, shows the parsed host and full target for inspection, and opens only
  on Enter in that review. It launches the system opener with a separate URL argument on a
  cancellable task that owns the opener process; terminal output, paste and key releases cannot launch it. Stable request
  identities suppress duplicates across reauthentication, including handled requests.

The token carries the same claim as for prompt boundaries: whatever wrote the sequence could read
`~/.merkur/shell-token`, so it is not remote output. The worst an accepted request can do is open a
web page under the browser’s recent activation policy or the terminal client’s explicit review.

## Terminal Effects

PTY output can request a title, bell, desktop notification or clipboard write. The canonical
terminal parser produces typed events; raw escape strings never cross into a client host.
The daemon carries them through authenticated reliable CTRL as `terminal_ui` (`0x3f`). Titles
and notification fields have a 2,048-byte UTF-8 bound and exclude C0/C1 controls; a notification
title also excludes semicolons. OSC 9 numeric subcommands cannot become host commands; accepted
notifications are reconstructed as fixed OSC 777 notification sequences.

The current title is sent at authenticated attachment and rebind. Transient effects belong to
attached peers: the daemon retains at most 16 unsent effects with a combined 2 MiB text bound,
and advances offline cursors instead of replaying offline notifications or clipboard writes.
Clipboard messages are copy-only, with `c` or `p` selectors and at most 2 MiB of UTF-8 text;
clipboard queries never expose a client's clipboard to the remote program.

The terminal client forwards its selected tab's title and restores the host's original title on
exit. Bells and desktop notifications may come from any live tab. Clipboard publication requires
the focused, selected live session with no dialog, rechecked when composing the host frame.
The client emits only a fixed base64 OSC 52 write and wipes owned clipboard text and frame
buffers. Headless output reports the byte count without printing clipboard contents. Browser
clipboard writes require the active focused session and platform permission; browser notifications
follow the account's existing notification preference.

## Metadata And Telemetry

Merkur hides terminal contents, not the fact of a session. Plaintext signaling exposes
capabilities, delegation certificates, nonces, ML-KEM public keys and ciphertexts, response
signatures, and Noise handshake messages to an edge operator; none is a reusable key or seed.
Addresses, sizes, timing, reconnects, and duration remain visible.

The browser response uses a strict CSP, `nosniff`, COOP and COEP, no-referrer, a restrictive
Permissions-Policy, and production HSTS. The document's `connect-src` is same-origin; only the
transport worker receives the broader HTTPS permission for runtime WebTransport candidates.
`style-src` carries a `sha256-` source for the inlined stylesheet, read out of the built shell at
server startup so a drifting hash cannot fail silently; `'unsafe-inline'` stays out. The server
stores one per-account preference in plaintext: the on-screen keyboard's arrangement and named
macros (`GET` and `PUT /api/settings/keyboard`), including each macro's display name and ordered
key combinations. Macro taps enter the same ordered input queue as other keystrokes. Each step
uses its stored modifiers and sends a press and release; the Rust dataplane encodes them against
the application's current keyboard modes. The passive offset learner and typing diagnostics,
a behavioural measurement of one person on one device, never leave that browser
(`accountKeyboardSettings` in `apps/web/src/terminal/virtual-keyboard.ts`).

Span attributes are constrained by a type. `packages/shared/src/span-attributes.ts` declares every
key Merkur may set with its value type; an unknown or computed key, or one such as `client.address`,
`url.full`, `user_agent.original`, or `merkur.user_id`, is a compile error, and
`bun run check:span-attributes` checks that nothing bypasses the type. This constrains every process
built from this repository and nothing else: the server relays daemon and browser span batches
without inspecting them, so a modified client could put arbitrary attributes in that stream. A
daemon and a browser are authenticated, not trusted to be unmodified.

| Path | What it carries | Authenticated by |
| --- | --- | --- |
| `POST /api/daemon/traces`, `POST /api/daemon/perf` | Command ids, session ids, command types, phase durations | Daemon management proofs |
| `POST /api/telemetry/traces` | Browser bootstrap phase durations, attempt id, device id; off unless "Performance reporting" is on | Browser access token |
| `POST /api/telemetry/error` | A failure class derived from the error's type and name only, never a message or stack | Browser access token |

No vendor credential reaches a user's machine: the server holds the exporter token, and the
daemon's network surface stays exactly the server and the edge. A `traceparent` on a control
command is matched against a fixed-width pattern before it can parent a span; a forged one buys
nothing but a misleading trace.

## Release Trust

Release trust is what lets an installed daemon accept an update: trust on first use, then a
compiled ML-DSA-87 pin forever after.

Daemon release artifacts are hashed with SHA-512 in one canonical manifest signed by a CI-held
ML-DSA-87 key. The daemon embeds the public-key pin and a monotonic release sequence, and the
updater verifies manifest shape, signature, context, expiry, minimum consumer sequence, artifact
name, size, and hash, and a durable rollback floor before activation. There is no unsigned checksum
or "skip verification" mode.

A script downloaded from the origin it verifies cannot establish its own trust root, so `/install`
trusts HTTPS to the server and to GitHub for the initial binary and its compiled pin. The installer
prints the pin's SHA-256 fingerprint (`merkur release-key` repeats it), published in `README.md` and
`SECURITY.md` for comparison over a channel the server does not control. Losing or compromising the
release key requires an explicit out-of-band trust-root replacement.

Web builds and deployment bundles use the same key with the contexts `merkur-web-release-manifest`
and `merkur-deployment-release-manifest`. Docker verifies the signed server, migrations, and web
assets against an independently selected commit and pin before packaging. This authenticates
inspected artifacts, not the OS, shared libraries, or container entrypoint. The server and edge
initialize only their `/data` volume as root, then run as UID and GID 10001 with `no_new_privs`;
STUN starts that way. Account settings verifies the server's reported proof pair against the loaded
client's build marker, and an independently trusted local bundle can be compared with
`bun run deployment:check-server` ([signed deployment](releases.md#signed-docker-deployment)). The
verifier is still delivered by the same origin, so the first-load boundary is unchanged.

## Repository And Dependency Protection

These controls keep a compromised dependency or workflow from reaching a release. GitHub automation
is part of the release trust boundary, so its permissions are the point.

`bun run setup:audit` installs the pinned cargo-audit release, and `bun run check:audit` checks both
Bun and Cargo lockfiles against current advisory databases, rejecting known Rust vulnerabilities and
yanked crates. The [dependency audit workflow](../.github/workflows/dependency-audit.yml) runs on
pushes to `main`, pull requests, daily, and on manual dispatch with read-only permissions and no
deployment secrets. Neither audit installs application dependencies or runs lifecycle scripts.

The CLA workflow runs a commit-pinned action with only its documented permissions and never executes
pull-request code. The checked-in [main-protection policy](../.github/main-protection.json)
requires a pull request, CI, audit, secret scanning, assurance and resolved conversations, applies to
administrators and blocks force pushes. Enforcement requires applying that policy on a
GitHub plan that supports protection for this repository; the policy file alone does not
protect a branch. Full-SHA enforcement rejects any unpinned workflow:

```sh
gh api --method PUT repos/merkur-sh/merkur/branches/main/protection \
  --input .github/main-protection.json
gh api --method PUT repos/merkur-sh/merkur/actions/permissions \
  -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
```

The `release-signing` and `production` environments allow only selected `v*` tags,
and tag rules restrict creation to release maintainers. Pushing the protected tag authorizes the
full release. The signing seed is an environment secret available only to the signing job, so a
compromised trusted workflow or runner can forge releases; deployment environments receive no
signing seed. See [CI operations](ci.md).

## Parser And Ownership Assurance

[`tools/bolero`](../tools/bolero/README.md) runs the actual wire and STUN parsers and the
terminal display ingress, staging and zstd decompression boundaries.
`bun run test:fuzz:smoke` checks encoder seeds and replays a fixed seed;
`bun run test:fuzz:campaign 10000` runs five bounded
coverage-guided libFuzzer campaigns and retains corpus and crash artifacts. Tests check
canonical framing, authenticated STUN mutation rejection, unchanged display authority
before apply, released staging budgets and decoder recovery after rejection. Input bounds
and a finite campaign are coverage limits, not proofs of arbitrary hostile input safety.
Bolero has an independent generated workspace and retained lockfile because its generator
pins a dependency version that differs from the production graph. It compiles the original
source with test-only cfgs; no production dependency or binary includes Bolero.

[`tools/ownership-proofs`](../tools/ownership-proofs/README.md) includes the production
custody, lane and edge membership/routing code directly. Three Kani harnesses exhaust
bounded counter-lane custody states. Five Loom models explore routing admission,
attach/detach, retirement and slot destruction with test-only synchronization adapters.
Five negative controls deliberately break those invariants and must fail. Production
uses its existing synchronization and transports. These checks do not prove the complete
cryptographic counter implementation, parking_lot, Tokio, QUIC or the whole application.
Run `bun run test:ownership`, `bun run test:ownership:kani` and
`bun run test:ownership:negative` with the pinned tools described in that README.

## Dependency Source And Audit Policy

`bun run setup:dependency-policy` installs pinned cargo-deny and cargo-vet releases.
`bun run check:dependency-policy` enforces the license, source, wildcard and prohibited
TLS-backend policy in `deny.toml`, then requires cargo-vet coverage for the locked
production dependency graph. The dependency audit workflow also checks diagnostic
workspaces and runs nine offline policy controls. Advisory scanning remains a separate
`check:audit` gate; cargo-vet's review coverage is not a vulnerability database.

`supply-chain/config.toml` imports review evidence from Mozilla, Google and the Bytecode
Alliance. Existing versions without complete evidence have explicit exact-version
exemptions marked unaudited. An exemption is not an audit or a security certification;
a new unreviewed version fails. Modified vendored patch crates are first-party and cannot
inherit upstream registry audits. Policy updates must review the actual dependency change
and its source rather than automatically refreshing exemptions or trusting publishers.

## Repository Secret Scanning

Secret scanning stops a credential from entering history, where removing it later would require a
rewrite. It runs locally on every commit and again in CI.

`bun run setup:hooks` (also run by `bun run setup`) installs the native TruffleHog release pinned in
`scripts/trufflehog.json` into the Git common directory shared by linked worktrees, and enables the
tracked `.githooks/pre-commit` through `core.hooksPath` without replacing another hook
configuration. The hook, also `bun run check:secrets`, scans the complete staged contents of added,
modified, renamed, and type-changed files by exporting blob ids from the index into a private
temporary directory, so partial staging and `git commit -a` scan the bytes being committed. A
missing or mismatched scanner, verified or unknown findings, and nonzero scanner exits block the
commit. Findings show detector names and locations, never values. Local hooks can be bypassed, so
CI stays enabled.

[Secret scanning in CI](../.github/workflows/secret-scanning.yml) runs the pinned TruffleHog on
pushes and pull requests over the changed commit range, and on manual dispatch over the full
history, with read-only access. It fails on verified credentials, candidates whose verification
errored, and scanner errors. Unverified candidates do not gate, so a passing scan is not proof the
repository holds no secrets. Reviewed dummy credentials may carry a line-local `trufflehog:ignore`
comment with an explanation; nothing is excluded globally. For a local history audit:

```sh
trufflehog git file://. --results=verified,unknown,unverified --fail --fail-on-scan-errors --no-update
```

TruffleHog verifies candidates against their providers. Treat scan output as sensitive and revoke an
exposed credential before removing it from source.

## Security Non-Goals

Merkur does not protect against:

- compromise of the browser profile, same-origin application code, daemon host, or local shell;
- a malicious server suppressing daemon revocation delivery or denying service;
- traffic analysis or denial of service by infrastructure that can observe, drop, delay, or reorder
  connections;
- account takeover through an exposed password, refresh cookie, live delegate, or classical
  management-plane TLS session;
- linking a daemon host controlled by an attacker; or
- cryptographic implementation defects or future breaks in the required primitives.

Password changes, password reset, remote browser-session revocation, self-revoking logout, device
deletion, daemon relinking, and offline release-root reprovisioning are the recovery controls for
their respective credentials. Exercise them rather than assuming an exposed
30-day delegation will expire soon enough. A password change cannot revoke an already extracted user root;
root compromise requires the destructive reprovisioning a password reset performs. Under email
identity the account's mailbox is therefore a credential too: whoever reads it can unlink the
account's machines and delete its boxes, though never open a terminal.

NAT traversal is bounded work aimed only at the browser address our edge validated on the
committed signaling connection: quinn proved that address answers, so a punch cannot be pointed at
a victim that never spoke. Private and local destinations are refused, a punch is four one-byte datagrams aimed at the daemon's own port number
and the next one, a per-destination cooldown and a global token bucket bound the total, and the
browser dials one WebTransport connection per offered candidate
(`MAX_WEBTRANSPORT_OFFER_CANDIDATES`, 10).
