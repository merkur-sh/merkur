//! Terminal-owned namespaces. Client IDs never identify an immutable revision.
//!
//! This module performs no image processing. A caller supplies an immutable,
//! already validated content root; its storage reservation travels with it.

use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;
use std::sync::Arc;

use crate::budget::{Budget, Lease, Usage};
use crate::command::{Action, Control, Error, Key};
use crate::ingest::CommandId;
use crate::projection::Content;
use crate::publication::{Fence, ImageIncarnation, PublicationGate, Revision, TerminalIncarnation};

/// Immutable validated content and its publication lifetime. Retirement revokes
/// processing/fetch access without freeing storage still held by existing readers.
pub trait SceneContent {
    fn descriptor(&self) -> Content;
    fn retire(&self);
}

/// Resource bound for sparse indices, tree nodes and Arc bookkeeping. The
/// concrete Image<C> allocation is added at admission; pixels are separately charged.
pub const IMAGE_METADATA_BYTES: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SceneError {
    Protocol(Error),
    MissingImage,
    Quota,
    Stale,
}

impl From<Error> for SceneError {
    fn from(error: Error) -> Self {
        Self::Protocol(error)
    }
}

/// A capture retains this exact root even after the client reuses its image ID.
pub struct Image<C> {
    pub incarnation: ImageIncarnation,
    pub revision: Revision,
    pub client_id: u32,
    pub number: Option<u32>,
    pub width: u32,
    pub height: u32,
    /// Declared before `content`: the metadata refund precedes content release,
    /// so a content release completion implies it.
    _metadata: Lease,
    pub content: C,
    source_root: [u8; 32],
}

struct Pending {
    fence: Fence,
    client_id: u32,
    number: Option<u32>,
    replaces: Option<ImageIncarnation>,
    query: bool,
    metadata: Option<Lease>,
}

/// Namespace mutation and publication rights have one terminal owner. There is
/// one pending upload because the canonical parser serializes commit boundaries.
pub struct Scene<C: SceneContent> {
    gate: PublicationGate,
    metadata: Budget,
    images: BTreeMap<ImageIncarnation, Arc<Image<C>>>,
    ids: BTreeMap<u32, ImageIncarnation>,
    numbers: BTreeMap<u32, BTreeSet<ImageIncarnation>>,
    sources: BTreeMap<[u8; 32], BTreeSet<ImageIncarnation>>,
    last_incarnation: u64,
    last_revision: u64,
    next_client_id: u32,
    pending: Option<Pending>,
    retired: bool,
}

pub enum Published<C> {
    Query,
    Image {
        image: Arc<Image<C>>,
        /// A predecessor under the same name, whose placements the caller retires.
        replaced: Option<ImageIncarnation>,
        /// The image whose content this publication retired: the replaced
        /// predecessor, or the revision an edit superseded in place. The caller
        /// learns what storage its release returns.
        retired: Option<Arc<Image<C>>>,
    },
}

impl<C: SceneContent> Scene<C> {
    pub fn new(terminal: TerminalIncarnation, metadata: Budget) -> Self {
        Self {
            gate: PublicationGate::new(terminal),
            metadata,
            images: BTreeMap::new(),
            ids: BTreeMap::new(),
            numbers: BTreeMap::new(),
            sources: BTreeMap::new(),
            last_incarnation: 0,
            last_revision: 0,
            next_client_id: 1,
            pending: None,
            retired: false,
        }
    }

    pub fn len(&self) -> usize {
        self.images.len()
    }
    pub fn is_empty(&self) -> bool {
        self.images.is_empty()
    }

    /// Deterministic source-eviction order, independent of names and access timing.
    pub fn oldest(&self) -> Option<ImageIncarnation> {
        self.images.first_key_value().map(|(id, _)| *id)
    }

    pub fn image(&self, incarnation: ImageIncarnation) -> Option<&Arc<Image<C>>> {
        self.images.get(&incarnation)
    }

    /// Lookup is scoped to this terminal's live namespace. A digest alone is not
    /// permission: deletion, replacement, eviction and reset remove membership.
    /// Retaining the returned image does not extend its content's access lifetime.
    pub fn source(&self, root: &[u8; 32]) -> Option<&Arc<Image<C>>> {
        self.sources
            .get(root)?
            .last()
            .and_then(|id| self.images.get(id))
    }

    pub fn resolve_id(&self, id: u32) -> Option<ImageIncarnation> {
        self.ids.get(&id).copied()
    }

    /// Inclusive namespace range, including images with no remaining placements.
    pub fn ids_in_range(
        &self,
        first: u32,
        last: u32,
    ) -> impl Iterator<Item = ImageIncarnation> + '_ {
        self.ids.range(first..=last).map(|(_, image)| *image)
    }

    /// Image numbers select the newest *remaining* upload with that number.
    pub fn resolve(&self, control: &Control) -> Result<ImageIncarnation, SceneError> {
        let id = control.get(Key::ImageId);
        let number = control.get(Key::ImageNumber);
        if id.is_some() && number.is_some() {
            return Err(Error::InvalidControl.into());
        }
        let found = match (id, number) {
            (Some(id), None) if id != 0 => self.resolve_id(id),
            (None, Some(number)) if number != 0 => self
                .numbers
                .get(&number)
                .and_then(|entries| entries.last().copied()),
            _ => None,
        };
        found.ok_or(SceneError::MissingImage)
    }

    /// Reserve metadata and a fresh identity without changing live image state.
    /// Even a query consumes a non-reusable internal identity, never a client ID.
    pub fn begin(&mut self, command: CommandId, control: &Control) -> Result<Fence, SceneError> {
        if self.retired {
            return Err(Error::Retired.into());
        }
        if self.pending.is_some() {
            return Err(Error::ValidationPending.into());
        }
        let action = control.action()?;
        if !matches!(
            action,
            Action::Transmit | Action::TransmitAndPlace | Action::Query
        ) {
            return Err(Error::InvalidControl.into());
        }
        if control.get(Key::ImageId).is_some() && control.get(Key::ImageNumber).is_some() {
            return Err(Error::InvalidControl.into());
        }
        let query = action == Action::Query;
        let number = control.get(Key::ImageNumber).filter(|number| *number != 0);
        let metadata = if query {
            None
        } else {
            Some(
                self.metadata
                    .reserve(Usage {
                        bytes: IMAGE_METADATA_BYTES + std::mem::size_of::<Image<C>>(),
                        objects: 1,
                    })
                    .ok_or(SceneError::Quota)?,
            )
        };
        let client_id = if number.is_some() && !query {
            self.allocate_client_id()?
        } else {
            control.get(Key::ImageId).unwrap_or(0)
        };
        let replaces = if query {
            None
        } else {
            self.ids.get(&client_id).copied()
        };
        let predecessor = replaces.and_then(|id| self.images.get(&id).map(|image| image.revision));
        let incarnation = ImageIncarnation(next_identity(&mut self.last_incarnation)?);
        let fence = self.gate.begin(command, incarnation, predecessor)?;
        self.pending = Some(Pending {
            fence,
            client_id,
            number,
            replaces,
            query,
            metadata,
        });
        Ok(fence)
    }

    fn allocate_client_id(&mut self) -> Result<u32, SceneError> {
        loop {
            let candidate = self.next_client_id;
            if candidate == 0 {
                return Err(Error::IdentityExhausted.into());
            }
            self.next_client_id = candidate.checked_add(1).unwrap_or(0);
            if !self.ids.contains_key(&candidate) {
                return Ok(candidate);
            }
        }
    }

    /// An animation edit retains its image/placement identity, but consumes a
    /// fresh publication right tied to the exact preceding immutable revision.
    pub fn begin_edit(
        &mut self,
        command: CommandId,
        incarnation: ImageIncarnation,
    ) -> Result<Fence, SceneError> {
        if self.retired {
            return Err(Error::Retired.into());
        }
        if self.pending.is_some() {
            return Err(Error::ValidationPending.into());
        }
        let image = self
            .images
            .get(&incarnation)
            .ok_or(SceneError::MissingImage)?;
        let metadata = self
            .metadata
            .reserve(Usage {
                bytes: IMAGE_METADATA_BYTES + size_of::<Image<C>>(),
                objects: 1,
            })
            .ok_or(SceneError::Quota)?;
        let fence = self
            .gate
            .begin(command, incarnation, Some(image.revision))?;
        self.pending = Some(Pending {
            fence,
            client_id: image.client_id,
            number: image.number,
            replaces: Some(incarnation),
            query: false,
            metadata: Some(metadata),
        });
        Ok(fence)
    }

    /// Only trusted immutable output may cross this boundary. Failed or stale
    /// publication drops that output and its leases without mutating the scene.
    pub fn publish(&mut self, fence: Fence, content: C) -> Result<Published<C>, SceneError> {
        let Content {
            root,
            width,
            height,
            ..
        } = content.descriptor();
        if crate::processing::pixel_bytes(width, height, 4).is_none() {
            return Err(Error::InvalidControl.into());
        }
        let pending = self
            .pending
            .as_ref()
            .filter(|pending| pending.fence == fence)
            .ok_or(SceneError::Stale)?;
        // All predecessor state comes from the owner, never the worker result.
        let current = pending
            .replaces
            .and_then(|id| self.images.get(&id).map(|image| image.revision));
        if current != fence.predecessor {
            return Err(SceneError::Stale);
        }
        let editing = pending.replaces == Some(fence.image);
        if editing
            && self
                .images
                .get(&fence.image)
                .is_none_or(|image| image.width != width || image.height != height)
        {
            return Err(Error::InvalidControl.into());
        }
        // Reserve the revision before consuming the one-use publication right.
        let revision = if pending.query {
            None
        } else {
            Some(Revision(next_identity(&mut self.last_revision)?))
        };
        if !self.gate.accept(fence, pending.fence.image, current) {
            return Err(SceneError::Stale);
        }
        let pending = self.pending.take().ok_or(SceneError::Stale)?;
        if pending.query {
            return Ok(Published::Query);
        }
        let image = Arc::new(Image {
            incarnation: fence.image,
            revision: revision.ok_or(SceneError::Stale)?,
            client_id: pending.client_id,
            number: pending.number,
            width,
            height,
            content,
            source_root: root,
            _metadata: pending.metadata.ok_or(SceneError::Stale)?,
        });
        if editing {
            let old = self
                .images
                .insert(image.incarnation, Arc::clone(&image))
                .expect("fenced live predecessor");
            old.content.retire();
            if old.source_root != root {
                if let Some(entries) = self.sources.get_mut(&old.source_root) {
                    entries.remove(&old.incarnation);
                    if entries.is_empty() {
                        self.sources.remove(&old.source_root);
                    }
                }
                self.sources
                    .entry(root)
                    .or_default()
                    .insert(image.incarnation);
            }
            // Names and upload ordering are unchanged. Existing placement
            // dependencies keep the incarnation and observe the fresh content.
            return Ok(Published::Image {
                image,
                replaced: None,
                retired: Some(old),
            });
        }
        let retired = pending.replaces.and_then(|old| self.remove(old));
        self.images.insert(image.incarnation, Arc::clone(&image));
        self.sources
            .entry(root)
            .or_default()
            .insert(image.incarnation);
        if image.client_id != 0 {
            self.ids.insert(image.client_id, image.incarnation);
        }
        if let Some(number) = image.number {
            self.numbers
                .entry(number)
                .or_default()
                .insert(image.incarnation);
        }
        Ok(Published::Image {
            image,
            replaced: pending.replaces,
            retired,
        })
    }

    /// Placement ownership must be retired by the caller in the same mutation.
    /// A reader still holding the returned image keeps it, and its content's
    /// storage charge, until it drops it.
    pub fn remove(&mut self, incarnation: ImageIncarnation) -> Option<Arc<Image<C>>> {
        let image = self.images.remove(&incarnation)?;
        image.content.retire();
        if let Some(entries) = self.sources.get_mut(&image.source_root) {
            entries.remove(&incarnation);
            if entries.is_empty() {
                self.sources.remove(&image.source_root);
            }
        }
        if image.client_id != 0 {
            self.ids.remove(&image.client_id);
        }
        if let Some(number) = image.number
            && let Some(entries) = self.numbers.get_mut(&number)
        {
            entries.remove(&incarnation);
            if entries.is_empty() {
                self.numbers.remove(&number);
            }
        }
        // Removing a predecessor revokes the command that was going to replace it.
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.replaces == Some(incarnation))
        {
            self.cancel();
        }
        if self.images.is_empty() {
            self.images = BTreeMap::new();
            self.ids = BTreeMap::new();
            self.numbers = BTreeMap::new();
            self.sources = BTreeMap::new();
        }
        Some(image)
    }

    pub fn cancel(&mut self) {
        self.gate.cancel();
        self.pending = None;
    }

    /// RIS empties the namespace without resetting any identity counter. Returns
    /// the removed images, retired, for the caller to learn what their release
    /// returns.
    pub fn clear(&mut self) -> BTreeMap<ImageIncarnation, Arc<Image<C>>> {
        self.cancel();
        for image in self.images.values() {
            image.content.retire();
        }
        // Index storage cannot outlive the leases held by image roots.
        self.ids = BTreeMap::new();
        self.numbers = BTreeMap::new();
        self.sources = BTreeMap::new();
        std::mem::take(&mut self.images)
    }

    pub fn retire(&mut self) {
        self.clear();
        self.gate.retire();
        self.retired = true;
    }
}

impl<C: SceneContent> Drop for Scene<C> {
    fn drop(&mut self) {
        self.clear();
    }
}

fn next_identity(value: &mut u64) -> Result<NonZeroU64, Error> {
    let next = value
        .checked_add(1)
        .and_then(NonZeroU64::new)
        .ok_or(Error::IdentityExhausted)?;
    *value = next.get();
    Ok(next)
}
