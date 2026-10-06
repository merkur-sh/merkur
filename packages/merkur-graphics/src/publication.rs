//! One-use publication rights for asynchronous image processing.
//!
//! A helper result is not terminal authority. The trusted owner validates its
//! immutable output before presenting its fence and the current scene state
//! here. None of the current-state arguments may come from the helper.

use core::num::NonZeroU64;

use crate::command::Error;
use crate::ingest::CommandId;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalIncarnation(pub [u8; 16]);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImageIncarnation(pub NonZeroU64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Revision(pub NonZeroU64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fence {
    pub terminal: TerminalIncarnation,
    pub command: CommandId,
    pub image: ImageIncarnation,
    pub predecessor: Option<Revision>,
}

/// Lives with the terminal owner, never with a helper or transport attachment.
/// It is deliberately not Clone; outstanding publication rights have one owner.
pub struct PublicationGate {
    terminal: TerminalIncarnation,
    last_command: u64,
    pending: Option<Fence>,
    retired: bool,
}

impl PublicationGate {
    pub const fn new(terminal: TerminalIncarnation) -> Self {
        Self {
            terminal,
            last_command: 0,
            pending: None,
            retired: false,
        }
    }

    pub fn begin(
        &mut self,
        command: CommandId,
        image: ImageIncarnation,
        predecessor: Option<Revision>,
    ) -> Result<Fence, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if self.pending.is_some() {
            return Err(Error::ValidationPending);
        }
        if command.get() <= self.last_command {
            return Err(Error::InvalidControl);
        }
        self.last_command = command.get();
        let fence = Fence {
            terminal: self.terminal,
            command,
            image,
            predecessor,
        };
        self.pending = Some(fence);
        Ok(fence)
    }

    /// Consume only this job's right to publish into the still-current scene.
    /// Rejected results have no effect on another pending job's rights.
    pub fn accept(
        &mut self,
        result: Fence,
        current_image: ImageIncarnation,
        current_predecessor: Option<Revision>,
    ) -> bool {
        if self.retired
            || self.pending != Some(result)
            || result.image != current_image
            || result.predecessor != current_predecessor
        {
            return false;
        }
        self.pending = None;
        true
    }

    pub fn cancel(&mut self) {
        self.pending = None;
    }

    pub fn retire(&mut self) {
        self.cancel();
        self.retired = true;
    }
}
