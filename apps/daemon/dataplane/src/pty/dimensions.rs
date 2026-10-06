use std::fmt;

/// The codec's receiver grid caps, narrowed to the PTY's `u16` dimensions: a
/// wire fact with one definition, so the daemon never sizes a terminal whose
/// frames a viewer refuses.
pub const MAX_TERMINAL_COLUMNS: u16 = dimension(merkur_codec::MAX_TERMINAL_COLUMNS);
pub const MAX_TERMINAL_ROWS: u16 = dimension(merkur_codec::MAX_TERMINAL_ROWS);
pub const MAX_TERMINAL_CELLS: usize = merkur_codec::MAX_TERMINAL_CELLS;

/// A codec cap as a PTY dimension. A cap past `u16` fails the build.
const fn dimension(cap: usize) -> u16 {
    assert!(
        cap <= u16::MAX as usize,
        "a terminal dimension cap fits u16"
    );
    cap as u16
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalDimensionsError {
    ZeroColumns,
    ZeroRows,
    ColumnsTooLarge,
    RowsTooLarge,
    CellCountTooLarge,
}

impl fmt::Display for TerminalDimensionsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ZeroColumns => "columns must be nonzero",
            Self::ZeroRows => "rows must be nonzero",
            Self::ColumnsTooLarge => "columns exceed maximum",
            Self::RowsTooLarge => "rows exceed maximum",
            Self::CellCountTooLarge => "total cells exceed maximum",
        };
        formatter.write_str(message)
    }
}

/// A 512-column row is at most 6 KiB in the codec's worst case, within its u16
/// row length. The cell cap accommodates a compact-font 4K viewport while
/// keeping a worst-case snapshot near 1 MiB and bounding duplicated peer grids.
pub fn validate_terminal_dimensions(
    columns: u16,
    rows: u16,
) -> Result<(), TerminalDimensionsError> {
    if columns == 0 {
        return Err(TerminalDimensionsError::ZeroColumns);
    }
    if rows == 0 {
        return Err(TerminalDimensionsError::ZeroRows);
    }

    let cells = usize::from(columns)
        .checked_mul(usize::from(rows))
        .ok_or(TerminalDimensionsError::CellCountTooLarge)?;
    if cells > MAX_TERMINAL_CELLS {
        return Err(TerminalDimensionsError::CellCountTooLarge);
    }
    if columns > MAX_TERMINAL_COLUMNS {
        return Err(TerminalDimensionsError::ColumnsTooLarge);
    }
    if rows > MAX_TERMINAL_ROWS {
        return Err(TerminalDimensionsError::RowsTooLarge);
    }

    Ok(())
}

/// Authenticated resize body: columns/rows (u16 BE), intent serial (u32 BE),
/// then one cell's width/height in unsigned 16.16 logical pixels (u32 BE each),
/// and the controlling attachment grant generation (u64 BE).
/// A host that knows no cell pixels states both as zero: the PTY's pixel extent
/// is then zero, which is the OS's "unknown", and no image is placed. A stated
/// extent must fit the OS PTY winsize fields; no saturation or wrap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Viewport {
    pub cols: u16,
    pub rows: u16,
    pub seq: u32,
    pub geometry_generation: u64,
    pub cell: Option<merkur_graphics::geometry::CellMetrics>,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl Viewport {
    pub fn decode(body: &[u8]) -> Option<Self> {
        let body: &[u8; 24] = body.try_into().ok()?;
        let geometry_generation = u64::from_be_bytes(body[16..24].try_into().ok()?);
        if geometry_generation == 0 {
            return None;
        }
        let cols = u16::from_be_bytes(body[0..2].try_into().ok()?);
        let rows = u16::from_be_bytes(body[2..4].try_into().ok()?);
        validate_terminal_dimensions(cols, rows).ok()?;
        let seq = u32::from_be_bytes(body[4..8].try_into().ok()?);
        if seq == 0 {
            return None;
        }
        let width = u32::from_be_bytes(body[8..12].try_into().ok()?);
        let height = u32::from_be_bytes(body[12..16].try_into().ok()?);
        let extent = |count: u16, metric: u32| {
            let pixels = (u64::from(count) * u64::from(metric) + (1 << 15)) >> 16;
            u16::try_from(pixels).ok().filter(|value| *value != 0)
        };
        let (cell, pixel_width, pixel_height) = if (width, height) == (0, 0) {
            (None, 0, 0)
        } else {
            let cell = merkur_graphics::geometry::CellMetrics::new(width, height)?;
            (
                Some(cell),
                extent(cols, cell.width())?,
                extent(rows, cell.height())?,
            )
        };
        Some(Self {
            cols,
            rows,
            seq,
            geometry_generation,
            cell,
            pixel_width,
            pixel_height,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resize_body(cols: u16, rows: u16, width: u32, height: u32) -> [u8; 24] {
        let mut body = [0; 24];
        body[..2].copy_from_slice(&cols.to_be_bytes());
        body[2..4].copy_from_slice(&rows.to_be_bytes());
        body[4..8].copy_from_slice(&1u32.to_be_bytes());
        body[8..12].copy_from_slice(&width.to_be_bytes());
        body[12..16].copy_from_slice(&height.to_be_bytes());
        body[16..24].copy_from_slice(&1u64.to_be_bytes());
        body
    }

    #[test]
    fn viewport_rounds_the_whole_fractional_extent_once() {
        let body = resize_body(120, 48, 8 * 65536 + 16384, 16 * 65536 + 32768);
        let viewport = Viewport::decode(&body).unwrap();
        assert_eq!((viewport.pixel_width, viewport.pixel_height), (990, 792));
        let cell = viewport.cell.unwrap();
        assert_eq!(cell.width(), 540672);
        assert_eq!(cell.height(), 1081344);
        assert_eq!(Viewport::decode(&body[..8]), None);
        assert_eq!(Viewport::decode(&[0; 17]), None);
    }

    #[test]
    fn a_viewport_without_cell_pixels_states_no_pixel_extent() {
        let viewport = Viewport::decode(&resize_body(120, 48, 0, 0)).unwrap();
        assert_eq!((viewport.cols, viewport.rows), (120, 48));
        assert_eq!(viewport.cell, None);
        assert_eq!((viewport.pixel_width, viewport.pixel_height), (0, 0));
    }

    #[test]
    fn viewport_refuses_zero_and_unrepresentable_os_extents() {
        for (cols, rows, width, height) in [
            (80, 24, 0, 65536),
            (80, 24, 65536, 0),
            (80, 24, 1, 65536),
            (80, 24, 65536, 1),
            (512, 24, u32::MAX, 65536),
            (80, 256, 65536, u32::MAX),
            (0, 24, 65536, 65536),
            (80, 0, 65536, 65536),
        ] {
            assert_eq!(
                Viewport::decode(&resize_body(cols, rows, width, height)),
                None
            );
        }
        let mut body = resize_body(80, 24, 65536, 65536);
        body[4..8].fill(0);
        assert_eq!(Viewport::decode(&body), None);
    }

    #[test]
    fn accepts_normal_dimensions() {
        assert_eq!(validate_terminal_dimensions(120, 40), Ok(()));
    }

    #[test]
    fn accepts_per_dimension_boundaries() {
        assert_eq!(
            validate_terminal_dimensions(MAX_TERMINAL_COLUMNS, 1),
            Ok(())
        );
        assert_eq!(validate_terminal_dimensions(1, MAX_TERMINAL_ROWS), Ok(()));
    }

    #[test]
    fn accepts_total_cell_boundary() {
        assert_eq!(validate_terminal_dimensions(384, 256), Ok(()));
    }

    #[test]
    fn rejects_zero_dimensions() {
        assert_eq!(
            validate_terminal_dimensions(0, 40),
            Err(TerminalDimensionsError::ZeroColumns)
        );
        assert_eq!(
            validate_terminal_dimensions(120, 0),
            Err(TerminalDimensionsError::ZeroRows)
        );
    }

    #[test]
    fn rejects_per_dimension_oversize() {
        assert_eq!(
            validate_terminal_dimensions(MAX_TERMINAL_COLUMNS + 1, 1),
            Err(TerminalDimensionsError::ColumnsTooLarge)
        );
        assert_eq!(
            validate_terminal_dimensions(1, MAX_TERMINAL_ROWS + 1),
            Err(TerminalDimensionsError::RowsTooLarge)
        );
    }

    #[test]
    fn rejects_total_cell_excess_without_wrapping() {
        assert_eq!(
            validate_terminal_dimensions(MAX_TERMINAL_COLUMNS, 193),
            Err(TerminalDimensionsError::CellCountTooLarge)
        );
        assert_eq!(
            validate_terminal_dimensions(u16::MAX, u16::MAX),
            Err(TerminalDimensionsError::CellCountTooLarge)
        );
    }
}
