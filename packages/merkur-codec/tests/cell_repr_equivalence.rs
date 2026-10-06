//! CellRepr equivalence test.
//!
//! `CellRepr::from_alacritty` is the single canonical conversion that both
//! daemon and term-wasm use. The heartbeat protocol relies on both sides
//! producing byte-identical CellRepr for the same Alacritty `Cell` — otherwise
//! the row hash diverges and we emit spurious resync requests.
//!
//! This test sweeps every relevant input dimension and pins the conversion's
//! observable behavior so a future refactor that quietly drifts one side from
//! the other fails CI loudly.

use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use merkur_codec::theme::{
    ANSI_PALETTE, DEFAULT_BACKGROUND, DEFAULT_DIM_FOREGROUND, DEFAULT_FOREGROUND, DIM_PALETTE,
    INDEXED_COLOR_TABLE, named_color, resolve_color,
};
use merkur_codec::{CellRepr, row_hash};

fn make_cell(c: char, fg: Color, bg: Color, flags: Flags) -> Cell {
    Cell {
        c,
        fg,
        bg,
        flags,
        ..Cell::default()
    }
}

#[test]
fn explicit_default_background_is_distinct_from_implicit_default() {
    let implicit = make_cell(
        ' ',
        Color::Named(NamedColor::Foreground),
        Color::Named(NamedColor::Background),
        Flags::empty(),
    );
    let [r, g, b] = DEFAULT_BACKGROUND;
    let explicit = Cell {
        bg: Color::Spec(Rgb { r, g, b }),
        ..implicit.clone()
    };
    let implicit = CellRepr::from_alacritty(&implicit);
    let explicit = CellRepr::from_alacritty(&explicit);
    assert_eq!(implicit.bg, explicit.bg);
    assert!(!implicit.has_explicit_background());
    assert!(explicit.has_explicit_background());
    assert_ne!(implicit, explicit);
    assert_ne!(row_hash(&[implicit]), row_hash(&[explicit]));
    assert_eq!(std::mem::size_of::<CellRepr>(), 16);
}

#[test]
fn from_alacritty_resolves_named_colors_via_shared_table() {
    let pairs: &[(NamedColor, [u8; 3])] = &[
        (NamedColor::Black, ANSI_PALETTE[0]),
        (NamedColor::Red, ANSI_PALETTE[1]),
        (NamedColor::Green, ANSI_PALETTE[2]),
        (NamedColor::Yellow, ANSI_PALETTE[3]),
        (NamedColor::Blue, ANSI_PALETTE[4]),
        (NamedColor::Magenta, ANSI_PALETTE[5]),
        (NamedColor::Cyan, ANSI_PALETTE[6]),
        (NamedColor::White, ANSI_PALETTE[7]),
        (NamedColor::BrightBlack, ANSI_PALETTE[8]),
        (NamedColor::BrightWhite, ANSI_PALETTE[15]),
        (NamedColor::Foreground, DEFAULT_FOREGROUND),
        (NamedColor::Background, DEFAULT_BACKGROUND),
        (NamedColor::DimForeground, DEFAULT_DIM_FOREGROUND),
        (NamedColor::DimRed, DIM_PALETTE[1]),
    ];
    for &(named, expected_rgb) in pairs {
        let cell = make_cell(
            'a',
            Color::Named(named),
            Color::Named(NamedColor::Background),
            Flags::empty(),
        );
        let repr = CellRepr::from_alacritty(&cell);
        assert_eq!(repr.fg, expected_rgb, "named={:?} fg mismatch", named);
        assert_eq!(
            named_color(named),
            expected_rgb,
            "named_color drift for {:?}",
            named
        );
    }
}

#[test]
fn from_alacritty_resolves_indexed_colors_via_shared_table() {
    for index in 0u8..=255 {
        let cell = make_cell(
            ' ',
            Color::Indexed(index),
            Color::Spec(Rgb { r: 0, g: 0, b: 0 }),
            Flags::empty(),
        );
        let repr = CellRepr::from_alacritty(&cell);
        assert_eq!(repr.fg, INDEXED_COLOR_TABLE[usize::from(index)]);
        // resolve_color path mirrors the lookup.
        assert_eq!(
            resolve_color(Color::Indexed(index)),
            INDEXED_COLOR_TABLE[usize::from(index)]
        );
    }
}

#[test]
fn from_alacritty_preserves_spec_rgb_exactly() {
    for (r, g, b) in [(0, 0, 0), (255, 255, 255), (42, 137, 200), (12, 12, 12)] {
        let cell = make_cell(
            'x',
            Color::Spec(Rgb { r, g, b }),
            Color::Spec(Rgb { r: b, g: r, b: g }),
            Flags::empty(),
        );
        let repr = CellRepr::from_alacritty(&cell);
        assert_eq!(repr.fg, [r, g, b]);
        assert_eq!(repr.bg, [b, r, g]);
    }
}

#[test]
fn pre_resolved_color_conversion_is_byte_identical() {
    let colors = [
        Color::Named(NamedColor::Foreground),
        Color::Indexed(197),
        Color::Spec(Rgb {
            r: 12,
            g: 137,
            b: 240,
        }),
    ];
    let flags = Flags::WIDE_CHAR | Flags::BOLD | Flags::ITALIC | Flags::UNDERCURL | Flags::INVERSE;
    for &fg in &colors {
        for &bg in &colors {
            let cell = make_cell('🚀', fg, bg, flags);
            assert_eq!(
                CellRepr::from_alacritty_with_colors(&cell, resolve_color(fg), resolve_color(bg),),
                CellRepr::from_alacritty(&cell),
            );
        }
    }
}

#[test]
fn from_alacritty_maps_each_flag_independently() {
    type FlagPredicate = fn(&CellRepr) -> bool;
    let cases: &[(Flags, FlagPredicate)] = &[
        (Flags::WIDE_CHAR, |c| c.wide()),
        (Flags::BOLD, |c| c.bold()),
        (Flags::ITALIC, |c| c.italic()),
        (Flags::UNDERLINE, |c| c.underline()),
        (Flags::INVERSE, |c| c.inverse()),
    ];
    for &(flag, predicate) in cases {
        let cell = make_cell(
            'A',
            Color::Named(NamedColor::Foreground),
            Color::Named(NamedColor::Background),
            flag,
        );
        let repr = CellRepr::from_alacritty(&cell);
        assert!(
            predicate(&repr),
            "flag {:?} did not propagate to CellRepr",
            flag
        );
    }
}

#[test]
fn underline_intersects_all_underline_variants() {
    for flag in [
        Flags::UNDERLINE,
        Flags::DOUBLE_UNDERLINE,
        Flags::UNDERCURL,
        Flags::DOTTED_UNDERLINE,
        Flags::DASHED_UNDERLINE,
    ] {
        let cell = make_cell(
            'B',
            Color::Named(NamedColor::Foreground),
            Color::Named(NamedColor::Background),
            flag,
        );
        let repr = CellRepr::from_alacritty(&cell);
        assert!(repr.underline(), "{:?} should map to underline=true", flag);
    }
}

#[test]
fn row_hash_is_deterministic_for_identical_repr() {
    let row: Vec<CellRepr> = (0..120)
        .map(|i| {
            let cell = make_cell(
                char::from_u32(0x30 + (i as u32 % 10)).unwrap_or('?'),
                Color::Indexed(i as u8),
                Color::Named(NamedColor::Background),
                Flags::BOLD,
            );
            CellRepr::from_alacritty(&cell)
        })
        .collect();
    let a = row_hash(&row);
    let b = row_hash(&row);
    assert_eq!(a, b);
}

#[test]
fn row_hash_changes_when_any_field_changes() {
    let cell = Cell {
        c: 'a',
        fg: Color::Indexed(7),
        bg: Color::Indexed(0),
        ..Cell::default()
    };
    let base = vec![CellRepr::from_alacritty(&cell); 1];
    let baseline_hash = row_hash(&base);

    let mut variant = cell.clone();
    variant.c = 'b';
    let new_row = vec![CellRepr::from_alacritty(&variant)];
    assert_ne!(row_hash(&new_row), baseline_hash);

    let mut variant = cell.clone();
    variant.fg = Color::Indexed(2);
    let new_row = vec![CellRepr::from_alacritty(&variant)];
    assert_ne!(row_hash(&new_row), baseline_hash);

    let mut variant = cell;
    variant.flags = Flags::BOLD;
    let new_row = vec![CellRepr::from_alacritty(&variant)];
    assert_ne!(row_hash(&new_row), baseline_hash);

    let mut wrapped = base;
    wrapped[0].set_wrapped(true);
    assert_ne!(row_hash(&wrapped), baseline_hash);
}

/// `wrapped` is row-scoped: it means "this row continues onto the next", and
/// only a row's final cell can say so. A per-cell conversion has no idea which
/// cell it holds, so it must not answer the question — the row builders in the
/// daemon and in term-wasm stamp the answer with `cell_wraps`, and the wire
/// carries it once per row rather than once per cell.
#[test]
fn from_alacritty_leaves_the_row_scoped_wrap_bit_to_the_row_builder() {
    let mut cell = Cell {
        c: 'a',
        ..Cell::default()
    };
    cell.flags = Flags::WRAPLINE;
    assert!(!CellRepr::from_alacritty(&cell).wrapped());
    assert!(merkur_codec::cell_wraps(&cell));

    cell.flags = Flags::empty();
    assert!(!merkur_codec::cell_wraps(&cell));
}
