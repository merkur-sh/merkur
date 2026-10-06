use std::io;

pub(super) trait TpmTransport: Send {
    /// One complete TPM command/response. A command is never resent after an
    /// ambiguous I/O failure; only a TPM response can authorize a retry.
    fn submit(&mut self, command: &[u8], response: &mut [u8; 4096]) -> io::Result<usize>;
}
