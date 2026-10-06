# Display Invariants

Normative rules the display path must keep. `docs/transport.md` (Display Codec,
Compression, And Recovery) describes the mechanism; this file is the contract. Every rule
below names, in parentheses, the failure it prevents.

## Authority

The authoritative terminal grid lives in the daemon dataplane. Browser display state is
synchronized via snapshots, row deltas, ACKs, resync, and FEC. Display ACKs advance rows
from the exact sent datagram snapshots, not from the latest terminal state.

Only the authenticated controlling attachment may resize the shared PTY. Explicit claims
and compare-and-swap transfers issue a non-reusable generation; each resize must name the
current grant before its per-peer intent serial can advance. A compound claim validates
its complete first viewport before changing ownership and commits both without another
round trip. Observers preserve canonical row coordinates rather than locally reflowing
them to their window. Grant updates are fenced by the authenticated display lineage in
both workers; losing control requests a canonical snapshot to replace any local resize guess.
Browser focus and viewport changes drive authenticated claims automatically: an unfocused
observer does not claim the geometry when its own window resizes. A controlling viewer retains
its requested viewport across snapshots sent before the resize. Until a complete frame names
that viewport, its locally reflowed grid supplies neither resume row hashes nor row-digest
comparisons. A geometry transfer retires that request and roots the observer in a canonical
snapshot.

A semantic pause inside a synchronized-output drain leaves a partial authoritative
mutation. Display capture, hashes, snapshots and repair wait for that drain to finish.
The helper's exact capacity/completion event resumes the owner, as does the landing of a
removed source's release a waiting storage admission needs; no display timer polls the
held grid. Input ACKs, reliable editor-anchor revocation and the CTRL input-routing
word remain independent: that word carries only the mode word's routing and
input-report bits, never cursor, grid, alternate-screen or grant state, and sending it
makes the commit re-admit the whole header.

## A datagram is a complete transformation

A display datagram is a complete, order-independent, idempotent transformation of the
grid, and the datagram lane never carries a multi-chunk frame. Every batch is
independently compressed and self-describing. Entries carry literal cell spans and never
read another mutable receiver row: a conditional source-hash check cannot make a
cross-row copy commute with its source's writer. `chunk_index`/`chunk_count` survive only
for the reliable lane's snapshots, where loss cannot occur. Losing one datagram must cost
the rows it carried and nothing more; a barrier above the unit of loss turns modest
datagram loss into a full-screen resync storm.

Only a snapshot carries grid geometry: a delta whose header names other dimensions is
refused by the receiver (`display_dimensions_mismatch`), never fitted by resizing the grid
around it. It is either in flight across a local resize whose snapshot re-roots
everything a round trip later, or corrupt, and the daemon re-sends whatever it never sees
ACKed.

## Graphics row authority

A row entry carries its complete graphics replacement, even when its text span is
partial. Absence clears graphics; no entry depends on another packet's dictionary or
mutable placement definition. Raw and streamed decoders validate the full entry before
application. Descriptors participate in received row hashes and row ordering independently
of pixel residency. Eligible descriptors change only at the presentation commit.
Logical multi-chunk prevalidation also retains every graphics replacement under its
quota before the first chunk applies. Releasing a rejected frame refunds its reservations;
accepted chunks transfer ownership without a second descriptor allocation.
Prediction checks both received and eligible coverage. A local resize with either form
of graphics retains the authoritative layout until a geometry snapshot arrives.

Graphics descriptors require the memory-only patch flag. The transport owner latches
that policy across reconnects, discards pending snapshot persistence, and stops copying
snapshots for disk storage. Pre-graphics text writes already in progress may finish.
The daemon latches this policy on successful image publication, preserving it through
image deletion and terminal reset; query-only validation does not activate it.
Native capture shares the projector's canonical row encoding alongside its cells and digest,
but never its storage charge: the projector alone holds that. Both ACK provenance tiers and
snapshot baselines keep only the row's version, the process-local identity of one retained
row allocation, so late ACKs cannot substitute the latest terminal graphics and a row a viewer
never acknowledges holds no storage. The same bytes in a new allocation compare unequal, which
costs one conservative re-send; unchanged rows keep their allocation. A graphics-only replacement or
deletion sends one unchanged text cell plus the complete graphics set. Unchanged text-only
rows allocate no graphics storage. Header-only recovery probes preserve memory-only policy.
Grid attachments emit coalesced movement, scissor and retirement notifications; ring,
viewport and screen changes emit a remapping notification. The native owner consumes
these at parser/resize boundaries and invalidates placement dependencies. Retirement
occurs when a row leaves live history, independently of when its storage is reused.
The live projector replaces native rows as one admitted batch. Unchanged canonical rows retain
their existing owners; changed rows mark display damage. Aggregate projected graphics must fit
the receiver's snapshot staging budget after worst-case native text, links and chunk framing,
as well as its received/presented/replacement descriptor budget. Reproducible projection storage
is released before deterministic oldest-source eviction, and since no capture is charged, that
release returns all of it: a slow or silent viewer cannot make the projector evict an
original. Unicode placeholders are interpreted from the authoritative grid
before color resolution discards their IDs. A quota-owned sparse row index follows grid
damage, binds virtual prototypes and places each virtual parent at the minimum column and
line of its placeholder cells, as Kitty does. Contiguous slices coalesce; holes and
reordered coordinates remain separate. These fragments stack at z -1, just beneath text,
whatever z the virtual placement requested, and merge with direct and relative placements
in canonical stacking order under the same complete row admission. Placeholder glyphs and decorations are suppressed; explicit backgrounds remain.
Direct and relative placements use a persistent AVL index ordered by canonical stacking
key, with exact subtree row masks. Only invalidated dependency members resolve geometry;
row queries skip subtrees with no visible member. Updates retain admitted node storage and
invalidate both previous and replacement row intervals. Canonical row comparison avoids
republishing semantically unchanged results. Placeholder selectors have a quota-owned reverse
index, including references to absent prototypes. Scene edits rebind only rows referencing the
changed selector; grid edits update their exact reverse edges. Per-row origin contributions
resolve only changed virtual parents and invalidate descendants only when their origins change.

The terminal WASM exports only presentation-eligible fragments. Its revision travels in
the existing packed geometry state; text-only frames require no additional WASM call.
The export allocation has an independent lease bounded by admitted descriptor count.
Replacement frees old backing before refunding it, and an empty eligible scene releases
the export allocation and lease together.
The render owner selects one sampling level for all clipped rows of each placement,
splits at tile boundaries, and reserves the complete visible atlas demand before fetching.
If that exact allocation fails, it reduces resolution across the scene. Descriptor and
geometry bounds reject an unadmittable scene as a whole, never as a visible prefix.
Split quads carry destination edges: each row or tile boundary is computed once and the vertex
stage selects it rather than summing an origin and extent, so neighbours meet on one f32 value
and no seam pixel is covered twice or left bare (an origin plus extent summed in f32 split
fractional row boundaries).
Asset arrival changes texture mappings, not authoritative row state or terminal ACKs.
Images draw before explicit cell backgrounds, below text, or above text according to z;
cursor and local preview remain in the same terminal render pass.

An animated descriptor names an immutable manifest containing pixel roots and the native
playback anchor. A command publishes a new manifest under the existing scene fence; ordinary
playback does not mutate terminal rows or generate a display packet per frame. The viewer
samples elapsed native time through the shared WASM timeline. Every visible binding for an
animation changes together after the entire selected frame becomes GPU-resident. Until then,
the previous complete frame remains pinned and the outstanding frame retains its requests.
Geometry admission includes a complete successor's texture capacity for running timelines.
Cached frame changes reuse placement geometry. Hidden views cancel playback deadlines and
resample native time on return; they do not restart the animation.

Decoded bitmaps arrive directly between workers. Upload credit retires on the matching
terminal GPU submission; renderer identity and authenticated display lineage fence stale
completions. Atlas regions may be reused through ordered writes on the same GPU queue;
the backing pages remain allocated and charged across scene deletion. Device loss
rebuilds the same backend and reconciles demand through the memory-only encoded cache.

## Complete-screen closure

An application that brackets a redraw in synchronized output (`DECSET 2026` BSU/ESU) has
declared which terminal state is a complete screen. The daemon names that state by content:
`merkur_codec::viewport_closure_digest` is XXH3 over the grid dimensions, the cursor as the
header carries it, and every row's `row_hash` — the same invariant display heartbeats compare.
A capture taken while `TerminalState::completed_sync_update_epoch()` is nonzero (the latest PTY
application ended exactly at an explicit ESU; any later byte, a resize or a forced sync release
clears it) stamps that digest into the frame header of every frame it produces, header-only
frames included. Anything else, and any capture with a graphics projection or pending graphics,
carries zero. A graphics placement digest does not prove its image has arrived.

The claim is a property of state, not of a transport group, so it survives everything that
splits one redraw across the wire: physical clipping into a later turn, FEC loss answered by a
re-diffed repair under a new presentation id and new sequences, reordering, duplication, and a
clipped continuation. Each capture of the same terminal state names the same digest.

The terminal worker adopts the claim of the newest applied sequence only; term-wasm applies rows
and headers only from newer sequences, so a late older frame can neither regress the grid nor
revive an older claim. The claim is fenced to the terminal instance, carrier session and local
canonical mutation epoch it was noted against; a local resize or reset retires it and the
ordinary rules below own the transaction again. While a claim is current and the authoritative
grid does not digest to it, no authoritative commit happens at all: no deadline, END, pump or
urgent release, and `executeRender` cannot commit authority. Local renders (prediction
retraction, cursor) keep drawing the previous committed scene. When the grid digests to the
claim, the transaction releases as `closure-complete`: inside the current task when no GPU work
is owned, the renderer has capacity, no early commit has spent this frame's opportunity and no
control, resize, resync or prediction barrier is pending; otherwise on the first real animation
frame or GPU completion. Leaving an unmet claim restarts the ordinary frame count.

Holding pixels holds nothing else. Selective ACKs are posted on apply, lost rows return through
the grant-exempt repair admission, a clipped state finishes as a grant-exempt continuation, and
new states are admitted against grants the worker mints on animation frames, never on commits.
The only wait left is for rows that have not arrived: under loss the first changed pixel of a
synchronized redraw is later, the complete image is not. Output that does not end at an explicit
ESU claims nothing and keeps the advisory rules below; nothing infers finality from quiet time,
queue drain or row counts.

## Presentation is advisory

Presentation grouping is advisory. Browser and native viewers apply the same client-core rules. `presentation_id`,
`presentation_member_index/count`, `row_predecessor_presentation_id`,
`PATCH_FLAG_PRESENTATION_COHERENT`, and `PATCH_FLAG_PRESENTATION_END` let the terminal
worker hold dirty geometry for one bounded transaction, but they never gate decode, grid
application, selective ACK, loss, repair, or resync. `END` alone cannot release a redraw: reordering
can deliver another member after it.

Membership completion is scoped to the current renderer transaction: every group
attached to it must be applied through, and the newest membership-bearing group *of that
transaction* must have carried END. A group first observed after the transaction started
(a queued newer redraw, or a daemon re-send of identical rows under a fresh presentation
id) belongs to the next transaction and cannot move the goalpost, and a queued frame
never re-holds a transaction that already released. Advisory completion is evaluated at the
applying member; coherent transactions normally commit at a worker animation frame. The
frame folds separately ended chunks into one image because advisory membership does not
establish application completion or complete content. This coalescing wait can miss a
composite that an earlier submission would reach.

A paced transaction closes on arrival. `PATCH_FLAG_DEMAND_AWAITS_GRANT` says that when the
daemon sent the frame, it was pacing the run and held no grant to send a newer state. When
every group attached to the transaction is complete and valid (END aside) and the newest one
carries the flag, the transaction commits as `paced-complete`: no newer state of that output
leaves the daemon until a grant reaches it, whether the next frame issues it or one is already
in flight, so holding the state would keep an older screen up longer.
Whether an unsynchronized application finished its redraw in that capture is not on the wire
(the same bytes are a whole redraw or the first part of one), so a capture caught mid-write
shows as a local terminal shows its grid at vsync, until the next paid state shows the rest.
A capture that carries a closure claim is exact: the terminal applies a BSU/ESU update whole,
and closure outranks this rule. A synchronized application's capture carries no claim when a
read after its last ESU reached the terminal, including one that only opened the next update,
and is then shown like unsynchronized output. The commit happens inside the current task under
the closure gates above, otherwise on the first real animation frame. The frame's own commit
does not spend the early opportunity; an early commit does, so a frame carries at most one of
each. (Waiting for the frame could fold in only a state an in-flight grant had already paid,
and it left paced output a frame staler on screen than unpaced delivery. Letting
a frame-released commit spend the opportunity kept every later state on the frame rule for
good. Holding a continuing state for its successor bet that the successor completed a redraw:
it committed floods in pairs, one screen per two frames, and at a round trip of 50 ms held
about one screen in ten a frame for no evidence.)

A hold with no coherent pixels (a header whose row predecessor is missing) commits at
the applying member.

Missing or malformed advice never extends the frame budget. A 0/0 pair is a nonmember
(for example a K1 evidence probe), not a grid-validation failure. The authoritative WASM
grid advances before the visible WebGPU state. Isolated urgent changes commit at the
earliest viable opportunity. The daemon marks a one-row cursor-row change urgent when it is the
first changed cursor row admitted since new input: a keystroke's header-only advertisement
releases the prediction barrier before the shell's echo is even read. Neither that frame,
an unrelated background row nor a replay of the pre-input cursor row consumes the exemption.
This scheduling evidence cannot establish causality between arbitrary PTY output and input. An urgent row
renders at once even while the previous submission is unconfirmed, bounded only by in-flight
capacity. Meanwhile an incomplete coherent transaction releases at the
SECOND worker animation frame after its first coherent apply: one whole frame interval,
counted in frames the compositor actually delivered after the hold began. A callback
with a repeated or older counted frame timestamp does not spend another frame, but
completion arriving between callbacks can still release on that same frame. A callback
whose frame time predates the first coherent apply is the frame the hold interrupted,
not one it collected through, so it neither counts nor releases. Frame times and apply
instants come from one clock, the worker realm's monotonic timeline its animation frames
use. Epoch time rebuilt from `performance.timeOrigin` is not that clock: WebKit moves the
origin forward by every device sleep, and with applies stamped on it every frame after an
iPhone sleep predated its hold, so output froze for as long as the phone had slept while
input kept working. Telemetry converts the core's times to epoch time at the boundary. There is no timer and
no estimated period on the release path; a hidden tab that produces no frames simply
keeps holding, because the authoritative grid and selective ACKs advance independently
of presentation.

A render that returns no submission or throws retains its pending-display edge and
unconsumed presentation transaction. It never immediately reclaims the aborted mailbox
inside that render call. An unblocked scene retries on a real animation opportunity;
an existing hold or lost context retains ownership of its own wake. New display traffic
is not required merely to make an aborted scene pending again.

A physically admitted coherent non-END original leaves the peer owing an END; the
clipped remainder is re-selected on the next owner turn, bounded only by carrier
capacity and actual-refusal backoff. Only an admitted END or authoritative generation
reset clears the obligation; a collapsed no-diff state emits a positive-member
header-only END. Probes, parity and repair replays never open this state. Actual
zero-progress admission uses a separate bounded retry, and fresh critical input may
attempt immediately without allowing the same failed input to spin.

## The daemon never coalesces against a clock

The owner loop applies every PTY read the reader thread had already queued, then
flushes in the same turn; a "now" decision runs at the bottom of that turn, never
through a zero-delay timer rearm. The only waits on the flush path are refusal evidence
(snapshot backoff, zero-progress admission retry) and a row's re-send deadline, and that
deadline is never shorter than the path's measured round trip.

The input ACK holds packet construction on the carrier its input arrived on, the edge tunnel
or the peer's direct session, until the same turn's flush has admitted the peer's header-only
or echo frame, so all of them share a packet. The hold ends at a point the turn reaches, never
on a clock, and it ends first before a hash pass over more than the cursor row, a snapshot, a
jumbo frame, or another peer's work. Direct sends admit through the session the peer owns,
synchronously: no registry lookup, lock or await stands between the owner turn and the
connection's queue.

Damage is not an emit reason: `record_damage` marks the cursor row on every read, so a
read that changed no row hash, no header field and no advertisement, and owes no END,
puts nothing on the wire, every chunk an application buffers behind BSU included. Before
each parser advance, including every queued read in a batch and a continuation resumed
after image-worker work, the owner confirms queued write completions. A completion
arriving between reads must not be left behind until the next owner turn. The input
watermark records confirmed writes; it does not claim that arbitrary PTY output is an
echo of a particular input. The echo horizon bounds the other side: each capture carries
the newest input its peer had queued when PTY output was last applied, and no later input
can have been answered in that grid, however far the watermark has advanced. The two can
arrive in either order: the reader can hand over a key's echo before the writer has queued
that key's completion, so the echo's frame carries the older watermark and a header-only
frame raises it afterwards. A presentation commit's telemetry therefore records both the
watermark and the horizon of its members, and the latency report answers an input from the
first fenced pixels whose watermark covers it, or whose horizon covers it once an applied
frame has confirmed it, at whichever of the two came later.

## Row lineage and application epochs

A header/cursor may depend on a wholly unseen earlier row presentation even after its
END. The row predecessor references the last actually admitted row-bearing group; only
exact current-lineage ACKs or complete absolute replacement of all unresolved ancestor
rows discharge unseen-row risk. Header-only updates, parity, replicas and probes never
advance that row head. All members share one pre-seal predecessor, and predecessor zero
never cancels an active browser hold. Snapshot/generation reset roots the lineage.

An explicitly applied, tail-complete BSU/ESU update carries a daemon-local epoch that
records the application's own atomicity boundary and waives nothing. Each peer consumes
it on its first actually admitted current-revision original (all chunks for a reliable
snapshot), never on preparation, parity, probes or replicas. No-op epochs do not create
work, and normally applied unframed suffixes/updates cannot inherit old ESU urgency. This
scheduling evidence is not a wire dependency or permission to merge distinct completed
application updates.

## The ACK is selective

The display ACK is selective, not cumulative. It reports the browser's newest applied
sequence plus a 128-bit received bitmap anchored at it and counting down. A cumulative
sequence cannot describe a hole, so it would credit rows the browser never received.
The daemon resolves each sequence to applied / lost / outstanding / unknown, and declares
loss after `LOSS_PACKET_THRESHOLD` (three) actually applied successors: evidence, not
allocated sequence distance. Refused sends can leave ID gaps. The third applied bit is
computed once per ACK; unresolved unreliable attempts retain bounded re-send deadlines
even when a sparse later ACK cannot resolve them. Never infer loss or suppress those
deadlines from raw sequence displacement. Never-admitted trailing reservations may be
reclaimed only before original/probe sends while the exact reservation tip is still
owned. Retained history is bounded; eviction and age pruning use actual admission time,
not numeric map order across wrap.

## Delivery is bounded by presentation

Output that outlasts one presented frame leaves the daemon only as screen states admitted
against client display grants, and each client issues grants at the rate its terminal is
shown. The native TUI limits composition to 60 Hz and waits for the previous host frame's
consumption reply before composing another frame; background tabs issue no presentation grant. Between grants the daemon keeps applying PTY output; the next admitted state is a
capture of the screen as it is then, never a backlog of intermediate states. (Without it a
flood filled the carrier with thousands of states per second the browser could never
present, and the user's own interrupt and its echo queued behind them.)

- An output run starts with the first output after at least one presentation period (the
  peer's reported period) of silence, once no paced state of the previous run is still
  unacknowledged. It is admitted as produced until at least one period has passed and the
  browser has acknowledged one of its datagrams: before that acknowledgement no grant can
  reflect the run. A burst that completes inside that window, and any output slower than
  the display, behaves exactly as unpaced delivery did. (Pacing a sub-frame burst only
  delayed its tail by a grant cycle and exposed it across frames; closing the window after
  one period at a long round trip left the run waiting a whole loop for its first grants.)
- A free state spends a banked grant when one is there, so the bank is gone while delivery
  is unpaced anyway and the browser's grant clock is running when the window closes. (A bank
  spent only after the window went in one burst of superseded states, then waited a loop.)
  Its final screen is captured at a grant, not at the moment its output stopped, which can
  deliver it a frame later than unpaced delivery; the browser commits that state as it lands
  (the paced close above), which in the closed-loop model puts it on screen when unpaced
  delivery would. Network loss, callback delays and the compositor's own deadline can still
  delay it.
- The grant is a cumulative per-generation u32 on the display ACK (datagram and reliable
  forms), max-merged by the daemon. Every generation opens with one implicit grant on both
  sides, and the browser restarts its sequence at every applied snapshot.
- The terminal worker issues at most one grant per animation frame, from the existing render
  and presentation callbacks after their display slice (never a loop of its own), and none
  while hidden. A hidden-to-visible transition requests one fresh state immediately and
  resumes per-frame refill without waiting for a prompt sample from the hidden-time run.
  It stops once `granted - seen` reaches `ceil(max(loop, network RTT) / presentation period) + 1`,
  where the loop runs on the worker's clock from the ACK that carried a grant to the arrival
  of the state that consumed it, sampled only from states flagged demand-prompt. The largest
  observed loop is retained until the carrier session changes; the measured network RTT
  seeds the cold window and a slower path. The window remains capped at 255. (Returning
  credit per applied state turns one burst into a burst every round trip; returning it per
  presentation after a burst leaves the pipeline at stop-and-wait; timing a grant from the
  frame that issued it counted the wait of a grant riding a later ACK as delivery loop.)
  Each visible environment signal re-arms retained render and presentation callbacks:
  WebKit suspension can clear its native worker callback list while JavaScript still owns
  those arms. Recovery does not depend on observing the hidden setter, which can coalesce
  with the visible setter before the worker processes it. Replaced callbacks cannot consume
  their successors, and neither repair membership nor GPU completion credit is reset.
- Every datagram carries the demand serial its state consumed; grant-exempt frames repeat the
  newest one, and snapshots and evidence probes carry zero, which the browser ignores. A
  demand-limited frame (the daemon holds nothing banked) is owed one posted grant; once a
  limited state is also demand-prompt (it consumed a grant that found the daemon waiting),
  the browser posts one grant per frame until its window is full, and keeps doing so until a
  state shows the daemon holding credit again. Any other grant rides the next ACK and costs no
  packet. The owed grant and the one that fills the window travel the reliable lane too, and
  a refused post owes it again. (A lost final grant would otherwise leave both sides waiting;
  refilling the window after every limited state woke the compositor frame after frame for a
  daemon that had gone idle, tripling animation frames on a 1 Hz dashboard.)
- Grant-exempt work: a free output run with nothing banked; input-caused urgent feedback, and the
  input-caused cursor row even amid rows waiting for a grant; input coverage and a header change
  that answers input after blocked bulk rows are removed; a state with no rows; the clipped
  remainder of an admitted state, restricted to rows it has not carried; repair of rows whose
  newest admitted send is unconfirmed past its re-send deadline or retired by selective ACK
  evidence; snapshots. A header change that answers no input while rows wait for a grant leaves
  with the paid state that carries them. (Typing latency is
  not a presentation question; a lost header-only state leaves no row the re-send deadline
  could repair; a lost window must recover without a grant the browser cannot know to send.
  Sent on its own, a flood's cursor moved on every PTY read, so every flush between grants put a
  header-only datagram on the wire, about 1,600 a second at 120 Hz and most of the downlink's
  datagrams, each showing the cursor over rows that had not arrived.)
- A peer waiting on its browser does not wake the owner loop: only exempt work does, and the
  grant itself is the wakeup. A carrier replacement, a new Noise session, a displaced carrier
  or rows disowned by a resync grant one state past the newest admitted one, and the browser's
  session fence forgets grants whose states were in flight; the browser adopts any serial past
  its own grant. Generation and carrier boundaries reopen unpaced delivery until an ACK
  sees the replacement flight, so the first replacement state does not leave a one-grant
  pipeline waiting another round trip.
- A state is marked as a continuing presentation (no END) whenever output advanced past it
  while it was prepared, whether or not its follow-up waits for a grant. In a free run the
  browser folds that follow-up in; a state that awaits a grant closes on arrival regardless
  (the paced close above), so there the mark changes nothing.
- `PATCH_FLAG_DEMAND_AWAITS_GRANT` is set exactly when the run's free window has closed and no
  grant is banked at the instant the frame is sent. Admission stamps a prediction; physical
  admission settles it, restamping a burst (and giving up its precomputed parity) when a grant
  landed or the window closed while it was encoded, and clearing it on a clipped prefix, whose
  remainder follows without a grant. The prediction almost always holds, so nothing moves.

## Flush is bounded by measured carrier space

A display flush is bounded by the carrier's measured free datagram-buffer space
(`Connection::datagram_send_buffer_space`), never by a byte constant. It is read from the
connection's delivery view, which every release of the connection-state lock publishes, so the
flush reads it exactly as of that release without taking the lock, from the direct session the
peer owns. The capacity
calculation includes each Quinn queue entry and HTTP/3 datagram header. Merkur's
patched WebTransport sender also performs a final atomic non-dropping admission,
refusing new work if another producer consumed the measured capacity; without it,
Quinn's dropping send could silently evict an accepted burst's head. There is no
inter-group pacing: the browser's receive queue depth is declared in `packages/shared`
above any burst the buffer can hold, so spacing has nothing left to protect and only
smears a redraw into a row-by-row sweep.

Reliable display commit is for snapshots, jumbo frames, resync/fallback, and repair
paths. Datagrams remain the low-latency default. A display frame is bounded to 2 MiB
on the wire and after decompression. The 18-byte stream envelope carries a 32-bit body
length, so a reliable frame can preserve an indivisible row beyond 64 KiB. WASM ingress,
raw validation and decompression enforce the same frame ceiling; aggregate
staging quotas remain separate. zstd history is also bounded to 2 MiB before decoding.
The browser frame ring reserves two maximum aligned slots plus sentinel and metadata
space, ensuring a maximum frame fits at any empty-ring cursor without a wrapped payload
copy or an intermediate buffer.

## Row priority classes

The cursor row and a changed cursor/mode header are critical: they are encoded in their own
display frame and FEC domain, sent first, and replicated across every live direct and edge
carrier. The two rows above the cursor (`VALUABLE_PROMPT_ROWS_ABOVE_CURSOR`) and the bottom three
rows (`VALUABLE_BOTTOM_ROW_COUNT`) are valuable and ordered ahead of ordinary visible rows; when
not themselves critical they remain single-carrier traffic. FEC groups never span the critical
and noncritical domains.

## Compression

Display bodies are compressed with zstd, and both ends link the C library. The daemon
encodes with `zstd`, plus `zstd-sys` directly for `ZDICT_finalizeDictionary`, which the safe
wrapper does not expose. `term-wasm` decodes through `zstd-safe` with libzstd compiled to
wasm32, so the WASM build needs a clang with the wasm32 target (`scripts/wasm-toolchain.ts`).

A compressed payload holds the rows in their stream-split layout
(`merkur_codec::RowSplitter`), not the row layout: like fields of every row travel together
(row indices, `left` fields, cell counts, colour modes, link tables, graphics sections, cell tags,
codepoints with their run lengths, colours), and the row byte count is dropped because the join
recomputes it. One entropy distribution per field is what makes it smaller than compressing the
row layout. The zstd frame is magicless, with a window descriptor and no frame content size or
checksum: the envelope already says the payload is zstd, carries the row-body length, and the
Noise AEAD authenticates every byte. The browser parses that header before decoding, refuses
any other frame dialect and any window above its bound, walks the block headers to prove the
payload is exactly one frame, decodes one-shot into a reusable split buffer, and joins it into a
reusable rows buffer that must come out exactly the declared length; the one row validator then
reads it. Nothing is allocated per frame. Level 3 and the 16 KiB dictionary cap are measured
knees, with the measurements recorded in `apps/daemon/dataplane/src/display/compressor.rs`; do
not round them off. Raw (uncompressed) frames keep the row layout.

Compression dictionaries are per peer and *finalized*, not raw recent content. The content is
the current screen in the form frames carry it: rows grouped to one datagram's worth, each group
split on its own, newest groups up to the cap. Finalizing buys pre-computed entropy tables and,
more importantly, stamps a dictionary id into every frame header, so a diverged dictionary is
rejected outright instead of decoding to plausible garbage. Install
rides the reliable CTRL lane and is a three-step exchange: the browser signals readiness
(`MSG_TYPE_DISPLAY_DICT_READY` (`0x2b`)), the daemon installs
(`MSG_TYPE_DISPLAY_DICT_INSTALL` (`0x2d`)), and the daemon must not compress against
that dictionary until the browser acknowledges it
(`MSG_TYPE_DISPLAY_DICT_ACK` (`0x2c`)): a successful reliable write is not evidence of install.
Neither the install nor its ACK is ever sent again, so neither is lost between the browser's workers: an install the
full frame ring refuses waits in the transport worker until the terminal worker's drain posts
`FRAME_RING_SPACE_EDGE`, and an ACK the full viewer-output ring refuses waits in the
terminal worker until the transport worker's drain posts `VIEWER_OUTPUT_SPACE_EDGE`. Both use the
input routing word's counted-refusal handshake (`docs/transport.md`, Input Records), and no
timer retries either. Readiness starts clear
on every authentication because the browser's dictionary lives in a terminal worker that
can be replaced while the transport survives. The browser retains the current *and*
immediately previous dictionary, because display datagrams can overtake the install on
the reliable lane. A peer holding no dictionary is a normal state, not a fallback path.

When the edge is the primary display carrier, an eligible critical datagram gets one bounded
compression attempt, taken only when it saves enough bytes or keeps the frame out of the reliable
jumbo lane. Direct critical datagrams and relayed noncritical datagrams do not pay that extra
attempt; stream and bulk delta workloads keep adaptive compression.

## One wrap bit per row

A row prefix carries one wrap bit (`ROW_FLAG_WRAPPED` (`0x8000`), the top bit of `cell_count`),
meaning "this row continues onto the next". The browser's terminal has no VTE parser, so
nothing else can tell it a line wraps, and without it a local resize truncates every
wrapped line rather than rewrapping it. The bit is row-scoped and lives on the row's
*final* cell, the one place alacritty's reflow reads it from, so
`CellRepr::from_alacritty` never sets it and row builders stamp it with `cell_wraps`.
`row_hash` digests it, which is what makes a row that starts wrapping without any cell
changing show up in the diff; it also means a receiver that mis-places the bit diverges
rather than guessing quietly.

## Explicit background coverage

An explicitly painted background remains distinct from the implicit terminal default even
when their RGB values are equal. `CellAttrs::EXPLICIT_DEFAULT_BG` retains that distinction
inside the existing 16-byte cell and 11-byte digest. Other explicit backgrounds are already
distinguishable by their RGB. On the wire, the existing `HAS_BG` bit and color token retain
explicit default-color paint; implicit defaults still omit the color. Both decoders restore
the attribute, so captures, changed ranges, ACK baselines, repair and hashes retain it.

WASM preserves explicit paint as a `Color::Spec` cell. Its receipt, ordering and presentation
follow the same row transaction as text. Background geometry omits only an implicit default;
explicit and inverse backgrounds still produce spans when their RGB matches the terminal
clear color. The image compositor uses these spans between its lowest and middle image layers.

## Links are ids on cells, URIs on the control lane

An OSC 8 hyperlink reaches the browser as a `u32` link id on each cell it covers
(`CellRepr::link`, 0 for none), never as a URI: an OSC 8 target has no length bound and a
display datagram does. On the wire a row whose entry holds any link sets `ROW_FLAG_LINKS`
(`0x8000`, the top bit of `left`; `ROW_FLAG_GRAPHICS` (`0x4000`) is the other flag bit there, both free because columns are capped at 512) and opens its row
bytes with a span table, `count: u16` then `offset: u16 | len: u16 | link: u32` per maximal
run of one id. A row without links pays nothing and encodes exactly as before. The id is a
cell field rather than a side table so every consumer that compares cells — changed-range
selection, ACK baselines, retained captures — sees a link change as it sees a glyph change.
The field does not grow the cell: shape, style and background provenance share one `CellAttrs` byte,
laid out as the digest's flags byte, and `CellRepr` stays 16 bytes (a `const` assertion
holds it there).

`row_hash` covers links only for a row that has one: its 11-byte-per-cell digest is followed
by one `offset | len | link` record (little-endian) per run, so link-free rows hash as they
always did and a link-only change still diverges. term-wasm keeps the ids beside its grid
(`display_cell_links`) and marks the row's hash dirty on a link-only change, which is not
damage because nothing is drawn.

The daemon's `LinkTable` issues ids during row capture and never reuses one. An id names a
URI, not an OSC 8 region: a program that redraws a link emits a new region (a new
`Hyperlink` allocation, and without an explicit OSC 8 id a new generated id) every time, and
keying on the region re-issued, re-defined and retired every link on every redraw. Capture
looks a region's allocation up first and hashes the URI only for an allocation it has not
seen. Only a target the browser would open gets an id (`openable_url`: printable ASCII
`http(s)`); `file:` links from `ls --hyperlink` and systemd, `man:` and editor schemes stay
plain text and cost no span table, digest suffix, or definition. The table holds one clone of
each region; a region whose only remaining clone is the table's is referenced by no grid
cell, scrollback line, or open template, and a URI left with no referenced region is retired.
The pass runs when the held regions have doubled since the last one, and only at the end of
`update_hashes_for_dirty_rows`, where every changed row has just been captured: mid-capture,
a redrawn row further down already holds a new region of a URI whose old one is gone, and
retiring it there would re-issue it under a new id. Retirement advances the table's
generation. `MSG_TYPE_DISPLAY_LINK_TABLE` (CTRL, reliable) carries
`id → URI` records; a peer is sent the whole live table as a reset when its generation
differs, when a display snapshot is scheduled for it, and after every new Noise session, and
only newer ids otherwise. An empty reset is still sent, because it is what stops a browser
resolving one daemon's ids against another session's definitions. Order against datagrams
does not matter: the browser resolves an id only when the user points at it, and an id whose
definition has not arrived is simply not clickable yet.
