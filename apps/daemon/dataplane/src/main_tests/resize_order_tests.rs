use super::*;

#[test]
fn pixel_geometry_queries_follow_the_committed_resize_and_survive_reset() {
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize::default())
        .unwrap();
    let (tx, rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, tx);
    let mut peers = PeerMap::from([(
        "browser".into(),
        PeerDisplayState::new("browser".into(), PeerTransport::WebTransport),
    )]);
    let peer = peers.get_mut("browser").unwrap();
    peer.authenticated = true;
    terminal.geometry_authority.claim(peer, 1, 0);
    let mut body = [0; 24];
    body[16..24].copy_from_slice(&1_u64.to_be_bytes());
    body[..2].copy_from_slice(&120_u16.to_be_bytes());
    body[2..4].copy_from_slice(&48_u16.to_be_bytes());
    body[4..8].copy_from_slice(&1_u32.to_be_bytes());
    body[8..12].copy_from_slice(&(8_u32 * 65536 + 16384).to_be_bytes());
    body[12..16].copy_from_slice(&(16_u32 * 65536 + 32768).to_be_bytes());
    handle_resize_request("browser", &body, &*pair.master, &mut terminal, &mut peers);
    let size = pair.master.get_size().unwrap();
    assert_eq!((size.pixel_width, size.pixel_height), (990, 792));
    terminal.apply_bytes(b"\x1b[14t\x1bc\x1b[14t\x1b[5n");
    let replies: Vec<_> = rx
        .try_iter()
        .filter_map(|event| match event {
            TerminalEvent::PtyWrite(bytes) => Some(bytes),
            _ => None,
        })
        .collect();
    assert_eq!(
        replies,
        [
            b"\x1b[4;792;990t".to_vec(),
            b"\x1b[4;792;990t".to_vec(),
            b"\x1b[0n".to_vec(),
        ]
    );
    // A malformed metric cannot consume its serial or alter the OS/grid pair.
    body[4..8].copy_from_slice(&2_u32.to_be_bytes());
    body[8..12].fill(0);
    handle_resize_request("browser", &body, &*pair.master, &mut terminal, &mut peers);
    assert_eq!(peers["browser"].last_resize_seq, 1);
    assert_eq!(pair.master.get_size().unwrap().pixel_width, 990);
}

#[test]
fn delayed_edge_resize_cannot_overwrite_newer_direct_viewport() {
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize::default())
        .expect("test PTY");
    let (terminal_tx, _terminal_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_tx);
    let mut peers = PeerMap::new();
    peers.insert(
        "browser".into(),
        PeerDisplayState::new("browser".into(), PeerTransport::WebTransport),
    );

    let peer = peers.get_mut("browser").unwrap();
    peer.authenticated = true;
    terminal.geometry_authority.claim(peer, 1, 0);
    // An initial edge resize was sent first but a newer viewport reaches
    // the daemon over direct before that edge stream is delivered.
    for (seq, cols, rows) in [(0x0102_0304_u32, 120_u16, 48_u16), (0x0102_0303, 80, 24)] {
        let mut body = [0; 24];
        body[16..24].copy_from_slice(&1_u64.to_be_bytes());
        body[..2].copy_from_slice(&cols.to_be_bytes());
        body[2..4].copy_from_slice(&rows.to_be_bytes());
        body[4..8].copy_from_slice(&seq.to_be_bytes());
        body[8..12].copy_from_slice(&(8_u32 << 16).to_be_bytes());
        body[12..16].copy_from_slice(&(16_u32 << 16).to_be_bytes());
        handle_resize_request("browser", &body, &*pair.master, &mut terminal, &mut peers);
    }

    let size = pair.master.get_size().expect("test PTY dimensions");
    assert_eq!((size.cols, size.rows), (120, 48));
    assert_eq!((size.pixel_width, size.pixel_height), (960, 768));
    assert_eq!((terminal.cols, terminal.rows), (120, 48));
    assert_eq!(peers["browser"].last_resize_seq, 0x0102_0304);
}

#[test]
fn resize_intent_wrap_duplicates_and_invalid_requests_preserve_latest_grid() {
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize::default())
        .expect("test PTY");
    let (terminal_tx, _terminal_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_tx);
    let mut peer = PeerDisplayState::new("browser".into(), PeerTransport::WebTransport);
    peer.authenticated = true;
    terminal.geometry_authority.claim(&peer, 1, 0);
    peer.last_resize_seq = u32::MAX - 1;
    let mut peers = PeerMap::from([("browser".into(), peer)]);

    for (seq, cols, accepted, expected_cols) in [
        (u32::MAX, 100_u16, true, 100),
        (1, 120, true, 120),
        (u32::MAX, 80, false, 120),
        (1, 90, false, 120),
        (0, 90, false, 120),
        (2, 0, false, 120),
        (2, 110, true, 110),
    ] {
        let peer = peers.get_mut("browser").expect("peer");
        peer.needs_snapshot = false;
        peer.needs_full_diff = false;
        let mut body = [0; 24];
        body[16..24].copy_from_slice(&1_u64.to_be_bytes());
        body[..2].copy_from_slice(&cols.to_be_bytes());
        body[2..4].copy_from_slice(&48_u16.to_be_bytes());
        body[4..8].copy_from_slice(&seq.to_be_bytes());
        body[8..12].copy_from_slice(&(8_u32 << 16).to_be_bytes());
        body[12..16].copy_from_slice(&(16_u32 << 16).to_be_bytes());
        handle_resize_request("browser", &body, &*pair.master, &mut terminal, &mut peers);
        let size = pair.master.get_size().expect("test PTY dimensions");
        assert_eq!((size.cols, size.rows), (expected_cols, 48));
        assert_eq!((terminal.cols, terminal.rows), (expected_cols, 48));
        assert_eq!(peers["browser"].needs_snapshot, accepted);
        assert_eq!(peers["browser"].needs_full_diff, accepted);
    }
}

/// A peer that owns geometry generation 1 of an 80×24 terminal.
fn fenced_owner() -> (portable_pty::PtyPair, TerminalState, PeerMap) {
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize::default())
        .expect("test PTY");
    let (terminal_tx, _terminal_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_tx);
    let mut peer = PeerDisplayState::new("browser".into(), PeerTransport::Edge);
    peer.authenticated = true;
    terminal.geometry_authority.claim(&peer, 1, 0);
    (pair, terminal, PeerMap::from([("browser".into(), peer)]))
}

fn resize_to(cols: u16, rows: u16, seq: u32) -> [u8; RESIZE_BYTES] {
    let mut body = [0; RESIZE_BYTES];
    body[..2].copy_from_slice(&cols.to_be_bytes());
    body[2..4].copy_from_slice(&rows.to_be_bytes());
    body[4..8].copy_from_slice(&seq.to_be_bytes());
    body[16..].copy_from_slice(&1_u64.to_be_bytes());
    body
}

fn pty_lane(delivery: DeliveryMode) -> PeerMessage {
    PeerMessage {
        input_permit: None,
        peer_node_id: "browser".into(),
        channel_id: CHANNEL_PTY,
        payload: bytes::Bytes::new(),
        via_transport: PeerTransport::Edge,
        delivery,
        connection_id: 0,
        edge_ingress: None,
    }
}

fn settle(
    pair: &portable_pty::PtyPair,
    writer: &mut PtyWriter,
    terminal: &mut TerminalState,
    peers: &mut PeerMap,
) {
    settle_geometry_fences(
        Some(&Arc::from("browser")),
        &*pair.master,
        writer,
        terminal,
        peers,
        &mut ParkedPeers::new(),
        &mut input::InputRefill::default(),
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
}

/// `stty size` typed after a resize, in one datagram run with the record
/// typed before it: the first record is admitted at once, the second only
/// after the PTY has the new size, and the control copy that comes late is
/// inert.
#[tokio::test]
async fn input_typed_after_a_resize_waits_for_it_on_the_datagram_lane() {
    let (pair, mut terminal, mut peers) = fenced_owner();
    let (mut writer, _completions) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let resize = resize_to(100, 30, 1);
    let fence = RunGeometry::new(2, MSG_TYPE_RESIZE, &resize).expect("a resize intent");
    let a = input_record::build::press('a');
    let b = input_record::build::press('b');
    let run = encode_probed_input_run(1, false, None, Some(fence), &[(&a, false), (&b, false)]);
    handle_pty_channel(
        &pty_lane(DeliveryMode::Datagram),
        &run,
        &mut writer,
        &mut terminal,
        &mut peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    assert_eq!(peers["browser"].keystroke_next_queued_seq, 2);
    assert_eq!(pair.master.get_size().unwrap().cols, 80);
    settle(&pair, &mut writer, &mut terminal, &mut peers);
    let size = pair.master.get_size().unwrap();
    assert_eq!((size.cols, size.rows), (100, 30));
    assert_eq!(peers["browser"].keystroke_next_queued_seq, 3);
    assert!(peers["browser"].geometry_fence.is_none());
    assert!(peers["browser"].keystroke_reorder_buf.is_empty());
    // The control lane's copy of the same intent arrives last.
    geometry::resize("browser", &resize, &*pair.master, &mut terminal, &mut peers);
    assert_eq!(peers["browser"].last_resize_seq, 1);
    assert_eq!(pair.master.get_size().unwrap().cols, 100);
}

#[tokio::test]
async fn the_reliable_lane_retains_input_behind_a_resize_without_copying_it() {
    let (pair, mut terminal, mut peers) = fenced_owner();
    let (mut writer, _completions) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let fence = RunGeometry::new(2, MSG_TYPE_RESIZE, &resize_to(100, 30, 1)).unwrap();
    let a = input_record::build::press('a');
    let b = input_record::build::press('b');
    let mut plaintext =
        encode_probed_input_run(1, false, None, Some(fence), &[(&a, false), (&b, false)]);
    let len = plaintext.len();
    let mut refill = input::InputRefill::default();
    handle_reliable_input(
        &mut pty_lane(DeliveryMode::Stream),
        &mut plaintext,
        len,
        &mut writer,
        &mut terminal,
        &mut peers,
        &mut refill,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    let peer = &peers["browser"];
    assert_eq!(peer.keystroke_next_queued_seq, 2);
    assert!(peer.reliable_inputs.has_pending());
    assert!(peer.keystroke_reorder_buf.is_empty(), "no reorder copy");
    settle(&pair, &mut writer, &mut terminal, &mut peers);
    assert_eq!(pair.master.get_size().unwrap().cols, 100);
    assert_eq!(peers["browser"].keystroke_next_queued_seq, 3);
    assert!(!peers["browser"].reliable_inputs.has_pending());
}

/// A successor lineage restates its geometry ahead of input its predecessor
/// already admitted: the intent is due at once, before the next record.
#[tokio::test]
async fn an_intent_whose_position_was_admitted_applies_before_the_next_record() {
    let (pair, mut terminal, mut peers) = fenced_owner();
    let (mut writer, _completions) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    peers.get_mut("browser").unwrap().keystroke_next_queued_seq = 5;
    peers.get_mut("browser").unwrap().keystroke_next_expected_seq = 5;
    let fence = RunGeometry::new(3, MSG_TYPE_RESIZE, &resize_to(120, 40, 4)).unwrap();
    let e = input_record::build::press('e');
    let run = encode_probed_input_run(5, false, None, Some(fence), &[(&e, false)]);
    handle_pty_channel(
        &pty_lane(DeliveryMode::Datagram),
        &run,
        &mut writer,
        &mut terminal,
        &mut peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    assert_eq!(peers["browser"].keystroke_next_queued_seq, 5);
    settle(&pair, &mut writer, &mut terminal, &mut peers);
    assert_eq!(pair.master.get_size().unwrap().cols, 120);
    assert_eq!(peers["browser"].keystroke_next_queued_seq, 6);
}

/// The control copy first: the run's copy holds nothing back.
#[tokio::test]
async fn a_resize_applied_from_control_holds_no_input() {
    let (pair, mut terminal, mut peers) = fenced_owner();
    let (mut writer, _completions) = PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let resize = resize_to(100, 30, 1);
    geometry::resize("browser", &resize, &*pair.master, &mut terminal, &mut peers);
    let fence = RunGeometry::new(2, MSG_TYPE_RESIZE, &resize).unwrap();
    let a = input_record::build::press('a');
    let b = input_record::build::press('b');
    let run = encode_probed_input_run(1, false, None, Some(fence), &[(&a, false), (&b, false)]);
    handle_pty_channel(
        &pty_lane(DeliveryMode::Datagram),
        &run,
        &mut writer,
        &mut terminal,
        &mut peers,
        Instant::now(),
        &mut PerfTimingTracker::default(),
    );
    assert_eq!(peers["browser"].keystroke_next_queued_seq, 3);
    assert!(peers["browser"].geometry_fence.is_none());
}
