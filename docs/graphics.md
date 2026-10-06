# Terminal graphics

How Merkur shows images in the terminal without letting them slow the text path. Programs
emit Kitty graphics commands, the Rust terminal beside the authoritative grid owns what is
displayed, and pixels travel separately from text. The application server is never in the
terminal or pixel path. Text, cursor state, and the graphics placements bound to each row
use the authenticated display machinery; immutable pixels travel independently and can
never hold up input admission or display acknowledgements.

## Authority and ingestion

This section covers who is allowed to parse a graphics command and who decides what it
means. There is one escape-sequence parser: the terminal's VTE feeds APC callbacks to the
graphics command receiver, which stages bytes in bounded storage and parks at a semantic
command boundary until the terminal owner can admit the work. Final uploads wait for
confined validation. A synchronized update cannot expose a partly parsed grid, and input
acknowledgements and routing decisions never wait on that display hold.

The scene owns image identities, revisions, placement dependencies, animation metadata, and
storage leases. A completed decode may publish only for its exact terminal incarnation,
command ordinal, image incarnation, and predecessor revision, so replacement, cancellation,
reset, and teardown all fence late work. Captured immutable rows can keep old revisions
alive without keeping mutable scene authority alive.

Pixels are decoded in a confined image helper, outside both the terminal owner and the
browser's rendering workers. Ordinary terminal commands cannot name local files, temporary
files, or shared-memory objects. A separate authorized local path, native descriptor
submission, validates the submitted extent before publication; see
[native image submission](native-images.md) and the
[image-worker contract](../packages/merkur-image-worker/README.md).

## Placement and display

This section covers how an image follows the text it was placed beside. Direct anchors
follow the grid's scrolling, history, reflow, and retirement notifications. Relative
placement changes invalidate the affected dependency subtree. Virtual placements use a
sparse placeholder index. The visibility index projects only the viewport rows an image
intersects, in canonical stacking order. Unchanged rows reuse their immutable encoding and
digest; empty rows allocate no graphics object.

Each changed row carries its complete graphics replacement, so the browser needs no prior
placement table to apply it. Graphics damage joins the same dirty-row bitset as text, and
capture, selective-ACK baselines, repair, and snapshots preserve a row's text, links, and
graphics together. Display lineages that carry graphics are memory-only. See
[display invariants](display-invariants.md) and the
[graphics model](../packages/merkur-graphics/README.md).

Geometry uses fixed-point coordinates and measured cell metrics. Cropping, clipping, and
adjacent row slices derive from the original transform. The controlling attachment's
accepted resize supplies terminal geometry; observers choose their own raster demand
without changing the shared grid. A viewport that states no cell metrics gives no placement
a geometry: anchored images are retired, nothing is projected, and a new placement is
refused (`EAGAIN`) until a viewport states them again.

## Pixels and finite transfers

This section covers how pixels reach the browser without competing with text. A content
manifest commits to canonical pixels and their interpretation; the trusted supervisor
validates helper output and computes the commitment. A content root names immutable data
and never grants access outside the requesting terminal's live authority.

| Property | Value |
| --- | --- |
| Tile interior | 256 pixels |
| Tile gutter | 1 pixel, clipped from the source neighbour |
| Encoded cache | Browser-owned, memory-only |

A bounded processing pool encodes only the requested footprint with reusable scratch.
Derived tiles are finite transfer objects, not a daemon cache and not a charge against
terminal source storage. Before an encoder returns to the pool it wipes every byte the job
touched, including cancelled jobs.

A finite transfer binds one concrete attachment, carries exact byte counts, and owns its
stream and cancellation state independently of the durable terminal lanes. An interrupted
transfer keeps its authenticated prefix and resumes only after its predecessor retires.
Queued requests wait on real capacity or lifecycle notifications. The relay's upstream
credit advances with downstream writes, and image pacing yields to interactive work. See
the [transport contract](transport.md#edge-relay).

## Visibility and GPU ownership

This section covers what images may never cost the text renderer. Only visible image
demand starts the asset worker. The compositor reserves a complete working set before
requesting pixels and chooses resolution within its bounded atlas. One tile upload joins an
eligible terminal submission after interactive uploads, under the existing GPU completion
credits. Pixel arrival updates texture mappings without rebuilding placement geometry. When
the last visible image goes away, demand clears and image frame processing detaches;
bounded backing storage can remain for reuse.

Pristine text frames allocate no image resources and submit no extra graphics commands.
Deleted images, and images retained outside the viewport, add no scene traversal, decode
requests, uploads, or animation wakeups to text rendering. Visible animations own one
next-boundary timer; hidden or stopped timelines do not poll. See
[display preparation](performance.md#display-preparation).

## Native terminal presentation

The terminal client uses the same verified tile transfers, placement projection and
animation timelines as the shared client core. It decodes each canonical RGBA tile once
and prepares clipped rasters at the host's pixel size. Adjacent fragments use the same
pixel-centre boundary, and resampling preserves alpha without introducing colours from
transparent neighbours. The status row is outside the image viewport.

Kitty image identities belong to the client across all tabs. Original tile and prepared
raster uploads use bounded base64 chunks and explicit acknowledgements. A complete
acknowledged scene replaces the previous placements inside synchronized output. A host
refusal fails the client with the reported error. Retained encoded and raster pixels share
a 128 MiB resource budget, independent of the host terminal's storage quota.

Native PNG decoding and pixel preparation run on a lazy graphics worker. Completion
wakes the UI reactor directly; scene and lineage cancellation discard stale work.
Reservations remain held through the worker and its completion queue until their
buffers are released. Host resize requests fresh cell metrics with `CSI 16 t`;
window dimensions containing padding do not become fractional cell estimates. A host that
reports neither window pixels nor a `CSI 16 t` answer states no cell metrics and shows no
images.

Switching tabs or opening a dialog removes placements while keeping acknowledged uploads
available. Closing a tab, replacing its authenticated lineage or retiring an unused tile
releases its host images. Retiring a tile also removes its residency from the shared
viewer, so an animation or later placement cannot rely on deleted pixels. Hidden timelines
own no animation deadline.

## Verification boundaries

This section covers how the invariants above are tested. The
[pinned Kitty corpus](../tests/fixtures/kitty/README.md) supplies independent command
observations. Property tests cover scene and grid projection, compositor tests cover
geometry, and real-helper tests exercise confinement and publication. Browser graphics
tests verify actual pixels separately from protocol replies.

The transport latency suite measures three arms: pristine text, text after deleting an
image, and text after an image scrolls outside the viewport. Graphics contention tests keep
matched control and image arms, exact input and completion populations, loss and reorder
strata, and separate harness-validity checks.
