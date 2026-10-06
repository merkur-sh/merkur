//! Local chrome paints Quicksilver's tokens or the host's defaults, never the
//! remote terminal's pen. `NO_COLOR` keeps the host palette and attributes.
use crate::host::HostSize;
use std::{io::Write, sync::OnceLock};
use unicode_width::UnicodeWidthChar;

pub(crate) const BEGIN: &[u8] =
    b"\x1b[?2026h\x1b[m\x1b[2J\x1b[?25l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
pub(crate) const END: &[u8] = b"\x1b[?2026l\x1b[5n";

#[derive(Clone, Copy)]
pub(crate) enum Style {
    Body,
    Heading,
    Accent,
    Meta,
    Line,
    Selected,
    Bar,
}

/// Colours the `●` a machine row painted at `position` by its state, as the
/// web list marks it: ok, warn, or faint. The cursor row keeps its tint.
pub(crate) fn state(
    out: &mut Vec<u8>,
    size: HostSize,
    position: (u16, u16),
    state: &str,
    selected: bool,
) {
    let (row, col) = position;
    if !color() || row == 0 || row > size.rows || col == 0 || col > size.cols {
        return;
    }
    write!(out, "\x1b[{row};{col}H\x1b[m").expect("Vec write");
    if selected {
        out.extend_from_slice(b"\x1b[48;2;40;35;62m");
    }
    out.extend_from_slice(match state {
        "Online" => b"\x1b[38;2;63;202;127m",
        "Degraded" => b"\x1b[38;2;224;164;79m",
        _ => b"\x1b[38;2;104;104;113m",
    });
    out.extend_from_slice("●\x1b[m".as_bytes());
}

#[derive(Clone, Copy)]
pub(crate) enum OrbSize {
    Large,
    Small,
}

fn color() -> bool {
    static COLOR: OnceLock<bool> = OnceLock::new();
    *COLOR.get_or_init(|| {
        std::env::var_os("NO_COLOR").is_none_or(|value| value.is_empty())
            && std::env::var_os("TERM").is_none_or(|value| value != "dumb")
    })
}

// Visual cadence: 48 compiled samples make one four-second cycle at twelve fps.
const ORB_FRAME_MS: f64 = 1_000.0 / 12.0;

pub(crate) struct OrbAnimation {
    focused: bool,
    visible: bool,
    started: Option<f64>,
    elapsed: f64,
    painted: Option<u64>,
}
impl Default for OrbAnimation {
    fn default() -> Self {
        Self {
            focused: true,
            visible: false,
            started: None,
            elapsed: 0.0,
            painted: None,
        }
    }
}
impl OrbAnimation {
    pub(crate) fn focused(&self) -> bool {
        self.focused
    }
    pub(crate) fn set_focused(&mut self, at: f64, focused: bool) {
        self.focused = focused;
        self.settle(at);
    }
    pub(crate) fn set_visible(&mut self, at: f64, visible: bool) {
        self.visible = visible;
        self.settle(at);
    }
    fn settle(&mut self, at: f64) {
        if self.focused && self.visible {
            if self.started.is_none() {
                self.started = Some(at);
            }
        } else if let Some(started) = self.started.take() {
            self.elapsed += at - started;
        }
    }
    fn elapsed(&self, at: f64) -> f64 {
        self.elapsed + self.started.map_or(0.0, |started| at - started)
    }
    fn step(&self, at: f64) -> u64 {
        (self.elapsed(at) / ORB_FRAME_MS).floor() as u64
    }
    pub(crate) fn frame(&self, at: f64) -> usize {
        (self.step(at) % crate::orb::FRAME_COUNT as u64) as usize
    }
    pub(crate) fn due(&self, at: f64) -> bool {
        self.started.is_some() && self.painted != Some(self.step(at))
    }
    pub(crate) fn next_frame(&self, at: f64, writable: bool) -> Option<f64> {
        if self.started.is_none() || !writable {
            return None;
        }
        Some(if self.due(at) {
            at
        } else {
            at + (self.step(at) + 1) as f64 * ORB_FRAME_MS - self.elapsed(at)
        })
    }
    pub(crate) fn painted(&mut self, at: f64) {
        self.painted = Some(self.step(at));
    }
    pub(crate) fn patch(
        &self,
        out: &mut Vec<u8>,
        size: HostSize,
        placement: ((u16, u16), OrbSize),
        at: f64,
    ) {
        // Keep the password cursor and host pen exactly where the last full frame left them.
        out.extend_from_slice(b"\x1b[?2026h\x1b7");
        orb(
            out,
            size,
            placement.0,
            placement.1,
            self.frame(at),
            self.painted
                .map(|step| (step % crate::orb::FRAME_COUNT as u64) as usize),
        );
        out.extend_from_slice(b"\x1b8");
        out.extend_from_slice(END);
    }
}

/// Compiled shader samples. Only changed rows are emitted for an animation frame.
pub(crate) fn orb(
    out: &mut Vec<u8>,
    size: HostSize,
    position: (u16, u16),
    art: OrbSize,
    frame: usize,
    previous: Option<usize>,
) {
    use crate::orb;
    let frame = frame % orb::FRAME_COUNT;
    let previous = previous.map(|frame| frame % orb::FRAME_COUNT);
    let (width, height, colored, monochrome): (_, _, &[&str], &[&str]) = match art {
        OrbSize::Large => (
            orb::LARGE_WIDTH,
            orb::LARGE_HEIGHT,
            &orb::LARGE_COLORED[frame],
            &orb::LARGE_MONOCHROME[frame],
        ),
        OrbSize::Small => (
            orb::SMALL_WIDTH,
            orb::SMALL_HEIGHT,
            &orb::SMALL_COLORED[frame],
            &orb::SMALL_MONOCHROME[frame],
        ),
    };
    let (row, col) = position;
    if row == 0
        || col == 0
        || row.saturating_add(height - 1) > size.rows
        || col.saturating_add(width - 1) > size.cols
    {
        return;
    }
    let rows = if color() { colored } else { monochrome };
    let old: Option<&[&str]> = previous.map(|frame| match art {
        OrbSize::Large if color() => &orb::LARGE_COLORED[frame][..],
        OrbSize::Large => &orb::LARGE_MONOCHROME[frame][..],
        OrbSize::Small if color() => &orb::SMALL_COLORED[frame][..],
        OrbSize::Small => &orb::SMALL_MONOCHROME[frame][..],
    });
    for (index, text) in rows.iter().enumerate() {
        if old.is_some_and(|rows| rows[index] == *text) {
            continue;
        }
        write!(out, "\x1b[{};{col}H\x1b[m", row + index as u16).expect("Vec write");
        out.extend_from_slice(text.as_bytes());
        out.extend_from_slice(b"\x1b[m");
    }
}

pub(crate) fn columns(text: &str) -> usize {
    text.chars().filter_map(UnicodeWidthChar::width).sum()
}

pub(crate) fn clip(text: &str, width: u16) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    if columns(&clean) <= usize::from(width) {
        return clean;
    }
    if width == 0 {
        return String::new();
    }
    let mut result = String::new();
    let mut used = 0;
    for c in clean.chars() {
        let next = c.width().unwrap_or(0);
        if used + next > usize::from(width - 1) {
            break;
        }
        used += next;
        result.push(c);
    }
    result.push('…');
    result
}

pub(crate) fn paint(
    out: &mut Vec<u8>,
    size: HostSize,
    position: (u16, u16),
    width: u16,
    text: &str,
    style: Style,
) {
    let (row, col) = position;
    if row == 0 || row > size.rows || col == 0 || col > size.cols {
        return;
    }
    let width = width.min(size.cols - col + 1);
    let text = clip(text, width);
    out.extend_from_slice(format!("\x1b[{row};{col}H\x1b[m").as_bytes());
    if col == 1 {
        out.extend_from_slice(b"\x1b[2K");
    }
    out.extend_from_slice(match style {
        Style::Body => b"",
        Style::Heading => b"\x1b[1m",
        // Quicksilver accentlt: small marks on a dark ground.
        Style::Accent if color() => b"\x1b[1;38;2;183;162;255m",
        Style::Accent => b"\x1b[1m",
        // meta: captions and secondary lines.
        Style::Meta if color() => b"\x1b[38;2;152;153;161m",
        Style::Meta => b"",
        // faint: rules and frames, which carry no information.
        Style::Line if color() => b"\x1b[38;2;104;104;113m",
        Style::Line => b"",
        // ink on accentsoft over a panel: the cursor row, as the web list.
        Style::Selected if color() => b"\x1b[1;38;2;248;248;252;48;2;40;35;62m",
        Style::Selected => b"\x1b[1;7m",
        // body on sunken: the hint bar.
        Style::Bar if color() => b"\x1b[38;2;185;185;192;48;2;18;18;23m",
        Style::Bar => b"\x1b[7m",
    });
    out.extend_from_slice(text.as_bytes());
    if matches!(style, Style::Selected | Style::Bar) {
        out.extend(std::iter::repeat_n(
            b' ',
            usize::from(width) - columns(&text),
        ));
    }
    out.extend_from_slice(b"\x1b[m");
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn screen(size: HostSize, bytes: &[u8]) -> Vec<String> {
        use alacritty_terminal::{
            event::VoidListener,
            index::{Column, Line, Point},
            term::{Config, Term, test::TermSize},
            vte::ansi::Processor,
        };
        let mut host = Term::new(
            Config::default(),
            &TermSize::new(usize::from(size.cols), usize::from(size.rows)),
            VoidListener,
        );
        let mut parser: Processor = Processor::new();
        parser.advance(&mut host, bytes);
        (0..size.rows)
            .map(|row| {
                (0..size.cols)
                    .map(|col| {
                        host.grid()[Point::new(Line(i32::from(row)), Column(usize::from(col)))].c
                    })
                    .collect()
            })
            .collect()
    }

    pub(crate) fn preview(name: &str, frame: &[u8]) {
        if let Some(directory) = std::env::var_os("MERKUR_CLI_PREVIEW_DIR") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                std::path::PathBuf::from(directory).join(format!("{name}.ansi")),
                frame,
            )
            .unwrap();
        }
    }

    #[test]
    fn orb_art_respects_its_rectangle_and_restores_the_host_pen() {
        let size = HostSize {
            cols: 40,
            rows: 16,
            cell: None,
        };
        let mut out = Vec::new();
        orb(&mut out, size, (1, 20), OrbSize::Large, 0, None);
        assert!(
            out.is_empty(),
            "art never clips into a neighboring component"
        );
        orb(&mut out, size, (2, 3), OrbSize::Large, 0, None);
        let screen = screen(size, &out);
        assert!(screen[0].trim().is_empty());
        assert!(screen[13..].iter().all(|row| row.trim().is_empty()));
        assert!(screen.iter().all(|row| row[..2].trim().is_empty()));
        assert!(out.ends_with(b"\x1b[m"));
        for rows in [
            &crate::orb::LARGE_MONOCHROME[0][..],
            &crate::orb::SMALL_MONOCHROME[0][..],
        ] {
            assert!(rows.iter().all(|row| !row.contains('\x1b')));
        }
        assert!(
            crate::orb::LARGE_MONOCHROME[0]
                .iter()
                .all(|row| columns(row) == 22)
        );
        assert!(
            crate::orb::SMALL_MONOCHROME[0]
                .iter()
                .all(|row| columns(row) == 12)
        );
        preview("orb", &out);
    }

    #[test]
    fn animation_pauses_without_focus_visibility_or_host_credit_and_coalesces_late_frames() {
        let mut orb = OrbAnimation::default();
        assert_eq!(orb.next_frame(0.0, true), None);
        orb.set_visible(0.0, true);
        assert_eq!(orb.next_frame(0.0, true), Some(0.0));
        orb.painted(0.0);
        assert_eq!(orb.next_frame(1.0, false), None);
        assert_eq!(orb.next_frame(1.0, true), Some(ORB_FRAME_MS));
        assert_eq!(orb.frame(1_001.0), 12);
        orb.painted(1_001.0);
        assert!(!orb.due(1_001.0));
        orb.set_focused(1_001.0, false);
        assert_eq!(orb.next_frame(50_000.0, true), None);
        assert_eq!(orb.frame(50_000.0), 12);
        orb.set_focused(50_000.0, true);
        assert_eq!(orb.frame(50_001.0), 12);
        orb.set_visible(50_001.0, false);
        assert_eq!(orb.next_frame(100_000.0, true), None);
        orb.set_visible(100_000.0, true);
        assert_eq!(orb.frame(103_000.0), 0);
    }

    #[test]
    fn animation_deltas_match_full_frames_and_preserve_cursor_and_pen() {
        use alacritty_terminal::{
            event::VoidListener,
            index::{Column, Line, Point},
            term::{Config, Term, test::TermSize},
            vte::ansi::Processor,
        };
        let size = HostSize {
            cols: 40,
            rows: 16,
            cell: None,
        };
        for art in [OrbSize::Large, OrbSize::Small] {
            let mut host = Term::new(Config::default(), &TermSize::new(40, 16), VoidListener);
            let mut parser: Processor = Processor::new();
            let mut initial = Vec::new();
            orb(&mut initial, size, (2, 3), art, 0, None);
            initial.extend_from_slice(b"\x1b[15;1H\x1b[1;38;2;1;2;3m");
            parser.advance(&mut host, &initial);
            let mut clock = OrbAnimation::default();
            clock.set_visible(0.0, true);
            clock.painted(0.0);
            for frame in 1..=crate::orb::FRAME_COUNT {
                let at = frame as f64 * ORB_FRAME_MS + 0.001;
                let mut patch = Vec::new();
                clock.patch(&mut patch, size, ((2, 3), art), at);
                assert!(!patch.windows(4).any(|bytes| bytes == b"\x1b[2J"));
                assert_eq!(
                    patch
                        .windows(4)
                        .filter(|bytes| *bytes == b"\x1b[5n")
                        .count(),
                    1
                );
                parser.advance(&mut host, &patch);
                clock.painted(at);
                let mut expected =
                    Term::new(Config::default(), &TermSize::new(40, 16), VoidListener);
                let mut full = Vec::new();
                orb(&mut full, size, (2, 3), art, frame, None);
                full.extend_from_slice(b"\x1b[15;1H\x1b[1;38;2;1;2;3m");
                Processor::<alacritty_terminal::vte::ansi::StdSyncHandler>::new()
                    .advance(&mut expected, &full);
                assert_eq!(host.grid().cursor.point, expected.grid().cursor.point);
                assert_eq!(host.grid().cursor.template, expected.grid().cursor.template);
                for row in 0..16 {
                    for col in 0..40 {
                        let point = Point::new(Line(row), Column(col));
                        assert_eq!(
                            host.grid()[point],
                            expected.grid()[point],
                            "frame {frame}, {point:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn chrome_clips_by_columns_and_cannot_inject_host_commands() {
        assert_eq!(clip("a界z", 3), "a…");
        assert_eq!(clip("界", 1), "…");
        assert_eq!(clip("a\x1b\x07b", 2), "ab");
        assert_eq!(clip("hello", 0), "");
        assert_eq!(clip("e\u{301}", 1), "e\u{301}");
        let mut out = Vec::new();
        let size = HostSize {
            cols: 3,
            rows: 2,
            cell: None,
        };
        paint(&mut out, size, (3, 1), 3, "outside", Style::Body);
        paint(&mut out, size, (1, 4), 3, "outside", Style::Body);
        assert!(out.is_empty());
    }
}
