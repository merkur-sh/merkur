//! Noise Protocol Framework — daemon side of Merkur's mandatory E2E transport.
//!
//! Pattern: `Noise_XXpsk3_25519_ChaChaPoly_SHA512`. The daemon is
//! always the RESPONDER; the browser is the INITIATOR, running this same crate
//! compiled to WebAssembly (`packages/e2e-wasm`). The per-connection PSK comes
//! from a fresh ML-KEM-1024 exchange whose complete response is signed by the
//! daemon's static ML-DSA-87 identity and bound to the server capability, peer
//! identities, and signaling session. A malicious blind edge cannot complete
//! the handshake or replay it into another session.
//!
//! The handshake itself is performed by the audited `snow` crate. This module
//! adds only the transport framing: a lane-partitioned nonce schedule that makes
//! cross-channel nonce reuse structurally impossible, plus — for BOTH reliable
//! streams and datagrams — an explicit per-frame wire counter and a sliding
//! replay window, so a frame that arrives out of order or duplicated (e.g. fanned
//! over the edge AND a direct WebTransport path, or overtaken across carrier
//! generations) is tolerated instead of permanently wedging the lane.
//! Both sides run this code, so the committed interop vectors
//! (`packages/shared/test-vectors/`) pin the wire format itself rather than
//! reconciling two implementations of it.

use snow::{HandshakeState, types::Cipher};
use zeroize::Zeroizing;

mod content;
mod hybrid;
mod identity;
mod rebind;
mod rebind_commit;
mod rebind_keeper;
mod renewal;
#[cfg(all(target_arch = "wasm32", not(feature = "std")))]
mod wasm_chacha;

pub use content::*;
pub use hybrid::*;
pub use identity::*;
pub use rebind::*;
pub use rebind_commit::*;
pub use rebind_keeper::{RebindKeeper, RebindOutcome};
pub use renewal::*;

pub const NOISE_PROTOCOL_NAME: &str = "Noise_XXpsk3_25519_ChaChaPoly_SHA512";

const TAG_BYTES: usize = 16;
/// Per-frame wire overhead: the 8-byte lane counter plus the AEAD tag. A sealed
/// frame is exactly `plaintext.len() + FRAME_OVERHEAD` bytes.
pub const FRAME_OVERHEAD: usize = 8 + TAG_BYTES;
const HANDSHAKE_OVERHEAD: usize = 96; // ephemeral + static + two tags, generously rounded.
const COUNTER_MASK: u64 = (1u64 << 56) - 1;
/// Receiver-local replay window, in slots. A logical channel is delivered across
/// multiple ordering domains (a frame may fan over the edge AND a direct
/// WebTransport path, and a replacement carrier may overtake the old one), so a
/// frame first delivered on a slow lane can trail the highest-seen counter by
/// far more than 64. Purely local dedup policy — only the 8-byte counter is on
/// the wire, so the size is not an interop parameter and can grow without
/// touching the interop vectors.
const REPLAY_WINDOW_BITS: u32 = 1024;
const REPLAY_WINDOW_WORDS: usize = REPLAY_WINDOW_BITS as usize / 64;

/// Number of logical channels that own a Noise lane. Must match the length of
/// `LOGICAL_CHANNELS` in `packages/shared/src/transport.ts`.
pub const LANE_COUNT: usize = 5;

/// Maps a wire channel id (`network::protocol::CHANNEL_*`) to its lane index,
/// matching the `LOGICAL_CHANNELS` ordering used by the browser.
pub fn lane_for_channel(channel_id: u8) -> Option<usize> {
    match channel_id {
        0x01 => Some(0), // pty
        0x02 => Some(1), // ctrl
        0x03 => Some(2), // displayDatagram
        0x04 => Some(3), // displayCommit
        0x05 => Some(4), // displayAck
        _ => None,
    }
}

/// `nonce = (laneId << 56) | (counter & COUNTER_MASK)` where
/// `laneId = channel_lane * 2 + datagram`. Disjoint per-lane ranges under one
/// direction key guarantee no nonce is ever reused.
fn lane_nonce(channel_lane: usize, datagram: bool, counter: u64) -> u64 {
    let lane_id = (channel_lane as u64) * 2 + datagram as u64;
    (lane_id << 56) | (counter & COUNTER_MASK)
}

/// A browser-side `XXpsk3` handshake that has written message 1 and does not
/// yet hold the PSK.
///
/// # Why this is a distinct type
///
/// Fusing message 1 into the request flight means the initiator must exist
/// before the ML-KEM exchange has produced the PSK. `snow` permits that —
/// `MissingPsk` is raised only when the token loop reaches `Token::Psk(n)`,
/// which for `XXpsk3` sits at the END of message 3, and `split()` runs after
/// that loop — so the PSK still lands in the chaining key before the transport
/// keys are derived.
///
/// What `snow` does NOT enforce is Merkur's ordering rule: the daemon is
/// authenticated by the response proof (an ML-DSA-87 signature at genesis, an
/// HMAC under `RS` on rebind), NOT by Noise, because its static key is
/// process-ephemeral and unpinned. That proof must be verified before message 2
/// is touched. The caller invokes
/// `read_authenticated_msg2` only after the application's identity
/// proof verifies. Its consuming result fixes the classical checkpoint and
/// cannot emit message 3 until the bootstrap PSK is installed.
pub struct PendingNoiseInitiator {
    state: HandshakeState,
}

impl PendingNoiseInitiator {
    /// Build the initiator and write message 1 in one step, so a caller cannot
    /// hold one that has not yet spoken.
    pub fn start(static_private: &[u8], prologue: &[u8]) -> Result<(Self, Vec<u8>), NoiseError> {
        let params = NOISE_PROTOCOL_NAME
            .parse()
            .map_err(|_| NoiseError::Params)?;
        // No `.psk(3, ..)`: it does not exist yet, and `Builder` initialises its
        // PSK slots empty.
        let mut state = snow::Builder::new(params)
            .prologue(prologue)?
            .local_private_key(static_private)?
            .build_initiator()?;
        let mut buf = vec![0u8; HANDSHAKE_OVERHEAD];
        let len = state.write_message(&[], &mut buf)?;
        buf.truncate(len);
        Ok((Self { state }, buf))
    }

    /// Read the identity-authenticated, empty second flight. XXpsk3 does not
    /// mix its PSK until message 3, so this checkpoint is independent of it.
    pub fn read_authenticated_msg2(mut self, msg2: &[u8]) -> Result<AwaitingNoisePsk, NoiseError> {
        let mut scratch = vec![0u8; msg2.len().max(HANDSHAKE_OVERHEAD)];
        if self.state.read_message(msg2, &mut scratch)? != 0 {
            return Err(NoiseError::InvalidFrame);
        }
        Ok(AwaitingNoisePsk::new(self.state, true))
    }
}

/// The common, request-bound XXpsk3 checkpoint after `ee` and `es`.
/// Raw Split halves never leave this opaque Rust owner and are never transport
/// keys: message 3 still mixes `se` and the PSK before the real Split.
pub struct NoiseCheckpoint {
    contribution: Zeroizing<([u8; 32], [u8; 32])>,
    hash: [u8; 64],
}

/// A handshake that has processed exactly two empty flights. Only the
/// consuming initiator/responder constructors can produce this checkpoint.
pub struct AwaitingNoisePsk {
    state: HandshakeState,
    checkpoint: NoiseCheckpoint,
    initiator: bool,
}

impl AwaitingNoisePsk {
    fn new(mut state: HandshakeState, initiator: bool) -> Self {
        let contribution = Zeroizing::new(state.dangerously_get_raw_split());
        let mut hash = [0u8; 64];
        hash.copy_from_slice(state.get_handshake_hash());
        Self {
            state,
            checkpoint: NoiseCheckpoint { contribution, hash },
            initiator,
        }
    }

    pub fn checkpoint(&self) -> &NoiseCheckpoint {
        &self.checkpoint
    }

    pub fn install_psk(mut self, psk: &[u8]) -> Result<NoiseHandshake, NoiseError> {
        let psk_array: &[u8; 32] = psk.try_into().map_err(|_| NoiseError::Params)?;
        self.state.set_psk(3, psk_array).map_err(NoiseError::Snow)?;
        Ok(NoiseHandshake {
            state: self.state,
            initiator: self.initiator,
        })
    }
}

/// Prepare the exact second flight before deriving the PSK that its identity
/// signature authenticates. This avoids a signature/PSK/message dependency cycle.
pub struct PendingNoiseResponder;

impl PendingNoiseResponder {
    pub fn start(
        static_private: &[u8],
        prologue: &[u8],
        msg1: &[u8],
    ) -> Result<(AwaitingNoisePsk, Vec<u8>), NoiseError> {
        let params = NOISE_PROTOCOL_NAME
            .parse()
            .map_err(|_| NoiseError::Params)?;
        let mut state = snow::Builder::new(params)
            .prologue(prologue)?
            .local_private_key(static_private)?
            .build_responder()?;
        let mut scratch = vec![0u8; msg1.len().max(HANDSHAKE_OVERHEAD)];
        if state.read_message(msg1, &mut scratch)? != 0 {
            return Err(NoiseError::InvalidFrame);
        }
        let len = state.write_message(&[], &mut scratch)?;
        scratch.truncate(len);
        Ok((AwaitingNoisePsk::new(state, false), scratch))
    }
}

/// Canonical Noise prologue, bound to the session and to the REQUEST
/// transcript. Layout is `"merkur-transport-pq" || u64be(len(session_id)) ||
/// session_id || u64be(len(daemon_id)) || daemon_id || SHA-512(request_tbs)`.
///
/// The marker binds the handshake to the current reliable-stream and datagram
/// counter/replay-window framing. A mismatched peer derives a different
/// prologue, so the handshake fails closed.
///
/// # Why the request and not the response
///
/// The browser writes Noise message 1 in the same flight as its request, so the
/// prologue has to be computable before the daemon has answered. Binding the
/// response there is what made the handshake un-pipelinable and cost a full
/// round trip on every connect and every rebind.
///
/// Nothing is lost by moving it. The response is still bound into the same
/// handshake, harder: the PSK is derived by HKDF over the ML-KEM shared secret
/// AND the signed response transcript, and `XXpsk3` mixes that PSK before the
/// transport keys are split. A handshake detached from its ML-KEM ciphertext
/// therefore still fails closed — at message 3 rather than at message 1, which
/// is a difference in *when* the forgery is refused, not in *whether*. The
/// browser additionally verifies the daemon's ML-DSA-87 signature (genesis) or
/// its HMAC under `RS` (rebind) over that response before it processes message
/// 2 at all, so nothing unauthenticated is fed to the handshake either way.
///
/// The request transcript covers Noise message 1, and the flight-1 proof covers
/// the request transcript — so message 1 is authenticated despite travelling in
/// the same flight as the proof over it. Without that an on-path party (the
/// blind edge, by this crate's own threat model) could splice its own message 1
/// into an otherwise valid flight.
pub fn derive_prologue(
    session_id: &str,
    daemon_id: &str,
    request_transcript_hash: &[u8; 64],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(24 + 8 + session_id.len() + 8 + daemon_id.len() + 64);
    out.extend_from_slice(b"merkur-transport-pq");
    out.extend_from_slice(&(session_id.len() as u64).to_be_bytes());
    out.extend_from_slice(session_id.as_bytes());
    out.extend_from_slice(&(daemon_id.len() as u64).to_be_bytes());
    out.extend_from_slice(daemon_id.as_bytes());
    out.extend_from_slice(request_transcript_hash);
    out
}

#[cfg(any(test, feature = "testing"))]
pub fn test_psk_from_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut psk = [0u8; 32];
    for (index, byte) in psk.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(psk)
}

#[derive(Debug)]
pub enum NoiseError {
    Snow(snow::Error),
    Params,
    NonceExhausted,
    BufferTooSmall,
    InvalidFrame,
}

impl std::fmt::Display for NoiseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NoiseError::Snow(err) => write!(f, "noise protocol error: {err}"),
            NoiseError::Params => write!(f, "invalid noise parameters"),
            NoiseError::NonceExhausted => write!(f, "noise lane nonce space exhausted"),
            NoiseError::BufferTooSmall => write!(f, "noise output buffer too small"),
            NoiseError::InvalidFrame => write!(f, "invalid encrypted transport frame"),
        }
    }
}

impl std::error::Error for NoiseError {}

impl From<snow::Error> for NoiseError {
    fn from(err: snow::Error) -> Self {
        NoiseError::Snow(err)
    }
}

/// Mints a fresh `(private, public)` X25519 static keypair under the Merkur
/// Noise parameter set. The daemon calls this once at startup and reuses the
/// resulting private key as the responder static for every peer handshake this
/// process serves. Persistent identity pinning is a later phase; here the key is
/// ephemeral to the process and never persisted.
pub fn generate_static_keypair() -> Result<(Vec<u8>, Vec<u8>), NoiseError> {
    let params = NOISE_PROTOCOL_NAME
        .parse()
        .map_err(|_| NoiseError::Params)?;
    let keypair = snow::Builder::new(params).generate_keypair()?;
    Ok((keypair.private, keypair.public))
}

/// Handshake wrapper. Production code only builds responders; the initiator path
/// exists for the interop tests and mirrors the browser exactly.
pub struct NoiseHandshake {
    state: HandshakeState,
    initiator: bool,
}

impl NoiseHandshake {
    pub fn new_responder(
        static_private: &[u8],
        psk: &[u8],
        prologue: &[u8],
    ) -> Result<Self, NoiseError> {
        Ok(Self {
            state: Self::builder(static_private, psk, prologue, None)?.build_responder()?,
            initiator: false,
        })
    }

    // Initiator path. The daemon is always the responder; the initiator is the
    // browser, which compiles this crate to WebAssembly. Also used by the
    // interop-vector and in-process tests, which simulate the browser natively.
    pub fn new_initiator(
        static_private: &[u8],
        psk: &[u8],
        prologue: &[u8],
    ) -> Result<Self, NoiseError> {
        Ok(Self {
            state: Self::builder(static_private, psk, prologue, None)?.build_initiator()?,
            initiator: true,
        })
    }

    fn builder<'a>(
        static_private: &'a [u8],
        psk: &'a [u8],
        prologue: &'a [u8],
        fixed_ephemeral: Option<&'a [u8]>,
    ) -> Result<snow::Builder<'a>, NoiseError> {
        let psk_array: &'a [u8; 32] = psk.try_into().map_err(|_| NoiseError::Params)?;
        let params = NOISE_PROTOCOL_NAME
            .parse()
            .map_err(|_| NoiseError::Params)?;
        let mut builder = snow::Builder::new(params)
            .prologue(prologue)?
            .local_private_key(static_private)?
            .psk(3, psk_array)?;
        if let Some(ephemeral) = fixed_ephemeral {
            builder = builder.fixed_ephemeral_key_for_testing_only(ephemeral);
        }
        Ok(builder)
    }

    pub fn write_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let mut buf = vec![0u8; payload.len() + HANDSHAKE_OVERHEAD];
        let len = self.state.write_message(payload, &mut buf)?;
        buf.truncate(len);
        Ok(buf)
    }

    pub fn read_message(&mut self, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let mut buf = vec![0u8; message.len()];
        let len = self.state.read_message(message, &mut buf)?;
        buf.truncate(len);
        Ok(buf)
    }

    pub fn is_complete(&self) -> bool {
        self.state.is_handshake_finished()
    }

    pub fn remote_static(&self) -> Option<Vec<u8>> {
        self.state.get_remote_static().map(<[u8]>::to_vec)
    }

    // Used by the interop-vector test to assert TS↔snow agreement; not needed on
    // the production responder path.
    #[cfg(any(test, feature = "testing"))]
    pub fn handshake_hash(&self) -> Vec<u8> {
        self.state.get_handshake_hash().to_vec()
    }

    pub fn into_transport(mut self) -> Result<NoiseTransport, NoiseError> {
        // Raw Split must never make an incomplete or reusable handshake into a
        // transport. Consuming self enforces one nonce schedule per key pair.
        if !self.state.is_handshake_finished() {
            return Err(snow::Error::State(snow::error::StateProblem::HandshakeNotFinished).into());
        }
        let keys = Zeroizing::new(self.state.dangerously_get_raw_split());
        let (send, receive) = if self.initiator {
            (&keys.0, &keys.1)
        } else {
            (&keys.1, &keys.0)
        };
        Ok(NoiseTransport::new(
            transport_cipher(send)?,
            transport_cipher(receive)?,
            content::ContentDomain::new(
                send,
                receive,
                self.state.get_handshake_hash(),
                self.initiator,
            )?,
        ))
    }
}

/// Why [`NoiseTransport::open_stream`] / [`NoiseTransport::open_datagram`]
/// dropped a frame. `Replay` is the EXPECTED, benign case for a frame fanned
/// over more than one transport (or arriving out of order): the receiver opens
/// the first copy and the per-lane sliding window rejects later duplicates.
/// `Auth` is a genuine failure — malformed framing, an out-of-range wire
/// counter, or an AEAD tag mismatch. The caller drops the frame in either case
/// (never plaintext), but the distinction lets the inbound log stay quiet for
/// routine multi-path dedup instead of crying wolf on every duplicate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenReject {
    Replay,
    Auth,
}

/// Admits each value at most once, and none `REPLAY_WINDOW_BITS` or more below
/// the highest admitted. `advance` records only a value `check` accepted.
#[derive(Clone, Copy)]
pub struct ReplayWindow {
    highest: u64,
    /// Multi-word sliding bitmap: bit `d` (word `d / 64`, bit `d % 64`) marks the
    /// counter `highest - d` as already seen. Bit 0 of word 0 is `highest`.
    bitmap: [u64; REPLAY_WINDOW_WORDS],
    seen_any: bool,
}

impl Default for ReplayWindow {
    fn default() -> Self {
        Self {
            highest: 0,
            bitmap: [0; REPLAY_WINDOW_WORDS],
            seen_any: false,
        }
    }
}

impl ReplayWindow {
    pub fn check(&self, counter: u64) -> bool {
        if !self.seen_any {
            return true;
        }
        if counter > self.highest {
            return true;
        }
        let delta = self.highest - counter;
        if delta >= REPLAY_WINDOW_BITS as u64 {
            return false;
        }
        let d = delta as usize;
        (self.bitmap[d / 64] & (1u64 << (d % 64))) == 0
    }

    pub fn advance(&mut self, counter: u64) {
        if !self.seen_any {
            self.seen_any = true;
            self.highest = counter;
            self.bitmap = [0; REPLAY_WINDOW_WORDS];
            self.bitmap[0] = 1;
            return;
        }
        if counter > self.highest {
            let shift = counter - self.highest;
            if shift >= REPLAY_WINDOW_BITS as u64 {
                self.bitmap = [0; REPLAY_WINDOW_WORDS];
            } else {
                shift_window_left(&mut self.bitmap, shift as usize);
            }
            self.bitmap[0] |= 1;
            self.highest = counter;
        } else {
            let d = (self.highest - counter) as usize;
            self.bitmap[d / 64] |= 1u64 << (d % 64);
        }
    }
}

/// Shift the multi-word replay bitmap left by `bits` positions (toward higher
/// deltas), dropping bits that fall off the top of the window. `bits` is assumed
/// `< REPLAY_WINDOW_BITS`. Bit 0 of word 0 is the lowest position, so this is a
/// standard little-endian-word multiprecision left shift; words are written high
/// to low so each read of a lower source word precedes its overwrite.
fn shift_window_left(words: &mut [u64; REPLAY_WINDOW_WORDS], bits: usize) {
    let word_shift = bits / 64;
    let bit_shift = bits % 64;
    for i in (0..REPLAY_WINDOW_WORDS).rev() {
        let mut v = if i >= word_shift {
            words[i - word_shift]
        } else {
            0
        };
        if bit_shift > 0 {
            v <<= bit_shift;
            if i > word_shift {
                v |= words[i - word_shift - 1] >> (64 - bit_shift);
            }
        }
        words[i] = v;
    }
}
/// Ciphertext record resource ceiling, including the wire counter and tag.
/// Shared by native and WASM callers; the display codec has a smaller frame cap.
pub const MAX_TRANSPORT_FRAME_BYTES: usize = 8 * 1024 * 1024;

// ChaChaPoly with the Split keys, nonce encoding and AD Snow's transport would
// use; Merkur owns record framing, so Snow's 16-bit message envelope is not.
// Natively that is ring through Snow's resolver. In the browser it is the
// simd128 cipher in `wasm_chacha`, byte-exact with Snow's pure-Rust one and
// about twice as fast on display-sized frames. A non-std host build (lint or
// check only; nothing ships it) keeps Snow's default resolver. Resolved once
// per direction at setup, never in the frame hot path.
#[cfg_attr(
    all(target_arch = "wasm32", not(feature = "std")),
    expect(
        clippy::unnecessary_wraps,
        reason = "the native resolvers can refuse the cipher; every build shares this signature"
    )
)]
fn transport_cipher(key: &[u8; 32]) -> Result<Box<dyn Cipher>, NoiseError> {
    #[cfg(all(target_arch = "wasm32", not(feature = "std")))]
    let mut cipher: Box<dyn Cipher> = Box::new(wasm_chacha::SimdChaChaPoly::default());
    #[cfg(feature = "std")]
    let mut cipher = snow::resolvers::CryptoResolver::resolve_cipher(
        &snow::resolvers::RingResolver,
        &snow::params::CipherChoice::ChaChaPoly,
    )
    .ok_or(NoiseError::Params)?;
    #[cfg(all(not(target_arch = "wasm32"), not(feature = "std")))]
    let mut cipher = snow::resolvers::CryptoResolver::resolve_cipher(
        &snow::resolvers::DefaultResolver,
        &snow::params::CipherChoice::ChaChaPoly,
    )
    .ok_or(NoiseError::Params)?;
    cipher.set(key);
    Ok(cipher)
}

/// Per-connection transport state shared across every logical channel. Sealing
/// validates lane, buffer and record bounds before spending a nonce; opening
/// returns `Err(OpenReject::Replay)` for a
/// benign duplicate/reorder rejected by the window and `Err(OpenReject::Auth)`
/// for a genuine failure — the caller drops the frame either way and never
/// falls back to plaintext.
///
/// BOTH sub-lanes (reliable stream and datagram) carry an explicit 8-byte
/// big-endian wire counter and a 1024-slot sliding replay window. Individual
/// persistent QUIC streams are ordered, but a logical channel may be fanned over
/// the edge AND a direct WebTransport path or cross a carrier replacement. The
/// open path must therefore tolerate reorder and duplicates — otherwise one gap
/// permanently wedges the lane.
pub struct NoiseTransport {
    content: content::ContentDomain,
    send_cipher: Box<dyn Cipher>,
    receive_cipher: Box<dyn Cipher>,
    send_stream: [u64; LANE_COUNT],
    send_datagram: [u64; LANE_COUNT],
    replay_stream: [ReplayWindow; LANE_COUNT],
    replay_datagram: [ReplayWindow; LANE_COUNT],
}

impl NoiseTransport {
    fn new(
        send_cipher: Box<dyn Cipher>,
        receive_cipher: Box<dyn Cipher>,
        content: content::ContentDomain,
    ) -> Self {
        Self {
            content,
            send_cipher,
            receive_cipher,
            send_stream: [0; LANE_COUNT],
            send_datagram: [0; LANE_COUNT],
            replay_stream: [ReplayWindow::default(); LANE_COUNT],
            replay_datagram: [ReplayWindow::default(); LANE_COUNT],
        }
    }

    /// Shared seal for both sub-lanes: bump the per-lane send counter, encrypt
    /// under the lane nonce, and frame `counter_be(8) || ciphertext` directly
    /// into `out`. Routing stream and datagram through one code path makes their
    /// wire framing identical by construction — the browser mirror relies on it.
    ///
    /// Returns the number of bytes written. `out` must hold at least
    /// `plaintext.len() + FRAME_OVERHEAD`; the allocating wrappers below size it
    /// exactly, and the WebAssembly binding reuses one buffer across frames.
    fn seal_framed_into(
        &mut self,
        channel_lane: usize,
        datagram: bool,
        plaintext: &[u8],
        out: &mut [u8],
    ) -> Result<usize, NoiseError> {
        // Checked before the counter advances: a rejected call must not burn a
        // lane counter, or a caller retrying with a larger buffer would leave
        // permanent gaps in the receiver's replay window.
        if channel_lane >= LANE_COUNT
            || plaintext.len() > MAX_TRANSPORT_FRAME_BYTES - FRAME_OVERHEAD
        {
            return Err(NoiseError::InvalidFrame);
        }
        if out.len() < plaintext.len() + FRAME_OVERHEAD {
            return Err(NoiseError::BufferTooSmall);
        }
        let send = if datagram {
            &mut self.send_datagram[channel_lane]
        } else {
            &mut self.send_stream[channel_lane]
        };
        let counter = *send;
        // The high byte is reserved for the lane id, leaving a 56-bit counter.
        // Exhaustion is practically unreachable, but wrapping would reuse a
        // ChaChaPoly nonce under the same transport key. Fail closed instead.
        if counter > COUNTER_MASK {
            return Err(NoiseError::NonceExhausted);
        }
        *send = counter + 1;
        out[..8].copy_from_slice(&(counter & COUNTER_MASK).to_be_bytes());
        let ciphertext_len = self.send_cipher.encrypt(
            lane_nonce(channel_lane, datagram, counter),
            &[],
            plaintext,
            &mut out[8..],
        );
        Ok(8 + ciphertext_len)
    }

    /// Shared open for both sub-lanes: parse the wire counter, reject an
    /// out-of-range or already-seen counter via the per-lane replay window, then
    /// authenticate into `out`. The window only advances on a SUCCESSFUL open, so
    /// a failed open never disturbs lane state.
    ///
    /// Returns the plaintext length written. `out` must hold at least
    /// `framed.len() - 8`.
    fn open_framed_into(
        &mut self,
        channel_lane: usize,
        datagram: bool,
        framed: &[u8],
        out: &mut [u8],
    ) -> Result<usize, OpenReject> {
        if channel_lane >= LANE_COUNT
            || !(FRAME_OVERHEAD..=MAX_TRANSPORT_FRAME_BYTES).contains(&framed.len())
        {
            return Err(OpenReject::Auth);
        }
        if out.len() < framed.len() - 8 {
            return Err(OpenReject::Auth);
        }
        let mut counter_bytes = [0u8; 8];
        counter_bytes.copy_from_slice(&framed[..8]);
        let counter = u64::from_be_bytes(counter_bytes);
        // The AEAD nonce masks the counter to 56 bits, but the replay window is
        // driven by the full wire counter. Reject any counter outside the
        // legitimate 56-bit lane space so an attacker cannot forge a "fresh"
        // far-future counter (counter + k*2^56) that re-decrypts the same
        // ciphertext under an unchanged masked nonce.
        if counter > COUNTER_MASK {
            return Err(OpenReject::Auth);
        }
        let fresh = if datagram {
            self.replay_datagram[channel_lane].check(counter)
        } else {
            self.replay_stream[channel_lane].check(counter)
        };
        if !fresh {
            return Err(OpenReject::Replay);
        }
        let plaintext_len = self
            .receive_cipher
            .decrypt(
                lane_nonce(channel_lane, datagram, counter),
                &[],
                &framed[8..],
                out,
            )
            .map_err(|_| OpenReject::Auth)?;
        if datagram {
            self.replay_datagram[channel_lane].advance(counter);
        } else {
            self.replay_stream[channel_lane].advance(counter);
        }
        Ok(plaintext_len)
    }

    fn seal_framed(
        &mut self,
        channel_lane: usize,
        datagram: bool,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, NoiseError> {
        if channel_lane >= LANE_COUNT
            || plaintext.len() > MAX_TRANSPORT_FRAME_BYTES - FRAME_OVERHEAD
        {
            return Err(NoiseError::InvalidFrame);
        }
        let mut framed = vec![0u8; plaintext.len() + FRAME_OVERHEAD];
        let len = self.seal_framed_into(channel_lane, datagram, plaintext, &mut framed)?;
        framed.truncate(len);
        Ok(framed)
    }

    fn open_framed(
        &mut self,
        channel_lane: usize,
        datagram: bool,
        framed: &[u8],
    ) -> Result<Vec<u8>, OpenReject> {
        if channel_lane >= LANE_COUNT
            || !(FRAME_OVERHEAD..=MAX_TRANSPORT_FRAME_BYTES).contains(&framed.len())
        {
            return Err(OpenReject::Auth);
        }
        let mut plaintext = vec![0u8; framed.len() - 8];
        let len = self.open_framed_into(channel_lane, datagram, framed, &mut plaintext)?;
        plaintext.truncate(len);
        Ok(plaintext)
    }

    /// In-place variants for callers that own a reusable buffer — the
    /// WebAssembly binding keeps one per session so a frame crosses the
    /// JavaScript boundary without a per-call allocation on either side.
    pub fn seal_into(
        &mut self,
        channel_lane: usize,
        datagram: bool,
        plaintext: &[u8],
        out: &mut [u8],
    ) -> Result<usize, NoiseError> {
        self.seal_framed_into(channel_lane, datagram, plaintext, out)
    }

    pub fn open_into(
        &mut self,
        channel_lane: usize,
        datagram: bool,
        framed: &[u8],
        out: &mut [u8],
    ) -> Result<usize, OpenReject> {
        self.open_framed_into(channel_lane, datagram, framed, out)
    }

    pub fn seal_stream(
        &mut self,
        channel_lane: usize,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, NoiseError> {
        self.seal_framed(channel_lane, false, plaintext)
    }

    pub fn open_stream(
        &mut self,
        channel_lane: usize,
        framed: &[u8],
    ) -> Result<Vec<u8>, OpenReject> {
        self.open_framed(channel_lane, false, framed)
    }

    pub fn seal_datagram(
        &mut self,
        channel_lane: usize,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, NoiseError> {
        self.seal_framed(channel_lane, true, plaintext)
    }

    pub fn open_datagram(
        &mut self,
        channel_lane: usize,
        framed: &[u8],
    ) -> Result<Vec<u8>, OpenReject> {
        self.open_framed(channel_lane, true, framed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_window_tolerates_wide_reorder_and_rejects_replays() {
        let mut w = ReplayWindow::default();
        // Establish a high-water counter, then deliver an in-order run.
        for c in 0..=2000u64 {
            assert!(w.check(c), "fresh counter {c} accepted");
            w.advance(c);
        }
        // A counter trailing the high-water by up to 1023 (within the widened
        // window) is a legitimate late cross-lane delivery — still acceptable
        // because it was never advanced. Deliver 2000 last, leaving 2000-700
        // un-seen only if it was skipped; here all were seen, so replays are
        // rejected...
        assert!(!w.check(2000), "exact high-water is a replay");
        assert!(
            !w.check(2000 - 1023),
            "just inside the 1024-slot window is a replay"
        );
        // ...and a counter older than the window is rejected (can't prove
        // freshness), while a fresh one just inside a gap is accepted.
        assert!(
            !w.check(2000 - 1024),
            "just past the window edge is rejected"
        );

        // Now model a real gap-then-late-arrival wider than the old 64-slot
        // window: jump the high-water forward, then accept a trailing counter
        // that a 64-slot window would have wrongly rejected.
        let mut g = ReplayWindow::default();
        g.advance(100);
        g.advance(100 + 500); // high-water jumps 500 (> old 64 window)
        assert!(
            g.check(100 + 500 - 300),
            "late arrival 300 back is accepted (was seen? no)"
        );
        g.advance(100 + 500 - 300);
        assert!(!g.check(100 + 500 - 300), "and is a replay once seen");
    }

    // Fixed inputs pinned by the committed vector and the browser Wasm
    // conformance test. Any change here must regenerate the vector.
    const PSK_HEX: &str = "9d61b19deffe6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e";
    const INIT_S_HEX: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const RESP_S_HEX: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const INIT_E_HEX: &str = "3333333333333333333333333333333333333333333333333333333333333333";
    const RESP_E_HEX: &str = "4444444444444444444444444444444444444444444444444444444444444444";

    fn hex_decode(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn vector_prologue() -> Vec<u8> {
        derive_prologue("vector-session", "vector-daemon", &[0x42; 64])
    }

    fn fixed_handshake(initiator: bool) -> NoiseHandshake {
        let psk = hex_decode(PSK_HEX);
        let (static_hex, eph_hex) = if initiator {
            (INIT_S_HEX, INIT_E_HEX)
        } else {
            (RESP_S_HEX, RESP_E_HEX)
        };
        let prologue = vector_prologue();
        let static_private = hex_decode(static_hex);
        let ephemeral = hex_decode(eph_hex);
        let builder =
            NoiseHandshake::builder(&static_private, &psk, &prologue, Some(&ephemeral)).unwrap();
        let state = if initiator {
            builder.build_initiator().unwrap()
        } else {
            builder.build_responder().unwrap()
        };
        NoiseHandshake { state, initiator }
    }

    /// Runs the full fixed-key handshake and returns the two transports plus the
    /// serialized vector value.
    fn run_vector() -> serde_json::Value {
        let mut init = fixed_handshake(true);
        let mut resp = fixed_handshake(false);

        let p1 = b"".to_vec();
        let p2 = b"".to_vec();
        let p3 = b"ok".to_vec();

        let msg1 = init.write_message(&p1).unwrap();
        assert_eq!(resp.read_message(&msg1).unwrap(), p1);
        let msg2 = resp.write_message(&p2).unwrap();
        assert_eq!(init.read_message(&msg2).unwrap(), p2);
        let msg3 = init.write_message(&p3).unwrap();
        assert_eq!(resp.read_message(&msg3).unwrap(), p3);

        assert!(init.is_complete() && resp.is_complete());
        let handshake_hash = init.handshake_hash();
        assert_eq!(handshake_hash, resp.handshake_hash());
        let init_remote_static = init.remote_static().unwrap();
        let resp_remote_static = resp.remote_static().unwrap();

        let mut init_t = init.into_transport().unwrap();
        let mut resp_t = resp.into_transport().unwrap();

        // initiator -> responder: ctrl stream (lane 1), displayDatagram (lane 2).
        let i2r_stream_pt: Vec<Vec<u8>> = vec![b"hello".to_vec(), b"world".to_vec(), b"!".to_vec()];
        let i2r_stream_framed: Vec<Vec<u8>> = i2r_stream_pt
            .iter()
            .map(|pt| init_t.seal_stream(1, pt).unwrap())
            .collect();
        for (pt, framed) in i2r_stream_pt.iter().zip(&i2r_stream_framed) {
            assert_eq!(&resp_t.open_stream(1, framed).unwrap(), pt);
        }

        let i2r_dgram_pt: Vec<Vec<u8>> =
            vec![b"row-a".to_vec(), b"row-b".to_vec(), b"row-c".to_vec()];
        let i2r_dgram_framed: Vec<Vec<u8>> = i2r_dgram_pt
            .iter()
            .map(|pt| init_t.seal_datagram(2, pt).unwrap())
            .collect();
        for (pt, framed) in i2r_dgram_pt.iter().zip(&i2r_dgram_framed) {
            assert_eq!(&resp_t.open_datagram(2, framed).unwrap(), pt);
        }
        // Replay of the first datagram must be rejected.
        assert_eq!(
            resp_t.open_datagram(2, &i2r_dgram_framed[0]),
            Err(OpenReject::Replay)
        );

        // responder -> initiator: pty stream (lane 0), displayAck datagram (lane 4).
        let r2i_stream_pt: Vec<Vec<u8>> = vec![b"ack-1".to_vec(), b"ack-2".to_vec()];
        let r2i_stream_framed: Vec<Vec<u8>> = r2i_stream_pt
            .iter()
            .map(|pt| resp_t.seal_stream(0, pt).unwrap())
            .collect();
        for (pt, framed) in r2i_stream_pt.iter().zip(&r2i_stream_framed) {
            assert_eq!(&init_t.open_stream(0, framed).unwrap(), pt);
        }

        let r2i_dgram_pt: Vec<Vec<u8>> = vec![b"g0".to_vec(), b"g1".to_vec()];
        let r2i_dgram_framed: Vec<Vec<u8>> = r2i_dgram_pt
            .iter()
            .map(|pt| resp_t.seal_datagram(4, pt).unwrap())
            .collect();
        for (pt, framed) in r2i_dgram_pt.iter().zip(&r2i_dgram_framed) {
            assert_eq!(&init_t.open_datagram(4, framed).unwrap(), pt);
        }

        let hexvec = |v: &[Vec<u8>]| -> Vec<String> { v.iter().map(|b| hex_encode(b)).collect() };

        serde_json::json!({
            "protocol": NOISE_PROTOCOL_NAME,
            "prologue_hex": hex_encode(&vector_prologue()),
            "psk_hex": PSK_HEX,
            "initiator_static_priv_hex": INIT_S_HEX,
            "responder_static_priv_hex": RESP_S_HEX,
            "initiator_ephemeral_priv_hex": INIT_E_HEX,
            "responder_ephemeral_priv_hex": RESP_E_HEX,
            "handshake": {
                "msg1_payload_hex": hex_encode(&p1),
                "msg1_hex": hex_encode(&msg1),
                "msg2_payload_hex": hex_encode(&p2),
                "msg2_hex": hex_encode(&msg2),
                "msg3_payload_hex": hex_encode(&p3),
                "msg3_hex": hex_encode(&msg3),
                "handshake_hash_hex": hex_encode(&handshake_hash),
                "initiator_remote_static_hex": hex_encode(&init_remote_static),
                "responder_remote_static_hex": hex_encode(&resp_remote_static),
            },
            "initiator_to_responder": {
                "stream": { "channel": "ctrl", "lane": 1, "plaintexts_hex": hexvec(&i2r_stream_pt), "framed_hex": hexvec(&i2r_stream_framed) },
                "datagram": { "channel": "displayDatagram", "lane": 2, "plaintexts_hex": hexvec(&i2r_dgram_pt), "framed_hex": hexvec(&i2r_dgram_framed) },
            },
            "responder_to_initiator": {
                "stream": { "channel": "pty", "lane": 0, "plaintexts_hex": hexvec(&r2i_stream_pt), "framed_hex": hexvec(&r2i_stream_framed) },
                "datagram": { "channel": "displayAck", "lane": 4, "plaintexts_hex": hexvec(&r2i_dgram_pt), "framed_hex": hexvec(&r2i_dgram_framed) },
            },
        })
    }

    fn vector_path() -> std::path::PathBuf {
        std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").expect("test manifest directory"),
        )
        .join("../shared/test-vectors/noise-xxpsk3.json")
    }

    #[test]
    fn derive_prologue_matches_shared_hex() {
        // Same inputs/hex asserted by packages/e2e-wasm/conformance.test.ts, so
        // the native build and the browser build are pinned to one byte string.
        let prologue = derive_prologue("sess-123", "daemon-xyz", &[0x42; 64]);
        assert_eq!(
            hex_encode(&prologue),
            concat!(
                "6d65726b75722d7472616e73706f72742d7071",
                "0000000000000008736573732d313233",
                "000000000000000a6461656d6f6e2d78797a",
                "4242424242424242424242424242424242424242424242424242424242424242",
                "4242424242424242424242424242424242424242424242424242424242424242"
            )
        );
    }

    #[test]
    fn incomplete_handshake_cannot_export_transport_keys() {
        let (secret, _) = generate_static_keypair().unwrap();
        for initiator in [false, true] {
            let handshake = if initiator {
                NoiseHandshake::new_initiator(&secret, &[7; 32], b"incomplete")
            } else {
                NoiseHandshake::new_responder(&secret, &[7; 32], b"incomplete")
            }
            .unwrap();
            assert!(handshake.into_transport().is_err());
        }
    }

    #[test]
    fn jumbo_transport_authenticates_the_whole_record_and_preserves_replay_state() {
        let (mut browser, mut daemon) = established_pair(&[7; 32], b"jumbo");
        for len in [
            65_519,
            65_520,
            2 * 1024 * 1024,
            MAX_TRANSPORT_FRAME_BYTES - FRAME_OVERHEAD,
        ] {
            let payload: Vec<_> = (0..len)
                .map(|index| (index.wrapping_mul(37) % 251) as u8)
                .collect();
            let wire = daemon.seal_stream(1, &payload).unwrap();
            assert_eq!(wire.len(), len + FRAME_OVERHEAD);
            for index in [8, wire.len() / 2, wire.len() - 1] {
                let mut corrupt = wire.clone();
                corrupt[index] ^= 1;
                assert_eq!(browser.open_stream(1, &corrupt), Err(OpenReject::Auth));
            }
            assert_eq!(browser.open_stream(0, &wire), Err(OpenReject::Auth));
            assert_eq!(browser.open_datagram(1, &wire), Err(OpenReject::Auth));
            assert_eq!(browser.open_stream(1, &wire).unwrap(), payload);
            assert_eq!(browser.open_stream(1, &wire), Err(OpenReject::Replay));
            let reply = browser.seal_stream(1, &payload).unwrap();
            assert_eq!(daemon.open_stream(1, &reply).unwrap(), payload);
        }
    }

    #[test]
    fn rejected_frame_bounds_do_not_consume_a_nonce_or_mutate_output() {
        let (mut browser, mut daemon) = established_pair(&[7; 32], b"bounds");
        let oversized = vec![0u8; MAX_TRANSPORT_FRAME_BYTES - FRAME_OVERHEAD + 1];
        let mut output = [0xa5; 64];
        assert!(matches!(
            browser.seal_into(0, false, &oversized, &mut output),
            Err(NoiseError::InvalidFrame)
        ));
        assert!(matches!(
            browser.seal_stream(0, &oversized),
            Err(NoiseError::InvalidFrame)
        ));
        assert!(matches!(
            browser.seal_into(LANE_COUNT, false, b"", &mut output),
            Err(NoiseError::InvalidFrame)
        ));
        assert!(matches!(
            browser.seal_into(0, false, b"x", &mut []),
            Err(NoiseError::BufferTooSmall)
        ));
        assert_eq!(output, [0xa5; 64]);
        let wire = browser.seal_stream(0, b"valid").unwrap();
        assert_eq!(&wire[..8], &[0; 8]);
        assert_eq!(daemon.open_stream(LANE_COUNT, &wire), Err(OpenReject::Auth));
        assert_eq!(daemon.open_stream(0, &wire).unwrap(), b"valid");
        assert_eq!(
            daemon.open_stream(0, &vec![0; MAX_TRANSPORT_FRAME_BYTES + 1]),
            Err(OpenReject::Auth)
        );
    }

    #[test]
    fn snow_handshake_and_transport_roundtrip() {
        // run_vector performs all the round-trip + replay assertions internally.
        let _ = run_vector();
    }

    #[test]
    fn rejects_high_bit_wire_counter_replay() {
        // Regression for the datagram replay bypass: forging the wire counter to
        // counter + 2^56 leaves the masked AEAD nonce unchanged (tag verifies) but
        // would look fresh to the replay window. The COUNTER_MASK guard rejects it.
        let psk = hex_decode(PSK_HEX);
        let init_static = hex_decode(INIT_S_HEX);
        let resp_static = hex_decode(RESP_S_HEX);
        let prologue = vector_prologue();
        let mut init = NoiseHandshake::new_initiator(&init_static, &psk, &prologue).unwrap();
        let mut resp = NoiseHandshake::new_responder(&resp_static, &psk, &prologue).unwrap();
        resp.read_message(&init.write_message(b"").unwrap())
            .unwrap();
        init.read_message(&resp.write_message(b"").unwrap())
            .unwrap();
        resp.read_message(&init.write_message(b"").unwrap())
            .unwrap();
        let mut init_t = init.into_transport().unwrap();
        let mut resp_t = resp.into_transport().unwrap();

        let framed = init_t.seal_datagram(2, b"replay-me").unwrap();
        assert_eq!(resp_t.open_datagram(2, &framed).unwrap(), b"replay-me");
        assert_eq!(
            resp_t.open_datagram(2, &framed),
            Err(OpenReject::Replay),
            "direct replay must be rejected"
        );

        let mut forged = framed.clone();
        let original = u64::from_be_bytes(forged[..8].try_into().unwrap());
        forged[..8].copy_from_slice(&(original + (1u64 << 56)).to_be_bytes());
        assert_eq!(
            resp_t.open_datagram(2, &forged),
            Err(OpenReject::Auth),
            "high-bit forged counter must be rejected"
        );
    }

    #[test]
    fn snow_reproduces_committed_vector() {
        let path = vector_path();
        let bytes = std::fs::read(&path).unwrap_or_else(|error| {
            panic!(
                "required Noise interop vector is missing at {}: {error}",
                path.display()
            )
        });
        let committed: serde_json::Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|error| panic!("invalid Noise vector at {}: {error}", path.display()));
        assert_eq!(
            run_vector(),
            committed,
            "snow output drifted from committed vector"
        );
    }

    // Run with: MERKUR_WRITE_NOISE_VECTORS=1 cargo test -p merkur-e2e write_noise_vector -- --ignored
    #[test]
    #[ignore]
    fn write_noise_vector() {
        if std::env::var("MERKUR_WRITE_NOISE_VECTORS").is_err() {
            return;
        }
        let path = vector_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = serde_json::to_string_pretty(&run_vector()).unwrap();
        std::fs::write(&path, format!("{json}\n")).unwrap();
    }

    /// Runs a full XXpsk3 handshake with FRESH (process-minted) keys, exactly as
    /// production does: the daemon responder static comes from
    /// `generate_static_keypair`, the PSK is the decoded auth-key bytes, and the
    /// prologue is session-bound. Returns `(initiator_transport,
    /// responder_transport)` — the browser is the initiator, the daemon the
    /// responder. This is the seam the live handshake handlers reach via
    /// `NoiseHandshake::new_responder` + `into_transport`.
    fn established_pair(psk: &[u8; 32], prologue: &[u8]) -> (NoiseTransport, NoiseTransport) {
        // Browser (initiator) and daemon (responder) each mint a static keypair.
        let (browser_static, _) = generate_static_keypair().unwrap();
        let (daemon_static, _) = generate_static_keypair().unwrap();
        let mut init = NoiseHandshake::new_initiator(&browser_static, psk, prologue).unwrap();
        let mut resp = NoiseHandshake::new_responder(&daemon_static, psk, prologue).unwrap();

        let msg1 = init.write_message(b"").unwrap();
        resp.read_message(&msg1).unwrap();
        let msg2 = resp.write_message(b"").unwrap();
        init.read_message(&msg2).unwrap();
        let msg3 = init.write_message(b"").unwrap();
        resp.read_message(&msg3).unwrap();

        assert!(init.is_complete() && resp.is_complete());
        // The daemon learns the browser's static (XX transmits it); the live
        // `handle_noise_final` asserts this before installing the transport.
        assert!(resp.remote_static().is_some());
        (
            init.into_transport().unwrap(),
            resp.into_transport().unwrap(),
        )
    }

    #[test]
    fn sealing_fails_closed_after_the_last_56_bit_lane_nonce() {
        let (mut transport, _) = established_pair(&[9u8; 32], b"nonce-exhaustion-test");
        transport.send_stream[1] = COUNTER_MASK;
        assert!(transport.seal_stream(1, b"last-valid-frame").is_ok());
        assert!(matches!(
            transport.seal_stream(1, b"must-not-wrap"),
            Err(NoiseError::NonceExhausted)
        ));
        assert_eq!(transport.send_stream[1], COUNTER_MASK + 1);
    }

    /// The mandatory dispatch-boundary proof at the crypto seam: a browser
    /// (initiator) seals a PTY frame on the PTY stream lane, and the daemon
    /// (responder) — opening on the SAME lane the inbound dispatch selects via
    /// `lane_for_channel(CHANNEL_PTY)` — recovers the exact plaintext. This is
    /// the open the daemon's `PeerDisplayState::open_terminal` /
    /// `open_inbound_terminal` calls; `main.rs` has the end-to-end variant that
    /// drives it through the real dispatch helper.
    #[test]
    fn browser_sealed_pty_frame_opens_at_daemon_lane() {
        let psk = test_psk_from_hex(PSK_HEX).unwrap();
        let prologue = derive_prologue("sess-pty", "daemon-pty", &[0x42; 64]);
        let (mut browser, mut daemon) = established_pair(&psk, &prologue);

        let lane = lane_for_channel(0x01).expect("pty owns a lane"); // CHANNEL_PTY
        let keystroke = b"echo hello\r";
        let sealed = browser.seal_stream(lane, keystroke).unwrap();
        assert_ne!(
            sealed.as_slice(),
            keystroke,
            "frame must be ciphertext on the wire"
        );
        let opened = daemon.open_stream(lane, &sealed).unwrap();
        assert_eq!(opened, keystroke, "daemon recovers the exact PTY plaintext");

        // A second distinct keystroke advances the implicit stream counter on
        // both sides and still round-trips (no nonce reuse, no desync).
        let next = b"\x03"; // ctrl-c
        let sealed2 = browser.seal_stream(lane, next).unwrap();
        assert_eq!(daemon.open_stream(lane, &sealed2).unwrap(), next);
    }

    /// displayAck datagram: a browser-sealed datagram opens at the daemon's
    /// datagram lane, and a replay of the same framed bytes is rejected (the
    /// per-lane replay window). Mirrors the live display-ack inbound path.
    #[test]
    fn browser_sealed_display_ack_datagram_round_trips_and_rejects_replay() {
        let psk = test_psk_from_hex(PSK_HEX).unwrap();
        let prologue = derive_prologue("sess-ack", "daemon-ack", &[0x42; 64]);
        let (mut browser, mut daemon) = established_pair(&psk, &prologue);

        let lane = lane_for_channel(0x05).expect("displayAck owns a lane"); // CHANNEL_DISPLAY_ACK
        let ack = &0x0001_0002u32.to_be_bytes();
        let framed = browser.seal_datagram(lane, ack).unwrap();
        assert_eq!(daemon.open_datagram(lane, &framed).unwrap(), ack);
        assert_eq!(
            daemon.open_datagram(lane, &framed),
            Err(OpenReject::Replay),
            "datagram replay must be rejected at the daemon"
        );
    }

    /// Lane-selection regression: locks the channel→lane map the seal/open path
    /// depends on, and proves SIGNALING owns no lane (never sealed).
    #[test]
    fn lane_for_channel_maps_terminal_channels_and_excludes_signaling() {
        assert_eq!(lane_for_channel(0x01), Some(0)); // pty
        assert_eq!(lane_for_channel(0x02), Some(1)); // ctrl
        assert_eq!(lane_for_channel(0x03), Some(2)); // displayDatagram
        assert_eq!(lane_for_channel(0x04), Some(3)); // displayCommit
        assert_eq!(lane_for_channel(0x05), Some(4)); // displayAck
        assert_eq!(lane_for_channel(0x00), None); // signaling — plaintext, no lane
        assert_eq!(lane_for_channel(0xFF), None); // close sentinel — no lane
    }

    /// Stream and datagram are DISJOINT nonce sub-lanes for the same channel: a
    /// frame sealed on the stream lane must not open as a datagram on the same
    /// lane index. This is exactly the invariant the inbound dispatch relies on
    /// when it picks the open call from `PeerMessage.delivery`.
    #[test]
    fn stream_and_datagram_sub_lanes_are_disjoint() {
        let psk = test_psk_from_hex(PSK_HEX).unwrap();
        let prologue = derive_prologue("sess-lane", "daemon-lane", &[0x42; 64]);
        let (mut browser, mut daemon) = established_pair(&psk, &prologue);

        let lane = lane_for_channel(0x01).unwrap();
        let stream_sealed = browser.seal_stream(lane, b"on-stream").unwrap();
        // Opening a stream-sealed frame as a datagram on the same lane must fail
        // (the wire counter parses, but the datagram nonce sub-space differs, so
        // the AEAD tag mismatches -> Auth). That failure touches only the
        // datagram replay window, so the very same framed bytes still open
        // correctly on the right (stream) sub-lane.
        assert!(
            daemon.open_datagram(lane, &stream_sealed).is_err(),
            "stream-lane ciphertext must not open as a datagram"
        );
        assert_eq!(
            daemon.open_stream(lane, &stream_sealed).unwrap(),
            b"on-stream",
            "the correct stream sub-lane still opens the same frame"
        );
    }

    /// The test-vector decoder accepts a 64-char hex string and rejects anything
    /// else; tests use the decoded bytes as deterministic PSK material.
    #[test]
    fn test_psk_hex_validates_length_and_hex() {
        assert!(test_psk_from_hex(PSK_HEX).is_some());
        assert!(test_psk_from_hex("00").is_none(), "too short");
        assert!(test_psk_from_hex(&"zz".repeat(32)).is_none(), "non-hex");
        let decoded = test_psk_from_hex(PSK_HEX).unwrap();
        assert_eq!(decoded.as_slice(), hex_decode(PSK_HEX).as_slice());
    }

    /// Regression for the reliable-stream-lane wedge: after the WebTransport
    /// upgrade a logical channel is delivered over multiple streams/transports,
    /// so CTRL/PTY stream frames can arrive out of order or duplicated. The
    /// stream lane must tolerate reorder (like the datagram lane) and treat a
    /// duplicate as a benign `Replay` instead of permanently desyncing — the
    /// failure mode that dropped every display/heartbeat frame in production.
    #[test]
    fn stream_lane_tolerates_reorder_and_rejects_replay() {
        let psk = test_psk_from_hex(PSK_HEX).unwrap();
        let prologue = derive_prologue("sess-reorder", "daemon-reorder", &[0x42; 64]);
        let (mut browser, mut daemon) = established_pair(&psk, &prologue);
        let lane = lane_for_channel(0x02).expect("ctrl owns a lane"); // CHANNEL_CTRL

        let f0 = browser.seal_stream(lane, b"zero").unwrap();
        let f1 = browser.seal_stream(lane, b"one").unwrap();
        let f2 = browser.seal_stream(lane, b"two").unwrap();

        // Out-of-order arrival (2, 0, 1) all open — no wedge.
        assert_eq!(daemon.open_stream(lane, &f2).unwrap(), b"two");
        assert_eq!(daemon.open_stream(lane, &f0).unwrap(), b"zero");
        assert_eq!(daemon.open_stream(lane, &f1).unwrap(), b"one");

        // A duplicate copy (the second path of a multi-path fan-out) is a benign
        // replay, not an authentication failure.
        assert_eq!(daemon.open_stream(lane, &f1), Err(OpenReject::Replay));

        // A fresh frame after the reorder still opens.
        let f3 = browser.seal_stream(lane, b"three").unwrap();
        assert_eq!(daemon.open_stream(lane, &f3).unwrap(), b"three");

        // A genuinely corrupt frame is an Auth failure, distinct from a replay.
        let mut tampered = browser.seal_stream(lane, b"four").unwrap();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert_eq!(daemon.open_stream(lane, &tampered), Err(OpenReject::Auth));
    }

    /// The property the whole fused handshake rests on: installing the PSK
    /// after message 1 rather than at build time changes NOTHING about the keys
    /// that come out.
    ///
    /// This is the claim two comments in this repo previously denied. `snow`
    /// raises `MissingPsk` only when the token loop reaches `Token::Psk(n)`,
    /// which for `XXpsk3` is appended to the END of message 3, and `split()`
    /// runs after that loop — so a PSK installed before message 3 is mixed into
    /// the chaining key before the transport keys exist. If that were ever
    /// false, the two transports below would disagree.
    #[test]
    fn a_late_installed_psk_yields_the_same_transport_as_an_early_one() {
        let prologue = derive_prologue("sess-fused", "daemon-fused", &[0x42; 64]);
        let psk = [0x5a; 32];

        let (browser_static, _) = generate_static_keypair().expect("browser static");
        let (daemon_static, _) = generate_static_keypair().expect("daemon static");

        // Sequential: the PSK is known at build time, as it was before.
        let mut early_initiator = NoiseHandshake::new_initiator(&browser_static, &psk, &prologue)
            .expect("early initiator");
        let mut early_responder = NoiseHandshake::new_responder(&daemon_static, &psk, &prologue)
            .expect("early responder");
        let e_msg1 = early_initiator.write_message(&[]).expect("early msg1");
        early_responder.read_message(&e_msg1).expect("early read 1");
        let e_msg2 = early_responder.write_message(&[]).expect("early msg2");
        early_initiator.read_message(&e_msg2).expect("early read 2");
        let e_msg3 = early_initiator.write_message(&[]).expect("early msg3");
        early_responder.read_message(&e_msg3).expect("early read 3");
        assert!(early_initiator.is_complete() && early_responder.is_complete());

        // Fused: message 1 is written before the PSK exists at all.
        let (pending, f_msg1) =
            PendingNoiseInitiator::start(&browser_static, &prologue).expect("pending");
        let mut late_responder =
            NoiseHandshake::new_responder(&daemon_static, &psk, &prologue).expect("late responder");
        late_responder.read_message(&f_msg1).expect("late read 1");
        let f_msg2 = late_responder.write_message(&[]).expect("late msg2");
        let mut late_initiator = pending
            .read_authenticated_msg2(&f_msg2)
            .expect("authenticated msg2")
            .install_psk(&psk)
            .expect("late install");
        let f_msg3 = late_initiator.write_message(&[]).expect("late msg3");
        late_responder.read_message(&f_msg3).expect("late read 3");
        assert!(late_initiator.is_complete() && late_responder.is_complete());

        // Same peer identity both ways.
        assert_eq!(
            early_initiator.remote_static(),
            late_initiator.remote_static(),
            "the daemon's static key must be authenticated identically"
        );

        // And the transports agree: seal on one, open on the other.
        let early_transport = early_responder.into_transport().expect("early transport");
        let late_transport = late_responder.into_transport().expect("late transport");
        let _ = (early_transport, late_transport);
    }

    /// A pending initiator has no way to read, so the only path out is the
    /// consuming installer. This test exists to fail loudly if someone later
    /// adds a `read_message` to it and reopens the ordering hole the type
    /// closes: the daemon is authenticated by the response proof, not by Noise.
    #[test]
    fn a_pending_initiator_refuses_a_message_two_under_the_wrong_psk() {
        let prologue = derive_prologue("sess-wrong", "daemon-wrong", &[0x42; 64]);
        let (browser_static, _) = generate_static_keypair().expect("browser static");
        let (daemon_static, _) = generate_static_keypair().expect("daemon static");

        let (pending, msg1) =
            PendingNoiseInitiator::start(&browser_static, &prologue).expect("pending");
        let mut responder = NoiseHandshake::new_responder(&daemon_static, &[0x5a; 32], &prologue)
            .expect("responder");
        responder.read_message(&msg1).expect("read 1");
        let msg2 = responder.write_message(&[]).expect("msg2");

        // Message 2 carries no Psk token, so a wrong PSK cannot be detected
        // here — it is detected at message 3, where the token is. The responder
        // must refuse.
        let mut initiator = pending
            .read_authenticated_msg2(&msg2)
            .expect("msg2 itself is psk-independent")
            .install_psk(&[0x00; 32])
            .unwrap();
        let msg3 = initiator.write_message(&[]).unwrap();
        assert!(
            responder.read_message(&msg3).is_err(),
            "a mismatched PSK must fail the handshake at message 3"
        );
    }

    #[test]
    fn secondary_secrets_bind_both_contributions_at_the_same_noise_checkpoint() {
        let prologue = derive_prologue("checkpoint", "daemon", &[0x12; 64]);
        let (browser_static, _) = generate_static_keypair().unwrap();
        let (daemon_static, _) = generate_static_keypair().unwrap();
        let (initiator, msg1) = PendingNoiseInitiator::start(&browser_static, &prologue).unwrap();
        let (responder, msg2) =
            PendingNoiseResponder::start(&daemon_static, &prologue, &msg1).unwrap();
        let initiator = initiator.read_authenticated_msg2(&msg2).unwrap();
        assert_eq!(initiator.checkpoint.hash, responder.checkpoint.hash);
        assert_eq!(
            *initiator.checkpoint.contribution,
            *responder.checkpoint.contribution
        );
        let mut response = b"merkur-session/response\0".to_vec();
        response.extend_from_slice(b"signed-checkpoint");
        let signature = [0x22; DAEMON_IDENTITY_SIGNATURE_BYTES];
        let a = derive_session_secrets(&[0x33; 32], &signature, &response).unwrap();
        let original_psk: [u8; 32] = a.as_bytes()[..32].try_into().unwrap();
        let a = a.bind_noise(initiator.checkpoint(), &response).unwrap();
        let b = derive_session_secrets(&[0x33; 32], &signature, &response)
            .unwrap()
            .bind_noise(responder.checkpoint(), &response)
            .unwrap();
        assert_eq!(a.as_bytes(), b.as_bytes());
        assert_eq!(a.noise_psk(), &original_psk);
        let kem_changed = derive_session_secrets(&[0x34; 32], &signature, &response)
            .unwrap()
            .bind_noise(initiator.checkpoint(), &response)
            .unwrap();
        assert_ne!(
            a.direct_upgrade_secret(),
            kem_changed.direct_upgrade_secret()
        );
        assert_ne!(a.rebind_secret(), kem_changed.rebind_secret());
        let (other, _) = PendingNoiseResponder::start(&daemon_static, &prologue, &msg1).unwrap();
        let classical_changed = derive_session_secrets(&[0x33; 32], &signature, &response)
            .unwrap()
            .bind_noise(other.checkpoint(), &response)
            .unwrap();
        assert_eq!(a.noise_psk(), classical_changed.noise_psk());
        assert_ne!(
            a.direct_upgrade_secret(),
            classical_changed.direct_upgrade_secret()
        );
        assert_ne!(a.rebind_secret(), classical_changed.rebind_secret());
        let checkpoint_split = zeroize::Zeroizing::new(*responder.checkpoint.contribution);
        let mut i = initiator.install_psk(&original_psk).unwrap();
        let mut r = responder.install_psk(&original_psk).unwrap();
        let msg3 = i.write_message(&[]).unwrap();
        r.read_message(&msg3).unwrap();
        assert_ne!(r.state.dangerously_get_raw_split(), *checkpoint_split);
        let ciphertext = i
            .into_transport()
            .unwrap()
            .seal_stream(0, b"valid")
            .unwrap();
        assert_eq!(
            r.into_transport()
                .unwrap()
                .open_stream(0, &ciphertext)
                .unwrap(),
            b"valid"
        );
    }

    #[test]
    fn an_empty_second_flight_is_identical_before_installing_any_psk() {
        let prologue = derive_prologue("late-responder", "daemon", &[0x12; 64]);
        let init = hex_decode(INIT_S_HEX);
        let init_e = hex_decode(INIT_E_HEX);
        let resp = hex_decode(RESP_S_HEX);
        let resp_e = hex_decode(RESP_E_HEX);
        let params = NOISE_PROTOCOL_NAME.parse().unwrap();
        let mut initiator = snow::Builder::new(params)
            .local_private_key(&init)
            .unwrap()
            .prologue(&prologue)
            .unwrap()
            .fixed_ephemeral_key_for_testing_only(&init_e)
            .build_initiator()
            .unwrap();
        let mut msg1 = [0u8; 96];
        let n = initiator.write_message(&[], &mut msg1).unwrap();
        let prepare = |psk: Option<&[u8; 32]>| {
            let params = NOISE_PROTOCOL_NAME.parse().unwrap();
            let builder = snow::Builder::new(params)
                .local_private_key(&resp)
                .unwrap()
                .prologue(&prologue)
                .unwrap()
                .fixed_ephemeral_key_for_testing_only(&resp_e);
            let builder = match psk {
                Some(psk) => builder.psk(3, psk).unwrap(),
                None => builder,
            };
            let mut responder = builder.build_responder().unwrap();
            let mut scratch = [0u8; 96];
            responder.read_message(&msg1[..n], &mut scratch).unwrap();
            let n = responder.write_message(&[], &mut scratch).unwrap();
            (scratch[..n].to_vec(), responder.dangerously_get_raw_split())
        };
        assert_eq!(prepare(None), prepare(Some(&[0x5a; 32])));
        assert_eq!(prepare(None), prepare(Some(&[0x5b; 32])));
    }
}
