pub const HAS_FG: u8 = 1 << 0;
pub const HAS_BG: u8 = 1 << 1;
pub const WIDE: u8 = 1 << 2;
pub const BOLD: u8 = 1 << 3;
pub const ITALIC: u8 = 1 << 4;
pub const UNDERLINE: u8 = 1 << 5;
pub const INVERSE: u8 = 1 << 6;
pub const RLE: u8 = 1 << 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellTag(pub u8);

impl CellTag {
    #[inline]
    pub fn has_fg(self) -> bool {
        self.0 & HAS_FG != 0
    }

    #[inline]
    pub fn has_bg(self) -> bool {
        self.0 & HAS_BG != 0
    }

    #[inline]
    pub fn is_wide(self) -> bool {
        self.0 & WIDE != 0
    }

    #[inline]
    pub fn is_bold(self) -> bool {
        self.0 & BOLD != 0
    }

    #[inline]
    pub fn is_italic(self) -> bool {
        self.0 & ITALIC != 0
    }

    #[inline]
    pub fn is_underline(self) -> bool {
        self.0 & UNDERLINE != 0
    }

    #[inline]
    pub fn is_inverse(self) -> bool {
        self.0 & INVERSE != 0
    }

    #[inline]
    pub fn is_rle(self) -> bool {
        self.0 & RLE != 0
    }
}

/// A cell's shape and style bits in one byte, laid out exactly as the row
/// digest's flags byte, so hashing copies it and the wire tag is a shift.
///
/// Packed rather than six `bool` fields because [`CellRepr`] is copied, compared
/// and retained per cell on every capture, diff and ACK baseline: six bools and a
/// link id make a 20-byte cell, one byte and a link id keep it at 16.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct CellAttrs(u8);

impl CellAttrs {
    pub const NONE: CellAttrs = CellAttrs(0);
    pub const WIDE: CellAttrs = CellAttrs(1 << 0);
    pub const BOLD: CellAttrs = CellAttrs(1 << 1);
    pub const ITALIC: CellAttrs = CellAttrs(1 << 2);
    pub const UNDERLINE: CellAttrs = CellAttrs(1 << 3);
    pub const INVERSE: CellAttrs = CellAttrs(1 << 4);
    /// Row-scoped: "this row's content continues on the next row".
    ///
    /// It is a property of the *row*, parked on the row's final cell because
    /// that is where alacritty's reflow reads it from — `grow_columns` tests
    /// `row[row.len() - 1]`, the last physical column, and nothing else. A
    /// `WRAPLINE` anywhere else in a row is invisible to reflow, so row
    /// builders stamp only the final cell and [`CellRepr::from_alacritty`]
    /// never sets it at all: a conversion that sees one cell cannot know whether
    /// it is the last one, and guessing would put the bit on cells reflow
    /// ignores.
    ///
    /// It rides the wire as one bit in the row prefix rather than a cell tag
    /// bit — the tag byte is fully allocated, and a row-scoped fact has no
    /// business costing a bit on every cell. Encoders derive it from the last
    /// cell of the span they emit; see `ROW_FLAG_WRAPPED`.
    pub const WRAPPED: CellAttrs = CellAttrs(1 << 5);
    /// Explicit background paint whose RGB equals the default background. Other
    /// explicit backgrounds are already distinguishable by their RGB. The wire
    /// carries this fact by retaining `HAS_BG` and the explicit color, including
    /// when it equals the default. Ordinary default cells pay no extra bytes.
    pub const EXPLICIT_DEFAULT_BG: CellAttrs = CellAttrs(1 << 6);
    /// Shape/style bits carried directly by the wire tag.
    const TAG_BITS: u8 = 0b1_1111;
    /// Wire tag bits sit two above their attribute bits, past `HAS_FG`/`HAS_BG`.
    const TAG_SHIFT: u32 = 2;

    #[inline]
    pub const fn bits(self) -> u8 {
        self.0
    }

    #[inline]
    pub const fn contains(self, other: CellAttrs) -> bool {
        self.0 & other.0 == other.0
    }

    /// `self` with `other` set when `on`, cleared otherwise.
    #[inline]
    pub const fn with(self, other: CellAttrs, on: bool) -> CellAttrs {
        if on {
            CellAttrs(self.0 | other.0)
        } else {
            CellAttrs(self.0 & !other.0)
        }
    }

    /// The attributes a wire tag names; never [`Self::WRAPPED`].
    #[inline]
    pub const fn from_tag(tag: u8) -> CellAttrs {
        CellAttrs((tag >> Self::TAG_SHIFT) & Self::TAG_BITS)
    }

    /// The color-presence bit also carries explicit default-background paint.
    #[inline]
    pub const fn from_tag_and_background(tag: u8, bg: [u8; 3]) -> CellAttrs {
        Self::from_tag(tag).with(
            Self::EXPLICIT_DEFAULT_BG,
            tag & HAS_BG != 0
                && bg[0] == crate::theme::DEFAULT_BACKGROUND[0]
                && bg[1] == crate::theme::DEFAULT_BACKGROUND[1]
                && bg[2] == crate::theme::DEFAULT_BACKGROUND[2],
        )
    }

    #[inline]
    const fn tag_bits(self) -> u8 {
        (self.0 & Self::TAG_BITS) << Self::TAG_SHIFT
    }
}

impl std::ops::BitOr for CellAttrs {
    type Output = CellAttrs;

    #[inline]
    fn bitor(self, other: CellAttrs) -> CellAttrs {
        CellAttrs(self.0 | other.0)
    }
}

impl std::ops::BitOrAssign for CellAttrs {
    #[inline]
    fn bitor_assign(&mut self, other: CellAttrs) {
        self.0 |= other.0;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellRepr {
    pub codepoint: u32,
    /// OSC 8 hyperlink id, or 0 for a cell outside any link.
    ///
    /// The id names a URI the daemon interned and delivered on the reliable
    /// control lane; the URI itself never rides a display datagram, because an
    /// OSC 8 target has no length bound and a datagram does. It is a cell field
    /// rather than a side table so every consumer that compares, diffs, or
    /// retains cells — changed-range selection, ACK baselines, captured rows —
    /// sees a link change exactly like a glyph change. On the wire it rides a
    /// per-row span table (`ROW_FLAG_LINKS`), never a cell tag bit, so a row
    /// with no links pays nothing.
    pub link: u32,
    pub fg: [u8; 3],
    pub bg: [u8; 3],
    pub attrs: CellAttrs,
}

const _: () = assert!(std::mem::size_of::<CellRepr>() == 16);

impl CellRepr {
    pub const BLANK: CellRepr = CellRepr {
        codepoint: 0,
        link: 0,
        fg: crate::theme::DEFAULT_FOREGROUND,
        bg: crate::theme::DEFAULT_BACKGROUND,
        attrs: CellAttrs::NONE,
    };

    #[inline]
    pub const fn wide(&self) -> bool {
        self.attrs.contains(CellAttrs::WIDE)
    }

    #[inline]
    pub const fn bold(&self) -> bool {
        self.attrs.contains(CellAttrs::BOLD)
    }

    #[inline]
    pub const fn italic(&self) -> bool {
        self.attrs.contains(CellAttrs::ITALIC)
    }

    #[inline]
    pub const fn underline(&self) -> bool {
        self.attrs.contains(CellAttrs::UNDERLINE)
    }

    #[inline]
    pub const fn inverse(&self) -> bool {
        self.attrs.contains(CellAttrs::INVERSE)
    }

    #[inline]
    pub fn has_explicit_background(&self) -> bool {
        self.bg != crate::theme::DEFAULT_BACKGROUND
            || self.attrs.contains(CellAttrs::EXPLICIT_DEFAULT_BG)
    }

    /// See [`CellAttrs::WRAPPED`].
    #[inline]
    pub const fn wrapped(&self) -> bool {
        self.attrs.contains(CellAttrs::WRAPPED)
    }

    #[inline]
    pub fn set_wrapped(&mut self, wrapped: bool) {
        self.attrs = self.attrs.with(CellAttrs::WRAPPED, wrapped);
    }

    /// Canonical conversion from an Alacritty cell to a transport-ready CellRepr.
    /// Both the daemon (encoder) and term-wasm (heartbeat hasher) MUST call this
    /// so their row hashes agree byte-for-byte.
    ///
    /// It leaves [`CellAttrs::WRAPPED`] clear. Row builders stamp that on the
    /// row's final cell with [`cell_wraps`]. It also leaves [`CellRepr::link`]
    /// clear: the id comes from the daemon's link table or the receiver's link
    /// grid, neither of which a one-cell conversion can see.
    #[inline]
    pub fn from_alacritty(cell: &alacritty_terminal::term::cell::Cell) -> CellRepr {
        Self::from_alacritty_with_colors(
            cell,
            crate::theme::resolve_color(cell.fg),
            crate::theme::resolve_color(cell.bg),
        )
    }

    /// Convert a cell whose colors were already resolved by a caller-side
    /// cache. The field mapping stays centralized here so cached row scans and
    /// one-off conversions cannot drift apart.
    #[inline]
    pub fn from_alacritty_with_colors(
        cell: &alacritty_terminal::term::cell::Cell,
        fg: [u8; 3],
        bg: [u8; 3],
    ) -> CellRepr {
        use alacritty_terminal::term::cell::Flags;
        use alacritty_terminal::vte::ansi::{Color, NamedColor};
        CellRepr {
            codepoint: u32::from(cell.c),
            link: 0,
            fg,
            bg,
            attrs: CellAttrs::NONE
                .with(CellAttrs::WIDE, cell.flags.contains(Flags::WIDE_CHAR))
                .with(CellAttrs::BOLD, cell.flags.contains(Flags::BOLD))
                .with(CellAttrs::ITALIC, cell.flags.contains(Flags::ITALIC))
                .with(
                    CellAttrs::UNDERLINE,
                    cell.flags.intersects(Flags::ALL_UNDERLINES),
                )
                .with(CellAttrs::INVERSE, cell.flags.contains(Flags::INVERSE))
                .with(
                    CellAttrs::EXPLICIT_DEFAULT_BG,
                    bg == crate::theme::DEFAULT_BACKGROUND
                        && cell.bg != Color::Named(NamedColor::Background),
                ),
        }
    }
}

/// Whether `cell` carries alacritty's wrap flag.
///
/// One owner for the flag lookup, because the daemon and term-wasm must agree
/// on it exactly: it feeds [`row_hash`](crate::row_hash), so a disagreement
/// reads as row divergence and provokes a resync rather than a wrong pixel.
#[inline]
pub fn cell_wraps(cell: &alacritty_terminal::term::cell::Cell) -> bool {
    use alacritty_terminal::term::cell::Flags;
    cell.flags.contains(Flags::WRAPLINE)
}

impl CellRepr {
    #[inline]
    pub fn tag(self, default_fg: [u8; 3], default_bg: [u8; 3]) -> u8 {
        let mut tag = 0u8;
        if self.fg != default_fg {
            tag |= HAS_FG;
        }
        if self.bg != default_bg || self.attrs.contains(CellAttrs::EXPLICIT_DEFAULT_BG) {
            tag |= HAS_BG;
        }
        tag | self.attrs.tag_bits()
    }
}
