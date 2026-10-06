use super::*;
use merkur_wire::terminal_ui::TerminalUi;

fn terminal() -> TerminalState {
    let (tx, _) = crossbeam_channel::unbounded();
    TerminalState::new(20, 4, tx)
}

#[test]
fn canonical_title_stack_reset_and_copy_are_typed_not_ansi() {
    let mut terminal = terminal();
    for part in [&b"\x1b]2;n"[..], b"vim\x1b", b"\\"] {
        terminal.apply_bytes(part);
    }
    assert_eq!(
        terminal.terminal_ui().title,
        TerminalUi::Title("nvim".into())
    );
    terminal.apply_bytes(b"\x1b[22;0t\x1b]2;child\x07\x1b[23;0t");
    assert_eq!(
        terminal.terminal_ui().title,
        TerminalUi::Title("nvim".into())
    );
    terminal.apply_bytes(b"\x1b]52;c;c2VjcmV0Cg==\x1b\\");
    let ui = terminal.terminal_ui();
    assert!(
        matches!(ui.after(0).next(), Some((1, TerminalUi::Clipboard { selection: b'c', text })) if text.as_str() == "secret\n")
    );
    // Clipboard reads and malformed UTF-8/base64 never touch a client clipboard.
    terminal.apply_bytes(b"\x1b]52;c;?\x07\x1b]52;c;!invalid\x07\x1b]52;c;/w==\x07");
    assert_eq!(terminal.terminal_ui().after(0).count(), 1);
}

#[test]
fn canonical_notifications_preserve_semicolons_and_reject_conemu_and_cancellation() {
    let mut terminal = terminal();
    terminal.apply_bytes(b"\x1b]9;done;a;b\x07\x1b]777;notify;title;a;b\x1b\\");
    let effects: Vec<_> = terminal
        .terminal_ui()
        .after(0)
        .map(|(_, effect)| effect.clone())
        .collect();
    assert_eq!(
        effects,
        [
            TerminalUi::Notification {
                title: "".into(),
                body: "done;a;b".into()
            },
            TerminalUi::Notification {
                title: "title".into(),
                body: "a;b".into()
            }
        ]
    );
    terminal.apply_bytes(
        b"\x1b]9;7;rm -rf /\x07\x1b]777;other;title;body\x07\x1b]9;cancelled\x18\x1b\\",
    );
    assert_eq!(terminal.terminal_ui().after(0).count(), 2);
}

#[test]
fn title_and_notification_buffers_do_not_cross_synchronized_application_boundaries() {
    let mut terminal = terminal();
    terminal.apply_bytes(b"\x1b[?2026h\x1b]2;held\x07\x1b]777;notify;t;b\x07");
    assert_eq!(terminal.terminal_ui().title_revision, 1);
    assert_eq!(terminal.terminal_ui().newest, 0);
    terminal.apply_bytes(b"\x1b[?2026l");
    assert_eq!(
        terminal.terminal_ui().title,
        TerminalUi::Title("held".into())
    );
    assert_eq!(terminal.terminal_ui().newest, 1);
}

#[test]
fn notification_body_survives_the_canonical_parameter_array_bound() {
    let mut terminal = terminal();
    let body = (0..40).map(|i| i.to_string()).collect::<Vec<_>>().join(";");
    terminal.apply_bytes(format!("\x1b]777;notify;title;{body}\x07").as_bytes());
    assert_eq!(
        terminal
            .terminal_ui()
            .after(0)
            .next()
            .map(|(_, effect)| effect),
        Some(&TerminalUi::Notification {
            title: "title".into(),
            body
        })
    );
}

#[test]
fn an_escape_is_not_a_notification_terminator_until_its_final_backslash() {
    let mut terminal = terminal();
    terminal.apply_bytes(b"\x1b]9;cancelled\x1b");
    assert_eq!(terminal.terminal_ui().newest, 0);
    terminal.apply_bytes(b"[31m");
    assert_eq!(terminal.terminal_ui().newest, 0);
    terminal.apply_bytes(b"\x1b]9;complete\x1b");
    assert_eq!(terminal.terminal_ui().newest, 0);
    terminal.apply_bytes(b"\\");
    assert_eq!(terminal.terminal_ui().newest, 1);
}

#[test]
fn canonical_ris_restores_the_client_title() {
    let mut terminal = terminal();
    terminal.apply_bytes(b"\x1b]2;old title\x07");
    terminal.apply_bytes(b"\x1bc");
    assert_eq!(terminal.terminal_ui().title, TerminalUi::Title(String::new()));
    assert_eq!(terminal.terminal_ui().title_revision, 3);
}
