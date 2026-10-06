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
