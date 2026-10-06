use super::transport::TpmTransport;
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
};
pub(super) struct LinuxTransport(File);
impl LinuxTransport {
    pub fn open() -> io::Result<Self> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tpmrm0")
            .map(Self)
    }
}
impl TpmTransport for LinuxTransport {
    fn submit(&mut self, command: &[u8], response: &mut [u8; 4096]) -> io::Result<usize> {
        // The device takes a whole command per write. write_all could turn a
        // short write into a second, malformed TPM command.
        let written = self.0.write(command)?;
        if written != command.len() {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "short TPM command",
            ));
        }
        loop {
            match self.0.read(response) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => return result,
            }
        }
    }
}
