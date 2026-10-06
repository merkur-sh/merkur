//! STUN wire format (RFC 8489, plus the RFC 5780 attributes we use).
//!
//! Parsing borrows from the caller's receive buffer and encoding writes into a
//! caller-owned array, so a served request allocates nothing. Everything here
//! reads attacker-controlled bytes, so every length is checked against the
//! remaining slice before it is used and no arithmetic on a wire length is
//! allowed to wrap.
//!
//! Only SHA-256 message integrity is implemented. RFC 8489's `MESSAGE-INTEGRITY`
//! (HMAC-SHA1) is not accepted at all: both ends of this protocol ship from this
//! repo, so there is no peer that needs it, and offering two integrity
//! algorithms would mean the weaker one decides security.

use ring::hmac;

/// Compare two byte strings without an early exit.
///
/// `ring`'s equivalent is deprecated and explicitly disclaims side-channel
/// guarantees for external callers, so the comparison lives here instead. The
/// accumulator passes through `black_box` so the optimiser cannot turn the fold
/// into a short-circuiting memcmp — every byte is read regardless of where the
/// first difference is.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    core::hint::black_box(difference) == 0
}

/// RFC 8489 section 5. Distinguishes STUN from other traffic on a shared port
/// and seeds the XOR-MAPPED-ADDRESS obfuscation.
pub const MAGIC_COOKIE: u32 = 0x2112_A442;

pub const HEADER_LEN: usize = 20;
/// Transaction ids are 96 bits.
pub const TRANSACTION_ID_LEN: usize = 12;

pub const METHOD_BINDING: u16 = 0x0001;
pub const CLASS_REQUEST: u16 = 0x0000;
pub const CLASS_SUCCESS: u16 = 0x0100;

pub const ATTR_CHANGE_REQUEST: u16 = 0x0003;
pub const ATTR_USERNAME: u16 = 0x0006;
pub const ATTR_MESSAGE_INTEGRITY_SHA256: u16 = 0x001C;
pub const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
pub const ATTR_OTHER_ADDRESS: u16 = 0x802C;

/// Largest datagram we will look at.
///
/// A legitimate request is ~120 bytes. This bound exists so a single oversized
/// datagram cannot make the responder walk a long attribute list, and it is far
/// below any path MTU we care about.
pub const MAX_MESSAGE_LEN: usize = 1200;

/// Full HMAC-SHA256 output. RFC 8489 permits truncation; we never truncate,
/// because a shorter tag buys nothing here — the response is already smaller
/// than the request either way.
pub const MESSAGE_INTEGRITY_SHA256_LEN: usize = 32;

/// A parsed request, borrowing the receive buffer.
pub struct BindingRequest<'a> {
    pub transaction_id: &'a [u8; TRANSACTION_ID_LEN],
    pub username: &'a [u8],
    /// Offset of the MESSAGE-INTEGRITY-SHA256 attribute's value.
    integrity_value: &'a [u8],
    /// Bytes covered by the integrity HMAC: everything before the attribute's
    /// own header, with the message length rewritten. Held as an offset because
    /// the rewrite happens against a copy of the header.
    integrity_prefix_len: usize,
    /// RFC 5780 CHANGE-REQUEST flags, if the attribute was present.
    ///
    /// Read by `serve`, which answers only when the requested different port
    /// and/or address exists among its bound sibling sockets. It is parsed before
    /// MESSAGE-INTEGRITY-SHA256 rather than skipped as unknown precisely so the
    /// integrity tag covers it: a responder steered by an attribute appended
    /// after the tag would be steerable by anyone who could intercept one valid
    /// message.
    pub change_request: Option<ChangeRequest>,
}

/// RFC 5780 section 7.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChangeRequest {
    pub change_ip: bool,
    pub change_port: bool,
}

/// Why a datagram was not served. Every variant is dropped silently — see
/// `main.rs` — so this exists for counters and logs, never for a response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseError {
    TooShort,
    TooLong,
    NotStun,
    BadCookie,
    NotBindingRequest,
    Malformed,
    /// Length field disagrees with the datagram we actually received.
    LengthMismatch,
    MissingUsername,
    MissingIntegrity,
    /// Attributes appeared after MESSAGE-INTEGRITY-SHA256. RFC 8489 requires
    /// the integrity attribute to cover everything before it; anything after it
    /// is unauthenticated and must not be honoured.
    AttributeAfterIntegrity,
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let word = bytes.get(offset..)?.first_chunk::<2>()?;
    Some(u16::from_be_bytes(*word))
}

/// Round an attribute value length up to the 4-byte boundary RFC 8489 requires.
fn padded_len(len: usize) -> Option<usize> {
    len.checked_add(3).map(|value| value & !3)
}

/// Parse a Binding request, rejecting anything that is not exactly that.
///
/// This runs before any cryptography, on unauthenticated bytes, so it is
/// deliberately strict: unknown comprehension-required attributes, trailing
/// data, and attributes after the integrity attribute are all refusals rather
/// than things to skip.
pub fn parse_binding_request(datagram: &[u8]) -> Result<BindingRequest<'_>, ParseError> {
    if datagram.len() > MAX_MESSAGE_LEN {
        return Err(ParseError::TooLong);
    }
    let Some(header) = datagram.first_chunk::<HEADER_LEN>() else {
        return Err(ParseError::TooShort);
    };
    // The two most significant bits of a STUN message are zero. This is the
    // cheapest possible rejection for traffic that is not STUN at all.
    if header[0] & 0xC0 != 0 {
        return Err(ParseError::NotStun);
    }

    let message_type = u16::from_be_bytes([header[0], header[1]]);
    let method = message_type & 0x3EEF;
    let class = message_type & 0x0110;
    if method != METHOD_BINDING || class != CLASS_REQUEST {
        return Err(ParseError::NotBindingRequest);
    }

    let length = usize::from(u16::from_be_bytes([header[2], header[3]]));
    if length % 4 != 0 {
        return Err(ParseError::Malformed);
    }
    let cookie = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    if cookie != MAGIC_COOKIE {
        return Err(ParseError::BadCookie);
    }
    // Exact, not `>=`: trailing bytes after a well-formed message are either a
    // different protocol or an attempt to smuggle data past the integrity check.
    if HEADER_LEN.checked_add(length) != Some(datagram.len()) {
        return Err(ParseError::LengthMismatch);
    }

    let Some((_, transaction_id)) = header.split_last_chunk::<TRANSACTION_ID_LEN>() else {
        return Err(ParseError::TooShort);
    };

    let mut username: Option<&[u8]> = None;
    let mut integrity: Option<(&[u8], usize)> = None;
    let mut change_request: Option<ChangeRequest> = None;

    let mut cursor = HEADER_LEN;
    while cursor < datagram.len() {
        if integrity.is_some() {
            return Err(ParseError::AttributeAfterIntegrity);
        }
        let attr_type = read_u16(datagram, cursor).ok_or(ParseError::Malformed)?;
        let attr_len = usize::from(read_u16(datagram, cursor + 2).ok_or(ParseError::Malformed)?);
        let value_start = cursor.checked_add(4).ok_or(ParseError::Malformed)?;
        let value_end = value_start
            .checked_add(attr_len)
            .ok_or(ParseError::Malformed)?;
        let value = datagram
            .get(value_start..value_end)
            .ok_or(ParseError::Malformed)?;

        match attr_type {
            ATTR_USERNAME => {
                if username.is_some() {
                    return Err(ParseError::Malformed);
                }
                username = Some(value);
            }
            ATTR_MESSAGE_INTEGRITY_SHA256 => {
                if value.len() != MESSAGE_INTEGRITY_SHA256_LEN {
                    return Err(ParseError::Malformed);
                }
                integrity = Some((value, cursor));
            }
            ATTR_CHANGE_REQUEST => {
                let &[0, 0, 0, flags] = value else {
                    return Err(ParseError::Malformed);
                };
                if change_request.is_some() || flags & !6 != 0 {
                    return Err(ParseError::Malformed);
                }
                change_request = Some(ChangeRequest {
                    change_ip: flags & 0x04 != 0,
                    change_port: flags & 0x02 != 0,
                });
            }
            other => {
                // RFC 8489 section 14: 0x0000-0x7FFF is comprehension-required.
                // We answer exactly one protocol and have no reason to tolerate
                // an attribute we do not understand in it.
                if other < 0x8000 {
                    return Err(ParseError::Malformed);
                }
            }
        }

        let advance = padded_len(attr_len).ok_or(ParseError::Malformed)?;
        cursor = value_start
            .checked_add(advance)
            .ok_or(ParseError::Malformed)?;
        if cursor > datagram.len() {
            return Err(ParseError::Malformed);
        }
    }

    let username = username.ok_or(ParseError::MissingUsername)?;
    let (integrity_value, integrity_offset) = integrity.ok_or(ParseError::MissingIntegrity)?;

    Ok(BindingRequest {
        transaction_id,
        username,
        integrity_value,
        integrity_prefix_len: integrity_offset,
        change_request,
    })
}

impl BindingRequest<'_> {
    /// Verify MESSAGE-INTEGRITY-SHA256 against `key`, in constant time.
    ///
    /// RFC 8489 section 14.6: the HMAC covers the message up to but not
    /// including this attribute, with the header's length field rewritten to
    /// the value it would have if this attribute were the last one. The rewrite
    /// is why the header is copied rather than hashed in place — the datagram
    /// is the caller's receive buffer and must not be mutated.
    pub fn verify_integrity(&self, datagram: &[u8], key: &hmac::Key) -> bool {
        let Some(prefix) = datagram.get(..self.integrity_prefix_len) else {
            return false;
        };
        let Some((header, attributes)) = prefix.split_first_chunk::<HEADER_LEN>() else {
            return false;
        };
        let covered = self.integrity_prefix_len + 4 + MESSAGE_INTEGRITY_SHA256_LEN - HEADER_LEN;
        let Ok(covered) = u16::try_from(covered) else {
            return false;
        };

        let mut context = hmac::Context::with_key(key);
        let mut header = *header;
        header[2..4].copy_from_slice(&covered.to_be_bytes());
        context.update(&header);
        context.update(attributes);
        let expected = context.sign();

        constant_time_eq(expected.as_ref(), self.integrity_value)
    }
}

/// Buffer for an encoded response. Sized for the largest message we build:
/// header + XOR-MAPPED-ADDRESS(v6) + OTHER-ADDRESS(v6) +
/// MESSAGE-INTEGRITY-SHA256, with room to spare.
pub const MAX_RESPONSE_LEN: usize = 320;

/// Incremental writer for a Binding success response.
pub struct ResponseWriter {
    buffer: [u8; MAX_RESPONSE_LEN],
    len: usize,
}

impl ResponseWriter {
    pub fn new(transaction_id: &[u8; TRANSACTION_ID_LEN]) -> Self {
        let mut buffer = [0u8; MAX_RESPONSE_LEN];
        buffer[0..2].copy_from_slice(&(METHOD_BINDING | CLASS_SUCCESS).to_be_bytes());
        // Length is patched in `finish`.
        buffer[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
        buffer[8..HEADER_LEN].copy_from_slice(transaction_id);
        Self {
            buffer,
            len: HEADER_LEN,
        }
    }

    pub fn binding_request(transaction_id: &[u8; TRANSACTION_ID_LEN]) -> Self {
        let mut writer = Self::new(transaction_id);
        writer.buffer[..2].copy_from_slice(&METHOD_BINDING.to_be_bytes());
        writer
    }

    pub fn push_attribute(&mut self, attr_type: u16, value: &[u8]) -> bool {
        let Some(padded) = padded_len(value.len()) else {
            return false;
        };
        let Some(end) = self.len.checked_add(4).and_then(|v| v.checked_add(padded)) else {
            return false;
        };
        let Ok(value_len) = u16::try_from(value.len()) else {
            return false;
        };
        // `None` is an attribute that would end past `MAX_RESPONSE_LEN`.
        let Some(attribute) = self.buffer.get_mut(self.len..end) else {
            return false;
        };
        let Some((header, body)) = attribute.split_first_chunk_mut::<4>() else {
            return false;
        };
        let Some(body) = body.get_mut(..value.len()) else {
            return false;
        };
        let [type_high, type_low] = attr_type.to_be_bytes();
        let [len_high, len_low] = value_len.to_be_bytes();
        *header = [type_high, type_low, len_high, len_low];
        body.copy_from_slice(value);
        // Padding bytes stay zero; the array was zeroed and never reused across
        // responses.
        self.len = end;
        true
    }

    /// Encode an address attribute, XOR-obfuscated per RFC 8489 section 14.2
    /// when `xor` is set. `RESPONSE-ORIGIN` and `OTHER-ADDRESS` are plain.
    pub fn push_address(
        &mut self,
        attr_type: u16,
        address: std::net::SocketAddr,
        transaction_id: &[u8; TRANSACTION_ID_LEN],
        xor: bool,
    ) -> bool {
        let mut value = [0u8; 20];
        let port = address.port() ^ if xor { (MAGIC_COOKIE >> 16) as u16 } else { 0 };
        value[1] = match address {
            std::net::SocketAddr::V4(_) => 0x01,
            std::net::SocketAddr::V6(_) => 0x02,
        };
        value[2..4].copy_from_slice(&port.to_be_bytes());

        match address {
            std::net::SocketAddr::V4(v4) => {
                let mut octets = v4.ip().octets();
                if xor {
                    let cookie = MAGIC_COOKIE.to_be_bytes();
                    for (byte, mask) in octets.iter_mut().zip(cookie) {
                        *byte ^= mask;
                    }
                }
                value[4..8].copy_from_slice(&octets);
                self.push_attribute(attr_type, &value[..8])
            }
            std::net::SocketAddr::V6(v6) => {
                let mut octets = v6.ip().octets();
                if xor {
                    let mut mask = [0u8; 16];
                    mask[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
                    mask[4..].copy_from_slice(transaction_id);
                    for (byte, mask_byte) in octets.iter_mut().zip(mask) {
                        *byte ^= mask_byte;
                    }
                }
                value[4..20].copy_from_slice(&octets);
                self.push_attribute(attr_type, &value[..20])
            }
        }
    }

    /// Borrow the encoded bytes. Valid after `finish_in_place`.
    pub fn as_bytes(&self) -> &[u8] {
        // `len` starts at `HEADER_LEN` and only `push_attribute` moves it, to
        // an end it has just written inside the buffer.
        self.buffer.get(..self.len).unwrap_or(&[])
    }

    /// Append MESSAGE-INTEGRITY-SHA256 in place, leaving the message readable
    /// through `as_bytes`.
    pub fn finish_in_place(&mut self, key: &hmac::Key) -> bool {
        let Ok(covered) = u16::try_from(self.len + 4 + MESSAGE_INTEGRITY_SHA256_LEN - HEADER_LEN)
        else {
            return false;
        };
        self.buffer[2..4].copy_from_slice(&covered.to_be_bytes());
        let tag = hmac::sign(key, self.as_bytes());
        self.push_attribute(ATTR_MESSAGE_INTEGRITY_SHA256, tag.as_ref())
    }
}

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub fn verify_integrity(packet: &[u8], key: &hmac::Key) -> bool {
    if packet.len() < 56 || packet.len() > MAX_MESSAGE_LEN || !packet.len().is_multiple_of(4) {
        return false;
    }
    let Some(header) = packet.first_chunk::<HEADER_LEN>() else {
        return false;
    };
    if usize::from(u16::from_be_bytes([header[2], header[3]])) + HEADER_LEN != packet.len() {
        return false;
    }
    let mut offset = HEADER_LEN;
    // Each turn reads one attribute header at `offset`; the walk ends where
    // fewer than four bytes remain.
    while let Some((covered, attribute)) = packet.split_at_checked(offset) {
        let Some((&[kind_high, kind_low, len_high, len_low], body)) =
            attribute.split_first_chunk::<4>()
        else {
            break;
        };
        let kind = u16::from_be_bytes([kind_high, kind_low]);
        let len = usize::from(u16::from_be_bytes([len_high, len_low]));
        let Some(value) = body.get(..len) else {
            return false;
        };
        if kind == 0x001c {
            return len == 32 && body.len() == len && hmac::verify(key, covered, value).is_ok();
        }
        offset += 4 + ((len + 3) & !3);
    }
    false
}

pub struct Success {
    pub mapped: Option<SocketAddr>,
    pub other: Option<SocketAddr>,
}

/// The daemon's authenticated Binding request: the ticket as USERNAME, RFC 5780
/// CHANGE-REQUEST flags when `change` is nonzero, and MESSAGE-INTEGRITY-SHA256
/// under the ticket's integrity key.
pub fn binding_request(
    transaction: &[u8; TRANSACTION_ID_LEN],
    ticket: &[u8],
    change: u8,
    key: &hmac::Key,
) -> Option<ResponseWriter> {
    let mut writer = ResponseWriter::binding_request(transaction);
    if !writer.push_attribute(ATTR_USERNAME, ticket) {
        return None;
    }
    if change != 0 && !writer.push_attribute(ATTR_CHANGE_REQUEST, &[0, 0, 0, change]) {
        return None;
    }
    writer.finish_in_place(key).then_some(writer)
}

/// Parse the strict success shape; callers must first authenticate it with `verify_integrity`.
pub fn parse_success(data: &[u8], expected_txn_id: &[u8; 12]) -> Option<Success> {
    let header = data.first_chunk::<HEADER_LEN>()?;
    if header[0..2] != [1, 1]
        || usize::from(u16::from_be_bytes([header[2], header[3]])) + HEADER_LEN != data.len()
        || !data.len().is_multiple_of(4)
        || header[4..8] != MAGIC_COOKIE.to_be_bytes()
        || header[8..20] != *expected_txn_id
    {
        return None;
    }
    let mut pos = HEADER_LEN;
    let mut mapped = None;
    let mut other = None;
    let mut integrity = false;
    // Each turn reads one attribute header at `pos`; the walk ends where fewer
    // than four bytes remain.
    while let Some((&[kind_high, kind_low, len_high, len_low], body)) = data
        .get(pos..)
        .and_then(|rest| rest.split_first_chunk::<4>())
    {
        let kind = u16::from_be_bytes([kind_high, kind_low]);
        let len = usize::from(u16::from_be_bytes([len_high, len_low]));
        let value = body.get(..len)?;
        if kind == 0x0020 || kind == ATTR_OTHER_ADDRESS {
            let xor = kind == 0x0020;
            let (&[0, family, port_high, port_low], address) = value.split_first_chunk::<4>()?
            else {
                return None;
            };
            if (xor && mapped.is_some()) || (!xor && other.is_some()) {
                return None;
            }
            let port = u16::from_be_bytes([port_high, port_low]) ^ if xor { 0x2112 } else { 0 };
            let ip = match (family, address) {
                (1, &[a, b, c, d]) => IpAddr::V4(Ipv4Addr::from(
                    u32::from_be_bytes([a, b, c, d]) ^ if xor { MAGIC_COOKIE } else { 0 },
                )),
                (2, address) => {
                    let mut bytes: [u8; 16] = address.try_into().ok()?;
                    if xor {
                        // The mask is the cookie and the transaction id: the
                        // header's last sixteen bytes.
                        for (byte, mask) in bytes.iter_mut().zip(&header[4..]) {
                            *byte ^= mask;
                        }
                    }
                    IpAddr::V6(Ipv6Addr::from(bytes))
                }
                _ => return None,
            };
            if port == 0 || ip.is_unspecified() || ip.is_multicast() {
                return None;
            }
            if xor {
                mapped = Some(SocketAddr::new(ip, port));
            } else {
                other = Some(SocketAddr::new(ip, port));
            }
        } else if kind == ATTR_MESSAGE_INTEGRITY_SHA256 {
            integrity = true;
            if len != 32 || pos + 4 + len != data.len() {
                return None;
            }
        } else if kind < 0x8000 {
            return None;
        }
        pos += 4 + ((len + 3) & !3);
    }
    if pos != data.len() || !integrity {
        return None;
    }
    Some(Success { mapped, other })
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};

    use super::*;

    fn test_key() -> hmac::Key {
        hmac::Key::new(hmac::HMAC_SHA256, &[7u8; 32])
    }

    /// Build a well-formed authenticated Binding request the way the daemon
    /// client does, so the parser is exercised against real output rather than
    /// against bytes written to satisfy it.
    fn build_request(username: &[u8], key: &hmac::Key, change: Option<ChangeRequest>) -> Vec<u8> {
        let mut message = Vec::new();
        message.extend_from_slice(&(METHOD_BINDING | CLASS_REQUEST).to_be_bytes());
        message.extend_from_slice(&0u16.to_be_bytes());
        message.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        message.extend_from_slice(&[9u8; TRANSACTION_ID_LEN]);

        message.extend_from_slice(&ATTR_USERNAME.to_be_bytes());
        message.extend_from_slice(&(username.len() as u16).to_be_bytes());
        message.extend_from_slice(username);
        while message.len() % 4 != 0 {
            message.push(0);
        }

        if let Some(change) = change {
            message.extend_from_slice(&ATTR_CHANGE_REQUEST.to_be_bytes());
            message.extend_from_slice(&4u16.to_be_bytes());
            let mut flags = 0u8;
            if change.change_ip {
                flags |= 0x04;
            }
            if change.change_port {
                flags |= 0x02;
            }
            message.extend_from_slice(&[0, 0, 0, flags]);
        }

        let covered = message.len() + 4 + MESSAGE_INTEGRITY_SHA256_LEN - HEADER_LEN;
        let length_at_hash = (covered as u16).to_be_bytes();
        let mut hashed = message.clone();
        hashed[2..4].copy_from_slice(&length_at_hash);
        let tag = hmac::sign(key, &hashed);

        message[2..4].copy_from_slice(&length_at_hash);
        message.extend_from_slice(&ATTR_MESSAGE_INTEGRITY_SHA256.to_be_bytes());
        message.extend_from_slice(&(MESSAGE_INTEGRITY_SHA256_LEN as u16).to_be_bytes());
        message.extend_from_slice(tag.as_ref());
        message
    }

    #[test]
    fn a_well_formed_authenticated_request_parses_and_verifies() {
        let key = test_key();
        let datagram = build_request(b"ticket", &key, None);
        let request = parse_binding_request(&datagram).expect("parse");
        assert_eq!(request.username, b"ticket");
        assert!(request.verify_integrity(&datagram, &key));
        assert_eq!(request.change_request, None);
    }

    #[test]
    fn a_change_request_attribute_round_trips() {
        let key = test_key();
        let change = ChangeRequest {
            change_ip: true,
            change_port: false,
        };
        let datagram = build_request(b"ticket", &key, Some(change));
        let request = parse_binding_request(&datagram).expect("parse");
        assert_eq!(request.change_request, Some(change));
        assert!(request.verify_integrity(&datagram, &key));
    }

    /// The whole point of the integrity check: one flipped byte anywhere in the
    /// covered region must fail, including inside an attribute the responder
    /// acts on.
    #[test]
    fn any_mutation_inside_the_covered_region_fails_verification() {
        let key = test_key();
        let original = build_request(b"ticket", &key, None);
        for index in 0..original.len() - MESSAGE_INTEGRITY_SHA256_LEN {
            let mut mutated = original.clone();
            mutated[index] ^= 0x01;
            let verified = parse_binding_request(&mutated)
                .map(|request| request.verify_integrity(&mutated, &key))
                .unwrap_or(false);
            assert!(!verified, "byte {index} was mutated but still verified");
        }
    }

    #[test]
    fn a_wrong_key_never_verifies() {
        let key = test_key();
        let datagram = build_request(b"ticket", &key, None);
        let request = parse_binding_request(&datagram).expect("parse");
        let other = hmac::Key::new(hmac::HMAC_SHA256, &[8u8; 32]);
        assert!(!request.verify_integrity(&datagram, &other));
    }

    /// Attributes after MESSAGE-INTEGRITY-SHA256 are outside the HMAC, so an
    /// attacker could append a CHANGE-REQUEST to an intercepted valid message
    /// and steer the responder. Refuse the whole datagram.
    #[test]
    fn an_attribute_appended_after_integrity_is_refused() {
        let key = test_key();
        let mut datagram = build_request(b"ticket", &key, None);
        datagram.extend_from_slice(&ATTR_CHANGE_REQUEST.to_be_bytes());
        datagram.extend_from_slice(&4u16.to_be_bytes());
        datagram.extend_from_slice(&[0, 0, 0, 0x04]);
        let length = (datagram.len() - HEADER_LEN) as u16;
        datagram[2..4].copy_from_slice(&length.to_be_bytes());

        assert_eq!(
            parse_binding_request(&datagram).err(),
            Some(ParseError::AttributeAfterIntegrity)
        );
    }

    #[test]
    fn trailing_bytes_are_refused_rather_than_ignored() {
        let key = test_key();
        let mut datagram = build_request(b"ticket", &key, None);
        datagram.push(0);
        assert_eq!(
            parse_binding_request(&datagram).err(),
            Some(ParseError::LengthMismatch)
        );
    }

    #[test]
    fn non_stun_traffic_is_rejected_before_any_work() {
        assert_eq!(parse_binding_request(&[]).err(), Some(ParseError::TooShort));
        assert_eq!(
            parse_binding_request(&[0xFF; 64]).err(),
            Some(ParseError::NotStun),
            "the two high bits are the cheapest possible discriminator"
        );
        let mut wrong_cookie = build_request(b"t", &test_key(), None);
        wrong_cookie[4] ^= 0xFF;
        assert_eq!(
            parse_binding_request(&wrong_cookie).err(),
            Some(ParseError::BadCookie)
        );
    }

    #[test]
    fn an_oversized_datagram_is_dropped_without_walking_it() {
        assert_eq!(
            parse_binding_request(&vec![0u8; MAX_MESSAGE_LEN + 1]).err(),
            Some(ParseError::TooLong)
        );
    }

    #[test]
    fn an_unknown_comprehension_required_attribute_is_refused() {
        let key = test_key();
        let mut message = Vec::new();
        message.extend_from_slice(&(METHOD_BINDING | CLASS_REQUEST).to_be_bytes());
        message.extend_from_slice(&0u16.to_be_bytes());
        message.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        message.extend_from_slice(&[9u8; TRANSACTION_ID_LEN]);
        // 0x0009 is comprehension-required and unknown to us.
        message.extend_from_slice(&0x0009u16.to_be_bytes());
        message.extend_from_slice(&4u16.to_be_bytes());
        message.extend_from_slice(&[0; 4]);
        let length = (message.len() - HEADER_LEN) as u16;
        message[2..4].copy_from_slice(&length.to_be_bytes());
        let _ = key;

        assert_eq!(
            parse_binding_request(&message).err(),
            Some(ParseError::Malformed),
            "an attribute we cannot interpret must not be silently skipped"
        );
    }

    #[test]
    fn a_request_without_credentials_is_refused() {
        let mut message = Vec::new();
        message.extend_from_slice(&(METHOD_BINDING | CLASS_REQUEST).to_be_bytes());
        message.extend_from_slice(&0u16.to_be_bytes());
        message.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        message.extend_from_slice(&[9u8; TRANSACTION_ID_LEN]);
        assert_eq!(
            parse_binding_request(&message).err(),
            Some(ParseError::MissingUsername),
            "an unauthenticated Binding request is exactly what a reflector would send"
        );
    }

    /// A truncated attribute header or value must not index past the buffer.
    #[test]
    fn truncated_attributes_are_refused_without_panicking() {
        let key = test_key();
        let full = build_request(b"ticket", &key, None);
        for cut in HEADER_LEN..full.len() {
            let mut truncated = full[..cut].to_vec();
            if truncated.len() >= 4 {
                let length = (truncated.len() - HEADER_LEN) as u16;
                truncated[2..4].copy_from_slice(&length.to_be_bytes());
            }
            // Only the absence of a panic is asserted; any error is acceptable.
            let _ = parse_binding_request(&truncated);
        }
    }

    #[test]
    fn xor_mapped_address_matches_the_rfc_8489_worked_example() {
        // RFC 8489 appendix B.1: 192.0.2.1:32853 with the sample transaction id
        // encodes as X-Port 0xA147 and X-Address 0xE112A443.
        let transaction_id: [u8; TRANSACTION_ID_LEN] = [
            0xB7, 0xE7, 0xA7, 0x01, 0xBC, 0x34, 0xD6, 0x86, 0xFA, 0x87, 0xDF, 0xAE,
        ];
        let mut writer = ResponseWriter::new(&transaction_id);
        let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 1), 32853));
        assert!(writer.push_address(ATTR_XOR_MAPPED_ADDRESS, address, &transaction_id, true));

        let bytes = writer.as_bytes();
        let value = &bytes[HEADER_LEN + 4..HEADER_LEN + 12];
        assert_eq!(value[1], 0x01, "IPv4 family");
        assert_eq!(&value[2..4], &[0xA1, 0x47]);
        assert_eq!(&value[4..8], &[0xE1, 0x12, 0xA6, 0x43]);
    }

    #[test]
    fn an_ipv6_reflexive_address_xors_over_the_full_transaction_id() {
        let transaction_id = [0x11u8; TRANSACTION_ID_LEN];
        let mut writer = ResponseWriter::new(&transaction_id);
        let address = SocketAddr::V6(SocketAddrV6::new(
            "2a01:4f8:c015:b50::1".parse::<Ipv6Addr>().unwrap(),
            44_433,
            0,
            0,
        ));
        assert!(writer.push_address(ATTR_XOR_MAPPED_ADDRESS, address, &transaction_id, true));
        let bytes = writer.as_bytes();
        let value = &bytes[HEADER_LEN + 4..HEADER_LEN + 24];
        assert_eq!(value[1], 0x02, "IPv6 family");

        // Undo the XOR and confirm the original address comes back.
        let mut mask = [0u8; 16];
        mask[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
        mask[4..].copy_from_slice(&transaction_id);
        let mut recovered = [0u8; 16];
        recovered.copy_from_slice(&value[4..20]);
        for (byte, mask_byte) in recovered.iter_mut().zip(mask) {
            *byte ^= mask_byte;
        }
        assert_eq!(
            Ipv6Addr::from(recovered),
            "2a01:4f8:c015:b50::1".parse::<Ipv6Addr>().unwrap()
        );
    }

    /// The response must never be larger than the request that triggered it,
    /// or this service becomes a UDP amplifier for a spoofed source address.
    ///
    /// The comparison is against the smallest request that can be *answered*,
    /// not the smallest that can be sent: the username is the ticket, so a
    /// shorter one cannot authenticate and gets no response at all. A ticket is
    /// 41 bytes, 55 characters base64url.
    ///
    /// This is why RESPONSE-ORIGIN is not emitted. It would add 24 bytes for an
    /// IPv6 vantage point and push the worst case past the request — and the
    /// client already learns the responding address from `recv_from`, so it
    /// carried no information the client did not have.
    #[test]
    fn a_response_is_never_larger_than_its_request() {
        let key = test_key();
        let ticket_username = [b'A'; 55];
        let datagram = build_request(&ticket_username, &key, None);
        let transaction_id = [9u8; TRANSACTION_ID_LEN];

        // Worst case: both addresses IPv6, which is the widest encoding.
        let mut writer = ResponseWriter::new(&transaction_id);
        let v6 = SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, 44_433, 0, 0));
        assert!(writer.push_address(ATTR_XOR_MAPPED_ADDRESS, v6, &transaction_id, true));
        assert!(writer.push_address(ATTR_OTHER_ADDRESS, v6, &transaction_id, false));
        assert!(writer.finish_in_place(&key));

        assert!(
            writer.as_bytes().len() <= datagram.len(),
            "response {} bytes vs request {} bytes: amplification factor > 1",
            writer.as_bytes().len(),
            datagram.len()
        );
    }
    #[test]
    fn the_daemon_request_is_authenticated_end_to_end() {
        let key = test_key();
        let valid = binding_request(&[3; 12], b"ticket", 0x06, &key).unwrap();
        let parsed = parse_binding_request(valid.as_bytes()).unwrap();
        assert_eq!(parsed.username, b"ticket");
        assert_eq!(
            parsed.change_request,
            Some(ChangeRequest {
                change_ip: true,
                change_port: true
            })
        );
        assert!(parsed.verify_integrity(valid.as_bytes(), &key));
        for i in 0..valid.as_bytes().len() {
            let mut mutated = valid.as_bytes().to_vec();
            mutated[i] ^= 1;
            assert!(
                !parse_binding_request(&mutated)
                    .is_ok_and(|request| request.verify_integrity(&mutated, &key)),
                "mutated byte {i}"
            );
        }
        assert!(binding_request(&[3; 12], &[0; 1200], 0, &key).is_none());
    }

    #[test]
    fn success_requires_one_final_full_integrity_attribute_and_unique_evidence() {
        let key = test_key();
        let txn = [3; 12];
        let address = "198.51.100.1:50000".parse().unwrap();
        let mut success = ResponseWriter::new(&txn);
        assert!(success.push_address(ATTR_XOR_MAPPED_ADDRESS, address, &txn, true));
        assert!(parse_success(success.as_bytes(), &txn).is_none());
        assert!(success.finish_in_place(&key));
        assert_eq!(
            parse_success(success.as_bytes(), &txn).unwrap().mapped,
            Some(address)
        );
        assert!(verify_integrity(success.as_bytes(), &key));
        let mut duplicate = ResponseWriter::new(&txn);
        for _ in 0..2 {
            assert!(duplicate.push_address(ATTR_XOR_MAPPED_ADDRESS, address, &txn, true));
        }
        assert!(duplicate.finish_in_place(&key));
        assert!(parse_success(duplicate.as_bytes(), &txn).is_none());
    }
}
