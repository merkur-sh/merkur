# Merkur VTE Patch

This workspace package is Merkur's pinned copy of the
[`vte`](https://crates.io/crates/vte) 0.15.0 parser. The root Cargo workspace overrides
the registry crate through `[patch.crates-io]`, so the native daemon dataplane,
`packages/alacritty-terminal-patch` and the browser terminal Wasm all compile against this
exact source tree. The upstream source is licensed under Apache-2.0 OR MIT; see
[LICENSE-APACHE](LICENSE-APACHE), [LICENSE-MIT](LICENSE-MIT) and the package metadata for
attribution.

## Batched printable runs

`Parser::advance_ground` classifies ground text in one forward pass, out of line from
the per-byte state machine. C0 controls execute as they come, and ESC enters
`escape_from_ground`. A block scan finds each printable ASCII run (`0x20..=0x7E`) and
hands it to the terminal, which does not scan it again. Text that goes on past DEL or an
eight-bit byte is observed once up to the next C0 control and split into ASCII runs and
UTF-8 characters, which the parser validates and decodes once: C1 controls execute and
every other character is printed individually. Malformed sequences keep the standard
replacement semantics (`str::from_utf8`'s error lengths), and an incomplete character at
the end of a read is completed by the next one. C1 controls and replacement characters
inside such text are therefore observed together with the text around them.

| Hook | Role |
| --- | --- |
| `Perform::print_str` | A non-empty printable ASCII run (`0x20..=0x7E`). Defaults to a per-character `print` loop. DEL and every non-ASCII printable character use `print` individually. |
| `ansi::Handler::input_str` | The same non-empty printable ASCII contract one layer up. Defaults to a per-character `input` loop; other printable characters use `input` individually. |
| `ansi::Performer::print_str` | Forwards the ASCII run to `Handler::input_str` and updates `preceding_char` from its last character. |

`alacritty_terminal`'s `Term` overrides `input_str` with a bulk row write. It trusts the
parser's ASCII classification and does not rescan or decode the run; see
`packages/alacritty-terminal-patch/src/term/mod.rs`.

## Controls from ground text

When ESC `[`, `]` or `P` follows ground text in the same read, the parser consumes
the CSI, OSC string or DCS in one out-of-line call with the per-byte table's semantics.
OSC payload is scanned in 16-byte blocks and stored in bulk; an OSC continuing into
the next read resumes in bulk. Bytes the per-byte machine would execute or cancel on,
a CSI or DCS split across reads, and DCS continuations go through the per-byte machine.
Consumed bytes are observed as slices before the actions they cause. Termination is
honoured after dispatches; printing, execution, payload, hook, control-boundary and
observation callbacks must not start terminating parsing.

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
