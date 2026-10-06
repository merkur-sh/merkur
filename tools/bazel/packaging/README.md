# Unsigned package inputs

`unsigned_package` consumes one regular file from each declared producer. It emits a gzip
archive in ustar format and a separate signing-input inventory. Member order is lexical;
timestamps, ownership and gzip metadata are fixed. Executables have mode 0555 and other files
have mode 0444. Input labels, normalized modes, byte sizes and SHA-512 digests are inventoried.
The packager hashes the exact stream written to each archive member.

The rule accepts an explicit complete file inventory and a nonempty license inventory.
Missing, additional, duplicate, empty, unsafe or unexpectedly nonexecutable inputs fail.
Existing outputs are never overwritten. The declared native Python distribution runs the
packager in isolated mode; the action does not install dependencies, discover files, invoke
a compiler or hold signing authority.

The consumer validates the archive digest and every member against both its signing-input
inventory and its independent producer-label/mode contract before extracting executables.
It refuses overlays, extra members, links, extended metadata and unsafe permissions. It
checks the raw ustar headers and zero padding, canonical gzip metadata, the exact expansion
length and a single complete compressed member before creating an executable tree.

```sh
bazel test //tools/bazel/packaging:controls_test //tools/bazel/packaging:ci_admission_test
```

The production signer continues to require the exact inventory in
[release_assets.py](../../../scripts/ci/release_assets.py).

`//tools/bazel/packaging:deployment_unsigned` is the manual Linux x86_64 unsigned
deployment producer. It consumes the typed original `//apps/server:server` executable and
compiler-context File, `//apps/server:migrations` and
`//apps/web:frontend_precompressed` TreeArtifacts, the shared frontend UUID, and explicitly
declared nonempty source license evidence, and the mandatory typed
`//tools/bazel/packaging:deployment_notices` result for these same configured outputs.
It emits `deployment.tar.gz` in the `archive` output group and
`deployment.inputs.json` in `signing_inputs`, exposing the original external notice text
and inventory in `notices` and `attribution`. The archive contains exactly
`server/server`, the four current bundled migrations and every original/Brotli frontend
member. Source license evidence and the compiler context are separately hashed in the
inventory; they are not incompatible extra deployment members. Packaging binds the
external `NOTICES.txt` and its selected-provider inventory by original File, size and
SHA-256, retaining each provider's configured context and source-inventory digests.
Source license evidence cannot replace that dependency attribution.

The deployment notice join requires exactly nine selected scopes: server npm, first-party,
WASM and embedded runtime; migration npm and first-party; frontend npm, first-party and
WASM. A provider must carry the exact configured deployment output File and original
compiler context. The join independently checks every member of all three artifact
producers, published notice text digests, context hashes and the complete scope inventory.
Intermediate pending scopes remain in the resulting inventory and must resolve to another
exact selected provider; unknown obligations refuse production. It renders deterministic
notice bytes, then the archive action rechecks that inventory against its actual members
and server configuration. Missing, duplicated or foreign providers and changed notice or
artifact bytes fail before an archive is published.

`server_npm_notices` consumes the genuine `//tools/bazel/bun:server_npm_attribution`
compiler-selected intermediate. `server_first_party_notices` and
`migrations_first_party_notices` consume their actual selected Bun build providers; their
production action execution remains unqualified. `web_first_party_notices` requires the
actual selected `BunBuildInfo` carried through frontend precompression. Server WASM and
embedded runtime, and web npm and WASM remain absent; the web consumer cannot substitute
a source census for its selected module/asset provider. Consequently `deployment_notices`
and `deployment_unsigned` continue to refuse incomplete analysis. Generic Rust
descriptor attribution remains a source intermediate; it does not export a selected WASM
artifact provider. These missing scopes require their owning producers' selected artifact
and source authority. The synthetic
`deployment_notices_test` exercises complete scope joins and their negative controls; it
does not establish those production providers, native execution, or full ten-artifact
release attribution.

The deployment packager pins the physical presentation of each declared tree, then reads
members through no-follow descriptors. Member aliases, special files, missing migrations,
unpaired Brotli files, wrong frontend/compiler identity and a non-Linux-x86_64 server fail.
It rechecks complete tree membership, each retained file identity and bytes before returning.
Both archive output parents are retained before streaming. Parent replacement refuses
publication and cleans only the packager's owned outputs. The embedded-license and
deployment layouts share one canonical gzip/ustar stream writer; the original
`unsigned_package` still requires its nonempty embedded license contract.

`deployment_package_test` exercises these boundaries on the declared Python distribution,
including reproducible bytes and the independent service-layout consumer. Its ELF headers
and compressed contents are structural fixtures. Actual server execution, Brotli roundtrip,
Linux producer/SDK qualification, complete external attribution, all ten release artifacts
and hosted workflow orchestration remain required. Configured producer groups must pass
the existing same-controller CI evidence binding before any protected consumer acts.

[release-contract.json](release-contract.json) lists the exact ten unsigned artifacts
consumed by the protected signer, native installer, Railway and Fly.
It binds daemon members and service directories to the concrete compiler producers.
`release_layout_test` exercises exact artifact sets, native ELF/Mach-O architecture,
permissions, source aliases, daemon members, bundled migrations and frontend identity and
precompressed-file inventory. Its synthetic binary headers test rejection rules; they do
not establish executable behavior, Brotli roundtrip, archive or image closure.

Production admission still requires reconstructed engine evidence for the source, native
SDK, profile and output digests, complete locked dependency attribution, all four native
platforms, terminal PGO and Docker runtime images. A nonempty NOTICES file or a layout
check cannot supply those receipts. The inactive CI templates refuse admission while
these producers or qualifications are pending.

`reconstructProducerVerification` accepts the frontend's raw `VerificationEvidence` and
an independent source/commit/platform/check inventory. It validates the runtime schema
and recomputes the report, rejecting failed, incomplete, stale or pending evidence.
Qualified booleans cannot replace it. `bindProducerArtifacts` then resolves the independently expected producer configuration
and output group from sanitized engine events. It requires the complete expected output
group, rejects missing or extra files and duplicated destinations, and verifies regular
materialized files against the engine SHA-256 and size. It neither downloads nor assembles
outputs. `shipping_evidence_test` exercises reconstruction and output binding on the
declared Bun runtime.

This binding establishes the selected output group's byte identity. Full shipping
admission additionally requires the complete ten-artifact consumer inventory, member
layout and modes, dependency attribution, native runtime, SDK/profile/context and image
qualifications. The production CLI and archive/image producers must supply those facts
before the protected signer can consume the result.

`license-closure.py` consumes an independently expected producer/configuration/source
context and its exact package identities, with materializations bound to declared source
labels. It records each published root license/notice file and any explicit nested
`license_file`, preserving text bytes and recording SHA-256 and size. File and parent
directory descriptors are pinned while reading; aliases, missing or empty texts,
unresolved metadata, duplicate identities and missing or extra package trees fail.
Collection rechecks complete license membership, physical identities and every captured
text before returning; changes during collection fail without retrying.
`license_inputs_test` and `license_closure_test` exercise filesystem races and strict
closure rejection on the declared Python distribution. Their package metadata is a test
fixture. Actual Bun compiler membership, selected Rust binary closures and the pinned
embedded-runtime notices must supply the complete production inventory before this
consumer can generate shipping attribution.
`rust-license-metadata.py` validates effective captured package metadata against declared
Cargo manifests, including exact workspace inheritance and packages that declare only a
license file. It invokes no resolver or compiler. `rust_license_metadata_test` verifies
those rules on native TOML inputs. Production callers must provide the declared workspace
manifest and authoritative selected package closure.

`declared_package_tree` copies the exact file inventory beneath a declared Cargo manifest
into regular isolated files, using the declared native Python distribution. It accepts
the engine's input aliases only when each member resolves beneath that exact manifest's
physical package root. Empty and binary source files remain valid; redirected, missing or
duplicate members fail. Original package member and parent-directory aliases fail through
no-follow descriptor reads, including aliases that stay within the same package. It never
overlays a previous tree or scans an ambient package.
Output members are created exclusively through retained directory descriptors. Directory
replacement fails identity checks; failure cleanup unlinks only the recorded owned
inodes through those descriptors and preserves caller replacements.

The twenty manual `rust_attribution_<package>__release__<target>` targets consume the
selected Rust compiler descriptors, exact transitive package-source providers and declared
workspace license. They validate the complete reachable compiler unit graph and effective
Cargo metadata before producing `attribution` and `notices` output groups. The JSON records
package identities, source and manifest labels, manifest digests and published license text
digests. Local AGPL packages retain explicit repository ownership of `//:LICENSE` and any
own published notices. Both outputs are created exclusively; failed publication removes
only files created by that invocation. The publisher captures both parent capabilities
before creating either file, retains file identities through completion, and uses those
descriptors for cleanup. Replacing an output parent cannot redirect the second file.

```sh
bazel build //tools/bazel/packaging:rust_attribution_merkur_stun__release__aarch64_apple_darwin
bazel test //tools/bazel/packaging:rust_notices_test //tools/bazel/packaging:package_tree_test
```

These outputs identify themselves as Rust attribution intermediates. They carry pending
complete Bun/compiler runtime attribution and native release source/SDK/profile evidence;
they do not generate the final ten-artifact shipping NOTICES or admit signing. The
consumer must bind these output groups to reconstructed engine evidence before using
them. `generator.py --check` verifies provider declarations against all twenty selected
compiler descriptors without executing Cargo.
It requires the exact five-binary/four-platform filename and compiler-context set, plus
the corresponding selected binary, package identity and release profile. Merely supplying
twenty descriptors cannot replace a missing context.

`server_npm_notices` consumes `BunNpmAttributionInfo` from the actual standalone compiler.
Its native action independently replays imported-file ownership against original source
declarations and typed npm package trees. It binds compiler bytes, public settings and
the complete typed resolver inventory, then reconciles exact package metadata and locked
registry integrity before collecting published license texts. The action validates each
engine tree carrier against its complete ordinary package origin; aliases in the original
package fail. Prepared packages that combine separately produced files need an explicit
source authority and are refused by this single-origin consumer.

```sh
bazel build //tools/bazel/packaging:server_npm_notices
bazel test //tools/bazel/packaging:npm_notices_test
```

The two output groups remain attribution intermediates, explicitly pending first-party,
WASM and embedded-runtime notices. They use the same exclusive descriptor-based publisher
as Rust attribution and require reconstructed engine output evidence before consumption.
They cannot replace the complete shipping NOTICES or authorize signing.

`confirmCiExpectations` consumes only actual root-owned preparation capabilities and
publishes their complete expected-context batch through the frontend lifecycle. The
returned CI confirmation is owned in memory; JSON cannot recreate it.
`reconstructPreparedCiEvidence` reconstructs one report against the matching captured
invocation. `reconstructPreparedCiBatch` requires exactly one report per captured
invocation, reconstructs every report against its independently captured context, and
returns detached immutable verdicts in captured order. Missing, extra, duplicate or
coherently reduced report inventories fail. These verdicts do not establish final
nonce or execution-pool admission. The publisher returns the root writer's actual owned
`PublishedVerificationExpectations` receipt. The writer creates and flushes a canonical
context array through a genuine held `ReportOutput`, independently rejects destinations
inside every original or frozen source root, and verifies the exact ordered batch and
retained bytes before confirmation. Silent no-op, structural, copied, serialized, consumed,
closed or modified receipts refuse confirmation. A local publication receipt does not
authenticate hosted storage or worker evidence. The standalone `ci_admit reconstruct`
File command retains diagnostic reconstruction only. It requires a singleton context
array and refuses a whole serialized `ControllerResult` or multi-platform input rather
than selecting a context from a submitted report. Uploaded documents cannot establish
controller ownership or nonce admission. The adapter has
no engine dispatch or nonce promotion operation. Final configured nonce/action inputs,
SDK/pool identity and aggregate admission remain mandatory before an inactive CI workflow
can use it. `ci_preparation_test` uses synthetic engine fixtures with the actual local publication
writer to test ownership, byte persistence and refusal boundaries. It does not qualify
hosted execution or external storage.


`bindPreparedCiArtifacts` consumes that same owned confirmation and the complete report
batch. The controller supplies only its configured producer/output-group contracts and
materialized output namespaces, keyed by the captured invocations. No second source or
expected-context document is accepted. Every report is reconstructed against the captured
batch before any output is consumed; all producer inventories must cover exactly that
batch. Output bytes are then bound to the verified engine digests in captured platform
order. Caller report and contract arrays are detached before asynchronous reads, and the
returned inventories are immutable. This unsigned-byte consumer performs no nonce
promotion, signing or deployment. Authentic output namespaces, final nonce/action/SDK/pool
binding and complete shipping attribution remain obligations of the one verification
controller before the inactive workflows can use its result.


`captureControllerCiExpectations` reuses the existing `ControllerResult` from the one
`verifyReservedBatch` lifecycle. It reads only the root-owned captured publication batch,
then reconstructs `result.results` against that complete batch before exposing a CI
confirmation. Copied or uploaded controller results cannot recreate this in-memory
handle. It neither reserves nor publishes again. A published but non-admitted controller
result can establish bounded report or artifact bytes only; it cannot authorize signing.
Workflow aggregation and unsigned artifact checks must consume this same controller
batch. The controller's admission, nonce authority and complete shipping qualifications
remain required before any protected consumer acts.
Cached controller confirmations retain their original result. Reconstruction rereads its
selected epochs, and unsigned binding rereads them again after all awaited artifact reads.
A forced selected revocation refuses either consumer; unrelated ledger updates remain
valid. A saved `admitted` boolean cannot replace this current authority check.

`reconstructControllerCiReport` consumes the actual admitted `ControllerResult` in that
same process. It captures the existing owned CI confirmation, requires a complete admitted
result, and reconstructs every nested execution report against the captured batch. It
returns immutable `admitted`, `expectations`, and `reports` fields after another selected
epoch check. Copied, uploaded, failed, unqualified or forcibly superseded results refuse
construction. This is the CI report path for the frontend's `--ci-report-file`; serializing
the result retains the constructed report, without making its JSON a new authority.
`bindControllerCiArtifacts` is the unsigned-byte entry point for that same actual
controller result. It captures its existing expectations and binds the complete
per-invocation configured producer/output-group inventories through
`bindPreparedCiArtifacts`. Missing or repeated platform inventories, copied results,
failed retention, cancelled or pending batches and selected epoch revocation refuse
consumption. Awaited output reads finish before another authority check returns immutable
artifact bindings. Call it from the controller's publication callback so binding failures
remain inside failure retirement; retain its result with the report, without treating
serialized documents as signing authority. Complete native package producers and shipping
qualification remain required.

The frontend's `--unsigned` request requires `--all`, `--ci-report-file ABS_JSON`
and `--unsigned-output-directory ABS_FRESH_DIRECTORY`. The output parent must already
exist outside the source checkout, and the new directory must be separate from report
Files. Within the owning controller's publication callback, `stageCiArtifacts` copies
every bound selected producer output to its original configured basename, including
separate signing-input JSON. It rechecks the original engine bytes, the current controller
and its own creation journal. The caller holds that actual `OwnedDirectory` through final
validation and removes its created Files if publication, source checks or nonce admission
fail. A single-platform directory is that platform's configured inventory; it does not
establish the complete ten-artifact release. The complete native batch uses
`stageReleaseArtifacts` to require all ten original shipping artifacts and retain
signing metadata in the fresh sibling directory named by appending `.evidence` to the
unsigned output directory. Neither byte consumer authorizes signing.

The inactive editor and unsigned-release recipes invoke the verification frontend with
explicit authoritative bare-ledger and private credential-source paths. Their outer Bazel
launches ignore all rc Files, including local credential-source imports, and explicitly
bind strict action environments, concurrent-source guards, verified remote downloads and
complete output materialization. Credential-source options are parsed only by the declared
helper inside the controller; launchers do not announce or evaluate them. The editor unsigned
task requests `--all --force --unsigned` and a fresh absolute unsigned output directory.
It materializes only the current native platform's complete selected output groups through
the same controller; it does not request the full four-platform release inventory. The unsigned
release prerequisite uses `--all --force` once for its captured commit and retains distinct
controller, CI and expected-context documents on success or failure. Retention requires
all three ordinary nonempty Files; an upload that finds only one diagnostic cannot satisfy
that inventory. The assurance, dependency-audit and extended recipes use the same declared
controller entry point and explicit bootstrap outputs, with missing provider and complete
policy qualification barriers intact. Post-CLI artifact uploads retain diagnostics; their
job status does not recreate the controller capability or authorize unsigned shipping.
Native packaging jobs
require that prerequisite and continue to refuse incomplete producers. Setup must provide
an authenticated authoritative ledger client and a declared credential helper; a supplied
path alone qualifies neither. Bootstrap and controller transport bind HTTPS verification
to the original SDK's contained `ssl/cert.pem` certificate bundle and OpenSSL backend.
The controller reads the designated provisioning client's ordinary configuration File
without following aliases, parses the captured bytes with includes disabled, and imports
only its raw HTTPS authority, original absolute credential helper and Git object format
into fresh private bare metadata. Arbitrary helpers, URL rewrites, includes, proxies and
extra HTTP headers refuse capture. Later changes to the caller's client do not reach the
controller's transport. Verification and redirects are fixed for the exact authority URL;
the original SDK CA bundle supplies trust without an ambient store or verification bypass.
These recipes stay inactive until native execution, complete artifact inventories and shipping controls are qualified.

The post-signing package smoke matrix preserves the original native release consumers on
Ubuntu x86_64, Ubuntu ARM64, macOS ARM64 and macOS Intel GitHub runners. It restores retained
signed bytes against the release CAS record before extracting the exact platform daemon archive
and invoking the original installer smoke checks with their version, sequence and signature
inputs. These consumers do not establish compiler placement or quiet performance qualification.
The inactive staged hook and editor task use `--staged` with that same controller and
explicit paths. Their acceptance requires exact index-byte materialization, immutable HEAD
and index identities, declared staged secret scanning and index/base ratchet, and an index
recheck before admission. Working-tree verification cannot satisfy that staged contract.


`server_first_party_notices` and `migrations_first_party_notices` consume the
original `BunBuildInfo` selected compiler inventory, settings, source declarations
and output artifact. Authored package trees retain the original manifest and exact
source File labels. The consumer reconciles each selected source with its authored
bytes; unused source files and packages do not become attribution components.
Typed npm origins account for selected registry inputs. Typed WASM packages retain
their original producer inventory and complete generated member bytes. A selected
generated member requires that exact physical origin and compiler/declaration owner;
it does not become an authored component. An input lacking authored, typed npm or
typed WASM custody refuses collection. WASM member custody leaves its configured
Rust/license closure and embedded-runtime obligations pending.

Each selected package keeps its explicit name, version and license from its own
manifest and its complete published root notice texts. A package declaring the
repository's license also records `//:LICENSE` with separate repository ownership;
a package under a different license must provide its own text. The notice inventory
binds the selected output's exact regular-file bytes and member modes. The deployment
join independently compares those artifact facts with the bytes it packages.

These are first-party scopes, with npm, WASM and embedded-runtime obligations still
explicit. They do not certify the complete service or ten-artifact release.
The native `native_bun_attributions` factory uses those same first-party and npm
collectors for daemon and release-verifier producers. The native first-party
collector requires one of the four declared Bun compile targets. Its artifact facts
retain the original executable basename; the native packager separately names the
archive destination. Root authored packages retain `//:package.json` and exact child
Bazel source File labels mapped to their original workspace-relative members. The root
component version is the original declared compile-context release version; other authored
packages retain their explicit manifest versions. A missing root build version refuses. Generated
WASM inputs require their own typed source custody; native runtime and WASM notice
scopes remain separate required providers.

The migrations build's development context is not a shipping release context.
The web first-party consumer requires its actual selected module/asset provider through
precompression, complete original/Brotli member pairs and the canonical frontend marker
matching its configured UUID. Each final member must match the same compiler artifact map;
private compiler copies cannot replace the original selected source Files. Missing
deployment scopes continue to refuse analysis, and controller, signing and workflow
activation remain separate gates.
`first_party_notices_test` uses synthetic producer bytes to test source, license,
context, omission and artifact custody; it is not native release qualification.

Migration first-party attribution reconciles the complete emitted tree against the original
compiler inventory's output member names, sizes and SHA-256 values before publication.
The common compiler inventory retains original compiler estimates in `outputs` and one
mandatory actual emitted-member map in `artifacts`, whose sizes and SHA-256 values bind
both standalone executables and bundle trees. The standalone member must equal the exact
declared executable basename. These facts require the original configured build Files;
synthetic inventories do not establish producer execution or release qualification.

The first-party collector anchors generated TreeArtifact inputs to the original execroot
namespace using its already-captured compiler configuration File and exact declared path
suffix. It reconciles the complete sandbox presentation and every member carrier with the
corresponding original producer member, then reads the original tree through the unchanged
no-follow walker. Missing members, foreign same-byte targets, changed carriers and original
producer-member aliases refuse; this does not relax the deployment packager's generic tree
contract or infer origin from a member's content.

`migrations_npm_notices` consumes the same `BunBuildInfo` used by migration first-party
attribution through `//tools/bazel/bun:migrations_npm_attribution`. Selected registry packages
must match the original typed npm source Files, compiler input bytes and declaration owners,
original lock integrity, package metadata and complete published root license texts. Every
source declaration requires `input`, `link`, `owner` and portable relative `canonical`
placement. Canonical compiler input keys resolve direct declarations of the original Files;
an alias placement cannot substitute its source or owner, and private compiler copies never
become source authority. The consumer reconciles its actual migration TreeArtifact against the common compiler artifact
map and keeps `first-party` pending. The deployment join requires that exact migration
first-party provider to resolve the obligation and checks both scopes against the same
migration output bytes. Standalone npm producers retain their original labels and the
explicit first-party, WASM and embedded-runtime obligations. Missing web/WASM/runtime
providers still refuse deployment analysis; the full ten-artifact release inventory,
hosted execution and complete release attribution remain unqualified.
