//! The composer's frames played into a real terminal, alacritty's, which
//! must then show exactly what the viewer presents.

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor};
use term_wasm::DISPLAYED_SPACER;

use super::*;

const RED: [u8; 3] = [0xf3, 0x8b, 0xa8];
const BLUE: [u8; 3] = [0x1e, 0x1e, 0x2e];

/// A viewer's presentation, held as plain rows.
struct Screen {
    cols: u16,
    rows: Vec<Vec<DisplayedCell>>,
    cursor: Option<DisplayedCursor>,
    links: Vec<Vec<u32>>,
    uris: std::collections::BTreeMap<u32, String>,
}

impl Presented for Screen {
    fn size(&self) -> (u16, u16) {
        (self.cols, self.rows.len() as u16)
    }

    fn row(&self, row: u16, out: &mut Vec<DisplayedCell>) {
        out.clear();
        out.extend_from_slice(&self.rows[usize::from(row)]);
    }

    fn cursor(&self) -> Option<DisplayedCursor> {
        self.cursor
    }

    fn links(&self, row: u16, out: &mut Vec<u32>) {
        out.clear();
        out.extend_from_slice(&self.links[usize::from(row)]);
    }

    fn link_uri(&self, id: u32) -> Option<&str> {
        self.uris.get(&id).map(String::as_str)
    }
}

impl Screen {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            links: vec![vec![0; usize::from(cols)]; usize::from(rows)],
            uris: std::collections::BTreeMap::new(),
            rows: vec![vec![DisplayedCell::BLANK; usize::from(cols)]; usize::from(rows)],
            cursor: Some(DisplayedCursor {
                row: 0,
                col: 0,
                shape: DisplayedCursorShape::Block,
            }),
        }
    }

    /// Writes `text` at `(row, col)` in `pen`, a wide character over two cells.
    fn put(&mut self, row: usize, col: usize, text: &str, pen: DisplayedCell) {
        let mut at = col;
        for c in text.chars() {
            let wide = matches!(c, '界' | '世');
            self.rows[row][at] = DisplayedCell {
                c,
                attrs: pen.attrs | if wide { DISPLAYED_WIDE } else { 0 },
                ..pen
            };
            at += 1;
            if wide {
                self.rows[row][at] = DisplayedCell {
                    c: ' ',
                    attrs: pen.attrs | DISPLAYED_SPACER,
                    ..pen
                };
                at += 1;
            }
        }
    }
}

fn pen(fg: Option<[u8; 3]>, bg: Option<[u8; 3]>, attrs: u8) -> DisplayedCell {
    DisplayedCell {
        c: ' ',
        fg,
        bg,
        attrs,
    }
}

/// A host terminal: alacritty, fed what the composer writes.
struct Host {
    term: Term<HostEvents>,
    parser: Processor,
    events: HostEvents,
}

#[derive(Clone, Default)]
struct HostEvents(std::rc::Rc<std::cell::RefCell<[usize; 4]>>);

impl EventListener for HostEvents {
    fn send_event(&self, event: Event) {
        let index = match event {
            Event::Title(_) | Event::ResetTitle => 0,
            Event::ClipboardStore(..) | Event::ClipboardLoad(..) => 1,
            Event::Bell => 3,
            Event::MouseCursorDirty
            | Event::ColorRequest(..)
            | Event::PtyWrite(_)
            | Event::TextAreaSizeRequest(_)
            | Event::CursorBlinkingChange
            | Event::Wakeup
            | Event::Exit
            | Event::ChildExit(_) => return,
        };
        self.0.borrow_mut()[index] += 1;
    }

    fn desktop_notification(&mut self, _title: &[u8], _body: &[&[u8]]) {
        self.0.borrow_mut()[2] += 1;
    }
}

impl Host {
    fn new(cols: u16, rows: u16) -> Self {
        let events = HostEvents::default();
        Self {
            term: Term::new(
                Config::default(),
                &TermSize::new(usize::from(cols), usize::from(rows)),
                events.clone(),
            ),
            parser: Processor::new(),
            events,
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    /// What the host shows at `(row, col)`, in the viewer's terms.
    fn cell(&self, row: usize, col: usize) -> DisplayedCell {
        let cell = &self.term.grid()[Point::new(Line(row as i32), Column(col))];
        let color = |color: Color, default: NamedColor| match color {
            Color::Named(named) if named == default => None,
            Color::Spec(rgb) => Some([rgb.r, rgb.g, rgb.b]),
            other => panic!("the composer writes no {other:?}"),
        };
        let mut attrs = 0;
        for (flag, bit) in [
            (Flags::BOLD, DISPLAYED_BOLD),
            (Flags::ITALIC, DISPLAYED_ITALIC),
            (Flags::UNDERLINE, DISPLAYED_UNDERLINE),
            (Flags::INVERSE, DISPLAYED_INVERSE),
            (Flags::WIDE_CHAR, DISPLAYED_WIDE),
            (Flags::WIDE_CHAR_SPACER, DISPLAYED_SPACER),
        ] {
            if cell.flags.contains(flag) {
                attrs |= bit;
            }
        }
        DisplayedCell {
            c: cell.c,
            fg: color(cell.fg, NamedColor::Foreground),
            bg: color(cell.bg, NamedColor::Background),
            attrs,
        }
    }

    /// Asserts the host shows `screen` from host row `origin` down: every
    /// glyph, colour and attribute; a blank's foreground shows nothing.
    fn shows(&self, screen: &Screen, origin: usize) {
        for (row, cells) in screen.rows.iter().enumerate() {
            for (col, want) in cells.iter().enumerate() {
                let got = self.cell(origin + row, col);
                let visible = |cell: DisplayedCell| {
                    if cell.c == ' ' && cell.attrs & !DISPLAYED_SPACER == 0 {
                        DisplayedCell { fg: None, ..cell }
                    } else {
                        cell
                    }
                };
                assert_eq!(visible(got), visible(*want), "cell ({row}, {col})");
            }
        }
        let cursor = self.term.grid().cursor.point;
        match screen.cursor {
            Some(want) => {
                assert!(self.term.mode().contains(TermMode::SHOW_CURSOR));
                assert_eq!(
                    (cursor.line.0 as usize, cursor.column.0),
                    (origin + usize::from(want.row), usize::from(want.col))
                );
                let shape = match want.shape {
                    DisplayedCursorShape::Block => CursorShape::Block,
                    DisplayedCursorShape::Underline => CursorShape::Underline,
                    DisplayedCursorShape::Beam => CursorShape::Beam,
                };
                assert_eq!(self.term.cursor_style().shape, shape);
            }
            None => assert!(!self.term.mode().contains(TermMode::SHOW_CURSOR)),
        }
    }
}

/// The frame between its synchronized-output brackets and the fence.
fn body(frame: &[u8]) -> &[u8] {
    let frame = frame
        .strip_prefix(b"\x1b[?2026h")
        .expect("a frame opens a synchronized update");
    frame
        .strip_suffix(b"\x1b[?2026l\x1b[5n")
        .expect("a frame closes it and asks for the fence")
}

fn compose(composer: &mut Composer, screen: &Screen, host: &mut Host) -> Vec<u8> {
    let mut out = Vec::new();
    composer.compose(screen, &mut out);
    host.feed(&out);
    out
}

fn styled_screen() -> Screen {
    let mut screen = Screen::new(12, 3);
    screen.put(0, 0, "$ ls", pen(None, None, 0));
    screen.put(0, 5, "red", pen(Some(RED), None, DISPLAYED_BOLD));
    screen.put(1, 0, "世界", pen(None, Some(BLUE), DISPLAYED_UNDERLINE));
    screen.put(1, 4, "it", pen(Some(RED), Some(BLUE), DISPLAYED_ITALIC));
    screen.put(2, 0, "inv", pen(None, None, DISPLAYED_INVERSE));
    for cell in &mut screen.rows[2][6..] {
        *cell = pen(None, Some(BLUE), 0);
    }
    screen.cursor = Some(DisplayedCursor {
        row: 0,
        col: 4,
        shape: DisplayedCursorShape::Beam,
    });
    screen
}

#[test]
fn the_first_frame_paints_the_area_and_the_host_shows_it_exactly() {
    let screen = styled_screen();
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    let frame = compose(&mut composer, &screen, &mut host);
    body(&frame);
    host.shows(&screen, 0);
    // The blue tail of the last row is one erase, not six blanks.
    assert!(frame.windows(3).any(|window| window == b"\x1b[K"));
}

#[test]
fn an_unchanged_presentation_writes_nothing() {
    let screen = styled_screen();
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    compose(&mut composer, &screen, &mut host);
    let mut out = Vec::new();
    assert!(!composer.compose(&screen, &mut out));
    assert!(out.is_empty());
}

#[test]
fn one_changed_cell_is_one_move_and_one_glyph() {
    let mut screen = styled_screen();
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    compose(&mut composer, &screen, &mut host);
    screen.put(0, 3, "x", pen(None, None, 0));
    let frame = compose(&mut composer, &screen, &mut host);
    host.shows(&screen, 0);
    // The glyph already advanced to the cursor.
    assert_eq!(body(&frame), b"\x1b[1;4H\x1b[0mx");
}

#[test]
fn rows_that_shrink_or_change_width_show_exactly() {
    let mut screen = styled_screen();
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    compose(&mut composer, &screen, &mut host);
    // The coloured word goes: its row's tail is erased.
    for cell in &mut screen.rows[0][4..] {
        *cell = DisplayedCell::BLANK;
    }
    // Wide characters become narrow ones and a narrow pair a wide one.
    screen.put(1, 0, "abcd", pen(None, None, 0));
    screen.put(1, 4, "界", pen(Some(RED), None, 0));
    compose(&mut composer, &screen, &mut host);
    host.shows(&screen, 0);
}

#[test]
fn the_area_starts_at_its_origin_and_leaves_the_rows_above_alone() {
    let screen = styled_screen();
    let mut host = Host::new(12, 4);
    host.feed(b"status");
    let mut composer = Composer::new(1);
    compose(&mut composer, &screen, &mut host);
    host.shows(&screen, 1);
    assert_eq!(host.cell(0, 0).c, 's');
    assert_eq!(host.cell(0, 5).c, 's');
}

#[test]
fn the_cursor_hides_shows_and_changes_shape() {
    let mut screen = styled_screen();
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    compose(&mut composer, &screen, &mut host);
    screen.cursor = None;
    assert_eq!(
        body(&compose(&mut composer, &screen, &mut host)),
        b"\x1b[?25l"
    );
    host.shows(&screen, 0);
    screen.cursor = Some(DisplayedCursor {
        row: 2,
        col: 1,
        shape: DisplayedCursorShape::Underline,
    });
    compose(&mut composer, &screen, &mut host);
    host.shows(&screen, 0);
}

#[test]
fn turning_an_attribute_off_resets_the_pen_and_adding_one_does_not() {
    let mut screen = Screen::new(4, 1);
    screen.cursor = None;
    screen.put(0, 0, "a", pen(None, None, DISPLAYED_BOLD));
    screen.put(
        0,
        1,
        "b",
        pen(None, None, DISPLAYED_BOLD | DISPLAYED_ITALIC),
    );
    screen.put(0, 2, "c", pen(Some(RED), None, 0));
    screen.put(0, 3, "d", pen(Some(RED), None, 0));
    let mut host = Host::new(4, 1);
    let mut composer = Composer::new(0);
    let frame = compose(&mut composer, &screen, &mut host);
    assert_eq!(
        body(&frame),
        b"\x1b[1;1H\x1b[0;1ma\x1b[3mb\x1b[0;38;2;243;139;168mcd\x1b[?25l\x1b[m"
    );
    host.shows(&screen, 0);
}

#[test]
fn a_resized_presentation_is_painted_whole() {
    let screen = styled_screen();
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    compose(&mut composer, &screen, &mut host);
    let mut wider = Screen::new(14, 3);
    wider.put(0, 0, "resized", pen(None, None, 0));
    let mut host = Host::new(14, 3);
    compose(&mut composer, &wider, &mut host);
    host.shows(&wider, 0);
}

#[test]
fn hyperlinks_follow_changed_cells_wide_glyphs_and_linked_blanks() {
    let mut screen = Screen::new(8, 1);
    screen.put(0, 0, "界ab", pen(None, None, 0));
    screen.uris.insert(7, "https://merkur.sh/one".into());
    screen.uris.insert(8, "https://merkur.sh/two".into());
    screen.links[0][..2].fill(7);
    screen.links[0][3..6].fill(8);
    let mut composer = Composer::new(1);
    let mut host = Host::new(8, 2);
    let uri = |host: &Host, col| {
        host.term.grid()[Point::new(Line(1), Column(col))]
            .hyperlink()
            .map(|link| link.uri().to_owned())
    };
    compose(&mut composer, &screen, &mut host);
    host.shows(&screen, 1);
    assert_eq!(uri(&host, 0).as_deref(), Some("https://merkur.sh/one"));
    assert_eq!(uri(&host, 1).as_deref(), Some("https://merkur.sh/one"));
    assert_eq!(uri(&host, 2), None);
    assert_eq!(uri(&host, 5).as_deref(), Some("https://merkur.sh/two"));
    assert_eq!(uri(&host, 6), None);
    screen.links[0][..2].fill(8);
    screen.links[0][3..].fill(0);
    compose(&mut composer, &screen, &mut host);
    host.shows(&screen, 1);
    assert_eq!(uri(&host, 0).as_deref(), Some("https://merkur.sh/two"));
    for col in 3..8 {
        assert_eq!(uri(&host, col), None);
    }
    host.feed(b"\x1b[1;1Hchrome");
    assert!(
        host.term.grid()[Point::new(Line(0), Column(0))]
            .hyperlink()
            .is_none()
    );
}

#[test]
fn missing_and_unsafe_link_definitions_cannot_inject_host_commands() {
    let mut screen = Screen::new(4, 1);
    screen.put(0, 0, "test", pen(None, None, 0));
    screen.links[0].fill(7);
    screen
        .uris
        .insert(7, "https://merkur.sh/\x1b\\\x1b[2J".into());
    let mut composer = Composer::new(0);
    let mut host = Host::new(4, 1);
    let frame = compose(&mut composer, &screen, &mut host);
    assert!(!frame.windows(3).any(|bytes| bytes == b"\x1b]8"));
    host.shows(&screen, 0);
    screen.uris.remove(&7);
    composer.invalidate();
    let frame = compose(&mut composer, &screen, &mut host);
    assert!(!frame.windows(3).any(|bytes| bytes == b"\x1b]8"));
    host.shows(&screen, 0);
}

#[test]
fn a_definition_arriving_after_its_cells_repaints_only_the_linked_cells() {
    let mut screen = Screen::new(8, 1);
    screen.put(0, 0, "plain a", pen(None, None, 0));
    screen.links[0][6] = 7;
    let mut composer = Composer::new(0);
    let mut host = Host::new(8, 1);
    compose(&mut composer, &screen, &mut host);
    screen.uris.insert(7, "https://merkur.sh/a".into());
    let frame = compose(&mut composer, &screen, &mut host);
    assert!(!contains_bytes(&frame, b"plain"));
    assert_eq!(
        host.term.grid()[Point::new(Line(0), Column(6))]
            .hyperlink()
            .unwrap()
            .uri(),
        "https://merkur.sh/a"
    );
    screen.uris.remove(&7);
    compose(&mut composer, &screen, &mut host);
    assert!(
        host.term.grid()[Point::new(Line(0), Column(6))]
            .hyperlink()
            .is_none()
    );
}
fn contains_bytes(bytes: &[u8], pattern: &[u8]) -> bool {
    bytes.windows(pattern.len()).any(|bytes| bytes == pattern)
}

/// A screen that says what each row is made from, and counts the rows the
/// composer reads.
struct Stamped {
    screen: Screen,
    revisions: Vec<Option<Revision>>,
    read: std::cell::Cell<usize>,
}

impl Stamped {
    fn new(screen: Screen) -> Self {
        Self {
            revisions: vec![Some((1, 0)); screen.rows.len()],
            screen,
            read: std::cell::Cell::new(0),
        }
    }

    /// Composes into `host` and returns how many rows the composer read.
    fn compose(&self, composer: &mut Composer, host: &mut Host) -> usize {
        self.read.set(0);
        let mut out = Vec::new();
        composer.compose(self, &mut out);
        host.feed(&out);
        self.read.get()
    }
}

impl Presented for Stamped {
    fn size(&self) -> (u16, u16) {
        self.screen.size()
    }

    fn row(&self, row: u16, out: &mut Vec<DisplayedCell>) {
        self.read.set(self.read.get() + 1);
        self.screen.row(row, out);
    }

    fn cursor(&self) -> Option<DisplayedCursor> {
        self.screen.cursor()
    }

    fn links(&self, row: u16, out: &mut Vec<u32>) {
        self.screen.links(row, out);
    }

    fn link_uri(&self, id: u32) -> Option<&str> {
        self.screen.link_uri(id)
    }

    fn revision(&self, row: u16) -> Option<Revision> {
        self.revisions[usize::from(row)]
    }
}

#[test]
fn a_row_made_from_what_the_host_shows_is_not_read_again() {
    let mut source = Stamped::new(styled_screen());
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    assert_eq!(source.compose(&mut composer, &mut host), 3);
    host.shows(&source.screen, 0);
    assert_eq!(source.compose(&mut composer, &mut host), 0);

    // One row is committed anew: it alone is read, and the host shows it.
    source.screen.put(1, 6, "new", pen(Some(RED), None, 0));
    source.revisions[1] = Some((2, 0));
    assert_eq!(source.compose(&mut composer, &mut host), 1);
    host.shows(&source.screen, 0);
    assert_eq!(source.compose(&mut composer, &mut host), 0);
}

#[test]
fn a_row_that_can_differ_between_reads_is_read_until_it_settles() {
    let mut source = Stamped::new(styled_screen());
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    source.compose(&mut composer, &mut host);

    // A speculative echo lands on the row: no commit made it.
    source.revisions[0] = None;
    source.screen.put(0, 4, "x", pen(None, None, 0));
    assert_eq!(source.compose(&mut composer, &mut host), 1);
    host.shows(&source.screen, 0);
    assert_eq!(source.compose(&mut composer, &mut host), 1);

    // It is withdrawn, and the row is again what its last commit made it.
    source.screen.put(0, 4, " ", pen(None, None, 0));
    source.revisions[0] = Some((1, 0));
    assert_eq!(source.compose(&mut composer, &mut host), 1);
    host.shows(&source.screen, 0);
    assert_eq!(source.compose(&mut composer, &mut host), 0);
}

#[test]
fn an_unknown_host_screen_and_a_new_size_read_every_row() {
    let mut source = Stamped::new(styled_screen());
    let mut host = Host::new(12, 3);
    let mut composer = Composer::new(0);
    source.compose(&mut composer, &mut host);

    // Something else drew over the area: every row is read and painted.
    host.feed(b"\x1b[2J");
    composer.invalidate();
    assert_eq!(source.compose(&mut composer, &mut host), 3);
    host.shows(&source.screen, 0);

    // The same commits at another size are another presentation.
    let mut taller = Screen::new(12, 4);
    taller.put(3, 0, "more", pen(None, None, 0));
    source.screen = taller;
    source.revisions = vec![Some((1, 0)); 4];
    let mut host = Host::new(12, 4);
    assert_eq!(source.compose(&mut composer, &mut host), 4);
    host.shows(&source.screen, 0);
}

#[test]
fn a_new_link_table_reads_every_row_and_repaints_what_it_resolved() {
    let mut screen = Screen::new(8, 2);
    screen.put(0, 0, "plain a", pen(None, None, 0));
    screen.put(1, 0, "other", pen(None, None, 0));
    screen.links[0][6] = 7;
    let mut source = Stamped::new(screen);
    let mut host = Host::new(8, 2);
    let mut composer = Composer::new(0);
    source.compose(&mut composer, &mut host);

    // The definition lands on its own lane, after the cells that carry it.
    source.screen.uris.insert(7, "https://merkur.sh/a".into());
    assert_eq!(source.compose(&mut composer, &mut host), 0);
    source.revisions.fill(Some((1, 1)));
    source.read.set(0);
    let mut frame = Vec::new();
    composer.compose(&source, &mut frame);
    host.feed(&frame);
    assert_eq!(source.read.get(), 2);
    assert!(!contains_bytes(&frame, b"plain"));
    assert!(!contains_bytes(&frame, b"other"));
    assert_eq!(
        host.term.grid()[Point::new(Line(0), Column(6))]
            .hyperlink()
            .unwrap()
            .uri(),
        "https://merkur.sh/a"
    );
}

#[test]
#[ignore = "host byte and allocation census; run with --ignored --nocapture"]
fn cursor_cost_profile() {
    for (name, text, col, hidden) in [
        ("echo", "x", 1, false),
        ("wide", "界", 2, false),
        ("wrap", "abcdefghijkl", 11, false),
        ("hidden", "x", 1, true),
        ("moved", "x", 5, false),
        ("erase", "", 0, false),
    ] {
        let mut screen = Screen::new(12, 2);
        screen.put(0, 0, "old", DisplayedCell::BLANK);
        let mut composer = Composer::new(0);
        let mut host = Host::new(12, 2);
        compose(&mut composer, &screen, &mut host);
        screen.rows[0].fill(DisplayedCell::BLANK);
        screen.put(0, 0, text, DisplayedCell::BLANK);
        screen.cursor = (!hidden).then_some(DisplayedCursor {
            row: 0,
            col,
            shape: DisplayedCursorShape::Beam,
        });
        let mut out = Vec::with_capacity(1024);
        let tally = crate::test_allocations::measure(|| {
            composer.compose(&screen, &mut out);
        });
        host.feed(&out);
        host.shows(&screen, 0);
        println!(
            "cursor {name}: bytes={} capacity={} {tally:?}",
            out.len(),
            out.capacity()
        );
        out.clear();
        let tally = crate::test_allocations::measure(|| {
            assert!(!composer.compose(&screen, &mut out));
        });
        assert!(out.is_empty());
        println!("cursor {name} unchanged: bytes=0 {tally:?}");
    }
}

#[test]
#[ignore = "retired-instruction population; select MERKUR_TUI_CURSOR_CASE"]
fn cursor_instruction_profile() {
    let case = std::env::var("MERKUR_TUI_CURSOR_CASE").unwrap_or_else(|_| "echo".into());
    let mut screen = Screen::new(12, 2);
    let mut composer = Composer::new(0);
    let mut out = Vec::with_capacity(1024);
    composer.compose(&screen, &mut out);
    for index in 0..1_000_000 {
        out.clear();
        let col = 1 + u16::try_from(index % 2).unwrap();
        match case.as_str() {
            "echo" => {
                screen.rows[0][0].c = if index % 2 == 0 { 'x' } else { 'y' };
                screen.cursor.as_mut().unwrap().col = 1;
            }
            "cursor" => screen.cursor.as_mut().unwrap().col = col,
            "wrap" => {
                screen.rows[0][11].c = if index % 2 == 0 { 'x' } else { 'y' };
                screen.cursor.as_mut().unwrap().col = 11;
            }
            "hidden" => {
                screen.rows[0][0].c = if index % 2 == 0 { 'x' } else { 'y' };
                screen.cursor = None;
            }
            "unchanged" => {}
            _ => panic!("unknown cursor workload"),
        }
        std::hint::black_box(composer.compose(std::hint::black_box(&screen), &mut out));
        std::hint::black_box(&out);
    }
}

/// Encode real display cells, then let the shared viewer commit them for the composer.
fn presented_cells(cells: &[merkur_codec::CellRepr]) -> merkur_client::viewer::Viewer<NativeGrid> {
    use merkur_client::input_sequence::InputMapping;
    use merkur_client::session::DisplayFence;
    use merkur_client::viewer::Viewer;
    use merkur_codec::{
        FrameHeader, FrameKind, MSG_TYPE_DISPLAY_PATCH, RowRef, STREAM_HEADER_BYTES, StreamHeader,
        encode_frame_into, write_stream_header,
    };
    use merkur_wire::protocol::CHANNEL_DISPLAY_COMMIT;

    let cols = u16::try_from(cells.len()).unwrap();
    let header = FrameHeader {
        kind: FrameKind::Snapshot,
        memory_only: false,
        cols,
        rows: 1,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 0,
        cursor_visible: 0,
        mode_flags: 0,
        row_count: 1,
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
    encode_frame_into(
        &mut payload,
        &header,
        std::iter::once(RowRef {
            row_index: 0,
            left: 0,
            cells,
            graphics: &[],
        }),
    );
    let body_len = u32::try_from(payload.len() - STREAM_HEADER_BYTES).unwrap();
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
    let start = merkur_codec::wire::write_wire_header_in_place(&mut payload).unwrap();
    let mut viewer = Viewer::new(NativeGrid::new(cols, 1));
    viewer.fence(0.0, DisplayFence { lineage: 1 });
    viewer.receive(
        0.0,
        CHANNEL_DISPLAY_COMMIT,
        &payload[start..],
        InputMapping::default(),
    );
    viewer.present_now(0.0);
    assert_eq!(viewer.stats().frames, 1, "the display frame applies");
    viewer
}

#[test]
fn display_cells_cannot_emit_host_controls() {
    use merkur_client::viewer::DisplayGrid;
    use merkur_codec::CellRepr;

    let controls: String = (0..=0x1f)
        .chain(0x7f..=0x9f)
        .map(|cp| char::from_u32(cp).unwrap())
        .collect();
    let payloads = [
        "\x1b]2;cell title\x07".to_string(),
        "\x1b]52;c;Y2VsbA==\x1b\\".to_string(),
        "\x1b]777;notify;cell;body\x07".to_string(),
        "\x1b[2J\x1b[?1049h\r\n\t\x08".to_string(),
        controls,
    ];
    let mut effects = [0; 4];
    let mut mismatches = 0;
    for payload in payloads {
        let text = format!("L{payload}R");
        let cells: Vec<_> = text
            .chars()
            .map(|c| CellRepr {
                codepoint: u32::from(c),
                ..CellRepr::BLANK
            })
            .collect();
        let mut viewer = presented_cells(&cells);
        let hashes = viewer.grid_mut().row_hashes().to_vec();
        let mut before = Vec::new();
        viewer.grid().row(0, &mut before);
        let mut composer = Composer::new(0);
        let mut out = Vec::new();
        assert!(composer.compose(viewer.grid(), &mut out));
        let mut host = Host::new(u16::try_from(cells.len()).unwrap(), 1);
        host.feed(&out);
        for (got, count) in effects.iter_mut().zip(*host.events.0.borrow()) {
            *got += count;
        }
        for (col, c) in text.chars().enumerate() {
            let expected = if c.is_control() { ' ' } else { c };
            mismatches += usize::from(host.cell(0, col).c != expected);
        }
        let mut after = Vec::new();
        viewer.grid().row(0, &mut after);
        assert_eq!(before, after, "composition cannot change presented cells");
        assert_eq!(hashes, viewer.grid_mut().row_hashes());
        out.clear();
        assert!(!composer.compose(viewer.grid(), &mut out));
        assert!(out.is_empty());
    }
    eprintln!(
        "cell effects [title, clipboard, notification, bell]={effects:?}; layout mismatches={mismatches}"
    );
    assert_eq!(effects, [0; 4]);
    assert_eq!(mismatches, 0);
}

#[test]
fn control_cells_preserve_declared_occupancy_and_style() {
    for c in (0..=0x1f)
        .chain(0x7f..=0x9f)
        .map(|cp| char::from_u32(cp).unwrap())
    {
        for width in [1, 2] {
            let mut source = Screen::new(6, 1);
            source.put(0, 0, "L", pen(None, None, 0));
            source.rows[0][1] = DisplayedCell {
                c,
                attrs: DISPLAYED_BOLD | if width == 2 { DISPLAYED_WIDE } else { 0 },
                fg: Some(RED),
                bg: Some(BLUE),
            };
            source.put(0, 1 + width, "R", pen(None, None, 0));
            let mut want = Screen::new(6, 1);
            want.rows.clone_from(&source.rows);
            for col in 1..1 + width {
                want.rows[0][col] = DisplayedCell {
                    c: ' ',
                    attrs: DISPLAYED_BOLD,
                    ..source.rows[0][1]
                };
            }
            let mut host = Host::new(6, 1);
            compose(&mut Composer::new(0), &source, &mut host);
            host.shows(&want, 0);
            assert_eq!(*host.events.0.borrow(), [0; 4]);
        }
    }
}

#[test]
#[ignore = "instruction census; run alone under /usr/bin/time -l"]
fn composer_instruction_profile() {
    use std::hint::black_box;

    let workload = std::env::var("TUI_COMPOSER_WORKLOAD").unwrap_or_else(|_| "ascii".into());
    let mut source = Stamped::new(Screen::new(80, 24));
    let text = match workload.as_str() {
        "ascii" | "edit" | "unchanged" | "cursor" | "styled" => "aZ09!~ ".repeat(11),
        "unicode2" => "éλЖ".repeat(25),
        "unicode3" => "─●€".repeat(25),
        "unicode4" => "𐐀𐐁𐐂".repeat(25),
        "wide" => "世界".repeat(19),
        "blank" => String::new(),
        _ => panic!("unknown composer workload"),
    };
    for row in 0..24 {
        let style = if workload == "styled" {
            pen(Some(RED), Some(BLUE), DISPLAYED_BOLD | DISPLAYED_ITALIC)
        } else {
            pen(None, None, 0)
        };
        source.screen.put(row, 0, &text, style);
    }
    let mut composer = Composer::new(0);
    let mut out = Vec::with_capacity(64 * 1024);
    composer.compose(&source, &mut out);
    let fingerprint = ring::digest::digest(&ring::digest::SHA256, &out);
    let capacities = (
        composer.shown.capacity(),
        composer.next.capacity(),
        out.capacity(),
    );
    let rounds = 20_000;
    let mut bytes = 0;
    for round in 0..rounds {
        match workload.as_str() {
            "edit" => {
                source.screen.rows[12][40].c = if round % 2 == 0 { 'x' } else { 'y' };
                source.revisions[12] = Some((round + 2, 0));
            }
            "unchanged" => {}
            "cursor" => source.screen.cursor.as_mut().unwrap().col = (round % 80) as u16,
            _ => composer.invalidate(),
        }
        out.clear();
        composer.compose(black_box(&source), black_box(&mut out));
        bytes += black_box(out.len());
        black_box(out.as_slice());
    }
    assert_eq!(
        capacities,
        (
            composer.shown.capacity(),
            composer.next.capacity(),
            out.capacity()
        )
    );
    eprintln!(
        "workload={workload} rounds={rounds} bytes={bytes} capacities={capacities:?} first_frame={fingerprint:?}"
    );
}

#[test]
fn printable_cells_keep_their_utf8_bytes() {
    let mut out = Vec::with_capacity(4);
    let mut writer = Writer {
        out: &mut out,
        origin: 0,
        cols: 2,
        pen: Some(Pen::DEFAULT),
        at: None,
        link: 0,
    };
    for c in (0..=0x10ffff)
        .filter_map(char::from_u32)
        .filter(|c| !c.is_control())
    {
        writer.out.clear();
        writer.at = Some((0, 0));
        writer.cell(
            0,
            0,
            DisplayedCell {
                c,
                ..DisplayedCell::BLANK
            },
            1,
        );
        let mut bytes = [0; 4];
        assert_eq!(
            writer.out.as_slice(),
            c.encode_utf8(&mut bytes).as_bytes(),
            "{c:?}"
        );
    }
}

#[test]
fn native_control_cells_preserve_two_columns_and_the_right_edge() {
    use merkur_codec::{CellAttrs, CellRepr};

    for c in (0..=0x1f)
        .chain(0x7f..=0x9f)
        .map(|cp| char::from_u32(cp).unwrap())
    {
        let cells = [
            CellRepr {
                codepoint: u32::from(c),
                attrs: CellAttrs::WIDE,
                ..CellRepr::BLANK
            },
            CellRepr::BLANK,
            CellRepr {
                codepoint: u32::from('R'),
                ..CellRepr::BLANK
            },
            CellRepr {
                codepoint: u32::from(c),
                attrs: CellAttrs::WIDE,
                ..CellRepr::BLANK
            },
        ];
        let viewer = presented_cells(&cells);
        let mut host = Host::new(4, 1);
        let mut out = Vec::new();
        Composer::new(0).compose(viewer.grid(), &mut out);
        host.feed(&out);
        assert_eq!(*host.events.0.borrow(), [0; 4]);
        for (col, c) in "  R ".chars().enumerate() {
            assert_eq!(host.cell(0, col).c, c, "cell {col}");
        }
    }
}

#[test]
#[ignore = "native instruction census; run alone under /usr/bin/time -l"]
fn native_composer_instruction_profile() {
    use merkur_codec::CellRepr;
    use std::hint::black_box;

    let cells: Vec<_> = "aZ09!~ "
        .repeat(11)
        .chars()
        .map(|c| CellRepr {
            codepoint: u32::from(c),
            ..CellRepr::BLANK
        })
        .collect();
    let viewer = presented_cells(&cells);
    let mut composer = Composer::new(0);
    let mut out = Vec::with_capacity(1024);
    composer.compose(viewer.grid(), &mut out);
    let fingerprint = ring::digest::digest(&ring::digest::SHA256, &out);
    let mut bytes = 0;
    for _ in 0..480_000 {
        composer.invalidate();
        out.clear();
        composer.compose(black_box(viewer.grid()), black_box(&mut out));
        bytes += black_box(out.len());
        black_box(out.as_slice());
    }
    eprintln!("native_ascii rounds=480000 bytes={bytes} first_frame={fingerprint:?}");
}

#[test]
#[ignore = "local chrome instruction census; run alone under /usr/bin/time -l"]
fn chrome_composer_instruction_profile() {
    use crate::chrome::Chrome;
    use crate::host::HostSize;
    use std::hint::black_box;

    let workload = std::env::var("TUI_COMPOSER_WORKLOAD").unwrap_or_else(|_| "ascii".into());
    assert!(matches!(workload.as_str(), "ascii" | "edit" | "unchanged"));
    let size = HostSize {
        cols: 80,
        rows: 24,
        cell: None,
    };
    let mut chrome = Chrome::default();
    let text = "aZ09!~ ".repeat(11);
    let mut paint = Vec::new();
    for row in 1..=24 {
        paint.extend_from_slice(format!("\x1b[{row};1H{text}").as_bytes());
    }
    let mut out = Vec::with_capacity(64 * 1024);
    chrome.present(size, |out| out.extend_from_slice(&paint), &mut out);
    let fingerprint = ring::digest::digest(&ring::digest::SHA256, &out);
    let mut bytes = 0;
    for round in 0..20_000 {
        if workload == "ascii" {
            chrome.invalidate();
        }
        out.clear();
        chrome.present(
            size,
            |paint| {
                if workload == "edit" {
                    paint.extend_from_slice(if round % 2 == 0 {
                        b"\x1b[13;41Hx"
                    } else {
                        b"\x1b[13;41Hy"
                    });
                }
            },
            black_box(&mut out),
        );
        bytes += black_box(out.len());
        black_box(out.as_slice());
    }
    eprintln!("chrome_{workload} rounds=20000 bytes={bytes} first_frame={fingerprint:?}");
}
