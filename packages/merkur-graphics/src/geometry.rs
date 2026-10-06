//! Deterministic placement geometry and independent, clipped row slices.
//!
//! Cell coordinates use unsigned 32.32 extents. Positions use signed 128-bit
//! intermediates so offscreen relative chains cannot overflow a visible slice.
//! Sampling always derives from the original rectangle, never a rounded prior
//! slice. Adjacent rows therefore share bit-identical source boundaries.

use std::num::NonZeroU32;

use crate::placements::Layout;
use crate::processing::pixel_bytes;

pub const CELL_UNIT: u64 = 1 << 32;
/// Pixel geometry supplied by the authoritative viewer, in 16.16 pixel units.
pub const PIXEL_UNIT: u32 = 1 << 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellMetrics {
    width: NonZeroU32,
    height: NonZeroU32,
}

impl CellMetrics {
    pub fn new(width: u32, height: u32) -> Option<Self> {
        Some(Self {
            width: NonZeroU32::new(width)?,
            height: NonZeroU32::new(height)?,
        })
    }

    pub fn width(self) -> u32 {
        self.width.get()
    }
    pub fn height(self) -> u32 {
        self.height.get()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeometryError {
    InvalidImage,
    InvalidOffset,
    UnrepresentableExtent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    source: SourceRect,
    /// Offset and extent in 32.32 cells. Virtual placements can have centered
    /// padding spanning multiple cells.
    offset_x: u64,
    offset_y: u64,
    width: u64,
    height: u64,
}

/// An absolute horizontal interval and a vertical interval within one row.
/// Source endpoints use 32.32 source pixels, not normalized texture coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowSlice {
    pub left: u64,
    pub right: u64,
    pub top: u64,
    pub bottom: u64,
    pub source_left: u64,
    pub source_right: u64,
    pub source_top: u64,
    pub source_bottom: u64,
}

/// Half-open grid rectangle in signed 32.32 cells, including history coordinates.
/// Margin clipping is a destination scissor; it never changes the sampling transform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellRect {
    left: i128,
    top: i128,
    right: i128,
    bottom: i128,
}

impl CellRect {
    pub fn new(left: i64, top: i64, right: i64, bottom: i64) -> Option<Self> {
        let unit = i128::from(CELL_UNIT);
        Self::fixed(
            i128::from(left) * unit,
            i128::from(top) * unit,
            i128::from(right) * unit,
            i128::from(bottom) * unit,
        )
    }

    /// Exact fixed-point boundaries. Negative history coordinates and fractional
    /// scissors after cell-metric changes must not be rounded to whole cells.
    pub fn fixed(left: i128, top: i128, right: i128, bottom: i128) -> Option<Self> {
        (left < right && top < bottom).then_some(Self {
            left,
            top,
            right,
            bottom,
        })
    }

    pub fn intersects(self, other: Self) -> bool {
        self.left < other.right
            && self.right > other.left
            && self.top < other.bottom
            && self.bottom > other.top
    }

    pub fn intersects_column(self, column: i64) -> bool {
        let left = i128::from(column) * i128::from(CELL_UNIT);
        self.left < left + i128::from(CELL_UNIT) && self.right > left
    }

    pub fn intersects_row(self, row: i64) -> bool {
        let top = i128::from(row) * i128::from(CELL_UNIT);
        self.top < top + i128::from(CELL_UNIT) && self.bottom > top
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Layer {
    BelowBackground,
    BelowText,
    AboveText,
}

impl Layer {
    pub const fn from_z(z: i32) -> Self {
        if z < i32::MIN / 2 {
            Self::BelowBackground
        } else if z < 0 {
            Self::BelowText
        } else {
            Self::AboveText
        }
    }
}

impl Layout {
    /// Intersect the requested source rectangle before applying scale. An empty
    /// intersection contributes no pixels. Explicit c/r include the X/Y offsets.
    pub fn geometry(
        self,
        image_width: u32,
        image_height: u32,
        cell: CellMetrics,
    ) -> Result<Option<Geometry>, GeometryError> {
        pixel_bytes(image_width, image_height, 4).ok_or(GeometryError::InvalidImage)?;
        let pixel_x = u64::from(self.offset_x) * u64::from(PIXEL_UNIT);
        let pixel_y = u64::from(self.offset_y) * u64::from(PIXEL_UNIT);
        if pixel_x >= u64::from(cell.width()) || pixel_y >= u64::from(cell.height()) {
            return Err(GeometryError::InvalidOffset);
        }
        if self.source_x >= image_width || self.source_y >= image_height {
            return Ok(None);
        }
        let source_width = image_width - self.source_x;
        let source_height = image_height - self.source_y;
        let source = SourceRect {
            x: self.source_x,
            y: self.source_y,
            width: if self.source_width == 0 {
                source_width
            } else {
                source_width.min(self.source_width)
            },
            height: if self.source_height == 0 {
                source_height
            } else {
                source_height.min(self.source_height)
            },
        };
        let offset_x = ratio(
            u128::from(pixel_x) * u128::from(CELL_UNIT),
            u128::from(cell.width()),
        )?;
        let offset_y = ratio(
            u128::from(pixel_y) * u128::from(CELL_UNIT),
            u128::from(cell.height()),
        )?;
        let width;
        let height;
        if self.columns != 0 {
            width = u64::from(self.columns) * CELL_UNIT - offset_x;
            height = if self.rows != 0 {
                u64::from(self.rows) * CELL_UNIT - offset_y
            } else {
                ratio(
                    u128::from(width) * u128::from(cell.width()) * u128::from(source.height),
                    u128::from(cell.height()) * u128::from(source.width),
                )?
            };
        } else if self.rows != 0 {
            height = u64::from(self.rows) * CELL_UNIT - offset_y;
            width = ratio(
                u128::from(height) * u128::from(cell.height()) * u128::from(source.width),
                u128::from(cell.width()) * u128::from(source.height),
            )?;
        } else {
            width = ratio(
                u128::from(source.width) * u128::from(PIXEL_UNIT) * u128::from(CELL_UNIT),
                u128::from(cell.width()),
            )?;
            height = ratio(
                u128::from(source.height) * u128::from(PIXEL_UNIT) * u128::from(CELL_UNIT),
                u128::from(cell.height()),
            )?;
        }
        if width == 0 || height == 0 {
            return Err(GeometryError::UnrepresentableExtent);
        }
        Ok(Some(Geometry {
            source,
            offset_x,
            offset_y,
            width,
            height,
        }))
    }
}

fn ratio(numerator: u128, denominator: u128) -> Result<u64, GeometryError> {
    u64::try_from(numerator / denominator).map_err(|_| GeometryError::UnrepresentableExtent)
}

impl Geometry {
    /// Virtual prototypes fit the whole image to their cell box, preserving
    /// aspect ratio and centering unused space. Unspecified box dimensions use
    /// the corresponding natural dimension rounded up to whole cells.
    pub fn virtual_placement(
        image_width: u32,
        image_height: u32,
        columns: u32,
        rows: u32,
        cell: CellMetrics,
    ) -> Result<Self, GeometryError> {
        pixel_bytes(image_width, image_height, 4).ok_or(GeometryError::InvalidImage)?;
        let natural = |pixels: u32, metric: u32| -> Result<u32, GeometryError> {
            u32::try_from((u64::from(pixels) * u64::from(PIXEL_UNIT)).div_ceil(u64::from(metric)))
                .map_err(|_| GeometryError::UnrepresentableExtent)
        };
        let columns = if columns == 0 {
            natural(image_width, cell.width())?
        } else {
            columns
        };
        let rows = if rows == 0 {
            natural(image_height, cell.height())?
        } else {
            rows
        };
        let box_width = u64::from(columns) * CELL_UNIT;
        let box_height = u64::from(rows) * CELL_UNIT;
        // Compare before narrowing: the unconstrained aspect-preserving size
        // may exceed the coordinate representation while the fitted size does not.
        let height_for_width =
            u128::from(box_width) * u128::from(cell.width()) * u128::from(image_height)
                / (u128::from(cell.height()) * u128::from(image_width));
        let (width, height) = if height_for_width <= u128::from(box_height) {
            (box_width, height_for_width as u64)
        } else {
            (
                ratio(
                    u128::from(box_height) * u128::from(cell.height()) * u128::from(image_width),
                    u128::from(cell.width()) * u128::from(image_height),
                )?,
                box_height,
            )
        };
        if width == 0 || height == 0 {
            return Err(GeometryError::UnrepresentableExtent);
        }
        Ok(Self {
            source: SourceRect {
                x: 0,
                y: 0,
                width: image_width,
                height: image_height,
            },
            offset_x: (box_width - width) / 2,
            offset_y: (box_height - height) / 2,
            width,
            height,
        })
    }

    pub fn source(self) -> SourceRect {
        self.source
    }
    pub fn offset(self) -> (u64, u64) {
        (self.offset_x, self.offset_y)
    }
    pub fn extent(self) -> (u64, u64) {
        (self.width, self.height)
    }

    /// Project exactly one placeholder cell, even when neighboring cells have
    /// unrelated image coordinates. Padding remains transparent.
    pub fn project_cell(
        self,
        image_column: u32,
        image_row: u32,
        screen_column: u32,
        columns: u32,
    ) -> Option<RowSlice> {
        if screen_column >= columns {
            return None;
        }
        let mut slice = self.project_row(-i64::from(image_column), -i64::from(image_row), 1, 0)?;
        let offset = u64::from(screen_column) * CELL_UNIT;
        slice.left += offset;
        slice.right += offset;
        Some(slice)
    }

    /// Cursor advance includes the starting offset, but never adds an extra cell
    /// to an explicitly sized placement. Values are computed before viewport clipping.
    pub fn cursor_advance(self) -> Option<(u32, u32)> {
        let columns =
            (u128::from(self.width) + u128::from(self.offset_x)).div_ceil(u128::from(CELL_UNIT));
        let rows =
            (u128::from(self.height) + u128::from(self.offset_y)).div_ceil(u128::from(CELL_UNIT));
        Some((u32::try_from(columns).ok()?, u32::try_from(rows).ok()?))
    }

    /// Test the entire image rectangle before scrolling within page margins.
    /// Looking only at the anchor incorrectly moves images crossing a margin.
    pub fn contained_by(self, column: i64, line: i64, clip: CellRect) -> bool {
        let unit = i128::from(CELL_UNIT);
        let left = i128::from(column) * unit + i128::from(self.offset_x);
        let top = i128::from(line) * unit + i128::from(self.offset_y);
        left >= clip.left
            && top >= clip.top
            && left + i128::from(self.width) <= clip.right
            && top + i128::from(self.height) <= clip.bottom
    }

    /// Exact visible row interval, computed once per placement. Offscreen images
    /// cost one intersection, not a scan of the viewport. Projection visits only
    /// rows which can emit fragments, including fractional top/bottom scissors.
    pub fn visible_rows(
        self,
        column: i64,
        line: i64,
        columns: u16,
        rows: u16,
        clip: Option<CellRect>,
    ) -> std::ops::Range<u16> {
        let unit = i128::from(CELL_UNIT);
        let left = i128::from(column) * unit + i128::from(self.offset_x);
        let top = i128::from(line) * unit + i128::from(self.offset_y);
        let mut visible_left = left.max(0);
        let mut visible_right = (left + i128::from(self.width)).min(i128::from(columns) * unit);
        let mut visible_top = top.max(0);
        let mut visible_bottom = (top + i128::from(self.height)).min(i128::from(rows) * unit);
        if let Some(clip) = clip {
            visible_left = visible_left.max(clip.left);
            visible_right = visible_right.min(clip.right);
            visible_top = visible_top.max(clip.top);
            visible_bottom = visible_bottom.min(clip.bottom);
        }
        if visible_left >= visible_right || visible_top >= visible_bottom {
            return 0..0;
        }
        // Viewport intersection proves both quotients fit u16. ceil(bottom)
        // keeps a partly covered final row without inventing a boundary pixel.
        (visible_top / unit) as u16..((visible_bottom + unit - 1) / unit) as u16
    }

    /// Allocation-free projection, called only for rows in a placement's damage
    /// interval. `row` and the anchor use the same screen/history coordinate space.
    pub fn project_row(self, column: i64, line: i64, columns: u32, row: i64) -> Option<RowSlice> {
        self.project_row_inner(column, line, columns, row, None)
    }

    pub fn project_row_clipped(
        self,
        column: i64,
        line: i64,
        columns: u32,
        row: i64,
        clip: CellRect,
    ) -> Option<RowSlice> {
        self.project_row_inner(column, line, columns, row, Some(clip))
    }

    fn project_row_inner(
        self,
        column: i64,
        line: i64,
        columns: u32,
        row: i64,
        clip: Option<CellRect>,
    ) -> Option<RowSlice> {
        let unit = i128::from(CELL_UNIT);
        let left = i128::from(column) * unit + i128::from(self.offset_x);
        let top = i128::from(line) * unit + i128::from(self.offset_y);
        let row_top = i128::from(row) * unit;
        let mut visible_left = left.max(0);
        let mut visible_right = (left + i128::from(self.width)).min(i128::from(columns) * unit);
        let mut visible_top = top.max(row_top);
        let mut visible_bottom = (top + i128::from(self.height)).min(row_top + unit);
        if let Some(clip) = clip {
            visible_left = visible_left.max(clip.left);
            visible_right = visible_right.min(clip.right);
            visible_top = visible_top.max(clip.top);
            visible_bottom = visible_bottom.min(clip.bottom);
        }
        if visible_left >= visible_right || visible_top >= visible_bottom {
            return None;
        }
        Some(RowSlice {
            left: u64::try_from(visible_left).ok()?,
            right: u64::try_from(visible_right).ok()?,
            top: u64::try_from(visible_top - row_top).ok()?,
            bottom: u64::try_from(visible_bottom - row_top).ok()?,
            source_left: sample(
                self.source.x,
                self.source.width,
                self.width,
                visible_left - left,
            ),
            source_right: sample(
                self.source.x,
                self.source.width,
                self.width,
                visible_right - left,
            ),
            source_top: sample(
                self.source.y,
                self.source.height,
                self.height,
                visible_top - top,
            ),
            source_bottom: sample(
                self.source.y,
                self.source.height,
                self.height,
                visible_bottom - top,
            ),
        })
    }
}

fn sample(start: u32, pixels: u32, extent: u64, offset: i128) -> u64 {
    // Intersection proves 0 <= offset <= extent; source extents were validated
    // against MAX_DIMENSION, so this product fits u128 and its quotient fits u64.
    u64::from(start) * CELL_UNIT
        + ((offset as u128 * u128::from(pixels) * u128::from(CELL_UNIT)) / u128::from(extent))
            as u64
}
