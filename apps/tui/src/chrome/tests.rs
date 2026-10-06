use super::*;
use crate::ui::{self, Style, tests::screen};

const SIZE: HostSize = HostSize {
    cols: 80,
    rows: 24,
    cell: None,
};

/// A screen like the sign-in card: a title, a field and a hint, cleared first.
fn card(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(ui::BEGIN);
    ui::paint(out, SIZE, (8, 10), 40, "MERKUR", Style::Accent);
    ui::paint(
        out,
        SIZE,
        (10, 10),
        40,
        "Your terminal, from anywhere.",
        Style::Body,
    );
    ui::paint(out, SIZE, (12, 10), 40, "Username", Style::Heading);
    ui::paint(out, SIZE, (13, 10), 40, value, Style::Body);
    ui::paint(out, SIZE, (24, 1), 80, " Enter continue", Style::Bar);
    out.extend_from_slice(format!("\x1b[13;{}H\x1b[6 q\x1b[?25h", 10 + value.len()).as_bytes());
    out.extend_from_slice(ui::END);
}

/// What a host shows when it applies `bytes` without holding synchronized
/// updates, as tmux does when it redraws a popup between pty reads.
fn unsynchronized(bytes: &[u8]) -> Vec<String> {
    let begin = b"\x1b[?2026h";
    let mut plain = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at..].starts_with(begin) {
            at += begin.len();
        } else {
            plain.push(bytes[at]);
            at += 1;
        }
    }
    screen(SIZE, &plain)
}

fn titled(rows: &[String]) -> bool {
    rows.iter().any(|row| row.contains("MERKUR"))
}

#[test]
fn a_keystroke_never_clears_and_no_partial_delivery_loses_the_screen() {
    let mut chrome = Chrome::default();
    let mut first = Vec::new();
    chrome.present(SIZE, |screen| card(screen, "ad"), &mut first);
    let mut keystroke = Vec::new();
    chrome.present(SIZE, |screen| card(screen, "ada"), &mut keystroke);

    assert!(!keystroke.windows(4).any(|bytes| bytes == b"\x1b[2J"));
    assert!(keystroke.len() < 64, "{} bytes", keystroke.len());
    let mut expected = Vec::new();
    card(&mut expected, "ada");
    let mut host = first.clone();
    host.extend_from_slice(&keystroke);
    assert_eq!(screen(SIZE, &host), screen(SIZE, &expected));
    for end in 0..=keystroke.len() {
        let mut partial = first.clone();
        partial.extend_from_slice(&keystroke[..end]);
        assert!(titled(&unsynchronized(&partial)), "blank after {end} bytes");
    }

    // The same keystroke written directly, as before: cleared, then repainted.
    let mut direct = Vec::new();
    card(&mut direct, "ad");
    let shown = direct.len();
    card(&mut direct, "ada");
    assert!((shown..direct.len()).any(|end| !titled(&unsynchronized(&direct[..end]))));
}

#[test]
fn an_unchanged_screen_writes_only_its_fence() {
    let mut chrome = Chrome::default();
    let mut out = Vec::new();
    chrome.present(SIZE, |screen| card(screen, "ada"), &mut out);
    out.clear();
    chrome.present(SIZE, |screen| card(screen, "ada"), &mut out);
    assert_eq!(out, b"\x1b[?2026l\x1b[5n");
}

#[test]
fn after_something_else_drew_the_next_frame_repaints_every_cell_and_releases_the_pointer() {
    let mut chrome = Chrome::default();
    let mut host = Vec::new();
    chrome.present(SIZE, |screen| card(screen, "ada"), &mut host);
    // A remote session paints over the whole screen and enables the pointer.
    host.extend_from_slice(b"\x1b[?1000h");
    for row in 1..=SIZE.rows {
        host.extend_from_slice(format!("\x1b[{row};1H{}", "x".repeat(80)).as_bytes());
    }
    chrome.invalidate();
    let start = host.len();
    chrome.present(SIZE, |screen| card(screen, "ada"), &mut host);
    assert!(host[start..].starts_with(POINTER_OFF));
    let mut expected = Vec::new();
    card(&mut expected, "ada");
    assert_eq!(screen(SIZE, &host), screen(SIZE, &expected));
}

#[test]
fn a_resized_host_is_repainted_whole() {
    let mut chrome = Chrome::default();
    let mut out = Vec::new();
    chrome.present(SIZE, |screen| card(screen, "ada"), &mut out);
    let small = HostSize {
        cols: 60,
        rows: 20,
        ..SIZE
    };
    out.clear();
    chrome.present(small, |screen| card(screen, "ada"), &mut out);
    let rows = screen(small, &out);
    assert!(titled(&rows));
    assert!(rows.iter().any(|row| row.contains("Username")));
}
