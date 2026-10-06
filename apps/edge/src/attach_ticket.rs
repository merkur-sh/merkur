//! Server-signed attach tickets: the edge relays only what the server issued.
//!
//! Without them the edge is an open relay: anyone who knows its address can pair
//! two endpoints under an invented routing label. Every routing preface now
//! carries a ticket minted by the application server from a deployment key this
//! process shares with it, and a peer whose ticket does not verify never reaches
//! the splice registry.
//!
//! Two roles, two lifetimes:
//!
//! - A **daemon** ticket binds a daemon id and expires. The server mints a fresh
//!   one on every control-lease renewal, so a daemon that is unlinked, or that
//!   lost its control connection, stops being able to attach within one
//!   lifetime. It names no session: a daemon holds one ticket for every
//!   session it serves.
//! - A **browser** ticket binds one session and the daemon it was issued for, and
//!   carries no expiry. It is useless on its own: the edge pairs a browser only
//!   with a daemon attachment naming the same daemon, and that daemon's ticket
//!   is the one that proves the machine is still linked. Session renewal and
//!   rebind are in-band between browser and daemon, so an expiring browser ticket
//!   would refuse legitimate lane redials long after the server last spoke.
//!
//! The wire format has a second implementation in TypeScript
//! (`apps/server/src/services/edge-attach-ticket.ts`), which issues. Both suites
//! pin the same vector, because nothing at runtime detects drift.
//!
//! Layout, base64url without padding on the wire:
//!
//! ```text
//!   version(1) | role(1) | expiry_unix_secs(8, big-endian) | tag(16)
//! ```
//!
//! `tag` is HMAC-SHA256 truncated to 16 bytes over the label, version, role,
//! expiry, and the length-prefixed daemon id and base session id (empty for a
//! daemon ticket). The session id is the base routing label: the interactive
//! lane uses it bare, the other lanes append `#signaling` or `#bulk`, and one
//! browser ticket covers all three.

use base64::Engine;
use ring::hmac;

/// Which end of a splice a ticket admits. Its own type so the probe binaries can
/// include this module without the relay's splice types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketRole {
    Browser,
    Daemon,
}

/// Format version, so a change is a hard cutover rather than a guess.
const TICKET_VERSION: u8 = 1;
const ROLE_BROWSER: u8 = 1;
const ROLE_DAEMON: u8 = 2;
const TAG_LEN: usize = 16;
/// version(1) + role(1) + expiry(8) + tag(16)
pub const TICKET_LEN: usize = 1 + 1 + 8 + TAG_LEN;
/// Length of the 64-byte deployment key, matching how every other Merkur
/// deployment secret is sized.
pub const KEY_LEN: usize = 64;

/// Domain separation from every other use of HMAC in the deployment.
const TAG_LABEL: &[u8] = b"merkur-edge-attach-ticket-v1";

/// Longest a daemon ticket may remain valid once minted.
///
/// A bound, not the issuing lifetime: the server mints for ninety seconds and a
/// fresh ticket rides every twenty-second lease renewal. The edge refuses
/// anything further out so a leaked key cannot mint a credential that outlives
/// its rotation.
const MAX_DAEMON_TICKET_LIFETIME_SECS: u64 = 5 * 60;

/// Tolerance for clock skew between the issuing server and this process. Both
/// run with NTP; a wide window would be indistinguishable from a longer
/// lifetime.
const CLOCK_SKEW_TOLERANCE_SECS: u64 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketError {
    Encoding,
    WrongLength,
    UnknownVersion,
    WrongRole,
    BadTag,
    Expired,
    LifetimeTooLong,
    /// A browser ticket carrying an expiry, which no issuer mints.
    UnexpectedExpiry,
    /// An identifier longer than the length prefix can carry.
    OversizedField,
}

/// The deployment key shared with the issuing server.
pub struct AttachTicketKey {
    key: hmac::Key,
}

impl AttachTicketKey {
    pub fn new(secret: &[u8; KEY_LEN]) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, secret),
        }
    }

    /// Parse the canonical unpadded base64url encoding of the 64-byte key.
    pub fn from_base64url(value: &str) -> Result<Self, String> {
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(value.as_bytes())
            .map_err(|_| "attach ticket key is not canonical base64url".to_string())?;
        let secret: [u8; KEY_LEN] = decoded
            .try_into()
            .map_err(|_| format!("attach ticket key must be exactly {KEY_LEN} bytes"))?;
        Ok(Self::new(&secret))
    }

    fn tag(
        &self,
        role: u8,
        expiry: u64,
        daemon_id: &str,
        session_id: &str,
    ) -> Result<[u8; TAG_LEN], TicketError> {
        let daemon_len = u16::try_from(daemon_id.len()).map_err(|_| TicketError::OversizedField)?;
        let session_len =
            u16::try_from(session_id.len()).map_err(|_| TicketError::OversizedField)?;
        let mut context = hmac::Context::with_key(&self.key);
        context.update(TAG_LABEL);
        context.update(&[TICKET_VERSION, role]);
        context.update(&expiry.to_be_bytes());
        context.update(&daemon_len.to_be_bytes());
        context.update(daemon_id.as_bytes());
        context.update(&session_len.to_be_bytes());
        context.update(session_id.as_bytes());
        let full = context.sign();
        let mut tag = [0u8; TAG_LEN];
        tag.copy_from_slice(&full.as_ref()[..TAG_LEN]);
        Ok(tag)
    }

    /// Mint a ticket. The production issuer is the application server; this
    /// exists so the conformance vector, the relay tests and the probes share
    /// the one Rust implementation of the format.
    #[cfg_attr(
        not(test),
        expect(
            clippy::allow_attributes,
            reason = "`#[path]` compiles this file into three binaries and `issue` is dead only \
                      in `merkur-edge`, so no expectation holds in all of them"
        )
    )]
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "the edge verifies tickets; the server issues them")
    )]
    pub fn issue(
        &self,
        role: TicketRole,
        daemon_id: &str,
        session_id: &str,
        expiry_unix_secs: u64,
    ) -> Result<String, TicketError> {
        let (role_byte, session, expiry) = match role {
            TicketRole::Browser => (ROLE_BROWSER, base_session_id(session_id), 0),
            TicketRole::Daemon => (ROLE_DAEMON, "", expiry_unix_secs),
        };
        let tag = self.tag(role_byte, expiry, daemon_id, session)?;
        let mut ticket = [0u8; TICKET_LEN];
        ticket[0] = TICKET_VERSION;
        ticket[1] = role_byte;
        ticket[2..10].copy_from_slice(&expiry.to_be_bytes());
        ticket[10..].copy_from_slice(&tag);
        Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(ticket))
    }

    /// Verify the ticket a routing preface carries.
    ///
    /// Order follows the STUN verifier: the tag is checked before the expiry, so
    /// a forged ticket and an expired one take the same path.
    pub fn verify(
        &self,
        role: TicketRole,
        daemon_id: &str,
        routing_session_id: &str,
        ticket: &str,
        now_unix_secs: u64,
    ) -> Result<(), TicketError> {
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(ticket.as_bytes())
            .map_err(|_| TicketError::Encoding)?;
        if decoded.len() != TICKET_LEN {
            return Err(TicketError::WrongLength);
        }
        if decoded[0] != TICKET_VERSION {
            return Err(TicketError::UnknownVersion);
        }
        let (expected_role, session) = match role {
            TicketRole::Browser => (ROLE_BROWSER, base_session_id(routing_session_id)),
            TicketRole::Daemon => (ROLE_DAEMON, ""),
        };
        if decoded[1] != expected_role {
            return Err(TicketError::WrongRole);
        }
        let mut expiry_bytes = [0u8; 8];
        expiry_bytes.copy_from_slice(&decoded[2..10]);
        let expiry = u64::from_be_bytes(expiry_bytes);
        let expected = self.tag(expected_role, expiry, daemon_id, session)?;
        if !constant_time_eq(&expected, &decoded[10..]) {
            return Err(TicketError::BadTag);
        }
        match role {
            TicketRole::Browser if expiry != 0 => Err(TicketError::UnexpectedExpiry),
            TicketRole::Browser => Ok(()),
            TicketRole::Daemon => {
                if expiry.saturating_add(CLOCK_SKEW_TOLERANCE_SECS) < now_unix_secs {
                    return Err(TicketError::Expired);
                }
                if expiry
                    > now_unix_secs
                        .saturating_add(MAX_DAEMON_TICKET_LIFETIME_SECS)
                        .saturating_add(CLOCK_SKEW_TOLERANCE_SECS)
                {
                    return Err(TicketError::LifetimeTooLong);
                }
                Ok(())
            }
        }
    }
}

/// The session a routing label belongs to: the interactive lane's bare label.
pub fn base_session_id(routing_session_id: &str) -> &str {
    routing_session_id
        .strip_suffix("#signaling")
        .or_else(|| routing_session_id.strip_suffix("#bulk"))
        .unwrap_or(routing_session_id)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

/// The daemon every relay test attachment serves.
#[cfg(test)]
pub const TEST_DAEMON_ID: &str = "test-daemon";

/// The deployment key relay tests run their accept loops with.
#[cfg(test)]
pub fn test_key() -> std::sync::Arc<AttachTicketKey> {
    std::sync::Arc::new(AttachTicketKey::new(&[9u8; KEY_LEN]))
}

/// A ticket `test_key` admits for `role` on `session_id`, for `TEST_DAEMON_ID`.
#[cfg(test)]
pub fn test_ticket(role: TicketRole, session_id: &str) -> String {
    let expiry = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch")
        .as_secs()
        + 90;
    test_key()
        .issue(role, TEST_DAEMON_ID, session_id, expiry)
        .expect("test ticket")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_790_000_000;

    fn key() -> AttachTicketKey {
        AttachTicketKey::new(&[7u8; KEY_LEN])
    }

    /// Pinned byte-for-byte by `apps/server/src/services/edge-attach-ticket.test.ts`.
    #[test]
    fn conformance_vector() {
        let key = key();
        assert_eq!(
            key.issue(TicketRole::Browser, "daemon-1", "session-1#bulk", 0)
                .unwrap(),
            "AQEAAAAAAAAAAKjJ6FRstzs_T-7SD4qU60I"
        );
        assert_eq!(
            key.issue(TicketRole::Daemon, "daemon-1", "", 1_790_000_090)
                .unwrap(),
            "AQIAAAAAarE72rtPDdT1Fc4HX_bsiZ172Gk"
        );
    }

    #[test]
    fn one_browser_ticket_covers_every_lane_of_its_session() {
        let key = key();
        let ticket = key
            .issue(TicketRole::Browser, "daemon-1", "session-1", 0)
            .unwrap();
        for label in ["session-1", "session-1#signaling", "session-1#bulk"] {
            assert_eq!(
                key.verify(TicketRole::Browser, "daemon-1", label, &ticket, NOW),
                Ok(())
            );
        }
        assert_eq!(
            key.verify(TicketRole::Browser, "daemon-1", "session-2", &ticket, NOW),
            Err(TicketError::BadTag)
        );
        assert_eq!(
            key.verify(TicketRole::Browser, "daemon-2", "session-1", &ticket, NOW),
            Err(TicketError::BadTag)
        );
    }

    #[test]
    fn a_daemon_ticket_names_its_daemon_and_expires() {
        let key = key();
        let ticket = key
            .issue(TicketRole::Daemon, "daemon-1", "", NOW + 90)
            .unwrap();
        for label in ["any-session", "other#bulk"] {
            assert_eq!(
                key.verify(TicketRole::Daemon, "daemon-1", label, &ticket, NOW),
                Ok(())
            );
        }
        assert_eq!(
            key.verify(TicketRole::Daemon, "daemon-2", "s", &ticket, NOW),
            Err(TicketError::BadTag)
        );
        assert_eq!(
            key.verify(TicketRole::Daemon, "daemon-1", "s", &ticket, NOW + 90 + 61),
            Err(TicketError::Expired)
        );
        let eternal = key
            .issue(TicketRole::Daemon, "daemon-1", "", NOW + 24 * 60 * 60)
            .unwrap();
        assert_eq!(
            key.verify(TicketRole::Daemon, "daemon-1", "s", &eternal, NOW),
            Err(TicketError::LifetimeTooLong)
        );
    }

    #[test]
    fn a_ticket_cannot_change_role() {
        let key = key();
        let browser = key.issue(TicketRole::Browser, "daemon-1", "s", 0).unwrap();
        let daemon = key
            .issue(TicketRole::Daemon, "daemon-1", "", NOW + 90)
            .unwrap();
        assert_eq!(
            key.verify(TicketRole::Daemon, "daemon-1", "s", &browser, NOW),
            Err(TicketError::WrongRole)
        );
        assert_eq!(
            key.verify(TicketRole::Browser, "daemon-1", "s", &daemon, NOW),
            Err(TicketError::WrongRole)
        );
    }

    #[test]
    fn malformed_and_foreign_tickets_are_refused() {
        let key = key();
        let other = AttachTicketKey::new(&[8u8; KEY_LEN]);
        let foreign = other
            .issue(TicketRole::Browser, "daemon-1", "s", 0)
            .unwrap();
        assert_eq!(
            key.verify(TicketRole::Browser, "daemon-1", "s", &foreign, NOW),
            Err(TicketError::BadTag)
        );
        assert_eq!(
            key.verify(TicketRole::Browser, "daemon-1", "s", "", NOW),
            Err(TicketError::WrongLength)
        );
        assert_eq!(
            key.verify(TicketRole::Browser, "daemon-1", "s", "not base64!", NOW),
            Err(TicketError::Encoding)
        );
        let mut bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(key.issue(TicketRole::Browser, "daemon-1", "s", 0).unwrap())
            .unwrap();
        bytes[0] = 2;
        let wrong_version = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes);
        assert_eq!(
            key.verify(TicketRole::Browser, "daemon-1", "s", &wrong_version, NOW),
            Err(TicketError::UnknownVersion)
        );
    }

    #[test]
    fn the_key_parses_only_its_canonical_encoding() {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; KEY_LEN]);
        assert!(AttachTicketKey::from_base64url(&encoded).is_ok());
        assert!(AttachTicketKey::from_base64url(&format!("{encoded}=")).is_err());
        assert!(AttachTicketKey::from_base64url(&encoded[..40]).is_err());
    }
}
