//! MZ, the display codec for row payloads: one rANS stream over the row
//! layout, every field coded in its own context against a static model trained
//! on real sessions, and references to rows the receiver already applied.
//!
//! The decoder writes row-layout bytes, so the one row validator reads an MZ
//! frame exactly as it reads a raw one.

mod frame;
mod history;
mod model;
mod model_data;
mod rans;
#[doc(hidden)]
pub mod train;

pub use frame::{
    MZ_TWO_STATE_MIN_ROW_BYTES, MzEncoder, MzError, MzReference, MzResolve, decode_mz_rows,
    encode_full_row_entry, full_row_entry_bytes, mz_entry_rows, reference_hash,
};
pub use history::{MZ_HISTORY_DATAGRAMS, MZ_REFERENCE_DATAGRAMS, RowHistory};

#[cfg(test)]
mod tests;
