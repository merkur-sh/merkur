# Worker compiler contract

The local Rust worker is disabled in production compiler units. The stock pinned Rust
compiler randomizes a seven-character invocation suffix for incremental object files.
Those names also enter rlib archive members, metadata links, and debug references.
Retained and fresh incremental state with the stock compiler cannot satisfy artifact
byte parity. The source patch is an unwired candidate.

`compiler-patch.json` pins the compiler source archive, source commit, three exact patch
bases and results, the patch, and the matched native LLVM archive. `prepare-compiler.py`
verifies these source pins before creating a new source directory. It applies the patch
with `git apply --check` and verifies the resulting source bytes. Preparing source does
not qualify a compiler, runtime, toolchain closure, or worker.

`prepared_compiler_sources` consumes the original compiler archive File and the existing
native Git SDK provider. Its action includes the full Git and Python distribution Files,
uses the provider's original Git executable, and seals Git's libexec, templates, library
and configuration environment. The standalone preparer requires the same explicit SDK
configuration, pins File and patch File; it never discovers Git through the host or PATH.

The patch introduces `-Cdeterministic-incremental-temporaries=yes`. This tracked codegen
option selects the fixed seven-character invocation suffix `0000000` only when
incremental compilation is enabled. The default remains disabled. Incremental cache
session names retain their upstream randomness. Changing the option changes the
compiler context; artifacts and scratch state from different contexts cannot be shared.

The option requires a private, single-writer invocation namespace. Each worker slot owns
its copied workspace under an exclusive lease. Before every request it unlinks all
material except verified, retained declared input files, without following symlinks.
Compiler outputs and cached-object aliases must be unlinked, never truncated in place.
Only the separate incremental cache survives. Cancellation kills and waits for the
compiler before the next request can purge or publish outputs. Independent slots may
use equal temporary names because their output namespaces are disjoint.

Serializing WorkRequests does not exclude a proc macro spawning another compiler into
the same output directory. Current process confinement does not establish that descendant
role boundary. Compiler actions with executable proc-macro inputs are ineligible for this
option until descendant execution isolation or audited purity and child-process controls
are qualified. The native worker unit controls do not prove this additional obligation.

A compiler build must use the exact prepared source, source-pinned vendored dependencies,
bootstrap tools checked against `src/stage0`, and the pinned matching LLVM artifact.
Setting the target's explicit `llvm-config` prevents an LLVM source-build fallback.
Record the bootstrap configuration, environment, native compiler and SDK identities,
build output, and resulting compiler/runtime file hashes. An experimental native host
build is not a hermetic, redistributable toolchain acquisition rule. Custom compiler
identity and its complete sysroot must be declared together; metadata from stock and
custom compiler contexts must not be assumed compatible.

Enabling this option requires successful complete-artifact comparisons for repeated,
fresh-state, edited, and reverted requests; native consumer and test execution; concurrent
independent namespaces; cancellation followed by a new request; and default-disabled
behavior. Qualification must include the actual worker request and its declared compiler,
sysroot, SDK, source, dependency, environment, feature, target, and profile inputs.
Retained-state cost must also be measured. Until those controls pass, the option remains
unwired and `qualified_platforms` remains empty. Linux confinement is unsupported and
fails closed.

Stateless execution must preserve the same compiler incremental mode with fresh ephemeral
scratch. Turning incremental compilation off also changes codegen-unit partitioning and
names; this patch does not make those different compiler modes byte-identical. Local
retained-state and remote stateless action identities must remain distinct. Both full
codegen and early metadata actions must apply the same incremental mode and
`/merkur/execroot` source-path remap. The metadata action uses the pinned wrapper's
original JSON artifact completion event and fresh incremental scratch beside its declared
metadata output. The wrapper refuses existing scratch, retires its owned directory after
compiler completion or failure, and never retains that state between metadata actions.
Matching only compiler flags or sysroot does not preserve metadata identity.

The eligible compiler role is a Rust library leaf without executable proc macros. The
pinned process wrapper spawns its one compiler through the declared confiner. Both apply
the complete declared-input policy, and the compiler cannot fork. Cancellation addresses
the wrapper directly; its signal handler kills its exact, unreaped compiler PID. A compiler
changing its own process group or session, or closing its output pipes, cannot escape this
PID ownership. Kernel exit readiness preserves the PID until the wrapper blocks cancellation
and reaps it. Wrapper error paths also kill and reap the compiler. The worker reaps the
wrapper before completing the request. This bounded role does not qualify arbitrary
proc-macro or native-linker descendants.

An authenticated, fully validated output inventory defines the cleanup boundary. Every
subsequent staging, preparation, compiler, publication and cleanup failure attempts removal
of every declared public output. If caller-owned permissions make an output inaccessible,
the worker preserves those permissions and becomes unusable; it cannot assert that the
inaccessible output was removed or compile another request. Private worker directories may
be repaired for cleanup without following symlinks or changing declared input files.

Public output paths are resolved through held directory descriptors. Every parent is
opened with `O_DIRECTORY | O_NOFOLLOW`; publication creates fresh entries exclusively
and never truncates an existing hardlink. Cleanup removes aliases as entries and never
follows their targets. Declared directory outputs preserve their regular files and modes.
A redirected or inaccessible output parent fails cleanup and makes the worker unusable.

Readonly directory outputs retain the existing publication ownership descriptors across
requests. Only the same physical public root and unchanged directory entries receive
permission recovery for cleanup; a replaced caller tree receives no inherited chmod
authority. Private leased directories are restored before pruning. Public output modes
remain unchanged on successful publication.

`//tools/bazel/worker:process_scope` is an unqualified Linux namespace supervisor. Its
caller must pass its own inherited pidfd, opened before spawning the supervisor. Kernel
pidfd events close admission and parent-death races. `CLONE_NEWPID` is mandatory, with
no process-group fallback. The namespace's init executes the pinned process wrapper;
normal init exit or cancellation kills and reaps all namespace descendants before init
can be reaped. An outer supervisor uses exit readiness before blocking cancellation and
reaping its exact child. This also handles descendants changing sessions, closing stdio,
and ignoring catchable signals.

`process_scope_test` exercises real grandchildren with explicit startup and liveness
pipes, normal completion, cancellation and caller death. Missing Linux namespace authority
fails the controls. The supervisor is not connected to production worker actions: Linux
filesystem confinement, native process execution and supported compiler-role purity still
require qualification. Darwin retains its fork-denied leaf restriction. Darwin group
signaling snapshots membership, and unsupported kqueue descendant tracking cannot replace
recursive process ownership.

`//tools/bazel/worker:compiler_bootstrap_inputs` consumes the existing prepared-source
provider, the three original Rust 1.96.0 stage0 distributions named by that source's
`src/stage0`, and the commit-pinned LLVM 22.1.6 distribution. The declared native Python
action retains the original distribution contents, merges their SDK components without
overwriting files, and binds the complete Python/Git File closure in one configuration
manifest. It does not build a compiler or publish a Rust toolchain.

The fixed native ARM64 bootstrap configuration requires stage 1 `compiler/rustc`,
`library`, and `src/tools/rustdoc` together, with vendored, locked, frozen, offline
dependencies and compiler/LLVM downloads disabled. The configuration is preparation
data, not executable `bootstrap.toml`: execution requires an approved native
`CcToolchainInfo` with original compiler, C++, archiver, ranlib, linker, runtime and Apple
sysroot inputs. System tool discovery is not admitted. Upstream's conditional Darwin
runtime paths also name `install_name_tool` and `codesign`; any selected invocation must
receive their declared authority. Matched compiler and Rustdoc production qualification
remains incomplete until this native closure and an admitted executor exist.
