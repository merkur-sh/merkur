use merkur_client::input_sequence::InputMapping;
use merkur_client::viewer::DisplayGrid;
use merkur_codec::{
    FrameHeader, FrameKind, MSG_TYPE_DISPLAY_PATCH, RowRef, STREAM_HEADER_BYTES, StreamHeader,
    encode_frame_into, write_stream_header,
};
use merkur_wire::input_record::{MouseRecord, WheelRecord, mods};
use merkur_wire::protocol::CHANNEL_DISPLAY_COMMIT;

use super::*;

fn size() -> HostSize {
    HostSize {
        cols: 8,
        rows: 4,
        cell: Some((10.0, 20.0)),
    }
}

#[test]
fn ending_the_input_owner_retires_unwritten_records() {
    let mut view = SessionView::new(size(), 1);
    view.budget.admit(6).unwrap();
    view.deferred.push_back(Command::Input {
        local_seq: 1,
        record: build::text("secret"),
        modelled: false,
    });
    view.ready.push_back(Command::Input {
        local_seq: 2,
        record: build::text("secret"),
        modelled: false,
    });
    view.disconnected();
    assert!(view.deferred.is_empty());
    assert!(view.ready.is_empty());
    assert_eq!(view.budget.admit(1), Ok(1));
    assert!(view.wants_frame());
}

#[test]
fn ending_the_input_owner_removes_the_unconfirmed_shadow_line() {
    let mut view = SessionView::new(size(), 1);
    view.receive(0.0, snapshot(8, 3, 1 << 5));
    view.drained(0.0);
    let mut commands = Vec::new();
    view.input(1.0, HostEvent::Record(build::press('x')), &mut commands)
        .unwrap();
    assert!(matches!(
        &commands[0],
        Command::Input { modelled: true, .. }
    ));
    assert!(view.viewer.grid().has_predictions());
    view.disconnected();
    assert!(!view.viewer.grid().has_predictions());
    assert_eq!(view.viewer.grid().size(), (8, 3));
}

fn snapshot(cols: u16, rows: u16, modes: u16) -> Output {
    let header = FrameHeader {
        kind: FrameKind::Snapshot,
        memory_only: false,
        cols,
        rows,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: modes,
        row_count: 0,
        frame_id: 1,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut payload = Vec::new();
    encode_frame_into(&mut payload, &header, std::iter::empty::<RowRef<'_>>());
    let body_len = (payload.len() - STREAM_HEADER_BYTES) as u32;
    write_stream_header(
        &mut payload,
        &StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: 0,
            body_len,
            seq: 0,
            generation: 1,
            input_seq: 0,
        },
    );
    Output::Terminal {
        datagram: false,
        channel: CHANNEL_DISPLAY_COMMIT,
        payload,
        input: InputMapping::default(),
    }
}

#[test]
fn changed_state_spends_consumption_credit_without_a_refresh_wait() {
    let mut frames = HostFrames::default();
    assert!(frames.begin(0.0, true));
    assert_eq!(frames.next_frame(1.0, true, true), None);
    assert!(
        !frames.begin(1.0, true),
        "a tab switch cannot bypass the host fence"
    );
    assert!(!frames.answered(), "the host has answered no query yet");
    frames.consumed();
    assert!(frames.answered());
    assert_eq!(frames.next_frame(1.0, true, true), Some(1.0));
    assert!(frames.begin(1.0, true));
    assert!(!frames.begin(2.0, true));
    frames.consumed();
    assert_eq!(frames.next_frame(2.0, true, false), Some(FRAME_PERIOD_MS));
    assert!(
        !frames.begin(2.0, false),
        "grant-only work retains its cadence"
    );
    assert!(frames.begin(FRAME_PERIOD_MS, false));
    frames.consumed();
    assert_eq!(
        frames.next_frame(50.0, false, false),
        None,
        "idle owns no timer"
    );
}

#[test]
fn owner_resize_reflows_and_observer_resize_keeps_canonical_coordinates() {
    let mut view = SessionView::new(size(), 1);
    view.receive(0.0, snapshot(12, 6, 0));
    view.drained(0.0);
    let resized = HostSize {
        cols: 7,
        rows: 5,
        ..size()
    };
    view.resize(1.0, resized);
    assert_eq!(view.viewer.grid().terminal().cols(), 12);
    assert_eq!(view.viewer.grid().terminal().rows(), 6);
    view.receive(2.0, Output::GeometryState(GeometryStatus::Owner));
    assert_eq!(view.viewer.grid().terminal().cols(), 7);
    assert_eq!(view.viewer.grid().terminal().rows(), 4);
    let Command::Viewport { cols, rows, cell } = view.viewport().expect("viewport") else {
        panic!("viewport");
    };
    assert_eq!((cols, rows, cell), (7, 4, Some((10.0, 20.0))));
    // A host that states no cell pixels still claims the machine's grid.
    let Some(Command::Viewport { cols, rows, cell }) = view.resize(
        3.0,
        HostSize {
            cell: None,
            ..resized
        },
    ) else {
        panic!("viewport");
    };
    assert_eq!((cols, rows, cell), (7, 4, None));
}

#[test]
fn host_pointer_modes_follow_the_remote_and_status_cells_never_reach_it() {
    let mut view = SessionView::new(size(), 1);
    view.receive(
        0.0,
        snapshot(8, 3, (POINTER_CLICKS | POINTER_DRAG | WHEEL) as u16),
    );
    view.drained(0.0);
    let mut frame = Vec::new();
    view.frame(0.0, &mut frame).unwrap();
    assert!(
        frame
            .windows(b"\x1b[?1002h".len())
            .any(|p| p == b"\x1b[?1002h")
    );
    assert!(frame.ends_with(b"\x1b[5n"));
    let mut commands = Vec::new();
    let mouse = MouseRecord {
        action: MouseAction::Press,
        button: MouseButton::Left,
        mods: mods::CTRL,
        column: 2,
        row: 1,
    };
    view.input(1.0, HostEvent::Mouse(mouse), &mut commands)
        .unwrap();
    assert!(
        matches!(&commands[0], Command::Input { local_seq: 1, record, modelled: false } if decode(record) == Some(InputRecord::Mouse(mouse)))
    );
    view.input(
        1.0,
        HostEvent::Mouse(MouseRecord { row: 3, ..mouse }),
        &mut commands,
    )
    .unwrap();
    assert_eq!(commands.len(), 1, "the status row belongs to the UI");
    view.input(
        1.0,
        HostEvent::Mouse(MouseRecord {
            action: MouseAction::Motion,
            button: MouseButton::None,
            ..mouse
        }),
        &mut commands,
    )
    .unwrap();
    assert_eq!(commands.len(), 1, "drag mode does not report hover");
    let wheel = WheelRecord {
        direction: WheelDirection::Down,
        mods: 0,
        count: 1,
        column: 2,
        row: 1,
    };
    view.input(1.0, HostEvent::Wheel(wheel), &mut commands)
        .unwrap();
    assert!(
        matches!(&commands[1], Command::Input { local_seq: 2, record, .. } if decode(record) == Some(InputRecord::Wheel(wheel)))
    );
}

#[test]
fn focus_drives_geometry_and_the_record_keeps_input_order() {
    let mut view = SessionView::new(size(), 1);
    let mut commands = Vec::new();
    view.input(0.0, HostEvent::Record(build::focus(false)), &mut commands)
        .unwrap();
    assert_eq!(commands.len(), 1, "unreported focus stays deferred");
    view.input(1.0, HostEvent::Record(build::press('x')), &mut commands)
        .unwrap();
    assert!(matches!(commands[0], Command::Focused(false)));
    assert!(
        matches!(&commands[1], Command::Input { local_seq: 1, record, modelled: false } if decode(record) == Some(InputRecord::Focus(false)))
    );
    assert!(matches!(commands[2], Command::Input { local_seq: 2, .. }));
}

#[test]
fn a_canonical_screen_larger_than_the_host_cannot_draw_over_chrome() {
    let mut view = SessionView::new(size(), 1);
    view.receive(0.0, snapshot(20, 8, 0));
    view.drained(0.0);
    let source = Cropped {
        grid: view.viewer.grid(),
        links: view.viewer.links(),
        cols: 8,
        rows: 3,
    };
    assert_eq!(source.size(), (8, 3));
    let mut row = Vec::new();
    source.row(0, &mut row);
    assert_eq!(row.len(), 8);
    let mut frame = Vec::new();
    view.frame(0.0, &mut frame).unwrap();
    assert!(
        !frame
            .windows(b"\x1b[4;".len())
            .any(|part| part == b"\x1b[4;")
    );
}

#[test]
fn a_mode_edge_cannot_let_new_input_overtake_deferred_reports() {
    let mut view = SessionView::new(size(), 1);
    let mut commands = Vec::new();
    view.input(
        0.0,
        HostEvent::Record(build::functional(u32::from('a'), 2, 0)),
        &mut commands,
    )
    .unwrap();
    assert!(commands.is_empty());
    view.receive(
        1.0,
        snapshot(8, 3, merkur_client::input_delivery::KEY_RELEASES as u16),
    );
    view.drained(1.0);
    view.input(2.0, HostEvent::Record(build::press('b')), &mut commands)
        .unwrap();
    assert!(matches!(
        commands[0],
        Command::Input {
            local_seq: 1,
            modelled: false,
            ..
        }
    ));
    assert!(matches!(commands[1], Command::Input { local_seq: 2, .. }));
    assert!(!matches!(
        view.poll_command(2.0),
        Some(Command::Input { .. })
    ));
}

#[test]
fn paste_chunks_preserve_utf8_and_the_host_budget_requires_authenticated_ack() {
    use merkur_client::input_delivery::MAX_INPUT_BYTES;
    let mut view = SessionView::new(size(), 1);
    let text = "界".repeat(PASTE_CHUNK);
    let mut commands = Vec::new();
    view.input(0.0, HostEvent::Record(build::paste(&text)), &mut commands)
        .unwrap();
    let mut recovered = String::new();
    for (index, command) in commands.iter().enumerate() {
        let Command::Input {
            local_seq, record, ..
        } = command
        else {
            panic!("input");
        };
        assert_eq!(*local_seq, index as u32 + 1);
        let Some(InputRecord::Paste(chunk)) = decode(record) else {
            panic!("paste");
        };
        assert!(chunk.len() <= PASTE_CHUNK);
        recovered.push_str(chunk);
    }
    assert_eq!(recovered, text);
    let sequence = match commands.last().unwrap() {
        Command::Input { local_seq, .. } => *local_seq,
        _ => unreachable!(),
    };
    view.receive(0.0, Output::InputAcknowledged(sequence));
    // Deferred focus reports are charged too, though no transport owns them yet.
    assert!(view.budget.admit(MAX_INPUT_BYTES).is_ok());
    assert!(
        view.input(1.0, HostEvent::Record(build::focus(true)), &mut commands)
            .is_err()
    );
}

fn cursor_delta(coherent: bool) -> Output {
    let Output::Terminal { mut payload, .. } = snapshot(8, 3, 0) else {
        unreachable!()
    };
    let mut header = merkur_codec::parse_frame_header(&payload).unwrap();
    header.kind = FrameKind::Delta;
    header.cursor_col = 1;
    header.presentation_coherent = coherent;
    header.presentation_id = 1;
    header.presentation_member_count = if coherent { 2 } else { 0 };
    payload.clear();
    encode_frame_into(&mut payload, &header, std::iter::empty::<RowRef<'_>>());
    let body_len = (payload.len() - STREAM_HEADER_BYTES) as u32;
    write_stream_header(
        &mut payload,
        &StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: 0,
            body_len,
            seq: 1,
            generation: 1,
            input_seq: 0,
        },
    );
    Output::Terminal {
        datagram: true,
        channel: merkur_wire::protocol::CHANNEL_DISPLAY_DATAGRAM,
        payload,
        input: InputMapping::default(),
    }
}

#[test]
fn urgent_authority_is_composed_before_the_next_maintenance_refresh() {
    let mut view = SessionView::new(size(), 1);
    view.receive(0.0, snapshot(8, 3, 0));
    view.drained(0.0);
    view.frame(0.0, &mut Vec::new()).unwrap();
    view.receive(1.0, cursor_delta(false));
    view.drained(1.0);
    assert!(view.needs_paint());
    let mut paint = Vec::new();
    view.frame(1.0, &mut paint).unwrap();
    assert_eq!(view.viewer.grid().cursor().unwrap().col, 1);
    assert!(
        paint
            .windows(b"\x1b[1;2H".len())
            .any(|bytes| bytes == b"\x1b[1;2H")
    );
}

/// Row `row` reading `text` with the cursor after it, where input is predicted.
fn row_delta(seq: u32, row: u16, text: &str) -> Output {
    let Output::Terminal { mut payload, .. } = snapshot(8, 3, 1 << 5) else {
        unreachable!()
    };
    let mut header = merkur_codec::parse_frame_header(&payload).unwrap();
    header.kind = FrameKind::Delta;
    header.cursor_row = row;
    header.cursor_col = text.len() as u16;
    header.row_count = 1;
    header.frame_id = seq + 1;
    let cells: Vec<merkur_codec::CellRepr> = text
        .chars()
        .map(|ch| merkur_codec::CellRepr {
            codepoint: u32::from(ch),
            ..merkur_codec::CellRepr::BLANK
        })
        .collect();
    payload.clear();
    encode_frame_into(
        &mut payload,
        &header,
        std::iter::once(RowRef {
            row_index: row,
            left: 0,
            cells: &cells,
            graphics: &[],
        }),
    );
    let body_len = (payload.len() - STREAM_HEADER_BYTES) as u32;
    write_stream_header(
        &mut payload,
        &StreamHeader {
            msg_type: MSG_TYPE_DISPLAY_PATCH,
            flags: 0,
            body_len,
            seq,
            generation: 1,
            input_seq: 0,
        },
    );
    Output::Terminal {
        datagram: true,
        channel: merkur_wire::protocol::CHANNEL_DISPLAY_DATAGRAM,
        payload,
        input: InputMapping::default(),
    }
}

/// Paint one frame, check the composer holds exactly what the viewer presents,
/// and say what each row was made from.
fn painted(view: &mut SessionView, now_ms: f64) -> Vec<Option<Revision>> {
    view.drained(now_ms);
    view.frame(now_ms, &mut Vec::new()).unwrap();
    let (cols, rows) = content_size(view.size, view.status_rows);
    let source = Cropped {
        grid: view.viewer.grid(),
        links: view.viewer.links(),
        cols,
        rows,
    };
    assert!(
        view.composer.mirrors(&source),
        "the composer holds a stale row at {now_ms}"
    );
    (0..rows).map(|row| source.revision(row)).collect()
}

#[test]
fn a_view_that_skips_settled_rows_holds_what_reading_every_row_would() {
    let mut view = SessionView::new(size(), 1);
    view.receive(0.0, snapshot(8, 3, 1 << 5));
    let settled = painted(&mut view, 0.0);
    assert!(settled.iter().all(Option::is_some));

    // An echo on one row is that row's commit alone.
    view.receive(1.0, row_delta(1, 1, "ls"));
    let echoed = painted(&mut view, 1.0);
    assert!(echoed[1] > settled[1]);
    assert_eq!((echoed[0], echoed[2]), (settled[0], settled[2]));
    assert_eq!(view.viewer.grid().screen()[1], "ls");

    // A key the model takes lands on the cursor's row with no commit, so
    // that row is read on every frame while the echo is there.
    let mut commands = Vec::new();
    view.input(2.0, HostEvent::Record(build::press('x')), &mut commands)
        .unwrap();
    assert!(view.viewer.grid().terminal().row_holds_prediction(1));
    let predicted = painted(&mut view, 2.0);
    assert_eq!(predicted[1], None);
    assert_eq!((predicted[0], predicted[2]), (echoed[0], echoed[2]));

    // Withdrawn, the row is again what its commit made it, and is shown so.
    view.viewer.discard_input();
    assert_eq!(painted(&mut view, 3.0), echoed);
}

#[test]
fn extra_host_paints_do_not_spend_an_incomplete_redraws_frame_bound() {
    let mut view = SessionView::new(size(), 1);
    view.receive(0.0, snapshot(8, 3, 0));
    view.drained(0.0);
    view.frame(0.0, &mut Vec::new()).unwrap();
    view.receive(1.0, cursor_delta(true));
    view.drained(1.0);
    assert!(
        !view.needs_paint(),
        "partial redraw has no new presented state"
    );
    assert!(view.wants_frame(), "partial redraw still needs maintenance");
    for at in [1.0, 2.0, 3.0, FRAME_PERIOD_MS] {
        view.frame(at, &mut Vec::new()).unwrap();
        assert_eq!(view.viewer.grid().cursor().unwrap().col, 0, "held at {at}");
    }
    view.frame(2.0 * FRAME_PERIOD_MS, &mut Vec::new()).unwrap();
    assert_eq!(view.viewer.grid().cursor().unwrap().col, 1);
}
