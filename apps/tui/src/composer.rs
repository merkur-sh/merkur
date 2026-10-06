//! What the host shows, kept in step with what the viewer presents.
//!
//! Each composition writes only the cells that changed since the last, in the
//! fewest SGR changes, erasing a row's blank tail with EL, as one
//! synchronized-output frame. It ends with `CSI 5 n`: the host answers once
//! it consumed the frame, the grant signal Phase 0.2 settled on, since no
//! host reports when it drew one. A default colour stays the host's default,
//! exactly as the daemon's cell says. The composer owns only its area,
//! `origin` rows down the host's screen.

use merkur_client_native::grid::NativeGrid;
use term_wasm::{
    DISPLAYED_BOLD, DISPLAYED_INVERSE, DISPLAYED_ITALIC, DISPLAYED_UNDERLINE, DISPLAYED_WIDE,
    DisplayedCell, DisplayedCursor, DisplayedCursorShape,
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
        let cell = next[col];
        // A wide character draws the spacer after it too.
        let width = if cell.attrs & DISPLAYED_WIDE != 0 && col + 1 < cols {
            2
        } else {
            1
        };
        let unit = col..col + width;
        if stale
            || next[unit.clone()] != shown[unit.clone()]
            || next_links[unit.clone()] != shown_links[unit.clone()]
        {
            writer.link(next_links[col], source.link_uri(next_links[col]));
            writer.cell(row, col as u16, cell, width);
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

    fn move_to(&mut self, row: u16, col: u16) {
        if self.at == Some((row, col)) {
            return;
        }
        self.out.extend_from_slice(b"\x1b[");
        push_decimal(self.out, u32::from(self.origin) + u32::from(row) + 1);
        self.out.push(b';');
        push_decimal(self.out, u32::from(col) + 1);
        self.out.push(b'H');
        self.at = Some((row, col));
    }

    fn cell(&mut self, row: u16, col: u16, cell: DisplayedCell, width: usize) {
        self.move_to(row, col);
        self.pen(Pen {
            fg: cell.fg,
            bg: cell.bg,
            attrs: cell.attrs & STYLE,
        });
        // A wide character with no room for its second column is shown as
        // what the host would leave there: a blank.
        let c = if cell.attrs & DISPLAYED_WIDE != 0 && width == 1 {
            ' '
        } else {
            cell.c
        };
        let mut utf8 = [0; 4];
        self.out
            .extend_from_slice(c.encode_utf8(&mut utf8).as_bytes());
        let next = col + width as u16;
        // At the last column the host holds a pending wrap: the next write
        // must place itself.
        self.at = (next < self.cols).then_some((row, next));
    }

    fn erase_tail(&mut self, row: u16, col: u16, bg: Option<[u8; 3]>) {
        self.move_to(row, col);
        self.pen(Pen { bg, ..Pen::DEFAULT });
        self.out.extend_from_slice(b"\x1b[K");
    }

    fn pen(&mut self, next: Pen) {
        if self.pen == Some(next) {
            return;
        }
        self.out.extend_from_slice(b"\x1b[");
        // Turning an attribute off takes a reset; adding one does not.
        let (from, mut separator) = match self.pen {
            Some(pen) if pen.attrs & !next.attrs == 0 => (pen, false),
            _ => {
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
        for (bit, code) in [
            (DISPLAYED_BOLD, &b"1"[..]),
            (DISPLAYED_ITALIC, b"3"),
            (DISPLAYED_UNDERLINE, b"4"),
            (DISPLAYED_INVERSE, b"7"),
        ] {
            if next.attrs & bit != 0 && from.attrs & bit == 0 {
                param(self.out, code);
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
                    push_decimal(self.out, u32::from(r));
                    self.out.push(b';');
                    push_decimal(self.out, u32::from(g));
                    self.out.push(b';');
                    push_decimal(self.out, u32::from(b));
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
        self.at = None;
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

fn push_decimal(out: &mut Vec<u8>, value: u32) {
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
