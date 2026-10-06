//! Browser host binding for the one sans-IO session. Network records and input
//! borrow reusable, wiping ingress; only public cold action metadata is JSON.

use merkur_authorization::{DelegationCertificate, PUBLIC_KEY_BYTES, parse_canonical};
use merkur_client::{
    Entropy,
    auth::Delegation,
    issuance::{Issuance, RenewalCapability},
    liveness::PathKind,
    session::{
        Action, Config, ConnId, DisplayResume, Event, Session, Status,
        geometry::GeometryStatus,
        graphics::{FinitePart, GraphicsAsset, GraphicsDemand, GraphicsPhase, MAX_DEMANDS},
    },
};
use merkur_e2e::DaemonIdentitySigningKey;
use merkur_edge_protocol::SpliceControlEvent;
use merkur_wire::{
    protocol::{DisplayAckPayload, OpenUrlId},
    terminal_ui::TerminalUi,
};
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

const MAX_INGRESS: usize = 16 * 1024 * 1024;

struct BrowserEntropy;
impl Entropy for BrowserEntropy {
    fn fill(&mut self, bytes: &mut [u8]) {
        getrandom::fill(bytes).expect("operating system entropy is required for authentication");
    }
}

#[wasm_bindgen]
pub struct ClientSession {
    session: Session,
    /// The browser's delegate key is software: it answers the session's
    /// signature requests in the turn that raised them.
    delegate_key: DaemonIdentitySigningKey,
    ingress: Zeroizing<Vec<u8>>,
    words: [u32; 12],
    bytes: Zeroizing<Vec<u8>>,
    metadata: Zeroizing<String>,
    lineage: u32,
    demands: DemandList,
}

#[wasm_bindgen]
impl ClientSession {
    /// wasm-bindgen copies the mutable seed and writes its wiped bytes back.
    /// The Rust copy is zeroizing; immutable browser strings are not used for keys.
    #[wasm_bindgen(constructor)]
    pub fn new(
        certificate: &str,
        root_public_key: &[u8],
        server_origin: String,
        browser_node_id: String,
        relay_only: bool,
        seed: &mut [u8],
    ) -> Result<Self, JsError> {
        let mut seed_copy = Zeroizing::new([0; 32]);
        if seed.len() != seed_copy.len() {
            seed.zeroize();
            return Err(JsError::new("invalid delegate seed"));
        }
        seed_copy.copy_from_slice(seed);
        seed.zeroize();
        let certificate: DelegationCertificate =
            parse_canonical(certificate, "delegation certificate")
                .map_err(|error| JsError::new(&error.to_string()))?;
        let root: [u8; PUBLIC_KEY_BYTES] = root_public_key
            .try_into()
            .map_err(|_| JsError::new("invalid delegation root public key"))?;
        let delegate_key = DaemonIdentitySigningKey::from_seed(&mut *seed_copy)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let delegation = Delegation {
            certificate,
            root_public_key: Box::new(root),
            server_origin,
        };
        Ok(Self {
            session: Session::new(
                Config {
                    browser_node_id,
                    relay_only,
                },
                delegation,
            ),
            delegate_key,
            ingress: Zeroizing::new(Vec::new()),
            words: [0; 12],
            bytes: Zeroizing::new(Vec::new()),
            metadata: Zeroizing::new(String::new()),
            lineage: 0,
            demands: DemandList::default(),
        })
    }

    pub fn reserve_ingress(&mut self, length: u32) -> usize {
        let length = length as usize;
        if length == 0 || length > MAX_INGRESS {
            return 0;
        }
        if self.ingress.len() < length {
            self.ingress.resize(length, 0);
        }
        self.ingress.as_mut_ptr() as usize
    }

    pub fn suspend(&mut self) {
        self.session.suspend();
    }
    pub fn connect(&mut self, daemon_id: &str) {
        self.session.connect(daemon_id, &mut BrowserEntropy);
    }
    pub fn is_ready(&self) -> bool {
        self.session.is_ready()
    }
    pub fn display_lineage(&self) -> u32 {
        self.session.display_lineage()
    }
    pub fn session_id(&self) -> Option<String> {
        self.session.session_id().map(str::to_owned)
    }
    pub fn rtt_ms(&self) -> f64 {
        self.session.rtt_ms().unwrap_or(-1.0)
    }
    pub fn network_rtt_ms(&self) -> f64 {
        self.session.network_rtt_ms().unwrap_or(-1.0)
    }
    pub fn quality_revision(&self) -> u32 {
        self.session.quality_revision()
    }
    pub fn input_ack_local(&self) -> u32 {
        self.session.input_ack_projection().0
    }
    pub fn input_ack_at(&self) -> f64 {
        self.session.input_ack_projection().1 as f64
    }
    pub fn input_sent_local(&self) -> u32 {
        self.session.input_sent_projection().0
    }
    pub fn input_sent_at(&self) -> f64 {
        self.session.input_sent_projection().1 as f64
    }
    pub fn quality(&self, now: f64) -> String {
        serde_json::to_string(&self.session.quality(time(now).unwrap_or(0)))
            .expect("metric snapshot")
    }
    pub fn input_datagram_sent(&mut self, now: f64, conn: u64, top_seq: u32) {
        self.deliver(
            now,
            Event::InputDatagramSent {
                conn: ConnId(conn),
                top_seq,
            },
        );
    }
    pub fn released_input(&self) -> u32 {
        self.session.input_released_local()
    }
    pub fn next_deadline(&self) -> f64 {
        self.session
            .next_deadline()
            .map_or(f64::INFINITY, |at| at as f64)
    }
    pub fn timeout(&mut self, now: f64) {
        if let Some(now) = time(now) {
            self.session.handle_timeout(now, &mut BrowserEntropy);
        }
    }
    pub fn connectivity_hint(&mut self, now: f64) {
        if let Some(now) = time(now) {
            self.session.connectivity_hint(now, &mut BrowserEntropy);
        }
    }
    pub fn issued(&mut self, now: f64, json: &str) {
        if let Some(now) = time(now) {
            self.session.handle(
                now,
                Event::Issued(Issuance::parse(json.as_bytes()).map(Box::new)),
                &mut BrowserEntropy,
            );
            self.answer_signatures(now);
        }
    }
    pub fn issuance_failed(&mut self, now: f64) {
        self.deliver(now, Event::IssuanceFailed);
    }
    pub fn daemon_unlinked(&mut self, now: f64) {
        self.deliver(now, Event::DaemonUnlinked);
    }
    pub fn authorization_denied(&mut self, now: f64) {
        self.deliver(now, Event::AuthorizationDenied);
    }
    pub fn renewed(&mut self, now: f64, json: &str) {
        if let Some(now) = time(now) {
            self.session.handle(
                now,
                Event::Renewed(RenewalCapability::parse(json.as_bytes())),
                &mut BrowserEntropy,
            );
            self.answer_signatures(now);
        }
    }
    pub fn connected(&mut self, now: f64, conn: u64) {
        self.deliver(now, Event::Connected(ConnId(conn)));
    }
    pub fn dial_failed(&mut self, now: f64, conn: u64) {
        self.deliver(now, Event::DialFailed(ConnId(conn)));
    }
    pub fn closed(&mut self, now: f64, conn: u64, egress_budget: bool) {
        self.deliver(
            now,
            Event::Closed {
                conn: ConnId(conn),
                egress_budget,
            },
        );
    }
    pub fn splice(&mut self, now: f64, conn: u64, json: &str) -> bool {
        let Ok(event) = serde_json::from_str::<SpliceControlEvent>(json) else {
            return false;
        };
        self.deliver(now, Event::Splice(ConnId(conn), event));
        true
    }
    /// kind: 0 reliable, 1 datagram, 2 proof, 3 finite begin, 4 finite data,
    /// 5 finite complete, 6 finite failed. Finite total is supplied as length
    /// at begin; all other byte-bearing events borrow ingress[..length].
    pub fn receive(
        &mut self,
        now: f64,
        kind: u8,
        conn: u64,
        source: u64,
        channel: u8,
        length: u32,
    ) -> bool {
        let Some(now) = time(now) else {
            return false;
        };
        let conn = ConnId(conn);
        let length = length as usize;
        if !matches!(kind, 3 | 5 | 6) && length > self.ingress.len() {
            return false;
        }
        let event = match kind {
            0 => Event::Reliable {
                conn,
                source,
                channel,
                payload: &self.ingress[..length],
            },
            1 => Event::Datagram {
                conn,
                payload: &self.ingress[..length],
            },
            2 => Event::Proof {
                conn,
                payload: &self.ingress[..length],
            },
            3 => Event::Finite {
                conn,
                stream: source,
                part: FinitePart::Begin {
                    channel,
                    total: length as u32,
                },
            },
            4 => Event::Finite {
                conn,
                stream: source,
                part: FinitePart::Data(&self.ingress[..length]),
            },
            5 | 6 => Event::Finite {
                conn,
                stream: source,
                part: FinitePart::End {
                    complete: kind == 5,
                },
            },
            _ => return false,
        };
        self.session.handle(now, event, &mut BrowserEntropy);
        if !matches!(kind, 3 | 5 | 6) {
            self.ingress[..length].zeroize();
        }
        true
    }
    pub fn input(&mut self, now: f64, sequence: u32, length: u32, modelled: bool) -> bool {
        let length = length as usize;
        if length == 0 || length > self.ingress.len() {
            return false;
        }
        let accepted =
            if let Some(now) = time(now).filter(|_| sequence != 0 && !self.session.is_closed()) {
                self.session
                    .send_input(now, sequence, self.ingress[..length].to_vec(), modelled);
                !self.session.is_closed()
            } else {
                false
            };
        self.ingress[..length].zeroize();
        accepted
    }
    pub fn host_observation(&mut self, frame: &[u8]) -> bool {
        self.session.send_host_observation(frame)
    }
    pub fn viewport(&mut self, cols: u16, rows: u16, width: f64, height: f64) {
        if cols != 0
            && rows != 0
            && width.is_finite()
            && height.is_finite()
            && width > 0.0
            && height > 0.0
        {
            self.session.set_viewport(cols, rows, Some((width, height)));
        }
    }
    pub fn focused(&mut self, focused: bool) {
        self.session.set_focused(focused);
    }
    pub fn take_geometry(&mut self) {
        self.session.take_geometry();
    }
    pub fn snapshot(&mut self, now: f64) {
        if let Some(now) = time(now) {
            self.session.request_display_snapshot(now);
        }
    }
    pub fn acknowledge_open_url(&mut self, epoch: u32, seq: u32) {
        self.session.acknowledge_open_url(OpenUrlId { epoch, seq });
    }

    /// One viewer output from reserved ingress: its seven words, little-endian,
    /// then its bytes, exactly as the viewer's `poll_output` left them. Decoded
    /// here so TypeScript owns no protocol serialization, ACK coalescing,
    /// dictionary state or resume authority.
    pub fn ingest_viewer_output(&mut self, now: f64, lineage: u32, kind: u8, length: u32) -> bool {
        let length = length as usize;
        if lineage == 0
            || lineage != self.lineage
            || length < VIEWER_WORDS_BYTES
            || length > self.ingress.len()
        {
            return false;
        }
        let Some(now) = time(now) else {
            return false;
        };
        let mut words = [0u32; 7];
        for (word, bytes) in words
            .iter_mut()
            .zip(self.ingress[..VIEWER_WORDS_BYTES].chunks_exact(4))
        {
            *word = u32::from_le_bytes(bytes.try_into().expect("four bytes"));
        }
        let bytes = &self.ingress[VIEWER_WORDS_BYTES..length];
        match kind {
            1 => {
                let Some(ack) = DisplayAckPayload::parse(bytes) else {
                    return false;
                };
                self.session.send_display_ack(now, &ack, words[0] != 0);
            }
            2 if bytes.is_empty() => self.session.request_display_snapshot(now),
            3 if bytes.len().is_multiple_of(2) => {
                let rows: Vec<_> = bytes
                    .chunks_exact(2)
                    .map(|b| u16::from_be_bytes([b[0], b[1]]))
                    .collect();
                self.session.send_display_resync_rows(words[0], &rows);
            }
            4 if bytes.is_empty() => self.session.send_display_dictionary_ready(words[0] != 0),
            5 if bytes.is_empty() => self.session.send_display_dictionary_ack(words[0]),
            6 => {
                let (Ok(cols), Ok(rows)) = (u16::try_from(words[3]), u16::try_from(words[4]))
                else {
                    return false;
                };
                let row_hashes = if words[5] == 0 {
                    if !bytes.is_empty() {
                        return false;
                    }
                    None
                } else {
                    if bytes.len() != usize::from(rows) * 8 {
                        return false;
                    }
                    Some(
                        bytes
                            .chunks_exact(8)
                            .map(|b| u64::from_be_bytes(b.try_into().expect("eight bytes")))
                            .collect(),
                    )
                };
                self.session.send_display_resume(
                    now,
                    &DisplayResume {
                        generation: words[0],
                        applied_seq: words[1],
                        repair_id: words[2],
                        cols,
                        rows,
                        row_hashes,
                    },
                );
            }
            7 => {
                let part = decode_demands(words[1], bytes);
                match self.demands.accept(words[0], words[2], part) {
                    Ok(Some(demands)) => self.session.graphics_demand(words[0], demands),
                    Ok(None) => {}
                    Err(()) => return false,
                }
            }
            _ => return false,
        }
        true
    }

    /// 1 issuance, 2 renewal, 3 edge dial, 4 direct dial, 5 reliable send,
    /// 6 proof send, 7 datagram send, 8 close, 9 terminal, 10 fence, 11 status,
    /// 12 path, 13 geometry, 14 graphics clock, 15 graphics asset, 16 open URL,
    /// 17 terminal UI. Conn u64 occupies words 0/1 (low/high).
    /// Retire native handles even while an older stream write awaits credit.
    pub fn host_actions_len(&self) -> usize {
        self.session.host_bearing_actions_len()
    }
    pub fn host_actions_bytes(&self) -> usize {
        self.session.host_bearing_actions_bytes()
    }

    pub fn poll_close(&mut self, now: f64) -> Option<u64> {
        let now_ms = time(now)?;
        self.session
            .poll_close_action(now_ms)
            .map(|action| match action {
                Action::Close { conn } => conn.0,
                _ => unreachable!("only Close actions are extracted"),
            })
    }

    /// Native writer credit is exact per carrier/channel; another lane remains pollable.
    pub fn has_reliable_capacity(&self, channel: u8) -> bool {
        self.session.has_reliable_capacity(channel)
    }

    pub fn reliable_blocked(&mut self, now_ms: f64, conn: u64, channel: u8, blocked: bool) {
        self.session
            .set_reliable_blocked(now_ms as u64, ConnId(conn), channel, blocked);
    }

    pub fn poll_action(&mut self, io: bool) -> u8 {
        self.words.fill(0);
        // `bytes` holds what the last action appended after this clear, or the
        // frame it presented, so every byte that action held lies below `len`.
        // Wiping that prefix wipes all of it; `Vec::zeroize` would also sweep
        // the whole capacity the largest action ever reserved, on every poll.
        // Dropping the `Zeroizing` owner still wipes the full capacity.
        self.bytes.as_mut_slice().zeroize();
        self.bytes.clear();
        self.metadata.zeroize();
        self.metadata.clear();
        let action = if io {
            self.session.poll_available_io_action()
        } else {
            self.session.poll_host_action()
        };
        let Some(action) = action else {
            return 0;
        };
        match action {
            Action::RequestIssuance(request) => {
                *self.metadata = serde_json::to_string(&request).expect("issuance metadata");
                1
            }
            Action::RequestRenewal(request) => {
                *self.metadata = serde_json::to_string(&request).expect("renewal metadata");
                2
            }
            Action::Dial {
                conn,
                lane,
                url,
                cert_hashes,
                preface,
                candidate,
            } => {
                self.conn(conn);
                self.words[2] = match lane {
                    merkur_wire::protocol::EdgeLane::Signaling => 0,
                    merkur_wire::protocol::EdgeLane::Interactive => 1,
                    merkur_wire::protocol::EdgeLane::Bulk => 2,
                };
                self.words[3] = u32::from(candidate);
                self.bytes.extend_from_slice(&preface);
                *self.metadata =
                    serde_json::json!({ "url": url, "certHashes": cert_hashes }).to_string();
                3
            }
            Action::DialDirect {
                conn,
                addr,
                cert_hash,
            } => {
                self.conn(conn);
                *self.metadata = serde_json::json!({ "url": format!("https://{addr}"), "certHashes": [cert_hash] }).to_string();
                4
            }
            Action::SendReliable {
                conn,
                channel,
                payload,
            } => {
                self.conn(conn);
                self.words[2] = u32::from(channel);
                self.present(payload);
                5
            }
            Action::SendProof { conn, payload } => {
                self.conn(conn);
                self.present(payload);
                6
            }
            Action::SendDatagram { conn, payload } => {
                self.conn(conn);
                self.present(payload);
                7
            }
            Action::SendInputDatagram {
                conn,
                payload,
                top_seq,
            } => {
                self.conn(conn);
                self.words[2] = top_seq;
                self.present(payload);
                7
            }
            Action::Close { conn } => {
                self.conn(conn);
                8
            }
            Action::Terminal {
                channel,
                datagram,
                payload,
                input,
            } => {
                self.words[..6].copy_from_slice(&[
                    u32::from(channel),
                    u32::from(datagram),
                    input.epoch,
                    input.local_minus_wire,
                    input.wire_min,
                    input.wire_max,
                ]);
                self.present(payload);
                9
            }
            Action::DisplayFence(fence) => {
                self.lineage = fence.lineage;
                // A list the old lineage's viewer left unfinished ends with it.
                self.demands = DemandList::default();
                self.words[0] = fence.lineage;
                10
            }
            Action::Status(status) => {
                self.words[0] = match status {
                    Status::Connecting => 0,
                    Status::Authenticating => 1,
                    Status::Ready => 2,
                    Status::Reconnecting => 3,
                    Status::RelayPaused => 4,
                    Status::Closed(reason) => {
                        *self.metadata = format!("{reason:?}");
                        5
                    }
                };
                11
            }
            Action::ObservedPath(address) => {
                *self.metadata = address.to_string();
                18
            }
            Action::Observation(value) => {
                *self.metadata = serde_json::to_string(&value).expect("measurement projection");
                19
            }
            Action::Path(path) => {
                self.words[0] = u32::from(path == PathKind::Direct);
                12
            }
            Action::GeometryState(status) => {
                self.words[0] = match status {
                    GeometryStatus::Vacant => 0,
                    GeometryStatus::Owner => 1,
                    GeometryStatus::Observer => 2,
                };
                13
            }
            Action::GraphicsClock {
                monotonic_us,
                rtt_ms,
            } => {
                self.words[..4].copy_from_slice(&[
                    monotonic_us as u32,
                    (monotonic_us >> 32) as u32,
                    rtt_ms as u32,
                    (rtt_ms >> 32) as u32,
                ]);
                14
            }
            Action::GraphicsAsset {
                epoch,
                key,
                asset,
                job,
                bytes,
            } => {
                // Job ids start at one: zero is an asset whose job is not recorded.
                let job = job.unwrap_or(0);
                self.words[..4].copy_from_slice(&[
                    epoch,
                    u32::from(asset == GraphicsAsset::Animation),
                    job as u32,
                    (job >> 32) as u32,
                ]);
                *self.metadata = key;
                self.bytes.extend_from_slice(&bytes);
                15
            }
            Action::GraphicsJob {
                phase,
                job,
                bytes,
                failed,
            } => {
                // The order of `SESSION_GRAPHICS_PHASES` in the browser's
                // `browser-client-session.ts`.
                let phase = match phase {
                    GraphicsPhase::Demanded => 0,
                    GraphicsPhase::Requested => 1,
                    GraphicsPhase::FirstByte => 2,
                    GraphicsPhase::Fin => 3,
                    GraphicsPhase::Published => 4,
                    GraphicsPhase::Retired => 5,
                    GraphicsPhase::Refused => 6,
                    GraphicsPhase::Unavailable => 7,
                    GraphicsPhase::Cancelled => 8,
                    GraphicsPhase::Interrupted => 9,
                    GraphicsPhase::Resumed => 10,
                };
                self.words[..5].copy_from_slice(&[
                    phase,
                    job as u32,
                    (job >> 32) as u32,
                    bytes,
                    u32::from(failed),
                ]);
                20
            }
            Action::OpenUrl { id, url } => {
                self.words[0] = id.epoch;
                self.words[1] = id.seq;
                *self.metadata = url;
                16
            }
            Action::TerminalUi(effect) => {
                *self.metadata = match effect {
                TerminalUi::Title(title) => serde_json::json!({"kind":"title", "title":title}),
                TerminalUi::Bell => serde_json::json!({"kind":"bell"}),
                TerminalUi::Notification { title, body } => serde_json::json!({"kind":"notification", "title":title, "body":body}),
                TerminalUi::Clipboard { selection, text } => serde_json::json!({"kind":"clipboard", "selection":String::from_utf8(vec![selection]).expect("selection"), "text":text.as_str()}),
            }.to_string();
                17
            }
        }
    }
    pub fn action_words_ptr(&self) -> *const u32 {
        self.words.as_ptr()
    }
    pub fn action_bytes_ptr(&self) -> *const u8 {
        self.bytes.as_ptr()
    }
    pub fn action_bytes_len(&self) -> usize {
        self.bytes.len()
    }
    pub fn action_metadata(&self) -> String {
        self.metadata.as_str().to_owned()
    }
}

impl ClientSession {
    fn deliver(&mut self, now: f64, event: Event<'_>) {
        if let Some(now) = time(now) {
            self.session.handle(now, event, &mut BrowserEntropy);
        }
    }
    fn conn(&mut self, conn: ConnId) {
        self.words[0] = conn.0 as u32;
        self.words[1] = (conn.0 >> 32) as u32;
    }
    /// Show the host a frame without copying it: the frame's own buffer becomes
    /// the action bytes, and the buffer it replaces, wiped by this poll, goes
    /// back to the session for the next frame it opens or seals.
    fn present(&mut self, payload: Vec<u8>) {
        let spent = std::mem::replace(&mut *self.bytes, payload);
        self.session.recycle(spent);
    }
}

fn time(now: f64) -> Option<u64> {
    (now.is_finite() && now >= 0.0 && now <= u64::MAX as f64).then_some(now as u64)
}

/// Seven `u32` words lead every viewer output.
const VIEWER_WORDS_BYTES: usize = 28;
const DEMAND_MORE: u32 = 1;
const DEMAND_CONTINUES: u32 = 2;

/// A graphics demand list on its way in. The viewer sends a long one in parts,
/// each naming its lineage and whether it continues a list and is followed by
/// more; the session is told only a whole list.
#[derive(Default)]
struct DemandList {
    epoch: u32,
    demands: Vec<GraphicsDemand>,
}

impl DemandList {
    /// Take one part in; the whole list once its last part has arrived. A part
    /// that starts a list replaces an unfinished one. A part that continues
    /// nothing, or that would pass what the session accepts, is refused and
    /// what was held goes with it.
    fn accept(
        &mut self,
        epoch: u32,
        flags: u32,
        part: Option<Vec<GraphicsDemand>>,
    ) -> Result<Option<Vec<GraphicsDemand>>, ()> {
        let continues = flags & DEMAND_CONTINUES != 0;
        let held = std::mem::take(&mut self.demands);
        let Some(mut part) = part.filter(|_| flags <= DEMAND_MORE | DEMAND_CONTINUES) else {
            return Err(());
        };
        if continues && (held.is_empty() || epoch != self.epoch) {
            return Err(());
        }
        let mut demands = if continues { held } else { Vec::new() };
        if demands.len() + part.len() > MAX_DEMANDS {
            return Err(());
        }
        demands.append(&mut part);
        if flags & DEMAND_MORE == 0 {
            return Ok(Some(demands));
        }
        self.epoch = epoch;
        self.demands = demands;
        Ok(None)
    }
}

fn decode_demands(count: u32, mut bytes: &[u8]) -> Option<Vec<GraphicsDemand>> {
    // Bound by the actual fixed record footprint before allocating.
    if count as usize > bytes.len() / 92 {
        return None;
    }
    let mut demands = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let header = bytes.get(..92)?;
        if header[0] > 1 || header[2..4] != [0, 0] {
            return None;
        }
        let word =
            |offset| u32::from_be_bytes(header[offset..offset + 4].try_into().expect("four bytes"));
        let length = word(88) as usize;
        let key = std::str::from_utf8(bytes.get(92..92 + length)?)
            .ok()?
            .to_owned();
        demands.push(GraphicsDemand {
            asset: if header[0] == 0 {
                GraphicsAsset::Tile
            } else {
                GraphicsAsset::Animation
            },
            level: header[1],
            frame: word(4),
            x: word(8),
            y: word(12),
            width: word(16),
            height: word(20),
            authority: header[24..56].try_into().ok()?,
            source: header[56..88].try_into().ok()?,
            key,
        });
        bytes = bytes.get(92 + length..)?;
    }
    bytes.is_empty().then_some(demands)
}

impl ClientSession {
    /// Signs every proof the session raised with the software delegate key,
    /// in the same turn: the core verifies each before flight 1 or a renewal
    /// leaves.
    fn answer_signatures(&mut self, now: u64) {
        while let Some(request) = self.session.take_signature_request() {
            let mut entropy = BrowserEntropy;
            let signature = merkur_authorization::sign_session_delegation_proof(
                &request.proof,
                &self.delegate_key,
                entropy.array(),
            )
            .ok();
            self.session
                .signed(now, request.id, signature.as_ref(), &mut entropy);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn demand_parser_requires_the_complete_canonical_record() {
        assert_eq!(decode_demands(0, &[]), Some(Vec::new()));
        assert_eq!(decode_demands(1, &[]), None);
        let mut bytes = vec![0; 93];
        bytes[91] = 1;
        bytes[92] = b'x';
        let demands = decode_demands(1, &bytes).unwrap();
        assert_eq!(demands[0].key, "x");
        bytes[2] = 1;
        assert_eq!(decode_demands(1, &bytes), None);
    }
    fn tile(key: &str) -> GraphicsDemand {
        GraphicsDemand {
            asset: GraphicsAsset::Tile,
            authority: [1; 32],
            frame: 0,
            key: key.into(),
            source: [1; 32],
            level: 0,
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        }
    }
    #[test]
    fn a_demand_list_reaches_the_session_whole_or_not_at_all() {
        let mut list = DemandList::default();
        // One part is a list.
        assert_eq!(
            list.accept(7, 0, Some(vec![tile("a")])),
            Ok(Some(vec![tile("a")]))
        );
        // Parts are held until the last, in order.
        assert_eq!(list.accept(7, DEMAND_MORE, Some(vec![tile("a")])), Ok(None));
        assert_eq!(
            list.accept(7, DEMAND_MORE | DEMAND_CONTINUES, Some(vec![tile("b")])),
            Ok(None)
        );
        assert_eq!(
            list.accept(7, DEMAND_CONTINUES, Some(vec![tile("c")])),
            Ok(Some(vec![tile("a"), tile("b"), tile("c")]))
        );
        // A part that continues nothing is refused: its first part never came.
        assert_eq!(
            list.accept(7, DEMAND_CONTINUES, Some(vec![tile("c")])),
            Err(())
        );
        // A new list replaces an unfinished one, and another lineage's part
        // cannot continue it.
        assert_eq!(list.accept(7, DEMAND_MORE, Some(vec![tile("a")])), Ok(None));
        assert_eq!(list.accept(7, DEMAND_MORE, Some(vec![tile("x")])), Ok(None));
        assert_eq!(
            list.accept(8, DEMAND_CONTINUES, Some(vec![tile("y")])),
            Err(())
        );
        assert_eq!(
            list.accept(7, DEMAND_CONTINUES, Some(vec![tile("y")])),
            Err(())
        );
        // Undecodable records and undefined flags end what was held.
        assert_eq!(list.accept(7, DEMAND_MORE, Some(vec![tile("a")])), Ok(None));
        assert_eq!(list.accept(7, DEMAND_CONTINUES, None), Err(()));
        assert_eq!(list.accept(7, 4, Some(vec![tile("a")])), Err(()));
        assert!(list.demands.is_empty());
    }
    #[test]
    fn a_demand_list_past_what_the_session_accepts_is_refused() {
        let mut list = DemandList::default();
        let part = || Some(vec![tile("a"); MAX_DEMANDS / 2 + 1]);
        assert_eq!(list.accept(7, DEMAND_MORE, part()), Ok(None));
        assert_eq!(list.accept(7, DEMAND_CONTINUES, part()), Err(()));
        assert!(list.demands.is_empty());
    }
    #[test]
    fn time_rejects_nonfinite_and_negative_values() {
        assert_eq!(time(f64::NAN), None);
        assert_eq!(time(f64::INFINITY), None);
        assert_eq!(time(-1.0), None);
        assert_eq!(time(12.5), Some(12));
    }
}
