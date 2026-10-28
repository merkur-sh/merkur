# Merkur Alacritty Terminal Patch

This workspace package is Merkur's pinned copy of the
[`alacritty_terminal`](https://crates.io/crates/alacritty_terminal) 0.26.0 library. The
root Cargo workspace overrides the registry crate through `[patch.crates-io]`, so both the
native daemon dataplane and the browser terminal Wasm compile against this exact source
tree. It is a library dependency, not a standalone Alacritty application; Merkur's
user-facing terminal, installation and configuration guidance live in the repository
[README](../../README.md). The upstream source is licensed under Apache-2.0; see
[LICENSE-APACHE](LICENSE-APACHE) and the package metadata for attribution.

## Merkur's changes

- Damage is tracked per line as a bitset, and `TermDamageIterator` yields line numbers;
  Merkur reads only which lines changed.
- `Term::input_str` (`src/term/mod.rs`) overrides the batched printable hook that
  `packages/vte-patch` adds. It receives only non-empty printable ASCII runs
  (`0x20..=0x7E`) and writes them a row-span at a time without rescanning. The parser
  classifies ground bytes in one forward pass and decodes non-ASCII characters once;
  DEL and every non-ASCII printable character reach `Term::input` individually.
- The grid carries image anchors (`src/grid/anchor.rs`, `src/grid/image_motion.rs`) that
  follow row rotation, reflow, scrolling and history retirement, so the graphics scene in
  `packages/merkur-graphics` binds placements to live rows without scanning the grid.
- APC and semantic-boundary callbacks from the patched parser are forwarded to the event
  listener.
- Each `Row` carries a capture key (`src/grid/row.rs`): every mutable cell access and row
  edit clears it, whole-row movement keeps it, and only the daemon's capture issues one, so a
  nonzero key proves the row unchanged since that capture wherever the row has moved.

## Moving it

Do not replace or upgrade this package independently of `packages/vte-patch`,
`packages/term-wasm`, the daemon dataplane, the lockfile and their conformance tests.

## Validating

Run from the repository root:

```sh
cargo test -p alacritty_terminal --locked
bun run build:wasm
bun run check:protocol
```
