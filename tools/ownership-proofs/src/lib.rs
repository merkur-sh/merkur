//! Test-only proof adapter. The ownership predicates below are production source.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnId(pub u64);

extern crate self as merkur_e2e;
include!(concat!(env!("OUT_DIR"), "/lanes.rs"));

#[cfg(any(test, kani))]
include!(concat!(env!("OUT_DIR"), "/writer_custody.rs"));

#[cfg(kani)]
mod proofs {
    use super::{lane_for_channel, writer_lane_blocked, ConnId};

    // This harness bounds custody to two entries; ids and channels span their full types.
    // It checks provider-independent exclusion and independent credit for other lanes.
    #[kani::proof]
    #[kani::unwind(3)]
    fn custody_survives_provider_switch() {
        let owners = [
            (ConnId(kani::any()), kani::any()),
            (ConnId(kani::any()), kani::any()),
        ];
        let conn = ConnId(kani::any());
        let channel: u8 = kani::any();
        let len: usize = kani::any();
        kani::assume(len <= owners.len());
        let blocked = &owners[..len];
        let selected: usize = kani::any();
        kani::assume(selected < len);
        let owned_channel = blocked[selected].1;
        kani::assume(lane_for_channel(owned_channel).is_some());
        // Changing provider cannot release custody of the owner's cipher.
        assert!(writer_lane_blocked(blocked, conn, owned_channel));
        // A lane absent from every owner remains independently writable.
        kani::assume(lane_for_channel(channel).is_some());
        kani::assume(lane_for_channel(channel) != lane_for_channel(owners[0].1));
        kani::assume(lane_for_channel(channel) != lane_for_channel(owners[1].1));
        assert!(!writer_lane_blocked(blocked, conn, channel));
    }

    #[kani::proof]
    #[kani::unwind(2)]
    fn proof_channels_keep_exact_writer_custody() {
        let old = ConnId(kani::any());
        let successor = ConnId(kani::any());
        let channel: u8 = kani::any();
        kani::assume(lane_for_channel(channel).is_none());
        kani::assume(old != successor);
        assert!(writer_lane_blocked(&[(old, channel)], old, channel));
        assert!(!writer_lane_blocked(&[(old, channel)], successor, channel));
    }

    #[kani::proof]
    #[kani::unwind(3)]
    fn unrelated_lane_keeps_credit() {
        let old = ConnId(kani::any());
        let successor = ConnId(kani::any());
        let owner_channel: u8 = kani::any();
        let send_channel: u8 = kani::any();
        kani::assume(lane_for_channel(owner_channel).is_some());
        kani::assume(lane_for_channel(send_channel).is_some());
        kani::assume(lane_for_channel(owner_channel) != lane_for_channel(send_channel));
        assert!(!writer_lane_blocked(
            &[(old, owner_channel)],
            successor,
            send_channel
        ));
        assert!(writer_lane_blocked(
            &[(old, owner_channel)],
            successor,
            owner_channel
        ));
        assert!(!writer_lane_blocked(&[], successor, owner_channel));
    }
}

#[cfg(not(kani))]
#[test]
fn provider_changes_cannot_release_another_writers_cipher() {
    assert!(writer_lane_blocked(&[(ConnId(1), 1)], ConnId(2), 1));
    assert!(!writer_lane_blocked(&[(ConnId(1), 1)], ConnId(2), 2));
}
