//! The Merkur client core.
//!
//! Everything a client does between its transport and its terminal, written
//! once: session issuance, the three-flight hybrid authentication, the edge
//! attachments and their lanes, input, heartbeat, recovery, and display
//! receipt. It is sans-IO: it owns no socket, no clock and no randomness. A
//! driver feeds it events with the current time and an [`Entropy`] source and
//! performs the actions it returns. The native client's driver is
//! `merkur-client-native`.

pub mod auth;
pub mod input_admission;
pub mod input_delivery;
pub mod input_sequence;
pub mod issuance;
pub mod liveness;
pub mod rebind;
pub mod renewal;
pub mod session;
#[cfg(test)]
mod test_support;
pub mod viewer;

/// Fresh randomness from the driver's operating-system source.
pub trait Entropy {
    fn fill(&mut self, bytes: &mut [u8]);

    fn array<const N: usize>(&mut self) -> [u8; N]
    where
        Self: Sized,
    {
        let mut bytes = [0u8; N];
        self.fill(&mut bytes);
        bytes
    }
}

/// An RFC 4122 version-4 id from the driver's entropy.
pub fn uuid_v4(entropy: &mut impl Entropy) -> String {
    let mut bytes: [u8; 16] = entropy.array();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
