# Inactive execution-pool contract

GitHub jobs orchestrate the engine and retain authenticated evidence. Standing Linux
execution uses hosted BuildBuddy RBE on both native architectures. Mac ARM execution requires
an actually available BuildBuddy-managed or dedicated registered worker. Intel Mac x64 requires an actually registered pool and external hardware. Registration
identifiers, endpoints and image identities must come from the authoritative operator
configuration; these templates invent none.

`tools/bazel/verification/executor-policy.ts` parses the explicit deployment inventory.
The JSON object contains only `pools`, with exactly one entry for each of
`darwin-arm64`, `darwin-x86_64`, `linux-arm64` and `linux-x86_64`. Every entry contains
`platform`, `provider`, `pool`, `executionPlatform`, `imageDigest`, `sdkDigest` and
`containerImage`. The `pool` field is mandatory; an explicitly supplied empty string names
the documented default pool and remains an exact `Pool=""` property. It does not create
an implicit inventory, infer this account's default or qualify quiet hardware.
`executionPlatform` names its declared Bazel platform. `imageDigest`
and `sdkDigest` are lowercase SHA-256 identities, not mutable image names. Linux entries
use `provider: "hosted"` and an OCI `containerImage` ending in the matching
`@sha256:<imageDigest>`. Mac entries set `containerImage` to `null`; Intel Mac entries
require `provider: "registered"`. `provider` selects the scheduler lane: `"hosted"` requests
`use-self-hosted-executors=false`; `"registered"` requests `true`. Mac management and scheduler
lane are distinct. An ARM Mac hosted entry is usable only after BuildBuddy confirms that
exact managed entitlement, lane and native pool access. Public documentation does not
establish this account's entitlement or routing. No default inventory or placeholder
deployment is checked in.

BuildBuddy's [ARM support announcement](https://www.buildbuddy.io/blog/arm64-support/)
confirms autoscaled Linux ARM64 support and mentions cloud Mac machines. Its
[Mac runner documentation](https://www.buildbuddy.io/docs/remote-runner-introduction/)
directs customers to confirm managed Mac access; the
[scheduling-property documentation](https://www.buildbuddy.io/docs/rbe-platforms/)
documents Darwin in the self-hosted lane. Those sources cannot supply a missing operator
configuration or qualify actual pool access.

The `standing_execution_platform` factory in `tools/bazel/platforms/execution.bzl` writes
BuildBuddy's `OSFamily`, `Arch`, `Pool`, `use-self-hosted-executors` and Linux
`container-image` properties onto each actual Bazel platform. `executorFlags` emits the
same exact scheduling request for the declared engine. BuildBuddy documents that
`--remote_default_exec_properties` are not applied when a target or execution platform already
has properties. The declared platform must carry the complete requested values; command-line
defaults do not override it. These properties select execution;
the supplied OS/SDK digests state what qualification must independently observe. Neither
the JSON declaration nor a scheduling request proves pool registration, the actual
selected worker, its SDK, or quiet measurement ownership. Genuine configured actions and
execution evidence must match before acceptance. A platform carrying different execution
properties cannot be approved merely because command-line defaults were requested.

`verifyNativePlatformBatch` requires the complete trusted native-four attempt inventory
before entering `verifyReservedBatch`. It reuses that controller's single reservation and
its complete publication, dispatch, report retention, promotion and retirement lifecycle.
A smaller local verification request still uses `verifyReservedBatch` directly. Submitted
reports and completed-job lists cannot shrink native qualification to a partial cohort.
No second receipt, result cache or nonce store is introduced by this driver.

Hermetic tests keep ordinary local and shared result reuse under their declared per-target
nonce Files. Live tests require fresh execution and explicit resource ownership; performance
tests additionally require dedicated quiet hardware held exclusively for the measurement.
An executor configuration cannot establish those runtime facts. The driver does not turn a
hosted Linux pool, developer Mac or ephemeral GitHub VM into measurement hardware.

Every admitted pool must prove its native OS/CPU, pinned engine/compiler/SDK closure,
configured source context and action scheduling. Cross-compiling on another host or a
developer-machine run does not qualify that pool. The optional four-GitHub-runner recipe
is a bounded control experiment and does not register standing execution workers.

BuildBuddy shares build artifacts and test results. Every test action consumes its own
nonce File. The authoritative ledger reserves pending epochs durably before forced
execution, and only complete source/graph/process-bound engine evidence can promote them.
Ordinary requests cannot reuse pending epochs. Terminal failure or cancellation retires
each still-matching reserved nonce through an authoritative compare-and-exchange, replacing
it with a new pending nonce. The guard matches the exact reservation nonce for each test;
it preserves a newer independent reservation. A cancelled worker's later pass cannot admit
its retired nonce. Retrying a pending epoch reserves another new nonce before execution.
BuildBuddy cache deletion is not part of this contract.

One trusted controller owns a forced batch across its independently planned platform
inventory. CI constructs its required four-platform cohort from the trusted event plan;
local requests may have a smaller independently planned cohort. Submitted reports never
define or shrink either inventory. Global native-four SDK/pool/cache qualification remains
a separate cutover prerequisite. It reserves the global test-label epochs once, dispatches that exact reservation
to every required platform, and validates every platform's expected checks, configured
identities and complete process-bound receipts before one atomic promotion. Individual
platform jobs never reserve or promote those epochs independently. A missing, duplicated,
failed or cancelled platform retires the still-matching batch into new pending epochs; a
concurrent newer reservation wins. Promotion requires the exact reserved nonce and state
for every selected test. Before publishing acceptance, the controller performs a final
authoritative read and requires those selected nonces to remain ready. Unrelated ledger
updates may proceed; an intervening selected revocation refuses publication.

The root `verifyReservedBatch` lifecycle owns each frontend `PreparedVerification`,
reservation, complete publication, settled execution batch and terminal nonce decision.
CI calls `captureControllerCiExpectations` on that actual `ControllerResult`; the root
`controllerExpectations` getter supplies its existing captured publication batch. CI does
not reserve or publish a second time. Copied and serialized controller results cannot
recreate the owned handle. Cached confirmations reread the original controller's selected
epochs at consumption; unsigned artifact binding rereads them after its awaited File
verification too. An intervening selected force revocation refuses either use, while
unrelated ledger updates remain valid. A saved admission boolean supplies no current
authority. `reconstructPreparedCiBatch` requires a bijection between those captured
invocations and submitted reports, reconstructs every report against its own expected
context, and returns detached immutable verdicts in captured order. Partial, repeated,
extra or coherently reduced report inventories refuse reconstruction. This vector does
not promote nonces or establish pool authority. Neither a serialized capability nor expected JSON supplied by a worker
can replace it. The publisher returns the root writer's actual owned durable receipt for
the complete ordered batch. Its canonical array File, even for one platform, is written
through held output capabilities outside every original and frozen source root, flushed
and independently verified before confirmation. Silent no-op publication, copied or
serialized receipts and closed or changed outputs refuse confirmation. This proves local
publication, not authenticated hosted storage. The local controller and batch consumer are implemented. Complete engine-owned
nonce/action/source binding, actual SDK/pool authority and end-to-end admission still
require qualification before the inactive workflows can execute this lifecycle.

The controller must acquire expected invocation, immutable Git base/candidate/head, source
and Git digests, configured graph digest, platform, exact checks and untracked admission
independently of a submitted report. `bindPreparedCiArtifacts` consumes the same owned
confirmation and complete nested `ControllerResult.results` report batch for unsigned
output-group digest checks; it accepts no second expected context. Bounded reconstruction
from a published but non-admitted controller result cannot authorize signing. The
controller reconstructs report acceptance, then reconciles
pool identity, nonce/action inputs and complete output/log/JUnit evidence. Uploaded JSON,
job status and reported acceptance booleans provide no independent authority.

Nonce/provider binding, the authoritative shared ledger, actual pool registration and
complete platform execution remain qualification prerequisites. The native and release
templates refuse missing execution adapters. Protected signing and deployment remain
separate trust domains. Worker environments contain no signing seed, deployment credential
or cache-control-plane authentication material.
