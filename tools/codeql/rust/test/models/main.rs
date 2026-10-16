const MAX_FRAME_BYTES: usize = 64 * 1024;

fn declared_length(bytes: &[u8]) -> usize {
    usize::from(u16::from_be_bytes([bytes[0], bytes[1]]))
}

async fn udp(socket: &tokio::net::UdpSocket) {
    let mut packet = [0u8; 1500];
    let Ok(_) = socket.recv(&mut packet).await else { return }; // $ Source
    let length = declared_length(&packet);
    let _ = Vec::<u8>::with_capacity(length); // $ Alert
    let _ = vec![0u8; length.min(MAX_FRAME_BYTES)];
    if length > MAX_FRAME_BYTES {
        return;
    }
    let _ = Vec::<u8>::with_capacity(length);
}

async fn quinn_stream(stream: &mut quinn::RecvStream) {
    let mut header = [0u8; 2];
    let Ok(_) = stream.read(&mut header).await else { return }; // $ Source
    let mut body = Vec::new();
    body.resize(declared_length(&header), 0); // $ Alert
}

async fn quinn_datagram(connection: &quinn::Connection) {
    let Ok(datagram) = connection.read_datagram().await else { return }; // $ Source
    let _ = vec![0u8; declared_length(&datagram)]; // $ Alert
}

async fn webtransport_datagram(connection: &wtransport::Connection) {
    let Ok(datagram) = connection.receive_datagram().await else { return }; // $ Source
    let mut body = Vec::<u8>::new();
    body.reserve(declared_length(&datagram)); // $ Alert
}

fn main() {
    let _ = (udp, quinn_stream, quinn_datagram, webtransport_datagram);
}
