use super::*;
use crate::edge_tunnel::test_allocations::{begin_thread, end_thread};
use merkur_wire::terminal_ui::{TEXT_BYTES_MAX, TerminalUi};

const PUSH: &[u8] = b"\x1b[22;0t";
const POP: &[u8] = b"\x1b[23;0t";

fn terminal() -> TerminalState {
    let (tx, _rx) = crossbeam_channel::unbounded();
    TerminalState::new(80, 24, tx)
}

fn title(terminal: &mut TerminalState, text: &str) {
    let bytes = format!("\x1b]2;{text}\x1b\\");
    assert_eq!(terminal.apply_bytes(bytes.as_bytes()), bytes.len());
}

fn canonical_title(terminal: &mut TerminalState) -> Option<String> {
    let mut replay = Vec::new();
    terminal.write_replay(&mut replay).unwrap();
    let start = replay.windows(4).position(|bytes| bytes == b"\x1b]2;")? + 4;
    let end = replay[start..]
        .windows(2)
        .position(|bytes| bytes == b"\x1b\\")?;
    Some(String::from_utf8(replay[start..start + end].to_vec()).unwrap())
}

#[test]
fn oversized_title_never_enters_stack() {
    let mut observations = Vec::new();
    for pushes in [64, 4096] {
        let mut terminal = terminal();
        // Reserve stack slots with the default title, so the measured region
        // counts title payloads without Vec growth or capacity changes.
        for _ in 0..pushes {
            terminal.apply_bytes(PUSH);
        }
        for _ in 0..pushes {
            terminal.apply_bytes(POP);
        }
        let oversized = "x".repeat(TEXT_BYTES_MAX + 1);
        title(&mut terminal, &oversized);
        let retained = canonical_title(&mut terminal).map_or(0, |title| title.len());
        begin_thread();
        for _ in 0..pushes {
            terminal.apply_bytes(PUSH);
        }
        let tally = end_thread();
        println!(
            "title_storage rejected bytes={} pushes={pushes} canonical_bytes={retained} allocations={} allocated_bytes={}",
            oversized.len(),
            tally.allocations,
            tally.allocated_bytes,
        );
        observations.push((retained, tally));
    }
    for (retained, tally) in observations {
        assert_eq!(retained, 0, "rejected title remains in canonical storage");
        assert_eq!(tally.allocations, 0, "rejected title is cloned onto stack");
        assert_eq!(tally.allocated_bytes, 0);
    }
}

#[test]
fn invalid_title_preserves_current_and_stacked_unicode() {
    for invalid in [
        "x".repeat(TEXT_BYTES_MAX + 1),
        "界".repeat(TEXT_BYTES_MAX / 3 + 1),
        "unsafe\u{85}title".into(),
        "unsafe\u{9f}title".into(),
    ] {
        for command in [0, 2] {
            for terminator in ["\x07", "\x1b\\"] {
                for chunk_size in [1, usize::MAX] {
                    let mut terminal = terminal();
                    title(&mut terminal, "λ · 界;🙂");
                    let revision = terminal.terminal_ui().title_revision;
                    let bytes = format!("\x1b]{command};{invalid}{terminator}");
                    for chunk in bytes.as_bytes().chunks(chunk_size) {
                        assert_eq!(terminal.apply_bytes(chunk), chunk.len());
                    }
                    assert_eq!(terminal.terminal_ui().title_revision, revision);
                    assert_eq!(canonical_title(&mut terminal).as_deref(), Some("λ · 界;🙂"));
                    terminal.apply_bytes(PUSH);
                    title(&mut terminal, "next");
                    terminal.apply_bytes(POP);
                    assert_eq!(canonical_title(&mut terminal).as_deref(), Some("λ · 界;🙂"));
                    assert_eq!(
                        terminal.terminal_ui().title,
                        TerminalUi::Title("λ · 界;🙂".into()),
                    );
                }
            }
        }
    }
}

#[test]
fn accepted_title_storage_preserves_bytes_and_push_pop() {
    for text in [
        String::new(),
        "x".repeat(TEXT_BYTES_MAX),
        "界".repeat(TEXT_BYTES_MAX / 3) + "ab",
        "λ · 界;🙂".into(),
    ] {
        let mut terminal = terminal();
        for _ in 0..64 {
            terminal.apply_bytes(PUSH);
        }
        for _ in 0..64 {
            terminal.apply_bytes(POP);
        }
        title(&mut terminal, &text);
        assert_eq!(
            canonical_title(&mut terminal).as_deref(),
            Some(text.as_str())
        );
        let expected_frame = TerminalUi::Title(text.clone()).encode().unwrap();
        assert_eq!(
            terminal.terminal_ui().title.encode().unwrap(),
            expected_frame
        );
        begin_thread();
        for _ in 0..64 {
            terminal.apply_bytes(PUSH);
        }
        let tally = end_thread();
        println!(
            "title_storage accepted bytes={} pushes=64 allocations={} allocated_bytes={}",
            text.len(),
            tally.allocations,
            tally.allocated_bytes,
        );
        assert_eq!(tally.allocated_bytes, text.len() * 64);
        title(&mut terminal, "next");
        for _ in 0..64 {
            terminal.apply_bytes(POP);
            assert_eq!(
                canonical_title(&mut terminal).as_deref(),
                Some(text.as_str())
            );
            assert_eq!(
                terminal.terminal_ui().title.encode().unwrap(),
                expected_frame
            );
        }
        terminal.apply_bytes(POP);
        assert_eq!(
            canonical_title(&mut terminal).as_deref(),
            Some(text.as_str())
        );
    }
    let mut terminal = terminal();
    terminal.apply_bytes(PUSH);
    title(&mut terminal, "temporary");
    terminal.apply_bytes(POP);
    assert_eq!(canonical_title(&mut terminal), None);
    assert_eq!(
        terminal.terminal_ui().title,
        TerminalUi::Title(String::new())
    );
}

#[test]
fn title_storage_preserves_parser_normalization_and_owned_admission() {
    use alacritty_terminal::vte::ansi::Handler;

    for (bytes, expected) in [
        (b"\x1b]0;  \xce\xbb ;\xe7\x95\x8c  \x07".to_vec(), "λ ;界"),
        (b"\x1b]2;first;\xff;last\x1b\\".to_vec(), "first;last"),
        (
            format!(
                "\x1b]2;{}λ{}\x07",
                " ".repeat(TEXT_BYTES_MAX),
                " ".repeat(TEXT_BYTES_MAX)
            )
            .into_bytes(),
            "λ",
        ),
    ] {
        let mut terminal = terminal();
        for chunk in bytes.chunks(1) {
            terminal.apply_bytes(chunk);
        }
        assert_eq!(canonical_title(&mut terminal).as_deref(), Some(expected));
        assert_eq!(
            terminal.terminal_ui().title,
            TerminalUi::Title(expected.into())
        );
    }

    let mut terminal = terminal();
    title(&mut terminal, "λ");
    terminal
        .term
        .set_title(Some("x".repeat(TEXT_BYTES_MAX + 1).into()));
    assert_eq!(canonical_title(&mut terminal).as_deref(), Some("λ"));
    terminal.term.set_title(None);
    assert_eq!(canonical_title(&mut terminal), None);
    assert_eq!(
        terminal.terminal_ui().title,
        TerminalUi::Title(String::new())
    );
}

#[test]
fn title_storage_non_title_workloads() {
    for (name, bytes) in [
        ("typing", &b"x\x08"[..]),
        ("cursor", &b"\x1b[3;40H\x1b[H"[..]),
        ("styled", &b"\x1b[31mred\x1b[0m\r"[..]),
        ("unicode", "λ界🙂\r".as_bytes()),
        ("osc_color", &b"\x1b]4;1;#abcdef\x07"[..]),
        ("bell", &b"\x07"[..]),
    ] {
        let mut terminal = terminal();
        terminal.apply_bytes(bytes);
        begin_thread();
        for _ in 0..1000 {
            assert_eq!(terminal.apply_bytes(bytes), bytes.len());
        }
        let tally = end_thread();
        let mut replay = Vec::new();
        terminal.write_replay(&mut replay).unwrap();
        let fingerprint = replay.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3)
        });
        println!(
            "title_storage non_title={name} repeats=1000 allocations={} allocated_bytes={} replay_bytes={} fingerprint={fingerprint:016x}",
            tally.allocations,
            tally.allocated_bytes,
            replay.len(),
        );
        assert_eq!(tally.allocations, 0);
        assert_eq!(tally.allocated_bytes, 0);
        assert_eq!(canonical_title(&mut terminal), None);
    }
}
