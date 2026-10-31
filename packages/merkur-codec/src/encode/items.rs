use crate::mz::MzItem;

pub(crate) trait CellMetadata {
    fn first(&mut self, _at: usize, _mode: u8) {}
    fn item(&mut self, _end: usize, _cells: usize) {}
}

impl CellMetadata for () {}

impl<T: CellMetadata + ?Sized> CellMetadata for &mut T {
    #[inline]
    fn first(&mut self, at: usize, mode: u8) {
        (**self).first(at, mode);
    }
    #[inline]
    fn item(&mut self, end: usize, cells: usize) {
        (**self).item(end, cells);
    }
}

pub(crate) trait FrameMetadata {
    fn cells(&mut self) -> impl CellMetadata + '_;
    fn begin_row(&mut self, _at: usize) {}
    fn end_row(&mut self) {}
}

impl FrameMetadata for () {
    #[inline]
    fn cells(&mut self) -> impl CellMetadata {}
}

impl<T: FrameMetadata + ?Sized> FrameMetadata for &mut T {
    #[inline]
    fn cells(&mut self) -> impl CellMetadata + '_ {
        (**self).cells()
    }
    #[inline]
    fn begin_row(&mut self, at: usize) {
        (**self).begin_row(at);
    }
    #[inline]
    fn end_row(&mut self) {
        (**self).end_row();
    }
}

pub(crate) struct RowItems<'a> {
    pub(super) items: &'a mut Vec<MzItem>,
    start: usize,
}

impl<'a> RowItems<'a> {
    pub(crate) fn new(items: &'a mut Vec<MzItem>, start: usize) -> Self {
        Self { items, start }
    }
}

impl CellMetadata for RowItems<'_> {
    #[inline]
    fn first(&mut self, _at: usize, _mode: u8) {
        self.items.clear();
    }

    #[inline]
    #[expect(
        clippy::cast_possible_truncation,
        reason = "trusted row entries fit their u16 wire fields"
    )]
    fn item(&mut self, end: usize, cells: usize) {
        self.items.push(MzItem {
            end: (end - self.start) as u16,
            cells: cells as u16,
        });
    }
}

/// The same scratch and source vectors MZ fills when it parses row bytes.
/// The final row stays in scratch: no later row can copy from it.
pub(crate) struct FrameItems<'a> {
    items: &'a mut Vec<MzItem>,
    row: RowItems<'a>,
    remaining: u16,
}

impl<'a> FrameItems<'a> {
    pub(crate) fn new(items: &'a mut Vec<MzItem>, scratch: &'a mut Vec<MzItem>, rows: u16) -> Self {
        items.clear();
        Self {
            items,
            row: RowItems::new(scratch, 0),
            remaining: rows,
        }
    }
}

impl FrameMetadata for FrameItems<'_> {
    #[inline]
    fn cells(&mut self) -> impl CellMetadata + '_ {
        &mut self.row
    }

    #[inline]
    fn begin_row(&mut self, at: usize) {
        self.row.start = at;
    }

    #[inline]
    fn end_row(&mut self) {
        self.remaining -= 1;
        if self.remaining != 0 {
            self.items.extend_from_slice(self.row.items);
        }
    }
}
