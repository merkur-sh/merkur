//! Canonical APC handoff without copying or allocating a second chunk buffer.
//!
//! The parser stops at a completed graphics command. Its owner inspects `pending`,
//! performs the semantic mutation or bounded queue handoff, then acknowledges it.
//! Final upload chunks additionally hold the parser until validation completes.

use crate::command::{Control, Error, Receiver};
use crate::ingest::{CommandId, Ingest, Step};

#[derive(Clone, Copy)]
enum Pending {
    Rejected {
        error: Error,
        control: Option<Control>,
    },
    Command {
        id: CommandId,
        control: Control,
    },
    Data {
        id: CommandId,
        control: Control,
        first: bool,
        last: bool,
    },
}

pub struct Boundary {
    receiver: Receiver,
    ingest: Ingest,
    pending: Option<Pending>,
}

impl Boundary {
    pub fn new(max_encoded_bytes: usize) -> Self {
        Self {
            receiver: Receiver::default(),
            ingest: Ingest::new(max_encoded_bytes),
            pending: None,
        }
    }

    pub fn start(&mut self) {
        assert!(
            !self.paused(),
            "parser advanced through a graphics boundary"
        );
        self.receiver.start();
    }

    pub fn push(&mut self, bytes: &[u8]) {
        assert!(
            !self.paused(),
            "parser advanced through a graphics boundary"
        );
        self.receiver.push(bytes);
    }

    pub fn end(&mut self, complete: bool) {
        assert!(
            !self.paused(),
            "parser advanced through a graphics boundary"
        );
        self.pending = match self.ingest.accept(self.receiver.finish(complete)) {
            Step::Ignored => None,
            Step::Rejected { error, control } => Some(Pending::Rejected { error, control }),
            Step::Command { id, control } => Some(Pending::Command { id, control }),
            Step::Data {
                id,
                control,
                first,
                last,
                ..
            } => Some(Pending::Data {
                id,
                control,
                first,
                last,
            }),
        };
    }

    pub fn paused(&self) -> bool {
        self.pending.is_some() || self.ingest.validation_pending()
    }

    pub fn pending(&self) -> Option<Step<'_>> {
        Some(match self.pending? {
            Pending::Rejected { error, control } => Step::Rejected { error, control },
            Pending::Command { id, control } => Step::Command { id, control },
            Pending::Data {
                id,
                control,
                first,
                last,
            } => Step::Data {
                id,
                control,
                first,
                last,
                encoded: self.receiver.payload(),
            },
        })
    }

    /// Called only after the command is applied, rejected, or handed to the
    /// reserved helper queue. A full queue leaves the same bytes available.
    pub fn acknowledge(&mut self) -> bool {
        self.pending.take().is_some()
    }

    pub fn finish_validation(&mut self, id: CommandId) -> bool {
        self.pending.is_none() && self.ingest.finish_validation(id)
    }

    /// RIS cancels continuation state but never reuses a command identity.
    pub fn reset(&mut self) {
        self.pending = None;
        self.ingest.cancel();
    }

    /// Lifecycle retirement invalidates both the staging boundary and any
    /// in-flight completion. The caller separately retires publication authority.
    pub fn retire(&mut self) {
        self.pending = None;
        self.ingest.retire();
    }
}
