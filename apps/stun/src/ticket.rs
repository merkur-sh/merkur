//! Stateless STUN credentials.
//!
//! # Why authenticate a Binding responder at all
//!
//! An open STUN server answers anyone. Two consequences matter here. It is a
//! UDP reflector — an attacker spoofs a victim's source address and we send the
//! victim our response — and its answers are the sole input to the daemon's NAT
//! classification, so anyone able to forge one can make a daemon believe it has
//! a reflexive address it does not have, or that its NAT is symmetric when it is
//! not. The first is an abuse problem for everyone else; the second silently
//! costs every session on that daemon its direct path.
//!
//! Both are solved by refusing to answer anything unauthenticated, and by
//! authenticating the response too.
//!
//! # Why a ticket rather than a per-daemon secret
//!
//! The responder must stay stateless: it holds no database, does no lookups on
//! the packet path, and can be redeployed or scaled to another region without
//! carrying anything. So the credential is self-describing — the server mints a
//! short-lived ticket over the daemon's already-authenticated control
//! connection, and the responder verifies it with the one shared key it was
//! deployed with. No per-daemon state exists anywhere in this process.
//!
//! # What a ticket does not carry
//!
//! No daemon id, user id, or any other identifier. The responder has no use for
//! one — it answers "what address did this packet come from", which is the same
//! answer regardless of who asked — and a stolen ticket should not tell an
//! attacker whose it was. The expiry bounds replay; the nonce keeps two tickets
//! minted in the same second distinct.

use ring::hmac;
use ring::rand::SecureRandom;

/// Format version, so a future change is a hard cutover rather than a guess.
/// A responder rejects anything else outright.
const TICKET_VERSION: u8 = 1;

const NONCE_LEN: usize = 16;
const TAG_LEN: usize = 16;
/// version(1) + expiry(8) + nonce(16) + tag(16)
pub const TICKET_LEN: usize = 1 + 8 + NONCE_LEN + TAG_LEN;

/// Domain separation. The same 64-byte deployment key derives both the ticket
/// tag and the per-ticket message-integrity key; without distinct labels a tag
/// would be usable as an integrity key and vice versa.
const TAG_LABEL: &[u8] = b"merkur-stun-ticket-v1";
const INTEGRITY_LABEL: &[u8] = b"merkur-stun-message-integrity-v1";

/// Longest a ticket may remain valid once minted.
///
/// Bounds replay of a captured ticket. It does not need to cover a session:
/// STUN is used at startup and on reprobe, and the daemon holds a live control
/// connection it can always ask for another over.
pub const MAX_TICKET_LIFETIME_SECS: u64 = 15 * 60;

/// Tolerance for clock skew between the issuing server and the responder.
///
/// Both run on infrastructure with NTP, so this is small on purpose: a wide
/// window is indistinguishable from a longer lifetime.
const CLOCK_SKEW_TOLERANCE_SECS: u64 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketError {
    WrongLength,
    UnknownVersion,
    BadTag,
    Expired,
    /// Valid tag, but an expiry further out than any honest issuer would mint.
    /// Refused so a leaked key cannot be used to forge an eternal credential
    /// that outlives key rotation.
    LifetimeTooLong,
}

/// The deployment key, shared by the issuing server and every responder.
pub struct TicketKey {
    key: hmac::Key,
}

impl TicketKey {
    /// `secret` is the raw 64 bytes, matching how edge registration keys are
    /// sized and encoded.
    pub fn new(secret: &[u8]) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, secret),
        }
    }

    fn tag(&self, version: u8, expiry: u64, nonce: &[u8; NONCE_LEN]) -> [u8; TAG_LEN] {
        let mut context = hmac::Context::with_key(&self.key);
        context.update(TAG_LABEL);
        context.update(&[version]);
        context.update(&expiry.to_be_bytes());
        context.update(nonce);
        let full = context.sign();
        let mut tag = [0u8; TAG_LEN];
        tag.copy_from_slice(&full.as_ref()[..TAG_LEN]);
        tag
    }

    /// Mint a ticket valid until `expiry_unix_secs`.
    ///
    /// Present so the wire format has exactly one implementation and the
    /// conformance tests can exercise issuance against verification. The
    /// production issuer is the application server; see
    /// `apps/server/src/services/stun-ticket-service.ts`, which must stay
    /// byte-identical to this.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the responder verifies tickets; the server issues them")
    )]
    pub fn issue(
        &self,
        expiry_unix_secs: u64,
        rng: &dyn SecureRandom,
    ) -> Result<[u8; TICKET_LEN], ()> {
        let mut nonce = [0u8; NONCE_LEN];
        rng.fill(&mut nonce).map_err(|_| ())?;
        let tag = self.tag(TICKET_VERSION, expiry_unix_secs, &nonce);

        let mut ticket = [0u8; TICKET_LEN];
        ticket[0] = TICKET_VERSION;
        ticket[1..9].copy_from_slice(&expiry_unix_secs.to_be_bytes());
        ticket[9..9 + NONCE_LEN].copy_from_slice(&nonce);
        ticket[9 + NONCE_LEN..].copy_from_slice(&tag);
        Ok(ticket)
    }

    /// Verify a ticket and derive the per-ticket message-integrity key.
    ///
    /// Order matters: the tag is checked before the expiry so that a forged
    /// ticket and an expired one take the same path, and neither reveals which
    /// it was — the caller drops both silently anyway, but keeping the shapes
    /// identical means a timing difference cannot distinguish them either.
    pub fn verify(&self, ticket: &[u8], now_unix_secs: u64) -> Result<hmac::Key, TicketError> {
        if ticket.len() != TICKET_LEN {
            return Err(TicketError::WrongLength);
        }
        let version = ticket[0];
        if version != TICKET_VERSION {
            return Err(TicketError::UnknownVersion);
        }
        let mut expiry_bytes = [0u8; 8];
        expiry_bytes.copy_from_slice(&ticket[1..9]);
        let expiry = u64::from_be_bytes(expiry_bytes);
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&ticket[9..9 + NONCE_LEN]);

        let expected = self.tag(version, expiry, &nonce);
        if !crate::message::constant_time_eq(&expected, &ticket[9 + NONCE_LEN..]) {
            return Err(TicketError::BadTag);
        }

        if expiry.saturating_add(CLOCK_SKEW_TOLERANCE_SECS) < now_unix_secs {
            return Err(TicketError::Expired);
        }
        if expiry
            > now_unix_secs
                .saturating_add(MAX_TICKET_LIFETIME_SECS)
                .saturating_add(CLOCK_SKEW_TOLERANCE_SECS)
        {
            return Err(TicketError::LifetimeTooLong);
        }

        let mut context = hmac::Context::with_key(&self.key);
        context.update(INTEGRITY_LABEL);
        context.update(ticket);
        let derived = context.sign();
        Ok(hmac::Key::new(hmac::HMAC_SHA256, derived.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use ring::rand::SystemRandom;

    use super::*;

    fn key() -> TicketKey {
        TicketKey::new(&[3u8; 64])
    }

    #[test]
    fn a_freshly_issued_ticket_verifies() {
        let key = key();
        let rng = SystemRandom::new();
        let ticket = key.issue(1_000_600, &rng).expect("issue");
        assert!(key.verify(&ticket, 1_000_000).is_ok());
    }

    #[test]
    fn two_tickets_minted_in_the_same_second_differ() {
        let key = key();
        let rng = SystemRandom::new();
        let first = key.issue(1_000_600, &rng).expect("issue");
        let second = key.issue(1_000_600, &rng).expect("issue");
        assert_ne!(first, second, "the nonce is what keeps these distinct");
    }

    /// Every byte of a ticket is covered by the tag. A single flip anywhere in
    /// the authenticated prefix must fail, and a flip in the tag itself must
    /// fail too.
    #[test]
    fn any_mutated_byte_invalidates_a_ticket() {
        let key = key();
        let rng = SystemRandom::new();
        let original = key.issue(1_000_600, &rng).expect("issue");
        for index in 0..TICKET_LEN {
            let mut mutated = original;
            mutated[index] ^= 0x01;
            // A mutated version byte is refused for that reason instead.
            let expected_ok = false;
            assert_eq!(
                key.verify(&mutated, 1_000_000).is_ok(),
                expected_ok,
                "byte {index} was mutated but the ticket still verified"
            );
        }
    }

    #[test]
    fn a_ticket_from_a_different_deployment_key_is_refused() {
        let rng = SystemRandom::new();
        let ticket = key().issue(1_000_600, &rng).expect("issue");
        let other = TicketKey::new(&[4u8; 64]);
        assert_eq!(
            other.verify(&ticket, 1_000_000).err(),
            Some(TicketError::BadTag)
        );
    }

    #[test]
    fn an_expired_ticket_is_refused_once_skew_tolerance_lapses() {
        let key = key();
        let rng = SystemRandom::new();
        let ticket = key.issue(1_000_000, &rng).expect("issue");
        assert!(
            key.verify(&ticket, 1_000_030).is_ok(),
            "inside the skew tolerance a just-expired ticket still works"
        );
        assert_eq!(
            key.verify(&ticket, 1_000_000 + CLOCK_SKEW_TOLERANCE_SECS + 1)
                .err(),
            Some(TicketError::Expired)
        );
    }

    /// A key holder must not be able to mint a credential that outlives key
    /// rotation. The responder enforces the ceiling itself rather than trusting
    /// the issuer to have applied it.
    #[test]
    fn an_absurdly_distant_expiry_is_refused_even_with_a_valid_tag() {
        let key = key();
        let rng = SystemRandom::new();
        let ticket = key
            .issue(1_000_000 + MAX_TICKET_LIFETIME_SECS * 10, &rng)
            .expect("issue");
        assert_eq!(
            key.verify(&ticket, 1_000_000).err(),
            Some(TicketError::LifetimeTooLong)
        );
    }

    #[test]
    fn a_wrong_length_or_version_is_refused_before_any_hmac() {
        let key = key();
        assert_eq!(key.verify(&[], 1).err(), Some(TicketError::WrongLength));
        assert_eq!(
            key.verify(&[0u8; TICKET_LEN - 1], 1).err(),
            Some(TicketError::WrongLength)
        );
        let rng = SystemRandom::new();
        let mut ticket = key.issue(1_000_600, &rng).expect("issue");
        ticket[0] = 2;
        assert_eq!(
            key.verify(&ticket, 1_000_000).err(),
            Some(TicketError::UnknownVersion)
        );
    }

    /// The integrity key must be bound to the specific ticket, or one valid
    /// ticket's key would authenticate messages presented with another.
    #[test]
    fn each_ticket_derives_its_own_message_integrity_key() {
        let key = key();
        let rng = SystemRandom::new();
        let first = key.issue(1_000_600, &rng).expect("issue");
        let second = key.issue(1_000_600, &rng).expect("issue");

        let first_key = key.verify(&first, 1_000_000).expect("verify");
        let second_key = key.verify(&second, 1_000_000).expect("verify");

        let message = b"binding request bytes";
        let first_tag = hmac::sign(&first_key, message);
        assert!(
            hmac::verify(&second_key, message, first_tag.as_ref()).is_err(),
            "two tickets must not share an integrity key"
        );
    }

    /// Cross-language vector.
    ///
    /// The application server issues these tickets in TypeScript
    /// (`apps/server/src/services/stun-ticket-service.ts`) and this crate is
    /// what verifies them. Nothing at runtime detects disagreement: a daemon
    /// handed a ticket this responder rejects just gets silence, which reaches
    /// the operator as `NatMapping::Unknown` and a missing direct path.
    ///
    /// So both sides pin the same string, produced from the same fixed inputs.
    /// Either implementation changing its layout, labels, field widths, or tag
    /// truncation breaks one of the two suites.
    #[test]
    fn the_pinned_cross_language_vector_round_trips() {
        const TICKET_B64: &str = "AQAAAAAAD0SYBwcHBwcHBwcHBwcHBwcHB5XG308T8ATzJFC6B2Xm0XE";
        const INTEGRITY_B64: &str = "MiRErNQ0xkLbd72f3fsxZqtyo9wJ_LbvmlppSKq85zA";

        let key = key();
        let expiry: u64 = 1_000_600;
        let nonce = [7u8; NONCE_LEN];

        // Rebuild the credential from the same inputs the TypeScript issuer
        // uses, rather than decoding the vector and re-signing it: that would
        // prove only that this file agrees with itself.
        let mut ticket = [0u8; TICKET_LEN];
        ticket[0] = TICKET_VERSION;
        ticket[1..9].copy_from_slice(&expiry.to_be_bytes());
        ticket[9..9 + NONCE_LEN].copy_from_slice(&nonce);
        ticket[9 + NONCE_LEN..].copy_from_slice(&key.tag(TICKET_VERSION, expiry, &nonce));

        use base64::Engine as _;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        assert_eq!(
            URL_SAFE_NO_PAD.encode(ticket),
            TICKET_B64,
            "the Rust encoding drifted from the TypeScript issuer"
        );

        // And the key both sides sign STUN messages under.
        let integrity = key
            .verify(&ticket, expiry - 60)
            .expect("vector must verify");
        let probe = hmac::sign(&integrity, b"");
        let expected = {
            let mut context = hmac::Context::with_key(&key.key);
            context.update(INTEGRITY_LABEL);
            context.update(&ticket);
            context.sign()
        };
        assert_eq!(
            URL_SAFE_NO_PAD.encode(expected.as_ref()),
            INTEGRITY_B64,
            "the derived message-integrity key drifted from the TypeScript issuer"
        );
        // The returned key really is the one that vector describes.
        let from_vector = hmac::Key::new(hmac::HMAC_SHA256, expected.as_ref());
        assert_eq!(probe.as_ref(), hmac::sign(&from_vector, b"").as_ref());
    }

    /// The tag and the integrity key come from the same deployment secret, so
    /// their domain separation is load-bearing: without distinct labels a
    /// ticket's own tag prefix would be a valid integrity key.
    #[test]
    fn the_tag_and_integrity_derivations_are_domain_separated() {
        let key = key();
        let rng = SystemRandom::new();
        let ticket = key.issue(1_000_600, &rng).expect("issue");
        let integrity = key.verify(&ticket, 1_000_000).expect("verify");

        let tag_in_ticket = &ticket[9 + NONCE_LEN..];
        let probe = hmac::sign(&integrity, b"probe");
        assert_ne!(
            &probe.as_ref()[..TAG_LEN],
            tag_in_ticket,
            "the integrity key must not reproduce the ticket tag"
        );
    }
}
