//! The outbox against `input-outbox.test.ts`, without the ring it reads there.

use super::Outbox;

fn outbox(records: &[(u32, u8)]) -> Outbox {
    let mut outbox = Outbox::new();
    for &(local, byte) in records {
        assert!(outbox.admit(local, vec![byte], false), "local {local}");
    }
    outbox
}

fn wires(outbox: &Outbox) -> Vec<u32> {
    (0..outbox.len()).map(|index| outbox.wire(index)).collect()
}

/// `[wire, first byte]` of every held entry, oldest first.
fn held(outbox: &Outbox) -> Vec<(u32, u8)> {
    outbox
        .records()
        .enumerate()
        .map(|(index, record)| (outbox.wire(index), record[0]))
        .collect()
}

fn provenance(outbox: &Outbox) -> Vec<bool> {
    outbox
        .run(0, outbox.len())
        .map(|(_, modelled)| modelled)
        .collect()
}

#[test]
fn an_ack_releases_the_acknowledged_prefix_and_never_moves_back() {
    let mut outbox = outbox(&[(1, 1), (2, 2), (3, 3)]);
    outbox.ack(1);
    assert_eq!(wires(&outbox), [2, 3]);
    outbox.ack(3);
    outbox.ack(2);
    assert!(outbox.is_empty());
    assert_eq!(outbox.acked(), 3);
}

#[test]
fn provenance_survives_a_rebase_and_a_new_lineage_revokes_it() {
    let mut outbox = Outbox::new();
    assert!(outbox.admit(10, vec![0x61], true));
    assert!(outbox.admit(11, vec![0x09], false));
    assert_eq!(provenance(&outbox), [true, false]);

    outbox.rebase(1);
    assert_eq!(wires(&outbox), [1, 2]);
    assert_eq!(provenance(&outbox), [true, false]);

    outbox.revoke_provenance();
    assert_eq!(provenance(&outbox), [false, false]);
}

#[test]
fn a_rebase_onto_the_first_unacknowledged_record_is_the_identity() {
    let mut outbox = outbox(&[(1, 1), (2, 2)]);
    outbox.ack(1);
    outbox.rebase(2);
    assert_eq!(wires(&outbox), [2]);
    assert!(outbox.admit(3, vec![3], false));
    assert_eq!(wires(&outbox), [2, 3]);
}

#[test]
fn a_fresh_peer_renumbers_the_held_records_and_everything_after_them() {
    let mut outbox = outbox(&[(1, 0x61), (2, 0x62), (3, 0x63)]);
    outbox.ack(1);
    outbox.rebase(1);
    assert_eq!(held(&outbox), [(1, 0x62), (2, 0x63)]);

    assert!(outbox.admit(4, vec![0x64], false));
    assert!(outbox.admit(5, vec![0x65], false));
    assert_eq!(wires(&outbox), [1, 2, 3, 4]);
    let mapping = outbox.mapping();
    assert_eq!(mapping.local_for_wire(1), Some(2));
    assert_eq!(mapping.local_for_wire(4), Some(5));
    assert_eq!(mapping.local_for_wire(5), None);
}

#[test]
fn a_renumbered_peer_translates_only_its_own_wire_interval() {
    let mut outbox = outbox(&[(99, 0x61), (100, 0x62)]);
    outbox.ack(99);
    let epoch = outbox.mapping().epoch;
    outbox.rebase(1);

    let mapping = outbox.mapping();
    assert_ne!(mapping.epoch, epoch);
    assert_eq!(mapping.local_for_wire(1), Some(100));
    assert_eq!(mapping.local_for_wire(2), None);
    assert!(outbox.admit(101, vec![0x63], false));
    assert_eq!(wires(&outbox), [1, 2]);
    let mapping = outbox.mapping();
    assert_eq!(mapping.local_for_wire(2), Some(101));
    // Wire 100 was the last peer's, though the offset alone could map it.
    assert_eq!(mapping.local_for_wire(100), None);
}

#[test]
fn a_resume_in_the_same_namespace_keeps_translating_applied_inputs() {
    let mut outbox = outbox(&[(1, 1), (2, 2)]);
    outbox.ack(2);
    outbox.rebase(3);

    let mapping = outbox.mapping();
    assert_eq!(mapping.local_for_wire(1), Some(1));
    assert_eq!(mapping.local_for_wire(2), Some(2));
    assert_eq!(mapping.local_for_wire(3), None);
    assert!(outbox.admit(3, vec![3], false));
    assert_eq!(wires(&outbox), [3]);
    assert_eq!(outbox.mapping().local_for_wire(3), Some(3));
}

#[test]
fn translation_takes_the_whole_unsigned_delta() {
    let mut outbox = Outbox::new();
    outbox.rebase(1);
    assert!(outbox.admit(0xffff_fffe, vec![1], false));
    assert_eq!(wires(&outbox), [1]);
    assert_eq!(outbox.mapping().local_minus_wire, 0xffff_fffd);
    assert_eq!(outbox.mapping().local_for_wire(1), Some(0xffff_fffe));
    assert!(outbox.admit(u32::MAX, vec![2], false));
    assert_eq!(wires(&outbox), [1, 2]);
    assert_eq!(outbox.mapping().local_for_wire(2), Some(u32::MAX));
}

#[test]
fn a_wire_sequence_past_u32_is_refused() {
    let mut outbox = Outbox::new();
    outbox.rebase(0xffff_fffe);
    assert!(outbox.admit(1, vec![1], false));
    assert!(outbox.admit(2, vec![2], false));
    assert!(!outbox.admit(3, vec![3], false));
}

#[test]
fn a_rebase_releases_what_the_daemon_applied_behind_a_lost_ack() {
    let mut outbox = outbox(&[(1, 0x61), (2, 0x62), (3, 0x63)]);
    // All three applied, their acknowledgement lost with the carrier:
    // renumbered, they would apply twice.
    outbox.rebase(4);
    assert!(outbox.is_empty());
    assert!(outbox.admit(4, vec![0x64], false));
    assert_eq!(wires(&outbox), [4]);

    let mut outbox = self::outbox(&[(1, 0x61), (2, 0x62), (3, 0x63)]);
    outbox.rebase(3);
    assert_eq!(held(&outbox), [(3, 0x63)]);
}

#[test]
fn an_ack_in_the_rebased_namespace_releases_everything() {
    let mut outbox = outbox(&[(1, 1), (2, 2)]);
    outbox.rebase(1);
    outbox.ack(2);
    assert!(outbox.is_empty());
}

#[test]
fn a_rebase_to_zero_is_ignored() {
    let mut outbox = outbox(&[(1, 1)]);
    outbox.rebase(0);
    assert_eq!(wires(&outbox), [1]);
}

#[test]
fn a_fresh_peer_with_nothing_held_anchors_the_next_record_on_its_expectation() {
    let mut outbox = outbox(&[(5000, 0x61)]);
    outbox.ack(5000);
    outbox.rebase(1);
    assert!(outbox.admit(5001, vec![0x62], false));
    assert!(outbox.admit(5002, vec![0x63], false));
    assert_eq!(wires(&outbox), [1, 2]);
    assert_eq!(outbox.mapping().local_for_wire(1), Some(5001));
}

#[test]
fn a_fresh_peer_keeps_every_later_record_contiguous_with_the_replayed_ones() {
    let mut outbox = Outbox::new();
    for (local, record) in [
        (1, vec![0x61]),
        (2, vec![0x62, 0x63]),
        (3, vec![0x64]),
        (4, vec![0x65, 0x66, 0x67]),
    ] {
        assert!(outbox.admit(local, record, false));
    }
    outbox.ack(1);
    outbox.rebase(1);
    assert_eq!(held(&outbox), [(1, 0x62), (2, 0x64), (3, 0x65)]);
    assert!(outbox.admit(5, vec![0x68], false));
    assert!(outbox.admit(6, vec![0x69], false));
    assert_eq!(wires(&outbox), [1, 2, 3, 4, 5]);
    assert_eq!(outbox.top(), 5);
}

#[test]
fn admission_bounds_release_capacity_only_on_ack_or_genesis() {
    use crate::input_delivery::{MAX_INPUT_BYTES, MAX_INPUT_ENTRIES};
    let mut outbox = Outbox::new();
    assert!(outbox.admit(1, vec![1; MAX_INPUT_BYTES], false));
    assert!(!outbox.admit(2, vec![2], false));
    assert_eq!(outbox.released_local(), 0);
    outbox.ack(1);
    assert_eq!(outbox.released_local(), 1);
    for sequence in 2..=(MAX_INPUT_ENTRIES as u32 + 1) {
        assert!(outbox.admit(sequence, vec![1], false));
    }
    assert!(!outbox.admit(MAX_INPUT_ENTRIES as u32 + 2, vec![1], false));
    outbox.rebase(3);
    assert_eq!(outbox.released_local(), 2);
    assert!(outbox.admit(MAX_INPUT_ENTRIES as u32 + 2, vec![1], false));
}

fn resize(seq: u32) -> Vec<u8> {
    let mut body = [0; merkur_wire::protocol::RESIZE_BYTES];
    body[..2].copy_from_slice(&100u16.to_be_bytes());
    body[2..4].copy_from_slice(&30u16.to_be_bytes());
    body[4..8].copy_from_slice(&seq.to_be_bytes());
    merkur_wire::protocol::encode_proto_frame(merkur_wire::protocol::MSG_TYPE_RESIZE, &body)
}

/// `(wire position, viewport serial)` of the fence a run carries.
fn fence(outbox: &Outbox) -> Option<(u32, u32)> {
    outbox
        .run_geometry()
        .map(|geometry| (geometry.position, geometry.seq()))
}

#[test]
fn a_fence_waits_for_the_first_record_typed_after_it_and_retires_with_it() {
    let mut outbox = outbox(&[(1, 1), (2, 2)]);
    outbox.fence(resize(7), false);
    assert_eq!(fence(&outbox), None, "nothing typed after it yet");
    assert!(outbox.admit(3, vec![3], false));
    assert!(outbox.admit(4, vec![4], false));
    assert_eq!(fence(&outbox), Some((3, 7)));
    // A newer intent supersedes the frame but keeps the held position.
    outbox.fence(resize(8), false);
    assert_eq!(fence(&outbox), Some((3, 8)));
    outbox.ack(2);
    assert_eq!(fence(&outbox), Some((3, 8)));
    outbox.ack(3);
    assert_eq!(fence(&outbox), None, "applied before record 3 was");
    // Retired: the next intent waits for its own record.
    outbox.fence(resize(9), false);
    assert_eq!(fence(&outbox), None);
    assert!(outbox.admit(5, vec![5], false));
    assert_eq!(fence(&outbox), Some((5, 9)));
}

#[test]
fn an_epochs_intent_precedes_every_held_record_and_follows_a_rebase() {
    let mut outbox = outbox(&[(10, 1), (11, 2)]);
    outbox.fence(resize(3), false);
    assert!(outbox.admit(12, vec![3], false));
    assert_eq!(fence(&outbox), Some((12, 3)));
    // A fresh daemon numbers the held records from its own expectation, and
    // its first intent goes ahead of all of them.
    outbox.rebase(1);
    outbox.clear_fence();
    assert_eq!(fence(&outbox), None);
    outbox.fence(resize(4), true);
    assert_eq!(fence(&outbox), Some((1, 4)));
    // With nothing held it waits for the next record, numbered on the rebase.
    let mut empty = Outbox::new();
    empty.rebase(40);
    empty.fence(resize(5), true);
    assert_eq!(fence(&empty), None);
    assert!(empty.admit(2, vec![1], false));
    assert_eq!(fence(&empty), Some((40, 5)));
}

#[test]
fn a_rebase_past_the_fences_record_retires_it() {
    let mut outbox = outbox(&[(1, 1)]);
    outbox.fence(resize(2), false);
    assert!(outbox.admit(2, vec![2], false));
    // The last daemon admitted record 2 behind a lost ack, so it applied the
    // fence first.
    outbox.rebase(3);
    assert_eq!(fence(&outbox), None);
    outbox.discard();
    outbox.fence(resize(3), false);
    outbox.discard();
    assert!(outbox.admit(3, vec![3], false));
    assert_eq!(fence(&outbox), None, "a retired session's intent is gone");
}
