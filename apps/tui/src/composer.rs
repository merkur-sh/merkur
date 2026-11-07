//! What the host shows, kept in step with what the viewer presents.
//!
//! Each composition writes the cells that changed since the last, as one
//! synchronized-output frame of the fewest bytes the composer can prove exact:
//! each cursor move the shortest of CUP, CHA, CR, CUF/CUB and CUU/CUD from a
//! known position, a gap of up to three unchanged cells written through when
//! that is shorter than moving over it, each pen change the shorter of a reset
//! and per-attribute changes, and a row's blank tail erased with EL. It ends
//! with `CSI 5 n`: the host answers once it consumed the frame, the grant
//! signal Phase 0.2 settled on, since no host reports when it drew one. A
//! default colour stays the host's default, exactly as the daemon's cell says.
//! The composer owns only its area, `origin` rows down the host's screen.

use merkur_client_native::grid::NativeGrid;
use term_wasm::{
    DISPLAYED_BOLD, DISPLAYED_INVERSE, DISPLAYED_ITALIC, DISPLAYED_SPACER, DISPLAYED_UNDERLINE,
    DISPLAYED_WIDE, DisplayedCell, DisplayedCursor, DisplayedCursorShape,
};

/// The attributes a pen carries; width is the cell's, not the pen's.
const STYLE: u8 = DISPLAYED_BOLD | DISPLAYED_ITALIC | DISPLAYED_UNDERLINE | DISPLAYED_INVERSE;

/// What a row was made from when it was read: the presentation commit that
/// last rewrote it, and the link table that resolves its links.
pub type Revision = (u64, u64);

/// What the viewer presents, row by row.
pub trait Presented {
    /// `(columns, rows)`.
    fn size(&self) -> (u16, u16);
    fn row(&self, row: u16, out: &mut Vec<DisplayedCell>);
    fn cursor(&self) -> Option<DisplayedCursor>;
    fn links(&self, _row: u16, out: &mut Vec<u32>) {
        out.clear();
    }
    fn link_uri(&self, _id: u32) -> Option<&str> {
        None
    }
    /// What `row`, its links and their URIs are made from. While it stands
    /// still the row reads the same, so the composer does not read it again.
    /// `None`, the default, is a row that can differ from one read to the next.
    fn revision(&self, _row: u16) -> Option<Revision> {
        None
    }
}

impl Presented for NativeGrid {
    fn size(&self) -> (u16, u16) {
        let terminal = self.terminal();
        (terminal.presentation_cols(), terminal.presentation_rows())
    }

    fn row(&self, row: u16, out: &mut Vec<DisplayedCell>) {
        self.terminal().displayed_row(row, out);
    }

    /// A row under a speculative echo changes with the echo, not with a commit.
    fn revision(&self, row: u16) -> Option<Revision> {
        let terminal = self.terminal();
        if terminal.row_holds_prediction(row) {
            return None;
        }
        Some((terminal.presentation_row_commit(row)?, 0))
    }

    fn cursor(&self) -> Option<DisplayedCursor> {
        self.terminal().displayed_cursor()
    }
}

pub struct Composer {
    /// The host row the area starts at.
    origin: u16,
    cols: u16,
    rows: u16,
    /// What the host shows in the area, as far as the composer wrote it.
    shown: Vec<DisplayedCell>,
    shown_cursor: Option<DisplayedCursor>,
    shown_links: Vec<u32>,
    /// What each row was made from when `shown` last took it in.
    shown_revisions: Vec<Option<Revision>>,
    next_links: Vec<u32>,
    /// The host's screen under the area is unknown: the next composition
    /// paints all of it.
    stale: bool,
    next: Vec<DisplayedCell>,
}

impl Composer {
    pub fn new(origin: u16) -> Self {
        Self {
            origin,
            cols: 0,
            rows: 0,
            shown: Vec::new(),
            shown_cursor: None,
            shown_links: Vec::new(),
            shown_revisions: Vec::new(),
            next_links: Vec::new(),
            stale: true,
            next: Vec::new(),
        }
    }

    /// Something else drew over the area, or the host cleared it.
    pub fn invalidate(&mut self) {
        self.stale = true;
    }

    /// The next composition paints the whole area: the host's screen is unknown.
    pub fn is_stale(&self) -> bool {
        self.stale
    }

    /// Whether the composer holds exactly what `source` presents now, row for
    /// row: what a composition that read every row would have left.
    #[cfg(test)]
    pub(crate) fn mirrors(&self, source: &impl Presented) -> bool {
        let (cols, rows) = source.size();
        let (mut cells, mut links) = (Vec::new(), Vec::new());
        (cols, rows) == (self.cols, self.rows)
            && (0..rows).all(|row| {
                source.row(row, &mut cells);
                cells.resize(usize::from(cols), DisplayedCell::BLANK);
                source.links(row, &mut links);
                links.resize(usize::from(cols), 0);
                for id in &mut links {
                    if *id != 0 && source.link_uri(*id).is_none() {
                        *id = 0;
                    }
                }
                let from = usize::from(row) * usize::from(cols);
                let shown = from..from + usize::from(cols);
                cells == self.shown[shown.clone()] && links == self.shown_links[shown]
            })
    }

    /// Writes one frame of what changed, fence included. False, and nothing
    /// written, when nothing did.
    pub fn compose(&mut self, source: &impl Presented, out: &mut Vec<u8>) -> bool {
        let (cols, rows) = source.size();
        if (cols, rows) != (self.cols, self.rows) {
            (self.cols, self.rows) = (cols, rows);
            self.shown = vec![DisplayedCell::BLANK; usize::from(cols) * usize::from(rows)];
            self.shown_links.resize(self.shown.len(), 0);
            self.shown_revisions.resize(usize::from(rows), None);
            self.stale = true;
        }
        let start = out.len();
        out.extend_from_slice(b"\x1b[?2026h");
        let body = out.len();
        let mut writer = Writer {
            out,
            origin: self.origin,
            cols,
            pen: None,
            at: None,
            link: 0,
        };
        for row in 0..rows {
            // A row made from what `shown` already holds is neither read nor
            // compared: a keystroke costs its own row, not the screen.
            let revision = source.revision(row);
            let shown_revision = &mut self.shown_revisions[usize::from(row)];
            if !self.stale && revision.is_some() && revision == *shown_revision {
                continue;
            }
            *shown_revision = revision;
            source.row(row, &mut self.next);
            self.next.resize(usize::from(cols), DisplayedCell::BLANK);
            source.links(row, &mut self.next_links);
            self.next_links.resize(usize::from(cols), 0);
            // Definitions can arrive after their cells on the independent
            // control lane. Repaint exactly those cells when the URI lands.
            for id in &mut self.next_links {
                if *id != 0 && source.link_uri(*id).is_none() {
                    *id = 0;
                }
            }
            let from = usize::from(row) * usize::from(cols);
            let shown = &mut self.shown[from..from + usize::from(cols)];
            compose_row(
                &mut writer,
                row,
                &self.next,
                shown,
                (
                    &self.next_links,
                    &mut self.shown_links[from..from + usize::from(cols)],
                ),
                source,
                self.stale,
            );
        }
        writer.link(0, None);
        let cursor = source.cursor();
        let styled = writer.pen.is_some_and(|pen| pen != Pen::DEFAULT);
        if writer.out.len() > body || self.stale || cursor != self.shown_cursor {
            writer.cursor(cursor, if self.stale { None } else { self.shown_cursor });
        }
        self.stale = false;
        self.shown_cursor = cursor;
        if out.len() == body {
            out.truncate(start);
            return false;
        }
        // What follows in the host's stream starts from a plain pen.
        if styled {
            out.extend_from_slice(b"\x1b[m");
        }
        out.extend_from_slice(b"\x1b[?2026l\x1b[5n");
        true
    }
}

fn compose_row(
    writer: &mut Writer<'_>,
    row: u16,
    next: &[DisplayedCell],
    shown: &mut [DisplayedCell],
    links: (&[u32], &mut [u32]),
    source: &impl Presented,
    stale: bool,
) {
    let (next_links, shown_links) = links;
    let cols = next.len();
    let tail = blank_tail(next).max(
        next_links
            .iter()
            .rposition(|&id| id != 0)
            .map_or(0, |at| at + 1),
    );
    let mut col = 0;
    while col < tail {
        let width = unit_width(next, col);
        let unit = col..col + width;
        if stale
            || next[unit.clone()] != shown[unit.clone()]
            || next_links[unit.clone()] != shown_links[unit.clone()]
        {
            let at = col as u16;
            // Only a gap of one to three cells on this row can be written
            // through for less than a move; anything else skips the call.
            if let Some((at_row, at_col)) = writer.at
                && at_row == row
                && at > at_col
                && at - at_col <= 3
            {
                writer.write_through(row, at, next, next_links);
            }
            writer.link(next_links[col], source.link_uri(next_links[col]));
            writer.cell(row, at, next[col], width);
            shown[unit.clone()].copy_from_slice(&next[unit.clone()]);
            shown_links[unit.clone()].copy_from_slice(&next_links[unit]);
        }
        col += width;
    }
    if tail < cols
        && (stale || next[tail..] != shown[tail..] || next_links[tail..] != shown_links[tail..])
    {
        writer.link(0, None);
        writer.erase_tail(row, tail as u16, next[tail].bg);
        shown[tail..].copy_from_slice(&next[tail..]);
        shown_links[tail..].copy_from_slice(&next_links[tail..]);
    }
}

/// A wide character draws the spacer after it too.
#[inline]
fn unit_width(next: &[DisplayedCell], col: usize) -> usize {
    if next[col].attrs & DISPLAYED_WIDE != 0 && col + 1 < next.len() {
        2
    } else {
        1
    }
}

/// Where the row's trailing run of plain blanks in one background starts:
/// what EL paints in a single sequence.
fn blank_tail(row: &[DisplayedCell]) -> usize {
    let Some(last) = row.last() else {
        return 0;
    };
    let plain = |cell: &DisplayedCell| cell.c == ' ' && cell.attrs == 0 && cell.bg == last.bg;
    row.iter()
        .rposition(|cell| !plain(cell))
        .map_or(0, |at| at + 1)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Pen {
    fg: Option<[u8; 3]>,
    bg: Option<[u8; 3]>,
    attrs: u8,
}

impl Pen {
    const DEFAULT: Pen = Pen {
        fg: None,
        bg: None,
        attrs: 0,
    };
}

struct Writer<'a> {
    out: &'a mut Vec<u8>,
    origin: u16,
    cols: u16,
    /// The host's pen; unknown at the start of a frame.
    pen: Option<Pen>,
    /// The host's cursor in the area, when the composer knows it.
    at: Option<(u16, u16)>,
    link: u32,
}

impl Writer<'_> {
    fn link(&mut self, id: u32, uri: Option<&str>) {
        let uri = uri.and_then(merkur_client::viewer::links::host_uri);
        let id = if uri.is_some() { id } else { 0 };
        if id == self.link {
            return;
        }
        self.out.extend_from_slice(b"\x1b]8;;");
        if let Some(uri) = uri {
            self.out.extend_from_slice(uri.as_bytes());
        }
        self.out.extend_from_slice(b"\x1b\\");
        self.link = id;
    }

    /// Reaches `(row, col)` with the fewest bytes among the moves whose result
    /// is exact from a known position: CR, CHA or CUF/CUB on the same row (always
    /// shorter than CUP there), CUU/CUD then a column move, or CUP, which is the
    /// only move from an unknown one.
    fn move_to(&mut self, row: u16, col: u16) {
        let Some((at_row, at_col)) = self.at else {
            return self.position(row, col);
        };
        if at_row == row {
            if at_col != col {
                ColumnMove::new(at_col, col).push(self.out);
                self.at = Some((row, col));
            }
            return;
        }
        let rows = at_row.abs_diff(row);
        let column = ColumnMove::new(at_col, col);
        let relative = count_sequence_len(rows) + column.len();
        let absolute = 3
            + digits(self.origin.saturating_add(row).saturating_add(1))
            + if col == 0 { 0 } else { 1 + digits(col + 1) };
        if relative >= absolute {
            return self.position(row, col);
        }
        self.out.extend_from_slice(b"\x1b[");
        push_count(self.out, rows);
        self.out.push(if row > at_row { b'B' } else { b'A' });
        column.push(self.out);
        self.at = Some((row, col));
    }

    /// CUP, without the column when it is the first.
    fn position(&mut self, row: u16, col: u16) {
        self.out.extend_from_slice(b"\x1b[");
        push_decimal(self.out, u32::from(self.origin) + u32::from(row) + 1);
        if col != 0 {
            self.out.push(b';');
            push_decimal(self.out, u32::from(col) + 1);
        }
        self.out.push(b'H');
        self.at = Some((row, col));
    }

    /// Writes the unchanged cells between the host's cursor and `col` when
    /// that costs fewer bytes than moving over them: single-width cells in the
    /// current pen and link, written exactly as `cell` writes them, so the
    /// host is left as it was and no cell can issue a host control.
    #[inline(never)]
    fn write_through(&mut self, row: u16, col: u16, next: &[DisplayedCell], links: &[u32]) {
        let Some((at_row, at_col)) = self.at else {
            return;
        };
        // Every cell costs at least a byte and the shortest forward move three
        // (`CSI C`), four from a gap of two on: only a gap of up to three can
        // be cheaper, and a longer one is decided without reading it.
        if at_row != row || col <= at_col || col - at_col > 3 {
            return;
        }
        let Some(pen) = self.pen else {
            return;
        };
        let gap = usize::from(at_col)..usize::from(col);
        let mut bytes = 0;
        for (cell, &link) in next[gap.clone()].iter().zip(&links[gap.clone()]) {
            let cell_pen = Pen {
                fg: cell.fg,
                bg: cell.bg,
                attrs: cell.attrs & STYLE,
            };
            if cell.attrs & (DISPLAYED_WIDE | DISPLAYED_SPACER) != 0
                || cell_pen != pen
                || link != self.link
            {
                return;
            }
            bytes += glyph_len(cell.c);
        }
        if bytes >= ColumnMove::new(at_col, col).len() {
            return;
        }
        for cell in &next[gap] {
            push_glyph(self.out, cell.c, 1);
        }
        self.at = Some((row, col));
    }

    // Glyph encoding stays out of the row comparison loop.
    #[inline(never)]
    fn cell(&mut self, row: u16, col: u16, cell: DisplayedCell, width: usize) {
        self.move_to(row, col);
        let next = col + width as u16;
        // At the last column the host holds a pending wrap: the next write
        // must place itself.
        self.at = (next < self.cols).then_some((row, next));
        self.pen(Pen {
            fg: cell.fg,
            bg: cell.bg,
            attrs: cell.attrs & STYLE,
        });
        // A wide character clipped to one column leaves a blank.
        let c = if cell.attrs & DISPLAYED_WIDE != 0 && width == 1 {
            ' '
        } else {
            cell.c
        };
        push_glyph(self.out, c, width);
    }

    fn erase_tail(&mut self, row: u16, col: u16, bg: Option<[u8; 3]>) {
        self.move_to(row, col);
        self.pen(Pen { bg, ..Pen::DEFAULT });
        self.out.extend_from_slice(b"\x1b[K");
    }

    /// Moves the host's pen to `next` in one SGR, by whichever of a reset or
    /// the exact per-attribute changes is shorter; an unknown pen takes the reset.
    fn pen(&mut self, next: Pen) {
        if self.pen == Some(next) {
            return;
        }
        // With no attribute to turn off and no colour returning to the
        // default, the per-attribute changes are a subset of what a reset
        // must restate, so only the other cases compare.
        let from = match self.pen {
            Some(pen)
                if (pen.attrs & !next.attrs == 0
                    && (next.fg.is_some() || pen.fg.is_none())
                    && (next.bg.is_some() || pen.bg.is_none()))
                    || changes_beat_reset(pen, next) =>
            {
                Some(pen)
            }
            _ => None,
        };
        self.out.extend_from_slice(b"\x1b[");
        let (from, mut separator) = match from {
            Some(pen) => (pen, false),
            None => {
                self.out.push(b'0');
                (Pen::DEFAULT, true)
            }
        };
        let mut param = |out: &mut Vec<u8>, text: &[u8]| {
            if separator {
                out.push(b';');
            }
            separator = true;
            out.extend_from_slice(text);
        };
        for &(bit, on, off) in &ATTRIBUTE_CODES {
            if next.attrs & bit != 0 && from.attrs & bit == 0 {
                param(self.out, on);
            } else if next.attrs & bit == 0 && from.attrs & bit != 0 {
                param(self.out, off);
            }
        }
        for (color, was, default, spec) in [
            (next.fg, from.fg, &b"39"[..], &b"38;2;"[..]),
            (next.bg, from.bg, b"49", b"48;2;"),
        ] {
            if color == was {
                continue;
            }
            match color {
                None => param(self.out, default),
                Some([r, g, b]) => {
                    param(self.out, spec);
                    push_channel(self.out, r);
                    self.out.push(b';');
                    push_channel(self.out, g);
                    self.out.push(b';');
                    push_channel(self.out, b);
                }
            }
        }
        self.out.push(b'm');
        self.pen = Some(next);
    }

    fn cursor(&mut self, cursor: Option<DisplayedCursor>, shown: Option<DisplayedCursor>) {
        let Some(cursor) = cursor else {
            self.out.extend_from_slice(b"\x1b[?25l");
            return;
        };
        self.move_to(cursor.row, cursor.col);
        if shown.is_none_or(|shown| shown.shape != cursor.shape) {
            self.out.extend_from_slice(match cursor.shape {
                DisplayedCursorShape::Block => b"\x1b[2 q",
                DisplayedCursorShape::Underline => b"\x1b[4 q",
                DisplayedCursorShape::Beam => b"\x1b[6 q",
            });
        }
        if shown.is_none() {
            self.out.extend_from_slice(b"\x1b[?25h");
        }
    }
}

/// Writes a cell's glyph over its `width` columns. Cell data cannot issue
/// host controls: a C0, C1 or DEL cell keeps its declared columns as blanks.
#[inline]
fn push_glyph(out: &mut Vec<u8>, c: char, width: usize) {
    if ('!'..='~').contains(&c) {
        out.push(c as u8);
    } else if c <= '\u{9f}' {
        out.extend_from_slice(&b"  "[..width]);
    } else {
        let mut utf8 = [0; 4];
        match c.encode_utf8(&mut utf8).len() {
            2 => out.extend_from_slice(&utf8[..2]),
            3 => out.extend_from_slice(&utf8[..3]),
            _ => out.extend_from_slice(&utf8),
        }
    }
}

/// The bytes `push_glyph` writes for a single-width cell.
#[inline]
fn glyph_len(c: char) -> usize {
    if c <= '\u{9f}' { 1 } else { c.len_utf8() }
}

/// Each style bit's SGR codes: on, then off. 22 also ends faint, which no pen
/// carries.
const ATTRIBUTE_CODES: [(u8, &[u8], &[u8]); 4] = [
    (DISPLAYED_BOLD, b"1", b"22"),
    (DISPLAYED_ITALIC, b"3", b"23"),
    (DISPLAYED_UNDERLINE, b"4", b"24"),
    (DISPLAYED_INVERSE, b"7", b"27"),
];

/// Whether turning attributes off one by one is shorter than a reset, from the
/// parameters only one of the two forms writes: each turned-off attribute and
/// each colour returning to the default (`;22`, `;39`), against the reset's
/// `0;`, its restated kept attributes (`1;`) and restated unchanged colours
/// (`38;2;r;g;b;`). Added attributes and newly set colours cost both the same.
fn changes_beat_reset(from: Pen, next: Pen) -> bool {
    let mut changes = 3 * (from.attrs & !next.attrs).count_ones() as usize;
    let mut reset = 2 + 2 * (from.attrs & next.attrs).count_ones() as usize;
    for (color, was) in [(next.fg, from.fg), (next.bg, from.bg)] {
        match (color == was, color) {
            (true, Some([r, g, b])) => {
                reset += 8 + digits(r.into()) + digits(g.into()) + digits(b.into());
            }
            (false, None) => changes += 3,
            _ => {}
        }
    }
    changes <= reset
}

/// Bytes of a cursor-motion sequence moving `count` cells: `ESC [ n X`, with
/// the count omitted when it is one.
fn count_sequence_len(count: u16) -> usize {
    3 + if count == 1 { 0 } else { digits(count) }
}

fn push_count(out: &mut Vec<u8>, count: u16) {
    if count != 1 {
        push_decimal(out, u32::from(count));
    }
}

/// The shortest exact move between two columns of one row.
#[derive(Clone, Copy)]
enum ColumnMove {
    Stay,
    /// CR, to the first column.
    Return,
    /// CHA to a 1-based column.
    Absolute(u16),
    /// CUF.
    Forward(u16),
    /// CUB.
    Back(u16),
}

impl ColumnMove {
    #[inline]
    fn new(from: u16, to: u16) -> Self {
        if from == to {
            return Self::Stay;
        }
        if to == 0 {
            return Self::Return;
        }
        let distance = from.abs_diff(to);
        if 3 + digits(to + 1) <= count_sequence_len(distance) {
            Self::Absolute(to + 1)
        } else if to > from {
            Self::Forward(distance)
        } else {
            Self::Back(distance)
        }
    }

    #[inline]
    fn len(self) -> usize {
        match self {
            Self::Stay => 0,
            Self::Return => 1,
            Self::Absolute(column) => 3 + digits(column),
            Self::Forward(count) | Self::Back(count) => count_sequence_len(count),
        }
    }

    fn push(self, out: &mut Vec<u8>) {
        let (count, end) = match self {
            Self::Stay => return,
            Self::Return => return out.push(b'\r'),
            Self::Absolute(column) => {
                out.extend_from_slice(b"\x1b[");
                push_decimal(out, u32::from(column));
                return out.push(b'G');
            }
            Self::Forward(count) => (count, b'C'),
            Self::Back(count) => (count, b'D'),
        };
        out.extend_from_slice(b"\x1b[");
        push_count(out, count);
        out.push(end);
    }
}

/// Decimal digits of a terminal coordinate or count.
#[inline]
fn digits(value: u16) -> usize {
    1 + usize::from(value >= 10)
        + usize::from(value >= 100)
        + usize::from(value >= 1000)
        + usize::from(value >= 10000)
}

/// Every colour channel's decimal digits, so an SGR colour is written by
/// table lookup rather than by division: `[len, d0, d1, d2]`.
static CHANNEL_DIGITS: [[u8; 4]; 256] = {
    let mut table = [[0u8; 4]; 256];
    let mut v: u8 = 0;
    loop {
        table[v as usize] = if v >= 100 {
            [3, b'0' + v / 100, b'0' + v / 10 % 10, b'0' + v % 10]
        } else if v >= 10 {
            [2, b'0' + v / 10, b'0' + v % 10, 0]
        } else {
            [1, b'0' + v, 0, 0]
        };
        if v == u8::MAX {
            break table;
        }
        v += 1;
    }
};

#[inline]
fn push_channel(out: &mut Vec<u8>, value: u8) {
    let [len, digits @ ..] = &CHANNEL_DIGITS[usize::from(value)];
    out.extend_from_slice(&digits[..usize::from(*len)]);
}

fn push_decimal(out: &mut Vec<u8>, value: u32) {
    if let Ok(small) = u8::try_from(value) {
        return push_channel(out, small);
    }
    let mut digits = [0; 10];
    let mut at = digits.len();
    let mut value = value;
    loop {
        at -= 1;
        digits[at] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    out.extend_from_slice(&digits[at..]);
}

#[cfg(test)]
mod tests;
