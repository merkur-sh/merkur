use super::*;
use merkur_client::input_sequence::InputMapping;
use merkur_wire::protocol::CHANNEL_DISPLAY_COMMIT;

fn size() -> HostSize {
    HostSize {
        cols: 12,
        rows: 6,
        cell: Some((10.0, 20.0)),
    }
}
fn tab(id: u64) -> Tab {
    Tab {
        id,
        machine: id.to_string(),
        view: SessionView::new(size(), 1),
        commands: None,
        driver: None,
        status: "Ready".into(),
        path: "Relay".into(),
        rtt_ms: None,
        geometry: None,
        urls: open_url::Requests::default(),
    }
}
fn machine(id: &str) -> Device {
    Device {
        id: id.into(),
        user_id: "user".into(),
        name: id.into(),
        platform: "macos".into(),
        last_seen: None,
        status: devices::Status::Online,
        version: None,
        identity_seal_backend: devices::IdentityBackend::Software,
    }
}
#[test]
fn background_output_never_schedules_a_foreground_grant() {
    let mut workspace = Workspace {
        tabs: vec![tab(1), tab(2)],
        selected: Some(1),
        ..Workspace::default()
    };
    let (foreground, _foreground_receiver) = driver::Commands::channel();
    let (background, _background_receiver) = driver::Commands::channel();
    workspace.tabs[0].commands = Some(foreground);
    workspace.tabs[1].commands = Some(background);
    let mut paint = Vec::new();
    workspace
        .frame(size(), 0.0, false, &mut Chrome::default(), &mut paint)
        .unwrap();
    assert!(!workspace.active().unwrap().view.wants_frame());
    let output = Output::Terminal {
        datagram: false,
        channel: CHANNEL_DISPLAY_COMMIT,
        payload: Vec::new(),
        input: InputMapping::default(),
    };
    assert_eq!(
        workspace.message(10.0, Message::Output(2, output)).unwrap(),
        MessageEffect::Quiet
    );
    assert!(workspace.tabs[1].view.wants_frame());
    assert!(!workspace.active().unwrap().view.wants_frame());
    assert_eq!(
        workspace
            .message(
                10.0,
                Message::Output(
                    2,
                    Output::GraphicsClock {
                        monotonic_us: 0,
                        rtt_ms: 10
                    }
                )
            )
            .unwrap(),
        MessageEffect::Quiet
    );
    assert_eq!(
        workspace
            .message(
                10.0,
                Message::Output(
                    1,
                    Output::GraphicsClock {
                        monotonic_us: 0,
                        rtt_ms: 10
                    }
                )
            )
            .unwrap(),
        MessageEffect::Changed
    );
}
#[test]
fn snapshots_keep_selection_by_identity_and_removed_selection_chooses_a_real_machine() {
    let mut workspace = Workspace::default();
    workspace
        .message(
            0.0,
            Message::Machines(vec![machine("a"), machine("b")], true, "Live".into()),
        )
        .unwrap();
    workspace.move_machine(1);
    assert_eq!(workspace.machine_selection.as_deref(), Some("b"));
    workspace
        .message(
            1.0,
            Message::Machines(vec![machine("b"), machine("a")], true, "Live".into()),
        )
        .unwrap();
    assert_eq!(workspace.machine_selection.as_deref(), Some("b"));
    workspace
        .message(
            2.0,
            Message::Machines(vec![machine("a")], true, "Live".into()),
        )
        .unwrap();
    assert_eq!(workspace.machine_selection.as_deref(), Some("a"));
}
#[test]
fn chrome_strips_host_commands_and_never_wraps_a_wide_final_scalar() {
    let mut out = Vec::new();
    line(
        &mut out,
        HostSize { cols: 3, ..size() },
        1,
        "a界Z\x1b\x07",
        false,
    );
    assert!(out.ends_with("a…\x1b[m".as_bytes()));
    out.clear();
    line(&mut out, HostSize { cols: 2, ..size() }, 1, "a界", false);
    assert!(out.ends_with("a…\x1b[m".as_bytes()));
}

#[test]
fn machine_resolution_prefers_exact_id_and_refuses_ambiguous_names() {
    let mut a = machine("a");
    let mut b = machine("b");
    a.name = "shared".into();
    b.name = "shared".into();
    let workspace = Workspace {
        machines: vec![a, b],
        ..Workspace::default()
    };
    assert_eq!(workspace.resolve_machine("a").unwrap(), "a");
    assert!(workspace.resolve_machine("shared").is_err());
    assert!(workspace.resolve_machine("missing").is_err());
}

#[test]
fn machines_keep_states_and_help_visible_with_long_names_and_small_hosts() {
    for (cols, rows) in [(48, 18), (80, 24), (36, 10)] {
        let size = HostSize {
            cols,
            rows,
            cell: None,
        };
        let mut a = machine("a");
        a.name = "Work laptop".into();
        let mut b = machine("b");
        b.name = "A very long machine name that should stay on its own row 界".into();
        b.status = devices::Status::Offline;
        let mut connected = tab(7);
        connected.machine = "a".into();
        let mut workspace = Workspace {
            tabs: vec![connected],
            machines: vec![a, b],
            machine_selection: Some("a".into()),
            list_live: true,
            list_status: "Live".into(),
            ..Workspace::default()
        };
        let mut paint = Vec::new();
        workspace
            .frame(size, 0.0, false, &mut Chrome::default(), &mut paint)
            .unwrap();
        let screen = crate::ui::tests::screen(size, &paint);
        assert!(
            screen
                .iter()
                .any(|row| row.contains("Online") && row.contains("Work laptop"))
        );
        assert!(screen.iter().any(|row| row.contains("Offline")));
        assert!(screen.last().unwrap().contains("? help"));
        if cols >= 72 {
            assert!(screen.iter().any(|row| row.contains("SESSION")));
            assert!(
                screen
                    .iter()
                    .any(|row| row.contains("Tab 1") && row.contains("Ready"))
            );
        }
        crate::ui::tests::preview(&format!("machines-{cols}"), &paint);
    }
}

#[test]
fn empty_accounts_explain_how_to_add_a_machine() {
    let size = HostSize {
        cols: 80,
        rows: 24,
        cell: None,
    };
    let mut workspace = Workspace {
        list_live: true,
        ..Workspace::default()
    };
    let mut frame = Vec::new();
    workspace
        .frame(size, 0.0, false, &mut Chrome::default(), &mut frame)
        .unwrap();
    let screen = crate::ui::tests::screen(size, &frame).join("\n");
    assert!(screen.contains("No machines linked yet"));
    assert!(screen.contains("link command"));
    crate::ui::tests::preview("machines-empty", &frame);
}

#[test]
fn shortcut_guide_preserves_viewport_ownership_and_returns_to_the_same_session() {
    let mut active = tab(7);
    let (sender, mut receiver) = driver::Commands::channel();
    active.commands = Some(sender);
    let mut workspace = Workspace {
        tabs: vec![active],
        selected: Some(7),
        ..Workspace::default()
    };
    workspace.show_help(0.0);
    assert_eq!(workspace.selected, Some(7));
    assert_eq!(workspace.dialog.as_ref().unwrap().previous, Some(7));
    assert!(receiver.try_recv().is_err());
    assert_eq!(
        ui_output(
            &mut workspace,
            7,
            merkur_wire::terminal_ui::TerminalUi::Clipboard {
                selection: b'c',
                text: zeroize::Zeroizing::new("covered session clipboard".into()),
            },
        ),
        MessageEffect::Quiet
    );
    workspace.close_dialog(1.0).unwrap();
    assert_eq!(workspace.selected, Some(7));
    assert!(receiver.try_recv().is_err());
    assert!(workspace.tabs[0].commands.is_some());
}
#[test]
fn an_observing_tab_offers_fit_and_fit_takes_the_geometry() {
    let mut active = tab(7);
    let (sender, mut receiver) = driver::Commands::channel();
    active.commands = Some(sender);
    let mut workspace = Workspace {
        tabs: vec![active],
        selected: Some(7),
        ..Workspace::default()
    };
    let state = |workspace: &mut Workspace, status| {
        workspace
            .message(0.0, Message::Output(7, Output::GeometryState(status)))
            .unwrap()
    };
    assert!(!workspace.footer(size(), false).contains("fit"));
    assert_eq!(
        state(&mut workspace, GeometryStatus::Observer),
        MessageEffect::Changed
    );
    assert!(workspace.footer(size(), false).contains("Ctrl-\\ f fit"));
    // An observer asks for the canonical screen it now crops.
    assert!(matches!(
        receiver.try_recv().unwrap().into_parts().0,
        Command::SnapshotRequest
    ));
    workspace.fit();
    assert!(matches!(
        receiver.try_recv().unwrap().into_parts().0,
        Command::TakeGeometry
    ));
    assert!(receiver.try_recv().is_err());
    assert_eq!(
        state(&mut workspace, GeometryStatus::Owner),
        MessageEffect::Changed
    );
    assert!(!workspace.footer(size(), false).contains("fit"));
    assert!(workspace.footer(size(), true).contains("f fit"));
}
#[test]
fn a_closed_dialogs_completion_cannot_replace_the_next_dialog() {
    let mut workspace = Workspace {
        dialog: Some(Dialog::link(None)),
        ..Workspace::default()
    };
    workspace.dialog.as_mut().unwrap().pending(2);
    assert_eq!(
        workspace
            .message(0.0, Message::Management(1, Ok(Outcome::Done)))
            .unwrap(),
        MessageEffect::Quiet
    );
    assert_eq!(
        workspace
            .message(0.0, Message::Management(2, Ok(Outcome::Done)))
            .unwrap(),
        MessageEffect::Changed
    );
}

#[test]
fn reconnect_replaces_the_ended_tab_and_fences_its_queued_output() {
    let mut old = tab(7);
    old.machine = "a".into();
    let mut workspace = Workspace {
        tabs: vec![tab(1), old, tab(3)],
        selected: Some(7),
        ..Workspace::default()
    };
    let mut replacement = tab(8);
    replacement.machine = "a".into();
    let (sender, mut receiver) = driver::Commands::channel();
    replacement.commands = Some(sender);
    workspace.publish_tab(10.0, replacement).unwrap();
    assert_eq!(
        workspace.tabs.iter().map(|tab| tab.id).collect::<Vec<_>>(),
        [1, 8, 3]
    );
    assert_eq!(workspace.selected, Some(8));
    assert!(receiver.try_recv().is_ok()); // The new session acquires focus.
    assert_eq!(
        workspace.message(11.0, Message::Ended(7, false)).unwrap(),
        MessageEffect::Quiet,
    );
    assert!(workspace.tabs[1].commands.is_some());
    assert_eq!(workspace.tabs[1].status, "Ready");
}

#[test]
fn a_dead_transport_does_not_prevent_leaving_its_tab() {
    let (sender, receiver) = driver::Commands::channel();
    drop(receiver);
    let mut ended = tab(1);
    ended.commands = Some(sender);
    let mut workspace = Workspace {
        tabs: vec![ended],
        selected: Some(1),
        ..Workspace::default()
    };
    workspace.select(0.0, None).unwrap();
    workspace.select(1.0, Some(1)).unwrap();
    workspace.close(2.0).unwrap();
    assert!(workspace.tabs.is_empty());
}

#[test]
fn a_driver_refusing_a_command_closes_only_its_tab_before_ended_arrives() {
    let (closed, receiver) = driver::Commands::channel();
    drop(receiver);
    let (live, mut receiver) = driver::Commands::channel();
    let mut ended = tab(1);
    ended.commands = Some(closed);
    let mut sibling = tab(2);
    sibling.commands = Some(live);
    let mut workspace = Workspace {
        tabs: vec![ended, sibling],
        selected: Some(1),
        ..Workspace::default()
    };
    workspace.tabs[0].send(Command::SnapshotRequest);
    assert!(workspace.tabs[0].commands.is_none());
    assert_eq!(workspace.tabs[0].status, "Closed");
    workspace
        .message(
            0.0,
            Message::Output(
                1,
                Output::GeometryState(merkur_client::session::geometry::GeometryStatus::Owner),
            ),
        )
        .unwrap();
    assert!(workspace.tabs[0].view.poll_command(0.0).is_none());
    workspace.tabs[0]
        .view
        .resize(0.0, HostSize { cols: 8, ..size() });
    assert_eq!(workspace.tabs[0].view.viewer().grid().terminal().cols(), 12);
    assert_eq!(workspace.tabs[0].status, "Closed");
    workspace.select(0.0, Some(2)).unwrap();
    assert!(matches!(
        receiver.try_recv().unwrap().into_parts().0,
        Command::Focused(true)
    ));
    workspace.flush(1.0);
    workspace.message(2.0, Message::Ended(1, false)).unwrap();
    assert_eq!(workspace.selected, Some(2));
    assert!(workspace.tabs[1].commands.is_some());
}

#[test]
fn a_panicking_reactor_reports_retirement_and_closes_its_tab() {
    let (sender, mut receiver) = mpsc::unbounded_channel();
    assert!(
        thread::spawn(move || {
            let _lifetime = DriverLifetime(1, sender);
            panic!("reactor fixture");
        })
        .join()
        .is_err()
    );
    let mut workspace = Workspace {
        tabs: vec![tab(1)],
        selected: Some(1),
        ..Workspace::default()
    };
    assert!(
        workspace
            .message(0.0, receiver.try_recv().unwrap())
            .is_err()
    );
    assert_eq!(workspace.tabs[0].status, "Transport failed");
    assert!(workspace.tabs[0].commands.is_none());
}

#[test]
fn url_requests_stay_in_their_tab_and_never_open_a_dialog_from_output() {
    let mut workspace = Workspace {
        tabs: vec![tab(1), tab(2)],
        selected: Some(1),
        ..Workspace::default()
    };
    let (sender, mut receipts) = driver::Commands::channel();
    workspace.tabs[1].commands = Some(sender);
    let id = merkur_wire::protocol::OpenUrlId { epoch: 3, seq: 7 };
    for _ in 0..2 {
        assert_eq!(
            workspace
                .message(
                    1.0,
                    Message::Output(
                        2,
                        Output::OpenUrl {
                            id,
                            url: "https://example.com/a;b".into(),
                        }
                    )
                )
                .unwrap(),
            MessageEffect::Quiet
        );
        assert!(
            matches!(receipts.try_recv().map(|delivery| delivery.into_parts().0), Ok(Command::OpenUrlAcknowledged(got)) if got == id)
        );
    }
    assert!(workspace.dialog.is_none());
    assert_eq!(workspace.selected, Some(1));
    assert_eq!(workspace.tabs[1].urls.len(), 1);
    workspace.select(2.0, Some(2)).unwrap();
    workspace.review_url(3.0).unwrap();
    assert!(workspace.dialog.is_some());
    assert_eq!(workspace.selected, None);
    workspace.dismiss_url(4.0, 2, id).unwrap();
    assert_eq!(workspace.selected, Some(2));
    assert_eq!(workspace.tabs[1].urls.len(), 0);
}

fn live_workspace() -> (Workspace, Vec<driver::CommandReceiver>) {
    let mut tabs = vec![tab(1), tab(2)];
    let mut receivers = Vec::new();
    for tab in &mut tabs {
        let (sender, receiver) = driver::Commands::channel();
        tab.commands = Some(sender);
        receivers.push(receiver);
    }
    (
        Workspace {
            tabs,
            selected: Some(1),
            focused: true,
            ..Workspace::default()
        },
        receivers,
    )
}

fn ui_output(
    workspace: &mut Workspace,
    id: u64,
    effect: merkur_wire::terminal_ui::TerminalUi,
) -> MessageEffect {
    workspace
        .message(0.0, Message::Output(id, Output::TerminalUi(effect)))
        .unwrap()
}

#[test]
fn background_titles_are_cached_and_only_the_live_selected_tab_changes_the_host_title() {
    use merkur_wire::terminal_ui::TerminalUi;
    let (mut workspace, _receivers) = live_workspace();
    assert_eq!(
        ui_output(&mut workspace, 1, TerminalUi::Title("foreground".into())),
        MessageEffect::Changed
    );
    let mut paint = Vec::new();
    workspace
        .frame(size(), 0.0, false, &mut Chrome::default(), &mut paint)
        .unwrap();
    assert!(
        paint
            .windows(b"\x1b]2;foreground\x1b\\".len())
            .any(|b| b == b"\x1b]2;foreground\x1b\\")
    );
    assert_eq!(
        ui_output(&mut workspace, 2, TerminalUi::Title("background".into())),
        MessageEffect::Quiet
    );
    assert_eq!(workspace.tabs[1].view.title(), "background");
    paint.clear();
    workspace
        .frame(size(), 20.0, false, &mut Chrome::default(), &mut paint)
        .unwrap();
    assert!(!paint.windows(b"\x1b]2;".len()).any(|b| b == b"\x1b]2;"));
    workspace.select(30.0, Some(2)).unwrap();
    paint.clear();
    workspace
        .frame(size(), 40.0, false, &mut Chrome::default(), &mut paint)
        .unwrap();
    assert!(
        paint
            .windows(b"\x1b]2;background\x1b\\".len())
            .any(|b| b == b"\x1b]2;background\x1b\\")
    );
    workspace.dialog = Some(Dialog::link(Some(2)));
    paint.clear();
    workspace
        .frame(size(), 60.0, false, &mut Chrome::default(), &mut paint)
        .unwrap();
    assert!(
        paint
            .windows(b"\x1b]2;merkur\x1b\\".len())
            .any(|b| b == b"\x1b]2;merkur\x1b\\")
    );
    workspace.dialog = None;
    workspace.tabs[1].commands = None;
    paint.clear();
    workspace
        .frame(size(), 80.0, false, &mut Chrome::default(), &mut paint)
        .unwrap();
    assert!(
        !paint
            .windows(b"background".len())
            .any(|b| b == b"background")
    );
}

#[test]
fn clipboard_authority_is_rechecked_at_commit_after_focus_tab_dialog_or_driver_changes() {
    use merkur_wire::terminal_ui::TerminalUi;
    for revoke in 0..4 {
        let (mut workspace, mut receivers) = live_workspace();
        let clipboard = || TerminalUi::Clipboard {
            selection: b'c',
            text: zeroize::Zeroizing::new("private clipboard".into()),
        };
        assert_eq!(
            ui_output(&mut workspace, 2, clipboard()),
            MessageEffect::Quiet
        );
        assert_eq!(
            ui_output(&mut workspace, 1, clipboard()),
            MessageEffect::Changed
        );
        match revoke {
            0 => workspace.focused = false,
            1 => workspace.select(1.0, Some(2)).unwrap(),
            2 => workspace.dialog = Some(Dialog::link(Some(1))),
            3 => {
                drop(receivers.remove(0));
            }
            _ => unreachable!(),
        }
        let mut paint = Vec::new();
        workspace
            .frame(size(), 20.0, false, &mut Chrome::default(), &mut paint)
            .unwrap();
        assert!(
            !paint.windows(b"\x1b]52;".len()).any(|b| b == b"\x1b]52;"),
            "revocation {revoke}"
        );
        assert!(
            !paint
                .windows(b"private clipboard".len())
                .any(|b| b == b"private clipboard")
        );
        assert_eq!(
            ui_output(&mut workspace, 1, clipboard()),
            MessageEffect::Quiet
        );
    }
}

#[test]
fn a_live_foreground_clipboard_is_emitted_once_as_base64_and_debug_never_names_its_text() {
    use merkur_wire::terminal_ui::TerminalUi;
    let (mut workspace, _receivers) = live_workspace();
    let effect = TerminalUi::Clipboard {
        selection: b'c',
        text: zeroize::Zeroizing::new("private clipboard".into()),
    };
    assert!(!format!("{effect:?}").contains("private clipboard"));
    assert_eq!(ui_output(&mut workspace, 1, effect), MessageEffect::Changed);
    let mut paint = Vec::new();
    workspace
        .frame(size(), 0.0, false, &mut Chrome::default(), &mut paint)
        .unwrap();
    let encoded = b"\x1b]52;c;cHJpdmF0ZSBjbGlwYm9hcmQ=\x1b\\";
    assert!(paint.windows(encoded.len()).any(|b| b == encoded));
    assert!(
        !paint
            .windows(b"private clipboard".len())
            .any(|b| b == b"private clipboard")
    );
    paint.clear();
    workspace
        .frame(size(), 20.0, false, &mut Chrome::default(), &mut paint)
        .unwrap();
    assert!(!paint.windows(b"\x1b]52;".len()).any(|b| b == b"\x1b]52;"));
}
