//! Sparse, quota-owned Unicode placeholder rows. Ordinary terminals never create
//! this index. Grid damage refreshes only affected rows; an unchanged cursor row
//! does not invalidate projection. Scene binding uses original SGR identities.

use alacritty_terminal::index::Line;
use alacritty_terminal::term::TermDamage;
use alacritty_terminal::vte::ansi::Color as TerminalColor;
use merkur_graphics::budget::Lease;
use merkur_graphics::placeholder::{Color, Placeholder, RowDecoder};
use merkur_graphics::projection::{Content, Fragment, Stack};

use super::*;

const ROWS: usize = crate::pty::dimensions::MAX_TERMINAL_ROWS as usize;

/// Images drawn on placeholder cells belong to the text layer, just beneath
/// the text, cursor and decorations of their own cells. Kitty uses this z for
/// every placeholder image, whatever z its virtual placement requested.
const PLACEHOLDER_Z: i32 = -1;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Cell {
    column: u16,
    placeholder: Placeholder,
}

struct Row {
    cells: Vec<Cell>,
    fragments: Vec<Fragment>,
    selectors: Vec<(u32, u32)>,
    bindings: Vec<(PlacementId, Position)>,
    _lease: Lease,
}

struct Prototype {
    id: PlacementId,
    selector: (u32, u32),
    origin: Option<Position>,
    projection: Option<(Geometry, Content, Stack)>,
    rows: [u64; ROWS / 64],
    origin_dirty: bool,
}

struct Selector {
    rows: [u64; ROWS / 64],
    _lease: Lease,
}

pub(super) struct Index {
    rows: [Option<Row>; ROWS],
    scratch: Vec<Cell>,
    selector_scratch: Vec<(u32, u32)>,
    prototypes: Vec<Prototype>,
    dirty_origins: Vec<PlacementId>,
    selectors: BTreeMap<(u32, u32), Box<Selector>>,
    dirty: [bool; ROWS],
    pub(super) changed: [bool; ROWS],
    metrics: Option<CellMetrics>,
    columns: u16,
    height: u16,
    initialized: bool,
    _lease: Lease,
}

fn color(color: TerminalColor) -> Color {
    match color {
        TerminalColor::Spec(rgb) => Color::Rgb([rgb.r, rgb.g, rgb.b]),
        TerminalColor::Indexed(index) => Color::Indexed(index),
        // ANSI's named 16 colors are palette indices too. Foreground/default
        // and the internal bright/dim default variants are not image IDs.
        TerminalColor::Named(named) if (named as u16) < 16 => Color::Indexed(named as u8),
        _ => Color::Default,
    }
}

/// Adjacent cells of the same prototype use the same affine source mapping.
/// Preserve holes, reordered source columns and independent instances; a normal
/// image row becomes one descriptor instead of one descriptor per terminal cell.
fn coalesce(fragments: &mut Vec<Fragment>) {
    let mut retained = 0;
    for index in 0..fragments.len() {
        let next = fragments[index];
        if retained != 0 {
            let previous = &mut fragments[retained - 1];
            let a = &mut previous.slice;
            let b = next.slice;
            if previous.stack == next.stack
                && previous.content == next.content
                && a.right == b.left
                && a.top == b.top
                && a.bottom == b.bottom
                && a.source_right == b.source_left
                && a.source_top == b.source_top
                && a.source_bottom == b.source_bottom
            {
                a.right = b.right;
                a.source_right = b.source_right;
                continue;
            }
        }
        fragments[retained] = next;
        retained += 1;
    }
    fragments.truncate(retained);
}

impl Index {
    fn new(budget: &Budget, columns: u16, height: u16, prototypes: usize) -> Option<Box<Self>> {
        let lease = budget.reserve(Usage {
            bytes: size_of::<Self>()
                + usize::from(columns) * (size_of::<Cell>() + size_of::<(u32, u32)>())
                + prototypes * (size_of::<Prototype>() + size_of::<PlacementId>()),
            objects: 5,
        })?;
        Some(Box::new(Self {
            rows: std::array::from_fn(|_| None),
            scratch: Vec::with_capacity(usize::from(columns)),
            selector_scratch: Vec::with_capacity(usize::from(columns)),
            prototypes: Vec::with_capacity(prototypes),
            dirty_origins: Vec::with_capacity(prototypes),
            selectors: BTreeMap::new(),
            dirty: [false; ROWS],
            changed: [false; ROWS],
            metrics: None,
            columns,
            height,
            initialized: false,
            _lease: lease,
        }))
    }

    fn refresh(&mut self, budget: &Budget, term: &mut Term<EventForwarder>) -> Option<bool> {
        let mut dirty = [false; ROWS];
        if !self.initialized {
            dirty[..usize::from(self.height)].fill(true);
        } else {
            match term.damage() {
                TermDamage::Full => dirty[..usize::from(self.height)].fill(true),
                TermDamage::Partial(lines) => {
                    for line in lines {
                        if line.line < usize::from(self.height) {
                            dirty[line.line] = true;
                        }
                    }
                }
            }
        }
        let mut changed = !self.initialized;
        for (row, dirty) in dirty.into_iter().enumerate().take(usize::from(self.height)) {
            if !dirty {
                continue;
            }
            self.scratch.clear();
            let mut decoder = RowDecoder::default();
            for (column, cell) in (&term.grid()[Line(row as i32)]).into_iter().enumerate() {
                if let Some(placeholder) = decoder.cell(
                    cell.c,
                    cell.zerowidth().unwrap_or_default(),
                    color(cell.fg),
                    cell.underline_color().map_or(Color::Default, color),
                ) {
                    self.scratch.push(Cell {
                        column: column as u16,
                        placeholder,
                    });
                }
            }
            if self.rows[row].as_ref().map_or(&[][..], |row| &row.cells) == self.scratch {
                continue;
            }
            changed = true;
            self.dirty[row] = true;
            self.changed[row] = true;
            self.unbind(row);
            self.selector_scratch.clear();
            self.selector_scratch.extend(
                self.scratch
                    .iter()
                    .map(|cell| (cell.placeholder.image_id, cell.placeholder.placement_id)),
            );
            self.selector_scratch.sort_unstable();
            self.selector_scratch.dedup();
            if let Some(previous) = &self.rows[row] {
                for key in &previous.selectors {
                    let selector = self.selectors.get_mut(key).expect("indexed selector");
                    selector.rows[row / 64] &= !(1 << (row % 64));
                    if selector.rows.iter().all(|word| *word == 0)
                        && self.selector_scratch.binary_search(key).is_err()
                    {
                        self.selectors.remove(key);
                    }
                }
            }
            if self.scratch.is_empty() {
                self.rows[row] = None;
                continue;
            }
            if self.rows[row]
                .as_ref()
                .is_none_or(|row| row.cells.capacity() < self.scratch.len())
            {
                // Retire reproducible storage before reserving its replacement.
                self.rows[row] = None;
                let count = self.scratch.len();
                let lease = budget.reserve(Usage {
                    bytes: count
                        * (size_of::<Cell>()
                            + size_of::<Fragment>()
                            + size_of::<(u32, u32)>()
                            + size_of::<(PlacementId, Position)>()),
                    objects: 4,
                })?;
                self.rows[row] = Some(Row {
                    cells: Vec::with_capacity(count),
                    fragments: Vec::with_capacity(count),
                    selectors: Vec::with_capacity(count),
                    bindings: Vec::with_capacity(count),
                    _lease: lease,
                });
            }
            let target = self.rows[row].as_mut().expect("admitted row");
            target.cells.clear();
            target.cells.extend_from_slice(&self.scratch);
            target.selectors.clear();
            target.selectors.extend_from_slice(&self.selector_scratch);
            for key in &target.selectors {
                if !self.selectors.contains_key(key) {
                    // Boxed values keep the B-tree's keys/edges small. Reserve a
                    // complete sparse node per member, including the singleton
                    // root, before either allocation (verified by allocator tests).
                    let lease = budget.reserve(Usage {
                        bytes: 512 + size_of::<Selector>(),
                        objects: 2,
                    })?;
                    self.selectors.insert(
                        *key,
                        Box::new(Selector {
                            rows: [0; ROWS / 64],
                            _lease: lease,
                        }),
                    );
                }
                self.selectors.get_mut(key).expect("admitted selector").rows[row / 64] |=
                    1 << (row % 64);
            }
        }
        self.initialized = true;
        Some(changed)
    }

    fn unbind(&mut self, line: usize) {
        let Some(row) = &mut self.rows[line] else {
            return;
        };
        for (id, _) in row.bindings.drain(..) {
            if let Ok(slot) = self
                .prototypes
                .binary_search_by_key(&id, |prototype| prototype.id)
            {
                let prototype = &mut self.prototypes[slot];
                prototype.rows[line / 64] &= !(1 << (line % 64));
                if !std::mem::replace(&mut prototype.origin_dirty, true) {
                    self.dirty_origins.push(prototype.id);
                }
            }
        }
    }

    fn invalidate_selector(&mut self, key: (u32, u32)) {
        if let Some(selector) = self.selectors.get(&key) {
            for (word, rows) in selector.rows.iter().copied().enumerate() {
                let mut rows = rows;
                while rows != 0 {
                    let bit = rows.trailing_zeros() as usize;
                    self.dirty[word * 64 + bit] = true;
                    rows &= rows - 1;
                }
            }
        }
    }

    fn bind(
        &mut self,
        scene: &Scene<ImageContent>,
        placements: &mut Placements,
        metrics: CellMetrics,
    ) {
        if self.metrics != Some(metrics) {
            self.metrics = Some(metrics);
            placements.invalidate_all();
        }
        // Retire demoted prototypes before inserting successors into the admitted
        // population: a parser batch may replace virtual and direct origins.
        for id in placements.dirty() {
            if placements
                .get(id)
                .is_none_or(|p| p.origin != Origin::Virtual)
            {
                self.remove(id);
            }
        }
        for id in placements.dirty() {
            let Some(placement) = placements.get(id).filter(|p| p.origin == Origin::Virtual) else {
                self.remove(id);
                continue;
            };
            let Some(source) = scene.image(placement.image) else {
                self.remove(id);
                continue;
            };
            let selector = (source.client_id, placement.client_id);
            self.invalidate_selector(selector);
            self.invalidate_selector((selector.0, 0));
            let projection = Geometry::virtual_placement(
                source.width,
                source.height,
                placement.layout.columns,
                placement.layout.rows,
                metrics,
            )
            .ok()
            .map(|geometry| {
                (
                    geometry,
                    source.content.descriptor(),
                    Stack {
                        z: PLACEHOLDER_Z,
                        image_id: source.client_id,
                        placement: id.0.get(),
                    },
                )
            });
            match self
                .prototypes
                .binary_search_by_key(&id, |prototype| prototype.id)
            {
                Ok(slot) => self.prototypes[slot].projection = projection,
                Err(slot) => {
                    assert!(self.prototypes.len() < self.prototypes.capacity());
                    self.dirty_origins.push(id);
                    self.prototypes.insert(
                        slot,
                        Prototype {
                            id,
                            selector,
                            origin: None,
                            projection,
                            rows: [0; ROWS / 64],
                            origin_dirty: true,
                        },
                    );
                }
            }
        }
        // Only rows named by actual grid damage or a changed selector are rebuilt.
        // Missing selectors stay indexed, so later prototype creation finds them.
        for line in 0..usize::from(self.height) {
            if !std::mem::take(&mut self.dirty[line]) {
                continue;
            }
            self.changed[line] = true;
            self.unbind(line);
            let Some(row) = &mut self.rows[line] else {
                continue;
            };
            row.fragments.clear();
            let mut cached = None;
            for cell in &row.cells {
                let placeholder = cell.placeholder;
                let key = (placeholder.image_id, placeholder.placement_id);
                let slot = match cached {
                    Some((previous, slot)) if previous == key => slot,
                    _ => {
                        let slot = scene
                            .resolve_id(key.0)
                            .and_then(|image| placements.resolve_virtual(image, key.1))
                            .and_then(|id| {
                                self.prototypes.binary_search_by_key(&id, |p| p.id).ok()
                            });
                        cached = Some((key, slot));
                        slot
                    }
                };
                let Some(slot) = slot else { continue };
                let prototype = &mut self.prototypes[slot];
                let Some((geometry, content, stack)) = prototype.projection else {
                    continue;
                };
                // A virtual parent sits at the minimum column and line of the
                // placeholder cells showing it, not at its virtual box origin.
                row.bindings.push((
                    prototype.id,
                    Position {
                        column: i64::from(cell.column),
                        line: line as i64,
                    },
                ));
                prototype.rows[line / 64] |= 1 << (line % 64);
                if !std::mem::replace(&mut prototype.origin_dirty, true) {
                    self.dirty_origins.push(prototype.id);
                }
                if let Some(slice) = geometry.project_cell(
                    placeholder.column,
                    placeholder.row,
                    u32::from(cell.column),
                    u32::from(self.columns),
                ) {
                    row.fragments.push(Fragment {
                        content,
                        stack,
                        slice,
                    });
                }
            }
            row.bindings.sort_unstable_by_key(|(id, _)| *id);
            row.bindings.dedup_by(|later, earlier| {
                if later.0 != earlier.0 {
                    return false;
                }
                earlier.1.column = earlier.1.column.min(later.1.column);
                earlier.1.line = earlier.1.line.min(later.1.line);
                true
            });
            row.fragments.sort_unstable_by(Fragment::compare);
            coalesce(&mut row.fragments);
        }
        while let Some(id) = self.dirty_origins.pop() {
            let slot = self
                .prototypes
                .binary_search_by_key(&id, |p| p.id)
                .expect("dirty prototype");
            let prototype = &mut self.prototypes[slot];
            prototype.origin_dirty = false;
            let mut origin: Option<Position> = None;
            for (word, rows) in prototype.rows.iter().copied().enumerate() {
                let mut rows = rows;
                while rows != 0 {
                    let bit = rows.trailing_zeros() as usize;
                    rows &= rows - 1;
                    let row = self.rows[word * 64 + bit].as_ref().expect("bound row");
                    let slot = row
                        .bindings
                        .binary_search_by_key(&prototype.id, |(id, _)| *id)
                        .expect("reverse binding");
                    let next = row.bindings[slot].1;
                    origin = Some(origin.map_or(next, |prior| Position {
                        column: prior.column.min(next.column),
                        line: prior.line.min(next.line),
                    }));
                }
            }
            if prototype.origin != origin {
                prototype.origin = origin;
                placements.invalidate(prototype.id);
            }
        }
    }

    pub(super) fn origin(&self, id: PlacementId) -> Option<Position> {
        let slot = self
            .prototypes
            .binary_search_by_key(&id, |prototype| prototype.id)
            .ok()?;
        self.prototypes[slot].origin
    }

    pub(super) fn row(&self, row: usize) -> &[Fragment] {
        self.rows[row]
            .as_ref()
            .map_or(&[], |row| row.fragments.as_slice())
    }

    pub(super) fn max_row(&self) -> usize {
        self.rows
            .iter()
            .flatten()
            .map(|row| row.fragments.len())
            .max()
            .unwrap_or(0)
    }

    pub(super) fn remove(&mut self, id: PlacementId) {
        let Ok(slot) = self
            .prototypes
            .binary_search_by_key(&id, |prototype| prototype.id)
        else {
            return;
        };
        let prototype = self.prototypes.remove(slot);
        if prototype.origin_dirty {
            self.dirty_origins.retain(|dirty| *dirty != id);
        }
        self.invalidate_selector(prototype.selector);
        self.invalidate_selector((prototype.selector.0, 0));
        for (word, rows) in prototype.rows.into_iter().enumerate() {
            let mut rows = rows;
            while rows != 0 {
                let bit = rows.trailing_zeros() as usize;
                rows &= rows - 1;
                let line = word * 64 + bit;
                self.changed[line] = true;
                let row = self.rows[line].as_mut().expect("bound row");
                row.fragments
                    .retain(|fragment| fragment.stack.placement != id.0.get());
                row.bindings.retain(|(bound, _)| *bound != id);
            }
        }
    }
}

impl Graphics {
    pub(super) fn refresh_placeholders(&mut self, term: &mut Term<EventForwarder>) {
        if self.placements.virtuals().len() == 0 {
            self.placeholders = None;
            return;
        }
        // Without cell pixels no placeholder binds; the index is rebuilt from
        // the grid once a viewport states them again.
        let Some(cell) = term
            .event_listener()
            .viewport
            .and_then(|viewport| viewport.cell)
        else {
            self.placeholders = None;
            return;
        };
        let columns = term.grid().columns() as u16;
        let rows = term.grid().screen_lines() as u16;
        loop {
            let count = self.placements.virtuals().len();
            if count == 0 {
                self.placeholders = None;
                return;
            }
            if self.placeholders.as_ref().is_some_and(|index| {
                index.columns != columns
                    || index.height != rows
                    || index.prototypes.capacity() < count
            }) {
                self.placeholders = None;
            }
            if self.placeholders.is_none() {
                self.placeholders = Index::new(&self.storage, columns, rows, count);
                self.projection_dirty = true;
                self.placements.invalidate_all();
            }
            if let Some(index) = &mut self.placeholders
                && let Some(changed) = index.refresh(&self.storage, term)
            {
                self.projection_dirty |= changed;
                if self.projection_dirty {
                    index.bind(&self.scene, &mut self.placements, cell);
                }
                return;
            }
            // No partial index or scene is published. Reproducible storage is
            // retired before deterministic source eviction makes room to retry.
            self.placeholders = None;
            self.clear_projection();
            self.projection_dirty = true;
            if !self.evict_projection_source(term) {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::TerminalState;

    #[test]
    fn reverse_selectors_track_missing_identities_and_charge_physical_storage() {
        let (tx, _) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(32, 20, tx);
        let budget = Budget::new(Usage {
            bytes: 8 << 20,
            objects: 4096,
        });
        for line in 0..20 {
            let text = format!(
                "\x1b[{};1H\x1b[38;5;{};58;5;7m{}",
                line + 1,
                line % 4 + 40,
                "\u{10eeee}".repeat(16)
            );
            terminal.parser.advance(&mut terminal.term, text.as_bytes());
        }
        crate::edge_tunnel::test_allocations::begin_thread();
        let mut index = Index::new(&budget, 32, 20, 1).unwrap();
        assert_eq!(index.refresh(&budget, &mut terminal.term), Some(true));
        let allocations = crate::edge_tunnel::test_allocations::end_thread();
        assert!(allocations.allocated_bytes <= budget.used().unwrap().bytes);
        assert_eq!(index.selectors.len(), 4);
        index.dirty.fill(false);
        index.invalidate_selector((42, 7));
        for line in 0..20 {
            assert_eq!(index.dirty[line], line % 4 == 2);
        }
        terminal.term.reset_damage();
        terminal
            .parser
            .advance(&mut terminal.term, b"\x1b[3;1H\x1b[2K");
        index.refresh(&budget, &mut terminal.term).unwrap();
        index.dirty.fill(false);
        index.invalidate_selector((42, 7));
        assert!(!index.dirty[2]);
        assert!(index.dirty[6]);
        drop(index);
        assert_eq!(
            budget.used().unwrap(),
            Usage {
                bytes: 0,
                objects: 0
            }
        );
    }

    #[test]
    fn grid_damage_refreshes_original_ids_and_reuses_unchanged_rows_without_allocation() {
        let (tx, _) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 3, tx);
        let budget = Budget::new(Usage {
            bytes: 1 << 20,
            objects: 32,
        });
        let mut index = Index::new(&budget, 8, 3, 1).unwrap();
        let text = "\x1b[38;5;42;58;5;7;7m\u{10eeee}\u{305}\u{305}\u{30e}\u{10eeee}";
        terminal.parser.advance(&mut terminal.term, text.as_bytes());
        assert_eq!(index.refresh(&budget, &mut terminal.term), Some(true));
        let cells = &index.rows[0].as_ref().unwrap().cells;
        assert_eq!(cells.len(), 2);
        assert_eq!(
            cells[0].placeholder,
            Placeholder {
                image_id: (2 << 24) | 42,
                placement_id: 7,
                row: 0,
                column: 0
            }
        );
        assert_eq!(cells[1].placeholder.column, 1);
        assert_eq!(cells[1].placeholder.image_id, (2 << 24) | 42);
        let allocation = cells.as_ptr();
        terminal.term.reset_damage();
        crate::edge_tunnel::test_allocations::begin_thread();
        let changed = index.refresh(&budget, &mut terminal.term);
        let allocations = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(changed, Some(false));
        assert_eq!(allocations.allocations, 0);
        assert_eq!(index.rows[0].as_ref().unwrap().cells.as_ptr(), allocation);

        terminal
            .parser
            .advance(&mut terminal.term, b"\x1b[1;1H\x1b[2K");
        assert_eq!(index.refresh(&budget, &mut terminal.term), Some(true));
        assert!(index.rows[0].is_none());
        drop(index);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }

    #[test]
    fn placeholder_row_allocation_cannot_escape_its_quota() {
        let (tx, _) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 3, tx);
        let budget = Budget::new(Usage {
            bytes: 1 << 20,
            objects: 5,
        });
        let mut index = Index::new(&budget, 8, 3, 1).unwrap();
        terminal
            .parser
            .advance(&mut terminal.term, "\x1b[38;5;42m\u{10eeee}".as_bytes());
        assert_eq!(index.refresh(&budget, &mut terminal.term), None);
        assert!(index.rows.iter().all(Option::is_none));
        drop(index);
        assert_eq!(
            budget.used(),
            Some(Usage {
                bytes: 0,
                objects: 0
            })
        );
    }
}
