//! Local screens (sign-in, machines, dialogs) paint into an offscreen
//! terminal, and the host receives only the cells that changed, through the
//! composer a remote session uses. A frame never clears the host: a pty hands
//! a multiplexer a frame in pieces, tmux may redraw its popup between them,
//! and a cleared screen redrawn halfway is a blank flash on every keystroke.

use alacritty_terminal::{
    event::VoidListener,
    grid::Dimensions,
    index::{Column, Line, Point},
    term::{Config, Term, TermMode, cell::Flags},
    vte::ansi::{Color, CursorShape, NamedColor, Processor},
};
use term_wasm::{
    DISPLAYED_BOLD, DISPLAYED_INVERSE, DISPLAYED_ITALIC, DISPLAYED_SPACER, DISPLAYED_UNDERLINE,
    DISPLAYED_WIDE, DisplayedCell, DisplayedCursor, DisplayedCursorShape,
};
use zeroize::Zeroize;

use crate::composer::{Composer, Presented};
use crate::host::HostSize;

/// A remote session may have left pointer reporting on; local screens take
/// no pointer input.
const POINTER_OFF: &[u8] = b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";

pub struct Chrome {
    screen: Screen,
    parser: Processor,
    composer: Composer,
    /// Local chrome drew the host's last frame.
    shown: bool,
    /// One painted screen; wiped once applied, as a host write buffer is.
    painted: Vec<u8>,
}

struct Screen(Term<VoidListener>);

struct Size {
    cols: usize,
    rows: usize,
}
impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

impl Default for Chrome {
    fn default() -> Self {
        let config = Config {
            scrolling_history: 0,
            ..Config::default()
        };
        Self {
            screen: Screen(Term::new(config, &Size { cols: 1, rows: 1 }, VoidListener)),
            parser: Processor::new(),
            composer: Composer::new(0),
            shown: false,
            painted: Vec::new(),
        }
    }
}

impl Chrome {
    /// Something else drew over the host screen.
    pub fn invalidate(&mut self) {
        self.composer.invalidate();
        self.shown = false;
    }

    /// Applies one painted screen, or a patch of the last, and writes what
    /// changed as exactly one frame ending in `CSI 5 n`. `paint` writes a
    /// complete synchronized update, as it would to the host.
    pub fn present(&mut self, size: HostSize, paint: impl FnOnce(&mut Vec<u8>), out: &mut Vec<u8>) {
        let size = Size {
            cols: usize::from(size.cols.max(1)),
            rows: usize::from(size.rows.max(1)),
        };
        let term = &mut self.screen.0;
        if (size.cols, size.rows) != (term.columns(), term.screen_lines()) {
            term.resize(size);
        }
        paint(&mut self.painted);
        self.parser.advance(term, &self.painted);
        self.painted.zeroize();
        if !self.shown {
            out.extend_from_slice(POINTER_OFF);
            self.shown = true;
        }
        if !self.composer.compose(&self.screen, out) {
            out.extend_from_slice(b"\x1b[?2026l\x1b[5n");
        }
    }
}

impl Presented for Screen {
    fn size(&self) -> (u16, u16) {
        (self.0.columns() as u16, self.0.screen_lines() as u16)
    }

    fn row(&self, row: u16, out: &mut Vec<DisplayedCell>) {
        out.clear();
        let grid = self.0.grid();
        let line = Line(i32::from(row));
        out.extend((0..grid.columns()).map(|col| {
            let cell = &grid[Point::new(line, Column(col))];
            let mut attrs = 0;
            for (flag, bit) in [
                (Flags::BOLD, DISPLAYED_BOLD),
                (Flags::ITALIC, DISPLAYED_ITALIC),
                (Flags::INVERSE, DISPLAYED_INVERSE),
                (Flags::WIDE_CHAR, DISPLAYED_WIDE),
                (Flags::WIDE_CHAR_SPACER, DISPLAYED_SPACER),
            ] {
                if cell.flags.contains(flag) {
                    attrs |= bit;
                }
            }
            if cell.flags.intersects(Flags::ALL_UNDERLINES) {
                attrs |= DISPLAYED_UNDERLINE;
            }
            DisplayedCell {
                c: if cell.c == '\0' { ' ' } else { cell.c },
                fg: rgb(cell.fg, NamedColor::Foreground),
                bg: rgb(cell.bg, NamedColor::Background),
                attrs,
            }
        }));
    }

    fn cursor(&self) -> Option<DisplayedCursor> {
        if !self.0.mode().contains(TermMode::SHOW_CURSOR) {
            return None;
        }
        let shape = match self.0.cursor_style().shape {
            CursorShape::Hidden => return None,
            CursorShape::Beam => DisplayedCursorShape::Beam,
            CursorShape::Underline => DisplayedCursorShape::Underline,
            CursorShape::Block | CursorShape::HollowBlock => DisplayedCursorShape::Block,
        };
        let point = self.0.grid().cursor.point;
        Some(DisplayedCursor {
            row: point.line.0 as u16,
            col: point.column.0 as u16,
            shape,
        })
    }
}

/// Local chrome paints explicit RGB or the host's default, nothing else.
fn rgb(color: Color, default: NamedColor) -> Option<[u8; 3]> {
    match color {
        Color::Spec(rgb) => Some([rgb.r, rgb.g, rgb.b]),
        Color::Named(named) if named == default => None,
        other => unreachable!("local chrome painted {other:?}"),
    }
}

#[cfg(test)]
mod tests;
