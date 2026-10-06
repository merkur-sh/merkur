//! Receiver-local admission, populated before sending encrypted control requests.
//! One table belongs to one authenticated attachment/key epoch. No hash authorizes
//! a fetch; the sender independently checks its live terminal source namespace.

use super::{
    CONTENT_CHUNK_BYTES, CONTENT_MAX_OBJECT_BYTES, CONTENT_MAX_TRANSFERS, ContentDescriptor,
    ContentError,
};

#[derive(Clone, Copy)]
enum Expected {
    Whole {
        request: u64,
        source: [u8; 32],
        max_bytes: u32,
    },
    Range(ContentDescriptor),
}

impl Expected {
    fn request(&self) -> u64 {
        match self {
            Self::Whole { request, .. } => *request,
            Self::Range(range) => range.request(),
        }
    }

    fn matches(&self, descriptor: &ContentDescriptor) -> bool {
        match self {
            Self::Whole {
                request,
                source,
                max_bytes,
            } => {
                descriptor.request() == *request
                    && descriptor.source() == source
                    && descriptor.object_bytes() <= *max_bytes
                    && descriptor.first() == 0
                    && descriptor.count() as usize
                        == (descriptor.object_bytes() as usize).div_ceil(CONTENT_CHUNK_BYTES)
            }
            Self::Range(range) => descriptor == range,
        }
    }
}

/// Fixed pending-request storage, separate from admitted transfer buffers. IDs
/// increase strictly within this epoch; consumed/cancelled requests cannot revive.
/// Cancellation after admission belongs to the returned receiver's owner.
pub struct ContentRequests {
    pending: [Option<Expected>; CONTENT_MAX_TRANSFERS as usize],
    last: u64,
}

impl Default for ContentRequests {
    fn default() -> Self {
        Self {
            pending: [None; CONTENT_MAX_TRANSFERS as usize],
            last: 0,
        }
    }
}

impl ContentRequests {
    /// Register before sending a fresh request. The daemon supplies the object
    /// hash and exact length in its authenticated header, avoiding an offer flight.
    pub fn whole(
        &mut self,
        request: u64,
        source: [u8; 32],
        max_bytes: u32,
    ) -> Result<(), ContentError> {
        if request == 0 || max_bytes == 0 || max_bytes as usize > CONTENT_MAX_OBJECT_BYTES {
            return Err(ContentError::Invalid);
        }
        self.insert(Expected::Whole {
            request,
            source,
            max_bytes,
        })
    }

    /// Resume only an exact range of the previously authenticated encoded object.
    pub fn range(&mut self, descriptor: ContentDescriptor) -> Result<(), ContentError> {
        self.insert(Expected::Range(descriptor))
    }

    fn insert(&mut self, expected: Expected) -> Result<(), ContentError> {
        if expected.request() <= self.last {
            return Err(ContentError::Replay);
        }
        let slot = self
            .pending
            .iter_mut()
            .find(|slot| slot.is_none())
            .ok_or(ContentError::Capacity)?;
        *slot = Some(expected);
        self.last = expected.request();
        Ok(())
    }

    pub fn cancel(&mut self, request: u64) -> bool {
        if let Some(slot) = self
            .pending
            .iter_mut()
            .find(|slot| slot.is_some_and(|entry| entry.request() == request))
        {
            *slot = None;
            true
        } else {
            false
        }
    }

    pub(super) fn matching(&self, descriptor: &ContentDescriptor) -> Option<usize> {
        self.pending
            .iter()
            .position(|slot| slot.is_some_and(|entry| entry.matches(descriptor)))
    }

    pub(super) fn consume(&mut self, slot: usize) {
        self.pending[slot] = None;
    }
}
