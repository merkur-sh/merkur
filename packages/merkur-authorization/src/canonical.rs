//! Canonical field rules shared by every record: unpadded base64url with exactly
//! one encoding per value, the protocol id alphabet, secure canonical origins,
//! display fields, and JavaScript safe integers. A record is canonical when it
//! re-serializes to the exact bytes it was read from.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::AuthorizationError;

/// `Number.MAX_SAFE_INTEGER`: every timestamp and epoch must survive a
/// round trip through a JavaScript number.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

const MAX_ID_BYTES: usize = 128;
const MAX_ORIGIN_BYTES: usize = 2_048;

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Characters in the unpadded base64url encoding of `bytes` bytes: four per
/// whole triple, then two or three for a remainder of one or two bytes.
pub const fn encoded_len(bytes: usize) -> usize {
    bytes / 3 * 4
        + match bytes % 3 {
            0 => 0,
            1 => 2,
            _ => 3,
        }
}

/// Decodes unpadded base64url of exactly `N` bytes whose encoding is the one
/// canonical spelling of those bytes.
pub fn decode_exact<const N: usize>(
    value: &str,
    label: &'static str,
) -> Result<[u8; N], AuthorizationError> {
    let decoded = decode_len(value, N, label)?;
    let mut out = [0u8; N];
    out.copy_from_slice(&decoded);
    Ok(out)
}

pub fn decode_len(
    value: &str,
    expected: usize,
    label: &'static str,
) -> Result<Vec<u8>, AuthorizationError> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AuthorizationError::new(
            label,
            "is not canonical unpadded base64url",
        ));
    }
    // The decoded length is decided by the character count alone, so a field of
    // any other length is refused before a byte of it is decoded or allocated
    // for, in the words the decoder below would have refused it with.
    if value.len() != encoded_len(expected) {
        return Err(AuthorizationError::new(
            label,
            if tail_decodes(value) {
                "is not canonical unpadded base64url of the expected length"
            } else {
                "is not canonical unpadded base64url"
            },
        ));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AuthorizationError::new(label, "is not canonical unpadded base64url"))?;
    if decoded.len() != expected || encode(&decoded) != value {
        return Err(AuthorizationError::new(
            label,
            "is not canonical unpadded base64url of the expected length",
        ));
    }
    Ok(decoded)
}

/// Whether a strict decoder accepts the end of `value`, a string already known
/// to be in the alphabet: one leftover character encodes no byte, and the bits
/// a final partial group does not use must be zero.
fn tail_decodes(value: &str) -> bool {
    let unused_bits = match value.len() % 4 {
        0 => return true,
        1 => return false,
        2 => 4,
        _ => 2,
    };
    value.bytes().next_back().is_some_and(|last| {
        let sextet = match last {
            b'A'..=b'Z' => last - b'A',
            b'a'..=b'z' => last - b'a' + 26,
            b'0'..=b'9' => last - b'0' + 52,
            b'-' => 62,
            _ => 63,
        };
        sextet & ((1 << unused_bits) - 1) == 0
    })
}

pub fn require_id(value: &str, label: &'static str) -> Result<(), AuthorizationError> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AuthorizationError::new(
            label,
            "must use the canonical protocol id alphabet",
        ));
    }
    if value.len() > MAX_ID_BYTES {
        return Err(AuthorizationError::new(label, "is too long"));
    }
    Ok(())
}

pub fn require_timestamp(value: u64, label: &'static str) -> Result<(), AuthorizationError> {
    if value > MAX_SAFE_INTEGER {
        return Err(AuthorizationError::new(
            label,
            "must be a non-negative safe integer",
        ));
    }
    Ok(())
}

pub fn require_positive(value: u64, label: &'static str) -> Result<(), AuthorizationError> {
    if value == 0 || value > MAX_SAFE_INTEGER {
        return Err(AuthorizationError::new(
            label,
            "must be a positive safe integer",
        ));
    }
    Ok(())
}

/// A display field: at most `max_bytes` of UTF-8 and not only whitespace, where
/// whitespace is exactly what `String.prototype.trim` removes.
pub fn require_display_field(
    value: &str,
    label: &'static str,
    max_bytes: usize,
) -> Result<(), AuthorizationError> {
    if value.len() > max_bytes || value.chars().all(is_ecmascript_whitespace) {
        return Err(AuthorizationError::new(label, "is invalid"));
    }
    Ok(())
}

/// ECMAScript `WhiteSpace` and `LineTerminator`.
fn is_ecmascript_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// A secure origin written exactly as the WHATWG URL parser serializes it:
/// `https://host[:port]`, or `http:` for a loopback host, with a lowercase ASCII
/// host, a canonical IPv4 or IPv6 literal, and no default, zero-padded or
/// out-of-range port.
pub fn require_origin(value: &str) -> Result<(), AuthorizationError> {
    const INVALID: &str = "must be a canonical secure origin";
    if value.len() > MAX_ORIGIN_BYTES {
        return Err(AuthorizationError::new("server origin", "is invalid"));
    }
    let (secure, rest) = if let Some(rest) = value.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = value.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err(AuthorizationError::new("server origin", INVALID));
    };
    let (host, port) =
        split_host_port(rest).ok_or_else(|| AuthorizationError::new("server origin", INVALID))?;
    if !canonical_host(host) {
        return Err(AuthorizationError::new("server origin", INVALID));
    }
    if let Some(port) = port {
        let default = if secure { "443" } else { "80" };
        if port.is_empty()
            || port == default
            || !port.bytes().all(|b| b.is_ascii_digit())
            || (port.len() > 1 && port.starts_with('0'))
            || port.parse::<u32>().map_or(true, |p| p > 65_535)
        {
            return Err(AuthorizationError::new("server origin", INVALID));
        }
    }
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    if !secure && !loopback {
        return Err(AuthorizationError::new("server origin", INVALID));
    }
    Ok(())
}

fn split_host_port(rest: &str) -> Option<(&str, Option<&str>)> {
    if rest.starts_with('[') {
        let end = rest.find(']')?;
        let (host, tail) = rest.split_at(end + 1);
        match tail {
            "" => Some((host, None)),
            _ => Some((host, Some(tail.strip_prefix(':')?))),
        }
    } else {
        match rest.rsplit_once(':') {
            Some((host, port)) => Some((host, Some(port))),
            None => Some((rest, None)),
        }
    }
}

fn canonical_host(host: &str) -> bool {
    if let Some(literal) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return literal
            .parse::<std::net::Ipv6Addr>()
            .is_ok_and(|address| whatwg_ipv6(&address) == literal);
    }
    if host.is_empty()
        || !host.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.' | b'_')
        })
    {
        return false;
    }
    // WHATWG reads a host whose last label is numeric as IPv4 and rewrites it,
    // so only the canonical dotted quad survives a round trip.
    let last = host.trim_end_matches('.').rsplit('.').next().unwrap_or("");
    if let Some(hex) = last.strip_prefix("0x")
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return false;
    }
    if !last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()) {
        return host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|address| address.to_string() == host);
    }
    true
}

/// The WHATWG IPv6 serializer: lowercase hex pieces, the first longest run of
/// two or more zero pieces compressed, and no embedded IPv4 form.
fn whatwg_ipv6(address: &std::net::Ipv6Addr) -> String {
    let pieces = address.segments();
    let (mut best_start, mut best_len) = (None, 1usize);
    let mut index = 0;
    while index < 8 {
        if pieces[index] == 0 {
            let start = index;
            while index < 8 && pieces[index] == 0 {
                index += 1;
            }
            if index - start > best_len {
                best_start = Some(start);
                best_len = index - start;
            }
        } else {
            index += 1;
        }
    }
    let mut out = String::new();
    let mut index = 0;
    while index < 8 {
        if Some(index) == best_start {
            out.push_str(if index == 0 { "::" } else { ":" });
            index += best_len;
            continue;
        }
        out.push_str(&format!("{:x}", pieces[index]));
        if index < 7 {
            out.push(':');
        }
        index += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_follow_the_whatwg_serialization() {
        for good in [
            "https://merkur.sh",
            "https://merkur.example",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://[::1]:8080",
            "https://a_b.example:8443",
            "https://[2001:db8::1]",
            "https://10.0.0.1",
        ] {
            assert!(require_origin(good).is_ok(), "{good}");
        }
        for bad in [
            "https://merkur.sh/",
            "https://Merkur.sh",
            "https://merkur.sh:443",
            "http://merkur.sh",
            "https://merkur.sh:08443",
            "https://merkur.sh:70000",
            "https://127.1",
            "https://[2001:0db8::1]",
            "https://[::ffff:1.2.3.4]",
            "ftp://merkur.sh",
            "https://merkur.sh:",
            "https://",
        ] {
            assert!(require_origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn display_fields_trim_like_javascript() {
        assert!(require_display_field("workstation", "name", 128).is_ok());
        assert!(require_display_field(" \u{FEFF}\u{3000}\n", "name", 128).is_err());
        // U+0085 is Unicode whitespace but not ECMAScript whitespace.
        assert!(require_display_field("\u{0085}", "name", 128).is_ok());
        assert!(require_display_field(&"x".repeat(129), "name", 128).is_err());
    }

    #[test]
    fn base64url_has_one_spelling() {
        let encoded = encode(&[0xa5; 64]);
        assert!(decode_len(&encoded, 64, "value").is_ok());
        assert!(decode_len(&format!("{encoded}="), 64, "value").is_err());
        assert!(decode_len(&encoded, 63, "value").is_err());
        // A trailing character whose low bits are not zero decodes to the same
        // bytes under a lenient decoder; it is not canonical.
        let short = encode(&[0xff]);
        let lenient = format!("{}{}", &short[..1], "_");
        assert!(decode_len(&lenient, 1, "value").is_err());
    }

    #[test]
    fn a_field_of_the_wrong_length_is_refused_by_its_character_count() {
        for bytes in 0..=64 {
            assert_eq!(encode(&vec![0xa5; bytes]).len(), encoded_len(bytes));
        }
        // An oversized field, and one a byte off either way: each is refused
        // for its length. A field no strict decoder reads at all, by its
        // leftover character or its nonzero unused bits, is refused as such.
        let exact = encode(&[0xa5; 64]);
        for (value, rule) in [
            (
                "A".repeat(4 * 1024 * 1024),
                "is not canonical unpadded base64url of the expected length",
            ),
            (
                encode(&[0xa5; 65]),
                "is not canonical unpadded base64url of the expected length",
            ),
            (
                encode(&[0xa5; 63]),
                "is not canonical unpadded base64url of the expected length",
            ),
            (format!("{exact}AAA"), "is not canonical unpadded base64url"),
            (format!("{exact}_"), "is not canonical unpadded base64url"),
        ] {
            assert_eq!(
                decode_len(&value, 64, "value"),
                Err(AuthorizationError::new("value", rule)),
                "{} characters",
                value.len()
            );
        }
        // The canonical check still runs for a field of the right length.
        let lenient = format!("{}{}", &exact[..exact.len() - 1], "_");
        assert_eq!(lenient.len(), encoded_len(64));
        assert!(decode_len(&lenient, 64, "value").is_err());
        assert!(decode_len(&exact, 64, "value").is_ok());
    }
}
