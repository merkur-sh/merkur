//! The client core's pure state: Kani proves the input numberings' serial
//! arithmetic over the whole `u32` domain, and the random engine drives the
//! heartbeat ladder through long event sequences against a link whose every
//! answer is chosen by the input.
use merkur_client::input_sequence::{
    EpochDecision, InputMapping, advance_input_seq, classify_epoch, input_seq_advances,
};
use merkur_client::liveness::{
    Heartbeat, LivenessLink, PathKind, RTO_CEIL_MS, RTO_FLOOR_MS, RTO_INITIAL_MS, Verdict,
};
use merkur_wire::protocol::{MSG_TYPE_HEARTBEAT_PING, decode_proto_frame};

mod bounded {
    include!("bounded.rs");
}
use bounded::bounded;

/// A wire sequence becomes a local one only inside the proven interval, never
/// as the protocol's zero, and two wire sequences never share a local one.
#[test]
#[cfg_attr(kani, kani::proof)]
fn proof_input_mapping() {
    bolero::check!()
        .with_type::<(u32, u32, u32, u32, u32)>()
        .for_each(|&(local_minus_wire, wire_min, wire_max, wire, other)| {
            let mapping = InputMapping {
                epoch: 1,
                local_minus_wire,
                wire_min,
                wire_max,
            };
            let Some(local) = mapping.local_for_wire(wire) else {
                return;
            };
            #[cfg(kani)]
            kani::cover!(local < wire, "a mapping that wraps");
            assert!(wire_min != 0 && (wire_min..=wire_max).contains(&wire));
            assert_ne!(local, 0);
            assert_eq!(mapping.normalize_display(wire), local);
            if other != wire {
                assert_ne!(mapping.local_for_wire(other), Some(local));
            }
        });
}

/// One serial order: a high-water never moves back, two sequences never both
/// advance on each other, and an epoch advances exactly when a sequence would.
#[test]
#[cfg_attr(kani, kani::proof)]
fn proof_input_serial_order() {
    bolero::check!()
        .with_type::<(u32, u32)>()
        .for_each(|&(current, candidate)| {
            let next = advance_input_seq(current, candidate);
            assert!(next == current || next == candidate);
            assert!(!input_seq_advances(next, current));
            assert!(
                !(input_seq_advances(current, candidate) && input_seq_advances(candidate, current))
            );
            assert_eq!(
                classify_epoch(current, candidate) == EpochDecision::Advance,
                input_seq_advances(current, candidate)
            );
            #[cfg(kani)]
            kani::cover!(
                current != 0 && candidate < current && next == candidate,
                "a high-water advances across the wrap"
            );
        });
}

const INTERVAL_MS: u64 = 1_000;
/// Far beyond any session, and far below the token's `now_ms * 1_000` limit.
const MAX_NOW_MS: u64 = 1 << 40;

struct Link {
    open: bool,
    accepts: bool,
    progress: u32,
    emit_top: u32,
    /// Tokens of the pings this link carried, oldest first.
    carried: Vec<u64>,
}

impl LivenessLink for Link {
    fn control_open(&self) -> bool {
        self.open
    }

    fn send_ping(&mut self, frame: &[u8]) -> bool {
        let (kind, body) = decode_proto_frame(frame).expect("a whole frame");
        assert_eq!(kind, MSG_TYPE_HEARTBEAT_PING);
        let token = u64::from_be_bytes(body.try_into().expect("an 8-byte token"));
        if !self.accepts {
            return false;
        }
        // Tokens name round trips: one reused would credit an old ping's pong.
        assert!(self.carried.last().is_none_or(|last| token > *last));
        self.carried.push(token);
        true
    }

    fn progress_seq(&self) -> u32 {
        self.progress
    }

    fn emit_top_seq(&self) -> u32 {
        self.emit_top
    }
}

/// What the verdicts since the last reset may still say.
#[derive(Default)]
struct Ladder {
    escalated: bool,
    failed: bool,
    /// Pings the link carried since the escalation.
    carried_since_escalation: usize,
}

/// Random engine only: Kani reached no verdict at six events, nor at three,
/// with round-trip samples or without them.
#[test]
fn proof_heartbeat_ladder() {
    let ladder = |bytes: &[u8]| {
        let mut heartbeat = Heartbeat::new(INTERVAL_MS);
        let mut link = Link {
            open: true,
            accepts: true,
            progress: 0,
            emit_top: 0,
            carried: Vec::new(),
        };
        let mut now = 0u64;
        let mut ladder = Ladder::default();
        for event in bytes.chunks_exact(3) {
            let arg = u16::from_be_bytes([event[1], event[2]]);
            now = (now + u64::from(arg)).min(MAX_NOW_MS);
            let carried_before = link.carried.len();
            let mut reset = false;
            match event[0] % 13 {
                0 => {
                    heartbeat.start(now, &mut link);
                    reset = true;
                }
                1 => {
                    heartbeat.stop();
                    reset = true;
                }
                2 => {
                    heartbeat.clear_tracking();
                    reset = true;
                }
                3 => {
                    heartbeat.send_immediate_ping(now, &mut link);
                    reset = true;
                }
                4 => heartbeat.arm_on_emit(now, &mut link),
                5 => heartbeat.probe_without_resetting(now, &mut link),
                6 => heartbeat.record_pong_proof(),
                7 => heartbeat.record_input_ack_proof(u32::from(arg)),
                8 => {
                    if let Some(&token) = link.carried.get(usize::from(arg) % 4) {
                        let path = if arg & 0x100 == 0 {
                            PathKind::Relay
                        } else {
                            PathKind::Direct
                        };
                        heartbeat.resolve_pong_rtt(token, path, now);
                    }
                }
                9 => link.open = arg & 1 == 0,
                10 => link.accepts = arg & 1 == 0,
                11 => {
                    link.progress = link.progress.wrapping_add(1);
                    link.emit_top = link.emit_top.max(link.progress);
                }
                _ => {
                    // The timer fires at or after the deadline it was set for.
                    if let Some(deadline) = heartbeat.next_deadline() {
                        now = now.max(deadline);
                    }
                    heartbeat.handle_timeout(now, &mut link);
                    // A deadline left at or before `now` would spin the timer.
                    assert!(heartbeat.next_deadline().is_none_or(|next| next > now));
                }
            }
            if ladder.escalated {
                ladder.carried_since_escalation += link.carried.len() - carried_before;
            }
            if reset {
                ladder = Ladder::default();
            }
            while let Some(verdict) = heartbeat.poll_verdict() {
                match verdict {
                    Verdict::Escalated => {
                        assert!(!ladder.escalated, "one escalation per ladder");
                        ladder.escalated = true;
                        // The lapse's probe leaves in the step that escalates.
                        ladder.carried_since_escalation = link.carried.len() - carried_before;
                    }
                    Verdict::Failed => {
                        assert!(ladder.escalated, "a failure follows its escalation");
                        assert!(!ladder.failed, "one failure per ladder");
                        // A probe the link refused is never an unanswered round trip.
                        assert!(ladder.carried_since_escalation > 0);
                        ladder.failed = true;
                    }
                    Verdict::Progress => ladder = Ladder::default(),
                }
            }
            let rto = heartbeat.rto_ms();
            if heartbeat.srtt_ms().is_none() {
                assert_eq!(rto, RTO_INITIAL_MS);
            } else {
                assert!((RTO_FLOOR_MS..=RTO_CEIL_MS).contains(&rto));
            }
        }
    };
    bounded::<1_200>(ladder);
}
