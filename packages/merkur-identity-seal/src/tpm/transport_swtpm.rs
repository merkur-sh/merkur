use super::transport::TpmTransport;
use std::{
    io::{self, Read, Write},
    net::TcpStream,
    time::Duration,
};
pub(super) struct SimulatorTransport(TcpStream);
impl SimulatorTransport {
    pub fn open(address: &str) -> io::Result<Self> {
        let socket = TcpStream::connect(address)?;
        socket.set_read_timeout(Some(Duration::from_secs(5)))?;
        socket.set_write_timeout(Some(Duration::from_secs(5)))?;
        socket.set_nodelay(true)?;
        Ok(Self(socket))
    }
}
impl TpmTransport for SimulatorTransport {
    fn submit(&mut self, command: &[u8], response: &mut [u8; 4096]) -> io::Result<usize> {
        self.0.write_all(command)?;
        self.0.read_exact(&mut response[..10])?;
        let length = u32::from_be_bytes(response[2..6].try_into().expect("fixed header")) as usize;
        if !(10..=response.len()).contains(&length) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid TPM response length",
            ));
        }
        self.0.read_exact(&mut response[10..length])?;
        Ok(length)
    }
}
