# Bazel CI integration

The `bazel-*.yml.in` workflow templates are inactive. The active workflows retain their
current admission, signing and deployment behavior. The templates preserve the
required source/native/integration/transport lanes, the four-platform obligations, the
scheduled/manual campaign distinction and all five extended environment suites.
Assurance requires parser replay, ownership, bounded parser/state proofs, real-session
network simulation and nonprivileged kernel-tool checks on every supported event. Schedules
and manual dispatches additionally require the coverage-guided campaign and a 200-seed
random simulation sweep. The campaign must be skipped on pushes and pull requests.

[qualification.json](qualification.json) is an explicit inventory of unresolved lane
prerequisites. Admission rejects a lane with any applicable unresolved entry. Missing
execution producers also fail explicitly in the templates. Clearing the inventory alone
cannot activate missing source, browser, tool or unsigned-release producers.

[bazel_admission.py](../../scripts/ci/bazel_admission.py) checks the exact applicable job
inventory: missing, failed, cancelled, additional and incorrectly skipped jobs fail. Source
remains required on prose-only changes. Scheduled/manual assurance requires the campaign and simulation sweep;
push and pull requests require the campaign to be skipped, while simulation replay remains
required. This job-status check establishes inventory
only. The inactive CI source and native jobs run the declared controller and retain all three
ordinary diagnostic Files; its required job aggregates those complete job results through
`ci-results`. This status aggregation cannot admit uploaded controller JSON. The native job
starts after source verification succeeds and requests the complete four-platform batch
with the explicit qualified executor policy. Its forced reservation cannot revoke an in-flight
source attempt. The required job retains the successful source status and requires successful
native admission; it does not re-admit the earlier source report after native force rotates
shared test epochs. Unimplemented authenticated integration and transport producers continue
to fail their lanes.
Assurance additionally requires the successful complete controller job; its
original lane jobs retain access to the same published diagnostics and project that
command's success. Downloaded reports cannot create controller authority. Validated engine
reports and successful evidence retention remain requirements for the executing batch.

The assurance controller uses `--all --force --assurance-event EVENT` with
`--ci-report-file ABS_JSON`. It captures one of `pull_request`, `push`, `schedule` or
`workflow_dispatch` and selects the complete configured operation union: all eight static
gates Bazel carries once, parser instrumentation and replay, ownership models and all-target Clippy,
ownership Kani and negative controls, every listed bounded parser/state proof, and
nonprivileged kernel Clippy, layout and completed-work checks. Simulation runs every scenario
seed and recorded regression with its retained diagnostic lock. Schedule and manual events
add the bounded campaign and 200 random simulation seeds. One reservation covers the union; the original lane jobs never
reserve or force tests separately. Missing configured producers fail before execution.

Extended CI passes `--extended-suites --all --force --ci-report-file` through one controller
reservation and admission for all eight static gates and all five suites. Its native and
browser matrices project the complete command and retain the same three diagnostic Files;
they never reserve separate test epochs or derive admission from uploaded JSON.
Native operations are `test:natlab`, `test:tpm-sim` and `test:graphics:long`; browser operations
are `test:e2e:transport:impaired:functional` and `test:e2e:edge-topology`. Missing or pending
configured execution providers refuse controller admission. The workflow remains inactive
until its original privileged network, TPM, long graphics and browser environments qualify.
The producers must retain original harness listings, solver budgets, production and
diagnostic locks, campaign mutation/input/memory bounds, and complete result outputs as
declared inputs and outputs. The controller's workflow timeout and diagnostic retention do
not establish those producer obligations or their qualification. The bounded proof inventory
includes `merkur-e2e`’s `proof_rebind_keeper_chain` with its original two-operation bound,
unwind limit and Kani stubbing. Simulation qualification must retain the original scenario
log, sweep log and failed-seed regression data on failure; controller diagnostic JSON alone
does not satisfy that output-retention obligation.

The controller selects replay through `test:sim` and adds `test:sim:sweep` only for schedule
and manual assurance events. Its simulator context uses the original retained simulator
lock, release test profile, `merkur_sim` and `tokio_unstable` flags. The separate
`//tools/bazel/rust:contexts_simulator_test` checks metadata generation; it does not run the
real-session scenarios or qualify simulator execution.

`//tools/bazel/rust:capture_simulator` selects a capture with fixed native target and
execution constraints on macOS or Linux, with ARM64 or x64. The acquired SDK uses the capture execution configuration and requires
matching native Rust target and execution hosts. It emits selected compiler declarations,
the original lock and public root bindings, including the library, every original
integration harness and rustdoc; `manifest.toml` remains the simulator manifest. Its
output must be captured and integrated, and the configured action and simulator runtime
must qualify before `tools/sim` can expose runnable targets.
`//tools/bazel/rust:simulator_generation_test` checks the producer boundaries; it does not
execute or qualify the real-session simulator.

The frontend retains selected simulation outputs before closing its private engine tree,
including failed attempts. Replay requires `scenarios.log`; sweep requires `sweep.log`,
`regressions.json` and `sweep-failures.json`, all beneath the attempt's simulation directory.
The `simulationDiagnostics` report field names the retained root, Files and problems under
its outside-checkout `evidenceDirectory`. Each attempt is separated by its actual target,
configuration, run, shard and attempt. Missing, duplicate, foreign or nonmaterialized
outputs refuse acceptance. Preserve that diagnostic tree alongside the three controller
report Files; the reports alone do not contain the scenario and failed-seed bytes.

[engine-pins.json](engine-pins.json) pins the official native Bazel payload for each supported
OS/CPU. The setup action verifies SHA-256 before executing the binary and checks its version.
This acquisition runs on GitHub's trusted control plane; it is separate from declared tools
executed by product actions. The setup action installs no package dependencies or compilers.
It requires explicit `ledger-origin`, `ledger-credential-helper` and `credential-file`
inputs from the trusted authentication bootstrap. The first is a canonical HTTPS ledger
URL without embedded credentials; the latter two are absolute original external Files.
No endpoint, helper, token or local authority is supplied by default. The workflow variables
name operator-provisioned policy inputs; configuring their names does not provision a service.
Credentials are provisioned through the original private File or the operator's declared
CLI/Keychain helper boundary. Never paste tokens into chat, reports or committed setup.

`//scripts:provision_ledger` creates a new dedicated bare client outside the checkout,
resets credential-helper inheritance, disables prompts, global/system Git configuration
and HTTP redirects, then reads the canonical remote ledger through `GitRevocationStore`.
It does not initialize, commit or push ledger epochs. Failed acquisition returns no client
output and prevents the verification step. A failed private client is retained outside
the checkout for diagnosis and is never reused. The setup action's `ledger-client` output
is passed to `--ledger-client`; `credential-file` forwards the separately supplied private
BuildBuddy File to `--credential-file` without reading its bytes. Neither File is uploaded
with retained reports or declared as a compiler/test input.

The launcher must bind the original native Git acquisition tool and its actual compiled
POSIX shell. Provisioning requires `git var GIT_SHELL_PATH` to report exactly `sh` and
binds the original `bin/sh` File from the same declared SDK through its exact `bin` PATH.
Absolute host-shell builds are refused; this is a prerequisite, not a shell override.
The acquired utility rebuild and its declared shell closure remain unqualified. The external helper's own
interpreter/runtime and protected HTTPS/write authentication also remain requirements.
Local bare transport controls prove client/configuration and refusal mechanics only.
A successful public ledger read or helper invocation does not prove authentication,
branch protection or hosted execution authority. Existing controller CAS/write readback
and final source/epoch guards still run before admission.

The declared tool for verification launchers is `//tools/bazel/tools/engine:bazel`, acquired
from the same official pins through the repository module extension. Its typed provider retains the
original executable File and platform-specific acquisition metadata File. Bun launchers
bind that exact tool to `MERKUR_VERIFICATION_BAZEL`; they do not discover Bazel through PATH
or a HOME cache. The native tool controls check the downloaded payload digest, architecture
and version, and reject a missing declared executable. These controls execute `--version`
only and do not start nested builds inside compiler or test actions.

Cargo introspection reuses the declared original-archive registry producer independently
from its source snapshot action. Its descriptor records the explicit Rust runtime; action
inputs and the typed SDK File closure also retain the complete configured Rust/Cc SDK.
These inputs do not discover a compiler, shell or SDK through the host PATH.

The release template preserves protected tag admission, the sequence journal, isolated
signer, signed-package smoke tests and privileged deployment job. Only
unsigned producer jobs are subject to the build-engine integration. No signing seed
or deployment credential belongs in the worker environment.

The release workflow orders its controller calls: required CI completes before Extended
CI's forced union; the complete forced native unsigned batch starts after both. These
dependencies keep the shared selected epochs from being rotated by concurrent release
controllers. Every original check, extended suite and ten-artifact requirement remains
required before signing.

Its unsigned verification command requests `--all --force --unsigned --native-platforms`
and an explicitly provisioned absolute `--executor-policy-file`. The policy must be an
ordinary nonempty File and capture all four qualified execution pools. The command supplies
a fresh absolute `--unsigned-output-directory` below the held outside-checkout diagnostic
parent. The same controller captures configured producer descriptors, reconstructs the
complete selected report batch and binds every ordinary output to its producer,
configuration, output group, destination, SHA-256 and byte length. One reservation covers
the complete native cohort; separate forced platform jobs cannot supply it because they
would rotate each other's shared selected test nonces. Missing producers, selected
attribution scopes, native execution evidence or platform coverage prevent admission.

The controller copies exactly the ten original shipping names into its fresh flat
consumer directory. Original signing inventories and engine descriptor evidence remain
in the separate fresh `.evidence` sibling. The held directory capabilities survive through
final controller acceptance; late source, nonce or publication failure retires their
created Files. The workflow uploads the shipping directory as `release-controller`, which
the isolated signer's unchanged `release-*` pattern selects. Its `unsigned-signing-evidence`
upload stays outside that pattern. Both uploads require the successful controller command;
controller, CI and expected-context diagnostics are retained even when verification fails.
The original daemon matrix and service job names project that complete command's success
without reserving or reexecuting another batch. Their status does not recreate a live
controller capability, qualify an executor or establish the original signing boundary.

Native daemon packaging requires each host's generated `dataplane_release` supplier under
`tools/bazel/rust/release_pgo/<Rust-triple>`, together with the same generated
`merkur-dataplane/profile_use/<Rust-triple>` compiler context and compiled Rust attribution.
The original `merkur-dataplane` shipping basename stays unchanged. A plain release unit or
another host's trained compiler cannot satisfy that role.

The declared Darwin ARM metadata operations are
`//tools/bazel/rust:capture_dataplane_release_pgo` for generation and
`//tools/bazel/rust:capture_dataplane_release_pgo_use` for profile use. The latter
consumes the real `dataplane_profile` output and its original generation context before
capturing the profile-use graph. Its successful output supplies the generated release
declarations; registration alone does not qualify a shipping supplier.

The required profile chain selects the instrumented library test harness, preserves the
original suite, display-pipeline and scroll workloads, and requires each workload to select
tests and write a profile before merging. Mandatory benchmark failures prevent training
output; the suite's test verdict remains the separate CI requirement. The profile-use
compiler and packaging consume those original declared outputs through the same unsigned
controller request. No standalone workflow build or uploaded profile substitutes for the
configured supplier. Four-host training, native execution, attribution and performance
qualification remain required before the inactive release recipe can be installed.

One-platform `--unsigned` verification remains a distinct bounded developer request. It
materializes only the complete captured output groups selected for that platform and
retains their original signing-input JSON; it cannot satisfy the full ten-file release
contract. Only Linux x64 has a one-platform producer, the unsigned deployment; the request
refuses on every other platform. The native release template requires the full
four-platform controller path.
The template remains inactive until its source, execution, cache, performance and unsigned
producer requirements are qualified. The existing protected signing and signed-package
consumer requirements still apply.

The bounded-proof lane requires the six listed parser/state proof harnesses, their original
budgets, unchanged production lock bytes and complete solver output retention. Kani comes
from its declared pinned SDK and executes inside nonce-keyed tests; a host setup command or
cached build-time solver result cannot satisfy the lane. Declaring the workflow job and
requiring its result does not qualify the declared proof targets or their solver
execution. The unchanged qualification inventory keeps these templates inactive.

The inactive [editor tasks](../../.vscode/tasks.bazel.json.in) point to the concrete
package, attribution capture, release layout and engine-output binding controls, and
the declared `//tools:verify` frontend contract. Tasks require an absolute checksum-pinned
engine through `MERKUR_VERIFICATION_BAZEL`; they do not discover an executable through PATH.
Changed verification captures the current index and worktree with immutable Git identities.
The controller snapshots every indexed and explicitly admitted untracked source, including
raw declarations, nested package boundaries and captured alias referents. Its manifest
retains original bytes, modes and topology. Each original regular File is acquired as a
flat payload whose name hashes its logical path; the mapping and manifest remain authoritative.
The captured-source action requires the complete payload inventory and publishes an actual
TreeArtifact at `@verification_context//:source_tree`; the policies that only read source
(lint, dead code, the latency and span policies) run in that tree. The ratchet and the
documentation check run Git over their source, so each reconstructs the captured source in
its private directory from the same payload, declared at
`@verification_context//:source_payload` with a mapping that must name every captured
file, and does not wait for the published tree. None executes against the live checkout. Missing payloads, changed bytes or modes, and conflicting
aliases refuse reconstruction. A reconstruction proves its tree in sweeps: every directory
it made still names the directory it holds, every file's name and bytes are the ones it
wrote, and the tree's membership and manifest digest are the capture's. A tool's private
tree is proved before the tool runs and again after it; the published tree has no consumer
and is proved once. Configured action and source-gate qualification remain
requirements before activating these entrypoints.
Complete fresh verification requests `--all --force`; authoritative nonce revocation and
shared-cache admission must be qualified before activation. Reports require a new absolute
path outside the repository.
The source workflow template passes the immutable PR base and checked-out candidate SHA;
other events request complete coverage. The declared frontend publishes an immutable
`VerificationExpectation` before engine execution to the held outside-source
`--expected-context-file`; publication failure prevents execution. Its ten fields derive
from freshly captured Git, source and configured coverage, independently of the submitted
report. The workflow retains that context and the sanitized result even on failure.
Consumers must reconstruct acceptance from a result's `.evidence`; an explicitly blocked
result or reported boolean cannot admit a lane. The source command remains behind the
unchanged qualification inventory, and templates remain inactive.

`reconstructCiVerification` in `tools/bazel/packaging/ci-evidence.ts` requires independently
acquired invocation, immutable base/candidate/head, Git digest, source digest, configured
graph digest, platform, required checks and explicit untracked admission. It compares those
identities with mandatory raw evidence context and reconstructs the engine verdict. The
controller must acquire these expected facts independently of the submitted report. This
constructor does not supply the status-only required-job aggregator. Hosted trusted
acquisition and report-origin binding remain qualification obligations. Its standalone
`ci_admit reconstruct` File
consumer requires one canonical singleton expectation array and refuses a bare object or
multi-platform batch. Matrix reconstruction uses the owned complete batch capability;
it never selects a context from report-supplied identity.

`confirmCiExpectations` in `tools/bazel/packaging/ci-preparation.ts` accepts only the root
frontend's owned `PreparedVerification` capabilities. The trusted controller calls
`prepareVerification` for each independently planned platform, then confirms the entire
batch through `publishVerificationExpectations` before dispatch. The CI wrapper returns
an owned confirmation only after that batch publication and its fresh source/Git checks
complete. `reconstructPreparedCiEvidence` uses those captured contexts, never an expected
JSON uploaded by a worker. Serialized preparations and confirmations are refused. The
publisher must return the actual root writer's owned `PublishedVerificationExpectations`
receipt. It writes the canonical array of complete contexts, including for one platform,
through a genuine held `ReportOutput`. The frontend independently checks the output is
outside every preparation's original and frozen source roots, flushes and verifies the
retained file, and confirms the exact ordered batch before its fresh source/Git checks.
Missing, copied, serialized, already consumed, closed or changed receipts refuse
confirmation. This local filesystem receipt does not authenticate hosted storage or
worker report origin.
`reconstructPreparedCiBatch` requires exactly one reconstructable report for every captured
invocation, refuses omitted, duplicate and extra reports, and returns detached immutable
verdicts in captured platform order. The submitted report cannot shrink the expected checks.

This preparation adapter dispatches no actions, admits no platform batch and promotes no
nonce. Final nonce-bound configured action/source inputs, SDK and execution-pool authority
still need the main frontend's owned binding stage. These inactive workflow templates
cannot use the adapter to substitute for that stage or the final authoritative ledger read. Native lanes still require equivalent
sanitized receipt retention and admission before activation.

The inactive [optional GitHub runner controls](../workflows/bazel-native-qualification.yml.in)
use `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15` and `macos-15-intel` for bounded controls.
These runners are not the standing execution pools. The recipe executes an explicit
engine, report-consumer, native TypeScript, runtime,
browser and Darwin SDK control inventory, retains sanitized BEP and a frontend result,
and requests a CI report through the frontend's `--ci-report-file`. All three ordinary
controller, CI and expected-context diagnostic Files live in the uploaded retained directory;
an independent `always()` step requires each to be a nonempty ordinary File. An early blocked
expected-context diagnostic can contain a blocked object instead of an expectation array and
cannot supply admission authority. Its actual owned controller result supplies the independently
captured context and complete nested report batch. The standalone
`//tools/bazel/packaging:ci_admit` commands retain or reconstruct
diagnostics. Trusted controller bootstrap, engine/pool qualification and complete unsigned
producer orchestration remain pending. A blocked
frontend report, missing expected context or failed control cannot qualify the platform.
The recipe does not clear global qualification entries or certify the complete workspace.
Before any configured control analysis, the trusted controller must initialize the complete
test inventory, capture its authoritative reservation and materialize the complete nonce
repository. Initial and final planning and execution receive the internal engine argument
`--override_repository=verification_revocations=ABS_CAPTURED_DIRECTORY`. This captured
directory requires reservation-origin and current-ledger checks; a supplied path or saved
repository is never admission authority. The adapter that supplies it is not implemented
in these inactive templates, so their direct test controls refuse default analysis.

BuildBuddy shares build outputs and test results. Each test action must consume its own
authoritative nonce as a declared input. Forced verification durably rotates the selected
tests' nonces before execution; failed or cancelled attempts cannot promote a pending
epoch to reusable state. Terminal failure or cancellation durably retires matching reserved
nonces into new pending epochs; a newer independent reservation is preserved. This policy
does not delete BuildBuddy cache files.
An old in-flight upload retains its old nonce key and cannot restore the selected current
pass. Nonce Files enter test actions only, so revocation does not rebuild test binaries.
The hosted cache needs no deletion API or self-hosted cache-control service for this design.
The [standing execution contract](execution-pools.md) is hosted BuildBuddy Linux, hosted or dedicated Mac ARM,
and an actually registered Intel Mac x64 pool. Actual registration, platform identity,
SDK/source context and receipt authority are required. No pool names are invented by
the templates. GitHub jobs may act as trusted controllers without qualifying their own
machines as standing workers. Performance qualification requires a quiet worker held
exclusively for the measurement; a developer Mac running the daemon cannot qualify it.
Mac compiler/SDK inputs must be declared original operator-provisioned Files with the
applicable Apple distribution rights; the setup action does not supply team-owned SDKs.
Direct controls in this optional runner baseline disable
shared caches and remote execution and ignore local rc files. Its nested verification
frontend uses hosted BuildBuddy and requires an authenticated nonce-ledger client and
a private credential File. Its explicit provisioning operation requires the external
operator inputs and declared acquisition tools described above; it does not provision
the protected authentication service or qualify the shell/helper closure.
The image-bound Linux utility/Redis SDK cannot qualify an ordinary Ubuntu runner: a
compatible declared GitHub-native SDK and full native execution remain pending. No
ambient tool or existing hosted-image receipt substitutes for those inputs.

The optional recipe is not installed as a dispatchable workflow. Launching it requires
an authorized scratch workflow/ref containing the verified source and recipe, plus an
authenticated trusted controller using the declared expected-context producer. Retention removes command-line environment and unrelated
engine metadata through the existing BEP sanitizer; private raw BEP and engine state are not
uploaded. The report constructor does not establish provenance for an uploaded JSON file.
The retained original test-output inventory preserves every requested log and XML file as
base64 bytes with a SHA-256 digest and length; a missing output refuses retention. This
byte capture does not replace strict configured BEP, original JUnit or native-payload
admission. Browser controls exercise software rendering, not hardware performance claims.

The selected STUN attribution task produces a Rust-only intermediate with explicit pending
Bun/runtime and native release evidence. It cannot admit the unsigned-release lane.
The inactive [pre-commit contract](../../.githooks/pre-commit.bazel.in) fails closed until
the staged source/index/base frontend and its receipt producer are qualified; it does
not replace the installed hook.


The standing CI and unsigned artifact consumers share the root `verifyReservedBatch`
lifecycle. `captureControllerCiExpectations` reads the exact published expectations from
its actual owned `ControllerResult`, then reconstructs every nested `result.results`
report against that batch. `bindPreparedCiArtifacts` uses the same confirmation for
configured producer/output-group byte checks, with no second expected source context.
Neither consumer reserves or publishes again. A copied/uploaded controller result is
retention data and cannot recreate the in-memory authority. Cached confirmations reread
the original admitted controller's selected epochs before returning reconstructed reports
or bound artifacts, including after asynchronous artifact verification. Selected force
revocation invalidates the old handle; unrelated ledger updates do not. A published, non-admitted
result may support bounded reconstruction but cannot authorize signing or workflow
admission. The inactive recipes still require an actual authenticated controller launch,
its dedicated authoritative ledger client and qualified native SDK/execution pools; no
arbitrary supplied bare repository, expected JSON or job status supplies those facts.


The verification controller uses hosted `grpcs://remote.buildbuddy.io` for the shared cache
and BES, with ordinary test-result reuse governed by the declared target nonce. Only a run
with a private engine publishes there: it writes the shared cache and streams its build and
test commands' events. A run that keeps its engine reads the shared cache, writes this
host's disk cache alone (`--noremote_upload_local_results`) and streams nothing. No query
streams in either case, because its answer is its output, which the controller keeps. Nested
commands ignore every rc file. The declared BuildBuddy credential helper reads the one
literal `common` or `build` `--remote_header=x-buildbuddy-api-key=...` binding from the
original workspace's ignored `.bazelrc.local`; `--credential-file ABS_BAZELRC` selects a
CI-created credential File instead. Other options and imports in that File are not
evaluated. Only its path enters the helper's client environment; the key is returned
through the credential-helper protocol and does not enter command arguments or reports.
The helper refuses foreign or non-TLS hosts and missing or ambiguous credentials.
The controller downloads all outputs and keeps local JSON BEP File URIs so original
materialized output custody can be checked; hosted BES retains its own remote references.
This transport implementation does not establish hosted-cache or executor qualification.

The current CLI requires `--ledger-client ABS_DEDICATED_BARE_REPOSITORY`. Its report is a
`ControllerResult` containing `admitted`, nested `results[]` and `problems[]`; expectation
publication remains one canonical array. The actual declared engine/Git initializer,
reservation and local publication lifecycle is implemented and has bounded native fixture
controls. Authenticated hosted authority, complete nonce action binding and the native
pool matrix remain qualification requirements. Neither those fixtures nor a non-admitted
single-platform report qualifies standing execution. The setup action provisions a fresh
bare client from the explicit canonical HTTPS origin and original declared credential
helper. The controller captures those provisioning inputs into its own private bare client;
an arbitrary repository path or uploaded report cannot supply ledger authority.

CI report publication uses `--ci-report-file ABS_JSON` on the declared verification
frontend. The same owned controller result supplies its captured expectations and complete
report batch to the CI consumer before the controller finishes admission. Caller report
writes, cancellation and a newer selected revocation share the controller's terminal
boundary: a failed publication retires this attempt's still-current promoted nonces.
Partially written diagnostic Files are never admission authority. The standalone
`ci_admit reconstruct` command reconstructs supplied evidence for diagnostics only.

The complete native controller request is `--all --native-platforms
--executor-policy-file ABS_JSON`. Its independently captured executor policy must contain
all four native execution platforms. The frontend plans each platform separately, reserves
the selected tests once for the complete cohort, and dispatches each configured execution
through the same admission and failure-retirement lifecycle. Missing or repeated platforms
cannot shrink the batch. `--qualify-execution` requires that complete native request;
ordinary successful execution does not establish quiet hardware, shared-cache behavior or
performance qualification.

Execution qualification retains the complete JSON spawn log with Bazel log sorting
disabled. Placement validation reads one record at a time and checks every selected test;
log order supplies no authority. Both completed engine exit and complete build events
remain required, even when build outputs were produced before an engine failure.
The declared JVM exits immediately on memory exhaustion; incomplete events or logs refuse
admission. Shutdown uses the same JVM startup policy. Prepared CI, hook and editor
entry points pass that startup option explicitly because they ignore rc files. Ordinary
direct builds inherit the same startup policy and log-sorting setting from `.bazelrc`.

Adding `--unsigned` requires `--ci-report-file ABS_JSON` and
`--unsigned-output-directory ABS_FRESH_DIRECTORY`. One-platform verification materializes
only its complete captured producer output groups, with the original artifact basenames
and separate signing-input JSON. Complete native unsigned verification requires the entire
ten-artifact shipping inventory and retains auxiliary signing metadata separately.
The native request selects each platform's original daemon producer and, on Linux,
its original verifier producer. The Linux x64 invocation also selects the
original deployment, edge and STUN images, and `//release:unsigned_complete` notices.
Each configured producer must complete before its contract or outputs can enter the
same controller's report and admission lifecycle. Missing native suppliers refuse analysis.
That evidence uses the fresh sibling named by appending `.evidence` to the unsigned
output directory; an existing publisher is never overwritten.
Both paths bind their Files from the actual owned controller result, keep the creation
journals through final validation, and remove their created Files on failure. Uploaded
artifacts and diagnostic documents cannot reconstruct that live admission authority.

The controller report lists retained simulation attempt Files in `simulationDiagnostics`. Every
controller recipe runs the declared `//tools/bazel/ci:simulation_artifacts` consumer before owned
storage cleanup. It copies only those listed regular Files beneath the current physical temporary
root into a fresh runner artifact directory, preserving failed and cancelled attempts. Its physical
output parent must be outside owned temporary storage, including when caller parents use aliases.
The upload contains only selected copies; it does not scan temporary storage or grant admission from report
JSON. Empty diagnostic inventories produce no simulation artifact. These inactive recipes retain
the original qualification requirements for simulator execution, shared-cache behavior and pools.

The inactive editor template provides a current-file formatting task. It runs the declared
`//tools:format` entry point through the explicit pinned Bazel executable and passes
`${file}` as one process argument. After formatter and tool qualification, a developer can
also run `bazel run //tools:format -- path/to/owned.ts` with one or more explicitly owned
Files. The entry point rejects empty requests, options, directories, outside paths,
symlink escapes, duplicate Files and hardlinks before formatting. It compares the declared
configuration snapshot with the current ordinary `biome.json` before writing.

Formatting changes only the named working-tree Files. Review and stage those changes before
staged verification. The inactive pre-commit template continues to verify the captured index
without formatting or staging working-tree changes. The template does not enable format on
save, install editor settings or replace the active hook; those integrations remain behind
qualification.

The declared `//dev:stack` entry point shares the original development supervisor and
selects its native and runtime inputs through the declared Bazel engine. Run it with an
explicit absolute `--credential-file` and select `--server-only`, `--web-only` or
`--with-daemon` when needed. It requires the original workspace `apps/server/.env`; full
stack operation also requires the linked daemon configuration and the original
single-instance boundary.

The runtime copies only configured authored SourceFiles and the selected npm, WASM and
source-built Vite inputs. Saved mapped JavaScript and TypeScript sources update that owned runtime. The native
watcher observes the original checkout's dataplane Rust and Swift sources and asks the
declared engine for a fresh native build. Source additions
and renames require a fresh configured graph and rematerialization before owned services
restart. A failed rebuild leaves the existing services and last good daemon binary running.
Native binaries come from their actual configured build-event outputs; the image worker
remains beside the dataplane under its original basename. Closing the stack joins its
owned processes and builds before removing the runtime.

The entry point requires complete declared compiler, native, WASM and Vite producers.
Missing configuration or build inputs refuse startup. Its focused lifecycle controls do
not qualify a live stack or its native toolchain. Replacing the active development commands and installing the Bazel editor/hook setup
requires the proposal's complete qualification before cutover.

Manual original-source capture targets under `//tools/bazel/rust` expose the native
protocol, TPM and WASM graph recipes. `capture_protocol_wasm_context` writes a fresh
context File from the current SourceSDK; `capture_protocol_wasm` consumes that same
File. The checked-in context remains an ordinary source input. Capture output is
separate from native test, cache and platform qualification.

`//tools/bazel/browser:runtime_test` runs the original browser version and JavaScript/
WASM controls with the declared Chromium and headless-shell payloads. It remains
manual until native runtime qualification succeeds.

The active lanes run on Bun and Cargo: `bun run test:unit`, `bun run gates`, `rust:test`
and the workflows under `.github/workflows/*.yml`. The Bazel lane runs beside them. A test
or build script that needs a tool takes the one its runner declares, and a source run that
declares none takes the host's: Playwright's installed browser, the host shells, the
workspace's `zstd-fixture` build, `xcrun`'s Swift tools, and the session oracle from
`bun run scripts/prepare-client-session-oracle.ts`. The oracle reader validates a manifest
by the producer it states, Cargo or Bazel.

`bazel run //tools:unit --` selects the complete configured source-test inventory through the same
controller as `//tools:verify`. It requires the same declared Git SDK, pinned engine,
credential helper and explicit `--ledger-client` input. Its `--unit` selection cannot be
combined with another workflow selection; reservations, reports, retirement and admission
use the existing controller lifecycle. Every admitted plan carries the eight static
policies Bazel implements, so the unit selection runs them with the source tests. The ninth
static gate of the source lanes, `check:slop`, has no Bazel check and is a declared
qualification: the source lanes alone run it. Its rule files are still part of the captured
tree, because the lint policy formats them, and its test runs in the unit selection with
the declared Biome package. The ledger test remains
in the source inventory with its declared Git runtime.

The verification, unit, oracle and ledger-provisioning launchers bind
`//tools/bazel/tools:controller_git`, and provisioning binds `controller_sh`. On macOS
these are members of the source-built Git SDK, whose compiled `sh` is a real `bin` File;
on Linux they are the image tools. The engine's downloads persist in `<git common directory>/merkur-tools/bazel-repository-cache`,
which Bazel checks by digest, and its action results in `bazel-disk-cache` beside it.

A pass of a source test, a type check or a static policy is reused on the host that
produced it. The launcher materializes only a test's declared files, and a policy reads only
its captured tree and Git facts, so the pass is keyed by everything the check could read
plus its epoch. A run whose every check passes for unchanged source makes its test epochs
`ready` even while declared qualifications are outstanding; the batch is still reported as
not admitted. A run with failures keeps the epochs of the tests that passed, when its
reports are complete and consistent, and retires every other selected epoch, so an observed
failure revokes an earlier pass. The next run keeps a ready epoch, and Bazel answers an
unchanged check from the disk cache. `--force` rotates every selected epoch. These checks
are tagged `no-remote-cache`: sharing a pass between hosts stays behind the shared-result
qualification. The engine keeps `bazel-disk-cache` within 16 GB itself: once a kept engine's
server has been idle it removes the least recently used entries. Deleting the directory is
always safe.

A type check declares what the compiler reads for its project: the files
`tsc --listFilesOnly` lists (the project's own and everything they import), the project's
configuration chain, the `package.json` above each listed file, and the registry packages of
every lock importer those files belong to. The import inventory records that list for each
project and `generate_graph.py` renders it, so an edit re-runs the type checks of the
projects that read the edited file and no others. A file the list lacks is absent from the
check's tree, and the compiler fails on the import that names it. The two tooling projects
under `tools/bazel` are checked the same way.

A test that reads repository files its imports do not name declares them in
`tools/bazel/bun/runtime-inputs.json`: the files, the module roots whose imports it loads,
or the source groups it scans. Three script tests take the whole captured tree because the
repository is their subject (gate selection, the documentation policy and the entry-point
scan), and one because its fixtures are arbitrary real files (the latency boundary). A
check that declares Git carries Git's own runtime (its programs, the SDK's commands and
shared libraries, its templates and the certificate store), not the whole SDK.

The package set Bazel resolves mirrors `bun.lock`. After a dependency changes,
`bun tools/bazel/bun/refresh-npm-lock.ts` records the facts of each locked tarball it has
not yet verified in `npm-inventory.json`, writes a pnpm lock holding exactly Bun's versions
with each peer bound as its consumer sees it, has pnpm resolve that lock over a copy of the
workspace manifests, and replaces `pnpm-lock.yaml` only when the result has the same
package identities, integrities and dependency edges as the packages Bun installed. pnpm
applies its own policies to that resolution; it refuses a locked version published within
its release-age window. The import inventory and the generated build files are then
regenerated, since the inventory records the lock's digest.

The Rust declarations mirror the Cargo manifests the same way. After a manifest, the lock or
the workspace lint table changes, `python3 -I -B tools/bazel/rust/refresh_graph.py --bazel
<engine>` builds the declared Cargo SDK, runs Cargo's metadata over a private copy of its
source snapshot, and replaces `tools/bazel/rust/metadata.json`, the notice facts and each
crate's generated `BUILD.bazel` (its lint table included).
`tools/bazel/rust/refresh_source_inputs.py` then follows, because the macro inputs name the
snapshot. The SDK's registry is a tree every execution host's volume must hold, so it never
carries two names that differ only by case or by Unicode normalization: as when Cargo
unpacks an archive on such a volume, a directory keeps its first spelling and a later file
replaces the earlier one under its own name.

An unforced run also reuses planning answers. A configured graph is a pure function of the
engine, the selection, which captured paths exist, and the bytes of the files Bazel reads
while it loads and analyses: the build, module and Starlark files it reads by name, and every
workspace file it recorded reading for a repository rule or module extension, in
`MODULE.bazel.lock` and in the repository markers of the engine's output bases. Any other
source file reaches the engine only as an action input, so editing one keeps the graph.
`bazel-plan-cache` holds the last graph per selection beside the digest of those inputs, and
the engine is asked again only when the digest differs. A record Bazel wrote for a workspace
directory, which names no bytes, turns the reuse off. The test epochs are bound into each
plan when it is handed out, so a rotated epoch does not ask the engine again. A forced,
placed or artifact-producing run reads no earlier run's answers: it asks the engine each
question once and keeps the answers in its own evidence directory, where its later plans of
the same bytes read them. A plan that binds a fresh audit is never kept.

A run whose every check passed with declared qualifications outstanding also keeps the
whole pass: its expectation and evidence, beside the digest of the engine, the selection,
every captured byte, the Git facts and the epoch of each selected test. The next unforced
run with the same digest, whose selected epochs are all `ready` and which selects no check
that must run afresh, executes nothing. It rebuilds the report from the kept evidence,
states `recorded: true`, and is not admitted, as the run it repeats was not. An admitted
batch is never answered from a record.

An engine captures its source when it starts, since that and the Git facts are what every
earlier answer is keyed by. Its own inputs (the object pack, the payload and the context
repository) and its version check are made when the run first asks the engine a question,
and the source and Git facts must still be the captured ones when they are. A run answered
from a record never makes them and starts no engine command. A run reserves its test epochs
from the ledger snapshot it has already read: a reservation that writes is exchanged against
that snapshot, which the authority refuses if the ledger has moved, and one that writes
nothing is checked against the authority at admission.

An ordinary run also keeps its engine. Each checkout has one engine home in the user's
cache (`~/Library/Caches/merkur-verification/<checkout digest>` on macOS, the XDG cache
directory elsewhere) holding the output base, the server's `HOME` and `TMPDIR`, and the
frozen source copy at one stable path. The server stays up between runs, and one live run
holds a home at a time. A forced, placed, qualifying or artifact-producing run has no home:
its engine is private to the evidence directory and shut down with it. With a home, test
logs live under the home's output base until the next run replaces them.

A source test has one deadline: the one its target declares, which the engine enforces. The
launcher gives Bun that deadline for every case in place of Bun's default of five seconds, so
a case that launches a program is not failed by how long the host took to start it. The
engine schedules actions and tests by the host's cores; the controller sets no job count.

The report states where a run's time went. Each check has a `durationMs`, as the engine
states it for the attempt (a cached attempt states the execution it replays), and the report
has `stages`: the wall time this controller process spent in each kind of its own work, with
`elapsedMs` for the whole process. They are diagnostics and carry no verification fact.

A ledger read asks the authority for the current revision and transfers it only when the
client does not hold that commit; a revision the client pushed is one it holds.

The ratchet runs its health report beside its two audits. The audits themselves run one
after the other: without fallow's cache, which is not a declared input, each audit makes a
temporary worktree of the base commit and first removes any other audit's, both those its
repository lists and those it finds in the temporary directory, whichever process made
them. The analyses therefore get a temporary directory of the check's own, which no other
process's audit reads. The check holds its private tree and Git state across all three and
proves them once they have all ended; an analysis that could not run prints its own message.

Two more inputs are kept stable for an ordinary run. Git encodes an object pack differently
each time, so the pack handed to the ratchet is kept in `bazel-object-pack` beside the
digest of its object identities and read again for the same identities. A new pack is
encoded without a search for new deltas: it carries objects to one consumer on this host. Tests store their
stand-in executables by content digest under `bazel-test-executables`, which the sandbox
may write and which outlives the test: macOS assesses each new executable file once, in one
system service, and a store private to each test made every stub a new file. A placed run
has no such store. On Darwin the launcher also carries the pinned Apple
compiler export as a declared File and gives the nested engine its store; see
[the Darwin compiler acquisition](../../tools/bazel/tools/native/darwin-compiler.md).
A refused provisioning or oracle preparation states its cause; the engine's own output
stays in the named private evidence directory.

`//tools:prepare_client_session_oracle` runs the declared client-session oracle preflight. It builds `//tools/bazel/bun:client_session_oracle`
through the declared engine. It publishes that completed action's original manifest and
executable Files from the `oracle_manifest` and `oracle_binary` output groups. The reader
validates the same configured source and unit contract; an absent or stale artifact refuses
use. These entry points remain subject to the existing qualification-before-cutover boundary.
