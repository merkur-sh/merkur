# Declared Darwin compiler acquisition

`darwin_compiler_archive` consumes the pinned export of the Apple compiler and macOS
SDK. Apple's licence forbids publishing that export, so the declaration names no
origin: `darwin-compiler-arm64.json` pins the export's SHA256 and size, the Xcode
release it is taken from, the exact strip prefix, execution CPU, all eight native tool
paths, SDK/resource/C++ header directories and original license members. The bytes
come from the one machine-local directory named by `MERKUR_DARWIN_COMPILER_STORE`,
which holds the export as `<sha256>.tar.gz`. The repository links that File, watches it
and has the extractor check its digest and size. A missing variable, a missing archive
or differing bytes refuse the repository with the export command; no developer
directory, `PATH` or `xcrun` is consulted. The repository does not decode or
authenticate an XIP itself.

The pinned release is Xcode 26.5 (17F42) for `aarch64`: SHA256
`9987b57648688edcb4883c1a45fc164d81b6c8db7046536eecf05175b0b9f967`, 455103601 bytes.
Verify the bundle's Apple signature, then export it into the store:

```
codesign --verify --deep --strict /Applications/Xcode.app
python3 -I -B tools/bazel/tools/native/darwin-export.py \
  --source-bundle /Applications/Xcode.app --execution-cpu aarch64 \
  --archive "$MERKUR_DARWIN_COMPILER_STORE/<sha256>.tar.gz" \
  --compiler-extractor tools/bazel/tools/native/darwin-compiler.py --output <result.json>
```

Two exports of the same release are byte-identical. Direct Bazel commands receive the
store through `common --repo_env=MERKUR_DARWIN_COMPILER_STORE=<absolute directory>` in
the ignored `.bazelrc.local`. The verification launchers carry the acquired archive as a
declared File, and the controller gives its nested engine the same store through that
File's physical directory, never through an rc file.

The repository reads the stored export and downloads a separately pinned standalone
Python distribution. It extracts the archive without running package scripts,
rejects conflicting members and escaping aliases, and verifies the declared CPU
and executable role of clang, clang++, ld, ar, ranlib, nm, strip and objdump. Native
runtime dependencies resolve through their actual loader-relative and inherited
rpath chain inside the original closure. Only `/usr/lib` and `/System/Library`
runtime dependencies belong to the explicitly constrained macOS executor image.
No basename substitution, ambient developer directory or ambient utility tool is
used to satisfy a missing member.

The generated repository materializes canonical archive members as generated Files
and unresolved symlink artifacts. This preserves colon filenames and recursive
framework aliases without expanding directory aliases into a TreeArtifact. The
original archive is also an input to the complete closure. SDK actions repeat the
original pin and member inventory checks before compiler consumers can execute.
The repository exposes this closure through a `cc_toolchain` and a constrained
`native_toolchain`. `darwin_config` sets the native
CPU and explicit deployment target, SDK sysroot, Clang resource headers, C++ headers,
compiler/linker tools, declared tool search directories and deterministic archiver
environment. The standard `CcToolchainInfo` supplies consumers with those Files and
configured action flags. Consumers select compiler and linker artifacts through
`cc_common.get_tool_for_action`; action configurations use generated File tools.
Creating the repository requires nonempty execution
constraints identifying the qualifying macOS image; the deployment target is the
minimum target OS, not a substitute for the compiler's execution OS requirement.

The root module declares `darwin_arm64`. The extension also generates
`@darwin_registration`: one `toolchain` per declared compiler, and an `execution`
platform that is the host plus the executor constraints of the compiler declared for
that host. Registration lives outside the compiler repository, so toolchain resolution
on a host without the export never fetches it. `//tools/bazel/cc/native:xcode_26_5_17f42`
is the executor constraint; a standing Mac pool must carry it on its own platform.
No `darwin_x64` compiler is declared. Archive structure controls use real tar
extraction and nonexecuted structural Mach-O images. They prove extraction and closure
checks, not SDK completeness, native executor qualification or reproducibility of
compiled outputs.

`darwin-export.py` accepts an explicit, independently Apple-signature-verified
bundle and mandatory `--execution-cpu` (`aarch64` or `x86_64`). Every selected original
executable and library must contain that native CPU; the exporter does not select a CPU
from the host. It copies only the Apple default compiler closure, macOS SDK and original
license whitelist, preserves original symlinks and bytes, and produces deterministic
archives. It does not discover Xcode or read developer account settings.
`--specification-output` writes the pin: the archive's SHA256 and size, the release
read from the bundle's `Contents/version.plist`, and the original member roles with
`original` as the strip prefix. Local source paths stay out of it.

`darwin_compilers` in `darwin-extension.bzl` accepts explicit root-module `compiler`
tags. Each tag declares `platform` (`darwin_arm64` or `darwin_x64`), a strict source
`specification` JSON label, `deployment_target` and `executor_constraints` labels.
It creates the corresponding `compiler_darwin_arm64` or `compiler_darwin_x64`
repository. An absent tag creates no compiler repository; acquisition of one explicitly
specified CPU does not invent the other. Duplicate declarations, CPU mismatches,
missing executor constraints and unsupported acquisition hosts fail closed.
Repository bootstrap selects the existing original standalone Python pin for the
actual Darwin/Linux ARM64/x64 acquisition host. The extension records its OS and
architecture dependencies; it does not select compiler sources from ambient Xcode.

The original export also retains the public Swift compiler driver, frontend, plugin
server, host/target modules, resource directories and their loader closure. Only
the specific Apple `llbuild.framework` runtime dependency extends the default
compiler/SDK whitelist; no other shared framework or developer account resources
are selected. Original directory aliases stay unresolved symlink Files.

`darwin_swift_sdk` selects these Files from the same `DarwinCompilerSdkInfo` used
by Cc consumers. That provider has one canonical identity in `providers.bzl`.
The Swift selector exports standard `TemplateVariableInfo` for the pinned
`cargo_build_script` toolchains interface. Its complete File closure belongs to
the existing build-script action, and `darwin_swift_build_environment` supplies
`MERKUR_SWIFTC`, `MERKUR_SWIFT_SDK`, `MERKUR_SWIFT_TOOLCHAIN` and the exact frontend
path through those variables. The configured Cc toolchain still owns `AR`. No
SDK directory path is discovered or substituted from the host.

`darwin_swift_identity_control_test` consumes the original compiled identity
build-script executable and the same configured Cc/Swift SDK. It retains all nine
controller controls, then compiles a public pure fixture and the original identity
bridge into unsigned objects and archives in two independent output roots. It
compares the exact artifact bytes without executing identity or Keychain code. The
compiler uses `-Xfrontend -disable-incremental-llvm-codegen`: Bazel owns incremental
action reuse, so Swift does not embed its path-dependent incremental module hash.
The original archive tool receives `ZERO_AR_DATE=1`. The control is a regular
nonce-bound test; its nonce is absent from the compiled Rust controller's inputs.
