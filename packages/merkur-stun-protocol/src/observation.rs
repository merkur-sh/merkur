//! Responder receipts: the requester knows its message key, never this key.

use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use ring::hmac;

pub const RECEIPT_KEY_LABEL: &[u8] = b"merkur-stun-observation-key\0";
const RECEIPT_LABEL: &[u8] = b"merkur-stun-observation\0";
pub const ADDRESS_BYTES: usize = 19;
pub const RECEIPT_BYTES: usize = ADDRESS_BYTES + 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    /// The responder's bound socket identity, never a routing destination.
    /// Wildcard listeners and responders behind NAT may name a local address.
    pub observer: SocketAddr,
    pub tag: [u8; 32],
}

pub fn derive_key(deployment: &hmac::Key, ticket: &[u8]) -> hmac::Key {
    let mut mac = hmac::Context::with_key(deployment);
    mac.update(RECEIPT_KEY_LABEL);
    mac.update(ticket);
    hmac::Key::new(hmac::HMAC_SHA256, mac.sign().as_ref())
}

fn encode_address(address: SocketAddr) -> [u8; ADDRESS_BYTES] {
    let mut bytes = [0; ADDRESS_BYTES];
    let ip = address.ip().to_canonical();
    bytes[0] = if ip.is_ipv4() { 4 } else { 6 };
    let v6 = match ip {
        IpAddr::V4(ip) => ip.to_ipv6_mapped(),
        IpAddr::V6(ip) => ip,
    };
    bytes[1..17].copy_from_slice(&v6.octets());
    bytes[17..].copy_from_slice(&address.port().to_be_bytes());
    bytes
}

fn decode_identity(bytes: &[u8]) -> Option<SocketAddr> {
    let (&family, rest) = bytes.split_first()?;
    let (ip, port) = rest.split_first_chunk::<16>()?;
    let port = u16::from_be_bytes(port.try_into().ok()?);
    let ip = Ipv6Addr::from(*ip);
    let ip = match family {
        4 => IpAddr::V4(ip.to_ipv4_mapped()?),
        6 if ip.to_ipv4_mapped().is_none() => IpAddr::V6(ip),
        _ => return None,
    };
    (port != 0 && !ip.is_multicast()).then_some(SocketAddr::new(ip, port))
}

fn sign(
    key: &hmac::Key,
    ticket: &[u8],
    transaction: &[u8; 12],
    mapped: SocketAddr,
    observer: SocketAddr,
) -> hmac::Tag {
    let mut mac = hmac::Context::with_key(key);
    mac.update(RECEIPT_LABEL);
    mac.update(ticket);
    mac.update(transaction);
    mac.update(&encode_address(mapped));
    mac.update(&encode_address(observer));
    mac.sign()
}

impl Receipt {
    pub fn issue(
        key: &hmac::Key,
        ticket: &[u8],
        transaction: &[u8; 12],
        mapped: SocketAddr,
        observer: SocketAddr,
    ) -> Self {
        let mut tag = [0; 32];
        tag.copy_from_slice(sign(key, ticket, transaction, mapped, observer).as_ref());
        Self { observer, tag }
    }

    pub fn verifies(
        &self,
        key: &hmac::Key,
        ticket: &[u8],
        transaction: &[u8; 12],
        mapped: SocketAddr,
    ) -> bool {
        super::message::constant_time_eq(
            &self.tag,
            sign(key, ticket, transaction, mapped, self.observer).as_ref(),
        )
    }

    pub fn encode(&self) -> [u8; RECEIPT_BYTES] {
        let mut bytes = [0; RECEIPT_BYTES];
        bytes[..ADDRESS_BYTES].copy_from_slice(&encode_address(self.observer));
        bytes[ADDRESS_BYTES..].copy_from_slice(&self.tag);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let (address, tag) = bytes.split_first_chunk::<ADDRESS_BYTES>()?;
        Some(Self {
            observer: decode_identity(address)?,
            tag: tag.try_into().ok()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requester_message_keys_cannot_forge_observations() {
        let deployment = hmac::Key::new(hmac::HMAC_SHA256, &[3; 64]);
        let receipt_key = derive_key(&deployment, b"ticket");
        let requester = hmac::Key::new(hmac::HMAC_SHA256, b"requester");
        let mapped = "198.51.100.2:50000".parse().unwrap();
        let observer = "203.0.113.1:3478".parse().unwrap();
        let receipt = Receipt::issue(&receipt_key, b"ticket", &[7; 12], mapped, observer);
        assert!(receipt.verifies(&receipt_key, b"ticket", &[7; 12], mapped));
        assert_eq!(Receipt::decode(&receipt.encode()), Some(receipt));
        assert!(!receipt.verifies(&requester, b"ticket", &[7; 12], mapped));
        assert!(!receipt.verifies(&receipt_key, b"other", &[7; 12], mapped));
        assert!(!receipt.verifies(&receipt_key, b"ticket", &[8; 12], mapped));
        assert!(!receipt.verifies(
            &receipt_key,
            b"ticket",
            &[7; 12],
            "198.51.100.3:50000".parse().unwrap()
        ));
    }

    #[test]
    fn receipt_key_matches_the_typescript_issuer_vector() {
        // Public fixture, shared with stun-ticket-service.test.ts.
        let ticket = [
            1, 0, 0, 0, 0, 0, 15, 68, 152, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 149,
            198, 223, 79, 19, 240, 4, 243, 36, 80, 186, 7, 101, 230, 209, 113,
        ];
        let expected = [
            192, 38, 140, 10, 243, 181, 66, 179, 8, 119, 23, 181, 211, 242, 224, 34, 51, 114, 212,
            2, 175, 123, 130, 133, 196, 13, 79, 100, 95, 114, 159, 157,
        ];
        let derived = derive_key(&hmac::Key::new(hmac::HMAC_SHA256, &[3; 64]), &ticket);
        let expected = hmac::Key::new(hmac::HMAC_SHA256, &expected);
        assert_eq!(
            hmac::sign(&derived, b"conformance").as_ref(),
            hmac::sign(&expected, b"conformance").as_ref()
        );
    }
}
