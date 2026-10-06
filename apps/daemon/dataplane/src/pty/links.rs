//! OSC 8 hyperlink interning.
//!
//! A display datagram carries a link as a `u32` id on its cells, never as a
//! URI: an OSC 8 target has no length bound and a datagram has 1100 bytes. This
//! table owns the id space. Row capture interns the hyperlink each cell holds,
//! and the send path delivers `id → URI` definitions to every peer on the
//! reliable control lane.
//!
//! An id names a URI, not an OSC 8 region. A program that redraws a link emits
//! a new region each time — alacritty gives every region its own `Hyperlink`
//! allocation and, without an explicit OSC 8 id, its own generated id — and
//! keying on the region re-issued, re-defined and retired every link on every
//! redraw: measured at 11 KiB of definitions per redraw for 8 links on each of
//! 40 rows, a full reset each time, 3.4× the display bytes it accompanied. Keyed
//! on the URI, a redraw costs no definition at all.
//!
//! Every cell of one region clones one allocation, so capture first looks the
//! allocation up and hashes the URI only for an allocation it has not seen. The
//! table holds one clone of each allocation it has seen; an allocation whose
//! clone is the last one alive is referenced by no grid cell, scrollback line,
//! or open OSC 8 template, and a URI none of whose allocations is referenced is
//! retired. Retirement runs when the held clones have doubled since the
//! previous pass — amortized compaction bounded by the live set, not a timer —
//! and advances [`LinkTable::generation`] only when a URI actually left, which
//! is what tells a peer to replace its definitions rather than extend them.
//!
//! The pass runs only where every changed row has just been captured
//! ([`LinkTable::retire_unreferenced_if_due`]). In the middle of a capture, a
//! redrawn row further down already holds a new region of a URI whose old
//! region is gone, and the pass would retire that URI moments before
//! re-issuing it under a new id — a reset per redraw again.

use alacritty_terminal::term::cell::Hyperlink;
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::Arc;

/// Hashes a URI with the XXH3 the display codec already carries; like the
/// allocation map, a table of the process's own terminal output has no
/// flooding adversary SipHash would be defending against.
#[derive(Default)]
struct UriHasher(u64);

impl Hasher for UriHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        self.0 = self.0.rotate_left(5) ^ merkur_codec::hash_bytes(bytes);
    }
}

/// Hashes an allocation address, the one key capture looks up per new region.
/// SipHash's flooding resistance buys nothing for addresses the process chose
/// itself; a multiply-fold spreads their aligned low bits into every bucket bit.
#[derive(Default)]
struct AllocationHasher(u64);

impl Hasher for AllocationHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u64(u64::from(byte));
        }
    }

    fn write_u64(&mut self, value: u64) {
        let mixed = (self.0 ^ value).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        self.0 = mixed ^ (mixed >> 32);
    }

    fn write_usize(&mut self, value: usize) {
        self.write_u64(value as u64);
    }
}

#[cfg(test)]
use merkur_wire::protocol::OPEN_URL_MAX_BYTES;
use merkur_wire::protocol::has_web_scheme;
pub use merkur_wire::protocol::openable_url;

pub struct LiveLink {
    pub id: u32,
    pub uri: Arc<str>,
    /// One clone of every region allocation seen for this URI and not yet found
    /// unreferenced.
    allocations: Vec<Hyperlink>,
}

pub struct LinkTable {
    by_allocation: HashMap<usize, u32, BuildHasherDefault<AllocationHasher>>,
    by_uri: HashMap<Arc<str>, u32, BuildHasherDefault<UriHasher>>,
    /// Ascending by id, so a peer's definitions since some id are a suffix.
    live: Vec<LiveLink>,
    held_allocations: usize,
    next_id: u32,
    prune_at: usize,
    generation: u64,
}

impl Default for LinkTable {
    fn default() -> Self {
        Self {
            by_allocation: HashMap::default(),
            by_uri: HashMap::default(),
            live: Vec::new(),
            held_allocations: 0,
            next_id: 1,
            prune_at: 1,
            generation: 1,
        }
    }
}

impl LinkTable {
    /// The id for `link`'s URI, issuing one on first sight, or 0 for a link the
    /// browser would refuse to open.
    ///
    /// Refused links — `file:` from `ls --hyperlink` and systemd, `man:`,
    /// editor schemes — are the common OSC 8 output and would cost a row span
    /// table, a digest suffix and a definition on every snapshot for a link the
    /// browser never opens. They render as the plain text they are.
    ///
    /// Ids are never reused within a table, so a stale row a peer still shows
    /// can name a retired link but never a different one. The id space is a
    /// resource bound: after `u32::MAX` distinct URIs in one dataplane
    /// lifetime, new ones render as plain text rather than wrap onto a live id.
    pub fn intern(&mut self, link: &Hyperlink) -> u32 {
        if let Some(&id) = self.by_allocation.get(&link.allocation()) {
            return id;
        }
        // A refused region is never indexed, so every capture of one would hash
        // and scan its URI again. Vetting requires a web scheme, so a URI
        // without one is refused on its prefix alone.
        if !has_web_scheme(link.uri().as_bytes()) {
            return 0;
        }
        // A known URI was vetted when it was issued, so a redraw skips the scan.
        let id = match self.by_uri.get(link.uri()) {
            Some(&id) => {
                let index = self
                    .live
                    .binary_search_by_key(&id, |live| live.id)
                    .expect("every URI in the index is live");
                self.live[index].allocations.push(link.clone());
                id
            }
            None => {
                if openable_url(link.uri().as_bytes()).is_none() {
                    return 0;
                }
                let id = self.next_id;
                let Some(next_id) = id.checked_add(1) else {
                    return 0;
                };
                self.next_id = next_id;
                let uri: Arc<str> = Arc::from(link.uri());
                self.by_uri.insert(Arc::clone(&uri), id);
                self.live.push(LiveLink {
                    id,
                    uri,
                    allocations: vec![link.clone()],
                });
                id
            }
        };
        self.by_allocation.insert(link.allocation(), id);
        self.held_allocations += 1;
        id
    }

    /// Release unreferenced regions and retire URIs left with none, once the
    /// held regions have doubled since the last pass. Call only after every
    /// changed row has been captured; see the module note.
    pub fn retire_unreferenced_if_due(&mut self) {
        if self.held_allocations >= self.prune_at {
            self.retire_unreferenced();
        }
    }

    fn retire_unreferenced(&mut self) {
        let before = self.live.len();
        let by_allocation = &mut self.by_allocation;
        let by_uri = &mut self.by_uri;
        let mut held = 0usize;
        self.live.retain_mut(|live| {
            live.allocations.retain(|allocation| {
                let referenced = allocation.strong_count() > 1;
                if !referenced {
                    by_allocation.remove(&allocation.allocation());
                }
                referenced
            });
            held += live.allocations.len();
            let referenced = !live.allocations.is_empty();
            if !referenced {
                by_uri.remove(&live.uri);
            }
            referenced
        });
        self.held_allocations = held;
        if self.live.len() != before {
            self.generation += 1;
        }
        self.prune_at = held.saturating_mul(2).max(1);
    }

    /// Changes whenever a link is retired. A peer that last received a
    /// different generation must replace its whole table.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Newest issued id, or 0 before the first.
    pub fn newest_id(&self) -> u32 {
        self.next_id - 1
    }

    /// Every live link, ascending by id.
    pub fn live(&self) -> &[LiveLink] {
        &self.live
    }

    /// Live links issued after `id`, ascending.
    pub fn issued_after(&self, id: u32) -> &[LiveLink] {
        let start = self.live.partition_point(|live| live.id <= id);
        &self.live[start..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(uri: &str) -> Hyperlink {
        Hyperlink::new(None::<String>, uri.to_owned())
    }

    #[test]
    fn one_uri_is_one_id_across_regions_and_ids_are_never_reused() {
        let mut table = LinkTable::default();
        let first = link("https://a.example");
        let clone = first.clone();
        let same_uri = link("https://a.example");
        let other = link("https://b.example");
        assert_eq!(table.intern(&first), 1);
        assert_eq!(table.intern(&clone), 1);
        assert_eq!(table.intern(&same_uri), 1, "a second region of one URI");
        assert_eq!(table.intern(&other), 2);
        assert_eq!(table.newest_id(), 2);
        assert_eq!(table.issued_after(1).len(), 1);
        assert_eq!(table.issued_after(1)[0].id, 2);
    }

    #[test]
    fn a_link_the_browser_cannot_open_gets_no_id() {
        let mut table = LinkTable::default();
        for uri in [
            "file:///etc/hosts",
            "man:ls(1)",
            "javascript:alert(1)",
            "https://",
            "https://a b",
        ] {
            assert_eq!(table.intern(&link(uri)), 0, "{uri}");
        }
        assert!(table.live().is_empty());
        assert_eq!(table.newest_id(), 0);
        // A refused region leaves no trace: nothing held, nothing indexed.
        assert!(table.by_allocation.is_empty() && table.by_uri.is_empty());
        assert_eq!(table.held_allocations, 0);
        assert_eq!(table.intern(&link("HTTPS://a.example/")), 1);
    }

    /// `openable_url` as it read before the scheme test moved first, kept as
    /// the oracle for the reordered conjunction.
    fn openable_url_oracle(url: &[u8]) -> Option<&str> {
        if url.len() > OPEN_URL_MAX_BYTES || !url.iter().all(|byte| (0x21..=0x7e).contains(byte)) {
            return None;
        }
        let text = std::str::from_utf8(url).ok()?;
        let lower_prefix = |prefix: &str| {
            text.len() > prefix.len() && text[..prefix.len()].eq_ignore_ascii_case(prefix)
        };
        (lower_prefix("http://") || lower_prefix("https://")).then_some(text)
    }

    #[test]
    fn testing_the_scheme_first_accepts_and_refuses_exactly_what_it_did() {
        let longest = format!("https://{}", "x".repeat(OPEN_URL_MAX_BYTES - 8));
        let mut urls: Vec<Vec<u8>> = [
            "https://a.example/",
            "HTTP://b.example",
            "hTtPs://c",
            "http://",
            "https://",
            "http:/x",
            "https//x",
            "http:",
            "h",
            "",
            " https://x",
            "https://a b",
            "https://a\tb",
            "https://é.example",
            "file:///etc/hosts",
            "man:ls(1)",
            "vscode://file/x",
            "ftp://x",
        ]
        .map(|url| url.as_bytes().to_vec())
        .to_vec();
        urls.extend([
            b"https://a\x7f".to_vec(),
            b"https://\xff".to_vec(),
            b"http\xff//x".to_vec(),
            format!("{longest}x").into_bytes(),
            longest.into_bytes(),
        ]);
        for url in &urls {
            assert_eq!(
                openable_url(url),
                openable_url_oracle(url),
                "{:?}",
                String::from_utf8_lossy(&url[..url.len().min(32)])
            );
        }
    }

    #[test]
    fn a_redrawn_link_keeps_its_id_without_a_new_generation() {
        let mut table = LinkTable::default();
        let generation = table.generation();
        let mut region = link("https://a.example");
        let id = table.intern(&region);
        // Each redraw drops the previous region, emits a new one, and is
        // captured before the pass runs.
        for _ in 0..64 {
            region = link("https://a.example");
            assert_eq!(table.intern(&region), id);
            table.retire_unreferenced_if_due();
        }
        assert_eq!(table.newest_id(), id);
        assert_eq!(table.generation(), generation);
        assert!(table.held_allocations <= 2, "dead regions are released");
    }

    #[test]
    fn a_uri_no_cell_references_is_retired_and_bumps_the_generation() {
        let mut table = LinkTable::default();
        let kept = link("https://kept.example");
        table.intern(&kept);
        {
            let dropped = link("https://gone.example");
            table.intern(&dropped);
        }
        let generation = table.generation();
        table.retire_unreferenced_if_due();
        assert_ne!(table.generation(), generation);
        let live: Vec<u32> = table.live().iter().map(|live| live.id).collect();
        assert_eq!(live, [1]);
        let third = link("https://third.example");
        assert_eq!(table.intern(&third), 3, "retirement never recycles an id");
        assert_eq!(table.intern(&link("https://gone.example")), 4);
    }

    #[test]
    fn a_fully_referenced_table_grows_without_a_new_generation() {
        let mut table = LinkTable::default();
        let links: Vec<Hyperlink> = (0..64)
            .map(|index| link(&format!("https://{index}.example")))
            .collect();
        let generation = table.generation();
        for link in &links {
            table.intern(link);
        }
        assert_eq!(table.live().len(), 64);
        assert_eq!(table.generation(), generation);
    }
}
