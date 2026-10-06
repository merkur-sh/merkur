//! Input-capture arithmetic over the terminal owner's published model bounds.
//!
//! The capture thread freezes shadow provenance synchronously. Its projection
//! owns no terminal, text, timer or allocator; the terminal owner executes and
//! may revoke that decision, while transport never waits for an admission slot.

// A latency path: input waits on the event itself, never on a clock. `clippy.toml` lists the
// timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

pub const BASE_READY: u32 = 1;
pub const SEEDABLE: u32 = 2;

#[derive(Clone, Copy, Debug)]
pub enum Op {
    Printable,
    Backspace,
    Delete,
    Left,
    Right,
}
impl Op {
    pub fn from_byte(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Printable),
            1 => Some(Self::Backspace),
            2 => Some(Self::Delete),
            3 => Some(Self::Left),
            4 => Some(Self::Right),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Snapshot {
    pub armed: bool,
    pub flags: u32,
    pub start: u32,
    pub cursor: u32,
    pub end: u32,
    pub remaining: u32,
    pub cols: u32,
    pub through: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Model {
    seeded: bool,
    start: u32,
    cursor: u32,
    end: u32,
    remaining: u32,
    cols: u32,
}
impl Model {
    fn adopt(&mut self, snapshot: Snapshot) {
        if !snapshot.armed || snapshot.flags & (BASE_READY | SEEDABLE) == 0 {
            self.seeded = false;
            return;
        }
        let valid = snapshot.cursor < snapshot.cols
            && (snapshot.flags & BASE_READY == 0
                || snapshot.start <= snapshot.cursor
                    && snapshot.cursor <= snapshot.end
                    && snapshot.end <= snapshot.cols);
        if !valid {
            self.seeded = false;
            return;
        }
        self.seeded = true;
        self.cols = snapshot.cols;
        self.remaining = snapshot.remaining;
        self.cursor = snapshot.cursor;
        if snapshot.flags & BASE_READY != 0 {
            self.start = snapshot.start;
            self.end = snapshot.end;
        } else {
            // The prompt anchor may seed further left. The cursor is the only
            // safe conservative floor until the owner publishes a real line.
            self.start = snapshot.cursor;
            self.end = snapshot.cursor;
        }
    }
    fn admit(&self, op: Op) -> bool {
        if !self.seeded || self.remaining == 0 {
            return false;
        }
        match op {
            Op::Printable => self.end.checked_add(1).is_some_and(|end| end < self.cols),
            Op::Backspace | Op::Left => self.cursor > self.start,
            Op::Delete | Op::Right => self.cursor < self.end,
        }
    }
    fn advance(&mut self, op: Op) {
        self.remaining -= 1;
        match op {
            Op::Printable => {
                self.cursor += 1;
                self.end += 1;
            }
            Op::Backspace => {
                self.cursor -= 1;
                self.end -= 1;
            }
            Op::Delete => self.end -= 1,
            Op::Left => self.cursor -= 1,
            Op::Right => self.cursor += 1,
        }
    }
}

/// One capture owner's projection and exact published-version/input frontier.
#[derive(Default)]
pub struct Mirror {
    model: Model,
    version: u32,
    latest_input: u32,
}
impl Mirror {
    /// Freeze and advance in one allocation-free boundary call. If the input
    /// writer refuses the record, the caller must invalidate this projection.
    pub fn prepare(&mut self, op: Op, input: u32, version: u32, snapshot: Snapshot) -> bool {
        if version == 0 {
            self.invalidate();
            return false;
        }
        if version != self.version && snapshot.through >= self.latest_input {
            self.version = version;
            self.model.adopt(snapshot);
        } else if !snapshot.armed {
            // Disarming always wins, even when the owner is behind capture.
            self.invalidate();
            return false;
        }
        self.latest_input = self.latest_input.max(input);
        if self.model.admit(op) {
            self.model.advance(op);
            true
        } else {
            // The owner might execute an op capture conservatively refused.
            // Its next caught-up publication is the only safe new projection.
            self.invalidate();
            false
        }
    }
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn invalidate(&mut self) {
        self.model.seeded = false;
    }
    pub fn flush(&mut self, input: u32) {
        self.invalidate();
        self.latest_input = self.latest_input.max(input);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn seed(through: u32) -> Snapshot {
        Snapshot {
            armed: true,
            flags: SEEDABLE,
            cursor: 2,
            remaining: 256,
            cols: 8,
            through,
            ..Snapshot::default()
        }
    }
    #[test]
    fn input_bursts_advance_locally_until_the_exact_column_bound() {
        let mut mirror = Mirror::default();
        for input in 1..=5 {
            assert!(mirror.prepare(Op::Printable, input, 1, seed(0)));
        }
        assert!(!mirror.prepare(Op::Printable, 6, 1, seed(0)));
        assert_eq!(
            (
                mirror.model.cursor,
                mirror.model.end,
                mirror.model.remaining
            ),
            (7, 7, 251)
        );
        assert!(!mirror.model.seeded);
    }
    #[test]
    fn a_seed_has_no_editable_cell_until_capture_prints_one() {
        for op in [Op::Backspace, Op::Delete, Op::Left, Op::Right] {
            let mut mirror = Mirror::default();
            assert!(!mirror.prepare(op, 1, 1, seed(0)));
        }
        let mut mirror = Mirror::default();
        assert!(mirror.prepare(Op::Printable, 1, 1, seed(0)));
        assert!(mirror.prepare(Op::Left, 2, 1, seed(0)));
        assert!(mirror.prepare(Op::Delete, 3, 1, seed(0)));
        assert_eq!((mirror.model.cursor, mirror.model.end), (2, 2));
    }
    #[test]
    fn publications_cannot_double_count_inputs_the_owner_has_not_drained() {
        let mut mirror = Mirror::default();
        assert!(mirror.prepare(Op::Printable, 1, 1, seed(0)));
        assert!(mirror.prepare(Op::Printable, 2, 1, seed(0)));
        assert!(mirror.prepare(Op::Printable, 3, 2, seed(1)));
        assert_eq!(mirror.model.end, 5);
        assert_eq!(mirror.version, 1);
        assert!(mirror.prepare(Op::Printable, 4, 3, seed(3)));
        assert_eq!(mirror.model.end, 3);
        assert_eq!(mirror.version, 3);
    }
    #[test]
    fn disarming_and_failed_writes_need_a_caught_up_publication_to_rearm() {
        let mut mirror = Mirror::default();
        assert!(mirror.prepare(Op::Printable, 1, 1, seed(0)));
        mirror.invalidate();
        assert!(!mirror.prepare(Op::Printable, 2, 1, seed(0)));
        assert!(!mirror.prepare(Op::Printable, 3, 2, seed(1)));
        assert!(mirror.prepare(Op::Printable, 4, 3, seed(3)));
        let mut disarmed = seed(0);
        disarmed.armed = false;
        assert!(!mirror.prepare(Op::Printable, 5, 4, disarmed));
        assert!(!mirror.model.seeded);
        mirror.flush(9);
        assert!(!mirror.prepare(Op::Printable, 10, 5, seed(8)));
        assert!(mirror.prepare(Op::Printable, 11, 6, seed(10)));
    }
    #[test]
    fn op_budget_and_empty_publications_fail_closed() {
        let mut mirror = Mirror::default();
        let mut snapshot = seed(0);
        snapshot.remaining = 0;
        assert!(!mirror.prepare(Op::Printable, 1, 1, snapshot));
        assert!(!mirror.prepare(Op::Printable, 2, 0, seed(1)));
        assert!(!mirror.model.seeded);
    }
    #[test]
    fn resetting_a_capture_owner_discards_the_old_input_namespace() {
        let mut mirror = Mirror::default();
        mirror.flush(u32::MAX);
        assert!(!mirror.prepare(Op::Printable, 1, 1, seed(0)));
        mirror.reset();
        assert!(mirror.prepare(Op::Printable, 1, 1, seed(0)));
        assert_eq!(mirror.latest_input, 1);
    }
    #[test]
    fn invalid_geometry_and_column_overflow_cannot_grant_provenance() {
        for snapshot in [
            Snapshot { cols: 0, ..seed(0) },
            Snapshot {
                cursor: 8,
                ..seed(0)
            },
            Snapshot {
                flags: BASE_READY,
                start: 3,
                ..seed(0)
            },
            Snapshot {
                flags: BASE_READY,
                end: 1,
                ..seed(0)
            },
            Snapshot {
                flags: BASE_READY,
                end: 9,
                ..seed(0)
            },
            Snapshot {
                flags: BASE_READY,
                start: 0,
                cursor: 0,
                end: u32::MAX,
                cols: u32::MAX,
                ..seed(0)
            },
        ] {
            let mut mirror = Mirror::default();
            assert!(!mirror.prepare(Op::Printable, 1, 1, snapshot));
        }
    }
}
