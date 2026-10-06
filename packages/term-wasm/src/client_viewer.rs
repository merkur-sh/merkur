//! The browser's exclusive viewer owner. Ingress and output use reusable linear
//! memory; JavaScript carries events and renders the viewer's committed terminal.

use merkur_client::input_sequence::InputMapping;
use merkur_client::session::{DisplayFence, graphics::GraphicsAsset};
use merkur_client::viewer::graphics::Scene;
use merkur_client::viewer::{Output, PredictionCommand, PredictionState, Viewer};
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

use crate::{Terminal, client_grid::ClientGrid};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(
        typescript_type = "(pointer: number, length: number, quadsRevision: number) => boolean"
    )]
    pub type SceneAdmitter;
    #[wasm_bindgen(typescript_type = "(pointer: number, sinceMs: number) => number")]
    pub type DisplayObserver;
    #[wasm_bindgen(method, js_name = call)]
    fn observe_display(
        this: &DisplayObserver,
        context: &JsValue,
        pointer: u32,
        since_ms: f64,
    ) -> f64;
    #[wasm_bindgen(method, js_name = call)]
    fn admit_scene(
        this: &SceneAdmitter,
        context: &JsValue,
        pointer: u32,
        length: u32,
        quads_revision: u32,
    ) -> bool;
}

#[wasm_bindgen]
pub struct ClientViewer {
    viewer: Viewer<ClientGrid>,
    ingress: Zeroizing<Vec<u8>>,
    mapping: InputMapping,
    output_words: [u32; 7],
    output_bytes: Vec<u8>,
    /// What is left of a graphics demand list too long for one output; its
    /// parts go out before anything the viewer queued after it.
    demand_parts: Option<DemandParts>,
    link_revision: u64,
    link_bytes: Vec<u8>,
    trace_words: [u32; 18],
    trace_times: [f64; 5],
    presentation_release: u8,
}

#[wasm_bindgen]
impl ClientViewer {
    /// Consumes the terminal handle: the caller cannot mutate authority outside
    /// the viewer or keep a second owner of its renderer and presentation.
    #[wasm_bindgen(constructor)]
    pub fn new(terminal: Terminal) -> Self {
        Self {
            viewer: Viewer::new(ClientGrid::from_terminal(terminal)),
            ingress: Zeroizing::new(Vec::new()),
            mapping: InputMapping::default(),
            output_words: [0; 7],
            output_bytes: Vec::new(),
            demand_parts: None,
            link_revision: u64::MAX,
            link_bytes: Vec::new(),
            trace_words: [0; 18],
            trace_times: [0.0; 5],
            presentation_release: 0,
        }
    }

    /// Copy into this buffer after reservation, rebinding after memory growth.
    /// Zero refuses an oversized frame without allocating. Bytes are borrowed
    /// for receive; the core retains only frames its lineage actually needs.
    pub fn reserve_ingress(&mut self, capacity: u32) -> usize {
        let capacity = capacity as usize;
        let maximum =
            merkur_wire::protocol::PROTO_MAX_BODY_BYTES + merkur_wire::protocol::PROTO_HEADER_BYTES;
        if capacity == 0 || capacity > maximum {
            return 0;
        }
        if self.ingress.len() < capacity {
            self.ingress.resize(capacity, 0);
        }
        self.ingress.as_mut_ptr() as usize
    }

    pub fn set_input_mapping(&mut self, epoch: u32, delta: u32, first: u32, last: u32) {
        self.mapping = InputMapping {
            epoch,
            local_minus_wire: delta,
            wire_min: first,
            wire_max: last,
        };
    }

    pub fn receive(&mut self, now_ms: f64, channel: u8, length: u32) -> bool {
        let length = length as usize;
        if length == 0 || length > self.ingress.len() || !now_ms.is_finite() {
            return false;
        }
        self.viewer
            .receive(now_ms, channel, &self.ingress[..length], self.mapping);
        true
    }

    /// Replace all account authority while retaining only local font resources.
    /// The host's exact session-instance fence, never a wire frame, calls this.
    pub fn reset_session(&mut self) {
        let grid = self.viewer.grid_mut().fresh_session();
        self.viewer = Viewer::new(grid);
        self.ingress.zeroize();
        self.mapping = InputMapping::default();
        self.output_words.fill(0);
        self.output_bytes.zeroize();
        self.output_bytes.clear();
        self.demand_parts = None;
        self.link_revision = u64::MAX;
        self.link_bytes.zeroize();
        self.link_bytes.clear();
        self.trace_words.fill(0);
        self.trace_times.fill(0.0);
        self.presentation_release = 0;
    }

    pub fn fence(&mut self, now_ms: f64, lineage: u32) {
        // The fence drops the scene's queued demands with the old lineage; the
        // rest of a list already on its way out goes with them.
        self.demand_parts = None;
        self.viewer.fence(now_ms, DisplayFence { lineage });
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.viewer.resize(cols, rows);
    }

    pub fn release_geometry(&mut self, now_ms: f64) {
        self.viewer.release_geometry(now_ms);
    }

    pub fn set_theme(&mut self, bytes: &[u8]) -> bool {
        self.viewer.grid_mut().set_theme(bytes)
    }

    /// Input borrows the same wiping ingress as display. The adapter copies
    /// once; wasm-bindgen never creates an unwiped temporary record vector.
    pub fn input(&mut self, now_ms: f64, sequence: u32, length: u32) -> bool {
        let length = length as usize;
        if length == 0 || length > self.ingress.len() {
            return false;
        }
        let accepted = now_ms.is_finite()
            && sequence != 0
            && self.viewer.input(now_ms, sequence, &self.ingress[..length]);
        self.ingress[..length].zeroize();
        accepted
    }

    /// SAB command kinds are 1 printable, 2 backspace, 3 delete, 4 cursor
    /// shift, 5 flush. The visible bit belongs to the captured key.
    pub fn prediction_command(
        &mut self,
        now_ms: f64,
        sequence: u32,
        kind: u8,
        value: i32,
        visible: bool,
    ) -> bool {
        if !now_ms.is_finite() || sequence == 0 {
            return false;
        }
        let command = match kind {
            1 => PredictionCommand::Printable(value as u32),
            2 => PredictionCommand::Backspace,
            3 => PredictionCommand::Delete,
            4 => PredictionCommand::CursorShift(value),
            5 => PredictionCommand::Flush,
            _ => return false,
        };
        self.viewer
            .prediction_command(now_ms, sequence, command, visible)
    }

    pub fn frame(&mut self, now_ms: f64, period_ms: f64, visible: bool, rtt_ms: f64) -> bool {
        let release = self.viewer.frame(
            now_ms,
            period_ms,
            visible,
            (rtt_ms >= 0.0).then_some(rtt_ms),
        );
        if let Some(release) = release {
            self.presentation_release = release_code(release);
        }
        release.is_some()
    }
    pub fn present_now(&mut self, now_ms: f64) -> bool {
        let release = self.viewer.present_now(now_ms);
        if let Some(release) = release {
            self.presentation_release = release_code(release);
        }
        release.is_some()
    }
    pub fn presentation_release(&self) -> u8 {
        self.presentation_release
    }

    pub fn set_visible(&mut self, now_ms: f64, visible: bool) {
        self.viewer.set_visible(now_ms, visible);
    }

    pub fn resume_visible(&mut self) {
        self.viewer.resume_visible();
    }

    pub fn wants_frame(&self, visible: bool) -> bool {
        self.viewer.wants_frame(visible)
    }

    pub fn next_deadline(&self) -> f64 {
        self.viewer.next_deadline().unwrap_or(f64::INFINITY)
    }

    pub fn handle_timeout(&mut self, now_ms: f64) {
        self.viewer.handle_timeout(now_ms);
    }

    pub fn set_cell_size(&mut self, now_ms: f64, width: f64, height: f64) {
        self.viewer.set_cell_size(now_ms, width, height);
    }

    pub fn set_graphics_resident(&mut self, now_ms: f64, epoch: u32, key: &str, resident: bool) {
        self.viewer
            .set_graphics_resident(now_ms, epoch, key, resident);
    }

    pub fn graphics_manifest(&mut self, now_ms: f64, epoch: u32, key: &str, bytes: &[u8]) {
        self.viewer
            .graphics_manifest(now_ms, epoch, key, bytes.to_vec());
    }

    pub fn graphics_clock(&mut self, now_ms: f64, monotonic_us: u64, rtt_ms: f64) {
        self.viewer.graphics_clock(now_ms, monotonic_us, rtt_ms);
    }

    pub fn link_uri(&self, id: u32) -> Option<String> {
        self.viewer
            .links()
            .uri(id)
            .and_then(merkur_client::viewer::links::host_uri)
            .map(str::to_owned)
    }

    /// Output kind is returned directly. The fixed native-endian words and
    /// byte buffer remain valid until the next poll; readers must copy anything
    /// they send to another worker. No per-datagram JS object is constructed.
    /// 1 ACK: word 0 durable, bytes canonical ACK body.
    /// 2 snapshot request. 3 resync: word 0 generation, big-endian u16 rows.
    /// 4 dictionary ready: word 0 boolean. 5 dictionary ACK: word 0 id.
    /// 6 resume: generation, applied seq, repair, cols, rows, hashes-present;
    ///   bytes big-endian u64 hashes. 7 graphics: epoch, the records in this
    ///   part, flags (bit 0 more parts follow, bit 1 this part continues a
    ///   list); records asset:u8, level:u8, reserved:2,
    ///   frame/x/y/width/height:u32 BE, authority:32, source:32,
    ///   key length:u32 BE, UTF-8 key.
    /// No output's bytes exceed [`VIEWER_OUTPUT_MAX_BYTES`]: a longer demand
    /// list is returned in parts, by the polls that follow one another.
    pub fn poll_output(&mut self, now_ms: f64) -> u8 {
        self.output_words.fill(0);
        self.output_bytes.clear();
        if self.demand_parts.is_some() {
            return self.poll_demand_part();
        }
        let Some(output) = self.viewer.poll_output(now_ms) else {
            return 0;
        };
        match output {
            Output::Ack { payload, durable } => {
                self.output_words[0] = u32::from(durable);
                self.output_bytes.extend_from_slice(&payload.encode());
                1
            }
            Output::SnapshotRequest => 2,
            Output::ResyncRows { generation, rows } => {
                self.output_words[0] = generation;
                for row in rows {
                    self.output_bytes.extend_from_slice(&row.to_be_bytes());
                }
                3
            }
            Output::DictionaryReady(ready) => {
                self.output_words[0] = u32::from(ready);
                4
            }
            Output::DictionaryAck(id) => {
                self.output_words[0] = id;
                5
            }
            Output::Resume(resume) => {
                self.output_words[..6].copy_from_slice(&[
                    resume.generation,
                    resume.applied_seq,
                    resume.repair_id,
                    u32::from(resume.cols),
                    u32::from(resume.rows),
                    u32::from(resume.row_hashes.is_some()),
                ]);
                for hash in resume.row_hashes.into_iter().flatten() {
                    self.output_bytes.extend_from_slice(&hash.to_be_bytes());
                }
                6
            }
            Output::GraphicsDemand { epoch, demands } => {
                self.demand_parts = Some(DemandParts {
                    epoch,
                    demands,
                    next: 0,
                });
                self.poll_demand_part()
            }
        }
    }

    /// The largest byte body `poll_output` returns: what the ring that carries
    /// an output to the session's worker sizes its entries by.
    pub fn output_max_bytes(&self) -> usize {
        VIEWER_OUTPUT_MAX_BYTES
    }

    pub fn set_presentation_ready(&mut self, ready: bool) {
        self.viewer.set_presentation_ready(ready);
    }
    pub fn set_tracing(&mut self, enabled: bool) {
        self.viewer.set_tracing(enabled);
    }
    /// Synchronous telemetry only: the callback must not reenter this viewer.
    /// Words: stage, seq, generation, input, frame, chunk index/count,
    /// presentation, member index/count, row predecessor, flags, bytes, rows.
    /// Stage 5 is a discarded transaction instead: generation, first and last
    /// seq, datagrams, rows, bytes, reason.
    pub fn set_display_observer(&mut self, observer: DisplayObserver) {
        self.viewer
            .grid_mut()
            .set_display_observer(Box::new(move |words, since_ms| {
                observer.observe_display(&JsValue::NULL, words.as_ptr() as u32, since_ms)
            }));
    }
    /// Before the host frees the viewer: tells the observer what stays unshown.
    pub fn discard_presentation(&mut self) {
        self.viewer.discard_presentation();
    }
    pub fn take_presentation_trace(&mut self) -> bool {
        let Some(trace) = self.viewer.take_presentation_trace() else {
            return false;
        };
        self.trace_words = trace.words;
        self.trace_times = trace.times;
        true
    }
    pub fn trace_words_ptr(&self) -> *const u32 {
        self.trace_words.as_ptr()
    }
    pub fn trace_times_ptr(&self) -> *const f64 {
        self.trace_times.as_ptr()
    }

    pub fn applied_frame_id(&self) -> u32 {
        self.viewer.applied_identity().1
    }
    pub fn applied_snapshot(&self) -> bool {
        self.viewer.applied_identity().2
    }
    pub fn applied_sequence(&self) -> u32 {
        self.viewer.applied_sequence()
    }
    pub fn request_snapshot(&mut self, now_ms: f64) {
        self.viewer.request_snapshot(now_ms);
    }

    pub fn request_row_repair(&mut self, generation: u32, rows: &[u16]) -> bool {
        self.viewer.request_row_repair(generation, rows)
    }

    /// The link table's revision, its low 32 bits: the host compares it with
    /// the one it last published and nothing else, and a `u64` would cross to
    /// JavaScript as a fresh `BigInt` on every frame.
    pub fn refresh_links(&mut self) -> u32 {
        let links = self.viewer.links();
        if self.link_revision != links.revision() {
            self.link_revision = links.revision();
            self.link_bytes.clear();
            for (id, uri) in links.entries() {
                self.link_bytes.extend_from_slice(&id.to_le_bytes());
                scene_string(&mut self.link_bytes, uri);
            }
        }
        self.link_revision as u32
    }
    pub fn links_bytes_ptr(&self) -> *const u8 {
        self.link_bytes.as_ptr()
    }
    pub fn links_bytes_len(&self) -> usize {
        self.link_bytes.len()
    }

    /// Called synchronously while the core owns its mutable grid. The callback
    /// consumes only these bytes and must never reenter the WASM viewer.
    pub fn set_scene_admitter(&mut self, admit: SceneAdmitter) {
        let mut bytes = Vec::new();
        let mut quads = Rc::clone(&self.viewer.graphics_scene().quads);
        let mut revision = 0u32;
        self.viewer
            .grid_mut()
            .set_graphics_admitter(Box::new(move |scene| {
                if !Rc::ptr_eq(&quads, &scene.quads) {
                    quads = Rc::clone(&scene.quads);
                    revision = revision
                        .checked_add(1)
                        .expect("scene quad revision exhausted");
                }
                bytes.clear();
                encode_scene(scene, &mut bytes);
                admit.admit_scene(
                    &JsValue::NULL,
                    bytes.as_ptr() as u32,
                    bytes.len() as u32,
                    revision,
                )
            }));
    }
    pub fn reproject_graphics(&mut self, now_ms: f64) {
        self.viewer.reproject_graphics(now_ms);
    }

    pub fn generation(&self) -> u32 {
        self.viewer.generation()
    }
    pub fn prediction_armed(&self) -> bool {
        self.viewer.prediction_armed()
    }
    pub fn prediction_authority_revision(&self) -> u32 {
        self.viewer.prediction_authority_revision()
    }
    pub fn prediction_state(&self) -> u8 {
        match self.viewer.prediction().state {
            PredictionState::Learning => 0,
            PredictionState::Visible => 1,
            PredictionState::Suppressed => 2,
        }
    }
    pub fn authoritative_input(&self) -> u32 {
        self.viewer.authoritative_input()
    }
    pub fn presentation_held(&mut self) -> bool {
        self.viewer.presentation_held()
    }
    /// Bit order: held, claim pending, repaint hold, awaits snapshot, awaits
    /// frames, pending transaction, completion opportunity, ready, render
    /// pending, resync pending, unrooted, epoch reset, claim met, hidden, early.
    pub fn presentation_gates(&self) -> u32 {
        self.viewer.presentation_gates()
    }
    /// Frames, snapshots and presentations so far, their low 32 bits. The
    /// host reads all three on every frame only to see whether they moved,
    /// which a wrap cannot hide; as `u64` each read would mint a `BigInt`.
    pub fn applied_frames(&self) -> u32 {
        self.viewer.stats().frames as u32
    }
    pub fn recovered_frames(&self) -> u64 {
        self.viewer.stats().recovered
    }
    pub fn applied_snapshots(&self) -> u32 {
        self.viewer.stats().snapshots as u32
    }

    pub fn applied_rows(&self) -> u64 {
        self.viewer.stats().rows
    }

    pub fn applied_presentations(&self) -> u32 {
        self.viewer.stats().presentations as u32
    }
    pub fn discard_input(&mut self) {
        self.viewer.discard_input();
    }

    pub fn output_words_ptr(&self) -> *const u32 {
        self.output_words.as_ptr()
    }

    pub fn output_bytes_ptr(&self) -> *const u8 {
        self.output_bytes.as_ptr()
    }

    pub fn output_bytes_len(&self) -> usize {
        self.output_bytes.len()
    }
}

impl ClientViewer {
    fn poll_demand_part(&mut self) -> u8 {
        let Some(mut parts) = self.demand_parts.take() else {
            return 0;
        };
        if !parts.write_next(&mut self.output_words, &mut self.output_bytes) {
            self.demand_parts = Some(parts);
        }
        7
    }
}

/// The largest byte body one polled output carries. Every output but a graphics
/// demand list is far smaller: a resume claim is eight bytes for each of at
/// most 256 rows. A demand record is 92 bytes and its key, a root in hex and a
/// tile address, so one part holds twenty or more.
const VIEWER_OUTPUT_MAX_BYTES: usize = 4096;
const DEMAND_MORE: u32 = 1;
const DEMAND_CONTINUES: u32 = 2;

/// A graphics demand list on its way out, and how far it has got.
struct DemandParts {
    epoch: u32,
    demands: Vec<merkur_client::session::graphics::GraphicsDemand>,
    next: usize,
}

impl DemandParts {
    /// Write the next part: as many whole records as fit, and always one. True
    /// once the list is out.
    fn write_next(&mut self, words: &mut [u32; 7], bytes: &mut Vec<u8>) -> bool {
        let first = self.next;
        while let Some(demand) = self.demands.get(self.next) {
            if self.next > first && bytes.len() + 92 + demand.key.len() > VIEWER_OUTPUT_MAX_BYTES {
                break;
            }
            bytes.extend_from_slice(&[
                u8::from(demand.asset == GraphicsAsset::Animation),
                demand.level,
                0,
                0,
            ]);
            for word in [
                demand.frame,
                demand.x,
                demand.y,
                demand.width,
                demand.height,
            ] {
                bytes.extend_from_slice(&word.to_be_bytes());
            }
            bytes.extend_from_slice(&demand.authority);
            bytes.extend_from_slice(&demand.source);
            bytes.extend_from_slice(&(demand.key.len() as u32).to_be_bytes());
            bytes.extend_from_slice(demand.key.as_bytes());
            self.next += 1;
        }
        let done = self.next == self.demands.len();
        words[0] = self.epoch;
        words[1] = (self.next - first) as u32;
        if !done {
            words[2] |= DEMAND_MORE;
        }
        if first != 0 {
            words[2] |= DEMAND_CONTINUES;
        }
        done
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_client::session::graphics::GraphicsDemand;

    fn demand(index: u32) -> GraphicsDemand {
        GraphicsDemand {
            asset: GraphicsAsset::Tile,
            authority: [index as u8; 32],
            frame: 0,
            key: format!("{:064x}:3:{index}:{index}", u64::from(index)),
            source: [index as u8; 32],
            level: 3,
            x: index,
            y: index,
            width: 258,
            height: 258,
        }
    }

    #[test]
    fn a_long_demand_list_goes_out_in_bounded_parts_that_name_their_place() {
        let demands: Vec<_> = (0..100).map(demand).collect();
        let mut parts = DemandParts {
            epoch: 9,
            demands,
            next: 0,
        };
        let (mut records, mut flags) = (0, Vec::new());
        loop {
            let (mut words, mut bytes) = ([0; 7], Vec::new());
            let done = parts.write_next(&mut words, &mut bytes);
            assert!(bytes.len() <= VIEWER_OUTPUT_MAX_BYTES);
            assert!(words[1] > 0);
            assert_eq!(words[0], 9);
            records += words[1];
            flags.push(words[2]);
            if done {
                break;
            }
        }
        assert_eq!(records, 100);
        assert!(flags.len() > 1, "a hundred records exceed one part");
        assert_eq!(flags[0], DEMAND_MORE);
        assert_eq!(flags[flags.len() - 1], DEMAND_CONTINUES);
        assert!(
            flags[1..flags.len() - 1]
                .iter()
                .all(|flags| *flags == DEMAND_MORE | DEMAND_CONTINUES)
        );
    }

    #[test]
    fn a_short_or_empty_demand_list_is_one_part() {
        for count in [0, 1, 20] {
            let mut parts = DemandParts {
                epoch: 4,
                demands: (0..count).map(demand).collect(),
                next: 0,
            };
            let (mut words, mut bytes) = ([0; 7], Vec::new());
            assert!(parts.write_next(&mut words, &mut bytes));
            assert_eq!(words[..3], [4, count, 0]);
        }
    }
}

// The renderer borrows exactly the terminal the viewer commits. Keep authority,
// prediction, ordering and presentation mutation out of these delegations.
macro_rules! render_methods {
    (read { $(fn $read:ident($($arg:ident: $ty:ty),*) -> $result:ty;)* }
     mutate { $(fn $write:ident($($warg:ident: $wty:ty),*) -> $wresult:ty;)* }) => {
        #[wasm_bindgen]
        impl ClientViewer {
            $(pub fn $read(&self, $($arg: $ty),*) -> $result {
                self.viewer.grid().terminal().$read($($arg),*)
            })*
            $(pub fn $write(&mut self, $($warg: $wty),*) -> $wresult {
                self.viewer.grid_mut().terminal_mut().$write($($warg),*)
            })*
        }
    };
}

render_methods! {
    read {
        fn cols() -> u16;
        fn rows() -> u16;
        fn row_hashes_len() -> u16;
        fn display_row_version(row: u16) -> u32;
        fn cursor_info_len() -> usize;
        fn cursor_motion_ptr() -> *const u32;
        fn cursor_motion_len() -> usize;
        fn cursor_motion_dropped() -> u32;
        fn last_flush_cause() -> u32;
        fn prediction_model_len() -> usize;
        fn reconcile_stats_ptr() -> *const u32;
        fn reconcile_stats_len() -> usize;
        fn prediction_render_dirty() -> bool;
        fn has_predictions() -> bool;
        fn visible_prediction_input_seqs_ptr() -> *const u32;
        fn visible_prediction_input_seqs_len() -> usize;
        fn visible_prediction_clear_effect_pairs_ptr() -> *const u32;
        fn visible_prediction_clear_effect_pairs_len() -> usize;
        fn visible_prediction_input_seqs_truncated() -> bool;
        fn cell_metrics_len() -> usize;
        fn atlas_is_dirty() -> bool;
        fn atlas_dirty_rect_len() -> usize;
        fn atlas_pixels_ptr() -> *const u8;
        fn atlas_width() -> u32;
        fn atlas_height() -> u32;
        fn atlas_generation() -> u32;
        fn speculative_ascii_entries_ptr() -> *const i32;
        fn speculative_ascii_entries_len() -> usize;
        fn missing_codepoints_len() -> usize;
        fn presentation_revision() -> u32;
        fn presentation_cols() -> u16;
        fn presentation_rows() -> u16;
        fn presentation_row_version(row: u16) -> u32;
        fn geometry_state_ptr() -> *const u32;
        fn geometry_state_len() -> usize;
        fn mouse_mode() -> u32;
        fn viewport_rows() -> String;
        fn presentation_viewport_rows() -> String;
        fn viewport_links() -> Vec<u32>;
        fn viewport_text_columns() -> Vec<u16>;
        fn viewport_wrap_bits() -> Vec<u8>;
        fn presentation_viewport_wrap_bits() -> Vec<u8>;
    }
    mutate {
        fn graphics_ptr() -> *const u8;
        fn graphics_len() -> usize;
        fn refresh_row_hashes() -> *const u64;
        fn row_hash(row: u16) -> u64;
        fn cursor_info_ptr() -> *const u16;
        fn received_cursor_info_ptr() -> *const u16;
        fn set_cursor_motion_journal(enabled: bool) -> ();
        fn clear_cursor_motion() -> ();
        fn prediction_model_ptr() -> *const u32;
        fn clear_prediction_render_dirty() -> ();
        fn set_font_bytes(normal: &[u8], bold: &[u8], italic: &[u8], bold_italic: &[u8]) -> ();
        fn set_regular_font_bytes(normal: &[u8]) -> ();
        fn set_style_font_bytes(bold: &[u8], italic: &[u8], bold_italic: &[u8]) -> ();
        fn set_cell_metrics(px_per_em: f32, line_height: f32, dpr: f32) -> ();
        fn cell_metrics_ptr() -> *const f32;
        fn atlas_dirty_rect_ptr() -> *const u32;
        fn prepare_speculative_ascii_atlas() -> bool;
        fn atlas_mark_clean() -> ();
        fn missing_codepoints_ptr() -> *const u32;
        fn finish_missing_pass() -> ();
        fn inject_glyph(cp: u32, style: u8, w: u16, h: u16, ox: i16, oy: i16, pixels: &[u8]) -> bool;
        fn build_geometry() -> ();
        fn set_preedit(text: &str, caret: u32) -> ();
    }
}

fn scene_string(bytes: &mut Vec<u8>, value: &str) {
    bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
    bytes.extend_from_slice(value.as_bytes());
}

fn encode_scene(scene: &Scene, bytes: &mut Vec<u8>) {
    for count in [scene.quads.len(), scene.tiles.len(), scene.animations.len()] {
        bytes.extend_from_slice(&(count as u32).to_le_bytes());
    }
    for quad in scene.quads.iter() {
        bytes.extend_from_slice(&[quad.layer, 0, 0, 0]);
        for value in [
            quad.left,
            quad.top,
            quad.right,
            quad.bottom,
            quad.u,
            quad.v,
            quad.uw,
            quad.vh,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        scene_string(bytes, &quad.key);
    }
    for tile in &scene.tiles {
        bytes.extend_from_slice(&[
            u8::from(tile.asset == GraphicsAsset::Animation),
            tile.level,
            0,
            0,
        ]);
        for word in [tile.frame, tile.x, tile.y, tile.width, tile.height] {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        bytes.extend_from_slice(&tile.authority);
        bytes.extend_from_slice(&tile.source);
        scene_string(bytes, &tile.key);
    }
    for animation in &scene.animations {
        scene_string(bytes, &animation.key);
        bytes.extend_from_slice(&(animation.bindings.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&[u8::from(animation.reserve), 0, 0, 0]);
        for (binding, tile) in &animation.bindings {
            scene_string(bytes, binding);
            scene_string(bytes, tile);
        }
    }
}

fn release_code(release: merkur_client::viewer::presentation::Release) -> u8 {
    use merkur_client::viewer::presentation::Release;
    match release {
        Release::None => 0,
        Release::EndQuiet => 1,
        Release::Deadline => 2,
        Release::Urgent => 3,
        Release::MembershipComplete => 4,
        Release::ClosureComplete => 5,
        Release::PacedComplete => 6,
    }
}
