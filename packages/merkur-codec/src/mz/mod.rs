//! MZ, the display codec for row payloads: one rANS stream over the row
//! layout, every field coded in its own adaptive context, starting each frame
//! from a trained prior or from the session's own tables, with copies of items
//! the receiver already holds.
//!
//! The decoder writes row-layout bytes, so the one row validator reads an MZ
//! frame exactly as it reads a raw one.

mod frame;
mod history;
mod model;
mod model_data;
mod nibble;
mod session;
#[doc(hidden)]
pub mod train;

pub use frame::{
    MZ_TWO_STATE_MIN_ROW_BYTES, MzCandidate, MzDecoder, MzEncoded, MzEncoder, MzError,
    MzFrameMetadata, MzItem, MzMatches, MzRow, MzRowCost, MzSources, NoHistory,
    encode_full_row_entry, entry_items, full_row_entry_bytes, item_hash, pair_hash,
};
pub use history::{
    MZ_HISTORY_BYTES, MZ_REFERENCE_DATAGRAMS, MzGenerations, MzLedger, MzStore, RowHistory,
    previous_generation,
};
pub use session::{
    MZ_DECLARATION_REACH, MZ_EPOCH_DATAGRAMS, MzEpochDeclaration, MzEpochError, MzReceiver, MzSession,
    MzTracePool, SessionModel,
    next_epoch_id,
};

#[cfg(test)]
mod tests;
