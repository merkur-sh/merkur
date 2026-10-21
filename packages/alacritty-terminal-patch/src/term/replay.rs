//! Merkur: the terminal's state as the escape sequences that rebuild it.
//!
//! A daemon upgrade replaces the process that owns this terminal while the shell keeps
//! running. The old process writes [`Term::write_replay`]; the new one feeds those bytes
//! through its own parser into a fresh terminal of the same size and configuration. The
//! bytes are the terminal language itself, so they mean the same thing to every release:
//! nothing here is a format of Merkur's.
//!
//! What it rebuilds: both screens' cells with their attributes, wide and combining
//! characters and OSC 8 links, the primary scrollback, line wrapping, both cursors and saved
//! cursors with their pens and character sets, the terminal modes, both keyboard-mode stacks,
//! the scrolling region, tab stops, the modified palette, the cursor style and the title.
//! What it does not: a cell holding a tab start reads as a space, the title stack is empty,
//! a saved cursor's pending wrap is dropped, and the viewport scrolls to the bottom.
//! It emits no query, so the replay makes the new terminal write nothing to the PTY.

use std::fmt::Write as _;

use crate::grid::{Cursor, Dimensions, Grid};
use crate::index::{Column, Line};
use crate::term::cell::{Cell, Flags, Hyperlink};
use crate::term::{Term, TermMode};
use crate::vte::ansi::{
    CharsetIndex, Color, CursorShape, KeyboardModes, NamedColor, StandardCharset,
};

/// The pen a run of cells is printed with.
#[derive(Clone, PartialEq)]
struct Pen {
    fg: Color,
    bg: Color,
    flags: Flags,
    underline: Option<Color>,
}

impl Pen {
    fn of(cell: &Cell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            flags: cell.flags & ATTRIBUTE_FLAGS,
            underline: cell.underline_color(),
        }
    }

    fn default_pen() -> Self {
        Self::of(&Cell::default())
    }
}

/// The flags SGR sets; the rest describe a cell's place in the grid and are rebuilt by
/// printing.
const ATTRIBUTE_FLAGS: Flags = Flags::INVERSE
    .union(Flags::BOLD)
    .union(Flags::ITALIC)
    .union(Flags::DIM)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT)
    .union(Flags::ALL_UNDERLINES);

/// Printing state shared across the whole replay.
struct Writer {
    out: String,
    pen: Pen,
    link: Option<(String, String)>,
}

impl Writer {
    fn pen(&mut self, pen: &Pen) {
        if &self.pen == pen {
            return;
        }
        self.out.push_str("\x1b[0");
        let flags = pen.flags;
        for (flag, code) in [
            (Flags::BOLD, "1"),
            (Flags::DIM, "2"),
            (Flags::ITALIC, "3"),
            (Flags::INVERSE, "7"),
            (Flags::HIDDEN, "8"),
            (Flags::STRIKEOUT, "9"),
        ] {
            if flags.contains(flag) {
                self.out.push(';');
                self.out.push_str(code);
            }
        }
        if flags.contains(Flags::UNDERLINE) {
            self.out.push_str(";4");
        } else if flags.contains(Flags::DOUBLE_UNDERLINE) {
            self.out.push_str(";4:2");
        } else if flags.contains(Flags::UNDERCURL) {
            self.out.push_str(";4:3");
        } else if flags.contains(Flags::DOTTED_UNDERLINE) {
            self.out.push_str(";4:4");
        } else if flags.contains(Flags::DASHED_UNDERLINE) {
            self.out.push_str(";4:5");
        }
        color(&mut self.out, pen.fg, Layer::Foreground);
        color(&mut self.out, pen.bg, Layer::Background);
        if let Some(underline) = pen.underline {
            color(&mut self.out, underline, Layer::Underline);
        }
        self.out.push('m');
        self.pen = pen.clone();
    }

    fn link(&mut self, link: Option<&Hyperlink>) {
        let wanted = link.map(|link| (link.id(), link.uri()));
        let current = self.link.as_ref().map(|(id, uri)| (id.as_str(), uri.as_str()));
        if wanted == current {
            return;
        }
        match link {
            Some(link) => {
                let _ = write!(self.out, "\x1b]8;id={};{}\x1b\\", link.id(), link.uri());
                self.link = Some((link.id().to_owned(), link.uri().to_owned()));
            },
            None => {
                self.out.push_str("\x1b]8;;\x1b\\");
                self.link = None;
            },
        }
    }

    fn cell(&mut self, cell: &Cell) {
        self.pen(&Pen::of(cell));
        self.link(cell.hyperlink_ref());
        self.out.push(if cell.c == '\t' { ' ' } else { cell.c });
        if let Some(zerowidth) = cell.zerowidth() {
            self.out.extend(zerowidth.iter());
        }
    }

    /// One row's cells: all of them when the row wraps into the next, so printing reaches
    /// the margin and wraps there; up to its last non-default cell otherwise.
    fn row(&mut self, grid: &Grid<Cell>, line: Line) -> bool {
        let row = &grid[line];
        let columns = grid.columns();
        let wraps = row[Column(columns - 1)].flags.contains(Flags::WRAPLINE);
        let end = if wraps {
            columns
        } else {
            (0..columns)
                .rev()
                .find(|&column| !is_default(&row[Column(column)]))
                .map_or(0, |column| column + 1)
        };
        for column in 0..end {
            let cell = &row[Column(column)];
            // A wide character's spacer is rebuilt by printing the character, and a leading
            // spacer by a wide character that meets the margin.
            if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            self.cell(cell);
        }
        wraps
    }

    /// Every row of `grid` from `first` to the bottom of the screen, each ended by CR LF
    /// unless it wraps, so rows above the screen scroll into history as they did.
    fn rows(&mut self, grid: &Grid<Cell>, first: i32) {
        let last = grid.screen_lines() as i32 - 1;
        for line in first..=last {
            let wraps = self.row(grid, Line(line));
            if line != last && !wraps {
                self.pen(&Pen::default_pen());
                self.link(None);
                self.out.push_str("\r\n");
            }
        }
    }

    /// Places `cursor` with its pen, link and character sets. The pending wrap is rebuilt
    /// by printing the margin cell again, which leaves it as it was.
    fn cursor(
        &mut self,
        grid: &Grid<Cell>,
        cursor: &Cursor<Cell>,
        origin: Option<Line>,
        wrap: bool,
    ) {
        let line = cursor.point.line - origin.unwrap_or(Line(0));
        let _ = write!(self.out, "\x1b[{};{}H", line.0 + 1, cursor.point.column.0 + 1);
        if wrap && cursor.input_needs_wrap {
            let cell = &grid[cursor.point.line][cursor.point.column];
            if !cell.flags.intersects(
                Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER | Flags::WIDE_CHAR,
            ) {
                self.cell(cell);
            }
        }
        self.pen(&Pen::of(&cursor.template));
        self.link(cursor.template.hyperlink_ref());
        for (index, intermediate) in [
            (CharsetIndex::G0, '('),
            (CharsetIndex::G1, ')'),
            (CharsetIndex::G2, '*'),
            (CharsetIndex::G3, '+'),
        ] {
            let designator = match cursor.charsets[index] {
                StandardCharset::Ascii => 'B',
                StandardCharset::SpecialCharacterAndLineDrawing => '0',
            };
            let _ = write!(self.out, "\x1b{intermediate}{designator}");
        }
    }
}

#[derive(Clone, Copy)]
enum Layer {
    Foreground,
    Background,
    Underline,
}

fn color(out: &mut String, color: Color, layer: Layer) {
    let (extended, base, bright, default) = match layer {
        Layer::Foreground => (38, 30, 90, 39),
        Layer::Background => (48, 40, 100, 49),
        Layer::Underline => (58, 0, 0, 59),
    };
    match color {
        Color::Spec(rgb) => {
            let _ = write!(out, ";{extended};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        },
        Color::Indexed(index) => {
            let _ = write!(out, ";{extended};5;{index}");
        },
        Color::Named(named) => {
            let index = named as usize;
            match (index, layer) {
                (_, Layer::Foreground) if named == NamedColor::Foreground => {
                    let _ = write!(out, ";{default}");
                },
                (_, Layer::Background) if named == NamedColor::Background => {
                    let _ = write!(out, ";{default}");
                },
                (0..=7, Layer::Foreground | Layer::Background) => {
                    let _ = write!(out, ";{}", base + index);
                },
                (8..=15, Layer::Foreground | Layer::Background) => {
                    let _ = write!(out, ";{}", bright + index - 8);
                },
                (0..=15, Layer::Underline) => {
                    let _ = write!(out, ";{extended};5;{index}");
                },
                // SGR names no other colour; a cell never holds one.
                _ => {},
            }
        },
    }
}

fn is_default(cell: &Cell) -> bool {
    let default = Cell::default();
    (cell.c == default.c || cell.c == '\t')
        && cell.fg == default.fg
        && cell.bg == default.bg
        && (cell.flags - Flags::WRAPLINE).is_empty()
        && cell.zerowidth().is_none_or(<[char]>::is_empty)
        && cell.underline_color().is_none()
        && cell.hyperlink_ref().is_none()
}

fn mode(out: &mut String, set: bool, code: &str) {
    let _ = write!(out, "\x1b[{code}{}", if set { 'h' } else { 'l' });
}

fn keyboard_stack(out: &mut String, stack: &[KeyboardModes]) {
    for modes in stack {
        let _ = write!(out, "\x1b[>{}u", modes.bits());
    }
}

impl<T> Term<T> {
    /// Appends the escape sequences that rebuild this terminal in a fresh one of the same
    /// size and configuration; see the module documentation for what they cover.
    pub fn write_replay(&self, out: &mut Vec<u8>) {
        let mut writer = Writer { out: String::new(), pen: Pen::default_pen(), link: None };
        let alternate = self.mode.contains(TermMode::ALT_SCREEN);
        let (primary, primary_keyboard) = if alternate {
            (&self.inactive_grid, &self.inactive_keyboard_mode_stack)
        } else {
            (&self.grid, &self.keyboard_mode_stack)
        };

        // The primary screen's history and screen, oldest row first.
        writer.rows(primary, -(primary.history_size() as i32));
        writer.pen(&Pen::default_pen());
        writer.link(None);

        // Tab stops and the palette belong to the terminal, not a screen.
        writer.out.push_str("\x1b[3g");
        for column in 0..self.columns() {
            if self.tabs[Column(column)] {
                let _ = write!(writer.out, "\x1b[1;{}H\x1bH", column + 1);
            }
        }
        for index in 0..256 {
            if let Some(rgb) = self.colors[index] {
                let _ = write!(
                    writer.out,
                    "\x1b]4;{index};rgb:{:02x}/{:02x}/{:02x}\x1b\\",
                    rgb.r, rgb.g, rgb.b
                );
            }
        }
        for (named, osc) in
            [(NamedColor::Foreground, 10), (NamedColor::Background, 11), (NamedColor::Cursor, 12)]
        {
            if let Some(rgb) = self.colors[named] {
                let _ = write!(
                    writer.out,
                    "\x1b]{osc};rgb:{:02x}/{:02x}/{:02x}\x1b\\",
                    rgb.r, rgb.g, rgb.b
                );
            }
        }
        if let Some(title) = &self.title {
            let _ = write!(writer.out, "\x1b]2;{title}\x1b\\");
        }

        if alternate {
            // Entering the alternate screen copies the primary cursor into it and saves it
            // as the primary's saved cursor, which while the alternate screen is up always
            // equals the primary cursor.
            writer.cursor(primary, &primary.cursor, None, true);
            keyboard_stack(&mut writer.out, primary_keyboard);
            writer.pen(&Pen::default_pen());
            writer.link(None);
            writer.out.push_str("\x1b[?1049h\x1b[H");
            writer.rows(&self.grid, 0);
            writer.pen(&Pen::default_pen());
            writer.link(None);
            keyboard_stack(&mut writer.out, &self.keyboard_mode_stack);
        } else {
            keyboard_stack(&mut writer.out, primary_keyboard);
        }

        // The active screen's state. The region homes the cursor, so it comes first; the
        // saved cursor is stored with DECSC from its absolute position, before origin mode
        // (which homes the cursor again and makes positions relative to the region).
        let region = &self.scroll_region;
        let _ = write!(writer.out, "\x1b[{};{}r", region.start.0 + 1, region.end.0);
        writer.cursor(&self.grid, &self.grid.saved_cursor, None, false);
        writer.out.push_str("\x1b7");
        let origin = self.mode.contains(TermMode::ORIGIN).then_some(region.start);
        if origin.is_some() {
            writer.out.push_str("\x1b[?6h");
        }

        let mode_word = self.mode;
        for (flag, code) in [
            (TermMode::APP_CURSOR, "?1"),
            (TermMode::LINE_WRAP, "?7"),
            (TermMode::FOCUS_IN_OUT, "?1004"),
            (TermMode::ALTERNATE_SCROLL, "?1007"),
            (TermMode::URGENCY_HINTS, "?1042"),
            (TermMode::BRACKETED_PASTE, "?2004"),
            (TermMode::INSERT, "4"),
            (TermMode::LINE_FEED_NEW_LINE, "20"),
        ] {
            mode(&mut writer.out, mode_word.contains(flag), code);
        }
        // Mouse protocols are exclusive, and so are mouse encodings.
        for (flag, code) in [
            (TermMode::MOUSE_REPORT_CLICK, "?1000"),
            (TermMode::MOUSE_DRAG, "?1002"),
            (TermMode::MOUSE_MOTION, "?1003"),
            (TermMode::UTF8_MOUSE, "?1005"),
            (TermMode::SGR_MOUSE, "?1006"),
        ] {
            if mode_word.contains(flag) {
                mode(&mut writer.out, true, code);
            }
        }
        writer.out.push_str(if mode_word.contains(TermMode::APP_KEYPAD) {
            "\x1b="
        } else {
            "\x1b>"
        });
        if mode_word.contains(TermMode::MODIFY_OTHER_KEYS_2) {
            writer.out.push_str("\x1b[>4;2m");
        } else if mode_word.contains(TermMode::MODIFY_OTHER_KEYS_1) {
            writer.out.push_str("\x1b[>4;1m");
        }
        if let Some(style) = self.cursor_style {
            let code = match style.shape {
                CursorShape::Block => Some(1),
                CursorShape::Underline => Some(3),
                CursorShape::Beam => Some(5),
                CursorShape::HollowBlock | CursorShape::Hidden => None,
            };
            if let Some(code) = code {
                let _ = write!(writer.out, "\x1b[{} q", code + u8::from(!style.blinking));
            }
        }

        // Last, so nothing above moves it: the cursor, then the active character set.
        writer.cursor(&self.grid, &self.grid.cursor, origin, true);
        mode(&mut writer.out, mode_word.contains(TermMode::SHOW_CURSOR), "?25");
        writer.out.push(match self.active_charset {
            CharsetIndex::G1 => '\x0e',
            _ => '\x0f',
        });
        out.extend_from_slice(writer.out.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::event::VoidListener;
    use crate::term::Config;
    use crate::term::test::TermSize;
    use crate::vte::ansi;

    fn term(columns: usize, lines: usize) -> Term<VoidListener> {
        let config = Config { kitty_keyboard: true, modify_other_keys: true, ..Config::default() };
        Term::new(config, &TermSize::new(columns, lines), VoidListener)
    }

    fn feed(term: &mut Term<VoidListener>, bytes: &[u8]) {
        let mut parser = ansi::Processor::<ansi::StdSyncHandler>::new();
        parser.advance(term, bytes);
    }

    fn replayed(original: &Term<VoidListener>) -> Term<VoidListener> {
        let mut bytes = Vec::new();
        original.write_replay(&mut bytes);
        let mut rebuilt = term(original.columns(), original.screen_lines());
        feed(&mut rebuilt, &bytes);
        rebuilt
    }

    /// What a cell shows and carries, compared across the replay.
    type CellView = (char, Color, Color, Flags, Vec<char>, Option<Color>, Option<(String, String)>);

    fn cell_view(cell: &Cell) -> CellView {
        (
            if cell.c == '\t' { ' ' } else { cell.c },
            cell.fg,
            cell.bg,
            cell.flags,
            cell.zerowidth().map(<[char]>::to_vec).unwrap_or_default(),
            cell.underline_color(),
            cell.hyperlink().map(|link| (link.id().to_owned(), link.uri().to_owned())),
        )
    }

    fn assert_grids_equal(left: &Grid<Cell>, right: &Grid<Cell>, label: &str) {
        assert_eq!(left.history_size(), right.history_size(), "{label}: history");
        for line in -(left.history_size() as i32)..left.screen_lines() as i32 {
            for column in 0..left.columns() {
                let point = (Line(line), Column(column));
                assert_eq!(
                    cell_view(&left[point.0][point.1]),
                    cell_view(&right[point.0][point.1]),
                    "{label}: cell {line},{column}"
                );
            }
        }
    }

    fn assert_cursors_equal(left: &Cursor<Cell>, right: &Cursor<Cell>, wrap: bool, label: &str) {
        assert_eq!(left.point, right.point, "{label}: point");
        assert_eq!(cell_view(&left.template), cell_view(&right.template), "{label}: pen");
        assert_eq!(left.charsets, right.charsets, "{label}: charsets");
        if wrap {
            assert_eq!(left.input_needs_wrap, right.input_needs_wrap, "{label}: pending wrap");
        }
    }

    fn assert_replays(original: &Term<VoidListener>) {
        let rebuilt = replayed(original);
        assert_grids_equal(&original.grid, &rebuilt.grid, "active");
        assert_grids_equal(&original.inactive_grid, &rebuilt.inactive_grid, "inactive");
        assert_cursors_equal(&original.grid.cursor, &rebuilt.grid.cursor, true, "cursor");
        assert_cursors_equal(
            &original.grid.saved_cursor,
            &rebuilt.grid.saved_cursor,
            false,
            "saved",
        );
        if original.mode.contains(TermMode::ALT_SCREEN) {
            assert_cursors_equal(
                &original.inactive_grid.cursor,
                &rebuilt.inactive_grid.cursor,
                true,
                "primary cursor",
            );
        }
        assert_eq!(original.mode, rebuilt.mode, "mode");
        assert_eq!(original.scroll_region, rebuilt.scroll_region, "region");
        assert_eq!(original.tabs.tabs, rebuilt.tabs.tabs, "tabs");
        for index in 0..crate::term::color::COUNT {
            assert_eq!(original.colors[index], rebuilt.colors[index], "palette {index}");
        }
        assert_eq!(original.cursor_style, rebuilt.cursor_style, "cursor style");
        assert_eq!(original.title, rebuilt.title, "title");
        assert_eq!(original.keyboard_mode_stack, rebuilt.keyboard_mode_stack, "keyboard");
        assert_eq!(
            original.inactive_keyboard_mode_stack, rebuilt.inactive_keyboard_mode_stack,
            "inactive keyboard"
        );
        assert_eq!(original.active_charset, rebuilt.active_charset, "active charset");
    }

    #[test]
    fn a_shell_screen_with_history_wraps_and_attributes_replays_exactly() {
        let mut original = term(12, 4);
        feed(
            &mut original,
            "plain\r\n\x1b[1;31mbold red\x1b[0m and on\r\n\x1b[38;2;10;20;30;48;5;200mrgb\x1b[0m \
             \x1b[4:3;58;5;3mcurl\x1b[0m\r\nwide 漢字 here and wrapped past the margin\r\n\
             e\u{301}combined \x1b]8;id=x;https://merkur.sh\x1b\\link\x1b]8;;\x1b\\\r\n\
             \x1b[44m\x1b[Kcoloured erase\x1b[0m\r\n$ "
                .as_bytes(),
        );
        assert!(original.grid.history_size() > 0);
        assert_replays(&original);
    }

    #[test]
    fn a_wide_character_meeting_the_margin_keeps_its_leading_spacer() {
        let mut original = term(6, 3);
        feed(&mut original, "abcde漢字".as_bytes());
        assert!(original.grid[Line(0)][Column(5)].flags.contains(Flags::LEADING_WIDE_CHAR_SPACER));
        assert_replays(&original);
    }

    #[test]
    fn a_pending_wrap_at_the_margin_survives() {
        let mut original = term(5, 3);
        feed(&mut original, b"12345");
        assert!(original.grid.cursor.input_needs_wrap);
        assert_replays(&original);
    }

    #[test]
    fn an_alternate_screen_application_replays_both_screens_and_modes() {
        let mut original = term(20, 6);
        feed(
            &mut original,
            b"prompt$ vim file\r\n\x1b[5;10H\x1b7\x1b[2;3H\x1b[>1u\x1b[?1049h\x1b[>5u\x1b[>7u\
              \x1b[2;5r\x1b[?6h\x1b[?1;1004;1006;1002;2004h\x1b=\x1b[>4;2m\x1b[4 q\
              \x1b[H\x1b[7m status \x1b[0m\x1b[3;2H\x1b[3mtext\x1b[?25l\x1b(0q\x1b)0\x0e\
              \x1b]4;1;rgb:12/34/56\x1b\\\x1b]11;rgb:01/02/03\x1b\\\x1b]2;editing\x1b\\\
              \x1b[3g\x1b[1;4H\x1bH\x1b[4;6H",
        );
        assert!(original.mode.contains(TermMode::ALT_SCREEN));
        assert_replays(&original);
    }

    #[test]
    fn a_full_width_row_that_does_not_wrap_keeps_its_line_break() {
        let mut original = term(4, 3);
        feed(&mut original, b"abcd\r\nefgh\r\nij");
        assert_replays(&original);
    }
}
