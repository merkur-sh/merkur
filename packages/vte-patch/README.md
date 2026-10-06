# Merkur VTE Patch

This workspace package is Merkur's pinned copy of the
[`vte`](https://crates.io/crates/vte) 0.15.0 parser. The root Cargo workspace overrides
the registry crate through `[patch.crates-io]`, so the native daemon dataplane,
`packages/alacritty-terminal-patch` and the browser terminal Wasm all compile against this
exact source tree. The upstream source is licensed under Apache-2.0 OR MIT; see
[LICENSE-APACHE](LICENSE-APACHE), [LICENSE-MIT](LICENSE-MIT) and the package metadata for
attribution.

## Batched printable runs

`Parser::advance_ground` already holds an entire run of printable text as a `&str`, and
upstream fans that run out one character at a time through `Perform::print`. Every
character then pays a fresh grid index, a fresh template read and a fresh bounds check
inside the terminal. The patch adds a batched hook so a consumer writes the whole run in
one pass:

| Hook | Role |
| --- | --- |
| `Perform::print_str` | A run of printable characters. Defaults to a per-character `print` loop, so existing implementations are unaffected. |
| `Parser::ground_dispatch` | Splits ground-state text at C0/C1 controls and hands each maximal printable run to `print_str`. |
| `ansi::Handler::input_str` | The same batched hook one layer up. Defaults to a per-character `input` loop. |
| `ansi::Performer::print_str` | Forwards the run to `Handler::input_str` and updates `preceding_char` from its last character. |

`alacritty_terminal`'s `Term` overrides `input_str` with a bulk row write; see
`packages/alacritty-terminal-patch/src/term/mod.rs`.

## APC framing and semantic boundaries

The same parser frames Kitty graphics commands. `Perform` and `ansi::Handler` expose
`apc_start`, `apc_put` and `apc_end`; payloads are borrowed slices, and the parser owns no
image storage. A command completes only after the full seven-bit string terminator. CAN,
SUB and unrelated escapes cancel it. Other C0/C1 bytes inside an APC are opaque payload for
the application receiver to validate, not terminal actions. SOS, PM, OSC and DCS cannot
dispatch graphics callbacks.

`ansi::Processor::advance` returns the number of accepted bytes. A handler that sets
`semantic_pending` owns an asynchronous semantic boundary: the caller must retain the
unaccepted suffix and resume after completion. Released synchronized buffers retain their
own unread suffix, and an empty advance can resume them. Neither an ESU completion epoch
nor a forced release bypasses this boundary. Alacritty forwards these callbacks to its
event listener; the daemon's listener feeds them to the graphics receiver and reports
`semantic_pending` while an image job is paused, as the
[graphics design](../../docs/graphics.md) describes.

## Moving it

Do not replace or upgrade this package independently of
`packages/alacritty-terminal-patch`, `packages/term-wasm`, the daemon dataplane, the
lockfile and their conformance tests.

## Validating

Run from the repository root:

```sh
cargo test -p vte --locked
cargo test -p alacritty_terminal --locked
bun run build:wasm
bun run check:protocol
```
