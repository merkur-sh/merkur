# Merkur graphics foundations

This crate implements the terminal side of the [terminal graphics contract](../../docs/graphics.md):
Kitty command ingestion, image namespaces, placement dependencies, fixed-point projection,
Unicode placeholders, bounded replies, resource accounting and publication ownership. The
daemon's terminal drives it from the patched parser's APC callbacks and connects
ingestion, inline decoding in the [isolated worker](../merkur-image-worker/README.md),
replies, image publication, placement commands and deletion, including animation edits.
Immutable rows reach authenticated asset delivery and the browser compositor. Software
acceptance covers this crate; platform and tool validation are outside its scope.

## Module map

| Module | Owns |
| --- | --- |
| `command::Receiver` | Consumes canonical VTE APC callbacks into a parsed control block and a bounded encoded payload. Unknown APC families are ignored. Failed commands retain parsed control data for response identity and quiet handling. No base64, zlib or image decoder runs here. |
| `ingest::Ingest` | One upload continuation: bounds cumulative encoded bytes, distinguishes first, intermediate and final chunks, and parks only the final command for validation. Deletion interrupts a receiving upload; a stale completion cannot resume a successor; command ordinals never wrap. |
| `boundary::Boundary` | Holds each complete APC at its semantic boundary until the owner acknowledges it. Retries against a full helper queue borrow the same staging bytes. RIS cancels continuation state while preserving ordinals. |
| `publication::PublicationGate` | Consumes a job's right to publish once, comparing terminal incarnation, command ordinal, image incarnation and predecessor revision against the pending job and the trusted current scene. |
| `scene::Scene` | Non-reusable image incarnations and revisions, ID replacement, anonymous images and newest-live-image-number selection. Publication replaces the namespace atomically; captured immutable roots keep their old data and storage charges. |
| `placements::Placements` | Named and anonymous placements, direct anchors, virtual origins, relative dependencies and reverse indices. Reparenting validates cycles and subtree depth before mutation; parent deletion cascades. |
| `geometry` | Crop intersection, direct-placement scaling, virtual-placement letterboxing and projection of clipped rows or placeholder cells in 32.32 cell coordinates from 16.16 pixel metrics. |
| `source::SourceManifest` | The 40-byte commitment to canonical pixels, dimensions and pixel interpretation, with a domain-separated BLAKE3 root independent of transfer encoding and level of detail. It grants no asset access. |
| `projection` | Immutable row fragments: a content-manifest commitment, sampling dimensions, stacking order and absolute 32.32 destination and source intervals, in a 120-byte canonical descriptor. |
| `animation::Manifest` | A canonical playback catalogue with a prefix-duration index, sampled from elapsed monotonic time in O(log frames) without allocation. |
| `placeholder::RowDecoder` | Unicode placeholder decoding: original foreground and underline encodings before colour resolution and the three left-inheritance rules, checked against the protocol's diacritic table. |
| `reply::Reply` | Fixed ASCII errors and numeric identities in a bounded stack buffer, with quiet handling and no unsolicited replies. |
| `budget::Budget`, `budget::Aggregate` | Byte and object reservation before admission, as a non-clonable lease that travels with its owner; `Aggregate` charges a local budget and its shared domain atomically. |
| `processing` | Checked pixel extents and the fixed request/result contract shared with the isolated worker. |

## Limits

| Limit | Value |
| --- | --- |
| APC control buffer (`command`) | 512 bytes |
| Encoded payload per chunk (`command`) | 4096 bytes |
| Source manifest | 40 bytes |
| Canonical row descriptor (`projection`) | 120 bytes |
| Animation frames per manifest | 4096 |
| Placeholder diacritic table | 297 codepoints |
| Storage per terminal (set by the daemon) | 128 MiB, 8192 objects |
| Storage across terminals (set by the daemon) | 512 MiB, 32768 objects |
| Decoder workspaces, process-wide | 2 |

## Ingestion and publication

The caller must reserve real storage before handing admitted borrowed chunks to the
helper; the cumulative encoded limit is not a substitute for global or domain accounting.
The publication gate does not establish a sandbox, validate pixels, allocate image
incarnations or provide the authoritative scene: the caller validates helper output and
obtains immutable ownership first, then the gate decides once whether that result may
still publish. Upload metadata is reserved before validation, queries leave the namespace
intact and reset clears live images without resetting identity counters.

## Placements and geometry

The patched terminal grid (`packages/alacritty-terminal-patch`) exposes attachments that
follow row rotation and reflow. Position resolution asks the grid for both coordinates and
never retains a column beside a line identity. Relative chains resolve without allocation,
including virtual roots whose origin comes from the sparse placeholder index.

A placement advances the cursor as Kitty does: past its last column on its last row, onto
the next line after the final column. A line below the scroll region's bottom scrolls the
region once per line crossed, so an image taller than the page ends on the cursor line;
rows move no further than the region and its history hold. Contained images scroll inside
page margins and clip permanently at their boundaries; images crossing a margin stay
fixed. Tagged anchors return coalesced movement, clipping and retirement events through
an intrusive queue, so erasure, screen clearing and history retirement release
dependencies without another graphics command or a scan of live placements. Ordinary text
erasure preserves direct placements; clear-screen includes images extending into the
viewport from history.

Delete commands collect their selection before mutation and delete deeper placements
first. Spatial selectors preserve virtual prototypes and match relative placements where
they are displayed. Explicit soft deletion retains named sources; deletion through a
parent frees a last-placement source. Deletion answers only an ambiguous image identity:
unknown selectors, absent cells and absent images delete nothing, silently.

The renderer sends its measured 16.16 logical-pixel metrics with each authenticated
resize, and the last accepted resize supplies placement geometry and the matching PTY
pixel-size query. Scissors retain source fractions across metric changes with inward
fixed-point rounding and no accumulation across round trips. A placement whose new
geometry cannot be represented is retired with its dependents. Disconnected terminals
retain their last committed geometry.

## Projection and animation

Resolved placements enumerate only intersecting viewport rows, including fractional
scissors. Nonempty row sets share immutable descriptor slices across consumers and retain
their byte and object charges until the last reference disappears, without retaining pixel
data. Replacement validates bounds and canonical order before mutation, and a quota
refusal preserves the old row. The 40-byte content domain inside a descriptor holds a
32-byte root, `u16` kind, `u16` width and `u32` height, big-endian; the kind distinguishes
static pixels from an immutable animation manifest. Live placement projection supplies
rows; independent encrypted assets supply pixels.

Animation metadata edits publish a new manifest through the same incarnation/revision
fence as pixel edits, and old retained roots confer no fetch authority. A frame upload
edits the frame its `r` names; zero or any later number appends, and every reply names that
frame once the image resolves. A new frame is composed from its base frame's pixels when it
is created. Animation control applies each valid field and ignores absent frames and
unknown states without a reply, as Kitty does.

## Replies and quiet mode

Deletion and animation control never acknowledge success; frame composition does.
Decoding failures carry Kitty's codes: `ENODATA` for short uncompressed pixels, `EBADPNG`
for an undecodable PNG, `EINVAL` otherwise. Invalid placeholder marks break inheritance;
extra marks after the three protocol fields are ignored, and indexed and RGB encodings are
distinct for inheritance even when they encode the same numeric ID.

## Budgets

Every admission reserves bytes and objects first. Retained captures cannot refund their
storage early, and retired consumers and pending process reaping keep both local and
aggregate charges until the resource is physically gone.

## Conformance and tests

The ingestion corpus references Kitty revision
[`1d67ecd47c0bd68951868c363baa92039d936572`](https://github.com/kovidgoyal/kitty/blob/1d67ecd47c0bd68951868c363baa92039d936572/docs/graphics-protocol.rst).
A separate [pinned Kitty-core corpus](../../tests/fixtures/kitty/README.md) compares
replies, cursors, draw-ordered row geometry and decoded image frames, with documented
reference deviations. An independent full-scan scene model checks every transition against
the indexed implementation. Ingestion tests cover input splitting, control ranges,
continuation restrictions, refusal of ambient file and shared-memory media, quota
rejection, cancellation, query ordering, synchronized-output barriers, one-use
publication, stale completions and allocation counts.

Run from the repository root:

```sh
cargo test --locked -p merkur-graphics -p vte -p alacritty_terminal
```
