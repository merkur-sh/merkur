//! The native viewer uses the terminal's shared client adapter.
pub use term_wasm::client_grid::ClientGrid as NativeGrid;

#[cfg(test)]
mod tests;
