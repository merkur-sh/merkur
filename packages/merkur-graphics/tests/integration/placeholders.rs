use merkur_graphics::placeholder::{Color, PLACEHOLDER, RowDecoder, diacritic_index};

const ZERO: char = '\u{305}';
const ONE: char = '\u{30d}';
const TWO: char = '\u{30e}';

#[test]
fn every_protocol_diacritic_has_its_pinned_index() {
    let mut count = 0;
    for line in include_str!("../fixtures/rowcolumn-diacritics.txt").lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let value = u32::from_str_radix(line.split(';').next().unwrap(), 16).unwrap();
        assert_eq!(diacritic_index(char::from_u32(value).unwrap()), Some(count));
        count += 1;
    }
    assert_eq!(count, 297);
    assert_eq!(diacritic_index('a'), None);
}

#[test]
fn all_three_left_inheritance_rules_are_exact() {
    let mut row = RowDecoder::default();
    let fg = Color::Indexed(42);
    let ul = Color::Rgb([0x12, 0x34, 0x56]);
    let first = row.cell(PLACEHOLDER, &[ONE, ZERO, TWO], fg, ul).unwrap();
    assert_eq!(
        (first.image_id, first.placement_id, first.row, first.column),
        (0x0200_002a, 0x123456, 1, 0)
    );
    let second = row.cell(PLACEHOLDER, &[], fg, ul).unwrap();
    assert_eq!(
        (second.image_id, second.row, second.column),
        (first.image_id, 1, 1)
    );
    let third = row.cell(PLACEHOLDER, &[ONE], fg, ul).unwrap();
    assert_eq!(
        (third.image_id, third.row, third.column),
        (first.image_id, 1, 2)
    );
    // Explicit row+column inherit the high byte only for exact adjacency.
    row.cell(PLACEHOLDER, &[ONE, ZERO, TWO], fg, ul);
    let next = row.cell(PLACEHOLDER, &[ONE, ONE], fg, ul).unwrap();
    assert_eq!(next.image_id, first.image_id);
    let nonadjacent = row.cell(PLACEHOLDER, &[ONE, ZERO], fg, ul).unwrap();
    assert_eq!(nonadjacent.image_id, 42);
    let next_row = row.cell(PLACEHOLDER, &[TWO], fg, ul).unwrap();
    assert_eq!((next_row.row, next_row.column), (2, 0));
}

#[test]
fn foreground_encoding_and_underline_identity_break_inheritance() {
    let mut row = RowDecoder::default();
    row.cell(
        PLACEHOLDER,
        &[ONE, ONE, TWO],
        Color::Indexed(42),
        Color::Default,
    );
    let rgb = row
        .cell(PLACEHOLDER, &[], Color::Rgb([0, 0, 42]), Color::Default)
        .unwrap();
    assert_eq!((rgb.image_id, rgb.row, rgb.column), (42, 0, 0));
    row.cell(
        PLACEHOLDER,
        &[ONE, ONE, TWO],
        Color::Indexed(42),
        Color::Default,
    );
    let explicit_zero = row
        .cell(PLACEHOLDER, &[], Color::Indexed(42), Color::Indexed(0))
        .unwrap();
    assert_eq!(
        (
            explicit_zero.image_id,
            explicit_zero.row,
            explicit_zero.column
        ),
        (42, 0, 0)
    );
}

#[test]
fn invalid_cells_and_row_boundaries_do_not_inherit() {
    let mut row = RowDecoder::default();
    let fg = Color::Rgb([0xab, 0xcd, 0xef]);
    row.cell(PLACEHOLDER, &[ONE, ONE, TWO], fg, Color::Default);
    assert!(row.cell('x', &[], fg, Color::Default).is_none());
    let cell = row.cell(PLACEHOLDER, &[], fg, Color::Default).unwrap();
    assert_eq!((cell.image_id, cell.row, cell.column), (0xabcdef, 0, 0));
    assert!(row.cell(PLACEHOLDER, &['x'], fg, Color::Default).is_none());
    assert!(
        row.cell(PLACEHOLDER, &[ZERO, ZERO, '\u{1d244}'], fg, Color::Default)
            .is_none()
    );
    assert_eq!(
        row.cell(PLACEHOLDER, &[], fg, Color::Default)
            .unwrap()
            .column,
        0
    );
    assert_eq!(
        RowDecoder::default()
            .cell(PLACEHOLDER, &[], fg, Color::Default)
            .unwrap()
            .column,
        0
    );
    assert!(
        row.cell(PLACEHOLDER, &[], Color::Default, Color::Default)
            .is_none()
    );
}
