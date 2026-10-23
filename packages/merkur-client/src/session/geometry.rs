//! The shared terminal's geometry: the port of `outbound-channels.ts`'s
//! geometry authority.
//!
//! One attachment at a time owns the PTY's size. The focused client claims it
//! for its own viewport, so the shell fits the screen someone is typing into;
//! an unfocused one claims nothing. Every claim carries the viewport, so the
//! grant and the first resize commit in one owner turn on the daemon. The
//! daemon's state message names the owner and a generation, which authorizes
//! the next claim and every resize. Before an epoch's first state a focused
//! client takes at generation zero, which the daemon reads as a take as of
//! authentication, so the first command typed meets the client's viewport.
//! Each authentication opens a new epoch.
//!
//! Every frame that carries a viewport is an intent the session also hands
//! the input outbox (`take_intent`): input typed after it waits on the daemon
//! until it is applied.

use merkur_wire::protocol::{MSG_TYPE_GEOMETRY_CLAIM, MSG_TYPE_RESIZE, encode_proto_frame};

/// A viewport: cells, and one cell in unsigned 16.16 logical pixels, both
/// zero for a host that knows no cell pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Viewport {
    pub cols: u16,
    pub rows: u16,
    pub cell_width: u32,
    pub cell_height: u32,
}

impl Viewport {
    /// `[cols][rows][seq][cell width][cell height]`.
    fn encode(&self, seq: u32) -> [u8; 16] {
        let mut bytes = [0; 16];
        bytes[..2].copy_from_slice(&self.cols.to_be_bytes());
        bytes[2..4].copy_from_slice(&self.rows.to_be_bytes());
        bytes[4..8].copy_from_slice(&seq.to_be_bytes());
        bytes[8..12].copy_from_slice(&self.cell_width.to_be_bytes());
        bytes[12..16].copy_from_slice(&self.cell_height.to_be_bytes());
        bytes
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeometryStatus {
    Vacant,
    Owner,
    Observer,
}

/// What a claim asks for: to observe, to take a vacant geometry, or to take
/// it over.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Claim {
    Observe = 0,
    Acquire = 1,
    Take = 2,
}

/// The newest frame that carries a viewport, for the input outbox.
pub(super) struct Intent {
    pub(super) frame: Vec<u8>,
    /// Made before the epoch's first state: it precedes every held input,
    /// which the daemon this epoch authenticated to has not admitted.
    pub(super) epoch: bool,
}

#[derive(Default)]
pub(super) struct Geometry {
    desired: Option<Viewport>,
    last_sent: Option<Viewport>,
    /// Intent order across carriers and reconnects of this client.
    resize_seq: u32,
    generation: u64,
    known: bool,
    controls: bool,
    focused: bool,
    /// The viewport a claim was made for: a repeated edge for it is inert.
    claim_attempt: Option<Viewport>,
    /// The viewport a compound claim carried, and its serial.
    claimed: Option<(Viewport, u32)>,
    out: Vec<Vec<u8>>,
    intent: Option<Intent>,
}

impl Geometry {
    pub(super) fn take_out(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.out)
    }

    pub(super) fn take_intent(&mut self) -> Option<Intent> {
        self.intent.take()
    }

    fn next_seq(&mut self) -> u32 {
        self.resize_seq = self.resize_seq.wrapping_add(1).max(1);
        self.resize_seq
    }

    /// The host's viewport, sent at once when this client owns the geometry.
    pub(super) fn set_viewport(&mut self, viewport: Viewport, ready: bool) {
        self.desired = Some(viewport);
        self.flush_resize(ready);
        self.claim_focused(ready);
    }

    pub(super) fn set_focused(&mut self, focused: bool, ready: bool) {
        if focused == self.focused {
            return;
        }
        self.focused = focused;
        if focused {
            self.claim_focused(ready);
        }
    }

    /// The user asked for the geometry.
    pub(super) fn take_control(&mut self, ready: bool) {
        if !ready {
            return;
        }
        if self.controls {
            return self.flush_resize(ready);
        }
        self.claim(Claim::Take);
    }

    /// A new authenticated session: once it carries frames, acquire the
    /// geometry if vacant, with the viewport, and learn its state either way.
    pub(super) fn begin_epoch(&mut self, ready: bool) {
        self.known = false;
        self.controls = false;
        self.generation = 0;
        self.last_sent = None;
        self.claim_attempt = None;
        self.refresh(ready);
    }

    /// A carrier came or went: ask for the state again. Before the epoch's
    /// first state, that is its claim: a focused client with a viewport takes
    /// the geometry as of authentication, as the browser's main thread replays
    /// its viewport at every authentication, and any other acquires it if
    /// vacant.
    pub(super) fn refresh(&mut self, ready: bool) {
        if !ready {
            return;
        }
        if self.known {
            return self.claim(Claim::Observe);
        }
        if self.focused && self.desired.is_some() {
            self.claim_attempt = self.desired;
            return self.claim(Claim::Take);
        }
        self.claim(Claim::Acquire);
    }

    /// The daemon's `[status][generation][accepted resize seq]`.
    pub(super) fn accept_state(&mut self, body: &[u8], ready: bool) -> Option<GeometryStatus> {
        let body: &[u8; 13] = body.try_into().ok()?;
        let status = match body[0] {
            0 => GeometryStatus::Vacant,
            1 => GeometryStatus::Owner,
            2 => GeometryStatus::Observer,
            _ => return None,
        };
        let generation = u64::from_be_bytes(body[1..9].try_into().expect("eight bytes"));
        let accepted = u32::from_be_bytes(body[9..13].try_into().expect("four bytes"));
        if self.known && generation < self.generation {
            return None;
        }
        if status == GeometryStatus::Owner && generation == 0 {
            return None;
        }
        let owner = status == GeometryStatus::Owner;
        let changed = !self.known || generation != self.generation || self.controls != owner;
        self.known = true;
        self.generation = generation;
        self.controls = owner;
        // Not the owner: what this client last claimed for no longer holds.
        if !owner {
            self.claim_attempt = None;
        }
        if changed {
            self.last_sent = None;
        }
        // The compound claim's resize was the one accepted: not sent again.
        if owner && let Some((viewport, _)) = self.claimed.filter(|(_, seq)| *seq == accepted) {
            self.last_sent = Some(viewport);
            self.claimed = None;
        }
        self.flush_resize(ready);
        Some(status)
    }

    fn claim_focused(&mut self, ready: bool) {
        if !ready || self.controls || !self.focused {
            return;
        }
        let Some(desired) = self.desired else {
            return;
        };
        if self.claim_attempt == Some(desired) {
            return;
        }
        self.claim_attempt = Some(desired);
        self.claim(Claim::Take);
    }

    /// `[action][generation][viewport or zeros]`. The generation authorizes a
    /// transfer; before the epoch's first state it is zero, a take as of
    /// authentication.
    fn claim(&mut self, action: Claim) {
        let viewport = if action == Claim::Observe {
            None
        } else {
            self.desired
        };
        let generation = if self.known { self.generation } else { 0 };
        let mut body = [0u8; 25];
        body[0] = action as u8;
        body[1..9].copy_from_slice(&generation.to_be_bytes());
        if let Some(viewport) = viewport {
            let seq = self.next_seq();
            body[9..].copy_from_slice(&viewport.encode(seq));
            self.claimed = Some((viewport, seq));
        }
        let frame = encode_proto_frame(MSG_TYPE_GEOMETRY_CLAIM, &body);
        if viewport.is_some() {
            self.intent = Some(Intent {
                frame: frame.clone(),
                epoch: !self.known,
            });
        }
        self.out.push(frame);
    }

    fn flush_resize(&mut self, ready: bool) {
        if !ready || !self.controls {
            return;
        }
        let Some(desired) = self.desired else {
            return;
        };
        if self.last_sent == Some(desired) {
            return;
        }
        self.last_sent = Some(desired);
        let seq = self.next_seq();
        let mut body = [0u8; 24];
        body[..16].copy_from_slice(&desired.encode(seq));
        body[16..].copy_from_slice(&self.generation.to_be_bytes());
        let frame = encode_proto_frame(MSG_TYPE_RESIZE, &body);
        self.intent = Some(Intent {
            frame: frame.clone(),
            epoch: false,
        });
        self.out.push(frame);
    }

    /// A new session: its daemon may be another process at its default size,
    /// which must receive the viewport even when it equals the last one sent.
    pub(super) fn reset(&mut self) {
        self.controls = false;
        self.known = false;
        self.claimed = None;
        self.claim_attempt = None;
        self.last_sent = None;
        self.intent = None;
    }
}

#[cfg(test)]
mod tests;
