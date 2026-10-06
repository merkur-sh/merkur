//! One upload continuation per terminal, with no owned image bytes.
//!
//! The receiver borrows each admitted chunk to a bounded helper-input queue.
//! The caller must reserve storage before accepting it. This state machine's
//! cumulative bound is additional to, not a replacement for, that reservation.

use crate::command::{Action, Chunk, Control, Error, Format, Key, Received};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommandId(u64);

impl CommandId {
    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(PartialEq, Eq)]
pub enum Step<'a> {
    Ignored,
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
        encoded: &'a [u8],
    },
}

impl core::fmt::Debug for Step<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Ignored => f.write_str("Ignored"),
            Self::Rejected { error, .. } => f.debug_tuple("Rejected").field(error).finish(),
            Self::Command { .. } => f.write_str("Command { .. }"),
            Self::Data {
                first,
                last,
                encoded,
                ..
            } => f
                .debug_struct("Data")
                .field("first", first)
                .field("last", last)
                .field("encoded_bytes", &encoded.len())
                .finish_non_exhaustive(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Idle,
    Receiving {
        id: CommandId,
        control: Control,
        bytes: usize,
    },
    Validating(CommandId),
    Retired,
}

pub struct Ingest {
    state: State,
    last_command: u64,
    max_encoded_bytes: usize,
}

impl Ingest {
    pub const fn new(max_encoded_bytes: usize) -> Self {
        Self {
            state: State::Idle,
            last_command: 0,
            max_encoded_bytes,
        }
    }

    pub const fn validation_pending(&self) -> bool {
        matches!(self.state, State::Validating(_))
    }

    /// A result may resume only the command that currently owns the barrier.
    /// Whether it was successful is decided after isolated validation and
    /// publication fencing, before allowing subsequent terminal semantics.
    pub fn finish_validation(&mut self, id: CommandId) -> bool {
        if self.state != State::Validating(id) {
            return false;
        }
        self.state = State::Idle;
        true
    }

    /// Lifecycle cancellation also revokes any validation continuation.
    pub fn cancel(&mut self) {
        if self.state != State::Retired {
            self.state = State::Idle;
        }
    }

    pub fn retire(&mut self) {
        self.state = State::Retired;
    }

    pub fn accept<'a>(&mut self, received: Received<'a>) -> Step<'a> {
        if self.state == State::Retired {
            return Step::Rejected {
                error: Error::Retired,
                control: None,
            };
        }
        if self.validation_pending() {
            return Step::Rejected {
                error: Error::ValidationPending,
                control: None,
            };
        }
        // Continuation failures report the original upload identity and quiet
        // policy. A rejected new command retains its own parsed reply context.
        let incoming = match &received {
            Received::Chunk(chunk) => Some(chunk.control),
            Received::Rejected { control, .. } => *control,
            _ => None,
        };
        let response = match self.state {
            State::Receiving { control, .. }
                if incoming.and_then(|control| control.action().ok()) != Some(Action::Delete) =>
            {
                Some(incoming.map_or(control, |incoming| control.with_quiet_from(&incoming)))
            }
            _ => incoming,
        };
        let result = match received {
            Received::Ignored => return Step::Ignored,
            Received::Cancelled => Err(Error::Cancelled),
            Received::Rejected { error, .. } => Err(error),
            Received::Chunk(chunk) => self.accept_chunk(chunk),
        };
        match result {
            Ok(step) => step,
            Err(error) => {
                self.cancel();
                Step::Rejected {
                    error,
                    control: response,
                }
            }
        }
    }

    fn next_command(&mut self) -> Result<CommandId, Error> {
        self.last_command = self
            .last_command
            .checked_add(1)
            .ok_or(Error::IdentityExhausted)?;
        Ok(CommandId(self.last_command))
    }

    fn accept_chunk<'a>(&mut self, chunk: Chunk<'a>) -> Result<Step<'a>, Error> {
        // Defense in depth for native callers constructing Chunk directly.
        chunk.control.require_supported_medium()?;
        chunk.control.quiet()?;
        if chunk.control.get(Key::ImageId).is_some()
            && chunk.control.get(Key::ImageNumber).is_some()
        {
            return Err(Error::InvalidControl);
        }
        let action = chunk.control.action()?;
        let more = chunk.control.more()?;
        if chunk.payload.len() > crate::command::MAX_CHUNK_BYTES {
            return Err(Error::ChunkTooLarge);
        }

        // Deletion is the sole command allowed to interrupt a chunked upload.
        if action == Action::Delete {
            self.cancel();
        }

        if let State::Receiving { id, control, bytes } = self.state {
            if !chunk.control.continuation(control.action()?) {
                return Err(Error::InvalidContinuation);
            }
            let control = control.with_quiet_from(&chunk.control);
            let total = bytes
                .checked_add(chunk.payload.len())
                .ok_or(Error::UploadTooLarge)?;
            self.admit_chunk(id, control, total, more, chunk.payload, false)
        } else if chunk.control.native_reference() {
            // A native reference names already validated bytes. Its descriptor
            // submission owns all decoding metadata; no chunk continuation or
            // second interpretation of those bytes is permitted through the PTY.
            if !matches!(
                action,
                Action::Transmit | Action::TransmitAndPlace | Action::Query | Action::Frame
            ) || more
                || chunk.payload.len() != 64
                || !chunk
                    .payload
                    .iter()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
                || [
                    Key::Format,
                    Key::Compression,
                    Key::Width,
                    Key::Height,
                    Key::Size,
                    Key::Offset,
                ]
                .into_iter()
                .any(|key| chunk.control.get(key).is_some())
            {
                return Err(Error::InvalidControl);
            }
            let id = self.next_command()?;
            self.admit_chunk(
                id,
                chunk.control,
                chunk.payload.len(),
                false,
                chunk.payload,
                true,
            )
        } else if action.transmits() {
            let format = chunk.control.format()?;
            let compressed = chunk.control.compressed()?;
            if format != Format::Png
                && (chunk.control.get(Key::Width).unwrap_or(0) == 0
                    || chunk.control.get(Key::Height).unwrap_or(0) == 0)
            {
                return Err(Error::InvalidControl);
            }
            if format == Format::Png && compressed && chunk.control.get(Key::Size).unwrap_or(0) == 0
            {
                return Err(Error::InvalidControl);
            }
            let id = self.next_command()?;
            self.admit_chunk(
                id,
                chunk.control,
                chunk.payload.len(),
                more,
                chunk.payload,
                true,
            )
        } else {
            if more || !chunk.payload.is_empty() {
                return Err(Error::InvalidControl);
            }
            Ok(Step::Command {
                id: self.next_command()?,
                control: chunk.control,
            })
        }
    }

    fn admit_chunk<'a>(
        &mut self,
        id: CommandId,
        control: Control,
        total: usize,
        more: bool,
        encoded: &'a [u8],
        first: bool,
    ) -> Result<Step<'a>, Error> {
        if total > self.max_encoded_bytes {
            return Err(Error::UploadTooLarge);
        }
        if more && !encoded.len().is_multiple_of(4) {
            return Err(Error::InvalidChunkLength);
        }
        self.state = if more {
            State::Receiving {
                id,
                control,
                bytes: total,
            }
        } else {
            State::Validating(id)
        };
        Ok(Step::Data {
            id,
            control,
            first,
            last: !more,
            encoded,
        })
    }
}
