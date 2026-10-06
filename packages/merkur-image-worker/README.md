# Isolated image processing

This package implements the confined processing component of the
[terminal graphics contract](../../docs/graphics.md). The daemon terminal launches the
sibling `merkur-image-worker` executable for inline query, transmit and
transmit-and-place commands. Local daemon builds, native harness artifacts and signed
release archives include it, and an installation is not activated unless all three sibling
executables are present.

## What runs where

The executable decodes; the library supervises. The executable starts with a clean address
space and a sanitised environment, closes unrelated descriptors, installs resource limits
and OS confinement, then emits a fixed readiness record before it reads any image bytes.
Sandbox failure terminates the job. There is no unsandboxed decoding path.

The library owns process supervision, not the decoder. Output enters trusted private memory
through a pipe; shape, reserved bytes, dimensions, byte count, EOF and successful process
exit are checked before pixels are returned. A rejection names one known failure class and
sets no other field. Cancellation kills and reaps the process, and an interrupted cleanup
retains its reservation rather than exposing the same capacity to another process.

## Sandbox

| Platform | Confinement |
| --- | --- |
| Linux | seccomp syscall allowlist with architecture validation and no-new-privileges |
| macOS | Seatbelt with an explicit BSD syscall allowlist; Mach traps and kernel MIG calls denied, including the legacy process-argument sysctl that default-deny alone does not block |

On Darwin the launcher sets `MallocNanoZone=0`, `MallocMaxMagazines=1` and
`MallocMaxMediumMagazines=1` before exec, so the system allocator does not reserve a nano
heap or per-CPU magazines beside the fixed Rust arena in this single-threaded executable.

## Decoder inputs and limits

The decoder accepts RGB, RGBA or PNG, with optional zlib compression. Base64 is decoded in
bounded chunks outside the terminal owner. It validates dimensions, lengths, PNG CRCs and
complete compressed input. Pixels are straight-alpha RGBA8. A PNG `gAMA` is corrected for
a 2.2 display gamma exactly as libpng does for Kitty, including 16-bit samples before
their reduction; sRGB images and gammas within libpng's 5% threshold are unchanged, and
embedded ICC profiles and chromaticities are not applied. A failure reports one fixed
class, never decoder text: short uncompressed pixels, an undecodable PNG, or any other
invalid input.

| Limit | Value |
| --- | --- |
| Encoded input after base64 | 64 MiB |
| Pixels per image | 16,777,216 |
| Largest dimension | 16384 |
| CPU time per job | 8 s |
| Supervisor work budget (startup plus final validation) | 8 s |
| Rust arena, statically mapped | 384 MiB |
| Address-space reservation per job | 768 MiB |

The work budget does not cover the time an application spends sending chunks. Freed arena
blocks are reused without kernel allocation. Before readiness, Linux audits total mapped
address space and macOS inventories every writable mapping, including shared-cache
submaps; the process refuses to start if its inventory exceeds the reservation. After
confinement, mapping, unmapping and protection changes are denied through both BSD and
Mach interfaces. These are resource bounds, not measured memory use.

## Native submissions

Native callers use the same executable, result validation and immutable source commitment.
The source is a file descriptor on stdin with a fixed request describing its byte extent
and decoding metadata. After confinement the helper checks a regular file with
descriptor-only `fstat`, takes a bounded private copy with positional reads and closes the
descriptor before decoding. The supervisor neither reads nor maps external mutable
storage; short reads and truncation fail validation, and the sender's file offset is
unchanged. Path opens and Linux `statx` remain denied. The terminal's
[native image API](../../docs/native-images.md) authenticates local callers and holds
validated results behind one-use parser references.

## Source manifests and retirement

After a successful decode, a bounded blocking job hashes the canonical pixels and commits
their dimensions and pixel interpretation in a 40-byte source manifest. The returned image
retains that manifest, so display capture never hashes pixels. The manifest's root is
independent of transfer encoding, tiles and resolution levels; it identifies content and
grants no authority to request it.

Image storage stays charged until physical destruction. A final reference release queues
a preallocated retirement record; a dedicated thread wipes and frees the source before
refunding its lease, and one completion covers a whole released subtree. The daemon
charges terminal-local and process-wide domains atomically, and the process-wide
processing domain admits at most two workspaces with their queues.

## Uploads

`upload::Upload` is a fixed-capacity queue of 16 chunks with nonblocking admission. The
terminal retains its one bounded APC payload and parks on full capacity; exact queue state
and job completion decide resumption, and notifications only wake the owner. Final
results carry the publication fence supplied at job creation, which the terminal must
still check against its current scene. Lifecycle owners join cancellation before shutting
down the async runtime.

## Tiles, pyramids and the encoder pool

`tile::Encoder` reads validated source rows into reusable Up-filter scanlines and writes
PNG at libdeflate level 1 into supplied output storage. Its C context lives in one
pre-admitted 512 KiB arena through per-instance allocation callbacks; the small FFI module
is the library's only unsafe-code exception. `encoding::Pool` owns two contexts, each with
its encoder and a reusable output span, admits before queuing blocking work and retains
every lease through worker retirement. Each tile is one exact-length copy out of that
span, and the span's encoded prefix is wiped before its context returns to the pool. No
tile is cached, and derived bytes confer no access after their source leaves the scene.

Reduced tiles use a depth-first row pipeline over the requested source footprint,
including gutters. Two rows per level fit in 131,184 bytes of reusable scratch, so there
are no whole-image mip allocations. Output is byte-identical to a whole-level
alpha-weighted linear-light reduction, including odd edges.

## Animation composition

Composition runs in the same confined executable. The owner streams only the affected
tile-aligned base region and the source patch; the helper applies checked replacement or
straight-alpha source-over and returns private pixels through the validated output pipe.
Frame trees share unchanged leaves and path-copy changed branches, and raster consumers
read contiguous spans across those leaves, so encoding and reduction never flatten an
animation canvas. Publication remains the terminal owner's decision.

## Tests

Tests run the real executable for every supported inline format, exercise queue
saturation and cancellation, inject hostile output into the supervisor and run OS denial
probes. Release tests are required as well as debug tests, because optimised address
arithmetic must agree with the arena symbol's linked alignment. The browser suite in
`tests/e2e/terminal-graphics.e2e.ts` launches a foreground PTY client through a real
session and checks replies from the packaged helper; it is part of the default transport
harness.

Run from the repository root:

```sh
cargo test --locked -p merkur-image-worker -p merkur-graphics
cargo test --release --locked -p merkur-image-worker
bun run test:e2e:transport -- tests/e2e/terminal-graphics.e2e.ts
```
