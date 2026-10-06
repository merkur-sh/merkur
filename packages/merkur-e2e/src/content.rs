//! Finite object-range encryption, independent of terminal record replay windows.
//! A descriptor authenticates bytes; the scene owner still authorizes every fetch.

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

use hkdf::Hkdf;
use sha2::Sha512;
use snow::types::Cipher;
use zeroize::{Zeroize, Zeroizing};

use crate::{NoiseError, NoiseTransport, ReplayWindow, transport_cipher};

mod requests;
#[cfg(test)]
mod tests;
pub use requests::ContentRequests;

/// Wire fact: a chunk is the integrity/resumption unit, not a separate stream.
pub const CONTENT_CHUNK_BYTES: usize = 16 * 1024;
/// Resource bound on one encoded tile or manifest, before any object allocation.
pub const CONTENT_MAX_OBJECT_BYTES: usize = 8 * 1024 * 1024;
/// Resource bound per direction and epoch, including owners awaiting retirement.
pub const CONTENT_MAX_TRANSFERS: u32 = 32;
/// request:u64, source:32, object:32, object bytes:u32, first:u32, count:u32.
pub const CONTENT_DESCRIPTOR_BYTES: usize = 84;
/// Opaque transfer identity followed by the encrypted descriptor and tag.
pub const CONTENT_HEADER_BYTES: usize = 8 + CONTENT_DESCRIPTOR_BYTES + 16;
/// Range-local ordinal followed by authenticated chunk bytes and tag.
pub const CONTENT_CHUNK_OVERHEAD: usize = 4 + 16;
const MAX_CHUNKS: usize = CONTENT_MAX_OBJECT_BYTES.div_ceil(CONTENT_CHUNK_BYTES);
const SEED_INFO: &[u8] = b"merkur.content.direction\0";
const KEY_INFO: &[u8] = b"merkur.content.transfer\0";
const HEADER_DOMAIN: &[u8] = b"merkur.content.descriptor\0";
const CHUNK_DOMAIN: &[u8] = b"merkur.content.chunk\0";
const HEADER_AD_BYTES: usize = HEADER_DOMAIN.len() + 64 + 1 + 8;
const CHUNK_AD_BYTES: usize = CHUNK_DOMAIN.len() + 64 + 1 + 8 + CONTENT_DESCRIPTOR_BYTES + 4 + 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContentError {
    Invalid,
    Auth,
    Replay,
    Capacity,
    Exhausted,
    Retired,
}

impl std::fmt::Display for ContentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Invalid => "invalid content record",
            Self::Auth => "content authentication failed",
            Self::Replay => "content transfer already admitted or expired",
            Self::Capacity => "content transfer capacity exhausted",
            Self::Exhausted => "content transfer identity exhausted",
            Self::Retired => "content key epoch retired",
        })
    }
}
impl std::error::Error for ContentError {}

/// Immutable authenticated response range. A fresh request learns the encoded
/// object identity here; a resumed request already knows and requires that identity.
/// Construction validates shape only; guessed roots do not confer fetch rights.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ContentDescriptor {
    bytes: [u8; CONTENT_DESCRIPTOR_BYTES],
}

impl ContentDescriptor {
    pub fn new(
        request: u64,
        source: [u8; 32],
        object: [u8; 32],
        object_bytes: u32,
        first: u32,
        count: u32,
    ) -> Result<Self, ContentError> {
        let chunks = (object_bytes as usize).div_ceil(CONTENT_CHUNK_BYTES);
        if request == 0
            || object_bytes == 0
            || object_bytes as usize > CONTENT_MAX_OBJECT_BYTES
            || count == 0
            || first as usize >= chunks
            || count as usize > chunks - first as usize
        {
            return Err(ContentError::Invalid);
        }
        let mut bytes = [0; CONTENT_DESCRIPTOR_BYTES];
        bytes[..8].copy_from_slice(&request.to_be_bytes());
        bytes[8..40].copy_from_slice(&source);
        bytes[40..72].copy_from_slice(&object);
        bytes[72..76].copy_from_slice(&object_bytes.to_be_bytes());
        bytes[76..80].copy_from_slice(&first.to_be_bytes());
        bytes[80..84].copy_from_slice(&count.to_be_bytes());
        Ok(Self { bytes })
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ContentError> {
        let bytes: [u8; CONTENT_DESCRIPTOR_BYTES] =
            bytes.try_into().map_err(|_| ContentError::Invalid)?;
        Self::new(
            u64::from_be_bytes(bytes[..8].try_into().expect("fixed request")),
            bytes[8..40].try_into().expect("fixed source"),
            bytes[40..72].try_into().expect("fixed object"),
            word(&bytes, 72),
            word(&bytes, 76),
            word(&bytes, 80),
        )
    }

    pub fn encode(&self) -> &[u8; CONTENT_DESCRIPTOR_BYTES] {
        &self.bytes
    }
    pub fn request(&self) -> u64 {
        u64::from_be_bytes(self.bytes[..8].try_into().expect("fixed request"))
    }
    pub fn source(&self) -> &[u8; 32] {
        self.bytes[8..40].try_into().expect("fixed source")
    }
    pub fn object(&self) -> &[u8; 32] {
        self.bytes[40..72].try_into().expect("fixed object")
    }
    pub fn object_bytes(&self) -> u32 {
        word(&self.bytes, 72)
    }
    pub fn first(&self) -> u32 {
        word(&self.bytes, 76)
    }
    pub fn count(&self) -> u32 {
        word(&self.bytes, 80)
    }

    pub fn range(&self) -> std::ops::Range<usize> {
        let start = self.first() as usize * CONTENT_CHUNK_BYTES;
        let end = ((self.first() + self.count()) as usize * CONTENT_CHUNK_BYTES)
            .min(self.object_bytes() as usize);
        start..end
    }

    /// Exact finite body length: one authenticated header and all chunk records.
    pub fn wire_bytes(&self) -> usize {
        self.range().len() + CONTENT_HEADER_BYTES + self.count() as usize * CONTENT_CHUNK_OVERHEAD
    }

    fn chunk_len(&self, ordinal: u32) -> Result<usize, ContentError> {
        if ordinal >= self.count() {
            return Err(ContentError::Invalid);
        }
        Ok((word(&self.bytes, 72) as usize
            - (self.first() + ordinal) as usize * CONTENT_CHUNK_BYTES)
            .min(CONTENT_CHUNK_BYTES))
    }
}

impl std::fmt::Debug for ContentDescriptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ContentDescriptor { .. }")
    }
}

fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(bytes[offset..offset + 4].try_into().expect("fixed word"))
}

struct Lifetime {
    live: AtomicBool,
    owners: [AtomicU32; 2],
}

struct Permit {
    lifetime: Arc<Lifetime>,
    direction: usize,
}

impl Permit {
    fn check(&self) -> Result<(), ContentError> {
        self.lifetime
            .live
            .load(Ordering::Acquire)
            .then_some(())
            .ok_or(ContentError::Retired)
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.lifetime.owners[self.direction].fetch_sub(1, Ordering::Relaxed);
    }
}

pub(crate) struct ContentDomain {
    send: Zeroizing<[u8; 64]>,
    receive: Zeroizing<[u8; 64]>,
    epoch: [u8; 64],
    send_direction: u8,
    next: u64,
    admitted: ReplayWindow,
    lifetime: Option<Arc<Lifetime>>,
}

impl ContentDomain {
    pub(crate) fn new(
        send: &[u8; 32],
        receive: &[u8; 32],
        epoch: &[u8],
        initiator: bool,
    ) -> Result<Self, NoiseError> {
        let epoch: [u8; 64] = epoch.try_into().map_err(|_| NoiseError::Params)?;
        let send_direction = u8::from(!initiator);
        Ok(Self {
            send: direction_seed(send, &epoch, send_direction)?,
            receive: direction_seed(receive, &epoch, send_direction ^ 1)?,
            epoch,
            send_direction,
            next: 1,
            admitted: ReplayWindow::default(),
            lifetime: None,
        })
    }

    fn permit(&mut self, direction: usize) -> Result<Permit, ContentError> {
        let lifetime = self.lifetime.get_or_insert_with(|| {
            Arc::new(Lifetime {
                live: AtomicBool::new(true),
                owners: [AtomicU32::new(0), AtomicU32::new(0)],
            })
        });
        lifetime.owners[direction]
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |owners| {
                (owners < CONTENT_MAX_TRANSFERS).then_some(owners + 1)
            })
            .map_err(|_| ContentError::Capacity)?;
        Ok(Permit {
            lifetime: Arc::clone(lifetime),
            direction,
        })
    }
}

impl Drop for ContentDomain {
    fn drop(&mut self) {
        if let Some(lifetime) = &self.lifetime {
            lifetime.live.store(false, Ordering::Release);
        }
    }
}

fn direction_seed(
    key: &[u8; 32],
    epoch: &[u8; 64],
    direction: u8,
) -> Result<Zeroizing<[u8; 64]>, NoiseError> {
    let mut seed = Zeroizing::new([0; 64]);
    Hkdf::<Sha512>::new(Some(epoch), key)
        .expand_multi_info(&[SEED_INFO, &[direction]], &mut *seed)
        .map_err(|_| NoiseError::Params)?;
    Ok(seed)
}

fn cipher(seed: &[u8; 64], transfer: u64) -> Result<Box<dyn Cipher>, ContentError> {
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha512>::from_prk(seed)
        .map_err(|_| ContentError::Invalid)?
        .expand_multi_info(&[KEY_INFO, &transfer.to_be_bytes()], &mut *key)
        .map_err(|_| ContentError::Invalid)?;
    transport_cipher(&key).map_err(|_| ContentError::Invalid)
}

fn header_ad(epoch: &[u8; 64], direction: u8, transfer: u64) -> [u8; HEADER_AD_BYTES] {
    let mut bytes = [0; HEADER_AD_BYTES];
    let n = HEADER_DOMAIN.len();
    bytes[..n].copy_from_slice(HEADER_DOMAIN);
    bytes[n..n + 64].copy_from_slice(epoch);
    bytes[n + 64] = direction;
    bytes[n + 65..].copy_from_slice(&transfer.to_be_bytes());
    bytes
}

fn chunk_ad(
    epoch: &[u8; 64],
    direction: u8,
    transfer: u64,
    descriptor: ContentDescriptor,
) -> [u8; CHUNK_AD_BYTES] {
    let mut bytes = [0; CHUNK_AD_BYTES];
    let n = CHUNK_DOMAIN.len();
    bytes[..n].copy_from_slice(CHUNK_DOMAIN);
    bytes[n..n + 64].copy_from_slice(epoch);
    bytes[n + 64] = direction;
    bytes[n + 65..n + 73].copy_from_slice(&transfer.to_be_bytes());
    bytes[n + 73..CHUNK_AD_BYTES - 8].copy_from_slice(descriptor.encode());
    bytes
}

impl NoiseTransport {
    /// Call only after scene authorization. The returned owner seals a range once;
    /// retransmission must retain its exact ciphertext, or start a fresh transfer.
    pub fn content_sender(
        &mut self,
        descriptor: ContentDescriptor,
    ) -> Result<ContentSender, ContentError> {
        self.reserve_content_sender()?.bind(descriptor)
    }

    /// Reserve one single-use transfer key while the authenticated terminal owner
    /// is available. A bounded asset job can then encode and bind its immutable
    /// descriptor without moving, locking or exporting the session's Noise state.
    pub fn reserve_content_sender(&mut self) -> Result<ContentSendKey, ContentError> {
        let domain = &mut self.content;
        let transfer = domain.next;
        let next = transfer.checked_add(1).ok_or(ContentError::Exhausted)?;
        let permit = domain.permit(0)?;
        let cipher = cipher(&domain.send, transfer)?;
        domain.next = next;
        Ok(ContentSendKey {
            cipher,
            epoch: domain.epoch,
            direction: domain.send_direction,
            transfer,
            permit,
        })
    }

    /// Authenticate before consulting local request state. Neither a malformed
    /// response nor capacity refusal consumes the request or commits replay state.
    /// The request owner drops a returned receiver when active work is cancelled.
    pub fn content_receiver(
        &mut self,
        requests: &mut ContentRequests,
        header: &[u8],
    ) -> Result<ContentReceiver, ContentError> {
        if header.len() != CONTENT_HEADER_BYTES {
            return Err(ContentError::Invalid);
        }
        let transfer = u64::from_be_bytes(header[..8].try_into().expect("fixed transfer"));
        if transfer == 0 {
            return Err(ContentError::Invalid);
        }
        let domain = &mut self.content;
        let cipher = cipher(&domain.receive, transfer)?;
        // Both providers accept an output the size of the ciphertext. This fixed
        // stack buffer never trusts a peer-supplied allocation or length.
        let mut decoded = Zeroizing::new([0; CONTENT_DESCRIPTOR_BYTES + 16]);
        let len = cipher
            .decrypt(
                0,
                &header_ad(&domain.epoch, domain.send_direction ^ 1, transfer),
                &header[8..],
                &mut *decoded,
            )
            .map_err(|_| ContentError::Auth)?;
        if len != CONTENT_DESCRIPTOR_BYTES {
            return Err(ContentError::Auth);
        }
        let descriptor = ContentDescriptor::decode(&decoded[..len])?;
        if !domain.admitted.check(transfer) {
            return Err(ContentError::Replay);
        }
        let slot = requests.matching(&descriptor).ok_or(ContentError::Auth)?;
        let permit = domain.permit(1)?;
        requests.consume(slot);
        domain.admitted.advance(transfer);
        Ok(ContentReceiver {
            cipher,
            descriptor,
            ad: chunk_ad(
                &domain.epoch,
                domain.send_direction ^ 1,
                transfer,
                descriptor,
            ),
            received: [0; MAX_CHUNKS.div_ceil(64)],
            permit,
        })
    }
}

/// An admitted, non-cloneable key for exactly one response descriptor. Dropping
/// unused work spends its identity permanently and releases its transfer slot.
pub struct ContentSendKey {
    cipher: Box<dyn Cipher>,
    epoch: [u8; 64],
    direction: u8,
    transfer: u64,
    permit: Permit,
}

impl ContentSendKey {
    pub fn bind(self, descriptor: ContentDescriptor) -> Result<ContentSender, ContentError> {
        self.permit.check()?;
        let mut header = [0; CONTENT_HEADER_BYTES];
        header[..8].copy_from_slice(&self.transfer.to_be_bytes());
        self.cipher.encrypt(
            0,
            &header_ad(&self.epoch, self.direction, self.transfer),
            descriptor.encode(),
            &mut header[8..],
        );
        self.permit.check()?;
        Ok(ContentSender {
            cipher: self.cipher,
            descriptor,
            header,
            ad: chunk_ad(&self.epoch, self.direction, self.transfer, descriptor),
            next: 0,
            permit: self.permit,
        })
    }
}

pub struct ContentSender {
    cipher: Box<dyn Cipher>,
    descriptor: ContentDescriptor,
    header: [u8; CONTENT_HEADER_BYTES],
    ad: [u8; CHUNK_AD_BYTES],
    next: u32,
    permit: Permit,
}

impl ContentSender {
    pub fn header(&self) -> &[u8; CONTENT_HEADER_BYTES] {
        &self.header
    }
    pub fn descriptor(&self) -> ContentDescriptor {
        self.descriptor
    }
    pub fn next_ordinal(&self) -> u32 {
        self.next
    }

    pub fn seal_next(&mut self, plaintext: &[u8], out: &mut [u8]) -> Result<usize, ContentError> {
        self.permit.check()?;
        let len = self.descriptor.chunk_len(self.next)?;
        if plaintext.len() != len || out.len() < len + CONTENT_CHUNK_OVERHEAD {
            return Err(ContentError::Invalid);
        }
        let ordinal = self.next;
        self.next += 1;
        self.ad[CHUNK_AD_BYTES - 8..CHUNK_AD_BYTES - 4].copy_from_slice(&ordinal.to_be_bytes());
        self.ad[CHUNK_AD_BYTES - 4..].copy_from_slice(&(len as u32).to_be_bytes());
        out[..4].copy_from_slice(&ordinal.to_be_bytes());
        let n = self
            .cipher
            .encrypt(u64::from(ordinal) + 1, &self.ad, plaintext, &mut out[4..]);
        if let Err(error) = self.permit.check() {
            out[..4 + n].zeroize();
            return Err(error);
        }
        Ok(4 + n)
    }
}

pub struct ContentReceiver {
    cipher: Box<dyn Cipher>,
    descriptor: ContentDescriptor,
    ad: [u8; CHUNK_AD_BYTES],
    received: [u64; MAX_CHUNKS.div_ceil(64)],
    permit: Permit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContentChunk {
    pub object_index: u32,
    pub len: usize,
    pub duplicate: bool,
}

impl ContentReceiver {
    pub fn descriptor(&self) -> ContentDescriptor {
        self.descriptor
    }

    pub fn open_chunk(
        &mut self,
        record: &[u8],
        out: &mut [u8],
    ) -> Result<ContentChunk, ContentError> {
        self.permit.check()?;
        if record.len() < CONTENT_CHUNK_OVERHEAD {
            return Err(ContentError::Invalid);
        }
        let ordinal = word(record, 0);
        let len = self.descriptor.chunk_len(ordinal)?;
        if record.len() != len + CONTENT_CHUNK_OVERHEAD || out.len() < len + 16 {
            return Err(ContentError::Invalid);
        }
        self.ad[CHUNK_AD_BYTES - 8..CHUNK_AD_BYTES - 4].copy_from_slice(&ordinal.to_be_bytes());
        self.ad[CHUNK_AD_BYTES - 4..].copy_from_slice(&(len as u32).to_be_bytes());
        let opened = self
            .cipher
            .decrypt(u64::from(ordinal) + 1, &self.ad, &record[4..], out);
        if opened != Ok(len) {
            out[..len + 16].zeroize();
            return Err(ContentError::Auth);
        }
        if let Err(error) = self.permit.check() {
            out[..len + 16].zeroize();
            return Err(error);
        }
        let word = &mut self.received[ordinal as usize / 64];
        let bit = 1 << (ordinal % 64);
        let duplicate = *word & bit != 0;
        *word |= bit;
        Ok(ContentChunk {
            object_index: self.descriptor.first() + ordinal,
            len,
            duplicate,
        })
    }
}
