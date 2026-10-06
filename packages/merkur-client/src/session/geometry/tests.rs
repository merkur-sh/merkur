//! The geometry authority against `outbound-channels.test.ts`.

use merkur_wire::protocol::{MSG_TYPE_GEOMETRY_CLAIM, MSG_TYPE_RESIZE, decode_proto_frame};

use super::*;

const CELL: (u32, u32) = (8 << 16, 16 << 16);

fn viewport(cols: u16, rows: u16) -> Viewport {
    Viewport {
        cols,
        rows,
        cell_width: CELL.0,
        cell_height: CELL.1,
    }
}

fn state(status: u8, generation: u64, accepted: u32) -> [u8; 13] {
    let mut body = [0; 13];
    body[0] = status;
    body[1..9].copy_from_slice(&generation.to_be_bytes());
    body[9..].copy_from_slice(&accepted.to_be_bytes());
    body
}

#[derive(Debug, PartialEq)]
enum Sent {
    Claim {
        action: u8,
        generation: u64,
        viewport: Option<(u16, u16, u32)>,
    },
    Resize {
        cols: u16,
        rows: u16,
        generation: u64,
    },
}

fn sent(geometry: &mut Geometry) -> Vec<Sent> {
    geometry
        .take_out()
        .iter()
        .map(|frame| {
            let (kind, body) = decode_proto_frame(frame).expect("a frame");
            let u16_at = |at: usize| u16::from_be_bytes([body[at], body[at + 1]]);
            let u32_at = |at: usize| u32::from_be_bytes(body[at..at + 4].try_into().unwrap());
            let u64_at = |at: usize| u64::from_be_bytes(body[at..at + 8].try_into().unwrap());
            match kind {
                MSG_TYPE_GEOMETRY_CLAIM => Sent::Claim {
                    action: body[0],
                    generation: u64_at(1),
                    viewport: body[9..]
                        .iter()
                        .any(|byte| *byte != 0)
                        .then(|| (u16_at(9), u16_at(11), u32_at(13))),
                },
                MSG_TYPE_RESIZE => Sent::Resize {
                    cols: u16_at(0),
                    rows: u16_at(2),
                    generation: u64_at(16),
                },
                other => panic!("unexpected frame {other}"),
            }
        })
        .collect()
}

/// A ready session that owns generation 1, as the browser's harness starts.
fn owner() -> Geometry {
    let mut geometry = Geometry::default();
    geometry.accept_state(&state(1, 1, 0), true);
    geometry
}

#[test]
fn the_focused_client_claims_the_geometry_for_its_own_viewport() {
    let mut geometry = owner();
    geometry.accept_state(&state(2, 5, 0), true);
    geometry.set_focused(true, true);
    assert!(sent(&mut geometry).is_empty(), "nothing to claim for yet");
    geometry.set_viewport(viewport(100, 30), true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Claim {
            action: 2,
            generation: 5,
            viewport: Some((100, 30, 1))
        }]
    );
    // A repeated edge for a viewport that has not moved is inert.
    geometry.set_viewport(viewport(100, 30), true);
    assert!(sent(&mut geometry).is_empty());
    // Granted, and the claim carried the resize: none follows it.
    geometry.accept_state(&state(1, 6, 1), true);
    assert!(sent(&mut geometry).is_empty());
    geometry.set_viewport(viewport(100, 24), true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Resize {
            cols: 100,
            rows: 24,
            generation: 6
        }]
    );
    // Another client took it; the next edge claims it back at that generation.
    geometry.accept_state(&state(2, 7, 0), true);
    geometry.set_viewport(viewport(100, 30), true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Claim {
            action: 2,
            generation: 7,
            viewport: Some((100, 30, 3))
        }]
    );
}

#[test]
fn an_unfocused_client_claims_nothing_until_it_is_focused() {
    let mut geometry = owner();
    geometry.accept_state(&state(2, 5, 0), true);
    geometry.set_viewport(viewport(100, 30), true);
    assert!(sent(&mut geometry).is_empty());
    geometry.set_focused(true, true);
    assert_eq!(sent(&mut geometry).len(), 1);
    // Refused, then focused again: the fresh generation is claimed with.
    geometry.accept_state(&state(2, 9, 0), true);
    geometry.set_focused(false, true);
    geometry.set_focused(true, true);
    let [Sent::Claim { generation: 9, .. }] = &sent(&mut geometry)[..] else {
        panic!("a claim at generation 9");
    };
}

#[test]
fn a_focused_client_takes_the_geometry_another_holds_at_authentication() {
    let mut geometry = Geometry::default();
    // Focus and layout arrive before any carrier: nothing can be claimed.
    geometry.set_focused(true, false);
    geometry.set_viewport(viewport(100, 30), false);
    geometry.begin_epoch(false);
    assert!(sent(&mut geometry).is_empty());
    geometry.refresh(true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Claim {
            action: 1,
            generation: 0,
            viewport: Some((100, 30, 1))
        }]
    );
    // Another client kept it: taken at the generation the answer names.
    geometry.accept_state(&state(2, 3, 0), true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Claim {
            action: 2,
            generation: 3,
            viewport: Some((100, 30, 2))
        }]
    );
    geometry.accept_state(&state(1, 4, 2), true);
    assert!(sent(&mut geometry).is_empty());

    // A vacant geometry is granted to the acquire: nothing is taken.
    geometry.begin_epoch(true);
    assert_eq!(sent(&mut geometry).len(), 1);
    geometry.accept_state(&state(1, 1, 3), true);
    assert!(sent(&mut geometry).is_empty());
}

#[test]
fn a_claim_before_the_first_state_waits_for_its_generation() {
    let mut geometry = Geometry::default();
    geometry.set_focused(true, true);
    geometry.set_viewport(viewport(100, 30), true);
    assert!(
        sent(&mut geometry).is_empty(),
        "no generation to authorize it"
    );
    geometry.accept_state(&state(2, 4, 0), true);
    let [
        Sent::Claim {
            action: 2,
            generation: 4,
            ..
        },
    ] = &sent(&mut geometry)[..]
    else {
        panic!("the waiting claim");
    };
}

#[test]
fn authentication_and_takeover_carry_the_first_resize_without_a_round_trip() {
    let mut geometry = owner();
    geometry.reset();
    geometry.set_viewport(viewport(100, 30), true);
    assert!(sent(&mut geometry).is_empty());
    // Authenticated before any carrier: the acquire waits for one.
    geometry.begin_epoch(false);
    assert!(sent(&mut geometry).is_empty());
    geometry.refresh(true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Claim {
            action: 1,
            generation: 0,
            viewport: Some((100, 30, 1))
        }]
    );
    geometry.accept_state(&state(2, 7, 0), true);
    geometry.set_viewport(viewport(120, 40), true);
    assert!(sent(&mut geometry).is_empty());
    geometry.take_control(true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Claim {
            action: 2,
            generation: 7,
            viewport: Some((120, 40, 2))
        }]
    );
    geometry.accept_state(&state(1, 8, 2), true);
    assert!(
        sent(&mut geometry).is_empty(),
        "the accepted intent is not sent twice"
    );
    geometry.accept_state(&state(2, 9, 0), true);
    // Older than what is known: ignored.
    assert_eq!(geometry.accept_state(&state(1, 8, 2), true), None);
    geometry.set_viewport(viewport(90, 20), true);
    assert!(sent(&mut geometry).is_empty());
    geometry.refresh(true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Claim {
            action: 0,
            generation: 9,
            viewport: None
        }]
    );
    geometry.accept_state(&state(1, 10, 0), true);
    assert_eq!(
        sent(&mut geometry),
        [Sent::Resize {
            cols: 90,
            rows: 20,
            generation: 10
        }]
    );
}
