---
paths:
  - "apps/tui/**"
  - "packages/merkur-client/**"
  - "packages/merkur-client-native/**"
  - "packages/merkur-wire/**"
  - "packages/merkur-edge-protocol/**"
  - "packages/merkur-authorization/**"
  - "packages/merkur-identity-seal/**"
---

# Client core and the terminal client

`packages/merkur-client` is the one client implementation. The TUI (`apps/tui`, binary
`merkur-tui`) and browser workers run on it, through native and WASM adapters respectively.
It is sans-IO: events in, actions out, `now_ms` passed in, randomness
through `Entropy`. No tokio, no clock, no socket, so it builds for wasm32.
`packages/merkur-identity-seal` owns native key custody, one `KeyCustody` primitive on every
platform: explicit label selection, chip-resident or chip-sealed keys, hardware signing and
locked secret memory. The daemon keeps its one-shot identity CLI and bounded signing worker in
the dataplane.

- The core holds no delegate key. Every session and renewal proof is a
  `Session::take_signature_request()` the host answers with `Session::signed`; the core
  verifies the signature under the certificate before anything leaves. The lanes dial
  while the host signs, so an enclave's milliseconds overlap the QUIC handshake. The WASM
  adapter answers in the same turn with its software key; the native driver signs on a
  blocking thread (`Task::Signed`). Revocations take the signer explicitly and run off any
  reactor that carries input.

`packages/merkur-client-native` is the tokio driver: OPAQUE, the account API, the
WebTransport carrier and the loop.

- One implementation per wire fact. `merkur-wire` (channels, frames, input records,
  signaling) is shared by the dataplane and the client. `merkur-edge-protocol` (routing
  preface, splice events) is shared by the edge, the dataplane and the client, and stays
  serde-only so the edge links no session cryptography. `merkur-authorization` holds the
  records the daemon verifies and the client signs. Change a contract in all of them in
  one commit.
- TypeScript record parsing stays pure TypeScript: Playwright fixtures and `merkur start`
  have no WASM realm. The Rust and TS sides are pinned to the same
  `packages/shared/test-vectors/`.
- The core's tests drive a `Session` against `test_support`'s in-process daemon, which
  answers as `session::auth_flow` does. Extend it rather than mocking the core.
- The viewer applies display frames through `viewer::DisplayGrid`, which term-wasm's
  `Terminal` satisfies through `term-wasm::client_grid::ClientGrid`. Native clients
  re-export that adapter as `NativeGrid`; the adapter builds for native and wasm32.
  The terminal worker's rules are its spec: port a rule together with its TypeScript test.
- The host numbers every input record from its own counter; `session::outbox` (the port of
  `input-outbox.ts`) maps that onto the daemon's wire numbering and re-aligns it at
  genesis only. Every terminal frame carries the mapping it arrived under
  (`input_sequence::InputMapping`), so the viewer reads a display header's input
  coverage in the host's numbering. A record's modelled bit is revoked at every
  authentication.
- Every authentication, the first or a rebind's successor, fences the viewer with a new
  lineage. The viewer answers with its resume claim (`Output::Resume`), which the session
  sends as `DISPLAY_RESUME`. A rebound daemon holds its display until that claim arrives,
  then repairs only the rows that diverged, and the viewer holds the paint until they land.
- Speculative echo is a security boundary (rule `speculative-echo`): the host shows every
  record to `Viewer::input` before it sends it, and sends the answer as the record's
  modelled bit, exactly as answered. The viewer models only what the daemon's
  `record_is_modelled` honours, under the mode word's grant, with the terminal worker's
  barrier and trust rules. It re-examines a deferred verdict when a presentation commits,
  the event the worker's 18 ms grace approximates.
- Graphics: at each presentation commit that changes placements, the viewer projects the
  scene at the host's cell size (`viewer::graphics`, the port of `scene.ts`) and names its
  tiles. `session::graphics` asks the daemon for each tile it does not hold and reads the
  answer from a finite stream opened by `merkur-e2e`. It verifies the object with
  `merkur-graphics`' `TileVerifier` before `Action::GraphicsAsset` hands it over. Every
  authentication starts over, and the viewer states its scene again at the fence.
  While the host records performance evidence (`PERF_ENABLE`), the session tells each
  job's transitions as `Action::GraphicsJob`, an I/O action so its time never waits behind
  host output. A job is told whole or not at all, and ends in the session at `Published`;
  the browser's transport worker records `consumed` and `retired` once the terminal worker
  answers for the asset (`client_graphics_consumed`).
- Animations (`viewer::playback`, the port of `playback.ts`) play the daemon's own
  timeline from its manifest, sampled on the daemon's clock, which each datagram heartbeat
  answer maps onto the host's (`Action::GraphicsClock`). The host reports the tiles it
  holds (`Viewer::set_graphics_resident`); a frame advances only once its tiles are held,
  and the next is fetched ahead. Quads name bindings, which each animation maps to its
  current frame's tile. Only a visible, moving timeline owns a deadline.
- `session::geometry` (the port of `outbound-channels.ts`' geometry authority) claims the
  machine's terminal size for a focused host's viewport. Every claim carries the viewport,
  so a grant and its first resize commit in one owner turn. Each authentication acquires
  once its carrier is ready, and a focused host then takes the geometry from whoever holds
  it, as the browser's main thread does by replaying its viewport at every `connected`.
  `Session::take_geometry` takes it on the user's request, whoever holds it; the TUI's
  `Ctrl-\\` `f` sends it (`Command::TakeGeometry`). A viewport states one
  cell's pixels only when the host knows them (`set_viewport`'s `cell`); without them the
  wire metrics are zero, the PTY's pixel extent is zero and the daemon places no image,
  so a host that shows images states them.
- The session opens and seals frames into buffers it keeps between frames. One it consumes
  itself (an input ACK, a heartbeat) returns at once; a host that has finished with an
  action's payload hands it back with `Session::recycle`. The WASM adapter presents a
  payload by taking its buffer and returning the one it replaces, so no frame is copied
  between the core and its host. The native driver's payloads leave its thread and are
  not returned.
- A host shows only what the viewer commits: `Viewer::present_now` after each drained
  batch (urgent state, and an early-closed transaction), `Viewer::frame` at each refresh
  (grants, held releases). Both return the release reason of a new presentation; the
  host draws term-wasm's presentation grid, never the applied one. A transaction the viewer
  drops uncommitted (a snapshot replaced its rows, a lineage boundary, the host's end) is
  told to a recording host as display trace stage 5, before anything the replacement
  applies; the browser records it as `presentation_transaction_discarded`, without which
  the report cannot account for the members it held.
- Browser main captures synchronous provenance through `input_admission::Mirror` in its
  existing authorization WASM realm. The SAB seqlock copies seven model words into its
  reusable destination; Rust owns local advance and the exact input frontier. No grid
  exists on main. A refused publication invalidates capture; authentication resets it.
  The terminal worker executes the command with its captured visibility bit and may revoke
  admission without delaying transport. `Viewer::prediction_command` shares the native model's
  exact authority and causal predicates; later trust never changes a captured key's visibility.
  WASM record input borrows reusable wiping ingress and erases the consumed bytes immediately.
- `merkur-tui headless` presents its undrawn grid as a 60 Hz display would, which is what
  keeps the daemon's grants flowing; `SIGUSR1` prints the presented grid's rows.
- `session::direct` races the daemon's manifest beside the relay and adopts the winner
  after its authenticated upgrade; from then on every sealed frame rides the direct
  attachment. A lost path hands unacknowledged input back to the relay. A rebind retires
  the path and keeps what the network spent.
- The TUI requests every Kitty keyboard flag (31), SGR mouse, bracketed
  paste and focus reporting. `merkur_tui::host_input` turns the host's reports into the
  records the browser's `key-record.ts` makes from the same facts: the key, its shifted
  and base-layout keys, modifiers, event, and typed text, spelled by
  `build::key_typing`. Plain UTF-8 from the host is committed text. Raw CR, BS/DEL and
  HT are Enter, Backspace and Tab; other C0 bytes except ESC name control-key presses.
  A raw key ends the preceding text run. Ctrl-B passes to the remote session; Ctrl-\\
  belongs to the workspace, with a double press forwarding one prefix.
- `merkur_tui::composer` writes what term-wasm's `displayed_row`/`displayed_cursor` show
  (the presentation, with the visible speculative echo over it) as diff frames: only
  changed cells, the fewest SGR changes, EL for a row's blank tail, one synchronized-output
  frame ending in `CSI 5 n`. The host's answer releases consumption credit, since
  no host reports drawing. Changed state paints immediately on that credit; grant-only
  refreshes and viewer redraw/repair frame counts retain a 60 Hz maintenance cadence.
  A default colour stays the host's default; explicit colours are the daemon's RGB. OSC 8
  identities come from the presentation cells; missing
  definitions stay unlinked until their reliable control frame arrives. It reads a row only
  when what the row is made from has changed: term-wasm stamps each presented row with the
  commit that last rewrote its cells or links (`presentation_row_commit`), the session view
  adds the link table's revision, and a row under a speculative echo
  (`row_holds_prediction`) is read on every frame. An invalidated area or a new size reads
  every row. Its tests replay frames into alacritty and compare every cell and link.
- `merkur_tui::chrome` puts local screens through the same composer: sign-in, machines and
  dialogs paint escape sequences into an offscreen alacritty grid, and the host receives
  only the changed cells. Local chrome never writes `ED`/`2J` to the host; tmux redraws a
  popup between pty reads, so a clear-then-repaint flashes blank. A remote frame
  invalidates the chrome; local chrome paints explicit RGB or the host default only.
- `merkur_tui::graphics` prepares clipped rasters in host pixels from verified PNG tiles.
  Uploads have process-wide identities and explicit Kitty acknowledgements. A complete
  prepared scene replaces placements together; tab hiding retains uploads, while closing,
  lineage changes and retirement delete them. Retirement also revokes viewer residency.
  Native encoded and raster pixels share a 128 MiB working-set budget. PNG decoding
  and pixel preparation run on a lazy worker; completion wakes the UI without a timer.
  Reservations follow live buffers through cancellation and completion queues.
- `merkur-tui connect` reads its password with echo disabled on a separately opened
  terminal device. The UI owns one outstanding consumed fence across screens; transport
  runs on its own reactor. Host writes keep their byte offset while input, output and
  viewer ACKs continue. Termios, alternate screen, keyboard and pointer modes restore
  on normal exit, lifecycle signals and panic. The actual stdin terminal device is opened
  separately; Darwin's reactor cannot register the `/dev/tty` alias.
- `SessionView` reserves the status row. An owner resize fences predictions before
  reflowing; an observer keeps canonical geometry and crops it to the host's content area.
  Cell pixels come from the host's window size or its `CSI 16 t` reply; a host that gives
  neither (a tmux popup) states a viewport without them, so the machine still takes its
  grid. The first screen holds until the host answers its first frame's `CSI 5 n`: replies
  are ordered, so by then the `CSI 16 t` before it is answered or never will be, and no
  session's first viewport precedes that fact. A window change keeps the last stated cell
  until the host states another. Remote modes route pointer reports, and reports over
  chrome never enter the remote terminal.
- A password never travels in argv or the environment. `merkur-tui headless` reads it
  from standard input and refuses a terminal. `--edge-port` and `--relay-only` exist only
  for the e2e harness: its proxy gives each peer role its own listener, and the fixture
  keeps the TUI on the relay unless `FORCE_EDGE=0`, as `VITE_FORCE_EDGE` keeps the browser.
- Gate: `rust:lint`, the crate's `cargo test`, then `test:e2e:transport`, where
  `tui-headless` drives the harness-built binary against a real splice. A direct-path
  change also runs `test:e2e:handover` (`tui-direct`).

- `account_store::Store` serializes account tokens with a descriptor lock across processes.
  Refresh and durable publication run as one blocking task on its own reactor; cancellation
  cannot cut them between rotation and publication. macOS uses the login Keychain, one item
  named by the directory's canonical path; Linux authenticates encrypted tokens against the
  entire public profile. File ownership, private modes, and link counts are checked before
  reading. A changed delegation never reuses an older process's credentials. Software
  custody is explicit; a pinned backend never changes. A record this build cannot parse or
  verify, or whose credentials or custody material are invalid (`InvalidData`), is removed
  with them and reads as signed out, so a cutover of the record or custody shape costs one
  sign-in instead of stranding every command.

- Host input events and native driver commands wipe owned input records on drop,
  including unread event batches and abandoned command queues. Paste decoding
  borrows a wiping buffer; it creates no unwiped temporary password string.

- Authenticated program open requests travel only on reliable CTRL. The session
  emits a typed request; a host acknowledges after retaining it. The TUI keeps a
  bounded per-tab queue, parses the HTTP(S) target again, and requires an explicit
  review and Enter before its cancellable task invokes the system opener. The
  task owns and cancels its child on exit, independently of committed account jobs.
  Receipts are compressed sequence intervals per daemon epoch and survive rebind.
