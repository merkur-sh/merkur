use ring::rand::{SecureRandom, SystemRandom};

fn map_request(nonce: &[u8; 12]) -> u8 {
    nonce[0]
}

fn constant() -> u8 {
    map_request(&[1u8; 12]) // $ Alert
}

fn copied(peer: &[u8]) -> u8 {
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(peer);
    map_request(&nonce)
}

fn filled() -> Result<u8, ring::error::Unspecified> {
    let mut nonce = [0u8; 12];
    SystemRandom::new().fill(&mut nonce)?;
    Ok(map_request(&nonce))
}

fn filled_through_a_chain() -> Option<u8> {
    let mut nonce = [0u8; 12];
    SecureRandom::fill(&SystemRandom::new(), &mut nonce).ok()?;
    Some(map_request(&nonce))
}

fn fill_error_discarded() -> u8 {
    let mut nonce = [0u8; 12]; // $ Alert
    let _ = SystemRandom::new().fill(&mut nonce);
    map_request(&nonce) // $ Sink
}

fn slice_fill_is_a_constant() -> u8 {
    let mut nonce = [0u8; 12]; // $ Alert
    nonce.fill(7);
    map_request(&nonce) // $ Sink
}

fn read_before_the_copy(peer: &[u8]) -> u8 {
    let mut nonce = [0u8; 12]; // $ Alert
    let early = map_request(&nonce); // $ Sink
    nonce.copy_from_slice(peer);
    early ^ map_request(&nonce) // $ Sink
}

fn partial_copy(peer: &[u8]) -> u8 {
    let mut nonce = [0u8; 12]; // $ Alert
    nonce[4..].copy_from_slice(peer);
    map_request(&nonce) // $ Sink
}

fn main() {
    let peer: Vec<u8> = std::env::args().flat_map(String::into_bytes).take(12).collect();
    let _ = (
        constant(),
        copied(&peer),
        filled(),
        filled_through_a_chain(),
        fill_error_discarded(),
        slice_fill_is_a_constant(),
        read_before_the_copy(&peer),
        partial_copy(&peer[4..]),
    );
}
